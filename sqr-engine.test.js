const assert = require('node:assert/strict');
const SqrEngine = require('./sqr-engine.js');

const headers = [
  '搜索查询','搜索查询得分','搜索查询量','曝光：曝光总量','曝光量：ASIN 计数','曝光：ASIN 曝光占比 %',
  '点击量：总次数','点击量：点击率 %','点击量：ASIN 数量','点击量：ASIN 份额 %','点击量：价格(中位数)','点击量：ASIN 售价（中位数）',
  '点击量：当日达配送速度','点击量：1 天配送速度','点击：2天配送速度','购物车添加：总数','加入购物车：加购率%',
  '加购：ASIN 数量','加入购物车：ASIN 加购占比 %','加入购物车：售价（中位数）','加入购物车：ASIN 价格（中位数）',
  '购物车添加：当日达配送速度','加入购物车：1 天配送速度','购物车添加：2 天配送速度','购买：下单总数',
  '下单成交：成交转化率%','下单成交：ASIN 数量','下单: ASIN 占比 %','购买次数：价格（中位数）',
  '购买：ASIN 价格（中位数）','下单成交：当日达配送速度','下单成交：1 天配送速度','下单：2天配送速度','报告日期'
];
function row(query, volume, impressions, asinImpressions, clicks, asinClicks, carts, asinCarts, purchases, asinPurchases) {
  return [
    query, 50, volume, impressions, asinImpressions, impressions ? asinImpressions / impressions * 100 : 0,
    clicks, volume ? clicks / volume * 100 : 0, asinClicks, clicks ? asinClicks / clicks * 100 : 0,
    9.99, 8.99, 10, 20, 30, carts, volume ? carts / volume * 100 : 0, asinCarts,
    carts ? asinCarts / carts * 100 : 0, 9.99, 8.99, 10, 20, 30, purchases,
    volume ? purchases / volume * 100 : 0, asinPurchases, purchases ? asinPurchases / purchases * 100 : 0,
    9.99, 8.99, 10, 20, 30, '2026-06-30'
  ];
}
function csvEscape(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}
const dataRows = [
  row('low volume dog bowl', 1000, 10000, 500, 400, 25, 100, 10, 30, 3),
  row('high demand water bowl', 10000, 100000, 1000, 4000, 50, 1000, 20, 300, 10),
  row('click share leakage query', 8000, 50000, 5000, 2000, 100, 400, 24, 100, 6),
  row('medium dog bowl', 5000, 20000, 2000, 1000, 100, 250, 30, 80, 12)
];
const csv = [
  'ASIN=["B08YYX1QLB"],报告范围=["每季度"],选择年份=["2026"],选择季度=["2"]',
  headers.map(csvEscape).join(','),
  ...dataRows.map(function (r) { return r.map(csvEscape).join(','); })
].join('\r\n');

const result = SqrEngine.processCsv(csv);
assert.equal(result.metadata.asin, 'B08YYX1QLB');
assert.equal(result.metadata.reportRange, '每季度');
assert.equal(result.metadata.year, '2026');
assert.equal(result.metadata.quarter, '2');
assert.equal(result.headers.length, 34);
assert.equal(result.rows.length, 4);
assert.equal(result.rawRows[0].query, 'low volume dog bowl');
assert.equal(result.rows[0].query, 'high demand water bowl');
assert.equal(result.highVolumeThreshold, 8500);
assert.equal(result.rows[0].queryCategory, '碗类相关词');
assert.equal(result.rows[0].relevanceLevel, '中相关');
assert.equal(result.rows[0].actionPriority, '高需求流量缺口');
assert.equal(result.rows[0].opportunityLabel, '高需求·低曝光');
assert.ok(Array.isArray(result.rows[0].funnelIssues));
assert.ok(result.queryGroups.length >= 2);
const waterBowlGroup = result.queryGroups.find(function (g) { return g.queryCategory === '碗类相关词'; });
assert.ok(waterBowlGroup);
assert.ok(Math.abs(waterBowlGroup.searchVolumeContribution - (10000 / 24000)) < 1e-10);
assert.ok(Math.abs(waterBowlGroup.asinPurchaseContribution - (10 / 31)) < 1e-10);
assert.ok(result.relevantOpportunities.some(function (r) { return r.query === 'high demand water bowl'; }));
assert.ok(result.coreConvertingTerms.some(function (r) { return r.query === 'medium dog bowl'; }));
assert.equal(result.rows.find(function (r) { return r.query === 'click share leakage query'; }).funnelDiagnosis, '曝光→点击份额流失');
assert.equal(result.aggregate.queryCount, 4);
assert.equal(result.aggregate.searchVolume, 24000);
assert.equal(result.aggregate.impressions, 180000);
assert.equal(result.aggregate.clicks, 7400);
assert.equal(result.aggregate.asinClicks, 275);
assert.ok(Math.abs(result.aggregate.asinImpressionShare - (8500 / 180000)) < 1e-10);
assert.ok(Math.abs(result.aggregate.asinClickShare - (275 / 7400)) < 1e-10);

function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}
const fakeXlsx = {
  utils: {
    book_new: function () { return { SheetNames: [], Sheets: {} }; },
    aoa_to_sheet: function (aoa) {
      const sheet = {};
      aoa.forEach(function (r, ri) {
        r.forEach(function (v, ci) {
          if (v === undefined) return;
          sheet[columnName(ci) + (ri + 1)] = { v: v, t: typeof v === 'number' ? 'n' : 's' };
        });
      });
      return sheet;
    },
    encode_cell: function (cell) { return columnName(cell.c) + (cell.r + 1); },
    book_append_sheet: function (wb, sheet, name) {
      wb.SheetNames.push(name);
      wb.Sheets[name] = sheet;
    }
  }
};
const workbook = SqrEngine.buildWorkbook(result, fakeXlsx);
assert.deepEqual(workbook.SheetNames, ['SQR', 'SQR总览', '搜索词分析', '关键词分组', '原始数据']);
const benchmark = workbook.Sheets['SQR'];
assert.equal(benchmark.A1.v, '类目点击率');
assert.equal(benchmark.B1.v, 'ASIN点击率');
assert.equal(benchmark.C1.v, '点击胜率');
assert.equal(benchmark.D1.v, '类目-加购率');
assert.equal(benchmark.F1.v, '加购胜率');
assert.equal(benchmark.G1.v, '类目-CVR');
assert.equal(benchmark.I1.v, 'CVR胜率');
assert.equal(benchmark.J1.v, 'PRI');
assert.equal(benchmark.K1.v, '搜索查询');
assert.equal(benchmark.AR1.v, '报告日期');
assert.equal(benchmark.A2.f, 'IFERROR(Q2/N2,0)');
assert.equal(benchmark.B2.f, 'IFERROR(S2/O2,0)');
assert.equal(benchmark.C2.f, 'B2>A2');
assert.equal(benchmark.D2.f, 'IFERROR(Z2/Q2,0)');
assert.equal(benchmark.E2.f, 'IFERROR(AB2/S2,0)');
assert.equal(benchmark.F2.f, 'E2>D2');
assert.equal(benchmark.G2.f, 'IFERROR(AI2/Q2,0)');
assert.equal(benchmark.H2.f, 'IFERROR(AK2/S2,0)');
assert.equal(benchmark.I2.f, 'H2>G2');
assert.equal(benchmark.J2.f, 'IFERROR(AL2/P2,0)');
assert.equal(benchmark.C2.v, true);
assert.equal(benchmark.F2.v, true);
assert.equal(benchmark.I2.v, true);
assert.equal(benchmark.C2.s.fill.fgColor.rgb, 'FFD9F5D6');
assert.equal(benchmark.F2.s.fill.fgColor.rgb, 'FFD9F5D6');
assert.equal(benchmark.I2.s.fill.fgColor.rgb, 'FFD9F5D6');
assert.equal(benchmark['!autofilter'].ref, 'A1:AR5');
const analysis = workbook.Sheets['搜索词分析'];
assert.equal(analysis.A1.v, '搜索查询');
assert.equal(analysis.B1.v, '搜索查询量');
assert.equal(analysis.C1.v, '搜索词类型');
assert.equal(analysis.D1.v, '相关性预判');
assert.equal(analysis.F1.v, '行动优先级');
assert.equal(analysis.H1.v, '机会标签');
assert.equal(analysis.I1.v, '漏斗诊断');
assert.equal(analysis.A2.v, 'high demand water bowl');
assert.equal(analysis.C2.v, '碗类相关词');
assert.equal(analysis.F2.v, '高需求流量缺口');
assert.equal(analysis.H2.v, '高需求·低曝光');
assert.equal(analysis['!autofilter'].ref, 'A1:BB5');
assert.equal(analysis['!freeze'].xSplit, 2);
const groups = workbook.Sheets['关键词分组'];
assert.equal(groups.A1.v, '搜索词分类');
assert.ok(groups.A2.v);
assert.equal(groups['!autofilter'].ref, 'A1:S4');
const raw = workbook.Sheets['原始数据'];
assert.equal(raw.A3.v, '搜索查询');
assert.equal(raw.A4.v, 'low volume dog bowl');
assert.equal(raw.A5.v, 'high demand water bowl');
assert.equal(raw['!autofilter'].ref, 'A3:AH7');
const overview = workbook.Sheets['SQR总览'];
assert.equal(overview.A1.v, 'SQR SEARCH QUERY PERFORMANCE');
assert.equal(overview.A8.v, '搜索漏斗');
assert.equal(overview.A24.v, '搜索查询');
assert.equal(overview.A28.v, '搜索查询');
console.log('SQR engine tests passed.');
