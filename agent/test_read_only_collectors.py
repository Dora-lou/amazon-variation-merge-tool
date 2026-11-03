# -*- coding: utf-8 -*-
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_only_collectors as collectors

REQUEST = {
    "product": "Test Product", "asin": "B012345678", "site": "US",
    "start_month": "2026-11", "end_month": "2027-02", "sell_through": 95,
    "knowledge_base": "至拓-运营", "notes": "",
}


class FakeMcp:
    def __init__(self, write_tool=None):
        self.write_tool = write_tool
        self.calls = []

    def initialize(self):
        self.calls.append(("initialize", {}))

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "help":
            tool_id = arguments["query"]
            return {"data": {"tools": [{"toolId": tool_id,
                    "toolType": "write" if tool_id == self.write_tool else "read"}]}}
        if name == "search":
            tool_id = arguments["toolId"]
            performance_props = {key:{} for key in collectors._lingxing_params(
                "query_product_performance_asin_lists", REQUEST)}
            replenishment_props = {key:{} for key in collectors._lingxing_params(
                "query_fba_valid_list", REQUEST)}
            schemas = {
                "erp_listing": {"type":"object","properties":{
                    "offset":{"type":"integer"},"length":{"type":"integer","maximum":200},
                    "pvi_ids":{"type":"string"},"search_field":{"type":"string"},
                    "search_value":{"type":"array","items":{"type":"string"}},
                    "exact_search":{"type":"string"}},"required":["offset","length","pvi_ids"]},
                "get_fba_stock_list": {"type":"object","additionalProperties":False,"properties":{
                    "offset":{"type":"integer"},"length":{"type":"integer","enum":[1000]},
                    "search_field":{"type":"string"},"search_value":{"type":"string"},
                    "fulfillment_channel_type":{"type":"string"},"is_hide_zero_stock":{"type":"string"}}},
                "query_product_performance_asin_lists": {"type":"object","properties":performance_props,
                    "required":["offset","length"]},
                "query_fba_valid_list": {"type":"object","properties":replenishment_props},
            }
            return {"data": {"toolId": tool_id, "toolType": "read", "inputSchema": schemas[tool_id]}}
        if name == "action":
            return {"data": {"rows": [{"asin": REQUEST["asin"], "sku": "SKU-1"}]}}
        raise AssertionError(name)


class LingxingTests(unittest.TestCase):
    def test_help_search_action_only_for_validated_read_tools(self):
        fake = FakeMcp()
        with patch.object(collectors.StreamableHttpMcpClient, "from_codex_config", return_value=fake):
            result = collectors.collect_lingxing(REQUEST, "codex")
        self.assertEqual(result["status"], "ok")
        names = [name for name, _ in fake.calls]
        self.assertEqual(names.count("help"), 4)
        self.assertEqual(names.count("search"), 4)
        self.assertEqual(names.count("action"), 4)
        for name, args in fake.calls:
            if name == "action":
                self.assertIn(args["toolId"], collectors.LINGXING_READ_ALLOWLIST)

    def test_write_metadata_stops_before_action(self):
        fake = FakeMcp(write_tool="get_fba_stock_list")
        with patch.object(collectors.StreamableHttpMcpClient, "from_codex_config", return_value=fake):
            result = collectors.collect_lingxing(REQUEST, "codex")
        self.assertEqual(result["status"], "partial")
        action_ids = [args["toolId"] for name, args in fake.calls if name == "action"]
        self.assertNotIn("get_fba_stock_list", action_ids)
        self.assertIn("未通过 help 只读校验", result["error"])

    def test_schema_rejects_extra_params(self):
        with self.assertRaises(collectors.CollectionError):
            collectors._schema_validate(
                {"type":"object","additionalProperties":False,"properties":{"offset":{"type":"integer"}}},
                {"offset":0,"delete":True},
            )


class LarkTests(unittest.TestCase):
    def test_write_command_is_not_in_allowlist(self):
        with self.assertRaises(collectors.CollectionError):
            collectors._run_lark("lark-cli", ["sheets", "+cells-set", "--url", "x"])

    def test_read_command_uses_argument_array_and_parses_json(self):
        def fake_run(cmd, **kwargs):
            self.assertEqual(cmd[:3], ["lark-cli", "auth", "status"])
            self.assertNotIn("shell", kwargs)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"authenticated": True}), stderr="")
        with patch.object(collectors.subprocess, "run", side_effect=fake_run):
            self.assertEqual(collectors._run_lark("lark-cli", ["auth", "status", "--json", "--verify"]),
                             {"authenticated": True})


class StructureTests(unittest.TestCase):
    def test_sensitive_keys_are_removed_before_analysis(self):
        clean = collectors._redact_sensitive({"rows":[{"sku":"S1","access_token":"nope"}],"cookie":"nope"})
        self.assertEqual(clean, {"rows":[{"sku":"S1"}]})

    def test_sku_map_keeps_source_provenance(self):
        sources = {"lingxing":{"records":{"listing":{"rows":[{
            "asin":"B012345678","sku":"SKU-1","seller_sku":"MSKU-1","fnsku":"FN-1"
        }]}}},"feishu":{"documents":[]}}
        mapping = collectors.build_sku_map(sources)
        self.assertEqual(mapping[0]["msku"], "MSKU-1")
        self.assertEqual(mapping[0]["sources"], ["lingxing"])

    def test_simulation_never_calls_real_collectors(self):
        simulated = {"schema_version":"1.0","overall_status":"ok","sources":{},"sku_map":[]}
        with patch.object(collectors, "collect_lingxing") as lx, patch.object(collectors, "collect_lark") as lark:
            self.assertIs(collectors.collect_trusted_data(REQUEST, "codex", "lark", simulated), simulated)
            lx.assert_not_called(); lark.assert_not_called()


if __name__ == "__main__":
    unittest.main()
