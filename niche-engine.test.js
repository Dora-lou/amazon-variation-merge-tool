const assert = require('node:assert/strict');
const NicheEngine = require('./niche-engine.js');

const productCsv = [
  '细分市场名称: Test Niche',
  '细分市场详情 - 商品选项卡',
  '上次更新日期：2026/11/15',
  '',
  '商品名称,细分市场点击量（过去 360 天）',
  '"Dog bowl, collapsible",100',
  '"Another ""premium"" bowl",200'
].join('\r\n');

const searchTermCsv = [
  '细分市场名称: Test Niche',
  '细分市场详情 - 搜索词选项卡',
  '上次更新日期：2026/11/15',
  '',
  '搜索词,搜索量（过去 360 天）,点击份额（过去 360 天）,搜索转化率（过去 360 天）',
  '"collapsible dog bowls",1000,0.5,0.1',
  '"travel dog bowls",500,0.25,0.2'
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

const names = NicheEngine.makeUniqueSheetNames([
  { id: '1', name: 'Travel: Dog Bowls' },
  { id: '2', name: 'Travel? Dog Bowls' },
  { id: '3', name: 'A'.repeat(40) }
]);
assert.equal(names[0].sheetName, 'Travel_ Dog Bowls');
assert.notEqual(names[0].sheetName, names[1].sheetName);
assert.ok(names.every(function (item) { return item.sheetName.length <= 31; }));

assert.throws(function () {
  NicheEngine.processFiles(
    productCsv,
    searchTermCsv.replace('Test Niche', 'Other Niche'),
    ''
  );
}, /名称不一致/);

console.log('Niche engine tests passed.');
