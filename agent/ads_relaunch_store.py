# -*- coding: utf-8 -*-
"""Local persistence for Amazon Ads Search Term Relaunch settings.

Only non-secret preferences and campaign registry metadata are stored here.
MCP credentials remain in the user's Codex configuration.
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(os.getenv("LOCALAPPDATA", tempfile.gettempdir())) / "AmazonOperationsWorkspace" / "context"
CONFIG_PATH = ROOT / "ads_relaunch_config.json"
MAX_CONFIG_BYTES = 250_000
ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
SENSITIVE_KEY_RE = re.compile(
    r"(token|cookie|secret|password|api[_-]?key|authorization|credential|mws|private[_-]?key)",
    re.I,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_ads_config() -> dict:
    return {
        "schema_version": "1.0",
        "updated_at": None,
        "global_settings": {
            "marketplace": "US",
            "report_days": 30,
            "duplicate_impression_days": 7,
            "match_types": ["exact", "phrase", "broad"],
            "campaign_structure": "exact_separate_phrase_broad_shared",
            "campaign_keyword_limit": None,
            "budgets": {},
            "bidding_strategy": "",
            "bid_coefficients": {"exact": 1.0, "phrase": 0.85, "broad": 0.70},
            "min_bid": None,
            "max_bid": None,
            "default_bid": None,
            "campaign_naming": {
                "code": "SP-KW",
                "prefix": "出单再投放",
                "date_format": "YYYYMMDD",
                "labels": {"exact": "精准", "phrase": "词组", "broad": "广泛",
                           "phrase_broad": "词组+广泛"},
            },
            "group_naming": {"exact": "精准", "phrase": "词组", "broad": "广泛"},
        },
        "global_negative_rules": {"negative_keywords": [], "negative_product_asins": []},
        "product_profiles": {},
        "campaign_registry": {},
        "execution_history": [],
    }


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return default_ads_config()
    return value if isinstance(value, dict) else default_ads_config()


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _sanitize(item) for key, item in value.items()
                if not SENSITIVE_KEY_RE.search(str(key))}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize(item) for item in value]
    return value


def _merge_defaults(value: dict) -> dict:
    result = default_ads_config()
    result.update(_sanitize(value))
    global_settings = default_ads_config()["global_settings"]
    if not isinstance(result.get("global_settings"), dict):
        result["global_settings"] = global_settings
    else:
        result["global_settings"] = {**global_settings, **result["global_settings"]}
        defaults = global_settings["bid_coefficients"]
        incoming = result["global_settings"].get("bid_coefficients")
        result["global_settings"]["bid_coefficients"] = (
            {**defaults, **incoming} if isinstance(incoming, dict) else copy.deepcopy(defaults)
        )
        for key in ("campaign_naming", "group_naming"):
            base = global_settings[key]
            incoming = result["global_settings"].get(key)
            result["global_settings"][key] = {**base, **incoming} if isinstance(incoming, dict) else copy.deepcopy(base)
    for key, fallback in (
        ("global_negative_rules", {"negative_keywords": [], "negative_product_asins": []}),
        ("product_profiles", {}),
        ("campaign_registry", {}),
        ("execution_history", []),
    ):
        if not isinstance(result.get(key), type(fallback)):
            result[key] = copy.deepcopy(fallback)
    return result


def load_ads_config() -> dict:
    return _merge_defaults(_read(CONFIG_PATH))


def _validate(config: object) -> dict:
    if not isinstance(config, dict):
        raise ValueError("广告配置必须是 JSON 对象")
    encoded = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_CONFIG_BYTES:
        raise ValueError("广告配置过大，请精简历史记录后再保存")
    clean = _sanitize(config)
    allowed = {
        "schema_version", "updated_at", "global_settings", "global_negative_rules",
        "product_profiles", "campaign_registry", "execution_history",
    }
    unknown = set(clean) - allowed
    if unknown:
        raise ValueError("广告配置包含不支持的顶层字段")
    if clean.get("schema_version", "1.0") != "1.0":
        raise ValueError("不支持的广告配置版本")
    for key, expected in (
        ("global_settings", dict), ("global_negative_rules", dict),
        ("product_profiles", dict), ("campaign_registry", dict), ("execution_history", list),
    ):
        if key in clean and not isinstance(clean[key], expected):
            raise ValueError(f"{key} 格式不正确")
    profiles = clean.get("product_profiles", {})
    for asin, profile in profiles.items():
        if not ASIN_RE.fullmatch(str(asin).upper()):
            raise ValueError("产品配置的键必须是 10 位 ASIN")
        if not isinstance(profile, dict):
            raise ValueError(f"ASIN {asin} 的产品配置格式不正确")
    history = clean.get("execution_history", [])
    if len(history) > 500:
        raise ValueError("执行记录最多保留 500 条")
    return clean


def _atomic_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".ads-relaunch-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def save_ads_config(payload: object) -> dict:
    """Save editable preferences while preserving Skill-managed campaign history.

    The browser UI may update global settings and product profiles. It must not
    accidentally erase campaign_registry or execution_history maintained by Codex.
    """
    incoming = _validate(payload)
    current = load_ads_config()
    merged = copy.deepcopy(current)
    for key in ("schema_version", "global_settings", "global_negative_rules", "product_profiles"):
        if key in incoming:
            merged[key] = incoming[key]
    # Explicit registry/history updates are accepted for import/restore workflows.
    for key in ("campaign_registry", "execution_history"):
        if key in incoming:
            merged[key] = incoming[key]
    merged["updated_at"] = utc_now()
    merged = _merge_defaults(merged)
    _atomic_write(CONFIG_PATH, merged)
    # Verify the persisted representation before returning success.
    verified = load_ads_config()
    if verified.get("updated_at") != merged.get("updated_at"):
        raise OSError("广告配置写入后校验失败")
    return verified
