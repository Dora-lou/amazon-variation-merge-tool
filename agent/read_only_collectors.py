# -*- coding: utf-8 -*-
"""Host-side, read-only data collection for sales-plan previews.

The collectors deliberately do not accept commands or tool IDs from the model or
browser.  Lingxing calls are validated against MCP help/search metadata before an
action is sent.  Lark commands are assembled from a small immutable allowlist.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

COLLECTION_TIMEOUT = 90
MAX_LARK_OUTPUT = 2_000_000
MAX_MCP_OUTPUT = 3_000_000
DEFAULT_KNOWLEDGE_BASE = "至拓-运营"

# Exact IDs only. A matching name or description is never sufficient.
LINGXING_READ_ALLOWLIST = {
    "erp_listing": "listing_and_sku_mapping",
    "get_fba_stock_list": "inventory_snapshot",
    "query_fba_valid_list": "replenishment_inventory",
    "query_product_performance_asin_lists": "historical_sales",
}

LARK_READ_COMMANDS = frozenset({
    ("auth", "status"),
    ("wiki", "+space-list"),
    ("wiki", "+node-list"),
    ("sheets", "+workbook-info"),
    ("sheets", "+table-get"),
})
LARK_ALLOWED_FLAGS = {
    ("auth", "status"): frozenset({"--json", "--verify"}),
    ("wiki", "+space-list"): frozenset({"--as", "--page-all", "--page-limit", "--format"}),
    ("wiki", "+node-list"): frozenset({
        "--space-id", "--parent-node-token", "--as", "--page-all", "--page-limit", "--format"
    }),
    ("sheets", "+workbook-info"): frozenset({"--spreadsheet-token", "--as", "--format"}),
    ("sheets", "+table-get"): frozenset({
        "--spreadsheet-token", "--sheet-id", "--sheet-name", "--range", "--as", "--max-chars",
        "--format", "--no-header"
    }),
}
LARK_BOOLEAN_FLAGS = frozenset({"--json", "--verify", "--page-all", "--no-header"})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CollectionError(RuntimeError):
    """A controlled error that is safe to show without subprocess output."""


class LarkCommandError(CollectionError):
    """Sanitized lark-cli failure; raw stderr is intentionally not retained."""

    def __init__(self, command: str, exit_code: int, category: str):
        self.command = command
        self.exit_code = exit_code
        self.category = category
        labels = {
            "duplicate_header": "表格存在重复表头",
            "authorization": "用户授权或权限不足",
            "validation": "命令参数或表格结构校验失败",
            "cli_usage": "命令参数不被当前 lark-cli 版本接受",
            "unknown": "未分类的 CLI 错误",
        }
        super().__init__(f"飞书只读命令 {command} 失败（退出码 {exit_code}：{labels.get(category, labels['unknown'])}）")


SENSITIVE_KEY_PARTS = ("token", "cookie", "authorization", "secret", "api_key", "apikey")


def _redact_sensitive(value: Any) -> Any:
    """Remove credential-like fields before data can enter a model prompt."""
    if isinstance(value, dict):
        return {key: _redact_sensitive(child) for key, child in value.items()
                if not any(part in str(key).casefold() for part in SENSITIVE_KEY_PARTS)}
    if isinstance(value, list):
        return [_redact_sensitive(child) for child in value]
    return value


def _json_from_text(text: str) -> Any:
    if not text or len(text) > MAX_MCP_OUTPUT:
        raise CollectionError("返回数据为空或超过安全大小限制")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        raise CollectionError("返回内容不是有效 JSON") from None


def _extract_mcp_payload(result: Any) -> Any:
    """Unwrap an MCP tools/call response without logging its raw content."""
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        texts = [item.get("text", "") for item in result["content"]
                 if isinstance(item, dict) and item.get("type") == "text"]
        if not texts:
            return result.get("structuredContent", result)
        parsed = [_json_from_text(text) for text in texts]
        return parsed[0] if len(parsed) == 1 else parsed
    return result


def _schema_validate(schema: dict, value: Any, path: str = "params") -> None:
    """Validate the JSON-schema subset used by the Lingxing MCP tool catalog."""
    expected = schema.get("type")
    types = expected if isinstance(expected, list) else [expected] if expected else []
    valid = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": type(value) is int,
        "number": type(value) in (int, float),
        "boolean": type(value) is bool,
        "null": value is None,
    }
    if types and not any(valid.get(kind, False) for kind in types):
        raise CollectionError(f"{path} 类型不符合 MCP Schema")
    if "enum" in schema and value not in schema["enum"]:
        raise CollectionError(f"{path} 不在 MCP Schema 允许值中")
    if type(value) in (int, float) and "maximum" in schema and value > schema["maximum"]:
        raise CollectionError(f"{path} 超过 MCP Schema 上限")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        missing = [name for name in schema.get("required", []) if name not in value]
        if missing:
            raise CollectionError(f"{path} 缺少 MCP 必填字段")
        if schema.get("additionalProperties") is False:
            unknown = set(value) - set(props)
            if unknown:
                raise CollectionError(f"{path} 包含 MCP Schema 未允许字段")
        for name, child in value.items():
            if name in props:
                _schema_validate(props[name], child, f"{path}.{name}")
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, child in enumerate(value):
            _schema_validate(schema["items"], child, f"{path}[{index}]")


class StreamableHttpMcpClient:
    """Minimal MCP streamable-HTTP client using only the Python standard library."""

    def __init__(self, url: str, headers: dict[str, str], timeout: int = COLLECTION_TIMEOUT):
        if not url.lower().startswith("https://"):
            raise CollectionError("领星 MCP 必须使用 HTTPS")
        self.url = url
        self.headers = dict(headers)
        self.timeout = timeout
        self.session_id: str | None = None
        self.request_id = 0

    @classmethod
    def from_codex_config(cls, codex_bin: str) -> "StreamableHttpMcpClient":
        try:
            proc = subprocess.run(
                [codex_bin, "mcp", "get", "yb-lingxing", "--json"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=20, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise CollectionError("无法读取本机领星 MCP 配置") from None
        if proc.returncode != 0 or len(proc.stdout) > 200_000:
            raise CollectionError("本机未找到可用的 yb-lingxing MCP 配置")
        try:
            config = json.loads(proc.stdout)
            transport = config["transport"]
        except (json.JSONDecodeError, KeyError, TypeError):
            raise CollectionError("yb-lingxing MCP 配置格式无法识别") from None
        if not config.get("enabled") or transport.get("type") != "streamable_http":
            raise CollectionError("yb-lingxing MCP 未启用或不是受支持的 HTTP 类型")
        if transport.get("http_headers_helper"):
            raise CollectionError("安全策略不执行 MCP 的外部凭证辅助命令")
        headers = {str(k): str(v) for k, v in (transport.get("http_headers") or {}).items()}
        for header, env_name in (transport.get("env_http_headers") or {}).items():
            value = os.getenv(str(env_name))
            if value:
                headers[str(header)] = value
        bearer_env = transport.get("bearer_token_env_var")
        if bearer_env and os.getenv(str(bearer_env)):
            headers["Authorization"] = "Bearer " + os.environ[str(bearer_env)]
        return cls(str(transport.get("url", "")), headers)

    @staticmethod
    def _decode_response(content_type: str, body: bytes) -> Any:
        if len(body) > MAX_MCP_OUTPUT:
            raise CollectionError("领星 MCP 返回超过安全大小限制")
        text = body.decode("utf-8", errors="strict")
        if "text/event-stream" in content_type:
            events = []
            for block in text.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in block.splitlines()
                                 if line.startswith("data:"))
                if data:
                    events.append(_json_from_text(data))
            if not events:
                raise CollectionError("领星 MCP SSE 响应为空")
            return events[-1]
        if not text.strip():
            return None
        return _json_from_text(text)

    def _post(self, payload: dict) -> Any:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **self.headers,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(
            self.url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session_id = session
                return self._decode_response(response.headers.get("Content-Type", ""), response.read())
        except urllib.error.HTTPError as exc:
            # Never include response bodies or request headers: either may contain secrets.
            raise CollectionError(f"领星 MCP HTTP 请求失败（状态码 {exc.code}）") from None
        except (urllib.error.URLError, TimeoutError, UnicodeError, OSError):
            raise CollectionError("领星 MCP 网络连接失败或响应无法解析") from None

    def initialize(self) -> None:
        self.request_id += 1
        result = self._post({
            "jsonrpc": "2.0", "id": self.request_id, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "amazon-sales-readonly-collector", "version": "1.0"},
            },
        })
        if not isinstance(result, dict) or ("result" not in result and "error" in result):
            raise CollectionError("领星 MCP 初始化失败")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def call_tool(self, name: str, arguments: dict) -> Any:
        self.request_id += 1
        response = self._post({
            "jsonrpc": "2.0", "id": self.request_id, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        if not isinstance(response, dict) or "error" in response:
            raise CollectionError(f"领星 MCP {name} 调用失败")
        result = response.get("result")
        if isinstance(result, dict) and result.get("isError"):
            raise CollectionError(f"领星 MCP {name} 返回工具错误")
        return _extract_mcp_payload(response)


def _tool_data(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise CollectionError("领星 MCP 工具元数据格式无效")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise CollectionError("领星 MCP 工具元数据缺少 data")
    return data


def _lingxing_params(tool_id: str, request: dict, scope: dict | None = None) -> dict:
    scope = scope or {}
    asin = request["asin"]
    if tool_id == "erp_listing":
        if scope.get("parent_asin"):
            return {"offset": 0, "length": 200, "pvi_ids": "", "search_field": "parent_asin",
                    "search_value": [scope["parent_asin"]], "exact_search": "1"}
        return {"offset": 0, "length": 200, "pvi_ids": "", "search_field": "asin",
                "search_value": [asin], "exact_search": "1"}
    if tool_id == "get_fba_stock_list":
        asins = sorted(set(scope.get("asins") or [asin]))
        if len(asins) > 1:
            advanced = [{"name": "ASIN", "search_field": "asin", "search_value": asins}]
            return {"offset": 0, "length": 1000, "senior_search_list": json.dumps(advanced),
                    "fulfillment_channel_type": "FBA", "is_hide_zero_stock": "0"}
        return {"offset": 0, "length": 1000, "search_field": "asin",
                "search_value": asins[0], "fulfillment_channel_type": "FBA",
                "is_hide_zero_stock": "0"}
    if tool_id == "query_product_performance_asin_lists":
        start_year, start_month = map(int, request["start_month"].split("-"))
        today = datetime.now().date()
        historical_year = min(start_year - 2, today.year - 2)
        historical_month = start_month if historical_year == start_year - 2 else today.month
        end_date = today.isoformat()
        return {
            "offset": 0, "length": 500, "start_date": f"{historical_year:04d}-{historical_month:02d}-01",
            "end_date": end_date, "date_type": "purchase", "date_view_type": "month",
            "date_view_order_type": 1, "summary_field": "sku", "summary_field_level1": "sku",
            "search_field": "parent_asin" if scope.get("parent_asin") else "asin",
            "search_value": [scope.get("parent_asin") or asin], "turn_on_summary": 1,
            "query_order_profit": True,
        }
    if tool_id == "query_fba_valid_list":
        if scope.get("parent_asin"):
            return {"offset": 0, "length": 200, "dataType": 4,
                    "parentAsin": scope["parent_asin"], "fulfillmentChannelType": "FBA",
                    "analysisMode": 2}
        return {"offset": 0, "length": 200, "dataType": 1, "searchField": "asin",
                "searchValue": asin, "fulfillmentChannelType": "FBA", "analysisMode": 2}
    raise CollectionError("领星工具不在本地只读白名单")


QUALITY_FIELD_GROUPS = {
    "listing_and_sku_mapping": {
        "asin": ("asin", "ASIN"), "parent_asin": ("parent_asin", "parentAsin"),
        "sku": ("sku", "local_sku", "localSku"), "msku": ("msku", "seller_sku", "sellerSku"),
        "fnsku": ("fnsku", "FNSKU"),
    },
    "inventory_snapshot": {
        "fba_available": ("afn_fulfillable_quantity", "fba_available_quantity", "available_quantity"),
        "fba_transfer_pending": ("pending_transfer_quantity", "transfer_quantity",
                                 "reserved_fc_transfers", "afn_reserved_fc_transfers"),
        "fba_inbound": ("inbound_quantity", "inbound_working_quantity", "inbound_shipped_quantity",
                        "inbound_receiving_quantity", "afn_inbound_working_quantity",
                        "afn_inbound_shipped_quantity", "afn_inbound_receiving_quantity"),
        "actual_transit": ("real_transit_quantity", "actual_transit_quantity"),
        "planned_inbound": ("stock_up_num", "planned_inbound_quantity"),
        "awd_available": ("awd_available_quantity", "awd_available", "awd_available_inventory",
                          "awd_usable_quantity"),
        "awd_standard_transit": ("awd_standard_transit_quantity", "awd_standard_transit",
                                 "awd_inbound_quantity", "awd_to_fba_quantity"),
    },
    "replenishment_inventory": {
        "actual_transit": ("real_transit_quantity", "actualTransitQuantity"),
        "planned_inbound": ("stock_up_num", "stockUpNum"),
        "available": ("available_quantity", "availableQuantity", "afn_fulfillable_quantity"),
    },
    "historical_sales": {
        "period": ("date", "month", "date_time", "dateTime"),
        "sales_units": ("volume", "sales_quantity", "salesQuantity", "totalSalesQuantity"),
        "sales_amount": ("sales_amount", "salesAmount", "totalSalesAmount"),
    },
}
REQUIRED_QUALITY_FIELDS = {
    "listing_and_sku_mapping": {"asin", "parent_asin", "sku"},
    "inventory_snapshot": {"fba_available", "fba_transfer_pending", "fba_inbound",
                           "awd_available", "awd_standard_transit"},
    "replenishment_inventory": {"actual_transit", "planned_inbound"},
    "historical_sales": {"period", "sales_units"},
}


def _business_records(payload: Any) -> list[dict]:
    """Return the largest record-like list while preserving the raw payload separately."""
    lists: list[list[dict]] = []

    def visit(value: Any) -> None:
        if isinstance(value, list):
            rows = [item for item in value if isinstance(item, dict)]
            if rows:
                lists.append(rows)
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            for child in value.values():
                visit(child)

    visit(payload)
    return max(lists, key=len) if lists else []


def _payload_failed(payload: Any) -> bool:
    return isinstance(payload, dict) and (
        payload.get("success") is False or payload.get("ok") is False or bool(payload.get("error"))
    )


def _field_quality(rows: list[dict], groups: dict[str, tuple[str, ...]]) -> dict[str, str]:
    quality = {}
    nested_rows = [item for row in rows for item in _walk(row)]
    for label, aliases in groups.items():
        values = [item[key] for item in nested_rows for key in aliases
                  if key in item and item[key] not in (None, "")]
        if not values:
            quality[label] = "field_missing"
        elif all(type(value) in (int, float) and value == 0 for value in values):
            quality[label] = "reported_zero"
        else:
            quality[label] = "value_present"
    return quality


def _query_summary(payload: Any, purpose: str) -> dict:
    if _payload_failed(payload):
        return {"status": "interface_failed", "record_count": 0, "field_quality": {}}
    rows = _business_records(payload)
    if not rows:
        return {"status": "empty_response", "record_count": 0, "field_quality": {}}
    quality = _field_quality(rows, QUALITY_FIELD_GROUPS.get(purpose, {}))
    required = REQUIRED_QUALITY_FIELDS.get(purpose, set())
    status = "field_missing" if any(quality.get(name) == "field_missing" for name in required) else "ok"
    return {"status": status, "record_count": len(rows), "field_quality": quality}


def _values(payload: Any, aliases: tuple[str, ...]) -> set[str]:
    values = set()
    for item in _walk(payload):
        for key in aliases:
            value = item.get(key)
            if value not in (None, ""):
                values.add(str(value).upper())
    return values


def _historical_coverage(payload: Any, request: dict) -> dict:
    start_year, start_month = map(int, request["start_month"].split("-"))
    end_year, end_month = map(int, request["end_month"].split("-"))
    start_index, end_index = start_year * 12 + start_month - 1, end_year * 12 + end_month - 1
    required = []
    for index in range(start_index, end_index + 1):
        prior = index - 12
        required.append(f"{prior // 12:04d}-{prior % 12 + 1:02d}")
    observed = set()
    for item in _walk(payload):
        for key in QUALITY_FIELD_GROUPS["historical_sales"]["period"]:
            value = str(item.get(key) or "")
            match = re.search(r"20\d{2}-(?:0[1-9]|1[0-2])", value)
            if match:
                observed.add(match.group(0))
    missing = [month for month in required if month not in observed]
    return {
        "required_prior_year_months": required,
        "observed_months": sorted(observed),
        "missing_prior_year_months": missing,
        "status": "complete" if not missing else "incomplete",
    }


def collect_lingxing(request: dict, codex_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "records": {}, "tools": [],
              "queries": {}, "family_scope": {}, "error": ""}
    try:
        client = StreamableHttpMcpClient.from_codex_config(codex_bin)
        client.initialize()
        schemas = {}
        for tool_id in LINGXING_READ_ALLOWLIST:
            try:
                help_data = _tool_data(client.call_tool("help", {"query": tool_id, "limit": 50, "offset": 0}))
                tools = help_data.get("tools", [])
                matched = [tool for tool in tools if isinstance(tool, dict) and tool.get("toolId") == tool_id]
                if len(matched) != 1 or matched[0].get("toolType") != "read":
                    raise CollectionError(f"领星工具 {tool_id} 未通过 help 只读校验")
                search_data = _tool_data(client.call_tool("search", {"toolId": tool_id}))
                if search_data.get("toolId") != tool_id or search_data.get("toolType") != "read":
                    raise CollectionError(f"领星工具 {tool_id} 未通过 search 只读校验")
                schemas[tool_id] = search_data.get("inputSchema", {})
            except CollectionError as exc:
                source["queries"][tool_id] = {"status": "interface_failed", "stage": "metadata", "error": str(exc)}

        def execute(tool_id: str, purpose: str, params: dict, key: str | None = None) -> Any | None:
            query_key = key or purpose
            if tool_id not in schemas:
                return None
            try:
                _schema_validate(schemas[tool_id], params)
                payload = client.call_tool("action", {"toolId": tool_id, "params": params})
                clean = _redact_sensitive(payload)
                summary = _query_summary(clean, purpose)
                page_size = params.get("length")
                if type(page_size) is int:
                    summary["pagination_complete"] = summary["record_count"] < page_size
                    if summary["record_count"] >= page_size and summary["status"] == "ok":
                        summary["status"] = "possibly_truncated"
                context = {name: params[name] for name in (
                    "search_field", "searchField", "dataType", "start_date", "end_date",
                    "date_view_type", "summary_field"
                ) if name in params}
                if "senior_search_list" in params:
                    context["multi_asin_scope"] = True
                source["queries"][query_key] = {
                    **summary, "tool_id": tool_id, "query_context": context
                }
                if _payload_failed(clean):
                    return None
                if tool_id not in source["tools"]:
                    source["tools"].append(tool_id)
                return clean
            except CollectionError as exc:
                source["queries"][query_key] = {
                    "status": "interface_failed", "stage": "action", "tool_id": tool_id, "error": str(exc)
                }
                return None

        def execute_paginated(tool_id: str, purpose: str, params: dict, key: str,
                              max_pages: int = 20) -> Any | None:
            page_size = params.get("length")
            if type(page_size) is not int or "offset" not in params:
                return execute(tool_id, purpose, params, key)
            pages, summaries = [], []
            complete = False
            for page_index in range(max_pages):
                page_params = {**params, "offset": page_index * page_size}
                page_key = f"{key}__page_{page_index + 1}"
                payload = execute(tool_id, purpose, page_params, page_key)
                summary = source["queries"].pop(page_key, {
                    "status": "interface_failed", "record_count": 0, "field_quality": {},
                    "tool_id": tool_id,
                })
                summaries.append(summary)
                if payload is None:
                    break
                pages.append(payload)
                if summary.get("record_count", 0) < page_size:
                    complete = True
                    break
            total = sum(item.get("record_count", 0) for item in summaries)
            fields = {field for item in summaries for field in item.get("field_quality", {})}
            combined_quality = {}
            for field in fields:
                values = [item.get("field_quality", {}).get(field) for item in summaries]
                combined_quality[field] = (
                    "value_present" if "value_present" in values else
                    "reported_zero" if "reported_zero" in values else "field_missing"
                )
            required = REQUIRED_QUALITY_FIELDS.get(purpose, set())
            if any(item.get("status") == "interface_failed" for item in summaries):
                status = "interface_failed"
            elif total == 0:
                status = "empty_response"
            elif any(combined_quality.get(field) == "field_missing" for field in required):
                status = "field_missing"
            elif not complete:
                status = "possibly_truncated"
            else:
                status = "ok"
            source["queries"][key] = {
                "status": status, "record_count": total, "field_quality": combined_quality,
                "pagination_complete": complete, "page_count": len(pages), "tool_id": tool_id,
                "query_context": summaries[0].get("query_context", {}) if summaries else {},
            }
            first_error = next((item.get("error") for item in summaries if item.get("error")), None)
            if first_error:
                source["queries"][key]["error"] = first_error
            if not pages:
                return None
            return pages[0] if len(pages) == 1 else {"pages": pages}

        requested_listing = execute_paginated(
            "erp_listing", "listing_and_sku_mapping", _lingxing_params("erp_listing", request),
            "listing_requested_asin"
        )
        parents = _values(requested_listing, ("parent_asin", "parentAsin")) if requested_listing else set()
        parent_asin = sorted(parents)[0] if len(parents) == 1 else request["asin"]
        # The webpage normally supplies a parent ASIN. If it supplies a child ASIN,
        # the first query discovers the parent and this second scoped query expands it.
        family_listing = execute_paginated(
            "erp_listing", "listing_and_sku_mapping",
            _lingxing_params("erp_listing", request, {"parent_asin": parent_asin}),
            "listing_parent_family",
        )
        if not _business_records(family_listing):
            # Do not assert that the requested ASIN is a parent when expansion returned no rows.
            if not parents:
                parent_asin = None
        listing_records = {"requested_asin": requested_listing}
        if family_listing is not None:
            listing_records["parent_family"] = family_listing
        source["records"]["listing_and_sku_mapping"] = listing_records
        asins = _values(listing_records, ("asin", "ASIN"))
        asins.add(request["asin"])
        source["family_scope"] = {
            "parent_asin": parent_asin,
            "child_asins": sorted(asins),
            "mapping_status": "complete_candidate" if parent_asin and family_listing and
            source["queries"].get("listing_parent_family", {}).get("pagination_complete") is True
            else "needs_review",
        }
        scope = {"parent_asin": parent_asin, "asins": sorted(asins)}
        for tool_id, purpose in LINGXING_READ_ALLOWLIST.items():
            if tool_id == "erp_listing":
                continue
            payload = execute_paginated(tool_id, purpose, _lingxing_params(tool_id, request, scope), purpose)
            if payload is not None:
                source["records"][purpose] = payload
                if purpose == "historical_sales":
                    coverage = _historical_coverage(payload, request)
                    source["queries"][purpose]["coverage"] = coverage
                    if coverage["status"] == "incomplete" and source["queries"][purpose]["status"] == "ok":
                        source["queries"][purpose]["status"] = "period_incomplete"

        query_states = [item.get("status") for key, item in source["queries"].items()
                        if not (key == "listing_requested_asin" and
                                source["queries"].get("listing_parent_family", {}).get("status") == "ok")]
        bad = {"interface_failed", "empty_response", "field_missing", "possibly_truncated",
               "period_incomplete"}
        source["status"] = "ok" if query_states and not any(state in bad for state in query_states) else (
            "partial" if source["records"] else "error"
        )
        failures = sum(state in bad for state in query_states)
        if failures:
            source["error"] = f"{failures} 个领星只读查询存在失败、空响应或字段缺失，已保留逐项状态"
    except CollectionError as exc:
        source["error"] = str(exc)
        source["status"] = "partial" if source["records"] else "error"
    return source


def resolve_lark_cli() -> str | None:
    return shutil.which("lark-cli")


def _run_lark(lark_bin: str, args: list[str]) -> Any:
    command = tuple(args[:2])
    if len(args) < 2 or command not in LARK_READ_COMMANDS:
        raise CollectionError("飞书命令未通过本地只读白名单")
    index = 2
    while index < len(args):
        flag = args[index]
        if flag not in LARK_ALLOWED_FLAGS[command]:
            raise CollectionError("飞书命令包含不允许的参数")
        index += 1 if flag in LARK_BOOLEAN_FLAGS else 2
        if index > len(args):
            raise CollectionError("飞书命令参数不完整")
    try:
        env = os.environ.copy()
        # Notifiers belong on stderr and can obscure machine-readable diagnostics.
        env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
        env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
        proc = subprocess.run(
            [lark_bin, *args], capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=COLLECTION_TIMEOUT, check=False,
            cwd=str(Path.home()), env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CollectionError("飞书 CLI 无法启动或读取超时") from None
    if proc.returncode != 0:
        category = "unknown"
        lowered = proc.stderr.casefold()
        try:
            envelope = json.loads(proc.stderr)
            error = envelope.get("error", envelope) if isinstance(envelope, dict) else {}
            error_type = str(error.get("type") or "").casefold()
            subtype = str(error.get("subtype") or "").casefold()
            message = str(error.get("message") or "").casefold()
            combined = " ".join((error_type, subtype, message))
            if "duplicate" in combined and "header" in combined:
                category = "duplicate_header"
            elif "auth" in combined or "permission" in combined or "scope" in combined:
                category = "authorization"
            elif error_type == "validation" or subtype:
                category = "validation"
        except (json.JSONDecodeError, TypeError, AttributeError):
            if any(marker in lowered for marker in ("unknown flag", "required flag", "unknown command", "accepts")):
                category = "cli_usage"
        raise LarkCommandError(" ".join(args[:2]), proc.returncode, category)
    if len(proc.stdout) > MAX_LARK_OUTPUT:
        raise CollectionError("飞书返回数据超过安全大小限制")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise CollectionError("飞书 CLI 未返回有效 JSON") from None


def _list_items(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("items", "spaces", "nodes", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = _list_items(value)
            if nested:
                return nested
    return []


def _node_match_type(node: dict, request: dict) -> str | None:
    title = str(node.get("title") or node.get("name") or "").casefold()
    target_terms = [request["asin"].casefold(), request["product"].casefold()]
    if any(term and term in title for term in target_terms):
        return "target"
    if any(term in title for term in ("销售计划", "库存", "利润")):
        return "reference"
    return None


def _node_matches(node: dict, request: dict) -> bool:
    return _node_match_type(node, request) is not None


def collect_lark(request: dict, lark_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "knowledge_base": "",
              "documents": [], "document_errors": [], "warnings": [], "error": ""}
    try:
        auth = _run_lark(lark_bin, ["auth", "status", "--json", "--verify"])
        if not isinstance(auth, dict) or auth.get("verified") is not True or auth.get("identity") != "user":
            raise CollectionError("飞书用户授权状态无法确认")
        spaces_payload = _run_lark(lark_bin, [
            "wiki", "+space-list", "--as", "user", "--page-all", "--page-limit", "10", "--format", "json"
        ])
        target_name = request.get("knowledge_base") or DEFAULT_KNOWLEDGE_BASE
        spaces = _list_items(spaces_payload)
        matches = [space for space in spaces if str(space.get("name") or space.get("title") or "") == target_name]
        if len(matches) != 1:
            raise CollectionError(f"未能唯一定位飞书知识库「{target_name}」")
        space = matches[0]
        space_id = str(space.get("space_id") or space.get("spaceId") or space.get("id") or "")
        if not space_id:
            raise CollectionError("飞书知识库缺少可读取的 space_id")
        source["knowledge_base"] = target_name
        queue: list[str | None] = [None]
        visited: set[str] = set()
        candidates: list[dict] = []
        while queue and len(visited) < 200:
            parent = queue.pop(0)
            args = ["wiki", "+node-list", "--space-id", space_id, "--as", "user",
                    "--page-all", "--page-limit", "4", "--format", "json"]
            if parent:
                args.extend(["--parent-node-token", parent])
            nodes = _list_items(_run_lark(lark_bin, args))
            for node in nodes:
                token = str(node.get("node_token") or node.get("nodeToken") or "")
                if token and token not in visited:
                    visited.add(token)
                    if node.get("has_child") or node.get("hasChild"):
                        queue.append(token)
                match_type = _node_match_type(node, request)
                if match_type:
                    candidates.append({**node, "_match_type": match_type})
        # Read only spreadsheet nodes, most specific matches first, bounded to avoid bulk export.
        candidates.sort(key=lambda n: (request["asin"].casefold() not in str(n.get("title", "")).casefold(),
                                       "销售计划" not in str(n.get("title", ""))))
        sheet_candidates = [node for node in candidates if
                            str(node.get("obj_type") or node.get("objType") or "").lower()
                            in ("sheet", "spreadsheet")]
        target_candidates = [node for node in sheet_candidates if node.get("_match_type") == "target"]
        selected = (target_candidates or sheet_candidates)[:5]
        source["target_match_found"] = bool(target_candidates)
        for index, node in enumerate(selected, start=1):
            obj_type = str(node.get("obj_type") or node.get("objType") or "").lower()
            if obj_type not in ("sheet", "spreadsheet"):
                continue
            token = str(node.get("obj_token") or node.get("objToken") or "")
            if not token:
                continue
            try:
                workbook = _run_lark(lark_bin, ["sheets", "+workbook-info", "--spreadsheet-token", token,
                                                       "--as", "user", "--format", "json"])
                table_args = ["sheets", "+table-get", "--spreadsheet-token", token,
                              "--as", "user", "--max-chars", "500000", "--format", "json"]
                read_mode = "header"
                try:
                    table = _run_lark(lark_bin, table_args)
                except LarkCommandError as exc:
                    if exc.category != "duplicate_header":
                        raise
                    # +table-get refuses duplicate names because the result could not round-trip.
                    # Positional columns are lossless for analysis and remain strictly read-only.
                    table = _run_lark(lark_bin, [*table_args, "--no-header"])
                    read_mode = "positional_no_header"
                    source["warnings"].append(
                        f"第 {index} 个匹配表格存在重复表头，已按位置列只读；列名需要人工核对。"
                    )
            except CollectionError as exc:
                source["document_errors"].append({"candidate": index, "error": str(exc)})
                continue
            source["documents"].append({
                # Resource locators are used in-memory for the read then discarded. They are
                # not credentials, but omitting them also prevents accidental disclosure.
                "title": str(node.get("title") or ""), "match_type": node.get("_match_type"),
                "read_mode": read_mode,
                "workbook": _redact_sensitive(workbook), "table": _redact_sensitive(table),
            })
        if not source["documents"]:
            if source["document_errors"]:
                source["status"] = "error"
                source["error"] = "知识库可访问，但匹配表格均读取失败"
            else:
                source["status"] = "missing"
                source["error"] = "知识库可访问，但未找到匹配的销售计划电子表格"
        elif source["document_errors"]:
            source["status"] = "partial"
            source["error"] = f"已读取 {len(source['documents'])} 个表格，另有 {len(source['document_errors'])} 个读取失败"
        elif not source["target_match_found"]:
            source["status"] = "partial"
            source["error"] = "知识库可访问且参考表格可读取，但未找到标题匹配当前产品或 ASIN 的表格"
        else:
            source["status"] = "ok"
    except CollectionError as exc:
        source["error"] = str(exc)
    return source


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def build_sku_map(sources: dict) -> list[dict]:
    aliases = {
        "asin": ("asin", "ASIN"), "parent_asin": ("parent_asin", "parentAsin", "父ASIN"),
        "sku": ("sku", "SKU", "local_sku", "localSku"),
        "msku": ("msku", "MSKU", "seller_sku", "sellerSku"),
        "fnsku": ("fnsku", "FNSKU"),
    }
    found: list[dict] = []
    for source_name, source in sources.items():
        for row in _walk(source.get("records", source.get("documents", []))):
            mapped = {}
            for canonical, keys in aliases.items():
                for key in keys:
                    if row.get(key) not in (None, ""):
                        mapped[canonical] = str(row[key])
                        break
            if mapped.get("asin") and any(mapped.get(key) for key in ("sku", "msku", "fnsku")):
                identifiers = {mapped.get(name) for name in ("sku", "msku", "fnsku") if mapped.get(name)}
                entry = next((item for item in found if item.get("asin") == mapped["asin"] and
                              identifiers.intersection({item.get(name) for name in ("sku", "msku", "fnsku")})), None)
                if entry is None:
                    entry = {**mapped, "sources": []}
                    found.append(entry)
                else:
                    for name, value in mapped.items():
                        entry.setdefault(name, value)
                if source_name not in entry["sources"]:
                    entry["sources"].append(source_name)
    return found[:500]


def collect_trusted_data(request: dict, codex_bin: str | None, lark_bin: str | None,
                         simulated: dict | None = None) -> dict:
    """Collect all sources before Codex starts; never persists the returned snapshot."""
    if simulated is not None:
        return simulated
    sources = {
        "lingxing": collect_lingxing(request, codex_bin) if codex_bin else {
            "status": "error", "collected_at": utc_now(), "records": {}, "tools": [],
            "error": "未找到 Codex CLI，无法读取 yb-lingxing MCP 配置",
        },
        "feishu": collect_lark(request, lark_bin) if lark_bin else {
            "status": "error", "collected_at": utc_now(), "knowledge_base": "",
            "documents": [], "error": "未找到 lark-cli",
        },
    }
    warnings = [f"{name}: {source['error']}" for name, source in sources.items() if source.get("error")]
    for name, source in sources.items():
        warnings.extend(f"{name}: {warning}" for warning in source.get("warnings", []))
    statuses = {source.get("status") for source in sources.values()}
    overall = "ok" if statuses == {"ok"} else "partial" if "ok" in statuses or "partial" in statuses else "blocked"
    return {
        "schema_version": "1.1", "collected_at": utc_now(), "overall_status": overall,
        "request_identity": {key: request[key] for key in ("asin", "site", "start_month", "end_month")},
        "sources": sources, "sku_map": build_sku_map(sources), "warnings": warnings,
        "rules": {
            "inventory": "按SKU核对FBA可售、待调仓、入库中、实际在途、计划入库、AWD可用、AWD标发在途；批次不清不得相加；reported_zero仅表示接口明确返回0，field_missing/empty_response/interface_failed绝不能当0",
            "allocation": "月度比例为输入、销量为输出；逐SKU不得超过已核对库存，不得跨SKU抵消",
            "profit": "成本缺失标待核算，不得把缺失成本或利润当作0",
        },
    }
