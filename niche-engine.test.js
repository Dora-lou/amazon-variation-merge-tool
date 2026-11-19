const assert = require('node:assert/strict');
const NicheEngine = require('./niche-engine.js');

const productCsv = [
  '细分市场名称: Test Niche',
  '细分市场详情 - 商品选项卡',
  '上次更新日期：2026/11/15',
  '',
  '"商品名称","细分市场点击量（过去 360 天）"',
  '"Dog bowl, collapsible","100"',
  '"Another ""premium"" bowl","200"'
].join('\r\n');

const stHeaders = [
  '搜索词',
  '搜索量（过去 360 天）',
  '搜索量增长（过去 90 天）',
  '搜索量增长（过去 180 天）',
  '点击份额（过去 360 天）',
  '搜索转化率（过去 360 天）',
  '点击率最高的商品1（标题）',
  '点击率最高的商品1 (ASIN)',
  '点击率最高的商品2（标题）',
  '点击率最高的商品2 (ASIN)',
  '点击率最高的商品3（标题）',
  '点击率最高的商品3 (ASIN)'
];
const stRows = [
  ['collapsible dog bowls', '1000', "'-0.3144", '0.4449', '0.5', '0.1',
    'Best bowl, premium', 'B012345678', 'Second bowl', 'B023456789', 'Third bowl', 'B034567890'],
  ['travel dog bowls', '500', "'-0.3156", '0.3182', '0.25', '0.2',
    'Travel bowl', 'B045678901', 'Second travel bowl', 'B056789012', 'Third travel bowl', 'B067890123']
];
function csvEscape(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}
const searchTermCsv = [
  '细分市场名称: Test Niche',
  '细分市场详情 - “搜索词” 选项卡',
  '上次更新日期：2026/11/15',
  '',
  stHeaders.map(csvEscape).join(','),
  ...stRows.map(function (row) { return row.map(csvEscape).join(','); })
].join('\r\n');

const result = NicheEngine.processFiles(productCsv, searchTermCsv, '');
assert.equal(result.name, 'Test Niche');
assert.equal(result.productCount, 2);
assert.equal(result.searchTermCount, 2);
assert.equal(result.totalClicks, 300);
assert.equal(result.totalOrders, 200);
assert.equal(result.overallCvr, 200 / 300);
assert.equal(result.rows[0].clicks, 150);
assert.equal(result.rows[0].orders, 100);
assert.equal(result.rows[0].ordersPct, 0.5);
assert.equal(result.rows[0].cvr, 100 / 150);
assert.equal(result.rows[1].clicks, 75);
assert.equal(result.rows[1].cvr, 100 / 75);
assert.equal(result.searchTermHeaders.length, 12);
assert.equal(result.searchTermExtraIndexes.length, 10);
assert.equal(result.rows[0].sourceValues[6], 'Best bowl, premium');

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
      aoa.forEach(function (row, rowIndex) {
        row.forEach(function (value, columnIndex) {
          if (value === undefined) return;
          const address = columnName(columnIndex) + (rowIndex + 1);
          sheet[address] = {
            v: value,
            t: typeof value === 'number' ? 'n' : 's'
          };
        });
      });
      return sheet;
    },
    encode_cell: function (cell) { return columnName(cell.c) + (cell.r + 1); },
    book_append_sheet: function (workbook, sheet, name) {
      workbook.SheetNames.push(name);
      workbook.Sheets[name] = sheet;
    }
  }
};
const secondNiche = Object.assign({}, result, {
  id: 'second-niche',
  name: 'Second Niche',
  rows: [
    Object.assign({}, result.rows[0], { term: 'collapsible dog bowls', searchVolume: 1500 }),
    Object.assign({}, result.rows[1], { term: 'another dog bowl', searchVolume: 250 })
  ]
});
const workbook = NicheEngine.buildWorkbook([result, secondNiche], fakeXlsx);
const overview = workbook.Sheets['总表'];
const sheet = workbook.Sheets['Test Niche'];
assert.deepEqual(workbook.SheetNames, ['总表', 'Test Niche', 'Second Niche']);
assert.equal(overview.A4.v, '所属 Niche 市场');
assert.equal(overview.B4.v, '搜索词');
assert.equal(overview.C4.v, '搜索量（过去 360 天）');
assert.equal(overview.D4.v, 'CVR');
assert.equal(overview.E4.v, 'Clicks');
assert.equal(overview.F4.v, 'Orders%');
assert.equal(overview.G4.v, 'Orders');
assert.equal(overview.H4.v, '搜索量增长（过去 90 天）');
assert.equal(overview.I4.v, '搜索量增长（过去 180 天）');
assert.equal(overview.J4.v, '点击份额（过去 360 天）');
assert.equal(overview.K4.v, '搜索转化率（过去 360 天）');
assert.equal(overview.A5.v, 'Second Niche');
assert.equal(overview.B5.v, 'collapsible dog bowls');
assert.equal(overview.C5.v, 1500);
assert.equal(overview.A6.v, 'Test Niche');
assert.equal(overview.B6.v, 'collapsible dog bowls');
assert.equal(overview.C6.v, 1000);
assert.equal(overview.A7.v, 'Test Niche');
assert.equal(overview.B7.v, 'travel dog bowls');
assert.equal(overview.C7.v, 500);
assert.notEqual(overview.A5.s.fill.fgColor.rgb, overview.A6.s.fill.fgColor.rgb);
assert.equal(overview.A6.s.fill.fgColor.rgb, overview.A7.s.fill.fgColor.rgb);
assert.equal(overview.H5.v, -0.3144);
assert.equal(overview.L5.v, 'Best bowl, premium');
assert.equal(overview.M5.v, 'B012345678');
assert.equal(overview['!autofilter'].ref, 'A4:Q8');
assert.equal(overview['!freeze'].xSplit, 2);
assert.equal(overview['!freeze'].ySplit, 4);
assert.equal(overview['!merges'].length, 3);
assert.equal(sheet.A7.v, '搜索词');
assert.equal(sheet.B7.v, '搜索量（过去 360 天）');
assert.equal(sheet.C7.v, 'CVR');
assert.equal(sheet.D7.v, 'Clicks');
assert.equal(sheet.E7.v, 'Orders%');
assert.equal(sheet.F7.v, 'Orders');
assert.equal(sheet.G7.v, '搜索量增长（过去 90 天）');
assert.equal(sheet.H7.v, '搜索量增长（过去 180 天）');
assert.equal(sheet.I7.v, '点击份额（过去 360 天）');
assert.equal(sheet.J7.v, '搜索转化率（过去 360 天）');
assert.equal(sheet.K7.v, '点击率最高的商品1（标题）');
assert.equal(sheet.L7.v, '点击率最高的商品1 (ASIN)');
assert.equal(sheet.A8.v, 'collapsible dog bowls');
assert.equal(sheet.B8.v, 1000);
assert.equal(sheet.C8.v, 100 / 150);
assert.equal(sheet.G8.v, -0.3144);
assert.equal(sheet.K8.v, 'Best bowl, premium');
assert.equal(sheet.L8.v, 'B012345678');
assert.equal(sheet.C8.z, '0.00%');
assert.equal(sheet['!freeze'].xSplit, 2);
assert.equal(sheet['!freeze'].ySplit, 7);
assert.ok(sheet.A1.s && sheet.A1.s.fill.fgColor.rgb === 'FF183B56');
assert.ok(sheet.A7.s && sheet.A7.s.font.color.rgb === 'FFFFFFFF');
assert.equal(sheet.M7.v, '点击率最高的商品2（标题）');
assert.equal(sheet.N7.v, '点击率最高的商品2 (ASIN)');
assert.equal(sheet.O7.v, '点击率最高的商品3（标题）');
assert.equal(sheet.P7.v, '点击率最高的商品3 (ASIN)');
assert.equal(sheet.M8.v, 'Second bowl');
assert.equal(sheet.N8.v, 'B023456789');
assert.equal(sheet.O8.v, 'Third bowl');
assert.equal(sheet.P8.v, 'B034567890');
assert.equal(sheet['!autofilter'].ref, 'A7:P9');
assert.equal(sheet['!merges'].length, 8);

const names = NicheEngine.makeUniqueSheetNames([
  { id: '1', name: 'Travel: Dog Bowls' },
  { id: '2', name: 'Travel? Dog Bowls' },
  { id: '3', name: 'A'.repeat(40) }
]);
assert.equal(names[0].sheetName, 'Travel_ Dog Bowls');
assert.notEqual(names[0].sheetName, names[1].sheetName);
assert.ok(names.every(function (item) { return item.sheetName.length <= 31; }));
const reservedTotalName = NicheEngine.makeUniqueSheetNames([
  { id: 'total-name', name: '总表' }
]);
assert.equal(reservedTotalName[0].sheetName, '总表 (2)');

assert.throws(function () {
  NicheEngine.processFiles(
    productCsv,
    searchTermCsv.replace('Test Niche', 'Other Niche'),
    ''
  );
}, /名称不一致/);

console.log('Niche engine tests passed.');
