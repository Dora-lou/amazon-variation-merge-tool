# -*- coding: utf-8 -*-
"""Deterministic, auditable sales-plan evidence derived from read-only data.

Codex may explain this evidence, but it may not create inventory or targets that
are absent here.  Unknown values remain unknown and therefore block a numeric
plan instead of becoming zero.
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any


INVENTORY_COMPONENTS = (
    "fba_available", "fba_transfer_pending", "fba_inbound",
    "actual_transit", "planned_inbound", "awd_available", "awd_standard_transit",
)
# The seven fields remain in the audit contract. Only these five fields are
# additive planning inventory under the confirmed rule. The afn_inbound_* states
# and stock_up_num remain lifecycle/reference fields because real_transit is the
# selected FBA-in-transit basis.
PLANNING_COMPONENTS = (
    "fba_available", "fba_transfer_pending", "actual_transit",
    "awd_available", "awd_standard_transit",
)
PLANNING_TRANSIT_COMPONENTS = {"actual_transit", "awd_standard_transit"}
COMPONENT_LABELS = {
    "fba_available": "FBA可售", "fba_transfer_pending": "FBA待调仓",
    "fba_inbound": "FBA入库中", "actual_transit": "FBA实际在途",
    "planned_inbound": "FBA计划入库", "awd_available": "AWD可用",
    "awd_standard_transit": "AWD标发在途",
}
COMPONENT_PRIORITY = {
    "fba_available": 70, "fba_transfer_pending": 60, "fba_inbound": 50,
    "actual_transit": 40, "awd_standard_transit": 35, "planned_inbound": 30,
    "awd_available": 20,
}


def _month_range(start: str, end: str) -> list[str]:
    sy, sm = map(int, start.split("-")); ey, em = map(int, end.split("-"))
    values = []
    cursor, finish = sy * 12 + sm - 1, ey * 12 + em - 1
    while cursor <= finish:
        values.append(f"{cursor // 12:04d}-{cursor % 12 + 1:02d}")
        cursor += 1
    return values


def _prior_year(month: str) -> str:
    year, number = map(int, month.split("-"))
    return f"{year - 1:04d}-{number:02d}"


def _number(value: Any) -> int | float | None:
    if type(value) not in (int, float) or value < 0:
        return None
    return value


def _identity(record: dict) -> str:
    for key in ("sku", "msku", "fnsku", "asin"):
        if record.get(key):
            return str(record[key]).upper()
    return ""


def _mapping_key(row: dict) -> tuple[str, str, str, str]:
    return tuple(str(row.get(key) or "").upper() for key in ("asin", "sku", "msku", "fnsku"))


def _matches_mapping(record: dict, mapping: dict) -> bool:
    comparable = []
    for key in ("asin", "sku", "msku", "fnsku"):
        if record.get(key) and mapping.get(key):
            comparable.append(str(record[key]).upper() == str(mapping[key]).upper())
    if not comparable or not all(comparable):
        return False
    for record_key, mapping_key in (("store_id", "store_id"), ("store", "store")):
        if mapping.get(mapping_key):
            if not record.get(record_key):
                return False
            if str(record[record_key]).upper() != str(mapping[mapping_key]).upper():
                return False
    expected_marketplace = mapping.get("marketplace") or mapping.get("site")
    observed_marketplace = record.get("marketplace") or record.get("site")
    if expected_marketplace:
        if not observed_marketplace or str(observed_marketplace).upper() != str(expected_marketplace).upper():
            return False
    return True


def _component_values(row: dict, source: str) -> list[tuple[str, int | float, str]]:
    values = []
    if source == "inventory_snapshot":
        direct = ("fba_available", "fba_transfer_pending", "actual_transit",
                  "planned_inbound", "awd_available", "awd_standard_transit")
        for field in direct:
            number = _number(row.get(field))
            if number is not None:
                values.append((field, number, field))
        inbound_total = _number(row.get("fba_inbound_total"))
        inbound_parts = [
            _number(row.get("fba_inbound_working")),
            _number(row.get("fba_inbound_shipped")),
            _number(row.get("fba_inbound_receiving")),
        ]
        if inbound_total is not None:
            values.append(("fba_inbound", inbound_total, "fba_inbound_total"))
        elif any(value is not None for value in inbound_parts):
            values.append(("fba_inbound", sum(value or 0 for value in inbound_parts),
                           "fba_inbound_working+shipped+receiving"))
    elif source == "replenishment_inventory":
        for field in ("actual_transit", "planned_inbound"):
            number = _number(row.get(field))
            if number is not None:
                values.append((field, number, field))
    return values


def _scoped_inventory_override(snapshot: dict, component: str) -> dict | None:
    """Return an explicitly recorded, scope-bound human confirmation only."""
    overrides = snapshot.get("inventory_overrides", {})
    if not isinstance(overrides, dict):
        return None
    override = overrides.get(component)
    if not isinstance(override, dict) or _number(override.get("value")) is None:
        return None
    scope = override.get("scope", {})
    identity = snapshot.get("request_identity", {})
    family = snapshot.get("sources", {}).get("lingxing", {}).get("family_scope", {})
    if not isinstance(scope, dict) or not isinstance(identity, dict):
        return None
    if str(scope.get("store_id", "")) != str(identity.get("store_id", "")):
        return None
    if str(scope.get("marketplace", "")).upper() != str(identity.get("site", "")).upper():
        return None
    if str(scope.get("parent_asin", "")).upper() != str(family.get("parent_asin", "")).upper():
        return None
    return override


def build_inventory_evidence(snapshot: dict) -> dict:
    sources = snapshot.get("sources", {})
    lingxing = sources.get("lingxing", {})
    mappings = list(snapshot.get("sku_map") or lingxing.get("records", {}).get("listing_and_sku_mapping", []))
    records = lingxing.get("records", {})
    collected_at = lingxing.get("collected_at") or snapshot.get("collected_at") or ""
    details, problems, audit_warnings, sku_totals = [], [], [], {}

    if lingxing.get("family_scope", {}).get("mapping_status") != "complete_candidate":
        problems.append("父子体与SKU映射未完整验证")
    if not mappings:
        problems.append("没有可用的目标SKU映射")

    for mapping in mappings:
        sku_key = _identity(mapping)
        if not sku_key:
            continue
        candidates = []
        for source_name in ("inventory_snapshot", "replenishment_inventory"):
            for row in records.get(source_name, []):
                if not _matches_mapping(row, mapping):
                    continue
                for component, quantity, source_field in _component_values(row, source_name):
                    item = {
                        "component": component, "label": COMPONENT_LABELS[component],
                        "quantity": quantity, "source": f"lingxing:{source_name}",
                        "source_field": source_field,
                        "warehouse": str(row.get("warehouse") or ""),
                        "store": str(row.get("store") or row.get("store_id") or ""),
                        "batch_id": str(row.get("batch_id") or row.get("shipment_id") or ""),
                        "as_of": str(row.get("snapshot_date") or row.get("status_date") or collected_at),
                        "available_from": str(row.get("arrival_date") or ""),
                        "sku_key": sku_key,
                    }
                    override = _scoped_inventory_override(snapshot, component)
                    if override is not None:
                        item["raw_quantity"] = quantity
                        item["quantity"] = override["value"]
                        item["override"] = {
                            "value": override["value"], "source": override.get("source", "user"),
                            "confirmed_at": override.get("confirmed_at", ""),
                            "reason": override.get("reason", ""), "scope": override.get("scope", {}),
                        }
                    candidates.append(item)

        # Identical aggregate rows can be returned by multiple pages.  Remove only
        # exact duplicates; never merge different quantities silently.
        exact_seen, unique = set(), []
        for item in candidates:
            fingerprint = tuple(item.get(key) for key in (
                "component", "quantity", "warehouse", "store", "batch_id", "as_of", "source"
            ))
            if fingerprint not in exact_seen:
                exact_seen.add(fingerprint); unique.append(item)
        observed_components = {item["component"] for item in unique}

        # A real batch identifier allows the same physical stock to be counted once
        # as it moves through plan/transit/inbound states.  Keep the furthest-progressed
        # state and retain the discarded states as audit evidence.
        by_batch: dict[str, list[dict]] = defaultdict(list)
        unbatched = []
        for item in unique:
            (by_batch[item["batch_id"]] if item["batch_id"] else unbatched).append(item)
        accepted = list(unbatched)
        for batch_id, batch_rows in by_batch.items():
            kept_original = max(batch_rows, key=lambda item: COMPONENT_PRIORITY[item["component"]])
            kept = dict(kept_original)
            kept["dedupe_basis"] = f"batch:{batch_id}"
            kept["deduped_components"] = sorted({row["component"] for row in batch_rows
                                                   if row is not kept_original})
            accepted.append(kept)

        component_rows = defaultdict(list)
        for item in accepted:
            component_rows[item["component"]].append(item)
        component_totals = {}
        for component in INVENTORY_COMPONENTS:
            rows = component_rows.get(component, [])
            if not rows and component in observed_components:
                # The component was explicitly returned but was the same physical
                # batch as a later state, so its incremental contribution is zero.
                component_totals[component] = 0
            elif not rows:
                component_totals[component] = None
                problems.append(f"{sku_key} 缺少{COMPONENT_LABELS[component]}字段")
            else:
                component_totals[component] = sum(row["quantity"] for row in rows)

        positive_unbatched_transit = {
            row["component"] for row in unbatched
            if row["component"] in PLANNING_TRANSIT_COMPONENTS and row["quantity"] > 0
        }
        dedupe_verified = len(positive_unbatched_transit) <= 1
        if not dedupe_verified:
            problems.append(
                f"{sku_key} 的在途/计划库存缺少批次标识，无法排除重复："
                + "、".join(COMPONENT_LABELS[name] for name in sorted(positive_unbatched_transit))
            )
        stores = {row["store"] for row in accepted if row.get("store")}
        if len(stores) > 1:
            problems.append(f"{sku_key} 库存包含多个店铺，不能跨店铺汇总")
        dated_components = PLANNING_TRANSIT_COMPONENTS | {"fba_transfer_pending"}
        for row in accepted:
            if row["component"] in dated_components and row["quantity"] > 0 and not row.get("available_from"):
                audit_warnings.append(f"{sku_key} 的{row['label']}缺少预计可售/到货日期")
        dates = {row["as_of"] for row in accepted if row.get("as_of")}
        date_aligned = len(dates) <= 1
        if not date_aligned:
            problems.append(f"{sku_key} 库存记录统计时间不一致")
        complete = all(component_totals[name] is not None for name in PLANNING_COMPONENTS)
        total = (round(sum(component_totals[name] for name in PLANNING_COMPONENTS))
                 if complete and dedupe_verified and date_aligned else None)
        sku_totals[sku_key] = total
        details.append({
            "asin": mapping.get("asin", ""), "sku": mapping.get("sku", ""),
            "msku": mapping.get("msku", ""), "fnsku": mapping.get("fnsku", ""),
            "sku_key": sku_key, "components": component_totals, "planning_components": list(PLANNING_COMPONENTS),
            "planning_inventory": total,
            "dedupe_verified": dedupe_verified, "date_aligned": date_aligned,
            "records": accepted,
        })

    ready = bool(details) and all(value is not None for value in sku_totals.values()) and not problems
    return {
        "status": "ready" if ready else "needs_review", "components": list(INVENTORY_COMPONENTS),
        "sku_details": details, "sku_totals": sku_totals,
        "inventory_total": sum(sku_totals.values()) if ready else None,
        "problems": list(dict.fromkeys(problems)),
        "audit_warnings": list(dict.fromkeys(audit_warnings)), "as_of": collected_at,
    }


def build_history_evidence(snapshot: dict, request: dict) -> dict:
    lingxing = snapshot.get("sources", {}).get("lingxing", {})
    rows = lingxing.get("records", {}).get("historical_sales", [])
    mappings = snapshot.get("sku_map", [])
    months = _month_range(request["start_month"], request["end_month"])
    required = [_prior_year(month) for month in months]
    values: dict[str, dict[str, int | float]] = defaultdict(dict)
    actual_values: dict[str, dict[str, int | float]] = defaultdict(dict)
    stores, problems = set(), []
    for mapping in mappings:
        key = _identity(mapping)
        if not key:
            continue
        for row in rows:
            if not _matches_mapping(row, mapping):
                continue
            period, units = str(row.get("period") or ""), _number(row.get("sales_units"))
            if period in required and units is not None:
                if period in values[key]:
                    problems.append(f"{key} 的 {period} 存在重复销量记录，需按店铺核对")
                else:
                    values[key][period] = units
            if row.get("store") or row.get("store_id"):
                stores.add(str(row.get("store") or row.get("store_id")))
    if len(stores) > 1:
        problems.append("历史销量包含多个店铺，当前请求没有唯一店铺范围")
    for mapping in mappings:
        key = _identity(mapping)
        missing = [month for month in required if month not in values.get(key, {})]
        if missing:
            problems.append(f"{key} 缺少完整自然月销量：{'、'.join(missing)}")
        elif sum(values[key].values()) <= 0:
            problems.append(f"{key} 去年同期销量全部为0，缺少可用季节性依据")
    coverage = lingxing.get("queries", {}).get("historical_sales", {}).get("coverage", {})
    if coverage.get("status") != "complete":
        problems.append("领星历史销量查询未覆盖全部去年同期自然月")
    # A started planning month needs a separate, current-period observation.  It
    # is deliberately not substituted for last year's seasonality basis and is
    # never inferred from a missing row.  The host collector may expose daily or
    # monthly recent rows; normalize only their period key here.
    recent_rows = lingxing.get("records", {}).get("recent_sales", [])
    for mapping in mappings:
        key = _identity(mapping)
        if not key:
            continue
        for row in recent_rows:
            if not _matches_mapping(row, mapping):
                continue
            period, units = str(row.get("period") or ""), _number(row.get("sales_units"))
            if period and units is not None:
                actual_values[key][period[:7]] = actual_values[key].get(period[:7], 0) + units
    ready = bool(mappings) and bool(values) and not problems
    return {
        "status": "ready" if ready else "needs_review", "required_months": required,
        "values_by_sku": dict(values), "stores": sorted(stores),
        "actual_values_by_sku": dict(actual_values),
        "actual_source": "lingxing:query_product_performance_asin_lists(recent)" if actual_values else "",
        "source": "lingxing:query_product_performance_asin_lists",
        "date_type": "purchase", "grain": "natural_month_sku", "problems": list(dict.fromkeys(problems)),
    }


def _largest_remainder(total: int, weights: list[float]) -> list[int]:
    raw = [total * weight for weight in weights]
    base = [int(value) for value in raw]
    remaining = total - sum(base)
    order = sorted(range(len(raw)), key=lambda index: (raw[index] - base[index], weights[index], -index),
                   reverse=True)
    for index in order[:remaining]:
        base[index] += 1
    return base


def _capacity_constrained(desired: list[int], capacities: list[int | float]) -> tuple[list[int], int]:
    """Push early overflow forward; never borrow future stock for an earlier month."""
    allocated, cumulative, carry = [], 0, 0
    for index, wanted in enumerate(desired):
        wanted += carry
        room = max(0, int(capacities[index]) - cumulative)
        accepted = min(wanted, room)
        allocated.append(accepted)
        cumulative += accepted
        carry = wanted - accepted
    return allocated, carry


def _notify_stage(stage_callback, stage: str, status: str) -> None:
    if stage_callback is not None:
        stage_callback(stage, status)


def build_plan_evidence(snapshot: dict, request: dict, today: date | None = None,
                        stage_callback=None) -> dict:
    today = today or datetime.now(timezone.utc).date()
    months = _month_range(request["start_month"], request["end_month"])
    _notify_stage(stage_callback, "inventory_calculation", "running")
    inventory = build_inventory_evidence(snapshot)
    _notify_stage(stage_callback, "inventory_calculation", "completed")
    _notify_stage(stage_callback, "historical_sales", "running")
    history = build_history_evidence(snapshot, request)
    _notify_stage(stage_callback, "historical_sales", "completed")
    _notify_stage(stage_callback, "plan_calculation", "running")
    problems = [*inventory["problems"], *history["problems"]]
    current_month = f"{today.year:04d}-{today.month:02d}"
    if months and months[0] <= current_month:
        current_actuals = history.get("actual_values_by_sku", {})
        missing_actual = [key for key in history.get("values_by_sku", {})
                          if current_month not in current_actuals.get(key, {})]
        if missing_actual:
            problems.append("规划期包含已开始月份，但当前月每个SKU尚无完整同口径已发生销量与数据截止日")
    sku_plan = []
    if not problems:
        mapping_by_key = {_identity(row): row for row in snapshot.get("sku_map", [])}
        inventory_by_key = {row["sku_key"]: row for row in inventory["sku_details"]}
        for sku_key, available in inventory["sku_totals"].items():
            target = round(available * request["sell_through"] / 100)
            history_values = history["values_by_sku"][sku_key]
            basis = [history_values[_prior_year(month)] for month in months]
            basis_total = sum(basis)
            weights = [value / basis_total for value in basis]
            desired = _largest_remainder(target, weights)
            ledger = inventory_by_key[sku_key]["records"]
            capacities = []
            for month in months:
                month_end = f"{month}-{calendar.monthrange(*map(int, month.split('-')))[1]:02d}"
                capacity = 0
                for row in ledger:
                    if row["component"] in ("fba_available", "awd_available"):
                        capacity += row["quantity"]
                    elif row.get("available_from") and str(row["available_from"])[:10] <= month_end:
                        capacity += row["quantity"]
                capacities.append(capacity)
            allocations, unallocated = _capacity_constrained(desired, capacities)
            if unallocated:
                problems.append(f"{sku_key} 有 {unallocated} 件目标因到货时点限制无法分配")
            mapping = mapping_by_key.get(sku_key, {})
            sku_plan.append({
                "sku_key": sku_key, "asin": mapping.get("asin", ""), "sku": mapping.get("sku", ""),
                "msku": mapping.get("msku", ""), "fnsku": mapping.get("fnsku", ""),
                "planning_inventory": available, "sell_through": request["sell_through"],
                "target_units": target, "available_by_month": dict(zip(months, capacities)),
                "monthly": [{"month": month, "target_units": units, "seasonality_basis": basis[index]}
                            for index, (month, units) in enumerate(zip(months, allocations))],
            })
    if problems:
        sku_plan = []
    monthly = []
    for month in months:
        value = (sum(next(row["target_units"] for row in item["monthly"] if row["month"] == month)
                     for item in sku_plan) if sku_plan else None)
        monthly.append({"month": month, "target_units": value})
    ready = bool(sku_plan) and not problems
    result = {
        "status": "ready" if ready else "needs_review", "generated_by": "deterministic_host_engine_v1",
        "inventory": inventory, "history": history, "monthly_plan": monthly,
        "sku_plan": sku_plan, "problems": list(dict.fromkeys(problems)),
        "sell_through": request["sell_through"],
    }
    _notify_stage(stage_callback, "plan_calculation", "completed")
    return result
