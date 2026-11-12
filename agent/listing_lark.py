# -*- coding: utf-8 -*-
"""Create a brand-new Feishu test workbook for a validated Listing draft."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime
from typing import Any

from read_only_collectors import CollectionError


def _run(lark_bin: str, args: list[str], stdin: dict | None = None) -> dict:
    try:
        proc = subprocess.run(
            [lark_bin, *args], input=(json.dumps(stdin, ensure_ascii=False) if stdin is not None else None),
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CollectionError("飞书测试表命令无法执行或超时") from None
    if proc.returncode != 0 or len(proc.stdout) > 2_000_000:
        raise CollectionError("飞书测试表命令失败；未返回原始错误以避免泄露认证信息")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise CollectionError("飞书测试表命令未返回 JSON") from None
    if not result.get("ok"):
        raise CollectionError("飞书测试表命令未成功")
    return result


def _sheet(name: str, columns: list[str], rows: list[list[Any]]) -> dict:
    return {"name": name, "columns": columns, "data": rows, "header": True,
            "allow_overwrite": False, "dtypes": {column: "object" for column in columns}}


def build_workbook_payload(result: dict) -> dict:
    asin, version = result["asin"], result["version"]
    copy_block = result["copy"]
    master_rows = []
    fields = [("Title", copy_block["title"]),
              ("Item Highlights", copy_block["item_highlights"])]
    fields.extend((f"Bullet {index}", field) for index, field in enumerate(copy_block["bullets"], 1))
    fields.extend([("Description", copy_block["description"]),
                   ("Search Terms", copy_block["search_terms"])])
    for name, field in fields:
        value = field["en"]
        master_rows.append([asin, version, name, value, field["zh"], len(value),
                            len(value.encode("utf-8")) if name == "Search Terms" else "",
                            "待审核", ", ".join(field.get("fact_ids", []))])

    variations = result.get("variation_rows", [])
    if not variations:
        variations = [[asin, "测试母版", "当前只生成一个代表性子 ASIN", "待审核"]]
    final_rows = [[asin, version, name, field["en"], field["zh"], "待审核"]
                  for name, field in fields]
    evidence_rows = []
    evidence_rows.extend([["产品事实", row.get("id", ""), row.get("fact", ""),
                           row.get("source", ""), row.get("status", "")]
                          for row in result.get("truth_profile", [])])
    evidence_rows.extend([["关键词", row.get("term", ""), row.get("evidence", ""),
                           row.get("source", ""), "已采集"] for row in result.get("keywords", [])])
    evidence_rows.extend([["竞品", row.get("asin", ""), row.get("title", ""),
                           row.get("evidence", ""), row.get("relevance", "")]
                          for row in result.get("competitors", [])])
    evidence_rows.extend([["待确认", "", item, "AI 草稿", "待确认"]
                          for item in result.get("pending_confirmations", [])])
    return {"sheets": [
        _sheet("01 Listing母版",
               ["子ASIN", "版本", "字段", "英文原稿", "中文译文", "字符数", "UTF-8字节", "状态", "事实依据ID"],
               master_rows),
        _sheet("02 变体差异", ["子ASIN", "属性", "差异/决策", "状态"], variations),
        _sheet("03 最终文案", ["子ASIN", "版本", "字段", "英文文案", "中文译文", "状态"], final_rows),
        _sheet("04 分析依据", ["类型", "标识/关键词", "内容/证据", "来源", "状态"], evidence_rows),
    ]}


def create_test_workbook(lark_bin: str, result: dict) -> dict:
    if not result.get("validation", {}).get("passed"):
        raise CollectionError("Listing 规则校验未通过，禁止写入测试表")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    title = f"[TEST] Amazon Listing Writer {result['asin']} {stamp}"
    payload = build_workbook_payload(result)
    created = _run(lark_bin, ["sheets", "+workbook-create", "--title", title,
                              "--sheets", "-", "--as", "user"], payload)
    data = created.get("data", {})
    token = str(data.get("spreadsheet_token") or data.get("spreadsheetToken") or data.get("token") or "")
    url = str(data.get("url") or data.get("spreadsheet_url") or "")
    if not token and "/sheets/" in url:
        token = url.split("/sheets/", 1)[1].split("?", 1)[0].split("/", 1)[0]
    if not token:
        raise CollectionError("飞书已接受建表请求，但响应缺少 spreadsheet token，无法回读验证")
    info = _run(lark_bin, ["sheets", "+workbook-info", "--spreadsheet-token", token,
                           "--as", "user"])
    table = _run(lark_bin, ["sheets", "+table-get", "--spreadsheet-token", token,
                            "--as", "user", "--max-chars", "500000"])
    sheets = info.get("data", {}).get("sheets", [])
    names = [row.get("title") or row.get("sheet_name") for row in sheets if isinstance(row, dict)]
    expected = ["01 Listing母版", "02 变体差异", "03 最终文案", "04 分析依据"]
    if names != expected:
        raise CollectionError(f"飞书测试表结构回读不一致：{names}")
    returned = table.get("data", {}).get("sheets", [])
    if len(returned) != 4 or any(not sheet.get("data") for sheet in returned):
        raise CollectionError("飞书测试表四个 Sheet 未全部回读到数据")
    return {"title": title, "spreadsheet_token": token, "url": url,
            "sheets": names, "readback_verified": True}
