#!/usr/bin/env python3
"""Validate a Feishu sales-plan workbook exported to .xlsx against the fixed 5-sheet contract."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from openpyxl import load_workbook

SHEETS = ["销售计划", "库存统计", "利润测算", "竞对分析", "月度复盘与补量折扣"]
INVENTORY_HEADERS = ["产品名称", "ASIN", "MSKU", "FNSKU", "FBA可售", "FBA待调仓", "FBA入库中", "FBA实际在途", "FBA计划入库", "AWD可用", "AWD标发在途", "规划总库存", "库存日期", "来源/口径", None, "后续计划量", "预计余量", "库存消化率", "库存检查"]
PROFIT_HEADERS = ["ASIN", "FNSKU", "产品名称", "产品成本 USD", "FBA配送费 USD", "其他固定成本 USD", "平台佣金率", "其他售价计提率", "售价 USD", "默认TACOS", "退货率", "仓储率", "固定成本 USD", "公式估算单件净利 USD", "公式估算单件利润率", "阶段广告费 USD", "成本状态", "数据来源/假设"]
COMPETITOR_HEADERS = ["竞对ASIN", "品牌", "商品标题（原文）", None, None, None, None, "四月合计", None, None, None, None, "可比性/说明"]
REVIEW_HEADERS = ["ASIN", "产品名称", "所选月计划销量", "所选月实际销量", "差值（实际−计划；负数=未达）", "待完成目标量", "售价 USD", "原价单件净利 USD", "折后售价 USD", "折后单件净利 USD", "折后预计总利润 USD", "前期未完成量", "本月补量参考（不叠加）", "库存余量（正式计划）", "成本状态", "计划/实际状态"]
ERROR_TOKENS = ("#REF!", "#VALUE!", "#DIV/0!", "#NAME?", "#N/A")

def month_count(start: str, end: str) -> int:
    sy, sm = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    return (ey - sy) * 12 + em - sm + 1

def rgb(cell):
    color = cell.fill.fgColor
    if color.type == "rgb" and color.rgb:
        return color.rgb[-6:].upper()
    return None

def check_header(ws, row, headers, errors, dynamic_positions=()):
    for col, expected in enumerate(headers, 1):
        actual = ws.cell(row, col).value
        if col in dynamic_positions:
            continue
        if expected is not None and actual != expected:
            errors.append(f"{ws.title}!{ws.cell(row,col).coordinate}: expected {expected!r}, got {actual!r}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="Feishu-exported .xlsx file")
    ap.add_argument("--start-month", help="YYYY-MM")
    ap.add_argument("--end-month", help="YYYY-MM")
    ap.add_argument("--expected-asins", default="", help="Comma-separated target product ASINs")
    ap.add_argument("--strict-format", action="store_true", help="Also verify key template colors and font")
    args = ap.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"ERROR: file not found: {path}")
        return 2

    wb = load_workbook(path, data_only=False)
    errors = []
    if wb.sheetnames != SHEETS:
        errors.append(f"Sheet order/count mismatch: expected {SHEETS}, got {wb.sheetnames}")

    if "销售计划" in wb.sheetnames:
        ws = wb["销售计划"]
        fixed = [ws.cell(13, c).value for c in range(1, 4)]
        if fixed != ["ASIN", "产品名称", "当前总库存"]:
            errors.append(f"销售计划!A13:C13 mismatch: {fixed!r}")
        if not str(ws["D13"].value or "").endswith("计划量"):
            errors.append(f"销售计划!D13 must be a dynamic month-range header ending in 计划量")
        month_merges = sorted(
            [r for r in ws.merged_cells.ranges if r.min_row == 1 and r.max_row == 1 and r.min_col >= 5],
            key=lambda r: r.min_col
        )
        if not month_merges:
            errors.append("销售计划 has no merged month title blocks on row 1")
        else:
            for rng in month_merges:
                width = rng.max_col - rng.min_col + 1
                headers = [ws.cell(13, c).value for c in range(rng.min_col, rng.max_col + 1)]
                allowed = [
                    ["销售比例", "日均", "原计划月销量", "实际销量", "差值（实际−计划）", "售价 USD"],
                    ["销售比例", "日均", "月销量", "售价 USD"]
                ]
                if width not in (4, 6) or headers not in allowed:
                    errors.append(f"销售计划 month block {rng}: invalid width/header {headers!r}")
                for row in range(1, 13):
                    expected_merge = f"{ws.cell(row,rng.min_col).coordinate}:{ws.cell(row,rng.max_col).coordinate}"
                    if expected_merge not in {str(x) for x in ws.merged_cells.ranges}:
                        errors.append(f"销售计划 missing merged range {expected_merge}")
                        break
            if args.start_month and args.end_month:
                expected = month_count(args.start_month, args.end_month)
                if len(month_merges) != expected:
                    errors.append(f"Month count mismatch: expected {expected}, got {len(month_merges)}")

    if "库存统计" in wb.sheetnames:
        ws = wb["库存统计"]
        if ws.max_column != 19:
            errors.append(f"库存统计 must have exactly 19 columns, got {ws.max_column}")
        check_header(ws, 3, INVENTORY_HEADERS, errors, dynamic_positions=(15, 16))
        if not re.match(r"^\d+%规划目标$", str(ws["O3"].value or "")):
            errors.append(f"库存统计!O3 must be '<目标百分比>规划目标', got {ws['O3'].value!r}")
        if not str(ws["P3"].value or "").endswith("计划量"):
            errors.append("库存统计!P3 must be a dynamic plan-quantity header")

    if "利润测算" in wb.sheetnames:
        ws = wb["利润测算"]
        if ws.max_column != 18:
            errors.append(f"利润测算 must have exactly 18 columns, got {ws.max_column}")
        check_header(ws, 3, PROFIT_HEADERS, errors)

    if "竞对分析" in wb.sheetnames:
        ws = wb["竞对分析"]
        if ws.max_column != 13:
            errors.append(f"竞对分析 must have exactly 13 columns, got {ws.max_column}")
        check_header(ws, 3, COMPETITOR_HEADERS, errors, dynamic_positions=(4,5,6,7,9,10,11,12))
        for col in range(4, 8):
            if not str(ws.cell(3,col).value or "").endswith("销量"):
                errors.append(f"竞对分析!{ws.cell(3,col).coordinate} must be a month sales header")
        for col in range(9, 13):
            if not str(ws.cell(3,col).value or "").endswith("占比"):
                errors.append(f"竞对分析!{ws.cell(3,col).coordinate} must be a month share header")

    if "月度复盘与补量折扣" in wb.sheetnames:
        ws = wb["月度复盘与补量折扣"]
        if ws.max_column != 16:
            errors.append(f"月度复盘与补量折扣 must have exactly 16 columns, got {ws.max_column}")
        check_header(ws, 6, REVIEW_HEADERS, errors)

    expected_asins = {x.strip().upper() for x in args.expected_asins.split(",") if x.strip()}
    if expected_asins:
        checks = [
            ("销售计划", 14, 1, "合计 / 校验"),
            ("库存统计", 4, 2, "合计"),
            ("利润测算", 4, 1, None),
            ("月度复盘与补量折扣", 7, 1, "合计"),
        ]
        for sheet, start_row, col, stop_label in checks:
            if sheet not in wb.sheetnames:
                continue
            ws = wb[sheet]
            for row in range(start_row, ws.max_row + 1):
                if stop_label and ws.cell(row, 1).value == stop_label:
                    break
                value = ws.cell(row, col).value
                if isinstance(value, str) and re.fullmatch(r"[A-Z0-9]{10}", value.upper()):
                    if value.upper() not in expected_asins:
                        errors.append(f"{sheet}!{ws.cell(row,col).coordinate} contains ASIN outside this task: {value}")

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and any(token in cell.value for token in ERROR_TOKENS):
                    errors.append(f"{ws.title}!{cell.coordinate} contains formula error token {cell.value!r}")

    if args.strict_format:
        checks = [
            ("销售计划", "E1", "FFE84A"),
            ("销售计划", "A2", "F9E3EC"),
            ("销售计划", "E4", "D9F0EC"),
            ("销售计划", "E13", "D9EAF7"),
            ("库存统计", "A3", "D9EAF7"),
            ("利润测算", "A3", "D9EAF7"),
            ("竞对分析", "A3", "D9EAF7"),
            ("月度复盘与补量折扣", "A6", "D9EAF7"),
        ]
        for sheet, cell, expected in checks:
            if sheet in wb.sheetnames:
                actual = rgb(wb[sheet][cell])
                if actual != expected:
                    errors.append(f"Format mismatch {sheet}!{cell}: expected #{expected}, got {actual}")
        if "销售计划" in wb.sheetnames:
            font_name = wb["销售计划"]["A1"].font.name
            if font_name and font_name != "等线":
                errors.append(f"Font mismatch: expected 等线, got {font_name!r}")

    if errors:
        print("TEMPLATE VALIDATION FAILED")
        for item in errors:
            print(" - " + item)
        return 1
    print("TEMPLATE VALIDATION PASSED")
    print(f"Sheets: {len(wb.sheetnames)}; order: {' / '.join(wb.sheetnames)}")
    if "销售计划" in wb.sheetnames:
        count = len([r for r in wb["销售计划"].merged_cells.ranges if r.min_row == 1 and r.max_row == 1 and r.min_col >= 5])
        print(f"Planning month blocks: {count}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
