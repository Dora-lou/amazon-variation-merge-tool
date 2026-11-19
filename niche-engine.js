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

  function rawExcelValue(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const cleaned = raw.replace(/^['’](?=[+-]?(?:\d|\.\d))/, '').replace(/,/g, '');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) {
      const number = Number(cleaned);
      if (Number.isFinite(number)) return number;
    }
    return raw;
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

    const headerRow = rows[found.rowIndex] || [];
    const sourceHeaders = headerRow.map(function (value) { return String(value == null ? '' : value).trim(); });
    const termIndex = found.indexes[normalizeHeader('搜索词')];
    const volumeIndex = found.indexes[normalizeHeader('搜索量（过去 360 天）')];
    const shareIndex = found.indexes[normalizeHeader('点击份额（过去 360 天）')];
    const conversionIndex = found.indexes[normalizeHeader('搜索转化率（过去 360 天）')];
    const extraIndexes = sourceHeaders.map(function (_, index) { return index; })
      .filter(function (index) { return index !== termIndex && index !== volumeIndex; });
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
        conversionRate: conversionRate,
        sourceValues: sourceHeaders.map(function (_, index) {
          return String(current[index] == null ? '' : current[index]);
        })
      });
    }

    if (!terms.length) fail('Search Term 表表头已识别，但没有找到搜索词数据行。');
    return {
      terms: terms,
      sourceHeaders: sourceHeaders,
      extraIndexes: extraIndexes
    };
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
    const searchData = parseSearchTermCsv(searchTermCsvText);
    const terms = searchData.terms;
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
        cvr: clicks > 0 ? orders / clicks : null,
        sourceValues: term.sourceValues
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
      searchTermHeaders: searchData.sourceHeaders,
      searchTermExtraIndexes: searchData.extraIndexes,
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

  function setCellStyle(sheet, XLSX, row, column, style) {
    const address = XLSX.utils.encode_cell
      ? XLSX.utils.encode_cell({ r: row, c: column })
      : columnName(column) + String(row + 1);
    if (!sheet[address]) sheet[address] = { t: 's', v: '' };
    sheet[address].s = style;
  }

  function buildWorkbook(niches, XLSX) {
    if (!XLSX || !XLSX.utils) fail('Excel 处理组件未加载，请刷新页面后重试。');
    if (!Array.isArray(niches) || !niches.length) fail('当前产品还没有 Niche 数据，无法导出。');

    const names = makeUniqueSheetNames(niches);
    const workbook = XLSX.utils.book_new();
    const palette = {
      navy: 'FF183B56',
      blue: 'FF2F5D83',
      teal: 'FF1D7180',
      slate: 'FF526A7D',
      pale: 'FFEAF1F7',
      paleValue: 'FFF5F8FB',
      row: 'FFFFFFFF',
      alternate: 'FFF5F8FB',
      calculated: 'FFF0F6FA',
      border: 'FFE1E8EF',
      white: 'FFFFFFFF',
      text: 'FF263B4D',
      muted: 'FF637B8F'
    };

    niches.forEach(function (niche, index) {
      const sourceHeaders = Array.isArray(niche.searchTermHeaders) ? niche.searchTermHeaders : [];
      const extraIndexes = Array.isArray(niche.searchTermExtraIndexes)
        ? niche.searchTermExtraIndexes
        : sourceHeaders.map(function (_, i) { return i; }).filter(function (i) { return i > 1; });
      const extraHeaders = extraIndexes.map(function (sourceIndex) {
        return sourceHeaders[sourceIndex] || ('原始 ST 字段 ' + (sourceIndex + 1));
      });
      const outputHeaders = [
        '搜索词',
        '搜索量（过去 360 天）',
        'CVR',
        'Clicks',
        'Orders%',
        'Orders'
      ].concat(extraHeaders);

      const aoa = [];
      aoa.push(['NICHE MARKET  |  ' + String(niche.name || '')]);
      aoa.push(['Search term performance  ·  Past 360 days']);
      aoa.push([]);
      aoa.push(['TOTAL CLICKS', '', 'TOTAL ORDERS', '', 'OVERALL CVR']);
      aoa.push([niche.totalClicks, '', niche.totalOrders, '', niche.overallCvr == null ? '' : niche.overallCvr]);
      aoa.push([]);
      aoa.push(outputHeaders);

      (niche.rows || []).forEach(function (row) {
        const originalValues = Array.isArray(row.sourceValues) ? row.sourceValues : [];
        const extraValues = extraIndexes.map(function (sourceIndex) {
          return rawExcelValue(originalValues[sourceIndex]);
        });
        aoa.push([
          row.term,
          row.searchVolume,
          row.cvr == null ? '' : row.cvr,
          row.clicks,
          row.ordersPct,
          row.orders
        ].concat(extraValues));
      });

      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const lastRow = 7 + (niche.rows || []).length;
      const lastColumnIndex = outputHeaders.length - 1;
      const lastColumn = columnName(lastColumnIndex);
      const merges = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumnIndex } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: lastColumnIndex } },
        { s: { r: 3, c: 0 }, e: { r: 3, c: 1 } },
        { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },
        { s: { r: 3, c: 2 }, e: { r: 3, c: 3 } },
        { s: { r: 4, c: 2 }, e: { r: 4, c: 3 } },
        { s: { r: 3, c: 4 }, e: { r: 3, c: 5 } },
        { s: { r: 4, c: 4 }, e: { r: 4, c: 5 } }
      ];
      sheet['!merges'] = merges;
      sheet['!cols'] = outputHeaders.map(function (header, columnIndex) {
        if (columnIndex === 0) return { wch: 36 };
        if (columnIndex === 1) return { wch: 19 };
        if (columnIndex === 2) return { wch: 13 };
        if (columnIndex === 3) return { wch: 16 };
        if (columnIndex === 4) return { wch: 13 };
        if (columnIndex === 5) return { wch: 16 };
        if (/标题/.test(header)) return { wch: 54 };
        if (/ASIN/i.test(header)) return { wch: 17 };
        if (/增长|份额|转化率|比率|百分比/.test(header)) return { wch: 21 };
        return { wch: Math.min(30, Math.max(18, String(header).length + 5)) };
      });
      sheet['!rows'] = [
        { hpt: 36 },
        { hpt: 23 },
        { hpt: 9 },
        { hpt: 21 },
        { hpt: 34 },
        { hpt: 10 },
        { hpt: 40 }
      ];
      for (let rowIndex = 0; rowIndex < (niche.rows || []).length; rowIndex += 1) {
        sheet['!rows'].push({ hpt: 34 });
      }
      sheet['!freeze'] = {
        xSplit: 2,
        ySplit: 7,
        topLeftCell: 'C8',
        activePane: 'bottomRight',
        state: 'frozen'
      };
      sheet['!autofilter'] = { ref: 'A7:' + lastColumn + lastRow };
      sheet['!views'] = [{ showGridLines: false, zoomScale: 85 }];
      sheet['!sheetPr'] = { tabColor: { rgb: 'FF2F7180' } };

      const thinBorder = {
        bottom: { style: 'thin', color: { rgb: palette.border } }
      };
      const titleStyle = {
        fill: { patternType: 'solid', fgColor: { rgb: palette.navy } },
        font: { name: 'Aptos Display', sz: 16, bold: true, color: { rgb: palette.white } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 }
      };
      const subtitleStyle = {
        fill: { patternType: 'solid', fgColor: { rgb: palette.pale } },
        font: { name: 'Aptos', sz: 10, italic: true, color: { rgb: palette.muted } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 }
      };
      const metricLabelStyle = {
        fill: { patternType: 'solid', fgColor: { rgb: palette.pale } },
        font: { name: 'Aptos', sz: 9, bold: true, color: { rgb: palette.muted } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 }
      };
      const metricValueStyle = {
        fill: { patternType: 'solid', fgColor: { rgb: palette.paleValue } },
        font: { name: 'Aptos Display', sz: 16, bold: true, color: { rgb: palette.navy } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
        border: thinBorder
      };

      for (let columnIndex = 0; columnIndex <= lastColumnIndex; columnIndex += 1) {
        setCellStyle(sheet, XLSX, 0, columnIndex, titleStyle);
        setCellStyle(sheet, XLSX, 1, columnIndex, subtitleStyle);
      }
      for (let columnIndex = 0; columnIndex <= 5; columnIndex += 1) {
        setCellStyle(sheet, XLSX, 3, columnIndex, metricLabelStyle);
        setCellStyle(sheet, XLSX, 4, columnIndex, metricValueStyle);
      }
      if (sheet.A5) sheet.A5.z = '#,##0';
      if (sheet.C5) sheet.C5.z = '#,##0.00';
      if (sheet.E5) sheet.E5.z = '0.00%';

      for (let columnIndex = 0; columnIndex <= lastColumnIndex; columnIndex += 1) {
        const headerFill = columnIndex < 2
          ? palette.teal
          : (columnIndex < 6 ? palette.blue : palette.slate);
        setCellStyle(sheet, XLSX, 6, columnIndex, {
          fill: { patternType: 'solid', fgColor: { rgb: headerFill } },
          font: { name: 'Aptos', sz: 10, bold: true, color: { rgb: palette.white } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: { bottom: { style: 'medium', color: { rgb: palette.navy } } }
        });
      }

      for (let dataIndex = 0; dataIndex < (niche.rows || []).length; dataIndex += 1) {
        const excelRow = 7 + dataIndex;
        const rowFill = dataIndex % 2 === 0 ? palette.row : palette.alternate;
        for (let columnIndex = 0; columnIndex <= lastColumnIndex; columnIndex += 1) {
          const isCalculated = columnIndex >= 2 && columnIndex <= 5;
          const fill = isCalculated ? palette.calculated : rowFill;
          const style = {
            fill: { patternType: 'solid', fgColor: { rgb: fill } },
            font: {
              name: 'Aptos',
              sz: 10,
              bold: isCalculated,
              color: { rgb: isCalculated ? palette.blue : palette.text }
            },
            alignment: {
              horizontal: columnIndex === 0 || (columnIndex >= 6 && typeof (sheet[columnName(columnIndex) + (excelRow + 1)] || {}).v === 'string')
                ? 'left'
                : 'right',
              vertical: 'center',
              wrapText: columnIndex >= 6 && /标题/.test(outputHeaders[columnIndex])
            },
            border: thinBorder
          };
          setCellStyle(sheet, XLSX, excelRow, columnIndex, style);
        }

        const rowNumber = excelRow + 1;
        const percentCell = sheet['C' + rowNumber];
        const clicksCell = sheet['D' + rowNumber];
        const orderShareCell = sheet['E' + rowNumber];
        const ordersCell = sheet['F' + rowNumber];
        const volumeCell = sheet['B' + rowNumber];
        if (percentCell && typeof percentCell.v === 'number') percentCell.z = '0.00%';
        if (clicksCell && typeof clicksCell.v === 'number') clicksCell.z = '#,##0.00';
        if (orderShareCell && typeof orderShareCell.v === 'number') orderShareCell.z = '0.00%';
        if (ordersCell && typeof ordersCell.v === 'number') ordersCell.z = '#,##0.00';
        if (volumeCell && typeof volumeCell.v === 'number') volumeCell.z = '#,##0';
      }

      XLSX.utils.book_append_sheet(workbook, sheet, names[index].sheetName);
    });

    workbook.Props = {
      Title: 'Niche Market Data',
      Subject: 'Search term performance and Niche market metrics',
      Author: 'Amazon Operations Workspace'
    };
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
