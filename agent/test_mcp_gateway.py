# -*- coding: utf-8 -*-
import unittest
from unittest.mock import patch

import mcp_gateway


class FakeClient:
    def __init__(self, tools):
        self.tools = tools
        self.calls = []

    def initialize(self):
        return None

    def list_tools(self):
        return self.tools

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"called": name, "arguments": arguments}


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.clients = {}
        self.configs = {
            "yb-lingxing": {"enabled": True, "transport": {"type": "streamable_http", "url": "https://example.invalid/lx"}},
            "xydc": {"enabled": True, "transport": {"type": "streamable_http", "url": "https://example.invalid/xy"}},
            "broken": {"enabled": True, "transport": {"type": "streamable_http", "url": "https://example.invalid/broken"}},
        }
        self.tool_sets = {
            "yb-lingxing": [
                {"name": "read_report", "description": "Read a report", "inputSchema": {"type": "object", "properties": {"asin": {"type": "string"}}}},
                {"name": "delete_report", "description": "Delete a report", "inputSchema": {"type": "object", "properties": {}}},
            ],
            "xydc": [
                {"name": "keywords", "description": "Read keyword data", "inputSchema": {"type": "object", "additionalProperties": True}},
            ],
        }

    def build(self):
        def fake_build(config, timeout):
            name = next(name for name, cfg in self.configs.items() if cfg is config)
            if name == "broken":
                raise mcp_gateway.McpConnectionError("simulated connection failure")
            client = FakeClient(self.tool_sets[name])
            self.clients[name] = client
            return client

        return patch.multiple(
            mcp_gateway,
            _discovered_servers=lambda _: list(self.configs),
            _load_transport_config=lambda _, name: self.configs[name],
            _build_client=fake_build,
        )

    def test_registers_every_tool_with_server_namespace_and_schema(self):
        with self.build():
            registry = mcp_gateway.McpRegistry("codex")
            snapshot = registry.refresh()
        self.assertEqual(snapshot["server_count"], 3)
        self.assertEqual(snapshot["tool_count"], 3)
        catalog = registry.catalog(limit=100)
        names = {tool["qualified_name"] for tool in catalog["tools"]}
        self.assertIn("mcp__yb-lingxing__read_report", names)
        self.assertIn("mcp__xydc__keywords", names)
        schema = next(tool for tool in catalog["tools"] if tool["qualified_name"].endswith("read_report"))
        self.assertEqual(schema["inputSchema"]["properties"]["asin"]["type"], "string")
        broken = next(server for server in snapshot["servers"] if server["name"] == "broken")
        self.assertEqual(broken["status"], "error")
        self.assertEqual(len(snapshot["errors"]), 1)

    def test_function_tools_include_all_tools_and_exact_parameters(self):
        with self.build():
            registry = mcp_gateway.McpRegistry("codex")
            registry.refresh()
        functions = {item["function"]["name"]: item["function"] for item in registry.openai_tools()}
        self.assertEqual(len(functions), 3)
        self.assertEqual(functions["mcp__yb-lingxing__read_report"]["parameters"]["type"], "object")
        self.assertIn("asin", functions["mcp__yb-lingxing__read_report"]["parameters"]["properties"])

    def test_high_risk_tool_is_visible_but_requires_confirmation(self):
        with self.build():
            registry = mcp_gateway.McpRegistry("codex")
            registry.refresh()
        with self.assertRaises(mcp_gateway.McpConfirmationRequired):
            registry.invoke("mcp__yb-lingxing__delete_report", {})
        self.assertEqual(self.clients["yb-lingxing"].calls, [])
        result = registry.invoke("mcp__yb-lingxing__delete_report", {}, confirmed=True)
        self.assertEqual(result["tool"], "delete_report")
        self.assertEqual(len(self.clients["yb-lingxing"].calls), 1)

    def test_function_tool_dispatch_round_trip(self):
        with self.build():
            registry = mcp_gateway.McpRegistry("codex")
            registry.refresh()
        message = registry.dispatch_tool_call({
            "id": "call-1",
            "function": {"name": "mcp__xydc__keywords", "arguments": '{"asin":"B000000000"}'},
        })
        self.assertEqual(message["role"], "tool")
        self.assertEqual(message["tool_call_id"], "call-1")
        self.assertEqual(self.clients["xydc"].calls[0][1]["asin"], "B000000000")

    def test_refresh_failure_keeps_previous_live_snapshot(self):
        with self.build():
            registry = mcp_gateway.McpRegistry("codex")
            registry.refresh(["xydc"])
            with patch.object(mcp_gateway, "_load_transport_config", side_effect=mcp_gateway.McpConnectionError("down")):
                snapshot = registry.refresh(["xydc"])
        self.assertEqual(snapshot["servers"][0]["status"], "stale")
        self.assertEqual(snapshot["tool_count"], 1)
        self.assertEqual(registry.catalog(limit=10)["tools"][0]["qualified_name"], "mcp__xydc__keywords")


if __name__ == "__main__":
    unittest.main()

