import json
import tempfile
import uuid
import unittest
from pathlib import Path
from unittest.mock import patch

import business_context
import server


class SharedContextTests(unittest.TestCase):
    def test_agent_instance_mutex_rejects_second_owner_and_releases(self):
        name = rf"Local\AmazonOperationsWorkspace.Test.{uuid.uuid4().hex}"
        first = server.AgentInstanceLock(name)
        second = server.AgentInstanceLock(name)
        third = server.AgentInstanceLock(name)
        try:
            first.acquire()
            with self.assertRaises(server.AgentAlreadyRunning):
                second.acquire()
            first.release()
            third.acquire()
        finally:
            first.release()
            second.release()
            third.release()

    def test_default_store_and_decision_survive_reload(self):
        with tempfile.TemporaryDirectory() as root:
            context_root = Path(root) / "context"
            with patch.object(business_context, "ROOT", context_root), \
                 patch.object(business_context, "LOCAL_CONTEXT_PATH", context_root / "local_context.json"), \
                 patch.object(business_context, "DECISIONS_PATH", context_root / "decisions.jsonl"):
                saved = business_context.set_default_store("2104", "US", "Store 2104")
                self.assertEqual(saved["status"], "confirmed")
                reloaded = business_context.load_context()
                self.assertEqual(reloaded["default_store"]["store_id"], "2104")
                self.assertEqual(business_context.load_decisions({"confirmed"})[0]["type"], "default_store")

    def test_same_asin_mappings_are_kept_separate_by_store(self):
        with tempfile.TemporaryDirectory() as root:
            context_root = Path(root) / "context"
            with patch.object(business_context, "ROOT", context_root), \
                 patch.object(business_context, "LOCAL_CONTEXT_PATH", context_root / "local_context.json"), \
                 patch.object(business_context, "DECISIONS_PATH", context_root / "decisions.jsonl"):
                for store, msku in (("2104", "MSKU-A"), ("2095", "MSKU-B")):
                    business_context.save_product_mappings(
                        {"store_id": store, "marketplace": "US", "scope_status": "confirmed"},
                        [{"asin": "B012345678", "msku": msku}],
                    )
                rows = business_context.load_context()["product_mappings"]
                self.assertEqual({row["store_id"] for row in rows}, {"2104", "2095"})
                self.assertEqual({row["msku"] for row in rows}, {"MSKU-A", "MSKU-B"})

    def test_sensitive_fields_are_not_persisted(self):
        with tempfile.TemporaryDirectory() as root:
            context_root = Path(root) / "context"
            with patch.object(business_context, "ROOT", context_root), \
                 patch.object(business_context, "LOCAL_CONTEXT_PATH", context_root / "local_context.json"), \
                 patch.object(business_context, "DECISIONS_PATH", context_root / "decisions.jsonl"):
                business_context.save_context({"decisions": [{"status": "confirmed", "api_key": "hidden"}]})
                content = (context_root / "local_context.json").read_text(encoding="utf-8")
                self.assertNotIn("hidden", content)
                self.assertNotIn("api_key", content)

    def test_unconfirmed_scope_is_rejected(self):
        with self.assertRaises(ValueError):
            server.valid_request({"asin": "B012345678", "site": "US", "scope_status": "needs_review",
                                  "store_id": "2104", "start_month": "2026-11", "end_month": "2026-12",
                                  "sell_through": 95})


if __name__ == "__main__":
    unittest.main()
