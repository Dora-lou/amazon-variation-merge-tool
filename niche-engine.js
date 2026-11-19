/* Niche market CSV processing engine. Runs entirely in the browser; no AI/API calls. */
(function (root) {
  'use strict';

  function fail(message) { throw new Error(message); }

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/^\uFEFF/, '')
      .replace(/[\s_\-./（）()：:]+/g, '')
      .toLowerCase()
      .trim();
  }

  function parseCsv(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '"') {
        if (quoted && source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        row.push(field);
        field = '';
      } else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(field);
        if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }

    if (quoted) fail('CSV 文件存在未闭合的双引号，请重新从后台下载文件。');
    row.push(field);
    if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
    if (!rows.length) fail('CSV 文件为空。');
    return rows;
  }

  function findHeader(rows, requiredHeaders, fileLabel) {
    const required = requiredHeaders.map(normalizeHeader);
    const limit = Math.min(rows.length, 50);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const headers = (rows[rowIndex] || []).map(normalizeHeader);
      const indexes = {};
      let complete = true;
      required.forEach(function (header) {
        const index = headers.indexOf(header);
        if (index < 0) complete = false;
        indexes[header] = index;
      });
      if (complete) return { rowIndex: rowIndex, headers: headers, indexes: indexes };
    }
    fail(fileLabel + '中未找到完整表头。请确认上传的是后台导出的原始 Niche CSV 文件。');
  }

  function parseNumber(value, fieldLabel, rowNumber) {
    let raw = String(value == null ? '' : value).trim();
    if (!raw) return 0;
    raw = raw.replace(/^['’]/, '').replace(/,/g, '').trim();
    const isPercent = /%$/.test(raw);
    if (isPercent) raw = raw.slice(0, -1);
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      fail('第 ' + rowNumber + ' 行的「' + fieldLabel + '」不是有效数字：' + String(value));
    }
    return isPercent ? number / 100 : number;
  }

  function extractNicheName(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const firstLines = source.split(/\r?\n/).slice(0, 5);
    for (let i = 0; i < firstLines.length; i += 1) {
      const match = firstLines[i].match(/细分市场名称\s*[:：]\s*(.+?)\s*$/);
      if (match && match[1]) return match[1].trim().replace(/^["']|["']$/g, '');
    }
    return '';
  }

  function parseProductCsv(text) {
    const rows = parseCsv(text);
    const found = findHeader(rows, ['商品名称', '细分市场点击量（过去 360 天）'], 'Product 表');
    const titleIndex = found.indexes[normalizeHeader('商品名称')];
    const clicksIndex = found.indexes[normalizeHeader('细分市场点击量（过去 360 天）')];
    const products = [];
    let totalClicks = 0;

    for (let i = found.rowIndex + 1; i < rows.length; i += 1) {
      const current = rows[i] || [];
      const title = String(current[titleIndex] == null ? '' : current[titleIndex]).trim();
      const rawClicks = current[clicksIndex];
      if (!title && String(rawClicks == null ? '' : rawClicks).trim() === '') continue;
      const clicks = parseNumber(rawClicks, '细分市场点击量（过去 360 天）', i + 1);
      totalClicks += clicks;
      products.push({ title: title, clicks: clicks });
    }

    if (!products.length) fail('Product 表表头已识别，但没有找到商品数据行。');
    return { totalClicks: totalClicks, productCount: products.length };
  }

  function parseSearchTermCsv(text) {
    const rows = parseCsv(text);
    const found = findHeader(rows, [
      '搜索词',
      '搜索量（过去 360 天）',
      '点击份额（过去 360 天）',
      '搜索转化率（过去 360 天）'
    ], 'Search Term 表');

    const termIndex = found.indexes[normalizeHeader('搜索词')];
    const volumeIndex = found.indexes[normalizeHeader('搜索量（过去 360 天）')];
    const shareIndex = found.indexes[normalizeHeader('点击份额（过去 360 天）')];
    const conversionIndex = found.indexes[normalizeHeader('搜索转化率（过去 360 天）')];
    const terms = [];

    for (let i = found.rowIndex + 1; i < rows.length; i += 1) {
      const current = rows[i] || [];
      const term = String(current[termIndex] == null ? '' : current[termIndex]).trim();
      if (!term) continue;
      const volume = parseNumber(current[volumeIndex], '搜索量（过去 360 天）', i + 1);
      const clickShare = parseNumber(current[shareIndex], '点击份额（过去 360 天）', i + 1);
      const conversionRate = parseNumber(current[conversionIndex], '搜索转化率（过去 360 天）', i + 1);
      if (volume < 0 || clickShare < 0 || conversionRate < 0) {
        fail('第 ' + (i + 1) + ' 行存在负数，请检查 Search Term 数据。');
      }
      terms.push({
        term: term,
        searchVolume: volume,
        clickShare: clickShare,
        conversionRate: conversionRate
      });
    }

    if (!terms.length) fail('Search Term 表表头已识别，但没有找到搜索词数据行。');
    return terms;
  }

  function processFiles(productCsvText, searchTermCsvText, nicheName) {
    const productNicheName = extractNicheName(productCsvText);
    const searchNicheName = extractNicheName(searchTermCsvText);
    if (productNicheName && searchNicheName &&
        normalizeHeader(productNicheName) !== normalizeHeader(searchNicheName)) {
      fail('两份 CSV 的细分市场名称不一致：Product 为「' + productNicheName +
        '」，Search Term 为「' + searchNicheName + '」。请确认两份文件属于同一个 Niche。');
    }

    const finalName = String(nicheName || productNicheName || searchNicheName || '').trim();
    if (!finalName) fail('请填写 Niche 市场名称，或上传带有细分市场名称说明行的原始 CSV。');

    const product = parseProductCsv(productCsvText);
    const terms = parseSearchTermCsv(searchTermCsvText);
    const totalOrders = terms.reduce(function (sum, term) {
      return sum + term.searchVolume * term.conversionRate;
    }, 0);
    const totalClicks = product.totalClicks;

    const calculatedTerms = terms.map(function (term) {
      const clicks = totalClicks * term.clickShare;
      const orders = term.searchVolume * term.conversionRate;
      return {
        term: term.term,
        searchVolume: term.searchVolume,
        clickShare: term.clickShare,
        conversionRate: term.conversionRate,
        clicks: clicks,
        orders: orders,
        ordersPct: totalOrders > 0 ? orders / totalOrders : 0,
        cvr: clicks > 0 ? orders / clicks : null
      };
    });

    return {
      name: finalName,
      totalClicks: totalClicks,
      totalOrders: totalOrders,
      overallCvr: totalClicks > 0 ? totalOrders / totalClicks : null,
      productCount: product.productCount,
      searchTermCount: calculatedTerms.length,
      rows: calculatedTerms,
      productNicheName: productNicheName,
      searchNicheName: searchNicheName
    };
  }

  function makeUniqueSheetNames(niches) {
    const used = new Set();
    return niches.map(function (niche) {
      const original = String(niche.name || 'Niche').trim();
      let base = original.replace(/[\\/*?:\[\]]/g, '_').replace(/^'+|'+$/g, '').trim();
      if (!base) base = 'Niche';
      base = base.slice(0, 31);
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate.toLowerCase())) {
        const tail = ' (' + suffix + ')';
        candidate = base.slice(0, 31 - tail.length) + tail;
        suffix += 1;
      }
      used.add(candidate.toLowerCase());
      return { id: niche.id, name: original, sheetName: candidate };
    });
  }

  function buildWorkbook(niches, XLSX) {
    if (!XLSX || !XLSX.utils) fail('Excel 处理组件未加载，请刷新页面后重试。');
    if (!Array.isArray(niches) || !niches.length) fail('当前产品还没有 Niche 数据，无法导出。');

    const names = makeUniqueSheetNames(niches);
    const workbook = XLSX.utils.book_new();

    niches.forEach(function (niche, index) {
      const aoa = [
        ['细分市场名称: ' + String(niche.name || '')],
        ['Total Orders', niche.totalOrders],
        ['Total Clicks', niche.totalClicks],
        ['CVR', niche.overallCvr == null ? '' : niche.overallCvr],
        ['CVR', 'Clicks', 'Orders%', 'Orders', '', '搜索词', '搜索量（过去 360 天）']
      ];

      (niche.rows || []).forEach(function (row) {
        aoa.push([
          row.cvr == null ? '' : row.cvr,
          row.clicks,
          row.ordersPct,
          row.orders,
          '',
          row.term,
          row.searchVolume
        ]);
      });

      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const lastRow = 5 + (niche.rows || []).length;
      sheet['!cols'] = [
        { wch: 13 }, { wch: 15 }, { wch: 13 }, { wch: 15 },
        { wch: 3 }, { wch: 42 }, { wch: 23 }
      ];
      sheet['!freeze'] = { xSplit: 0, ySplit: 5, topLeftCell: 'A6', activePane: 'bottomLeft', state: 'frozen' };
      sheet['!autofilter'] = { ref: 'A5:G' + lastRow };

      if (sheet.B2) sheet.B2.z = '#,##0.00';
      if (sheet.B3) sheet.B3.z = '#,##0';
      if (sheet.B4 && niche.overallCvr != null) sheet.B4.z = '0.00%';

      for (let rowIndex = 6; rowIndex <= lastRow; rowIndex += 1) {
        const cvrCell = sheet['A' + rowIndex];
        const clicksCell = sheet['B' + rowIndex];
        const shareCell = sheet['C' + rowIndex];
        const ordersCell = sheet['D' + rowIndex];
        const volumeCell = sheet['G' + rowIndex];
        if (cvrCell && typeof cvrCell.v === 'number') cvrCell.z = '0.00%';
        if (clicksCell && typeof clicksCell.v === 'number') clicksCell.z = '#,##0.00';
        if (shareCell && typeof shareCell.v === 'number') shareCell.z = '0.00%';
        if (ordersCell && typeof ordersCell.v === 'number') ordersCell.z = '#,##0.00';
        if (volumeCell && typeof volumeCell.v === 'number') volumeCell.z = '#,##0';
      }

      XLSX.utils.book_append_sheet(workbook, sheet, names[index].sheetName);
    });

    return workbook;
  }

  const api = {
    parseCsv: parseCsv,
    extractNicheName: extractNicheName,
    parseProductCsv: parseProductCsv,
    parseSearchTermCsv: parseSearchTermCsv,
    processFiles: processFiles,
    makeUniqueSheetNames: makeUniqueSheetNames,
    buildWorkbook: buildWorkbook
  };

  root.NicheEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
