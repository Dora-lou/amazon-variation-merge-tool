# -*- coding: utf-8 -*-
"""Unified dynamic MCP discovery, registration, and invocation layer.

This module is intentionally independent from the Amazon business collectors.
The collectors may choose a small set of tools for a particular read-only
workflow, but this registry never applies a tool allowlist: every tool returned
by an enabled MCP server's ``tools/list`` is registered and exposed to the
agent/model with its complete input schema.

The implementation uses only the Python standard library so the local Agent
does not need another runtime dependency. Credentials are read from the Codex
MCP configuration only to establish a connection and are never included in a
status response, tool catalog, exception, or log.
"""
from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Callable


DEFAULT_TIMEOUT = 90
CONFIG_TIMEOUT = 20
MAX_RPC_BYTES = 8_000_000
MAX_CATALOG_TOOLS = 100_000
MAX_SEARCH_RESULTS = 500
MAX_TOOL_RESULT_BYTES = 8_000_000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_json(value: Any) -> Any:
    """Return a JSON-safe copy without exposing credential-like values."""
    if isinstance(value, dict):
        return {
            str(key): _safe_json(child)
            for key, child in value.items()
            if not any(part in str(key).casefold()
                       for part in ("token", "cookie", "authorization", "secret", "api_key", "apikey"))
        }
    if isinstance(value, list):
        return [_safe_json(child) for child in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _copy_json(value: Any) -> Any:
    """Copy tool metadata without dropping legitimate schema property names.

    A tool schema may legitimately contain a parameter named ``token``.  It is
    metadata, not a credential value, so redacting that key would violate the
    full-schema registration contract.  Runtime results use ``_safe_json``;
    tool definitions use this exact JSON copy instead.
    """
    try:
        return json.loads(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        raise McpGatewayError("MCP 工具定义不是有效 JSON") from None


def _safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value)).strip("_")
    return value or "unnamed"


def qualified_tool_name(server_name: str, tool_name: str) -> str:
    """Build a stable, collision-resistant model-facing tool name."""
    return f"mcp__{_safe_name(server_name)}__{_safe_name(tool_name)}"


class McpGatewayError(RuntimeError):
    """Controlled gateway error safe to return to the browser/model."""


class McpConnectionError(McpGatewayError):
    pass


class McpToolNotFound(McpGatewayError):
    pass


class McpConfirmationRequired(McpGatewayError):
    """Raised before a potentially mutating tool is actually invoked."""

    def __init__(self, tool: dict):
        self.tool = tool
        super().__init__(
            f"工具 {tool['qualified_name']} 可能执行写入、修改或删除操作，需要执行前确认"
        )


class _JsonRpcError(McpGatewayError):
    def __init__(self, method: str):
        self.method = method
        super().__init__(f"MCP {method} 返回 JSON-RPC 错误")


def _parse_json(value: str | bytes) -> Any:
    if isinstance(value, bytes):
        if len(value) > MAX_RPC_BYTES:
            raise McpGatewayError("MCP 返回超过安全大小限制")
        value = value.decode("utf-8", errors="strict")
    if len(value.encode("utf-8")) > MAX_RPC_BYTES:
        raise McpGatewayError("MCP 返回超过安全大小限制")
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError, UnicodeError):
        raise McpGatewayError("MCP 返回不是有效 JSON") from None


def _rpc_result(response: Any, method: str) -> Any:
    if not isinstance(response, dict):
        raise McpGatewayError(f"MCP {method} 返回格式无效")
    if response.get("error") is not None:
        raise _JsonRpcError(method)
    return response.get("result")


def _extract_content(result: Any) -> Any:
    """Keep structuredContent when available and decode text content if needed."""
    if not isinstance(result, dict):
        return result
    if "structuredContent" in result:
        return result["structuredContent"]
    content = result.get("content")
    if not isinstance(content, list):
        return result
    texts = [item.get("text") for item in content
             if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)]
    if len(texts) == 1:
        try:
            return _parse_json(texts[0])
        except McpGatewayError:
            return texts[0]
    if texts:
        values = []
        for text in texts:
            try:
                values.append(_parse_json(text))
            except McpGatewayError:
                values.append(text)
        return values
    return result


class _RpcClient:
    def __init__(self, timeout: int = DEFAULT_TIMEOUT):
        self.timeout = timeout
        self.request_id = 0
        self._lock = threading.RLock()

    def initialize(self) -> None:
        self._request("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "amazon-operations-workbench", "version": "2.0"},
        })
        self._notify("notifications/initialized", {})

    def list_tools(self) -> list[dict]:
        result = self._request("tools/list", {}) or {}
        tools = result.get("tools", []) if isinstance(result, dict) else []
        if not isinstance(tools, list):
            raise McpGatewayError("MCP tools/list 返回的工具清单格式无效")
        return [tool for tool in tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)]

    def call_tool(self, name: str, arguments: dict) -> Any:
        result = self._request("tools/call", {"name": name, "arguments": arguments})
        if isinstance(result, dict) and result.get("isError"):
            raise McpGatewayError(f"MCP 工具 {name} 执行失败")
        return _extract_content(result)

    def _request(self, method: str, params: dict) -> Any:
        with self._lock:
            self.request_id += 1
            response = self._send({"jsonrpc": "2.0", "id": self.request_id,
                                   "method": method, "params": params})
        return _rpc_result(response, method)

    def _notify(self, method: str, params: dict) -> None:
        with self._lock:
            self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, payload: dict) -> Any:
        raise NotImplementedError


class _HttpClient(_RpcClient):
    def __init__(self, url: str, headers: dict[str, str], timeout: int = DEFAULT_TIMEOUT):
        super().__init__(timeout)
        if not url.lower().startswith(("https://", "http://")):
            raise McpConnectionError("MCP HTTP 地址格式不受支持")
        self.url = url
        self.headers = dict(headers)
        self.session_id: str | None = None

    def _send(self, payload: dict) -> Any:
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream", **self.headers}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(
            self.url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session_id = session
                body = response.read(MAX_RPC_BYTES + 1)
                if len(body) > MAX_RPC_BYTES:
                    raise McpGatewayError("MCP 返回超过安全大小限制")
                content_type = response.headers.get("Content-Type", "")
                if "text/event-stream" in content_type:
                    events = []
                    for block in body.decode("utf-8").replace("\r\n", "\n").split("\n\n"):
                        data = "\n".join(line[5:].lstrip() for line in block.splitlines()
                                           if line.startswith("data:"))
                        if data:
                            events.append(_parse_json(data))
                    if not events:
                        raise McpGatewayError("MCP SSE 响应为空")
                    return events[-1]
                return _parse_json(body) if body.strip() else {"jsonrpc": "2.0", "result": {}}
        except urllib.error.HTTPError as exc:
            # Do not read or expose the response body: upstream errors can contain credentials.
            raise McpConnectionError(f"MCP HTTP 请求失败（HTTP {exc.code}）") from None
        except (urllib.error.URLError, TimeoutError, OSError, UnicodeError):
            raise McpConnectionError("MCP HTTP 连接失败或超时") from None


class _StdioClient(_RpcClient):
    def __init__(self, command: str, args: list[str], env: dict[str, str] | None,
                 cwd: str | None, timeout: int = DEFAULT_TIMEOUT):
        super().__init__(timeout)
        process_env = os.environ.copy()
        process_env.update({str(key): str(value) for key, value in (env or {}).items()})
        try:
            self.process = subprocess.Popen(
                [command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, cwd=cwd or None, env=process_env,
                bufsize=0,
            )
        except OSError:
            raise McpConnectionError("MCP stdio 服务无法启动") from None
        self._reader_lock = threading.Lock()

    def _send(self, payload: dict) -> Any:
        if self.process.poll() is not None or not self.process.stdin or not self.process.stdout:
            raise McpConnectionError("MCP stdio 服务已退出")
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # MCP stdio uses one JSON-RPC object per line. (The HTTP transport
        # separately handles SSE/JSON framing.)
        message = body + b"\n"
        try:
            self.process.stdin.write(message)
            self.process.stdin.flush()
            if "id" not in payload:
                return {}
            with self._reader_lock:
                result: queue.Queue = queue.Queue(maxsize=1)

                def read_response() -> None:
                    try:
                        result.put((True, self._read_message()))
                    except Exception as exc:  # noqa: BLE001 - converted below
                        result.put((False, exc))

                reader = threading.Thread(target=read_response, daemon=True)
                reader.start()
                try:
                    ok, response = result.get(timeout=self.timeout)
                except queue.Empty:
                    raise McpConnectionError("MCP stdio 响应超时") from None
                if not ok:
                    raise response
                return response
        except (OSError, ValueError):
            raise McpConnectionError("MCP stdio 通信失败") from None

    def _read_message(self) -> Any:
        assert self.process.stdout is not None
        first_line = self.process.stdout.readline()
        if not first_line:
            raise McpConnectionError("MCP stdio 服务未返回响应")
        # Accept legacy Content-Length framing as well as the MCP newline
        # framing, so future configured stdio servers remain interoperable.
        if first_line.lower().startswith(b"content-length:"):
            headers = {"content-length": first_line.decode("ascii").split(":", 1)[1].strip()}
            while True:
                line = self.process.stdout.readline()
                if not line:
                    raise McpConnectionError("MCP stdio 响应不完整")
                if line in (b"\r\n", b"\n"):
                    break
                try:
                    key, value = line.decode("ascii").split(":", 1)
                    headers[key.casefold()] = value.strip()
                except (UnicodeError, ValueError):
                    raise McpConnectionError("MCP stdio 响应头格式无效") from None
            try:
                length = int(headers["content-length"])
            except (KeyError, ValueError):
                raise McpConnectionError("MCP stdio 响应缺少 Content-Length") from None
            if not 0 < length <= MAX_RPC_BYTES:
                raise McpConnectionError("MCP stdio 响应大小无效")
            body = self.process.stdout.read(length)
            if len(body) != length:
                raise McpConnectionError("MCP stdio 响应不完整")
            return _parse_json(body)
        return _parse_json(first_line.strip())

    def close(self) -> None:
        try:
            self.process.terminate()
        except OSError:
            pass


def _load_transport_config(codex_bin: str, server_name: str) -> dict:
    try:
        proc = subprocess.run(
            [codex_bin, "mcp", "get", server_name, "--json"], capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=CONFIG_TIMEOUT, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise McpConnectionError("无法读取 MCP 配置") from None
    if proc.returncode != 0 or len(proc.stdout) > 300_000:
        raise McpConnectionError("MCP 配置不可用")
    try:
        config = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        raise McpConnectionError("MCP 配置格式无法识别") from None
    if not isinstance(config, dict):
        raise McpConnectionError("MCP 配置格式无法识别")
    return config


def _build_client(config: dict, timeout: int) -> _RpcClient:
    transport = config.get("transport") if isinstance(config.get("transport"), dict) else {}
    transport_type = str(transport.get("type") or "")
    if transport_type in ("streamable_http", "sse", "http"):
        headers = {str(k): str(v) for k, v in (transport.get("http_headers") or {}).items()}
        for header, env_name in (transport.get("env_http_headers") or {}).items():
            if os.getenv(str(env_name)):
                headers[str(header)] = os.environ[str(env_name)]
        bearer_env = transport.get("bearer_token_env_var")
        if bearer_env and os.getenv(str(bearer_env)):
            headers["Authorization"] = "Bearer " + os.environ[str(bearer_env)]
        return _HttpClient(str(transport.get("url") or ""), headers, timeout)
    if transport_type == "stdio":
        command = str(transport.get("command") or "")
        if not command:
            raise McpConnectionError("MCP stdio 配置缺少启动命令")
        env = transport.get("env") or {}
        env_vars = transport.get("env_vars") or {}
        if isinstance(env_vars, dict):
            for key, env_name in env_vars.items():
                if os.getenv(str(env_name)):
                    env[str(key)] = os.environ[str(env_name)]
        elif isinstance(env_vars, list):
            for env_name in env_vars:
                if os.getenv(str(env_name)):
                    env[str(env_name)] = os.environ[str(env_name)]
        return _StdioClient(command, [str(arg) for arg in (transport.get("args") or [])],
                            env, str(transport.get("cwd") or "") or None, timeout)
    raise McpConnectionError("MCP 传输类型暂不支持")


def _discovered_servers(codex_bin: str) -> list[str]:
    try:
        proc = subprocess.run(
            [codex_bin, "mcp", "list", "--json"], capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=CONFIG_TIMEOUT, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise McpConnectionError("无法读取本机 MCP Server 列表") from None
    if proc.returncode != 0 or len(proc.stdout) > 500_000:
        raise McpConnectionError("本机 MCP Server 列表不可用")
    try:
        payload = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        raise McpConnectionError("本机 MCP Server 列表格式无法识别") from None
    entries = payload if isinstance(payload, list) else payload.get("servers", []) if isinstance(payload, dict) else []
    names = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        if entry.get("enabled") is False:
            names.append(entry["name"])
        else:
            names.append(entry["name"])
    return list(dict.fromkeys(names))


def _is_high_risk(tool: dict) -> bool:
    text = " ".join(str(tool.get(key) or "") for key in ("name", "description", "qualified_name")).casefold()
    annotations = tool.get("annotations") if isinstance(tool.get("annotations"), dict) else {}
    if annotations.get("readOnlyHint") is False or annotations.get("destructiveHint") is True:
        return True
    exact_mutation_names = {"action", "execute", "run", "write", "mutate", "create", "update", "delete", "remove"}
    name = str(tool.get("name") or "").casefold().strip()
    if name in exact_mutation_names:
        return True
    return bool(re.search(r"(?:write|update|create|delete|remove|modify|set|put|post|patch|cancel|send|publish|\u5199\u5165|\u4fee\u6539|\u5220\u9664|\u521b\u5efa|\u53d1\u9001|\u4e0a\u4f20)", text))


class McpRegistry:
    """Thread-safe dynamic catalog for all configured MCP Servers."""

    def __init__(self, codex_bin: str | None, timeout: int = DEFAULT_TIMEOUT,
                 call_logger: Callable[[dict], Any] | None = None):
        self.codex_bin = codex_bin
        self.timeout = timeout
        self._lock = threading.RLock()
        self._servers: dict[str, dict] = {}
        self._tools: dict[str, dict] = {}
        self.refreshing = False
        self.last_refresh: str | None = None
        self.discovery_error: str = ""
        self.call_logger = call_logger

    def refresh(self, server_names: list[str] | None = None) -> dict:
        with self._lock:
            self.refreshing = True
        try:
            if not self.codex_bin:
                raise McpConnectionError("未找到 Codex CLI，无法读取 MCP Server 配置")
            names = server_names or _discovered_servers(self.codex_bin)
            names = list(dict.fromkeys(str(name) for name in names if str(name).strip()))
            results = {}
            with self._lock:
                previous = dict(self._servers)
                for name in names:
                    old = previous.get(name, {})
                    self._servers[name] = {
                        "name": name, "status": "connecting",
                        "transport": old.get("transport", "unknown"),
                        "error": "", "tools": old.get("tools", []),
                        "client": old.get("client"),
                        "refreshed_at": utc_now(),
                        "last_successful_refresh": old.get("last_successful_refresh"),
                    }
                self._rebuild_tool_index()
            with ThreadPoolExecutor(max_workers=max(1, min(8, len(names) or 1))) as pool:
                futures = {pool.submit(self._connect_one, name): name for name in names}
                for future in as_completed(futures):
                    name = futures[future]
                    try:
                        results[name] = future.result()
                    except McpGatewayError as exc:
                        results[name] = self._error_state(name, str(exc), self._failure_status(exc))
                    except Exception as exc:
                        # Keep failures isolated while exposing only the stable
                        # exception class, never arbitrary subprocess text.
                        results[name] = self._error_state(name, f"MCP Server 连接失败（{type(exc).__name__}）", "error")
            with self._lock:
                old = self._servers
                merged = {}
                for name in names:
                    state = results.get(name) or self._error_state(name, "MCP Server 未返回状态")
                    # A transient refresh failure must not erase a previously live
                    # client/tool snapshot; mark it stale and keep it callable.
                    if state["status"] in ("error", "disconnected") and name in old and old[name].get("client"):
                        state["status"] = "stale"
                        state["error"] = state["error"] or "本次刷新失败，保留上一次工具快照"
                        state["client"] = old[name]["client"]
                        state["tools"] = old[name].get("tools", [])
                        state["last_successful_refresh"] = old[name].get("last_successful_refresh")
                    merged[name] = state
                self._servers = merged
                self._rebuild_tool_index()
                self.last_refresh = utc_now()
                self.discovery_error = ""
            return self.snapshot()
        except McpGatewayError as exc:
            with self._lock:
                self.discovery_error = str(exc)
            raise
        finally:
            with self._lock:
                self.refreshing = False

    def reconnect(self, server_name: str) -> dict:
        return self.refresh([server_name])

    @staticmethod
    def _failure_status(exc: Exception) -> str:
        message = str(exc)
        if "HTTP 401" in message or "HTTP 403" in message or "HTTP 422" in message:
            return "error"
        if isinstance(exc, McpConnectionError) and any(marker in message for marker in ("超时", "连接失败", "无法启动", "未返回")):
            return "disconnected"
        return "error"

    def _connect_one(self, server_name: str) -> dict:
        config = _load_transport_config(self.codex_bin, server_name)
        if config.get("enabled") is False:
            return {"name": server_name, "status": "disabled", "transport": "disabled",
                    "error": str(config.get("disabled_reason") or "Server 已禁用"),
                    "tools": [], "client": None, "refreshed_at": utc_now()}
        transport = config.get("transport") if isinstance(config.get("transport"), dict) else {}
        client = _build_client(config, self.timeout)
        try:
            client.initialize()
            discovered = client.list_tools()
        except Exception:
            close = getattr(client, "close", None)
            if close:
                close()
            raise
        tools = []
        for raw in discovered[:MAX_CATALOG_TOOLS]:
            original_name = str(raw["name"])
            tool = _copy_json(raw)
            tool["name"] = original_name
            tool["server"] = server_name
            tool["qualified_name"] = qualified_tool_name(server_name, original_name)
            tool["high_risk"] = _is_high_risk(tool)
            tool["risk_level"] = "high" if tool["high_risk"] else "normal"
            tools.append(tool)
        return {
            "name": server_name, "status": "connected", "transport": str(transport.get("type") or "unknown"),
            "error": "", "tools": tools, "client": client,
            "refreshed_at": utc_now(), "last_successful_refresh": utc_now(),
        }

    def _error_state(self, name: str, message: str, status: str = "error") -> dict:
        return {"name": name, "status": status, "transport": "unknown", "error": message,
                "tools": [], "client": None, "refreshed_at": utc_now()}

    def _rebuild_tool_index(self) -> None:
        self._tools = {}
        for server in self._servers.values():
            for tool in server.get("tools", []):
                candidate = tool["qualified_name"]
                if candidate in self._tools:
                    digest = hashlib.sha1(str(tool["server"]).encode("utf-8")).hexdigest()[:8]
                    candidate = f"{candidate}__{digest}"
                    counter = 2
                    while candidate in self._tools:
                        candidate = f"{tool['qualified_name']}__{digest}_{counter}"
                        counter += 1
                    tool["qualified_name"] = candidate
                self._tools[candidate] = tool

    def _public_server(self, state: dict) -> dict:
        return {
            "name": state.get("name"), "status": state.get("status"),
            "transport": state.get("transport"), "error": state.get("error"),
            "refreshed_at": state.get("refreshed_at"),
            "last_successful_refresh": state.get("last_successful_refresh"),
            "connected_at": state.get("last_successful_refresh"),
            "tool_count": len(state.get("tools", [])),
            "stale_snapshot": state.get("status") == "stale",
        }

    def snapshot(self) -> dict:
        with self._lock:
            tools = []
            for source in self._tools.values():
                tool = dict(source)
                server_state = self._servers.get(tool.get("server"), {})
                tool["server_status"] = server_state.get("status", "error")
                tool["available"] = server_state.get("status") in ("connected", "stale")
                tools.append(tool)
            return {
                "status": "refreshing" if self.refreshing else "ready",
                "last_refresh": self.last_refresh,
                "discovery_error": self.discovery_error,
                "server_count": len(self._servers),
                "tool_count": len(tools),
                "servers": [self._public_server(state) for state in self._servers.values()],
                "errors": [{"server": state["name"], "error": state.get("error", "")}
                           for state in self._servers.values() if state.get("error")],
            }

    def catalog(self, query: str = "", offset: int = 0, limit: int = MAX_SEARCH_RESULTS,
                server: str = "", risk: str = "", available: str | None = None) -> dict:
        query = str(query or "").casefold().strip()
        try:
            offset = max(0, int(offset))
            limit = max(1, min(MAX_SEARCH_RESULTS, int(limit)))
        except (TypeError, ValueError):
            raise McpGatewayError("工具检索分页参数无效") from None
        with self._lock:
            tools = []
            for source in self._tools.values():
                tool = dict(source)
                server_state = self._servers.get(tool.get("server"), {})
                tool["server_status"] = server_state.get("status", "error")
                tool["available"] = server_state.get("status") in ("connected", "stale")
                tools.append(tool)
            server_filter = str(server or "").casefold().strip()
            risk = str(risk or "").casefold().strip()
            if server_filter:
                tools = [tool for tool in tools if server_filter == str(tool.get("server", "")).casefold()]
            if risk in ("high", "normal"):
                tools = [tool for tool in tools if tool.get("risk_level") == risk]
            if available in ("true", "false"):
                expected = available == "true"
                tools = [tool for tool in tools if tool.get("available") is expected]
            if query:
                tools = [tool for tool in tools if query in json.dumps(tool, ensure_ascii=False).casefold()]
            total = len(tools)
            page = tools[offset:offset + limit]
            return {"tools": page, "total": total, "offset": offset, "limit": limit,
                    "has_more": offset + len(page) < total}

    def _tool(self, qualified_name: str) -> dict:
        with self._lock:
            tool = self._tools.get(qualified_name)
            if not tool:
                raise McpToolNotFound(f"未找到 MCP 工具 {qualified_name}")
            return tool

    def invoke(self, qualified_name: str, arguments: dict | None = None,
               confirmed: bool = False) -> dict:
        tool = self._tool(str(qualified_name))
        if not isinstance(arguments, dict):
            raise McpGatewayError("MCP 工具 arguments 必须是 JSON 对象")
        started = time.perf_counter()
        status = "error"
        result = None
        error = ""
        try:
            if tool.get("high_risk") and not confirmed:
                status = "confirmation_required"
                raise McpConfirmationRequired(tool)
            with self._lock:
                state = self._servers.get(tool["server"])
                client = state.get("client") if state else None
            if client is None:
                raise McpConnectionError(f"MCP Server {tool['server']} 当前不可用")
            result = client.call_tool(tool["name"], arguments)
            encoded = json.dumps(_safe_json(result), ensure_ascii=False)
            if len(encoded.encode("utf-8")) > MAX_TOOL_RESULT_BYTES:
                raise McpGatewayError("MCP 工具结果超过安全大小限制")
            status = "success"
            return {"server": tool["server"], "tool": tool["name"],
                    "qualified_name": tool["qualified_name"], "result": _safe_json(result)}
        except McpConfirmationRequired:
            error = "需要执行前确认"
            raise
        except Exception as exc:
            error = str(exc) if isinstance(exc, McpGatewayError) else type(exc).__name__
            raise
        finally:
            if self.call_logger:
                try:
                    self.call_logger({
                        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                        "server": tool["server"], "tool": tool["name"],
                        "qualified_name": tool["qualified_name"], "arguments": arguments,
                        "status": status, "duration_ms": round((time.perf_counter() - started) * 1000),
                        "result": result, "error": error, "confirmed": confirmed,
                    })
                except Exception:
                    pass

    def tool_requires_confirmation(self, qualified_name: str) -> bool:
        return bool(self._tool(str(qualified_name)).get("high_risk"))

    def openai_tools(self) -> list[dict]:
        """Return the complete OpenAI-compatible function tool declaration list."""
        with self._lock:
            return [{
                "type": "function",
                "function": {
                    "name": tool["qualified_name"],
                    "description": str(tool.get("description") or ""),
                    "parameters": tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else {},
                },
            } for tool in self._tools.values()]

    def dispatch_tool_call(self, tool_call: dict, confirmed: bool = False) -> dict:
        """Dispatch a function tool_call and return a tool message."""
        function = tool_call.get("function", {}) if isinstance(tool_call, dict) else {}
        name = function.get("name")
        raw_arguments = function.get("arguments", {})
        if isinstance(raw_arguments, str):
            try:
                raw_arguments = json.loads(raw_arguments)
            except json.JSONDecodeError:
                raise McpGatewayError("模型工具参数不是有效 JSON") from None
        result = self.invoke(name, raw_arguments, confirmed=confirmed)
        return {"role": "tool", "tool_call_id": tool_call.get("id", ""),
                "name": name, "content": json.dumps(result["result"], ensure_ascii=False)}


