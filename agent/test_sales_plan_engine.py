# -*- coding: utf-8 -*-
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sales_plan_engine import build_history_evidence, build_inventory_evidence, build_plan_evidence


REQUEST = {
    "product": "围栏", "asin": "B012345678", "site": "US",
    "start_month": "2027-11", "end_month": "2028-02", "sell_through": 95,
}


def complete_snapshot(two_skus=False):
    mappings = [{
        "parent_asin": "B099999999", "asin": "B012345678", "sku": "SKU-1",
        "msku": "MSKU-1", "fnsku": "FN-1", "product_name": "真实围栏",
    }]
    if two_skus:
        mappings.append({
            "parent_asin": "B099999999", "asin": "B012345679", "sku": "SKU-2",
            "msku": "MSKU-2", "fnsku": "FN-2", "product_name": "真实围栏",
        })
    inventory, replenish, history = [], [], []
    for index, mapping in enumerate(mappings, start=1):
        identity = {key: mapping[key] for key in ("asin", "sku", "msku", "fnsku")}
        inventory.extend([
            {**identity, "fba_available": 40 * index, "fba_transfer_pending": 5,
             "awd_available": 15, "snapshot_date": "2027-10-31T00:00:00Z",
             "arrival_date": "2027-11-01"},
            {**identity, "fba_inbound_total": 10, "batch_id": f"INB-{index}",
             "snapshot_date": "2027-10-31T00:00:00Z", "arrival_date": "2027-11-01"},
            {**identity, "awd_standard_transit": 5, "batch_id": f"AWD-{index}",
             "snapshot_date": "2027-10-31T00:00:00Z", "arrival_date": "2027-11-01"},
        ])
        replenish.extend([
            {**identity, "actual_transit": 10, "batch_id": f"ACT-{index}",
             "status_date": "2027-10-31T00:00:00Z", "arrival_date": "2027-11-01"},
            {**identity, "planned_inbound": 5, "batch_id": f"PLAN-{index}",
             "status_date": "2027-10-31T00:00:00Z", "arrival_date": "2027-11-01"},
        ])
        for month, units in zip(("2026-11", "2026-12", "2027-01", "2027-02"), (40, 30, 20, 10)):
            history.append({**identity, "period": month, "sales_units": units})
    return {
        "collected_at": "2027-10-31T00:00:00Z", "overall_status": "ok", "sku_map": mappings,
        "sources": {"lingxing": {
            "status": "ok", "collected_at": "2027-10-31T00:00:00Z",
            "family_scope": {"mapping_status": "complete_candidate", "parent_asin": "B099999999"},
            "queries": {"historical_sales": {"coverage": {"status": "complete"}}},
            "records": {"listing_and_sku_mapping": mappings, "inventory_snapshot": inventory,
                        "replenishment_inventory": replenish, "historical_sales": history},
        }, "feishu": {"status": "missing", "documents": []}},
    }


class InventoryEvidenceTests(unittest.TestCase):
    def test_all_seven_components_produce_sku_total(self):
        evidence = build_inventory_evidence(complete_snapshot())
        self.assertEqual(evidence["status"], "ready")
        self.assertEqual(evidence["inventory_total"], 90)
        self.assertEqual(set(evidence["sku_details"][0]["components"]), {
            "fba_available", "fba_transfer_pending", "fba_inbound", "actual_transit",
            "planned_inbound", "awd_available", "awd_standard_transit",
        })

    def test_missing_is_not_zero(self):
        snapshot = complete_snapshot()
        del snapshot["sources"]["lingxing"]["records"]["inventory_snapshot"][0]["awd_available"]
        evidence = build_inventory_evidence(snapshot)
        self.assertEqual(evidence["status"], "needs_review")
        self.assertIsNone(evidence["inventory_total"])
        self.assertIsNone(evidence["sku_details"][0]["components"]["awd_available"])

    def test_explicit_zero_is_valid(self):
        snapshot = complete_snapshot()
        for row in snapshot["sources"]["lingxing"]["records"]["inventory_snapshot"]:
            for key in ("fba_available", "fba_transfer_pending", "fba_inbound_total",
                        "awd_available", "awd_standard_transit"):
                row[key] = 0
        for row in snapshot["sources"]["lingxing"]["records"]["replenishment_inventory"]:
            if "actual_transit" in row: row["actual_transit"] = 0
            if "planned_inbound" in row: row["planned_inbound"] = 0
        evidence = build_inventory_evidence(snapshot)
        self.assertEqual(evidence["status"], "ready")
        self.assertEqual(evidence["inventory_total"], 0)

    def test_unbatched_transit_overlap_blocks_total(self):
        snapshot = complete_snapshot()
        for row in snapshot["sources"]["lingxing"]["records"]["replenishment_inventory"]:
            row["batch_id"] = ""
        evidence = build_inventory_evidence(snapshot)
        self.assertEqual(evidence["status"], "needs_review")
        self.assertTrue(any("无法排除重复" in problem for problem in evidence["problems"]))

    def test_same_batch_is_counted_once(self):
        snapshot = complete_snapshot()
        rows = snapshot["sources"]["lingxing"]["records"]["replenishment_inventory"]
        rows[0]["batch_id"] = rows[1]["batch_id"] = "SAME-BATCH"
        evidence = build_inventory_evidence(snapshot)
        self.assertEqual(evidence["status"], "ready")
        self.assertEqual(evidence["inventory_total"], 85)
        self.assertEqual(evidence["sku_details"][0]["components"]["planned_inbound"], 0)


class HistoryAndPlanTests(unittest.TestCase):
    def test_plan_engine_reports_calculation_stages(self):
        stages = []
        build_plan_evidence(
            complete_snapshot(), REQUEST, today=date(2027, 10, 1),
            stage_callback=lambda name, status: stages.append((name, status)),
        )
        self.assertEqual(stages, [
            ("inventory_calculation", "running"), ("inventory_calculation", "completed"),
            ("historical_sales", "running"), ("historical_sales", "completed"),
            ("plan_calculation", "running"), ("plan_calculation", "completed"),
        ])

    def test_complete_natural_month_history(self):
        evidence = build_history_evidence(complete_snapshot(), REQUEST)
        self.assertEqual(evidence["status"], "ready")
        self.assertEqual(evidence["grain"], "natural_month_sku")

    def test_missing_month_blocks_plan(self):
        snapshot = complete_snapshot()
        snapshot["sources"]["lingxing"]["records"]["historical_sales"].pop()
        history = build_history_evidence(snapshot, REQUEST)
        self.assertEqual(history["status"], "needs_review")
        plan = build_plan_evidence(snapshot, REQUEST, today=date(2027, 10, 1))
        self.assertEqual(plan["status"], "needs_review")
        self.assertTrue(all(row["target_units"] is None for row in plan["monthly_plan"]))

    def test_multi_sku_plan_respects_each_inventory(self):
        snapshot = complete_snapshot(two_skus=True)
        plan = build_plan_evidence(snapshot, REQUEST, today=date(2027, 10, 1))
        self.assertEqual(plan["status"], "ready")
        self.assertEqual([row["target_units"] for row in plan["sku_plan"]], [86, 124])
        for row in plan["sku_plan"]:
            self.assertLessEqual(row["target_units"], row["planning_inventory"])
            self.assertEqual(sum(month["target_units"] for month in row["monthly"]), row["target_units"])

    def test_started_month_requires_actual_cutoff(self):
        plan = build_plan_evidence(complete_snapshot(), REQUEST, today=date(2027, 11, 4))
        self.assertEqual(plan["status"], "needs_review")
        self.assertTrue(any("已开始月份" in problem for problem in plan["problems"]))

    def test_future_arrival_cannot_support_earlier_months(self):
        snapshot = complete_snapshot()
        for source in ("inventory_snapshot", "replenishment_inventory"):
            for row in snapshot["sources"]["lingxing"]["records"][source]:
                if row.get("arrival_date"):
                    row["arrival_date"] = "2028-03-01"
        plan = build_plan_evidence(snapshot, REQUEST, today=date(2027, 10, 1))
        self.assertEqual(plan["status"], "needs_review")
        self.assertTrue(any("到货时点限制" in problem for problem in plan["problems"]))

    def test_cross_store_history_is_not_mixed(self):
        snapshot = complete_snapshot()
        rows = snapshot["sources"]["lingxing"]["records"]["historical_sales"]
        rows[0]["store_id"] = "STORE-1"; rows[1]["store_id"] = "STORE-2"
        evidence = build_history_evidence(snapshot, REQUEST)
        self.assertEqual(evidence["status"], "needs_review")
        self.assertTrue(any("多个店铺" in problem for problem in evidence["problems"]))


if __name__ == "__main__":
    unittest.main()
