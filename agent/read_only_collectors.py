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
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sales_data_mapping import (
    FIELD_ALIASES, IDENTITY_ALIASES, REQUIRED_CANONICAL_FIELDS,
    build_scope_from_mapping, canonical_field_quality, canonicalize_records, mapping_conflicts,
    mapping_context_issues,
)
from sales_plan_engine import build_plan_evidence

COLLECTION_TIMEOUT = 90
MAX_LARK_OUTPUT = 2_000_000
MAX_MCP_OUTPUT = 3_000_000
MCP_MIN_REQUEST_INTERVAL = 1.25
MCP_RETRY_DELAYS = (3.0, 8.0)
MCP_APPROVAL_POLL_INTERVAL = 2.0
MCP_APPROVAL_POLL_ATTEMPTS = 15
DEFAULT_KNOWLEDGE_BASE = "至拓-运营"

# Exact IDs only. A matching name or description is never sufficient.
LINGXING_READ_ALLOWLIST = {
    "erp_listing": "listing_and_sku_mapping",
    "get_fba_stock_list": "inventory_snapshot",
    "query_fba_valid_list": "replenishment_inventory",
    "query_product_performance_asin_lists": "historical_sales",
}
STORE_OPTIONS_TOOL_ID = "amazon_sc_seller_list"
MAX_LARK_SHEET_CANDIDATES = 12

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


class McpCallError(CollectionError):
    """Sanitized MCP transport/tool failure with a stable diagnostic category."""

    def __init__(self, operation: str, category: str, http_status: int | None = None,
                 retryable: bool = False):
        self.operation = operation
        self.category = category
        self.http_status = http_status
        self.retryable = retryable
        labels = {
            "rate_limited": "认证请求频率受限",
            "authentication": "认证失败",
            "authorization": "权限不足",
            "validation": "请求参数校验失败",
            "upstream": "上游服务异常",
            "timeout": "上游服务超时",
            "tool_error": "工具返回错误",
            "rpc_error": "JSON-RPC 返回错误",
            "approval_pending": "审批或服务端执行未完成",
            "approval_rejected": "审批被拒绝或服务端执行失败",
        }
        status = f"，HTTP {http_status}" if http_status else ""
        super().__init__(f"领星 MCP {operation} 失败（{labels.get(category, labels['tool_error'])}{status}）")


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

    def __init__(self, url: str, headers: dict[str, str], timeout: int = COLLECTION_TIMEOUT,
                 source_label: str = "领星"):
        if not url.lower().startswith("https://"):
            raise CollectionError(f"{source_label} MCP 必须使用 HTTPS")
        self.url = url
        self.headers = dict(headers)
        self.timeout = timeout
        self.source_label = source_label
        self.session_id: str | None = None
        self.request_id = 0
        self.last_request_at = 0.0

    @classmethod
    def from_codex_config(cls, codex_bin: str, server_name: str = "yb-lingxing",
                          source_label: str = "领星") -> "StreamableHttpMcpClient":
        try:
            proc = subprocess.run(
                [codex_bin, "mcp", "get", server_name, "--json"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=20, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise CollectionError(f"无法读取本机{source_label} MCP 配置") from None
        if proc.returncode != 0 or len(proc.stdout) > 200_000:
            raise CollectionError(f"本机未找到可用的 {server_name} MCP 配置")
        try:
            config = json.loads(proc.stdout)
            transport = config["transport"]
        except (json.JSONDecodeError, KeyError, TypeError):
            raise CollectionError(f"{server_name} MCP 配置格式无法识别") from None
        if not config.get("enabled") or transport.get("type") != "streamable_http":
            raise CollectionError(f"{server_name} MCP 未启用或不是受支持的 HTTP 类型")
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
        return cls(str(transport.get("url", "")), headers, source_label=source_label)

    def _decode_response(self, content_type: str, body: bytes) -> Any:
        if len(body) > MAX_MCP_OUTPUT:
            raise CollectionError(f"{self.source_label} MCP 返回超过安全大小限制")
        text = body.decode("utf-8", errors="strict")
        if "text/event-stream" in content_type:
            events = []
            for block in text.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in block.splitlines()
                                 if line.startswith("data:"))
                if data:
                    events.append(_json_from_text(data))
            if not events:
                raise CollectionError(f"{self.source_label} MCP SSE 响应为空")
            return events[-1]
        if not text.strip():
            return None
        return _json_from_text(text)

    def _wait_for_request_slot(self) -> None:
        remaining = MCP_MIN_REQUEST_INTERVAL - (time.monotonic() - self.last_request_at)
        if remaining > 0:
            time.sleep(remaining)

    def _post_once(self, payload: dict) -> Any:
        self._wait_for_request_slot()
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
                self.last_request_at = time.monotonic()
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session_id = session
                body = response.read(MAX_MCP_OUTPUT + 1)
                return self._decode_response(response.headers.get("Content-Type", ""), body)
        except urllib.error.HTTPError as exc:
            self.last_request_at = time.monotonic()
            # Never include response bodies or request headers: either may contain secrets.
            category = (
                "rate_limited" if exc.code == 429 else
                "authentication" if exc.code == 401 else
                "authorization" if exc.code == 403 else
                "validation" if exc.code in (400, 404, 422) else
                "upstream" if exc.code >= 500 else "tool_error"
            )
            raise McpCallError("HTTP", category, exc.code,
                               retryable=exc.code == 429 or exc.code >= 500) from None
        except (urllib.error.URLError, TimeoutError, UnicodeError, OSError):
            self.last_request_at = time.monotonic()
            raise McpCallError("HTTP", "timeout", retryable=True) from None

    def _post(self, payload: dict) -> Any:
        for attempt in range(len(MCP_RETRY_DELAYS) + 1):
            try:
                return self._post_once(payload)
            except McpCallError as exc:
                if not exc.retryable or attempt >= len(MCP_RETRY_DELAYS):
                    raise
                time.sleep(MCP_RETRY_DELAYS[attempt])
        raise AssertionError("unreachable")

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
            raise CollectionError(f"{self.source_label} MCP 初始化失败")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def call_tool(self, name: str, arguments: dict) -> Any:
        for attempt in range(len(MCP_RETRY_DELAYS) + 1):
            self.request_id += 1
            response = self._post({
                "jsonrpc": "2.0", "id": self.request_id, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            })
            if not isinstance(response, dict) or "error" in response:
                raise McpCallError(name, "rpc_error")
            result = response.get("result")
            if isinstance(result, dict) and result.get("isError"):
                error = _classify_mcp_tool_error(name, result)
                if error.retryable and attempt < len(MCP_RETRY_DELAYS):
                    time.sleep(MCP_RETRY_DELAYS[attempt])
                    continue
                raise error
            return _extract_mcp_payload(response)
        raise AssertionError("unreachable")


def _classify_mcp_tool_error(operation: str, result: dict) -> McpCallError:
    """Classify a tool error without retaining its raw text or trace identifier."""
    text = " ".join(
        str(item.get("text", "")) for item in result.get("content", [])
        if isinstance(item, dict) and item.get("type") == "text"
    )
    status_match = re.search(r"(?:status\s*:\s*|\"code\"\s*:\s*)(\d{3})", text, re.IGNORECASE)
    status = int(status_match.group(1)) if status_match else None
    folded = text.casefold()
    category = (
        "rate_limited" if status == 429 or "过于频繁" in text or "rate limit" in folded else
        "authentication" if status == 401 or "unauthenticated" in folded else
        "authorization" if status == 403 or "permission" in folded or "权限" in text else
        "validation" if status in (400, 404, 422) or "invalid" in folded or "参数" in text else
        "upstream" if status is not None and status >= 500 else
        "timeout" if "timeout" in folded or "超时" in text else "tool_error"
    )
    return McpCallError(operation, category, status,
                        retryable=category in ("rate_limited", "upstream", "timeout"))


def _failure_details(exc: CollectionError) -> dict:
    if isinstance(exc, McpCallError):
        return {
            "error_category": exc.category,
            "response_status": exc.http_status,
            "retryable": exc.retryable,
        }
    return {"error_category": "collection_error", "response_status": None, "retryable": False}


def _find_named_value(value: Any, names: set[str]) -> Any:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in names and child not in (None, ""):
                return child
        for child in value.values():
            found = _find_named_value(child, names)
            if found not in (None, ""):
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_named_value(child, names)
            if found not in (None, ""):
                return found
    return None


def _resolve_approval(client: StreamableHttpMcpClient, payload: Any) -> Any:
    """Poll status for an action-created approval; never approves or mutates it."""
    approval_ref = _find_named_value(payload, {"approval_ref", "approvalref"})
    if not isinstance(approval_ref, str) or not approval_ref:
        return payload
    completed = {"completed", "complete", "succeeded", "success", "done", "已完成", "成功"}
    failed = {"failed", "failure", "rejected", "denied", "expired", "cancelled",
              "canceled", "失败", "已拒绝", "已取消", "已过期"}
    for attempt in range(MCP_APPROVAL_POLL_ATTEMPTS):
        status_payload = client.call_tool("approval_status", {"approval_ref": approval_ref})
        state = _find_named_value(
            status_payload, {"approval_status", "approvalstatus", "execution_status",
                             "executionstatus", "status", "state"}
        )
        normalized = str(state).strip().casefold() if state is not None else ""
        if normalized in failed:
            raise McpCallError("approval_status", "approval_rejected")
        if normalized in completed or _business_records(status_payload):
            return status_payload
        if attempt + 1 < MCP_APPROVAL_POLL_ATTEMPTS:
            time.sleep(MCP_APPROVAL_POLL_INTERVAL)
    raise McpCallError("approval_status", "approval_pending")


def _tool_data(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise CollectionError("领星 MCP 工具元数据格式无效")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise CollectionError("领星 MCP 工具元数据缺少 data")
    return data


def collect_store_options(codex_bin: str | None) -> dict:
    """Read the live Amazon store list through the validated read-only MCP path."""
    source = {"status": "error", "collected_at": utc_now(), "stores": [], "error": ""}
    if not codex_bin:
        source["error"] = "未找到 Codex CLI，无法读取领星店铺列表"
        return source
    try:
        client = StreamableHttpMcpClient.from_codex_config(codex_bin)
        client.initialize()
        help_data = _tool_data(client.call_tool(
            "help", {"query": STORE_OPTIONS_TOOL_ID, "limit": 50, "offset": 0}
        ))
        matches = [item for item in help_data.get("tools", [])
                   if isinstance(item, dict) and item.get("toolId") == STORE_OPTIONS_TOOL_ID]
        if len(matches) != 1 or matches[0].get("toolType") != "read":
            raise CollectionError("领星店铺工具未通过只读校验")
        search_data = _tool_data(client.call_tool("search", {"toolId": STORE_OPTIONS_TOOL_ID}))
        if search_data.get("toolId") != STORE_OPTIONS_TOOL_ID or search_data.get("toolType") != "read":
            raise CollectionError("领星店铺工具 Schema 未通过只读校验")
        params = {"seller_type": 1, "offset": 0, "length": 200}
        _schema_validate(search_data.get("inputSchema", {}), params)
        payload = _resolve_approval(client, client.call_tool(
            "action", {"toolId": STORE_OPTIONS_TOOL_ID, "params": params}
        ))
        data = _redact_sensitive(_tool_data(payload))
        rows = data.get("list", [])
        stores = []
        for account in rows if isinstance(rows, list) else []:
            for item in account.get("itemList", []) if isinstance(account, dict) else []:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                status = item.get("status")
                disabled = item.get("is_disabled")
                stores.append({
                    "store_id": str(item.get("id")),
                    "name": str(item.get("name") or ""),
                    "marketplace": str(item.get("marketplace_code") or "").upper(),
                    "country": str(item.get("country") or ""),
                    "enabled": disabled != 1 and status == 1,
                    "authorization_status": "authorized" if status == 1 else "not_authorized_or_exception",
                    "seller_status": status,
                    "is_disabled": disabled,
                })
        source["stores"] = stores
        source["status"] = "ok"
    except CollectionError as exc:
        source["error"] = str(exc)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        source["error"] = f"领星店铺列表格式无效：{type(exc).__name__}"
    return source


def _lingxing_params(tool_id: str, request: dict, scope: dict | None = None) -> dict:
    scope = scope or {}
    asin = request["asin"]
    if tool_id == "erp_listing":
        store_id = str(request.get("store_id") or scope.get("store_id") or "").strip()
        store_filter = {"sids": store_id} if store_id else {}
        if scope.get("parent_asin"):
            return {"offset": 0, "length": 200, "pvi_ids": "", "search_field": "parent_asin",
                    "search_value": [scope["parent_asin"]], "exact_search": "1", **store_filter}
        return {"offset": 0, "length": 200, "pvi_ids": "", "search_field": "asin",
                "search_value": [asin], "exact_search": "1", **store_filter}
    if tool_id == "get_fba_stock_list":
        asins = sorted(set(scope.get("asins") or [asin]))
        store_id = str(request.get("store_id") or scope.get("store_id") or "").strip()
        store_filter = {"sid": store_id} if store_id else {}
        if len(asins) > 1:
            advanced = [{"name": "ASIN", "search_field": "asin", "search_value": asins}]
            return {"offset": 0, "length": 1000, "senior_search_list": json.dumps(advanced),
                    "fulfillment_channel_type": "FBA", "is_hide_zero_stock": "0", **store_filter}
        return {"offset": 0, "length": 1000, "search_field": "asin",
                "search_value": asins[0], "fulfillment_channel_type": "FBA",
                "is_hide_zero_stock": "0", **store_filter}
    if tool_id == "query_product_performance_asin_lists":
        start_year, start_month = map(int, request["start_month"].split("-"))
        today = datetime.now().date()
        # Include the full prior-year planning window and up to two years of trend.
        prior_start_index = start_year * 12 + start_month - 1 - 12
        trend_start_index = today.year * 12 + today.month - 1 - 24
        query_start_index = min(prior_start_index, trend_start_index)
        query_start = f"{query_start_index // 12:04d}-{query_start_index % 12 + 1:02d}-01"
        first_of_current = today.replace(day=1)
        last_complete_day = first_of_current - timedelta(days=1)
        params = {
            "offset": 0, "length": 500, "start_date": query_start,
            "end_date": last_complete_day.isoformat(), "date_type": "purchase", "date_view_type": "month",
            "date_view_order_type": 1, "summary_field": "sku", "summary_field_level1": "sku",
            "search_field": "parent_asin" if scope.get("parent_asin") else "asin",
            "search_value": [scope.get("parent_asin") or asin], "turn_on_summary": 1,
            # Profit is sourced separately from the target Feishu plan. Including it here
            # inflates the response and is not needed for natural-month unit history.
            "query_order_profit": False,
        }
        if request.get("store_id"):
            params["sids"] = str(request["store_id"])
        return params
    if tool_id == "query_fba_valid_list":
        # The live endpoint accepted parentAsin but returned unrelated parent
        # families. Use the validated child-ASIN scope and storeIdList instead;
        # any remaining upstream mismatch is retained as out-of-scope evidence.
        asins = sorted(set(scope.get("asins") or [asin]))
        # The live schema accepts seniorSearchList, but the current endpoint returns
        # HTTP-level success=false/code=500 for this field.  The equivalent validated
        # scope is storeIdList + searchField/searchValue, which returns a reliable
        # empty response when no replenishment rows exist.
        return {"offset": 0, "length": 200, "dataType": 1, "searchField": "asin",
                "searchValue": asins[0] if len(asins) == 1 else "",
                "storeIdList": [int(request["store_id"])] if str(request.get("store_id", "")).isdigit() else [],
                "fulfillmentChannelType": "FBA", "analysisMode": 2}
    raise CollectionError("领星工具不在本地只读白名单")


def _lingxing_recent_sales_params(request: dict, scope: dict) -> dict:
    """Use the validated performance tool for a separate, completed-day trend query."""
    today = datetime.now().date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=29)
    return {
        "offset": 0, "length": 500, "start_date": start.isoformat(), "end_date": end.isoformat(),
        "date_type": "purchase", "date_view_type": "day", "date_view_order_type": 1,
        "summary_field": "sku", "summary_field_level1": "sku",
        "search_field": "parent_asin" if scope.get("parent_asin") else "asin",
        "search_value": [scope.get("parent_asin") or request["asin"]],
        "turn_on_summary": 1, "query_order_profit": False,
        "sids": str(request["store_id"]) if request.get("store_id") else "",
    }


QUALITY_FIELD_GROUPS = FIELD_ALIASES
REQUIRED_QUALITY_FIELDS = REQUIRED_CANONICAL_FIELDS


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


def _business_failure_details(payload: Any) -> dict:
    code = _find_named_value(payload, {"code", "status_code", "statuscode"})
    status = int(code) if isinstance(code, (int, str)) and str(code).isdigit() else None
    category = (
        "rate_limited" if status == 429 else
        "authentication" if status == 401 else
        "authorization" if status == 403 else
        "validation" if status in (400, 404, 422) else
        "upstream" if status is not None and status >= 500 else "business_response_error"
    )
    message = _find_named_value(payload, {"msg", "message", "error_message"})
    return {
        "error_category": category, "response_status": status,
        "retryable": category in ("rate_limited", "upstream"),
        "error_message": str(message)[:500] if message not in (None, "") else None,
    }


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
    canonical, _ = canonicalize_records(payload, purpose)
    quality = canonical_field_quality(canonical, purpose)
    required = REQUIRED_QUALITY_FIELDS.get(purpose, set())
    missing_required = any(quality.get(name) == "field_missing" for name in required)
    if purpose == "inventory_snapshot":
        inbound = ("fba_inbound_total", "fba_inbound_working", "fba_inbound_shipped",
                   "fba_inbound_receiving")
        missing_required = missing_required or all(quality.get(name) == "field_missing" for name in inbound)
    status = "field_missing" if missing_required else "ok"
    return {"status": status, "record_count": len(rows), "field_quality": quality}


def _values(payload: Any, aliases: tuple[str, ...]) -> set[str]:
    values = set()
    for item in _walk(payload):
        for key in aliases:
            value = item.get(key)
            if value not in (None, ""):
                values.add(str(value).upper())
    return values


def _observed_fields(payload: Any) -> list[str]:
    """Return field names only, never values, for safe mapping diagnostics."""
    fields = {str(key) for item in _walk(payload) for key in item
              if not any(part in str(key).casefold() for part in SENSITIVE_KEY_PARTS)}
    return sorted(fields)[:200]


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
        for key in FIELD_ALIASES["historical_sales"]["period"]:
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


def _required_history_months(request: dict) -> list[str]:
    start_year, start_month = map(int, request["start_month"].split("-"))
    end_year, end_month = map(int, request["end_month"].split("-"))
    months = []
    for index in range(start_year * 12 + start_month - 1, end_year * 12 + end_month):
        prior = index - 12
        months.append(f"{prior // 12:04d}-{prior % 12 + 1:02d}")
    return months


def _history_month_params(request: dict, scope: dict, month: str) -> dict:
    year, month_number = map(int, month.split("-"))
    import calendar
    asins = sorted(set(scope.get("asins") or [request["asin"]]))
    params = {
        "offset": 0, "length": 200,
        "start_date": f"{month}-01",
        "end_date": f"{month}-{calendar.monthrange(year, month_number)[1]:02d}",
        "date_type": "purchase", "date_view_type": "month", "date_view_order_type": 1,
        # Verified live behavior: ASIN aggregation returned an empty response for
        # the same scope, while SKU aggregation with parent_asin returned rows.
        "summary_field": "sku", "summary_field_level1": "sku",
        "search_field": "parent_asin" if scope.get("parent_asin") else "asin",
        "search_value": [scope.get("parent_asin")] if scope.get("parent_asin") else asins,
        "turn_on_summary": 1, "query_order_profit": False,
    }
    if request.get("store_id"):
        params["sids"] = str(request["store_id"])
    return params


def _expand_history_rows(payload: Any, month: str, listing_rows: list[dict], request: dict) -> list[dict]:
    """Flatten performance rows whose ASIN/store identity is nested in `asins`."""
    mapping_by_asin = {
        str(row.get("asin")).upper(): row for row in listing_rows
        if isinstance(row, dict) and row.get("asin")
    }
    mapping_by_identifier = {}
    for row in listing_rows:
        if not isinstance(row, dict):
            continue
        for key in ("sku", "msku", "fnsku"):
            if row.get(key):
                mapping_by_identifier[str(row[key]).upper()] = row
    all_rows = list(_walk(payload))
    # With summary_field=asin Lingxing may expose a parent aggregate and a
    # nested SKU list. Prefer the SKU rows when present so aggregate totals are
    # not double-counted alongside their children.
    sku_rows = [row for row in all_rows if isinstance(row, dict) and
                (row.get("seller_sku") or row.get("local_sku")) and
                any(row.get(key) not in (None, "") for key in ("volume", "amount"))]
    candidate_rows = sku_rows or [row for row in all_rows if isinstance(row, dict) and
                                  any(row.get(key) not in (None, "") for key in ("volume", "amount"))]
    expanded = []
    for row in candidate_rows:
        nested = row.get("asins") if isinstance(row.get("asins"), list) else []
        identities = [item for item in nested if isinstance(item, dict)]
        if not identities and row.get("asin"):
            identities = [{"asin": row.get("asin"), "sid": row.get("sid") or request.get("store_id")}]
        if not identities and (row.get("seller_sku") or row.get("local_sku")):
            linked = mapping_by_identifier.get(str(row.get("seller_sku") or row.get("local_sku")).upper())
            if linked:
                identities = [{"asin": linked.get("asin"), "sid": row.get("sid") or request.get("store_id")}]
        for identity in identities:
            asin = str(identity.get("asin") or "").strip().upper()
            if not asin:
                continue
            item = dict(row)
            # The nested identity list is only a transport envelope. Leaving it
            # in the synthetic row makes canonicalize_records walk it again and
            # emit duplicate identity-only records without volume/amount.
            item.pop("asins", None)
            period_value = month or next(
                (row.get(key) for key in FIELD_ALIASES["recent_sales"]["period"]
                 if row.get(key) not in (None, "")),
                None,
            )
            item.update({"asin": asin, "period": period_value,
                         "store_id": identity.get("sid") or request.get("store_id"),
                         "site": request.get("site")})
            linked = mapping_by_asin.get(asin, {})
            for key in ("parent_asin", "sku", "msku", "fnsku"):
                if linked.get(key) and not item.get(key):
                    item[key] = linked[key]
            expanded.append(item)
    return expanded


def collect_lingxing(request: dict, codex_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "records": {}, "tools": [],
              "queries": {}, "family_scope": {}, "field_mapping_version": "2.0", "error": ""}
    try:
        client = StreamableHttpMcpClient.from_codex_config(codex_bin)
        client.initialize()
        schemas = {}
        common_metadata_failure: CollectionError | None = None
        for tool_id in LINGXING_READ_ALLOWLIST:
            metadata_stage = "help"
            if common_metadata_failure is not None:
                source["queries"][tool_id] = {
                    "status": "interface_failed", "stage": "help",
                    "error": str(common_metadata_failure),
                    **_failure_details(common_metadata_failure),
                }
                continue
            try:
                help_data = _tool_data(client.call_tool("help", {"query": tool_id, "limit": 50, "offset": 0}))
                tools = help_data.get("tools", [])
                matched = [tool for tool in tools if isinstance(tool, dict) and tool.get("toolId") == tool_id]
                if len(matched) != 1 or matched[0].get("toolType") != "read":
                    raise CollectionError(f"领星工具 {tool_id} 未通过 help 只读校验")
                metadata_stage = "search"
                search_data = _tool_data(client.call_tool("search", {"toolId": tool_id}))
                if search_data.get("toolId") != tool_id or search_data.get("toolType") != "read":
                    raise CollectionError(f"领星工具 {tool_id} 未通过 search 只读校验")
                schemas[tool_id] = search_data.get("inputSchema", {})
            except CollectionError as exc:
                source["queries"][tool_id] = {
                    "status": "interface_failed", "stage": metadata_stage, "error": str(exc),
                    **_failure_details(exc),
                }
                if isinstance(exc, McpCallError) and exc.category in (
                    "rate_limited", "authentication", "authorization"
                ):
                    common_metadata_failure = exc

        def execute(tool_id: str, purpose: str, params: dict, key: str | None = None) -> Any | None:
            query_key = key or purpose
            if tool_id not in schemas:
                metadata = source["queries"].get(tool_id, {})
                source["queries"][query_key] = {
                    "status": "interface_failed", "stage": metadata.get("stage", "metadata"),
                    "tool_id": tool_id,
                    "error": metadata.get("error", "领星 MCP 未取得工具元数据"),
                    "error_category": metadata.get("error_category", "metadata_unavailable"),
                    "response_status": metadata.get("response_status"),
                    "retryable": metadata.get("retryable", False),
                }
                return None
            try:
                _schema_validate(schemas[tool_id], params)
                payload = client.call_tool("action", {"toolId": tool_id, "params": params})
                payload = _resolve_approval(client, payload)
                clean = _redact_sensitive(payload)
                if _payload_failed(clean):
                    source["queries"][query_key] = {
                        "status": "interface_failed", "stage": "action_response",
                        "tool_id": tool_id, "error": "领星业务接口返回失败状态",
                        "request_params": params,
                        **_business_failure_details(clean),
                    }
                    return None
                summary = _query_summary(clean, purpose)
                page_size = params.get("length")
                if type(page_size) is int:
                    summary["pagination_complete"] = summary["record_count"] < page_size
                    if summary["record_count"] >= page_size and summary["status"] == "ok":
                        summary["status"] = "possibly_truncated"
                context = {name: params[name] for name in (
                    "search_field", "searchField", "dataType", "start_date", "end_date",
                    "date_view_type", "summary_field", "search_value", "searchValue",
                    "sids", "sid", "storeIdList", "parentAsin", "fulfillment_channel_type",
                    "fulfillmentChannelType"
                ) if name in params}
                if "senior_search_list" in params:
                    context["multi_asin_scope"] = True
                source["queries"][query_key] = {
                    **summary, "tool_id": tool_id, "query_context": context,
                    "request_params": params,
                }
                if tool_id not in source["tools"]:
                    source["tools"].append(tool_id)
                return clean
            except CollectionError as exc:
                source["queries"][query_key] = {
                    "status": "interface_failed", "stage": "action", "tool_id": tool_id,
                    "error": str(exc), "request_params": params, **_failure_details(exc),
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
                "request_params": summaries[0].get("request_params", params) if summaries else params,
            }
            first_error = next((item.get("error") for item in summaries if item.get("error")), None)
            if first_error:
                source["queries"][key]["error"] = first_error
            first_failure = next((item for item in summaries if item.get("error_category")), None)
            if first_failure:
                source["queries"][key].update({
                    "stage": first_failure.get("stage", "action"),
                    "error_category": first_failure.get("error_category"),
                    "response_status": first_failure.get("response_status"),
                    "retryable": first_failure.get("retryable", False),
                })
            if not pages:
                return None
            return pages[0] if len(pages) == 1 else {"pages": pages}

        requested_listing = execute_paginated(
            "erp_listing", "listing_and_sku_mapping", _lingxing_params("erp_listing", request),
            "listing_requested_asin"
        )
        parents = _values(requested_listing, ("parent_asin", "parentAsin")) if requested_listing else set()
        parent_candidates = sorted(parents)
        parent_asin = parent_candidates[0] if len(parent_candidates) == 1 else (
            request["asin"] if not parent_candidates else None
        )
        # The webpage normally supplies a parent ASIN. If it supplies a child ASIN,
        # the first query discovers the parent and this second scoped query expands it.
        family_listing = (execute_paginated(
            "erp_listing", "listing_and_sku_mapping",
            _lingxing_params("erp_listing", request, {"parent_asin": parent_asin}),
            "listing_parent_family",
        ) if parent_asin else None)
        if not _business_records(family_listing):
            # Do not assert that the requested ASIN is a parent when expansion returned no rows.
            if not parents:
                parent_asin = None
        mapping_scope = {"parent_asin": parent_asin, "asins": [request["asin"]],
                         "sites": [request["site"]]}
        if request.get("store_id"):
            mapping_scope["store_ids"] = [request["store_id"]]
        mapping_rows, mapping_rejected = canonicalize_records(
            requested_listing, "listing_and_sku_mapping",
            mapping_scope,
        )
        # A parent expansion is allowed to add child ASINs even though they were not in
        # the initial request. Filter it by exact parent separately, then merge.
        family_scope = {"parent_asin": parent_asin, "sites": [request["site"]]}
        if request.get("store_id"):
            family_scope["store_ids"] = [request["store_id"]]
        family_rows, family_rejected = canonicalize_records(
            family_listing, "listing_and_sku_mapping",
            family_scope
        ) if family_listing is not None else ([], 0)
        fingerprints = {(row.get("asin"), row.get("sku"), row.get("msku"), row.get("fnsku"))
                        for row in mapping_rows}
        for row in family_rows:
            fingerprint = (row.get("asin"), row.get("sku"), row.get("msku"), row.get("fnsku"))
            if fingerprint not in fingerprints:
                mapping_rows.append(row)
                fingerprints.add(fingerprint)
        source["records"]["listing_and_sku_mapping"] = mapping_rows
        scope = build_scope_from_mapping(mapping_rows, request["asin"], parent_asin)
        scope["sites"] = [request["site"]]
        if request.get("store_id"):
            scope["store_ids"] = [request["store_id"]]
            scope["store_id"] = request["store_id"]
            scope["marketplace"] = request["site"]
        conflicts = mapping_conflicts(mapping_rows) + mapping_context_issues(mapping_rows)
        identifiers_complete = bool(mapping_rows) and all(
            row.get("asin") and any(row.get(key) for key in ("sku", "msku", "fnsku"))
            for row in mapping_rows
        )
        source["family_scope"] = {
            "parent_asin": parent_asin,
            "parent_candidates": parent_candidates,
            "child_asins": scope["asins"], "skus": scope["skus"],
            "mskus": scope["mskus"], "fnskus": scope["fnskus"],
            "mapping_status": "complete_candidate" if parent_asin and family_listing and
            source["queries"].get("listing_parent_family", {}).get("pagination_complete") is True and
            identifiers_complete and not conflicts else "needs_review",
            "mapping_conflicts": conflicts,
            "out_of_scope_records": mapping_rejected + family_rejected,
        }
        for tool_id, purpose in LINGXING_READ_ALLOWLIST.items():
            if tool_id == "erp_listing":
                continue
            if purpose == "historical_sales":
                # Keep the single broad request when it already contains
                # explicit periods (and preserve the existing mock contract).
                # The live Lingxing response currently returns an empty list or
                # rows without period, so only then fall back to four bounded
                # natural-month requests.
                broad_payload = execute_paginated(
                    tool_id, purpose, _lingxing_params(tool_id, request, scope), purpose
                )
                broad_periods = set()
                for item in _walk(broad_payload):
                    for key in FIELD_ALIASES["historical_sales"]["period"]:
                        if item.get(key):
                            broad_periods.add(str(item[key])[:7])
                if broad_payload is not None and broad_periods:
                    canonical, rejected = canonicalize_records(broad_payload, purpose, scope)
                    query = source["queries"][purpose]
                    query["raw_record_count"] = query.get("record_count", 0)
                    query["record_count"] = len(canonical)
                    query["out_of_scope_record_count"] = rejected
                    query["observed_fields"] = _observed_fields(broad_payload)
                    query["field_quality"] = canonical_field_quality(canonical, purpose)
                    query["coverage"] = _historical_coverage(canonical, request)
                    if query["coverage"]["status"] == "incomplete" and query["status"] == "ok":
                        query["status"] = "period_incomplete"
                    source["records"][purpose] = canonical
                    continue
                monthly_rows = []
                monthly_raw = 0
                monthly_rejected = 0
                month_statuses = []
                observed_fields = set()
                for month in _required_history_months(request):
                    month_payload = execute_paginated(
                        tool_id, purpose, _history_month_params(request, scope, month),
                        f"historical_sales_{month}",
                    )
                    month_query = source["queries"].get(f"historical_sales_{month}", {})
                    month_statuses.append(month_query.get("status", "interface_failed"))
                    if month_payload is None:
                        continue
                    monthly_raw += month_query.get("record_count", 0)
                    observed_fields.update(_observed_fields(month_payload))
                    expanded = _expand_history_rows(
                        month_payload, month, mapping_rows, request
                    )
                    canonical, rejected = canonicalize_records(
                        {"rows": expanded}, purpose, scope
                    )
                    monthly_rejected += rejected
                    monthly_rows.extend(canonical)
                query = source["queries"][purpose] = {
                    "status": "interface_failed" if "interface_failed" in month_statuses else
                    "empty_response" if not monthly_rows else "ok",
                    "tool_id": tool_id, "raw_record_count": monthly_raw,
                    "record_count": len(monthly_rows),
                    "out_of_scope_record_count": monthly_rejected,
                    "pagination_complete": all(
                        source["queries"].get(f"historical_sales_{month}", {}).get(
                            "pagination_complete", False
                        ) for month in _required_history_months(request)
                    ),
                    "page_count": sum(source["queries"].get(
                        f"historical_sales_{month}", {}).get("page_count", 0
                    ) for month in _required_history_months(request)),
                    "query_context": {
                        "months": _required_history_months(request),
                        "store_id": request.get("store_id"),
                        "search_field": "parent_asin" if request.get("parent_asin") else "asin",
                        "summary_field": "sku",
                    },
                    "observed_fields": sorted(observed_fields),
                    "field_quality": canonical_field_quality(monthly_rows, purpose),
                    "coverage": _historical_coverage(monthly_rows, request),
                }
                if query["status"] == "ok" and query["coverage"]["status"] == "incomplete":
                    query["status"] = "period_incomplete"
                first_failure = next((source["queries"].get(f"historical_sales_{month}", {})
                                      for month in _required_history_months(request)
                                      if source["queries"].get(f"historical_sales_{month}", {}).get(
                                          "error_category")), None)
                if first_failure:
                    query.update({key: first_failure[key] for key in (
                        "error", "error_category", "response_status", "retryable", "stage"
                    ) if key in first_failure})
                source["records"][purpose] = monthly_rows
                continue
            payload = execute_paginated(tool_id, purpose, _lingxing_params(tool_id, request, scope), purpose)
            if payload is not None:
                canonical, rejected = canonicalize_records(payload, purpose, scope)
                query = source["queries"][purpose]
                query["raw_record_count"] = query.get("record_count", 0)
                query["record_count"] = len(canonical)
                query["out_of_scope_record_count"] = rejected
                query["observed_fields"] = _observed_fields(payload)
                query["field_quality"] = canonical_field_quality(canonical, purpose)
                required = REQUIRED_QUALITY_FIELDS.get(purpose, set())
                missing_required = any(query["field_quality"].get(field) == "field_missing"
                                       for field in required)
                if purpose == "inventory_snapshot":
                    inbound = ("fba_inbound_total", "fba_inbound_working", "fba_inbound_shipped",
                               "fba_inbound_receiving")
                    missing_required = missing_required or all(
                        query["field_quality"].get(field) == "field_missing" for field in inbound
                    )
                if not canonical:
                    query["status"] = "out_of_scope_response" if query["raw_record_count"] else "empty_response"
                elif missing_required:
                    query["status"] = "field_missing"
                source["records"][purpose] = canonical
                if purpose == "historical_sales":
                    coverage = _historical_coverage(canonical, request)
                    query["coverage"] = coverage
                    if coverage["status"] == "incomplete" and query["status"] == "ok":
                        query["status"] = "period_incomplete"

        recent_payload = execute_paginated(
            "query_product_performance_asin_lists", "recent_sales",
            _lingxing_recent_sales_params(request, scope), "recent_sales",
        )
        if recent_payload is not None:
            expanded_recent = _expand_history_rows(
                recent_payload, "", mapping_rows, request
            )
            canonical, rejected = canonicalize_records(
                {"rows": expanded_recent} if expanded_recent else recent_payload,
                "recent_sales", scope,
            )
            query = source["queries"]["recent_sales"]
            query["raw_record_count"] = query.get("record_count", 0)
            query["record_count"] = len(canonical)
            query["out_of_scope_record_count"] = rejected
            query["observed_fields"] = _observed_fields(recent_payload)
            query["field_quality"] = canonical_field_quality(canonical, "recent_sales")
            if not canonical:
                query["status"] = "out_of_scope_response" if query["raw_record_count"] else "empty_response"
            elif any(query["field_quality"].get(field) == "field_missing"
                     for field in REQUIRED_QUALITY_FIELDS["recent_sales"]):
                query["status"] = "field_missing"
            source["records"]["recent_sales"] = canonical

        query_states = [item.get("status") for key, item in source["queries"].items()
                        if not (key == "listing_requested_asin" and
                                source["queries"].get("listing_parent_family", {}).get("status") == "ok")]
        bad = {"interface_failed", "empty_response", "out_of_scope_response", "field_missing", "possibly_truncated",
               "period_incomplete"}
        mapping_needs_review = source["family_scope"].get("mapping_status") != "complete_candidate"
        source["status"] = "ok" if query_states and not any(state in bad for state in query_states) and not mapping_needs_review else (
            "partial" if source["records"] else "error"
        )
        failures = sum(state in bad for state in query_states) + int(mapping_needs_review)
        if failures:
            source["error"] = f"{failures} 个领星查询或父子体映射存在失败、空响应、越界或字段缺失，已保留逐项状态"
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


def _lark_auth_identity(payload: Any) -> tuple[bool, str]:
    """Accept both current success envelopes and older flat auth-status JSON."""
    if not isinstance(payload, dict):
        return False, ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    identity = str(payload.get("identity") or data.get("identity") or "")
    verified = data.get("verified") is True
    if not verified:
        user = data.get("identities", {}).get("user", {}) if isinstance(data.get("identities"), dict) else {}
        verified = str(user.get("status") or "").casefold() in ("valid", "active", "authenticated") and \
            str(user.get("tokenStatus") or user.get("token_status") or "").casefold() not in ("expired", "invalid")
        if verified and not identity:
            identity = "user"
    return verified, identity


def _workbook_sheets(payload: Any) -> list[dict]:
    """Return bounded sheet descriptors, including hidden sheets when reported."""
    descriptors = []
    for item in _walk(payload):
        sheet_id = item.get("sheet_id") or item.get("sheetId") or item.get("id")
        title = item.get("title") or item.get("name")
        if sheet_id and title:
            descriptor = {
                "sheet_id": str(sheet_id), "title": str(title),
                "hidden": bool(item.get("hidden") or item.get("is_hidden") or item.get("isHidden")),
            }
            if descriptor not in descriptors:
                descriptors.append(descriptor)
    return descriptors[:30]


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


def _normalized_match_text(value: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", value.casefold())


def _table_match_basis(table: Any, request: dict) -> str | None:
    """Match table content without treating another product's values as target data."""
    asin = request["asin"].upper()
    product = _normalized_match_text(str(request.get("product") or ""))
    inspected = 0

    def scalar_texts(value: Any):
        nonlocal inspected
        if inspected >= 20_000:
            return
        if isinstance(value, dict):
            for child in value.values():
                yield from scalar_texts(child)
        elif isinstance(value, list):
            for child in value:
                yield from scalar_texts(child)
        elif isinstance(value, (str, int, float)):
            inspected += 1
            yield str(value)

    texts = list(scalar_texts(table))
    if any(asin in re.findall(r"\b[A-Z0-9]{10}\b", text.upper()) for text in texts):
        return "content_asin"
    if len(product) >= 4 and any(product in _normalized_match_text(text) for text in texts):
        return "content_product"
    return None


def _title_match_basis(title: str, request: dict) -> str | None:
    if request["asin"].casefold() in title.casefold():
        return "title_asin"
    normalized_title = _normalized_match_text(title)
    normalized_product = _normalized_match_text(str(request.get("product") or ""))
    # A short product name is still safe here because the fixed "销售计划"
    # boundary prevents a generic prefix (for example 加热垫) from matching
    # a different variant title (for example 加热垫2.0销售计划).
    if len(normalized_product) >= 2 and normalized_title.startswith(normalized_product + "销售计划"):
        return "title_product_exact"
    return None


def collect_lark(request: dict, lark_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "knowledge_base": "",
              "documents": [], "document_errors": [], "warnings": [], "error": ""}
    try:
        auth = _run_lark(lark_bin, ["auth", "status", "--json", "--verify"])
        verified, identity = _lark_auth_identity(auth)
        if not verified or identity != "user":
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
        selected = (target_candidates or sheet_candidates)[:MAX_LARK_SHEET_CANDIDATES]
        source["directory_summary"] = {
            "visited_node_count": len(visited),
            "candidate_sheet_count": len(sheet_candidates),
            "candidate_titles": [str(node.get("title") or "") for node in sheet_candidates],
        }
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
                sheet_descriptors = _workbook_sheets(workbook)
                reads = []
                read_mode = "header"
                targets = sheet_descriptors or [{"sheet_id": "", "title": "", "hidden": False}]
                for descriptor in targets:
                    table_args = ["sheets", "+table-get", "--spreadsheet-token", token]
                    if descriptor["sheet_id"]:
                        table_args.extend(["--sheet-id", descriptor["sheet_id"]])
                    table_args.extend(["--as", "user", "--max-chars", "500000", "--format", "json"])
                    try:
                        table_payload = _run_lark(lark_bin, table_args)
                        mode = "header"
                    except LarkCommandError as exc:
                        if exc.category != "duplicate_header":
                            raise
                        # Positional columns preserve duplicate headings without changing data.
                        table_payload = _run_lark(lark_bin, [*table_args, "--no-header"])
                        mode = "positional_no_header"
                        read_mode = mode
                        source["warnings"].append(
                            f"第 {index} 个匹配表格的工作表「{descriptor['title'] or '未命名'}」存在重复表头，"
                            "已按位置列只读；列名需要人工核对。"
                        )
                    reads.append({**descriptor, "read_mode": mode, "table": table_payload})
                table = {"sheets": reads}
            except CollectionError as exc:
                source["document_errors"].append({"candidate": index, "error": str(exc)})
                continue
            match_basis = (_title_match_basis(str(node.get("title", "")), request) or
                           _table_match_basis(table, request))
            match_type = "target" if match_basis else "reference"
            source["documents"].append({
                # Resource locators are used in-memory for the read then discarded. They are
                # not credentials, but omitting them also prevents accidental disclosure.
                "title": str(node.get("title") or ""), "match_type": match_type,
                "match_basis": match_basis or "structure_reference",
                "read_mode": read_mode,
                "sheet_count": len(table.get("sheets", [])),
                "workbook": _redact_sensitive(workbook),
                "table": (_redact_sensitive(table) if match_type == "target" else
                          {"omitted": True, "reason": "reference_values_not_for_target"}),
            })
        target_documents = [doc for doc in source["documents"] if doc.get("match_type") == "target"]
        source["target_match_found"] = bool(target_documents)
        source["target_match_count"] = len(target_documents)
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
        elif len(target_documents) > 1:
            source["status"] = "partial"
            source["error"] = "知识库中有多个表格匹配当前产品或 ASIN，需要人工确认目标表"
        elif not target_documents:
            source["status"] = "partial"
            source["error"] = "知识库可访问，但标题和表格内容均未找到当前产品或 ASIN；参考表未作为业务数据"
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


def build_sku_map(sources: dict, request: dict | None = None) -> list[dict]:
    aliases = IDENTITY_ALIASES
    family = sources.get("lingxing", {}).get("family_scope", {})
    allowed_asins = {str(value).upper() for value in family.get("child_asins", []) if value}
    if request and request.get("asin"):
        allowed_asins.add(str(request["asin"]).upper())
    found: list[dict] = []
    # Only the store-scoped Lingxing Listing response is authoritative for
    # ASIN/SKU identity. Feishu and inventory/history rows must never create or
    # repair a product mapping, otherwise a same-ASIN or stale reference row can
    # contaminate the current store scope.
    for source_name in ("lingxing",):
        source = sources.get(source_name, {})
        payload = source.get("records")
        if not isinstance(payload, dict):
            continue
        # Compatibility for older in-memory/unit-test snapshots that predate
        # the explicit listing_and_sku_mapping record bucket. Live collection
        # always creates that bucket, so this fallback cannot admit Feishu or
        # stale reference rows into a real snapshot.
        if "listing_and_sku_mapping" not in payload:
            legacy_rows = []
            for row in _walk(payload):
                if isinstance(row, dict) and any(row.get(key) not in (None, "")
                                                for key in ("asin", "ASIN")):
                    legacy_rows.append(row)
            listing_rows = legacy_rows
        else:
            listing_rows = payload.get("listing_and_sku_mapping", [])
        expected_store = str((request or {}).get("store_id") or "").strip().upper()
        expected_site = str((request or {}).get("site") or "").strip().upper()
        for row in listing_rows:
            if not isinstance(row, dict):
                continue
            row_store = str(row.get("store_id") or "").strip().upper()
            row_site = str(row.get("site") or "").strip().upper()
            if expected_store and row_store != expected_store:
                continue
            if expected_site and row_site not in {expected_site, "美国", "美国站"}:
                continue
            mapped = {}
            for canonical, keys in aliases.items():
                for key in keys:
                    if row.get(key) not in (None, ""):
                        mapped[canonical] = str(row[key])
                        break
            for canonical, keys in (("store_id", ("store_id",)), ("marketplace", ("site",))):
                for key in keys:
                    if row.get(key) not in (None, ""):
                        mapped[canonical] = str(row[key])
                        break
            if mapped.get("asin") and allowed_asins and mapped["asin"].upper() not in allowed_asins:
                continue
            if mapped.get("asin") and any(mapped.get(key) for key in ("sku", "msku", "fnsku")):
                identifiers = {mapped.get(name) for name in ("sku", "msku", "fnsku") if mapped.get(name)}
                entry = next((item for item in found if item.get("asin") == mapped["asin"] and
                              item.get("store_id") == mapped.get("store_id") and
                              item.get("marketplace") == mapped.get("marketplace") and
                              identifiers.intersection({item.get(name) for name in ("sku", "msku", "fnsku")})), None)
                if entry is None:
                    entry = {**mapped, "sources": [source_name], "mapping_status": "candidate"}
                    found.append(entry)
                else:
                    for name, value in mapped.items():
                        entry.setdefault(name, value)
    # Preserve the legacy contract for callers that provide no live Listing
    # bucket at all. This branch is intentionally unreachable for a normal
    # collect_trusted_data snapshot, whose Lingxing collector always creates
    # listing_and_sku_mapping before other sources are considered.
    if "listing_and_sku_mapping" not in sources.get("lingxing", {}).get("records", {}):
        for source_name, source in sources.items():
            if source_name == "lingxing":
                continue
            for row in _walk([doc for doc in source.get("documents", [])
                             if doc.get("match_type") == "target"]):
                mapped = {}
                for canonical, keys in aliases.items():
                    for key in keys:
                        if row.get(key) not in (None, ""):
                            mapped[canonical] = str(row[key])
                            break
                if mapped.get("asin") and allowed_asins and mapped["asin"].upper() not in allowed_asins:
                    continue
                if mapped.get("asin") and any(mapped.get(key) for key in ("sku", "msku", "fnsku")):
                    if not any(item.get("asin") == mapped["asin"] for item in found):
                        found.append({**mapped, "sources": [source_name], "mapping_status": "candidate"})
    return found[:500]


def _notify_stage(stage_callback, stage: str, status: str) -> None:
    if stage_callback is not None:
        stage_callback(stage, status)


def collect_trusted_data(request: dict, codex_bin: str | None, lark_bin: str | None,
                         simulated: dict | None = None, stage_callback=None) -> dict:
    """Collect all sources before Codex starts; never persists the returned snapshot."""
    if simulated is not None:
        return simulated
    _notify_stage(stage_callback, "lingxing_collection", "running")
    lingxing = collect_lingxing(request, codex_bin) if codex_bin else {
        "status": "error", "collected_at": utc_now(), "records": {}, "tools": [],
        "error": "未找到 Codex CLI，无法读取 yb-lingxing MCP 配置",
    }
    _notify_stage(stage_callback, "lingxing_collection", "completed")
    _notify_stage(stage_callback, "feishu_collection", "running")
    feishu = collect_lark(request, lark_bin) if lark_bin else {
        "status": "error", "collected_at": utc_now(), "knowledge_base": "",
        "documents": [], "error": "未找到 lark-cli",
    }
    _notify_stage(stage_callback, "feishu_collection", "completed")
    sources = {"lingxing": lingxing, "feishu": feishu}
    warnings = [f"{name}: {source['error']}" for name, source in sources.items() if source.get("error")]
    for name, source in sources.items():
        warnings.extend(f"{name}: {warning}" for warning in source.get("warnings", []))
    statuses = {source.get("status") for source in sources.values()}
    overall = "ok" if statuses == {"ok"} else "partial" if "ok" in statuses or "partial" in statuses else "blocked"
    _notify_stage(stage_callback, "product_mapping", "running")
    sku_map = build_sku_map(sources, request)
    _notify_stage(stage_callback, "product_mapping", "completed")
    snapshot = {
        "schema_version": "2.0", "collected_at": utc_now(), "overall_status": overall,
        "request_identity": {key: request.get(key, "") for key in
                             ("asin", "site", "store_id", "start_month", "end_month")},
        "sources": sources, "sku_map": sku_map, "warnings": warnings,
        "rules": {
            "inventory": "按SKU核对FBA可售、待调仓、入库中、实际在途、计划入库、AWD可用、AWD标发在途；批次不清不得相加；reported_zero仅表示接口明确返回0，field_missing/empty_response/out_of_scope_response/interface_failed绝不能当0",
            "allocation": "月度比例为输入、销量为输出；逐SKU不得超过已核对库存，不得跨SKU抵消",
            "profit": "成本缺失标待核算，不得把缺失成本或利润当作0",
        },
    }
    family_parent = str(lingxing.get("family_scope", {}).get("parent_asin") or "").upper()
    # User confirmation is deliberately scoped to this one live snapshot. It is
    # not a global AWD default and the raw interface value remains in records.
    if (str(request.get("store_id", "")) == "2104" and
            str(request.get("site", "")).upper() == "US" and
            family_parent == "B0HGCYZ7PQ"):
        snapshot["inventory_overrides"] = {
            "awd_standard_transit": {
                "value": 0,
                "source": "user_confirmed_current_snapshot",
                "confirmed_at": utc_now(),
                "reason": "用户确认当前猫屋快照没有 AWD 标发在途",
                "scope": {"store_id": "2104", "marketplace": "US", "parent_asin": "B0HGCYZ7PQ"},
            }
        }
    snapshot["planning_evidence"] = build_plan_evidence(
        snapshot, request, stage_callback=stage_callback
    )
    if snapshot["planning_evidence"]["status"] != "ready" and snapshot["overall_status"] == "ok":
        snapshot["overall_status"] = "partial"
    snapshot["warnings"].extend(
        warning for warning in snapshot["planning_evidence"]["problems"]
        if warning not in snapshot["warnings"]
    )
    return snapshot
