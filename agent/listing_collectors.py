# -*- coding: utf-8 -*-
"""Fixed read-only collectors for the Listing Writer workflow."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from read_only_collectors import (
    CollectionError, StreamableHttpMcpClient, _redact_sensitive, _schema_validate,
    _tool_data, utc_now,
)

LINGXING_LISTING_TOOLS = (
    "erp_listing", "ad_auth_shops", "ad_campaign_search_term_report",
)
XIYOU_LISTING_TOOLS = frozenset({
    "get_asin_info", "get_asin_variations", "get_asin_keywords",
    "get_keyword_asin_analysis",
})


def _records(value: Any) -> list[dict]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("list", "data", "rows", "records", "entities"):
        child = value.get(key)
        found = _records(child)
        if found:
            return found
    for child in value.values():
        found = _records(child)
        if found:
            return found
    return []


def _xiyou_data(payload: Any) -> dict:
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    if isinstance(payload, dict):
        return payload
    return {}


def _lingxing_metadata(client: StreamableHttpMcpClient) -> dict[str, dict]:
    schemas: dict[str, dict] = {}
    for tool_id in LINGXING_LISTING_TOOLS:
        help_data = _tool_data(client.call_tool("help", {"query": tool_id, "limit": 50, "offset": 0}))
        matches = [tool for tool in help_data.get("tools", [])
                   if isinstance(tool, dict) and tool.get("toolId") == tool_id]
        if len(matches) != 1 or matches[0].get("toolType") != "read":
            raise CollectionError(f"领星工具 {tool_id} 未通过 help 只读校验")
        search_data = _tool_data(client.call_tool("search", {"toolId": tool_id}))
        if search_data.get("toolId") != tool_id or search_data.get("toolType") != "read":
            raise CollectionError(f"领星工具 {tool_id} 未通过 search 只读校验")
        schemas[tool_id] = search_data.get("inputSchema", {})
    return schemas


def collect_listing_lingxing(request: dict, codex_bin: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "listing": [],
              "search_terms": [], "period": "", "tools": [], "error": ""}
    try:
        client = StreamableHttpMcpClient.from_codex_config(codex_bin)
        client.initialize()
        schemas = _lingxing_metadata(client)

        def action(tool_id: str, params: dict) -> Any:
            _schema_validate(schemas[tool_id], params)
            payload = client.call_tool("action", {"toolId": tool_id, "params": params})
            source["tools"].append(tool_id)
            return _redact_sensitive(payload)

        listing_payload = action("erp_listing", {
            "offset": 0, "length": 200, "pvi_ids": "", "search_field": "asin",
            "search_value": [request["asin"]], "exact_search": "1",
        })
        listing_rows = [row for row in _records(listing_payload)
                        if str(row.get("asin") or row.get("amz_product_id") or "").upper() == request["asin"]]
        source["listing"] = listing_rows[:20]
        active = next((row for row in listing_rows if str(row.get("status_text", "")) == "在售"),
                      listing_rows[0] if listing_rows else {})
        store_id = str(active.get("store_id") or "")

        shops = _records(action("ad_auth_shops", {}))
        profile = next((row for row in shops if str(row.get("sid") or row.get("store_id") or "") == store_id
                        and str(row.get("country", "")).upper() == request["site"]), None)
        if not profile:
            source["status"] = "partial" if listing_rows else "error"
            source["error"] = "领星 Listing 已读取，但未找到与店铺匹配的广告 Profile"
            return source
        end = datetime.now(timezone.utc).date() - timedelta(days=1)
        start = end - timedelta(days=89)
        source["period"] = f"{start.isoformat()} - {end.isoformat()}"
        terms_payload = action("ad_campaign_search_term_report", {
            "report_date": source["period"],
            "profile_ids": [int(profile["profile_id"])],
            "asin": request["asin"], "category": "HasDeal", "sort_field": "orders",
            "sort_type": "desc", "page": 1, "length": 200, "group_type": "query",
            "with_translation": 1,
        })
        terms = []
        for row in _records(terms_payload):
            query = str(row.get("query") or "").strip().lower()
            if not query or query == request["asin"].lower() or query.startswith("b0"):
                continue
            orders = row.get("orders")
            direct_orders = row.get("direct_orders")
            if str(orders or "0") in ("0", "0.0") and str(direct_orders or "0") in ("0", "0.0"):
                continue
            terms.append({key: row.get(key) for key in (
                "query", "localize_query", "orders", "direct_orders", "indirect_orders",
                "sales", "spends", "clicks", "impressions", "ctr", "cvr", "acos", "cpc",
            )})
        source["search_terms"] = terms[:200]
        source["status"] = "ok" if listing_rows and terms else "partial"
        if not listing_rows:
            source["error"] = "领星未返回该 ASIN 的 Listing"
        elif not terms:
            source["error"] = "领星未返回该 ASIN 在查询周期内的出单搜索词"
    except CollectionError as exc:
        source["error"] = str(exc)
        source["status"] = "partial" if source["listing"] else "error"
    return source


def collect_listing_xiyou(request: dict, codex_bin: str, user_task: str) -> dict:
    source = {"status": "error", "collected_at": utc_now(), "product": {},
              "variations": {}, "keywords": [], "competitors": [], "tools": [], "error": ""}
    try:
        client = StreamableHttpMcpClient.from_codex_config(
            codex_bin, server_name="xydc-mcp", source_label="西柚"
        )
        client.initialize()

        def call(name: str, args: dict) -> dict:
            if name not in XIYOU_LISTING_TOOLS:
                raise CollectionError("西柚工具不在 Listing 只读白名单")
            payload = _redact_sensitive(client.call_tool(name, {
                **args, "user_task": user_task,
                "intent_summary": f"为 Listing Writer 测试读取{name}所需的真实数据",
            }))
            source["tools"].append(name)
            return _xiyou_data(payload)

        info = call("get_asin_info", {"country": request["site"], "asins": [request["asin"]]})
        entities = info.get("entities", []) if isinstance(info, dict) else []
        source["product"] = entities[0] if entities and isinstance(entities[0], dict) else {}
        source["variations"] = call("get_asin_variations", {
            "country": request["site"], "asin": request["asin"],
        })
        keyword_data = call("get_asin_keywords", {
            "country": request["site"], "asin": request["asin"], "page": 1,
            "page_size": 200, "sort_field": "traffic", "sort_order": "desc",
        })
        source["keywords"] = keyword_data.get("list", [])[:200]
        core_keyword = next((str(row.get("searchTerm", "")).strip()
                             for row in source["keywords"] if row.get("searchTerm")), "")
        if core_keyword:
            competitor_data = call("get_keyword_asin_analysis", {
                "country": request["site"], "keyword": core_keyword, "page": 1,
                "page_size": 20, "sort_field": "traffic", "sort_order": "desc",
            })
            source["competitor_keyword"] = core_keyword
            source["competitors"] = [row for row in competitor_data.get("list", [])
                                     if str(row.get("asin", "")).upper() != request["asin"]][:20]
        source["status"] = "ok" if source["product"] and source["keywords"] else "partial"
        if not source["product"]:
            source["error"] = "西柚未返回该 ASIN 的商品详情"
        elif not source["keywords"]:
            source["error"] = "西柚未返回该 ASIN 的关键词"
    except CollectionError as exc:
        source["error"] = str(exc)
        source["status"] = "partial" if source["product"] or source["keywords"] else "error"
    return source


def collect_listing_data(request: dict, codex_bin: str | None) -> dict:
    if not codex_bin:
        return {"schema_version": "1.0", "collected_at": utc_now(), "overall_status": "blocked",
                "sources": {"lingxing": {"status": "error", "error": "未找到 Codex CLI"},
                            "xiyou": {"status": "error", "error": "未找到 Codex CLI"}}}
    user_task = ("生成一个美国站 ASIN 的 Listing 草稿；只能使用真实产品资料、领星出单词和西柚关键词/竞品数据；"
                 "不得编造功能、参数、认证或竞品数据；不得修改亚马逊后台。")
    sources = {
        "lingxing": collect_listing_lingxing(request, codex_bin),
        "xiyou": collect_listing_xiyou(request, codex_bin, user_task),
    }
    statuses = {source.get("status") for source in sources.values()}
    overall = "ok" if statuses == {"ok"} else "partial" if "ok" in statuses or "partial" in statuses else "blocked"
    return {"schema_version": "1.0", "collected_at": utc_now(), "overall_status": overall,
            "request_identity": {"asin": request["asin"], "site": request["site"]},
            "sources": sources,
            "warnings": [f"{name}: {value.get('error')}" for name, value in sources.items()
                         if value.get("error")]}
