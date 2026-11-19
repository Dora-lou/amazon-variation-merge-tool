(function () {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  let currentData = null;
  let currentFile = null;

  function formatNumber(value, decimals) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('en-US', {
      maximumFractionDigits: decimals == null ? 0 : decimals,
      minimumFractionDigits: decimals == null ? 0 : decimals
    });
  }
  function formatPercent(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return (Number(value) * 100).toFixed(2) + '%';
  }
  function formatIndex(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Number(value).toFixed(2) + 'x';
  }
  function setStatus(message, type) {
    const el = $('status');
    el.textContent = message;
    el.className = 'status' + (type ? ' ' + type : '');
  }
  function createMetaChip(text) {
    const chip = document.createElement('span');
    chip.className = 'meta-chip';
    chip.textContent = text;
    return chip;
  }
  function renderMetadata(data) {
    const host = $('metadata');
    host.innerHTML = '';
    const m = data.metadata;
    [
      m.asin ? 'ASIN ' + m.asin : '',
      m.reportRange || '',
      m.year ? m.year + (m.quarter ? ' Q' + m.quarter : '') : '',
      data.rows.length + ' 个搜索查询',
      data.rows[0] && data.rows[0].reportDate ? '报告日期 ' + data.rows[0].reportDate : ''
    ].filter(Boolean).forEach(function (value) { host.appendChild(createMetaChip(value)); });
  }
  function renderKpis(data) {
    const a = data.aggregate;
    const cards = [
      ['搜索查询数', formatNumber(a.queryCount), '本份报告中的搜索词'],
      ['搜索查询量合计', formatNumber(a.searchVolume), '所含搜索词的查询量之和'],
      ['市场点击总量', formatNumber(a.clicks), '全部搜索词合计'],
      ['ASIN 点击份额', formatPercent(a.asinClickShare), 'ASIN 点击量 ÷ 市场点击量'],
      ['ASIN 购买份额', formatPercent(a.asinPurchaseShare), 'ASIN 购买量 ÷ 市场购买量']
    ];
    const host = $('kpis');
    host.innerHTML = '';
    cards.forEach(function (item) {
      const card = document.createElement('div');
      card.className = 'kpi';
      const label = document.createElement('span');
      label.textContent = item[0];
      const value = document.createElement('strong');
      value.textContent = item[1];
      const note = document.createElement('small');
      note.textContent = item[2];
      card.append(label, value, note);
      host.appendChild(card);
    });
  }
  function renderFunnel(data) {
    const a = data.aggregate;
    const stages = [
      { name: '曝光', market: a.impressions, asin: a.asinImpressions, share: a.asinImpressionShare, index: null },
      { name: '点击', market: a.clicks, asin: a.asinClicks, share: a.asinClickShare, index: a.asinImpressionShare ? a.asinClickShare / a.asinImpressionShare : null },
      { name: '加购', market: a.cartAdds, asin: a.asinCartAdds, share: a.asinCartShare, index: a.asinClickShare ? a.asinCartShare / a.asinClickShare : null },
      { name: '购买', market: a.purchases, asin: a.asinPurchases, share: a.asinPurchaseShare, index: a.asinCartShare ? a.asinPurchaseShare / a.asinCartShare : null }
    ];
    const host = $('funnel');
    host.innerHTML = '';
    stages.forEach(function (stage) {
      const card = document.createElement('div');
      card.className = 'funnel';
      const name = document.createElement('div');
      name.className = 'stage';
      name.textContent = stage.name;
      const total = document.createElement('strong');
      total.textContent = formatNumber(stage.market);
      const note = document.createElement('small');
      note.textContent = 'ASIN 数量 ' + formatNumber(stage.asin);
      const share = document.createElement('div');
      share.className = 'share';
      share.textContent = 'ASIN 份额 ' + formatPercent(stage.share);
      const index = document.createElement('small');
      index.textContent = stage.index == null ? '作为份额基准' : '相对上阶段 ' + formatIndex(stage.index);
      card.append(name, total, note, share, index);
      host.appendChild(card);
    });
  }
  function renderInsightList(hostId, rows, mode) {
    const host = $(hostId);
    host.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '15px 0';
      empty.textContent = mode === 'opportunity'
        ? '本报告未识别到符合当前规则的高需求低曝光词。'
        : '本报告未识别到阶段份额指数低于 0.80 的搜索词。';
      host.appendChild(empty);
      return;
    }
    rows.slice(0, 6).forEach(function (row) {
      const item = document.createElement('div');
      item.className = 'insight-item';
      const info = document.createElement('div');
      const query = document.createElement('strong');
      query.textContent = row.query;
      const note = document.createElement('small');
      note.textContent = '搜索量 ' + formatNumber(row.searchVolume) +
        ' · ASIN 曝光份额 ' + formatPercent(row.asinImpressionShareCalc);
      info.append(query, note);
      const tag = document.createElement('span');
      tag.className = 'tag' + (mode === 'weak' ? ' weak' : '');
      tag.textContent = mode === 'opportunity' ? row.opportunityLabel : row.funnelDiagnosis;
      item.append(info, tag);
      host.appendChild(item);
    });
  }
  function matchesFilter(row, filter) {
    if (!filter) return true;
    if (filter === '份额提升') return row.funnelDiagnosis.indexOf('份额提升') >= 0;
    return row.opportunityLabel === filter || row.funnelDiagnosis === filter;
  }
  function renderDetail() {
    if (!currentData) return;
    const query = $('queryFilter').value.trim().toLowerCase();
    const filter = $('diagnosisFilter').value;
    const filtered = currentData.rows.filter(function (row) {
      return (!query || row.query.toLowerCase().indexOf(query) >= 0) && matchesFilter(row, filter);
    });
    const shown = filtered.slice(0, 30);
    const body = $('detailBody');
    body.innerHTML = '';
    shown.forEach(function (row) {
      const tr = document.createElement('tr');
      const values = [
        row.query,
        formatNumber(row.searchVolume),
        row.opportunityLabel,
        row.funnelDiagnosis,
        formatPercent(row.asinImpressionShareCalc),
        formatPercent(row.asinClickShareCalc),
        formatPercent(row.asinCartShareCalc),
        formatPercent(row.asinPurchaseShareCalc)
      ];
      values.forEach(function (value, index) {
        const td = document.createElement('td');
        td.textContent = value;
        if (index === 0) td.className = 'query';
        if (index === 2 && row.opportunityLabel === '高需求·低曝光') {
          td.innerHTML = '';
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = value;
          td.appendChild(tag);
        }
        if (index === 3 && row.funnelDiagnosis.indexOf('流失') >= 0) {
          td.innerHTML = '';
          const tag = document.createElement('span');
          tag.className = 'tag weak';
          tag.textContent = value;
          td.appendChild(tag);
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    $('tableFooter').textContent = '当前筛选 ' + formatNumber(filtered.length) + ' 个搜索词；页面预览最多显示前 30 条。Excel 导出包含全部 ' + formatNumber(currentData.rows.length) + ' 条搜索词及完整原始字段。';
  }
  function render(data) {
    currentData = data;
    $('analysisArea').classList.remove('hidden');
    renderMetadata(data);
    renderKpis(data);
    renderFunnel(data);
    const opportunities = data.rows.filter(function (row) { return row.opportunityLabel === '高需求·低曝光'; });
    const weak = data.rows.filter(function (row) { return row.funnelDiagnosis.indexOf('份额流失') >= 0; });
    $('opportunityCount').textContent = opportunities.length + ' 个词';
    $('weakCount').textContent = weak.length + ' 个词';
    renderInsightList('opportunityList', opportunities, 'opportunity');
    renderInsightList('weakList', weak, 'weak');
    $('queryFilter').value = '';
    $('diagnosisFilter').value = '';
    renderDetail();
    $('downloadBtn').disabled = false;
  }
  $('sqrFile').addEventListener('change', function () {
    currentFile = this.files && this.files[0] ? this.files[0] : null;
    $('analyzeBtn').disabled = !currentFile;
    $('downloadBtn').disabled = true;
    $('fileName').textContent = currentFile ? currentFile.name : '尚未选择文件';
    if (currentFile) setStatus('已选择文件。点击「解析并分析」开始处理。');
  });
  $('analyzeBtn').addEventListener('click', async function () {
    if (!currentFile) return;
    const button = this;
    button.disabled = true;
    setStatus('正在读取并计算 SQR 数据…');
    try {
      const text = await currentFile.text();
      const data = window.SqrEngine.processCsv(text);
      render(data);
      const meta = data.metadata.asin ? 'ASIN ' + data.metadata.asin + ' · ' : '';
      setStatus(meta + '成功识别 ' + data.rows.length + ' 个搜索查询和 ' + data.headers.length + ' 个原始字段。可以查看分析结果或下载 Excel。', 'success');
    } catch (error) {
      currentData = null;
      $('analysisArea').classList.add('hidden');
      $('downloadBtn').disabled = true;
      setStatus(error && error.message ? error.message : '解析失败，请检查文件格式。', 'error');
    } finally {
      button.disabled = !currentFile;
    }
  });
  $('downloadBtn').addEventListener('click', function () {
    if (!currentData) return;
    try {
      const workbook = window.SqrEngine.buildWorkbook(currentData, window.XLSX);
      const asin = currentData.metadata.asin || 'SQR';
      const period = currentData.metadata.year
        ? '_' + currentData.metadata.year + (currentData.metadata.quarter ? 'Q' + currentData.metadata.quarter : '')
        : '';
      window.XLSX.writeFile(workbook, asin + '_SQR分析' + period + '.xlsx');
      setStatus('Excel 工作簿已生成，包含 SQR 总览、搜索词分析和原始数据三个 Sheet。', 'success');
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Excel 导出失败，请重试。', 'error');
    }
  });
  $('queryFilter').addEventListener('input', renderDetail);
  $('diagnosisFilter').addEventListener('change', renderDetail);
  $('resetFilters').addEventListener('click', function () {
    $('queryFilter').value = '';
    $('diagnosisFilter').value = '';
    renderDetail();
  });
}());
