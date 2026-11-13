'use strict';
(() => {
  const API = 'http://127.0.0.1:8765';
  const SESSION_KEY = 'amazonAgentPairKey';
  const DRAFT_KEY = 'amazonAdsRelaunchDraftV1';
  const $ = id => document.getElementById(id);
  let connected = false;
  let stores = [];
  let savedConfig = defaultConfig();

  function defaultConfig() {
    return {
      schema_version: '1.0', updated_at: null,
      global_settings: {
        marketplace: 'US', report_days: 30, duplicate_impression_days: 7,
        execution_interval_days: 7, match_types: ['exact', 'phrase', 'broad'],
        campaign_structure: 'exact_separate_phrase_broad_shared',
        campaign_keyword_limit: null, budgets: {}, bidding_strategy: '',
        bid_coefficients: { exact: 1, phrase: 0.85, broad: 0.70 },
        min_bid: null, max_bid: null, default_bid: null,
        campaign_naming: {
          code: 'SP-KW', prefix: '出单再投放', date_format: 'YYYYMMDD',
          labels: { exact: '精准', phrase: '词组', broad: '广泛', phrase_broad: '词组+广泛' }
        },
        group_naming: { exact: '精准', phrase: '词组', broad: '广泛' }
      },
      global_negative_rules: { negative_keywords: [], negative_product_asins: [] },
      product_profiles: {}, campaign_registry: {}, execution_history: []
    };
  }

  function request(path, init) {
    init = init || {};
    const key = sessionStorage.getItem(SESSION_KEY) || '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    return fetch(API + path, {
      ...init, mode: 'cors', cache: 'no-store', signal: controller.signal,
      headers: { 'X-Agent-Key': key, ...(init.headers || {}) }
    }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '本机 Agent 请求失败');
      return body;
    }).finally(() => clearTimeout(timeout));
  }

  function setConnection(ok, label, kind) {
    connected = ok;
    $('connectionState').textContent = label;
    $('connectionState').className = 'status ' + (kind || (ok ? 'good' : 'warn'));
    $('saveConfigBtn').disabled = !ok;
    $('setDefaultStoreBtn').disabled = !ok || !$('storeChoice').value;
  }
  function value(id) { return $(id).value.trim(); }
  function optionalNumber(id) {
    const raw = value(id);
    return raw === '' ? null : Number(raw);
  }
  function lineList(raw) {
    return String(raw || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  }
  function parseNegativeKeywords(raw, label) {
    return lineList(raw).map((line, index) => {
      const parts = line.split('|');
      const keyword = (parts[0] || '').trim();
      const type = (parts[1] || '').trim().toLowerCase();
      if (!keyword || !['exact', 'phrase'].includes(type)) {
        throw new Error(label + '第 ' + (index + 1) + ' 行格式错误，请按“关键词 | exact”或“关键词 | phrase”填写');
      }
      return { keyword, match_type: type.toUpperCase() };
    });
  }
  function uniqueStrings(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = String(item).trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function checkedMatchTypes() {
    return Array.from(document.querySelectorAll('input[name="matchType"]:checked')).map(node => node.value);
  }
  function selectedStore() {
    const raw = value('storeChoice');
    if (!raw) return null;
    const split = raw.split('|');
    return stores.find(row => row.store_id === split[0] && row.marketplace === split[1]) || null;
  }
  function setStoreDisplay() {
    const store = selectedStore();
    $('marketplaceDisplay').value = store ? store.marketplace : (savedConfig.global_settings.marketplace || 'US');
    $('storeHint').textContent = store ? ('当前店铺：' + (store.name || store.store_id) + ' · ' + store.marketplace) : '请选择一个已授权店铺';
    $('setDefaultStoreBtn').disabled = !connected || !store;
  }

  async function loadStores() {
    const result = await request('/api/stores');
    stores = result.stores || [];
    const select = $('storeChoice');
    select.replaceChildren(new Option('请选择领星店铺', ''));
    stores.filter(row => row.enabled).forEach(row => {
      const option = new Option((row.name || '未命名店铺') + ' · ' + row.store_id + ' · ' + row.marketplace,
        row.store_id + '|' + row.marketplace);
      select.append(option);
    });
    const preferred = result.default_store;
    if (preferred) {
      const match = stores.find(row => row.store_id === preferred.store_id &&
        row.marketplace === preferred.marketplace && row.enabled);
      if (match) select.value = match.store_id + '|' + match.marketplace;
    }
    if (!select.value && stores.filter(row => row.enabled).length === 1) {
      const only = stores.find(row => row.enabled);
      select.value = only.store_id + '|' + only.marketplace;
    }
    setStoreDisplay();
  }

  async function loadConfig() {
    const result = await request('/api/ads/config');
    savedConfig = result.config || defaultConfig();
    renderConfig();
  }

  async function connect() {
    const key = value('pairKey');
    if (key) sessionStorage.setItem(SESSION_KEY, key);
    try {
      const health = await request('/api/health');
      await request('/api/auth');
      setConnection(true, '已连接');
      $('skillInstallState').textContent = health.amazon_ads_relaunch_skill_found
        ? '本机已检测到广告再投放 Skill'
        : '本机尚未安装广告再投放 Skill；保存配置后请运行 agent/install-skill.ps1';
      if (!health.amazon_ads_relaunch_skill_found) $('skillInstallState').style.color = '#9e6828';
      await loadConfig();
      try { await loadStores(); }
      catch (storeError) { $('storeHint').textContent = '店铺读取失败：' + storeError.message; }
      $('formStatus').textContent = '已读取本机持久配置。否定规则与 Campaign Registry 会保存在本机。';
    } catch (error) {
      setConnection(false, '连接失败');
      $('formStatus').textContent = '连接失败：' + error.message + '。请确认本机 Agent 已启动且配对码正确。';
    }
  }

  function setNumber(id, number) {
    $(id).value = number === null || number === undefined ? '' : String(number);
  }
  function renderConfig() {
    const g = savedConfig.global_settings || {};
    $('reportDays').value = g.report_days ?? 30;
    $('duplicateDays').value = g.duplicate_impression_days ?? 7;
    $('executionInterval').value = g.execution_interval_days ?? 7;
    $('campaignLimit').value = g.campaign_keyword_limit ?? '';
    $('campaignStructure').value = g.campaign_structure || 'exact_separate_phrase_broad_shared';
    $('biddingStrategy').value = g.bidding_strategy || '';
    $('exactCoeff').value = g.bid_coefficients?.exact ?? 1;
    $('phraseCoeff').value = g.bid_coefficients?.phrase ?? 0.85;
    $('broadCoeff').value = g.bid_coefficients?.broad ?? 0.70;
    setNumber('minBid', g.min_bid);
    setNumber('maxBid', g.max_bid);
    setNumber('defaultBid', g.default_bid);
    const budgets = g.budgets || {};
    setNumber('budgetExact', budgets.exact);
    setNumber('budgetPhraseBroad', budgets.phrase_broad);
    setNumber('budgetPhrase', budgets.phrase);
    setNumber('budgetBroad', budgets.broad);
    setNumber('budgetAll', budgets.all);
    const naming = g.campaign_naming || {};
    $('campaignCode').value = naming.code || 'SP-KW';
    $('campaignPrefix').value = naming.prefix || '出单再投放';
    const labels = naming.labels || {};
    $('labelExact').value = labels.exact || '精准';
    $('labelPhrase').value = labels.phrase || '词组';
    $('labelBroad').value = labels.broad || '广泛';
    $('labelPhraseBroad').value = labels.phrase_broad || '词组+广泛';
    $('dateFormat').value = naming.date_format || 'YYYYMMDD';
    const groupNaming = g.group_naming || {};
    $('groupNameExact').value = groupNaming.exact || '精准';
    $('groupNamePhrase').value = groupNaming.phrase || '词组';
    $('groupNameBroad').value = groupNaming.broad || '广泛';
    const matchTypes = new Set(g.match_types || ['exact', 'phrase', 'broad']);
    document.querySelectorAll('input[name="matchType"]').forEach(node => { node.checked = matchTypes.has(node.value); });
    const globalNeg = savedConfig.global_negative_rules || {};
    $('globalNegativeKeywords').value = (globalNeg.negative_keywords || []).map(x => x.keyword + ' | ' + String(x.match_type || 'EXACT').toLowerCase()).join('\n');
    $('globalNegativeAsins').value = (globalNeg.negative_product_asins || []).join('\n');
    loadProfileForAsin();
  }

  function loadProfileForAsin() {
    const asin = value('asin').toUpperCase();
    const profile = (savedConfig.product_profiles || {})[asin] || {};
    $('productName').value = profile.product_name || '';
    $('productShortName').value = profile.product_short_name || '';
    const productBudgets = profile.budgets || {};
    setNumber('productBudgetExact', productBudgets.exact);
    setNumber('productBudgetPhraseBroad', productBudgets.phrase_broad);
    setNumber('productBudgetPhrase', productBudgets.phrase);
    setNumber('productBudgetBroad', productBudgets.broad);
    setNumber('productBudgetAll', productBudgets.all);
    $('exactMin').value = profile.match_order_bands?.exact?.min_orders ?? '';
    $('exactMax').value = profile.match_order_bands?.exact?.max_orders ?? '';
    $('phraseMin').value = profile.match_order_bands?.phrase?.min_orders ?? '';
    $('phraseMax').value = profile.match_order_bands?.phrase?.max_orders ?? '';
    $('broadMin').value = profile.match_order_bands?.broad?.min_orders ?? '';
    $('broadMax').value = profile.match_order_bands?.broad?.max_orders ?? '';
    $('profileExcludedCampaigns').value = (profile.excluded_source_campaigns || []).join('\n');
    $('profileNegativeKeywords').value = (profile.negative_keywords || []).map(x => x.keyword + ' | ' + String(x.match_type || 'EXACT').toLowerCase()).join('\n');
    $('profileNegativeAsins').value = (profile.negative_product_asins || []).join('\n');
    $('targetAcos').value = profile.target_acos === null || profile.target_acos === undefined ? '' : String(Number(profile.target_acos) * 100);
  }

  function collectPersistentConfig() {
    const g = {
      marketplace: selectedStore()?.marketplace || $('marketplaceDisplay').value || 'US',
      report_days: optionalNumber('reportDays'),
      duplicate_impression_days: optionalNumber('duplicateDays'),
      execution_interval_days: optionalNumber('executionInterval') ?? 7,
      match_types: checkedMatchTypes(),
      campaign_structure: value('campaignStructure'),
      campaign_keyword_limit: optionalNumber('campaignLimit'),
      budgets: {
        exact: optionalNumber('budgetExact'),
        phrase_broad: optionalNumber('budgetPhraseBroad'),
        phrase: optionalNumber('budgetPhrase'),
        broad: optionalNumber('budgetBroad'),
        all: optionalNumber('budgetAll')
      },
      bidding_strategy: value('biddingStrategy'),
      bid_coefficients: {
        exact: Number(value('exactCoeff')),
        phrase: Number(value('phraseCoeff')),
        broad: Number(value('broadCoeff'))
      },
      min_bid: optionalNumber('minBid'),
      max_bid: optionalNumber('maxBid'),
      default_bid: optionalNumber('defaultBid'),
      campaign_naming: {
        code: value('campaignCode') || 'SP-KW',
        prefix: value('campaignPrefix') || '出单再投放',
        date_format: value('dateFormat') || 'YYYYMMDD',
        labels: {
          exact: value('labelExact') || '精准',
          phrase: value('labelPhrase') || '词组',
          broad: value('labelBroad') || '广泛',
          phrase_broad: value('labelPhraseBroad') || '词组+广泛'
        }
      },
      group_naming: {
        exact: value('groupNameExact') || '精准',
        phrase: value('groupNamePhrase') || '词组',
        broad: value('groupNameBroad') || '广泛'
      }
    };
    const profiles = { ...(savedConfig.product_profiles || {}) };
    const asin = value('asin').toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(asin)) {
      profiles[asin] = {
        ...(profiles[asin] || {}),
        product_name: value('productName'),
        product_short_name: value('productShortName'),
        budgets: {
          exact: optionalNumber('productBudgetExact'),
          phrase_broad: optionalNumber('productBudgetPhraseBroad'),
          phrase: optionalNumber('productBudgetPhrase'),
          broad: optionalNumber('productBudgetBroad'),
          all: optionalNumber('productBudgetAll')
        },
        match_order_bands: {
          exact: { min_orders: optionalNumber('exactMin'), max_orders: optionalNumber('exactMax') },
          phrase: { min_orders: optionalNumber('phraseMin'), max_orders: optionalNumber('phraseMax') },
          broad: { min_orders: optionalNumber('broadMin'), max_orders: optionalNumber('broadMax') }
        },
        excluded_source_campaigns: uniqueStrings(lineList(value('profileExcludedCampaigns'))),
        negative_keywords: parseNegativeKeywords(value('profileNegativeKeywords'), 'ASIN 专属否定关键词'),
        negative_product_asins: uniqueStrings(lineList(value('profileNegativeAsins')).map(x => x.toUpperCase())),
        target_acos: optionalNumber('targetAcos') === null ? null : Number(value('targetAcos')) / 100
      };
    }
    return {
      schema_version: '1.0',
      global_settings: g,
      global_negative_rules: {
        negative_keywords: parseNegativeKeywords(value('globalNegativeKeywords'), '全局否定关键词'),
        negative_product_asins: uniqueStrings(lineList(value('globalNegativeAsins')).map(x => x.toUpperCase()))
      },
      product_profiles: profiles
    };
  }

  function campaignBudgetGroups(matches, structure) {
    if (structure === 'one_campaign_multi_groups') return ['all'];
    if (structure === 'separate_campaign_per_match') return matches.slice();
    const groups = [];
    if (matches.includes('exact')) groups.push('exact');
    if (structure === 'exact_separate_phrase_broad_shared') {
      if (matches.includes('phrase') || matches.includes('broad')) groups.push('phrase_broad');
    } else {
      if (matches.includes('phrase')) groups.push('phrase');
      if (matches.includes('broad')) groups.push('broad');
    }
    return groups;
  }

  function validateConfig(config, task) {
    const g = config.global_settings;
    if (!/^[A-Z0-9]{10}$/.test(task.asin)) throw new Error('请输入有效的 10 位 ASIN');
    if (!task.store_id || !task.marketplace) throw new Error('请连接本机 Agent 并选择领星店铺');
    if (!Number.isInteger(g.report_days) || g.report_days < 1) throw new Error('默认统计周期必须是大于0的整数天数');
    if (!Number.isInteger(g.duplicate_impression_days) || g.duplicate_impression_days < 1) throw new Error('去重窗口必须是大于0的整数天数');
    if (!Number.isInteger(g.campaign_keyword_limit) || g.campaign_keyword_limit < 1) throw new Error('请设置每个 Campaign 的最大关键词数');
    if (!g.match_types.length) throw new Error('至少选择一种匹配方式');
    if (!g.bidding_strategy) throw new Error('请选择 Campaign 竞价策略');
    const c = g.bid_coefficients;
    if (!(c.exact > c.phrase && c.phrase > c.broad && c.broad > 0)) throw new Error('Bid 系数必须满足 Exact > Phrase > Broad，且全部大于0');
    if (g.min_bid !== null && g.max_bid !== null && g.min_bid > g.max_bid) throw new Error('最低 Bid 不能高于最高 Bid');
    if (g.min_bid !== null && g.min_bid <= 0) throw new Error('最低 Bid 必须大于0');
    if (g.max_bid !== null && g.max_bid <= 0) throw new Error('最高 Bid 必须大于0');
    if (g.default_bid !== null && g.default_bid <= 0) throw new Error('默认 Bid 必须大于0');
    const profile = config.product_profiles[task.asin] || {};
    const bands = profile.match_order_bands || {};
    g.match_types.forEach(type => {
      const band = bands[type] || {};
      if (!Number.isInteger(band.min_orders) || band.min_orders < 0) {
        throw new Error(({ exact: '精准', phrase: '词组', broad: '广泛' })[type] + '匹配必须设置最低出单量');
      }
      if (band.max_orders !== null && band.max_orders !== undefined &&
          (!Number.isInteger(band.max_orders) || band.max_orders < band.min_orders)) {
        throw new Error(({ exact: '精准', phrase: '词组', broad: '广泛' })[type] + '最高出单量不能小于最低出单量');
      }
    });
    const budgetKeys = campaignBudgetGroups(g.match_types, g.campaign_structure);
    const effectiveBudgets = { ...(g.budgets || {}), ...(profile.budgets || {}) };
    budgetKeys.forEach(key => {
      const amount = effectiveBudgets[key];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('请填写 ' + ({ exact: '精准 Campaign', phrase_broad: '词组+广泛 Campaign', phrase: '词组 Campaign', broad: '广泛 Campaign', all: '共用 Campaign' })[key] + ' 的日预算');
      }
    });
    const negativeAsins = (config.global_negative_rules.negative_product_asins || []).concat(profile.negative_product_asins || []);
    for (const asin of negativeAsins) {
      if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('否定商品列表中存在无效 ASIN：' + asin);
    }
    if (task.report_days !== null && (!Number.isInteger(task.report_days) || task.report_days < 1)) {
      throw new Error('本次统计周期必须是大于0的整数天数');
    }
  }

  function makeTask() {
    const store = selectedStore();
    return {
      asin: value('asin').toUpperCase(),
      store_id: store?.store_id || '',
      store_name: store?.name || '',
      marketplace: store?.marketplace || '',
      report_days: optionalNumber('reportDaysOverride'),
      extra_excluded_campaigns: uniqueStrings(lineList(value('extraExcludedCampaigns'))),
      notes: value('taskNotes')
    };
  }

  function makeInstruction(config, task) {
    const profile = config.product_profiles[task.asin] || {};
    const payload = {
      schema_version: config.schema_version,
      config_file_path: '%LOCALAPPDATA%\\AmazonOperationsWorkspace\\context\\ads_relaunch_config.json',
      store: { store_id: task.store_id, store_name: task.store_name, marketplace: task.marketplace },
      task: {
        asin: task.asin,
        product_name: profile.product_name || '',
        product_short_name: profile.product_short_name || '',
        report_days: task.report_days || config.global_settings.report_days,
        extra_excluded_campaigns: task.extra_excluded_campaigns,
        notes: task.notes
      },
      global_settings: config.global_settings,
      global_negative_rules: config.global_negative_rules,
      product_profile: profile,
      campaign_registry: config.campaign_registry || {},
      execution_history: config.execution_history || []
    };
    const json = JSON.stringify(payload, null, 2);
    return [
      '请调用我本机已安装的 amazon-ads-search-term-relaunch Skill，立即执行本次 Amazon SP 关键词出单词二次投放任务。不是只做方案或预览；请按下面的配置真实创建/追加广告。新建 Campaign 必须保持 PAUSED。',
      '',
      '【本次任务范围】',
      '- ASIN：' + task.asin,
      '- 店铺：' + task.store_name + '（' + task.store_id + '）',
      '- Marketplace：' + task.marketplace,
      '- 统计周期：近 ' + (task.report_days || config.global_settings.report_days) + ' 天',
      '- 临时排除来源广告：' + (task.extra_excluded_campaigns.join('；') || '无'),
      '- 特殊要求：' + (task.notes || '无'),
      '',
      '【配置快照 JSON】',
      '以下 JSON 是本次前置程序生成的最新配置；同时读取本机配置文件，按 Skill 规定合并版本和记忆。不要让我重复填写已存在的设置。',
      '----- CONFIG JSON START -----',
      json,
      '----- CONFIG JSON END -----',
      '',
      '【必须遵守】',
      '1. 先完整读取 amazon-ads-search-term-relaunch Skill 及其 references，再按真实领星 MCP 工具 schema 执行；不要猜测工具名或参数。',
      '2. 以领星 Customer Search Term 广告归因订单为出单词来源；先按 ASIN、SKU、店铺、站点和统计周期过滤，再排除来源 Campaign 并汇总同一搜索词。',
      '3. 产品相关性是硬性条件；按 Exact/Phrase/Broad 各自订单区间分配，区间允许重叠；小样本正常参与，不设置额外最低点击门槛。',
      '4. 重复检查必须扫描该 ASIN 当前全部相关广告，唯一键为关键词文本+匹配方式；只有 Campaign、Ad Group、Keyword 均 ENABLED 且去重窗口内有曝光才跳过。不同匹配方式允许同时投放。',
      '5. 只复用本 Skill 的 campaign_registry 中已登记 Campaign；未满优先追加，按整个 Campaign（所有 Ad Group 合计）计算关键词上限；满额后才创建下一个序号 Campaign。',
      '6. 竞价主要依据实际历史 CPC，参考领星建议竞价；同一词 Exact > Phrase > Broad。遇到缺失或异常竞价按 Skill 规则处理，不得编造。',
      '7. 新建 Campaign PAUSED；Ad Group、Product Ad、Keyword ENABLED。若追加到已手动开启的 Skill Campaign，保持 Campaign 已启用并让新关键词正常启用。',
      '8. 不修改任何非 Skill 创建并登记的原有广告；不添加/修改原广告否定词；不做自动调价、自动暂停或其他后续优化。',
      '9. 完成后把成功创建的 Campaign/Ad Group/Keyword ID、关键词、匹配方式、Bid、预算、状态和执行记录写回本机配置文件；保留用户设置。',
      '10. 汇报创建成功/失败、各匹配方式关键词数量、重复跳过原因、Campaign Pool 复用情况及配置持久化结果。只有必要的 ASIN/SKU 或数据口径无法确认时才向我提问。'
    ].join('\n');
  }

  async function persistConfig(config, quiet) {
    if (!connected) throw new Error('请先连接本机 Agent，才能保存跨任务的 ASIN 记忆和 Campaign Registry');
    const result = await request('/api/ads/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    });
    savedConfig = result.config || savedConfig;
    if (!quiet) $('formStatus').textContent = '配置已保存到本机：全局规则、ASIN 否定规则和产品简称已持久化；Campaign Registry 保持不变。';
  }

  async function runGenerate(copy) {
    if (!$('adsForm').reportValidity()) return;
    try {
      const task = makeTask();
      const config = collectPersistentConfig();
      validateConfig(config, task);
      const profile = config.product_profiles[task.asin] || {};
      if (!profile.product_short_name && !profile.product_name) {
        $('formStatus').textContent = '未填写产品简称，Skill 将尝试从领星/Listing 读取产品名称并生成简称；如无法可靠识别会在创建前提示。';
      }
      if (connected) await persistConfig(config, true);
      else {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(config));
        $('formStatus').textContent = '当前未连接本机 Agent：已在当前浏览器保存草稿，但不能保存 Campaign Registry/ASIN 长期记忆。请连接后保存。';
      }
      const promptConfig = connected ? savedConfig : { ...savedConfig, ...config };
      const instruction = makeInstruction(promptConfig, task);
      $('instructionPreview').textContent = instruction;
      $('instructionPreview').hidden = false;
      if (copy) {
        await copyText(instruction);
        $('formStatus').textContent = '已保存配置并复制完整 Codex 指令。打开 Codex 粘贴执行即可。';
      } else {
        $('formStatus').textContent = '指令已生成，请核对下方完整内容。';
      }
      $('instructionPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { $('formStatus').textContent = error.message; }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('复制失败，请从下方预览手动复制');
  }

  function exportConfig() {
    try {
      const config = { ...savedConfig, ...collectPersistentConfig() };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'amazon-ads-relaunch-config.json';
      link.click();
      URL.revokeObjectURL(url);
      $('formStatus').textContent = '已导出当前配置。Campaign Registry 以本机 Agent 中保存的版本为准。';
    } catch (error) { $('formStatus').textContent = error.message; }
  }

  async function importConfig(file) {
    const incoming = JSON.parse(await file.text());
    if (!incoming || typeof incoming !== 'object' || !incoming.global_settings) throw new Error('配置文件格式不正确');
    const currentRegistry = savedConfig.campaign_registry || {};
    const currentHistory = savedConfig.execution_history || [];
    savedConfig = { ...defaultConfig(), ...incoming };
    if (!Object.prototype.hasOwnProperty.call(incoming, 'campaign_registry')) savedConfig.campaign_registry = currentRegistry;
    if (!Object.prototype.hasOwnProperty.call(incoming, 'execution_history')) savedConfig.execution_history = currentHistory;
    renderConfig();
    if (connected) {
      await persistConfig(savedConfig, true);
      $('formStatus').textContent = '配置已导入并保存到本机 Agent。';
    } else {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(savedConfig));
      $('formStatus').textContent = '配置已载入当前页面草稿；连接本机 Agent 后再保存，才能长期记忆。';
    }
  }

  async function saveDefaultStore() {
    const store = selectedStore();
    if (!store) throw new Error('请先选择店铺');
    const result = await request('/api/context/default-store', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: store.store_id, marketplace: store.marketplace })
    });
    $('storeHint').textContent = '已设为默认店铺：' + (result.default_store.store_name || store.name) + ' · ' + store.marketplace;
  }

  $('connectBtn').addEventListener('click', connect);
  $('storeChoice').addEventListener('change', setStoreDisplay);
  $('setDefaultStoreBtn').addEventListener('click', () => saveDefaultStore().catch(e => { $('formStatus').textContent = e.message; }));
  $('asin').addEventListener('change', loadProfileForAsin);
  $('saveConfigBtn').addEventListener('click', async () => {
    try {
      const config = collectPersistentConfig();
      const asin = value('asin').toUpperCase();
      if (asin && !/^[A-Z0-9]{10}$/.test(asin)) throw new Error('ASIN 必须为10位字母数字');
      await persistConfig(config, false);
    } catch (error) { $('formStatus').textContent = error.message; }
  });
  $('previewBtn').addEventListener('click', () => runGenerate(false));
  $('adsForm').addEventListener('submit', event => { event.preventDefault(); runGenerate(true); });
  $('exportBtn').addEventListener('click', exportConfig);
  $('importBtn').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (file) importConfig(file).catch(error => { $('formStatus').textContent = error.message; });
    event.target.value = '';
  });

  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) {
      savedConfig = { ...defaultConfig(), ...JSON.parse(draft) };
      renderConfig();
    }
  } catch (_) { /* ignore malformed local draft */ }

  const existingKey = sessionStorage.getItem(SESSION_KEY);
  if (existingKey) {
    $('pairKey').value = existingKey;
    connect();
  } else {
    renderConfig();
  }
})();
