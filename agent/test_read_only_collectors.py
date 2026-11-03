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
                    "senior_search_list":{"type":"string"},
                    "fulfillment_channel_type":{"type":"string"},"is_hide_zero_stock":{"type":"string"}}},
                "query_product_performance_asin_lists": {"type":"object","properties":performance_props,
                    "required":["offset","length"]},
                "query_fba_valid_list": {"type":"object","properties":replenishment_props},
            }
            return {"data": {"toolId": tool_id, "toolType": "read", "inputSchema": schemas[tool_id]}}
        if name == "action":
            tool_id = arguments["toolId"]
            rows = {
                "erp_listing": [{"asin": REQUEST["asin"], "parent_asin": "B099999999",
                                 "sku": "SKU-1", "seller_sku": "MSKU-1", "fnsku": "FN-1"}],
                "get_fba_stock_list": [{"asin": REQUEST["asin"], "sku": "SKU-1",
                    "afn_fulfillable_quantity": 0, "pending_transfer_quantity": 0,
                    "inbound_quantity": 0, "real_transit_quantity": 0, "stock_up_num": 0,
                    "awd_available_quantity": 0, "awd_standard_transit_quantity": 0}],
                "query_fba_valid_list": [{"asin": REQUEST["asin"], "sku": "SKU-1",
                                          "stock_up_num": 0, "real_transit_quantity": 0}],
                "query_product_performance_asin_lists": [
                    {"asin": REQUEST["asin"], "sku": "SKU-1", "month": month, "volume": 0}
                    for month in ("2025-11", "2025-12", "2026-01", "2026-02")
                ],
            }[tool_id]
            return {"data": {"rows": rows}}
        raise AssertionError(name)


class LingxingTests(unittest.TestCase):
    def test_parent_listing_is_paginated_until_short_page(self):
        class PagingMcp(FakeMcp):
            def call_tool(self, name, arguments):
                if name == "action" and arguments["toolId"] == "erp_listing" and \
                        arguments["params"].get("search_field") == "parent_asin":
                    self.calls.append((name, arguments))
                    offset = arguments["params"]["offset"]
                    size = 200 if offset == 0 else 1
                    return {"data":{"rows":[{
                        "asin":f"B{offset+i:09d}","parent_asin":"B099999999",
                        "sku":f"SKU-{offset+i}","seller_sku":f"MSKU-{offset+i}"
                    } for i in range(size)]}}
                return super().call_tool(name, arguments)
        fake = PagingMcp()
        with patch.object(collectors.StreamableHttpMcpClient, "from_codex_config", return_value=fake):
            result = collectors.collect_lingxing(REQUEST, "codex")
        family = result["queries"]["listing_parent_family"]
        self.assertEqual(family["record_count"], 201)
        self.assertEqual(family["page_count"], 2)
        self.assertTrue(family["pagination_complete"])
        self.assertEqual(result["family_scope"]["mapping_status"], "complete_candidate")

    def test_query_quality_distinguishes_empty_missing_zero_and_failure(self):
        self.assertEqual(collectors._query_summary({"data":{"rows":[]}}, "inventory_snapshot")["status"],
                         "empty_response")
        missing = collectors._query_summary({"data":{"rows":[{"sku":"S1"}]}}, "inventory_snapshot")
        self.assertEqual(missing["status"], "field_missing")
        zero = collectors._query_summary(
            {"data":{"rows":[{"sku":"S1","afn_fulfillable_quantity":0}]}}, "inventory_snapshot")
        self.assertEqual(zero["status"], "field_missing")
        self.assertEqual(zero["field_quality"]["fba_available"], "reported_zero")
        self.assertEqual(collectors._query_summary({"success":False}, "inventory_snapshot")["status"],
                         "interface_failed")

    def test_historical_coverage_requires_prior_year_planning_months(self):
        coverage = collectors._historical_coverage(
            {"rows":[{"month":"2025-11"},{"month":"2025-12"}]}, REQUEST)
        self.assertEqual(coverage["status"], "incomplete")
        self.assertEqual(coverage["missing_prior_year_months"], ["2026-01", "2026-02"])

    def test_help_search_action_only_for_validated_read_tools(self):
        fake = FakeMcp()
        with patch.object(collectors.StreamableHttpMcpClient, "from_codex_config", return_value=fake):
            result = collectors.collect_lingxing(REQUEST, "codex")
        self.assertEqual(result["status"], "ok")
        names = [name for name, _ in fake.calls]
        self.assertEqual(names.count("help"), 4)
        self.assertEqual(names.count("search"), 4)
        self.assertEqual(names.count("action"), 5)
        self.assertEqual(result["family_scope"]["parent_asin"], "B099999999")
        self.assertEqual(result["queries"]["inventory_snapshot"]["field_quality"]["fba_available"],
                         "reported_zero")
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
        self.assertIn("未通过 help 只读校验", result["queries"]["get_fba_stock_list"]["error"])

    def test_schema_rejects_extra_params(self):
        with self.assertRaises(collectors.CollectionError):
            collectors._schema_validate(
                {"type":"object","additionalProperties":False,"properties":{"offset":{"type":"integer"}}},
                {"offset":0,"delete":True},
            )


class LarkTests(unittest.TestCase):
    def test_duplicate_header_error_is_safely_classified(self):
        failure = SimpleNamespace(returncode=2, stdout="", stderr=json.dumps({
            "ok":False,"error":{"type":"validation","subtype":"duplicate_header",
                                  "message":"duplicate header; hidden resource token must not leak"}
        }))
        with patch.object(collectors.subprocess, "run", return_value=failure):
            with self.assertRaises(collectors.LarkCommandError) as caught:
                collectors._run_lark("lark-cli", ["sheets", "+table-get", "--spreadsheet-token", "hidden"])
        self.assertEqual(caught.exception.category, "duplicate_header")
        self.assertNotIn("hidden", str(caught.exception))

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
