# -*- coding: utf-8 -*-
"""Cross-product contract regression for the shared planning engine.

These cases intentionally vary parent/child/SKU counts and store scope.  They
are synthetic fixtures around the three production regression ASINs; no live
business values are embedded in application code.
"""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sales_data_mapping import mapping_conflicts
from sales_plan_engine import build_plan_evidence


def fixture(parent, children, store="2104", conflict=False):
    mappings = []
    snapshot_rows = []
    history_rows = []
    for index, asin in enumerate(children, 1):
        sku = f"SKU-{parent[-4:]}-{index}"
        msku = f"MSKU-{parent[-4:]}-{index}"
        fnsku = f"FNSKU-{parent[-4:]}-{index}"
        if conflict and index == len(children):
            msku = mappings[0]["msku"]
        row = {"parent_asin": parent, "asin": asin, "sku": sku, "msku": msku,
               "fnsku": fnsku, "store_id": store, "marketplace": "US"}
        mappings.append(row)
        snapshot_rows.append({**row, "batch_id": f"BASE-{index}", "fba_available": 20 + index,
            "fba_transfer_pending": 0, "fba_inbound_working": 0,
            "fba_inbound_shipped": 0, "fba_inbound_receiving": 0,
            "planned_inbound": 9, "awd_available": 4,
            "snapshot_date": "2026-10-31", "arrival_date": "2026-11-01"})
        snapshot_rows.extend([
            {**row, "batch_id": f"FBA-{index}", "actual_transit": 3,
             "snapshot_date": "2026-10-31", "arrival_date": "2026-11-01"},
            {**row, "batch_id": f"AWD-{index}", "awd_standard_transit": 2,
             "snapshot_date": "2026-10-31", "arrival_date": "2026-11-01"},
        ])
        for period, units in (("2025-12", 10 + index), ("2026-01", 8 + index),
                              ("2026-02", 6 + index)):
            history_rows.append({**row, "period": period, "sales_units": units})
    return {
        "collected_at": "2026-10-31T00:00:00+00:00",
        "sku_map": mappings,
        "sources": {"lingxing": {
            "family_scope": {"mapping_status": "complete_candidate", "parent_asin": parent},
            "records": {"listing_and_sku_mapping": mappings,
                        "inventory_snapshot": snapshot_rows,
                        "historical_sales": history_rows,
                        "recent_sales": []},
            "queries": {"historical_sales": {"coverage": {"status": "complete"}}},
        }},
    }


class CrossProductRegressionTests(unittest.TestCase):
    def test_shared_engine_handles_three_products_and_different_child_counts(self):
        cases = [
            ("B0HGCYZ7PQ", ["B0HGCYZ7PQ1", "B0HGCYZ7PQ2", "B0HGCYZ7PQ3"]),
            ("B0HGXFNMLD", ["B0HGXFNMLD1", "B0HGXFNMLD2"]),
            ("B09V52N6QP", ["B09V52N6QP1", "B09V52N6QP2", "B09V52N6QP3", "B09V52N6QP4"]),
        ]
        for parent, children in cases:
            evidence = build_plan_evidence(
                fixture(parent, children),
                {"asin": parent, "site": "US", "store_id": "2104",
                 "start_month": "2026-12", "end_month": "2027-02", "sell_through": 95},
                today=date(2026, 10, 31),
            )
            self.assertEqual(evidence["status"], "ready", parent)
            self.assertEqual(len(evidence["sku_plan"]), len(children))
            self.assertEqual(sum(row["target_units"] for row in evidence["monthly_plan"]),
                             sum(row["target_units"] for row in evidence["sku_plan"]))

    def test_real_foldable_bowl_style_sku_msku_conflict_stays_needs_review(self):
        data = fixture("B09V52N6QP", ["B09V52N6QP1", "B09V52N6QP2"], conflict=True)
        mappings = data["sku_map"]
        self.assertTrue(any("msku" in item.lower() for item in mapping_conflicts(mappings)))
        # The collector marks this mapping needs_review before the planner can
        # produce a formal target; this test guards the business boundary.
        data["sources"]["lingxing"]["family_scope"]["mapping_status"] = "needs_review"
        evidence = build_plan_evidence(data, {"asin": "B09V52N6QP", "site": "US",
            "store_id": "2104", "start_month": "2026-12", "end_month": "2027-02",
            "sell_through": 95}, today=date(2026, 10, 31))
        self.assertNotEqual(evidence["status"], "ready")
