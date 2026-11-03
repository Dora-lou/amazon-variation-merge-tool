# -*- coding: utf-8 -*-
"""Host-side, read-only data collection for sales-plan previews.

The collectors deliberately do not accept commands or tool IDs from the model or
browser.  Lingxing calls are validated against MCP help/search metadata before an
action is sent.  Lark commands are assembled from a small immutable allowlist.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
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
        "--spreadsheet-token", "--sheet-id", "--sheet-name", "--range", "--as", "--max-chars", "--format"
    }),
}
LARK_BOOLEAN_FLAGS = frozenset({"--json", "--verify", "--page-all"})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CollectionError(RuntimeError):
    """A controlled error that is safe to show without subprocess output."""


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


def _lingxing_params(tool_id: str, request: dict) -> dict:
    asin = request["asin"]
    if tool_id == "erp_listing":
        return {"offset": 0, "length": 200, "pvi_ids": "", "search_field": "asin",
                "search_value": [asin], "exact_search": "1"}
    if tool_id == "get_fba_stock_list":
        return {"offset": 0, "length": 1000, "search_field": "asin",
                "search_value": asin, "fulfillment_channel_type": "FBA",
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
            "search_field": "asin", "search_value": [asin], "turn_on_summary": 1,
            "query_order_profit": True,
        }
    if tool_id == "query_fba_valid_list":
        return {"offset": 0, "length": 200, "dataType": 1, "searchField": "asin",
                "searchValue": asin, "fulfillmentChannelType": "FBA", "analysisMode": 2}
    raise CollectionError("领星工具不在本地只读白名单")


def collect_lingxing(request: dict, codex_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "records": {}, "tools": [], "error": ""}
    try:
        client = StreamableHttpMcpClient.from_codex_config(codex_bin)
        client.initialize()
        for tool_id, purpose in LINGXING_READ_ALLOWLIST.items():
            help_data = _tool_data(client.call_tool("help", {"query": tool_id, "limit": 50, "offset": 0}))
            tools = help_data.get("tools", [])
            matched = [tool for tool in tools if isinstance(tool, dict) and tool.get("toolId") == tool_id]
            if len(matched) != 1 or matched[0].get("toolType") != "read":
                raise CollectionError(f"领星工具 {tool_id} 未通过 help 只读校验")
            search_data = _tool_data(client.call_tool("search", {"toolId": tool_id}))
            if search_data.get("toolId") != tool_id or search_data.get("toolType") != "read":
                raise CollectionError(f"领星工具 {tool_id} 未通过 search 只读校验")
            params = _lingxing_params(tool_id, request)
            _schema_validate(search_data.get("inputSchema", {}), params)
            payload = client.call_tool("action", {"toolId": tool_id, "params": params})
            source["records"][purpose] = _redact_sensitive(payload)
            source["tools"].append(tool_id)
        source["status"] = "ok"
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
        proc = subprocess.run(
            [lark_bin, *args], capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=COLLECTION_TIMEOUT, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CollectionError("飞书 CLI 无法启动或读取超时") from None
    if proc.returncode != 0:
        raise CollectionError(f"飞书只读命令失败（退出码 {proc.returncode}）")
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


def _node_matches(node: dict, request: dict) -> bool:
    title = str(node.get("title") or node.get("name") or "").casefold()
    terms = [request["asin"].casefold(), request["product"].casefold(), "销售计划", "库存", "利润"]
    return any(term and term in title for term in terms)


def collect_lark(request: dict, lark_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "knowledge_base": "",
              "documents": [], "error": ""}
    try:
        auth = _run_lark(lark_bin, ["auth", "status", "--json", "--verify"])
        if not isinstance(auth, dict):
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
                if _node_matches(node, request):
                    candidates.append(node)
        # Read only spreadsheet nodes, most specific matches first, bounded to avoid bulk export.
        candidates.sort(key=lambda n: (request["asin"].casefold() not in str(n.get("title", "")).casefold(),
                                       "销售计划" not in str(n.get("title", ""))))
        for node in candidates[:5]:
            obj_type = str(node.get("obj_type") or node.get("objType") or "").lower()
            if obj_type not in ("sheet", "spreadsheet"):
                continue
            token = str(node.get("obj_token") or node.get("objToken") or "")
            if not token:
                continue
            workbook = _run_lark(lark_bin, ["sheets", "+workbook-info", "--spreadsheet-token", token,
                                                   "--as", "user", "--format", "json"])
            table = _run_lark(lark_bin, ["sheets", "+table-get", "--spreadsheet-token", token,
                                                "--as", "user", "--max-chars", "500000", "--format", "json"])
            source["documents"].append({
                # Resource locators are used in-memory for the read then discarded. They are
                # not credentials, but omitting them also prevents accidental disclosure.
                "title": str(node.get("title") or ""), "workbook": _redact_sensitive(workbook),
                "table": _redact_sensitive(table),
            })
        if not source["documents"]:
            source["status"] = "missing"
            source["error"] = "知识库可访问，但未找到匹配的销售计划电子表格"
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
        "asin": ("asin", "ASIN"), "parent_asin": ("parent_asin", "parentAsin"),
        "sku": ("sku", "local_sku", "localSku"), "msku": ("msku", "seller_sku", "sellerSku"),
        "fnsku": ("fnsku", "FNSKU"),
    }
    found: dict[tuple, dict] = {}
    for source_name, source in sources.items():
        for row in _walk(source.get("records", source.get("documents", []))):
            mapped = {}
            for canonical, keys in aliases.items():
                for key in keys:
                    if row.get(key) not in (None, ""):
                        mapped[canonical] = str(row[key])
                        break
            if mapped.get("asin") and any(mapped.get(key) for key in ("sku", "msku", "fnsku")):
                key = tuple(mapped.get(name, "") for name in ("asin", "sku", "msku", "fnsku"))
                entry = found.setdefault(key, {**mapped, "sources": []})
                if source_name not in entry["sources"]:
                    entry["sources"].append(source_name)
    return list(found.values())[:500]


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
    statuses = {source.get("status") for source in sources.values()}
    overall = "ok" if statuses == {"ok"} else "partial" if "ok" in statuses or "partial" in statuses else "blocked"
    return {
        "schema_version": "1.0", "collected_at": utc_now(), "overall_status": overall,
        "request_identity": {key: request[key] for key in ("asin", "site", "start_month", "end_month")},
        "sources": sources, "sku_map": build_sku_map(sources), "warnings": warnings,
        "rules": {
            "inventory": "按SKU核对FBA可售、待调仓、入库中、实际在途、计划入库、AWD可用、AWD标发在途；批次不清不得相加",
            "allocation": "月度比例为输入、销量为输出；逐SKU不得超过已核对库存，不得跨SKU抵消",
            "profit": "成本缺失标待核算，不得把缺失成本或利润当作0",
        },
    }
