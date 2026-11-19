/* Standalone Amazon Search Query Performance (SQR) analysis engine. */
(function (root) {
  'use strict';
  function fail(message) { throw new Error(message); }
  function normalizeHeader(value) {
    return String(value == null ? '' : value).normalize('NFKC').replace(/^\uFEFF/, '')
      .replace(/[\s_\-./（）()：:％%]+/g, '').toLowerCase().trim();
  }
  function parseCsv(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const rows = []; let row = []; let field = ''; let quoted = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '"') {
        if (quoted && source[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
      else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(field);
        if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
        row = []; field = '';
      } else field += ch;
    }
    if (quoted) fail('CSV 文件存在未闭合的双引号，请重新从亚马逊后台下载。');
    row.push(field);
    if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
    if (!rows.length) fail('CSV 文件为空。');
    return rows;
  }
  function parseMetadata(line) {
    const text = String(line || '');
    function get(key) {
      const match = text.match(new RegExp(key + '\\s*=\\s*\\[([^\\]]*)\\]'));
      return match ? match[1].replace(/^["']|["']$/g, '').trim() : '';
    }
    return {
      asin: get('ASIN'), reportRange: get('报告范围'),
      year: get('选择年份'), quarter: get('选择季度'), raw: text
    };
  }
  const REQUIRED = [
    '搜索查询','搜索查询得分','搜索查询量','曝光：曝光总量','曝光量：ASIN 计数',
    '点击量：总次数','点击量：ASIN 数量','购物车添加：总数','加购：ASIN 数量',
    '购买：下单总数','下单成交：ASIN 数量','报告日期'
  ];
  const FIELD_ALIASES = {
    query:['搜索查询'], score:['搜索查询得分'], searchVolume:['搜索查询量'],
    impressions:['曝光：曝光总量'], asinImpressions:['曝光量：ASIN 计数'],
    asinImpressionShare:['曝光：ASIN 曝光占比 %'], clicks:['点击量：总次数'],
    clickRate:['点击量：点击率 %'], asinClicks:['点击量：ASIN 数量'],
    asinClickShare:['点击量：ASIN 份额 %'], cartAdds:['购物车添加：总数'],
    cartAddRate:['加入购物车：加购率%'], asinCartAdds:['加购：ASIN 数量'],
    asinCartShare:['加入购物车：ASIN 加购占比 %'], purchases:['购买：下单总数'],
    purchaseRate:['下单成交：成交转化率%'], asinPurchases:['下单成交：ASIN 数量'],
    asinPurchaseShare:['下单: ASIN 占比 %'], reportDate:['报告日期']
  };
  function parseNumber(value) {
    const raw = String(value == null ? '' : value).trim().replace(/,/g, '');
    if (!raw || raw === '-' || raw === '—') return 0;
    const n = Number(raw.replace(/^['’]/, ''));
    return Number.isFinite(n) ? n : 0;
  }
  function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = values.slice().sort(function (a,b) { return a-b; });
    const pos = (sorted.length - 1) * fraction, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function safeDivide(a,b) { return b > 0 ? a / b : null; }
  function readValue(row, indexes, key) {
    const value = row[indexes[key]];
    return key === 'query' || key === 'reportDate'
      ? String(value == null ? '' : value).trim() : parseNumber(value);
  }
  function classifyQuery(query) {
    const q = String(query || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    const hasDog = /\bdog\b/.test(q);
    const hasCat = /\bcat\b/.test(q);
    const hasBowl = /\b(bowl|bowls|dish|dishes)\b/.test(q);
    const hasBottle = /\bbottles?\b/.test(q);
    const hasCollapse = /\b(collapsible|collapsable|foldable|folding|collapsing|collapse|pop up)\b/.test(q);
    const hasScene = /\b(travel|portable|hiking|hike|camping|camp|beach|walking|walks|on the go)\b/.test(q);
    const hasBroad = /\b(accessories|necessities|essentials|gear)\b/.test(q);
    const modifiers = [];
    if (hasCollapse) modifiers.push('折叠/收纳');
    if (hasScene) modifiers.push('便携/外出场景');
    if (hasBottle) modifiers.push('饮水瓶形态');
    if (/\b(silicone|stainless|steel|plastic|rubber)\b/.test(q)) modifiers.push('材质');
    if (/\b(small|medium|large|mini)\b/.test(q)) modifiers.push('尺寸');
    if (hasCat) modifiers.push('猫用品');
    let queryCategory = '泛词/需人工确认';
    let relevanceLevel = '低相关/需确认';
    let relevanceScore = 25;
    if (hasCat) {
      queryCategory = '跨品类：猫用品'; relevanceLevel = '跨品类/需确认'; relevanceScore = 30;
    } else if (hasBottle) {
      queryCategory = '相邻形态：饮水瓶'; relevanceLevel = '相邻形态/需确认'; relevanceScore = 45;
    } else if (hasBroad) {
      queryCategory = '泛场景/周边词'; relevanceLevel = '低相关/需确认'; relevanceScore = 20;
    } else if (hasCollapse && hasBowl) {
      queryCategory = '核心功能词：折叠碗'; relevanceLevel = '高相关'; relevanceScore = 100;
    } else if (hasDog && hasBowl && hasScene) {
      queryCategory = '使用场景词：外出/旅行'; relevanceLevel = '高相关'; relevanceScore = 85;
    } else if (hasDog && hasBowl) {
      queryCategory = '品类词：狗碗/水碗'; relevanceLevel = '中高相关'; relevanceScore = 70;
    } else if (hasBowl && hasScene) {
      queryCategory = '使用场景词：外出/旅行'; relevanceLevel = '中相关'; relevanceScore = 60;
    } else if (hasBowl) {
      queryCategory = '碗类相关词'; relevanceLevel = '中相关'; relevanceScore = 55;
    } else if (hasDog && hasScene) {
      queryCategory = '犬类外出场景词'; relevanceLevel = '需确认'; relevanceScore = 45;
    }
    if (!modifiers.length) modifiers.push('基础品类/泛词');
    return {
      queryCategory: queryCategory,
      relevanceLevel: relevanceLevel,
      relevanceScore: relevanceScore,
      queryModifiers: modifiers
    };
  }
  function buildQueryGroups(rows) {
    const groups = {};
    const totalSearchVolume = rows.reduce(function (sum,row) { return sum + (row.searchVolume || 0); }, 0);
    const totalAsinPurchases = rows.reduce(function (sum,row) { return sum + (row.asinPurchases || 0); }, 0);
    rows.forEach(function (row) {
      const key = row.queryCategory;
      if (!groups[key]) groups[key] = {
        queryCategory: key, queryCount: 0, searchVolume: 0,
        impressions: 0, asinImpressions: 0, clicks: 0, asinClicks: 0,
        cartAdds: 0, asinCartAdds: 0, purchases: 0, asinPurchases: 0
      };
      const group = groups[key];
      group.queryCount += 1;
      ['searchVolume','impressions','asinImpressions','clicks','asinClicks','cartAdds','asinCartAdds','purchases','asinPurchases']
        .forEach(function (keyName) { group[keyName] += row[keyName] || 0; });
    });
    return Object.keys(groups).map(function (key) {
      const group = groups[key];
      group.asinImpressionShare = safeDivide(group.asinImpressions, group.impressions);
      group.asinClickShare = safeDivide(group.asinClicks, group.clicks);
      group.asinCartShare = safeDivide(group.asinCartAdds, group.cartAdds);
      group.asinPurchaseShare = safeDivide(group.asinPurchases, group.purchases);
      group.searchVolumeContribution = safeDivide(group.searchVolume, totalSearchVolume);
      group.asinPurchaseContribution = safeDivide(group.asinPurchases, totalAsinPurchases);
      group.asinClickToPurchaseRate = safeDivide(group.asinPurchases, group.asinClicks);
      group.asinClickToCartRate = safeDivide(group.asinCartAdds, group.asinClicks);
      return group;
    }).sort(function (a,b) { return b.asinPurchases-a.asinPurchases; });
  }
  function processCsv(text) {
    const sourceRows = parseCsv(text);
    let headerIndex = -1;
    const requiredKeys = REQUIRED.map(normalizeHeader);
    for (let i = 0; i < Math.min(sourceRows.length, 20); i += 1) {
      const normalized = (sourceRows[i] || []).map(normalizeHeader);
      if (requiredKeys.every(function (key) { return normalized.indexOf(key) >= 0; })) {
        headerIndex = i; break;
      }
    }
    if (headerIndex < 0) fail('未找到 SQR 表头。请上传亚马逊后台导出的原始 Search Query Performance CSV。');
    const headers = (sourceRows[headerIndex] || []).map(function (v) { return String(v == null ? '' : v).trim(); });
    const normalizedHeaders = headers.map(normalizeHeader);
    const indexes = {};
    Object.keys(FIELD_ALIASES).forEach(function (key) {
      const aliases = FIELD_ALIASES[key].map(normalizeHeader);
      indexes[key] = normalizedHeaders.findIndex(function (header) { return aliases.indexOf(header) >= 0; });
    });
    const missing = REQUIRED.filter(function (header) { return normalizedHeaders.indexOf(normalizeHeader(header)) < 0; });
    if (missing.length) fail('SQR 表缺少必要字段：' + missing.join('、'));
    const metadata = parseMetadata((sourceRows[0] || []).join(','));
    const rows = [];
    for (let i = headerIndex + 1; i < sourceRows.length; i += 1) {
      const source = sourceRows[i] || [];
      const query = readValue(source, indexes, 'query');
      if (!query) continue;
      const item = { sourceValues: headers.map(function (_, j) { return String(source[j] == null ? '' : source[j]); }) };
      Object.keys(indexes).forEach(function (key) { if (indexes[key] >= 0) item[key] = readValue(source, indexes, key); });
      rows.push(item);
    }
    if (!rows.length) fail('已识别 SQR 表头，但没有找到搜索查询数据。');
    const totals = rows.reduce(function (sum, row) {
      ['searchVolume','impressions','asinImpressions','clicks','asinClicks','cartAdds','asinCartAdds','purchases','asinPurchases']
        .forEach(function (key) { sum[key] += row[key] || 0; });
      return sum;
    }, {searchVolume:0,impressions:0,asinImpressions:0,clicks:0,asinClicks:0,cartAdds:0,asinCartAdds:0,purchases:0,asinPurchases:0});
    const aggregate = Object.assign({queryCount:rows.length}, totals, {
      marketClickRate:safeDivide(totals.clicks,totals.searchVolume),
      marketCartAddRate:safeDivide(totals.cartAdds,totals.searchVolume),
      marketPurchaseRate:safeDivide(totals.purchases,totals.searchVolume),
      asinImpressionShare:safeDivide(totals.asinImpressions,totals.impressions),
      asinClickShare:safeDivide(totals.asinClicks,totals.clicks),
      asinCartShare:safeDivide(totals.asinCartAdds,totals.cartAdds),
      asinPurchaseShare:safeDivide(totals.asinPurchases,totals.purchases),
      asinCtr:safeDivide(totals.asinClicks,totals.asinImpressions),
      asinClickToCartRate:safeDivide(totals.asinCartAdds,totals.asinClicks),
      asinClickToPurchaseRate:safeDivide(totals.asinPurchases,totals.asinClicks),
      asinCartToPurchaseRate:safeDivide(totals.asinPurchases,totals.asinCartAdds)
    });
    const highVolumeThreshold = percentile(rows.map(function (r) { return r.searchVolume || 0; }), 0.75);
    rows.forEach(function (row) {
      row.asinImpressionShareCalc = safeDivide(row.asinImpressions,row.impressions);
      row.asinClickShareCalc = safeDivide(row.asinClicks,row.clicks);
      row.asinCartShareCalc = safeDivide(row.asinCartAdds,row.cartAdds);
      row.asinPurchaseShareCalc = safeDivide(row.asinPurchases,row.purchases);
      row.exposureToClickIndex = safeDivide(row.asinClickShareCalc,row.asinImpressionShareCalc);
      row.clickToCartIndex = safeDivide(row.asinCartShareCalc,row.asinClickShareCalc);
      row.cartToPurchaseIndex = safeDivide(row.asinPurchaseShareCalc,row.asinCartShareCalc);
      row.asinCtr = safeDivide(row.asinClicks,row.asinImpressions);
      row.asinClickToCartRate = safeDivide(row.asinCartAdds,row.asinClicks);
      row.asinClickToPurchaseRate = safeDivide(row.asinPurchases,row.asinClicks);
      row.asinCartToPurchaseRate = safeDivide(row.asinPurchases,row.asinCartAdds);
      row.highVolume = (row.searchVolume || 0) >= highVolumeThreshold;
      row.opportunityLabel = row.highVolume && row.asinImpressionShareCalc !== null &&
        aggregate.asinImpressionShare !== null && row.asinImpressionShareCalc < aggregate.asinImpressionShare
        ? '高需求·低曝光' : (row.highVolume ? '高搜索量' : '常规搜索量');
      const stages = [
        {key:'exposureToClickIndex',label:'曝光→点击份额流失'},
        {key:'clickToCartIndex',label:'点击→加购份额流失'},
        {key:'cartToPurchaseIndex',label:'加购→购买份额流失'}
      ];
      const weak = stages.map(function (s) { return {label:s.label,value:row[s.key]}; })
        .filter(function (s) { return s.value !== null && s.value < 0.8; })
        .sort(function (a,b) { return a.value-b.value; });
      const strong = stages.map(function (s) { return {label:s.label.replace('份额流失','份额提升'),value:row[s.key]}; })
        .filter(function (s) { return s.value !== null && s.value > 1.2; })
        .sort(function (a,b) { return b.value-a.value; });
      row.funnelDiagnosis = weak.length ? weak[0].label : (strong.length ? strong[0].label : '份额表现相对稳定');
      row.funnelIssues = weak.map(function (stage) { return stage.label; });
      row.funnelStrengths = strong.map(function (stage) { return stage.label; });
      const classification = classifyQuery(row.query);
      row.queryCategory = classification.queryCategory;
      row.relevanceLevel = classification.relevanceLevel;
      row.relevanceScore = classification.relevanceScore;
      row.queryModifiers = classification.queryModifiers;
      row.sampleLabel = row.asinClicks < 20 ? '小样本（ASIN点击<20）' : (row.asinClicks < 50 ? '中样本（ASIN点击20–49）' : '样本相对充足（ASIN点击≥50）');
      const isRelevant = row.relevanceScore >= 55;
      if (row.opportunityLabel === '高需求·低曝光' && isRelevant) row.actionPriority = '高需求流量缺口';
      else if (row.relevanceScore <= 30) row.actionPriority = '先核实相关性';
      else if (row.relevanceScore <= 45) row.actionPriority = '核实形态匹配';
      else if (isRelevant && row.asinPurchases >= 20) row.actionPriority = '核心成交词';
      else if (isRelevant && weak.length) row.actionPriority = '转化待优化';
      else row.actionPriority = '持续观察';
      if (row.relevanceScore <= 30) row.recommendation = '该词偏向泛场景或跨品类搜索，先核对产品是否真正满足该搜索意图，不建议仅因搜索量高就直接扩量。';
      else if (row.relevanceScore <= 45) row.recommendation = '该词涉及相邻产品形态或需要进一步确认，先核实商品功能是否与搜索意图一致，再决定是否纳入关键词投放。';
      else if (row.opportunityLabel === '高需求·低曝光') row.recommendation = '搜索需求较高但 ASIN 曝光份额低。确认产品相关性后，检查 Listing 关键词覆盖、广告覆盖和自然位置，再考虑小预算测试。';
      else if (row.relevanceScore >= 70 && row.asinPurchases >= 20) row.recommendation = '该词已有较强 ASIN 成交信号，优先保护有效的 Listing 与广告覆盖；是否增投仍需结合 CPC、ACOS、TACOS 和利润判断。';
      else if (row.funnelDiagnosis === '曝光→点击份额流失') row.recommendation = 'ASIN 曝光份额未有效转化为点击。检查搜索结果页主图、标题、价格、评分和优惠；同时确认搜索词与商品是否足够匹配。';
      else if (row.funnelDiagnosis === '点击→加购份额流失') row.recommendation = 'ASIN 点击份额未充分转化为加购。检查详情页卖点、产品适配、尺寸/材质表达和到手价，判断用户是否在页面阶段流失。';
      else if (row.funnelDiagnosis === '加购→购买份额流失') row.recommendation = 'ASIN 加购份额未充分转化为购买。检查到手价、配送时效、库存和购买限制，排查结账前流失。';
      else if (row.funnelIssues.length) row.recommendation = '该词存在多个阶段份额下降，优先排查：' + row.funnelIssues.join('、') + '。先确认相关性和样本量，再决定优化动作。';
      else if (row.funnelDiagnosis.indexOf('份额提升') >= 0) row.recommendation = '该阶段 ASIN 份额相对上一个阶段有所提升，可继续观察并保持有效做法；投放决策仍需结合广告成本。';
      else row.recommendation = '暂未发现明显的份额断层，结合相关性、利润、广告花费和自然排名决定后续投入。';
    });
    const rawRows = rows.slice();
    rows.sort(function (a,b) { return (b.searchVolume-a.searchVolume) || String(a.query).localeCompare(String(b.query)); });
    const queryGroups = buildQueryGroups(rows);
    const coreConvertingTerms = rows.filter(function (row) {
      return row.relevanceScore >= 70 && row.asinPurchases > 0;
    }).sort(function (a,b) { return b.asinPurchases-a.asinPurchases; }).slice(0,20);
    const relevantOpportunities = rows.filter(function (row) {
      return row.opportunityLabel === '高需求·低曝光' && row.relevanceScore >= 55;
    }).sort(function (a,b) { return (b.relevanceScore-a.relevanceScore) || (b.searchVolume-a.searchVolume); });
    return {metadata:metadata,headers:headers,rows:rows,rawRows:rawRows,aggregate:aggregate,
      highVolumeThreshold:highVolumeThreshold,queryGroups:queryGroups,
      coreConvertingTerms:coreConvertingTerms,relevantOpportunities:relevantOpportunities,
      sourceRowCount:rows.length,sourceHeaderRow:headerIndex+1};
  }
  function excelValue(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number') return value;
    const raw = String(value).trim();
    if (!raw) return '';
    const cleaned = raw.replace(/^['’]/,'').replace(/,/g,'');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) {
      const n = Number(cleaned); if (Number.isFinite(n)) return n;
    }
    return raw;
  }
  function colName(index) {
    let name='', value=index+1;
    while (value>0) { const r=(value-1)%26; name=String.fromCharCode(65+r)+name; value=Math.floor((value-1)/26); }
    return name;
  }
  function setStyle(sheet,XLSX,row,column,style) {
    const address=XLSX.utils.encode_cell({r:row,c:column});
    if (!sheet[address]) sheet[address]={t:'s',v:''};
    sheet[address].s=style;
  }
  function buildWorkbook(data,XLSX) {
    if (!XLSX || !XLSX.utils) fail('Excel 处理组件未加载，请刷新页面后重试。');
    const workbook=XLSX.utils.book_new(), rows=data.rows, a=data.aggregate;
    const p={navy:'FF183B56',blue:'FF2F5D83',teal:'FF1D7180',pale:'FFEAF1F7',pale2:'FFF5F8FB',green:'FFE6F3EA',greenText:'FF236B48',amber:'FFFFF2D9',amberText:'FF8A5A12',red:'FFFCE9EA',redText:'FF9A3942',white:'FFFFFFFF',text:'FF263B4D',muted:'FF637B8F',border:'FFE1E8EF'};
    const metaText=[data.metadata.asin?'ASIN: '+data.metadata.asin:'',data.metadata.reportRange?'报告范围: '+data.metadata.reportRange:'',data.metadata.year?'年份: '+data.metadata.year:'',data.metadata.quarter?'季度: Q'+data.metadata.quarter:''].filter(Boolean).join('  |  ');
    const opportunities=rows.filter(function(r){return r.opportunityLabel==='高需求·低曝光';})
      .sort(function(a,b){return (b.relevanceScore-a.relevanceScore)||(b.searchVolume-a.searchVolume);}).slice(0,20);
    const weakRows=rows.filter(function(r){return r.funnelIssues && r.funnelIssues.length;})
      .sort(function(a,b){return (b.relevanceScore-a.relevanceScore)||(b.searchVolume-a.searchVolume);}).slice(0,20);
    const coreSalesRows=(data.coreConvertingTerms||[]).slice(0,15);
    const overview=[
      ['SQR SEARCH QUERY PERFORMANCE'],[metaText||'Amazon Search Query Performance Report'],
      ['搜索查询数',a.queryCount,'搜索查询量合计',a.searchVolume,'ASIN',data.metadata.asin||''],
      ['市场曝光总量',a.impressions,'市场点击总量',a.clicks,'ASIN 点击量',a.asinClicks],
      ['市场加购总量',a.cartAdds,'ASIN 加购量',a.asinCartAdds,'市场购买总量',a.purchases],
      ['ASIN 购买量',a.asinPurchases,'高搜索量阈值（P75）',data.highVolumeThreshold,'报告日期',rows[0]?rows[0].reportDate:''],
      [],
      ['搜索漏斗','市场总量','ASIN 数量','ASIN 份额','阶段份额指数'],
      ['曝光',a.impressions,a.asinImpressions,a.asinImpressionShare,'—'],
      ['点击',a.clicks,a.asinClicks,a.asinClickShare,safeDivide(a.asinClickShare,a.asinImpressionShare)],
      ['加购',a.cartAdds,a.asinCartAdds,a.asinCartShare,safeDivide(a.asinCartShare,a.asinClickShare)],
      ['购买',a.purchases,a.asinPurchases,a.asinPurchaseShare,safeDivide(a.asinPurchaseShare,a.asinCartShare)],
      [],
      ['搜索量加权市场率','比率'],
      ['点击量 / 搜索查询量',a.marketClickRate],
      ['加购量 / 搜索查询量',a.marketCartAddRate],
      ['购买量 / 搜索查询量',a.marketPurchaseRate],
      ['ASIN 点击 / ASIN 曝光',a.asinCtr],
      ['ASIN 加购 / ASIN 点击',a.asinClickToCartRate],
      ['ASIN 购买 / ASIN 点击',a.asinClickToPurchaseRate],
      ['ASIN 购买 / ASIN 加购',a.asinCartToPurchaseRate],
      [],
      ['重点机会词（高搜索量且 ASIN 曝光份额低于本报告加权水平）'],
      ['搜索查询','搜索查询量','相关性预判','ASIN 曝光份额','ASIN 购买量','行动优先级']
    ];
    opportunities.forEach(function(r){overview.push([r.query,r.searchVolume,r.relevanceLevel,r.asinImpressionShareCalc,r.asinPurchases,r.actionPriority]);});
    if(!opportunities.length) overview.push(['本报告未识别到符合当前规则的高需求低曝光词。']);
    overview.push([]);
    const weakSectionRow = overview.length;
    overview.push(['份额流失词（阶段份额指数低于 0.80）']);
    const weakHeaderRow = overview.length;
    overview.push(['搜索查询','搜索查询量','曝光→点击指数','点击→加购指数','加购→购买指数','主要诊断']);
    weakRows.forEach(function(r){overview.push([r.query,r.searchVolume,r.exposureToClickIndex,r.clickToCartIndex,r.cartToPurchaseIndex,r.funnelIssues.join('；')]);});
    if(!weakRows.length) overview.push(['本报告未识别到阶段份额指数低于 0.80 的搜索词。']);
    overview.push([]);
    const coreSectionRow=overview.length;
    overview.push(['核心成交词（高/中高相关，按 ASIN 购买量排序）']);
    const coreHeaderRow=overview.length;
    overview.push(['搜索查询','搜索查询量','ASIN 点击量','ASIN 加购量','ASIN 购买量','ASIN 购买份额']);
    coreSalesRows.forEach(function(r){overview.push([r.query,r.searchVolume,r.asinClicks,r.asinCartAdds,r.asinPurchases,r.asinPurchaseShareCalc]);});
    if(!coreSalesRows.length) overview.push(['本报告未识别到有 ASIN 购买记录的高相关搜索词。']);
    const overviewSheet=XLSX.utils.aoa_to_sheet(overview);
    overviewSheet['!merges']=[{s:{r:0,c:0},e:{r:0,c:5}},{s:{r:1,c:0},e:{r:1,c:5}}];
    overviewSheet['!cols']=[{wch:38},{wch:20},{wch:19},{wch:19},{wch:23},{wch:62}];
    overviewSheet['!views']=[{showGridLines:false,zoomScale:90}];
    overviewSheet['!freeze']={xSplit:0,ySplit:8,topLeftCell:'A9',activePane:'bottomLeft',state:'frozen'};
    overviewSheet['!sheetPr']={tabColor:{rgb:p.teal}};
    for(let c=0;c<6;c+=1){
      setStyle(overviewSheet,XLSX,0,c,{fill:{patternType:'solid',fgColor:{rgb:p.navy}},font:{name:'Aptos Display',sz:16,bold:true,color:{rgb:p.white}},alignment:{vertical:'center',horizontal:'left',indent:1}});
      setStyle(overviewSheet,XLSX,1,c,{fill:{patternType:'solid',fgColor:{rgb:p.pale}},font:{name:'Aptos',sz:10,italic:true,color:{rgb:p.muted}},alignment:{vertical:'center',horizontal:'left',indent:1}});
    }
    const sectionRows=[7,13,22,weakSectionRow];
    const tableHeaderRows=[23,weakHeaderRow,coreHeaderRow];
    for(let r=2;r<=5;r+=1){
      for(let c=0;c<6;c+=1){
        const isLabel=c%2===0;
        setStyle(overviewSheet,XLSX,r,c,{
          fill:{patternType:'solid',fgColor:{rgb:isLabel?p.pale:p.pale2}},
          font:{name:'Aptos',sz:isLabel?9:11,bold:isLabel||c===1||c===3||c===5,color:{rgb:isLabel?p.muted:p.navy}},
          alignment:{vertical:'center',horizontal:'left',indent:isLabel?1:0}
        });
      }
    }
    for(let r=0;r<overview.length;r+=1){
      const first=String((overview[r]||[])[0]||'');
      const isSection=['搜索漏斗','搜索量加权市场率','重点机会词（高搜索量且 ASIN 曝光份额低于本报告加权水平）','份额流失词（阶段份额指数低于 0.80）','核心成交词（高/中高相关，按 ASIN 购买量排序）'].indexOf(first)>=0;
      const isHeader=tableHeaderRows.indexOf(r)>=0;
      if(isSection||isHeader) for(let c=0;c<6;c+=1) setStyle(overviewSheet,XLSX,r,c,{
        fill:{patternType:'solid',fgColor:{rgb:isSection?p.blue:p.teal}},
        font:{name:'Aptos',sz:10,bold:true,color:{rgb:p.white}},
        alignment:{vertical:'center',wrapText:true}
      });
    }
    for(let r=8;r<=11;r+=1) for(let c=0;c<=4;c+=1) setStyle(overviewSheet,XLSX,r,c,{
      fill:{patternType:'solid',fgColor:{rgb:p.pale2}},font:{name:'Aptos',sz:10,color:{rgb:p.text}}});
    ['D9','D10','D11','D12'].forEach(function(address){if(overviewSheet[address]&&typeof overviewSheet[address].v==='number')overviewSheet[address].z='0.00%';});
    ['E10','E11','E12'].forEach(function(address){if(overviewSheet[address]&&typeof overviewSheet[address].v==='number')overviewSheet[address].z='0.00\"x\"';});
    opportunities.forEach(function(_,i){const cell=overviewSheet['D'+(25+i)];if(cell&&typeof cell.v==='number')cell.z='0.00%';});
    weakRows.forEach(function(_,i){['C','D','E'].forEach(function(col){const cell=overviewSheet[col+(weakHeaderRow+2+i)];if(cell&&typeof cell.v==='number')cell.z='0.00"x"';});});
    coreSalesRows.forEach(function(_,i){const cell=overviewSheet['F'+(coreHeaderRow+2+i)];if(cell&&typeof cell.v==='number')cell.z='0.00%';});
    XLSX.utils.book_append_sheet(workbook,overviewSheet,'SQR总览');

    const derivedHeaders=['搜索词类型','相关性预判','修饰意图','行动优先级','样本提示','机会标签','漏斗诊断','全部漏斗问题','建议方向','ASIN曝光份额（计算）','ASIN点击份额（计算）','ASIN加购份额（计算）','ASIN购买份额（计算）','曝光→点击份额指数','点击→加购份额指数','加购→购买份额指数','ASIN点击率（ASIN点击/ASIN曝光）','ASIN点击后加购率','ASIN点击后购买率','ASIN加购后购买率'];
    const queryIndex=data.headers.findIndex(function(h){return normalizeHeader(h)===normalizeHeader('搜索查询');});
    const volumeIndex=data.headers.findIndex(function(h){return normalizeHeader(h)===normalizeHeader('搜索查询量');});
    const remainingIndexes=data.headers.map(function(_,i){return i;}).filter(function(i){return i!==queryIndex&&i!==volumeIndex;});
    const analysisHeaders=['搜索查询','搜索查询量'].concat(derivedHeaders).concat(remainingIndexes.map(function(i){return data.headers[i];}));
    const analysisAoa=[analysisHeaders];
    rows.forEach(function(r){
      const values=[r.query,r.searchVolume,r.queryCategory,r.relevanceLevel,r.queryModifiers.join('、'),r.actionPriority,r.sampleLabel,r.opportunityLabel,r.funnelDiagnosis,(r.funnelIssues||[]).join('；'),r.recommendation,r.asinImpressionShareCalc,r.asinClickShareCalc,r.asinCartShareCalc,r.asinPurchaseShareCalc,r.exposureToClickIndex,r.clickToCartIndex,r.cartToPurchaseIndex,r.asinCtr,r.asinClickToCartRate,r.asinClickToPurchaseRate,r.asinCartToPurchaseRate];
      remainingIndexes.forEach(function(i){values.push(excelValue(r.sourceValues[i]));});
      analysisAoa.push(values);
    });
    const analysisSheet=XLSX.utils.aoa_to_sheet(analysisAoa);
    analysisSheet['!cols']=analysisHeaders.map(function(h,i){
      if(i===0)return{wch:38};if(i===1)return{wch:18};if(h==='建议方向')return{wch:62};
      if(h==='修饰意图'||h==='全部漏斗问题')return{wch:32};
      if(h==='漏斗诊断'||h==='机会标签'||h==='行动优先级'||h==='搜索词类型'||h==='相关性预判'||h==='样本提示')return{wch:24};if(/标题/.test(h))return{wch:48};
      if(/ASIN/.test(h))return{wch:18};return{wch:Math.min(25,Math.max(14,String(h).length+3))};
    });
    analysisSheet['!freeze']={xSplit:2,ySplit:1,topLeftCell:'C2',activePane:'bottomRight',state:'frozen'};
    analysisSheet['!autofilter']={ref:'A1:'+colName(analysisHeaders.length-1)+analysisAoa.length};
    analysisSheet['!views']=[{showGridLines:false,zoomScale:80}];
    analysisSheet['!sheetPr']={tabColor:{rgb:p.blue}};
    for(let c=0;c<analysisHeaders.length;c+=1)setStyle(analysisSheet,XLSX,0,c,{
      fill:{patternType:'solid',fgColor:{rgb:c<2?p.teal:(c<22?p.blue:p.muted)}},
      font:{name:'Aptos',sz:10,bold:true,color:{rgb:p.white}},
      alignment:{vertical:'center',horizontal:'center',wrapText:true}});
    for(let r=1;r<analysisAoa.length;r+=1){
      const fill=r%2?p.white:p.pale2;
      for(let c=0;c<analysisHeaders.length;c+=1){
        const address=colName(c)+(r+1),v=analysisSheet[address]?analysisSheet[address].v:'';
        let color=p.text,bold=false;
        if(c===5&&String(v).indexOf('高需求')>=0){color=p.amberText;bold=true;}
        if(c===8&&String(v).indexOf('流失')>=0){color=p.redText;bold=true;}
        if(c===8&&String(v).indexOf('提升')>=0){color=p.greenText;bold=true;}
        if(c===5&&String(v).indexOf('核实')>=0){color=p.amberText;bold=true;}
        setStyle(analysisSheet,XLSX,r,c,{fill:{patternType:'solid',fgColor:{rgb:fill}},font:{name:'Aptos',sz:9,bold:bold,color:color},alignment:{vertical:'center',wrapText:c>=2&&c<=10||/标题/.test(analysisHeaders[c])}});
      }
      [11,12,13,14,18,19,20,21].forEach(function(c){const cell=analysisSheet[colName(c)+(r+1)];if(cell&&typeof cell.v==='number')cell.z='0.00%';});
      [15,16,17].forEach(function(c){const cell=analysisSheet[colName(c)+(r+1)];if(cell&&typeof cell.v==='number')cell.z='0.00"x"';});
      remainingIndexes.forEach(function(sourceIndex,offset){
        if(/%/.test(data.headers[sourceIndex])){
          const cell=analysisSheet[colName(22+offset)+(r+1)];
          if(cell&&typeof cell.v==='number')cell.z='0.00"%"';
        }
      });
      const volumeCell=analysisSheet['B'+(r+1)];if(volumeCell&&typeof volumeCell.v==='number')volumeCell.z='#,##0';
    }
    XLSX.utils.book_append_sheet(workbook,analysisSheet,'搜索词分析');

    const groupHeaders=['搜索词分类','搜索词数量','搜索查询量','搜索量贡献占比','市场曝光量','ASIN曝光量','ASIN曝光份额','市场点击量','ASIN点击量','ASIN点击份额','市场加购量','ASIN加购量','ASIN加购份额','市场购买量','ASIN购买量','ASIN订单贡献占比','ASIN购买份额','ASIN点击后加购率','ASIN点击后购买率'];
    const groupAoa=[groupHeaders];
    (data.queryGroups||[]).forEach(function(g){
      groupAoa.push([g.queryCategory,g.queryCount,g.searchVolume,g.searchVolumeContribution,g.impressions,g.asinImpressions,g.asinImpressionShare,
        g.clicks,g.asinClicks,g.asinClickShare,g.cartAdds,g.asinCartAdds,g.asinCartShare,
        g.purchases,g.asinPurchases,g.asinPurchaseContribution,g.asinPurchaseShare,g.asinClickToCartRate,g.asinClickToPurchaseRate]);
    });
    const groupSheet=XLSX.utils.aoa_to_sheet(groupAoa);
    groupSheet['!cols']=groupHeaders.map(function(h,i){return{wch:i===0?30:(i===1?14:18)};});
    groupSheet['!freeze']={xSplit:1,ySplit:1,topLeftCell:'B2',activePane:'bottomRight',state:'frozen'};
    groupSheet['!autofilter']={ref:'A1:'+colName(groupHeaders.length-1)+groupAoa.length};
    groupSheet['!views']=[{showGridLines:false,zoomScale:90}];
    groupSheet['!sheetPr']={tabColor:{rgb:p.greenText}};
    for(let c=0;c<groupHeaders.length;c+=1)setStyle(groupSheet,XLSX,0,c,{
      fill:{patternType:'solid',fgColor:{rgb:p.teal}},font:{name:'Aptos',sz:10,bold:true,color:{rgb:p.white}},
      alignment:{vertical:'center',horizontal:'center',wrapText:true}});
    for(let r=1;r<groupAoa.length;r+=1){
      for(let c=0;c<groupHeaders.length;c+=1)setStyle(groupSheet,XLSX,r,c,{
        fill:{patternType:'solid',fgColor:{rgb:r%2?p.white:p.pale2}},
        font:{name:'Aptos',sz:9,color:{rgb:p.text}},
        alignment:{vertical:'center',wrapText:false}});
      [3,6,9,12,15,16,17,18].forEach(function(c){const cell=groupSheet[colName(c)+(r+1)];if(cell&&typeof cell.v==='number')cell.z='0.00%';});
    }
    XLSX.utils.book_append_sheet(workbook,groupSheet,'关键词分组');

    const rawAoa=[['原始 SQR 数据  |  保留后台导出的全部字段'],[metaText],data.headers];
    (data.rawRows || rows).forEach(function(r){rawAoa.push(r.sourceValues.map(excelValue));});
    const rawSheet=XLSX.utils.aoa_to_sheet(rawAoa);
    rawSheet['!merges']=[{s:{r:0,c:0},e:{r:0,c:data.headers.length-1}}];
    rawSheet['!cols']=data.headers.map(function(h){if(h==='搜索查询')return{wch:38};if(/配送速度/.test(h))return{wch:18};return{wch:Math.min(26,Math.max(16,String(h).length+4))};});
    rawSheet['!freeze']={xSplit:1,ySplit:3,topLeftCell:'B4',activePane:'bottomRight',state:'frozen'};
    rawSheet['!autofilter']={ref:'A3:'+colName(data.headers.length-1)+rawAoa.length};
    rawSheet['!views']=[{showGridLines:false,zoomScale:80}];
    rawSheet['!sheetPr']={tabColor:{rgb:'FF8393A2'}};
    for(let c=0;c<data.headers.length;c+=1){
      setStyle(rawSheet,XLSX,0,c,{fill:{patternType:'solid',fgColor:{rgb:p.navy}},font:{name:'Aptos Display',sz:14,bold:true,color:{rgb:p.white}},alignment:{vertical:'center',indent:1}});
      setStyle(rawSheet,XLSX,2,c,{fill:{patternType:'solid',fgColor:{rgb:p.muted}},font:{name:'Aptos',sz:9,bold:true,color:{rgb:p.white}},alignment:{vertical:'center',wrapText:true}});
      if(/%/.test(data.headers[c])){
        for(let rowIndex=3;rowIndex<rawAoa.length;rowIndex+=1){
          const cell=rawSheet[colName(c)+(rowIndex+1)];
          if(cell&&typeof cell.v==='number')cell.z='0.00"%"';
        }
      }
    }
    XLSX.utils.book_append_sheet(workbook,rawSheet,'原始数据');
    workbook.Props={Title:'Amazon SQR Analysis',Subject:'Search Query Performance analysis',Author:'Amazon Operations Workspace'};
    return workbook;
  }
  const api={parseCsv:parseCsv,parseMetadata:parseMetadata,processCsv:processCsv,buildWorkbook:buildWorkbook,percentile:percentile};
  root.SqrEngine=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
}(typeof window!=='undefined'?window:globalThis));
