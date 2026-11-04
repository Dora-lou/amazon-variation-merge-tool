# -*- coding: utf-8 -*-
"""Canonical, read-only field mapping for sales-plan source records.

This module never calls Lingxing or Feishu.  It converts already collected rows
into a small documented contract while preserving missing/zero/failure states.
"""
from __future__ import annotations

import re
from typing import Any, Iterable


IDENTITY_ALIASES = {
    "parent_asin": ("parent_asin", "parentAsin", "parentASIN", "父ASIN"),
    "asin": ("asin", "ASIN", "child_asin", "childAsin", "子ASIN"),
    "sku": ("local_sku", "localSku", "sku", "SKU", "本地SKU"),
    "msku": ("seller_sku", "sellerSku", "msku", "MSKU"),
    "fnsku": ("fnsku", "FNSKU"),
}

# Aliases are accepted only when an actual response contains them.  Missing
# aliases stay missing; no default zero is ever synthesized.
FIELD_ALIASES = {
    "listing_and_sku_mapping": IDENTITY_ALIASES,
    "inventory_snapshot": {
        **IDENTITY_ALIASES,
        "fba_available": ("afn_fulfillable_quantity", "fba_available_quantity", "available_quantity"),
        "fba_transfer_pending": (
            "afn_reserved_fc_transfers", "reserved_fc_transfers", "pending_transfer_quantity",
            "transfer_quantity",
        ),
        "fba_inbound_total": ("inbound_quantity", "afn_inbound_quantity"),
        "fba_inbound_working": ("afn_inbound_working_quantity", "inbound_working_quantity"),
        "fba_inbound_shipped": ("afn_inbound_shipped_quantity", "inbound_shipped_quantity"),
        "fba_inbound_receiving": ("afn_inbound_receiving_quantity", "inbound_receiving_quantity"),
        "awd_available": (
            "awd_available_quantity", "awd_available", "awd_available_inventory", "awd_usable_quantity",
        ),
        "awd_standard_transit": (
            "awd_standard_transit_quantity", "awd_standard_transit", "awd_inbound_quantity",
            "awd_to_fba_quantity",
        ),
        "snapshot_date": ("snapshot_date", "snapshotDate", "update_time", "updated_at", "gmt_modified"),
    },
    "replenishment_inventory": {
        **IDENTITY_ALIASES,
        "actual_transit": ("real_transit_quantity", "actualTransitQuantity", "actual_transit_quantity"),
        "planned_inbound": ("stock_up_num", "stockUpNum", "planned_inbound_quantity"),
        "available": ("available_quantity", "availableQuantity", "afn_fulfillable_quantity"),
        "arrival_date": (
            "arrival_date", "arrivalDate", "expected_arrival_date", "expectedArrivalDate",
            "estimated_arrival_date",
        ),
    },
    "historical_sales": {
        **IDENTITY_ALIASES,
        "period": ("period", "month", "date", "date_time", "dateTime", "report_date", "reportDate"),
        "sales_units": ("volume", "sales_quantity", "salesQuantity", "totalSalesQuantity"),
        "sales_amount": ("sales_amount", "salesAmount", "totalSalesAmount"),
    },
}

REQUIRED_CANONICAL_FIELDS = {
    "listing_and_sku_mapping": {"parent_asin", "asin"},
    "inventory_snapshot": {"fba_available", "fba_transfer_pending", "awd_available",
                           "awd_standard_transit"},
    "replenishment_inventory": {"actual_transit", "planned_inbound"},
    "historical_sales": {"period", "sales_units"},
}


def walk_dicts(value: Any) -> Iterable[dict]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def _first_present(row: dict, aliases: tuple[str, ...]) -> tuple[Any, str | None]:
    for alias in aliases:
        if alias in row and row[alias] not in (None, ""):
            return row[alias], alias
    return None, None


def _normalize_scalar(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if re.fullmatch(r"-?\d+", stripped):
        try:
            return int(stripped)
        except ValueError:
            return value
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)", stripped):
        try:
            return float(stripped)
        except ValueError:
            return value
    return stripped


def _identity_matches_scope(record: dict, scope: dict | None) -> bool:
    if not scope:
        return True
    allowed = {
        "asin": {str(v).upper() for v in scope.get("asins", []) if v},
        "parent_asin": {str(scope["parent_asin"]).upper()} if scope.get("parent_asin") else set(),
        "sku": {str(v).upper() for v in scope.get("skus", []) if v},
        "msku": {str(v).upper() for v in scope.get("mskus", []) if v},
        "fnsku": {str(v).upper() for v in scope.get("fnskus", []) if v},
    }
    observed = {key: str(record[key]).upper() for key in allowed if record.get(key) not in (None, "")}
    if not observed:
        return False
    comparable = [(key, value) for key, value in observed.items() if allowed[key]]
    # One matching identifier must never override another explicit mismatch.  A
    # response row carrying a known SKU but a different ASIN is not target data.
    return bool(comparable) and all(value in allowed[key] for key, value in comparable)


def canonicalize_records(payload: Any, purpose: str, scope: dict | None = None) -> tuple[list[dict], int]:
    """Return unique in-scope rows plus count of identity-bearing rejected rows."""
    aliases = FIELD_ALIASES.get(purpose, {})
    records: list[dict] = []
    rejected = 0
    seen = set()
    for row in walk_dicts(payload):
        canonical: dict[str, Any] = {}
        source_fields = {}
        for field, field_aliases in aliases.items():
            value, source_field = _first_present(row, field_aliases)
            if source_field is not None:
                canonical[field] = _normalize_scalar(value)
                source_fields[field] = source_field
        if not any(canonical.get(key) not in (None, "") for key in IDENTITY_ALIASES):
            continue
        if not _identity_matches_scope(canonical, scope):
            rejected += 1
            continue
        if purpose == "historical_sales" and canonical.get("period"):
            match = re.search(r"20\d{2}-(?:0[1-9]|1[0-2])", str(canonical["period"]))
            canonical["period"] = match.group(0) if match else canonical["period"]
        canonical["source_fields"] = source_fields
        fingerprint = tuple(sorted((key, repr(value)) for key, value in canonical.items()
                                   if key != "source_fields"))
        if fingerprint not in seen:
            records.append(canonical)
            seen.add(fingerprint)
    return records, rejected


def canonical_field_quality(records: list[dict], purpose: str) -> dict[str, str]:
    quality = {}
    identity_fields = set(IDENTITY_ALIASES)
    for field in FIELD_ALIASES.get(purpose, {}):
        if (field in identity_fields and purpose != "listing_and_sku_mapping") or field in {
            "snapshot_date", "arrival_date"
        }:
            continue
        values = [record[field] for record in records if record.get(field) not in (None, "")]
        if not values:
            quality[field] = "field_missing"
        elif all(type(value) in (int, float) and value == 0 for value in values):
            quality[field] = "reported_zero"
        else:
            quality[field] = "value_present"
    return quality


def build_scope_from_mapping(records: list[dict], requested_asin: str, parent_asin: str | None) -> dict:
    scope = {
        "parent_asin": parent_asin,
        "asins": {requested_asin.upper()},
        "skus": set(), "mskus": set(), "fnskus": set(),
    }
    for record in records:
        if parent_asin and record.get("parent_asin") and str(record["parent_asin"]).upper() != parent_asin.upper():
            continue
        for key, plural in (("asin", "asins"), ("sku", "skus"), ("msku", "mskus"), ("fnsku", "fnskus")):
            if record.get(key):
                scope[plural].add(str(record[key]).upper())
    return {key: sorted(value) if isinstance(value, set) else value for key, value in scope.items()}


def mapping_conflicts(records: list[dict]) -> list[str]:
    conflicts = []
    for field in ("sku", "msku", "fnsku"):
        associations: dict[str, set[str]] = {}
        for record in records:
            if record.get(field) and record.get("asin"):
                associations.setdefault(str(record[field]).upper(), set()).add(str(record["asin"]).upper())
        for value, asins in associations.items():
            if len(asins) > 1:
                conflicts.append(f"{field} {value} 对应多个子 ASIN")
    return conflicts
