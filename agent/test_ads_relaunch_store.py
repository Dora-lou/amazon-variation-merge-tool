# -*- coding: utf-8 -*-
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ads_relaunch_store as store


class AdsRelaunchStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ads_relaunch_config.json"
        self.patch = patch.object(store, "CONFIG_PATH", self.path)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_default_config_is_available_without_file(self):
        config = store.load_ads_config()
        self.assertEqual(config["schema_version"], "1.0")
        self.assertEqual(config["global_settings"]["duplicate_impression_days"], 7)
        self.assertEqual(config["campaign_registry"], {})

    def test_save_preferences_preserves_campaign_registry(self):
        original = store.default_ads_config()
        original["campaign_registry"] = {"scope": {"campaigns": [{"campaign_id": "123"}]}}
        store._atomic_write(self.path, original)
        updated = store.save_ads_config({
            "schema_version": "1.0",
            "global_settings": {"report_days": 45},
            "product_profiles": {"B012345678": {"product_short_name": "围栏"}},
        })
        self.assertEqual(updated["global_settings"]["report_days"], 45)
        self.assertIn("scope", updated["campaign_registry"])
        self.assertEqual(updated["product_profiles"]["B012345678"]["product_short_name"], "围栏")

    def test_sensitive_keys_are_not_persisted(self):
        config = store.save_ads_config({
            "schema_version": "1.0",
            "global_settings": {"api_key": "must-not-persist", "report_days": 30},
            "product_profiles": {},
        })
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn("must-not-persist", raw)
        self.assertNotIn("api_key", raw)
        self.assertEqual(config["global_settings"]["report_days"], 30)

    def test_invalid_product_profile_asin_is_rejected(self):
        with self.assertRaises(ValueError):
            store.save_ads_config({
                "schema_version": "1.0",
                "product_profiles": {"not-an-asin": {}},
            })

    def test_config_round_trips_as_utf8_json(self):
        store.save_ads_config({
            "schema_version": "1.0",
            "product_profiles": {"B012345678": {"product_short_name": "八角围栏"}},
        })
        parsed = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(parsed["product_profiles"]["B012345678"]["product_short_name"], "八角围栏")


if __name__ == "__main__":
    unittest.main()
