# -*- coding: utf-8 -*-
"""Small, local-only shared business context store.

The store intentionally contains business scope and decisions only.  MCP
credentials remain in the user's Codex configuration and are never accepted by
this module or returned to the browser.
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


STATUS_VALUES = frozenset({"confirmed", "temporary", "needs_review"})
SENSITIVE_KEY_RE = re.compile(r"(token|cookie|secret|password|api[_-]?key|authorization|header|credential|mws)", re.I)
ROOT = Path(os.getenv("LOCALAPPDATA", tempfile.gettempdir())) / "AmazonOperationsWorkspace" / "context"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = PROJECT_ROOT / "business_context" / "operations_rules.yaml"
SCHEMA_PATH = PROJECT_ROOT / "business_context" / "context_schema.json"
LOCAL_CONTEXT_PATH = ROOT / "local_context.json"
DECISIONS_PATH = ROOT / "decisions.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _safe(v) for k, v in value.items() if not SENSITIVE_KEY_RE.search(str(k))}
    if isinstance(value, list):
        return [_safe(item) for item in value]
    return value


def default_context() -> dict:
    return {
        "schema_version": "1.0",
        "default_store": None,
        "product_mappings": [],
        "decisions": [],
        "pending_verifications": [],
    }


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return copy.deepcopy(fallback)


def load_rules() -> dict:
    """Read the JSON-compatible YAML rules without requiring PyYAML."""
    value = _read_json(RULES_PATH, {"schema_version": "1.0", "rules": {}})
    return _safe(value) if isinstance(value, dict) else {"schema_version": "1.0", "rules": {}}


def load_context() -> dict:
    value = _read_json(LOCAL_CONTEXT_PATH, default_context())
    if not isinstance(value, dict):
        value = default_context()
    result = default_context()
    result.update(_safe(value))
    for key in ("product_mappings", "decisions", "pending_verifications"):
        if not isinstance(result.get(key), list):
            result[key] = []
    return result


def load_decisions(statuses: set[str] | None = None) -> list[dict]:
    result = []
    try:
        lines = DECISIONS_PATH.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeError):
        return result
    for line in lines:
        try:
            item = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(item, dict):
            continue
        status = item.get("status")
        if statuses and status not in statuses:
            continue
        result.append(_safe(item))
    return result


def _atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(_safe(value), handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def save_context(context: dict) -> dict:
    value = load_context()
    value.update(_safe(context))
    value["schema_version"] = "1.0"
    _atomic_write(LOCAL_CONTEXT_PATH, value)
    return value


def set_default_store(store_id: str, marketplace: str, store_name: str = "") -> dict:
    store_id = str(store_id).strip()
    marketplace = str(marketplace).strip().upper()
    if not store_id or not marketplace:
        raise ValueError("店铺 ID 和 Marketplace 不能为空")
    item = {
        "store_id": store_id,
        "marketplace": marketplace,
        "store_name": str(store_name).strip(),
        "status": "confirmed",
        "confirmed_by": "user",
        "confirmed_at": utc_now(),
    }
    context = load_context()
    context["default_store"] = item
    save_context(context)
    append_decision({
        "type": "default_store",
        "status": "confirmed",
        "scope": {"store_id": store_id, "marketplace": marketplace},
        "decision": "用户确认默认店铺",
        "confirmed_by": "user",
        "confirmed_at": item["confirmed_at"],
    })
    return item


def save_product_mappings(scope: dict, mappings: list[dict], mapping_status: str | None = None) -> list[dict]:
    """Persist only user-confirmed mappings for one store/Marketplace scope."""
    store_id = str(scope.get("store_id", "")).strip()
    marketplace = str(scope.get("marketplace", "")).strip().upper()
    if not store_id or not marketplace or scope.get("scope_status") != "confirmed":
        raise ValueError("商品映射必须绑定已确认店铺")
    if mapping_status is not None and mapping_status != "complete_candidate":
        raise ValueError("父子体范围或 SKU 映射尚未通过核验，不能保存为 confirmed")
    clean = []
    for row in mappings:
        if not isinstance(row, dict):
            continue
        item = _safe({
            "store_id": store_id,
            "marketplace": marketplace,
            "asin": str(row.get("asin") or "").strip().upper(),
            "parent_asin": str(row.get("parent_asin") or "").strip().upper(),
            "sku": str(row.get("sku") or "").strip(),
            "msku": str(row.get("msku") or "").strip(),
            "fnsku": str(row.get("fnsku") or "").strip(),
            "status": "confirmed",
            "confirmed_at": utc_now(),
        })
        if item["asin"] and any(item[key] for key in ("sku", "msku", "fnsku")):
            clean.append(item)
    if not clean:
        raise ValueError("sku_map 为空或缺少 ASIN 与 SKU/MSKU/FNSKU，不能保存为 confirmed")
    context = load_context()
    previous = [row for row in context["product_mappings"]
                if not (row.get("store_id") == store_id and
                        str(row.get("marketplace", "")).upper() == marketplace and
                        row.get("asin") in {item["asin"] for item in clean})]
    context["product_mappings"] = previous + clean
    save_context(context)
    append_decision({
        "type": "product_mapping",
        "status": "confirmed",
        "scope": {"store_id": store_id, "marketplace": marketplace},
        "mapping_count": len(clean),
        "decision": "用户确认当前店铺商品映射",
        "confirmed_by": "user",
        "confirmed_at": utc_now(),
    })
    return clean


def append_decision(decision: dict) -> dict:
    item = _safe(dict(decision))
    status = item.get("status", "confirmed")
    if status not in STATUS_VALUES:
        raise ValueError("无效的上下文状态")
    item.setdefault("decision_id", f"decision-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}")
    item.setdefault("created_at", utc_now())
    DECISIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DECISIONS_PATH.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    context = load_context()
    context["decisions"] = load_decisions()
    save_context(context)
    return item


def build_codex_context(scope: dict, trusted_data: dict) -> dict:
    """Build the only business-context envelope allowed into Codex prompts."""
    context = load_context()
    return {
        "schema_version": "1.0",
        "rules": load_rules(),
        "confirmed_context": {
            "default_store": context.get("default_store"),
            "product_mappings": [row for row in context.get("product_mappings", [])
                                  if row.get("status", "confirmed") == "confirmed"],
            "decisions": load_decisions({"confirmed"}),
        },
        "temporary_context": {
            "decisions": load_decisions({"temporary"}),
        },
        "pending_verifications": context.get("pending_verifications", []) + load_decisions({"needs_review"}),
        "task_scope": _safe(scope),
        "trusted_data": _safe(trusted_data),
    }
