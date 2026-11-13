'use strict';
(() => {
  const URL_BASE = 'http://127.0.0.1:8765';
  const BUILD_VERSION = '2026.11.13.1';
  const $ = id => document.getElementById(id);
  const sessionKey = 'amazonAgentPairKey';
  let connected = false, running = false, stores = [], currentResult = null;
  const localProducts = new Map();
  let timer = null;
  const labels = { queued:'任务排队中',running:'Agent 正在读取领星与飞书',completed:'预览完成',failed:'执行失败' };
  function setConnection(ok, label) {
    connected = ok;
    $('connectionState').textContent = label;
    $('connectionState').className = 'chip ' + (ok ? 'good' : 'warn');
    $('refreshStoresBtn').disabled = !ok;
    $('setDefaultStoreBtn').disabled = !ok || !$('storeChoice').value;
    $('startBtn').disabled = !ok || running || !$('storeChoice').value;
    $('formStatus').textContent = ok ? ($('storeChoice').value ? '已确认店铺，可以生成预览' : '请先选择并确认店铺') : '请先连接本机 Agent';
  }
  function optionText(on) { return on ? '已安装' : '未检测到'; }
  function runtimeText(value) {
    return ({ok:'正常', authenticated:'正常', not_checked:'尚未执行', not_run:'尚未执行',
      unavailable:'不可用', failed:'失败', timeout:'超时'})[value] || value || '待确认';
  }
  function selectedStore() { return stores.find(row => row.store_id === $('storeChoice').value && row.marketplace === $('marketplace').value) || null; }
  function updateStoreState() {
    const store = selectedStore();
    $('storeStatus').textContent = store ? `当前任务店铺已确认：${store.name}（${store.store_id}）` : '未确认店铺，不能生成销售计划';
    $('setDefaultStoreBtn').disabled = !connected || !store;
    $('startBtn').disabled = !connected || running || !store;
    $('formStatus').textContent = connected ? (store ? '已确认店铺，可以生成预览' : '请先选择并确认店铺') : '请先连接本机 Agent';
  }
  async function loadStores(quiet=false) {
    try {
      const body = await request('/api/stores');
      stores = body.stores || [];
      const preferred = body.default_store;
      const marketplace = $('marketplace').value;
      $('storeChoice').replaceChildren(new Option('请先选择店铺', ''));
      for (const row of stores.filter(item => item.marketplace === marketplace)) {
        const option = new Option(`${row.name || '未命名店铺'} · ${row.store_id}${row.enabled ? '' : ' · 不可用'}`, row.store_id);
        option.disabled = !row.enabled;
        $('storeChoice').append(option);
      }
      const preferredRow = preferred && stores.find(row => row.store_id === preferred.store_id && row.marketplace === preferred.marketplace && row.enabled);
      if (preferredRow) $('storeChoice').value = preferredRow.store_id;
      $('defaultStoreState').textContent = preferred ? `${preferred.store_name || preferred.store_id} · ${preferred.marketplace}` : '未设置';
      updateStoreState();
    } catch (error) {
      stores = [];
      $('storeChoice').replaceChildren(new Option('店铺读取失败', ''));
      updateStoreState();
      if (!quiet) alert('店铺读取失败：' + error.message);
    }
  }
  async function request(path, init={}) {
    const key = sessionStorage.getItem(sessionKey) || '';
    const controller = new AbortController();
    const timeoutMs = path === '/api/stores' || path === '/api/context/default-store' ? 45000 : 12000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(URL_BASE+path, {
        ...init,
        mode:'cors',
        cache:'no-store',
        signal:controller.signal,
        headers:{ 'X-Agent-Key':key, ...(init.headers || {}) },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '本机 Agent 请求失败');
      return body;
    } finally { clearTimeout(timeout); }
  }
  async function connect(quiet=false) {
    const key = $('pairKey').value.trim();
    if (key) sessionStorage.setItem(sessionKey,key);
    try {
      const health = await request('/api/health');
      $('agentVersion').textContent = health.agent_version || BUILD_VERSION;
      $('codexState').textContent = optionText(health.codex_found);
      $('codexLoginState').textContent = runtimeText(health.codex_login_status);
      $('codexModelState').textContent = runtimeText(health.codex_model_service_status);
      $('larkState').textContent = optionText(health.lark_cli_found);
      $('skillState').textContent = optionText(health.sales_plan_skill_found);
      if (!health.codex_found || !health.lark_cli_found || !health.sales_plan_skill_found) {
        setConnection(false,'环境未就绪');
        if(!quiet)alert('本机 Agent 已启动，但缺少 Codex、飞书 CLI 或销售计划 Skill。请按安装说明检查。');
        return;
      }
      if (!sessionStorage.getItem(sessionKey)) {
        setConnection(false,'需要配对码');
        if(!quiet)alert('请输入启动 Agent 时终端显示的配对码');
        return;
      }
      // Health alone cannot authenticate. Request an authenticated route.
      await request('/api/auth');
      setConnection(true,'已连接');
      await loadStores(quiet);
    } catch (error) {
      setConnection(false,'连接失败');
      if(!quiet) alert('连接失败：'+error.message+'。请确认已启动本机 Agent，并允许浏览器访问本地网络。');
    }
  }
  $('connectBtn').addEventListener('click',()=>connect());
  $('refreshStoresBtn').addEventListener('click',()=>loadStores());
  $('marketplace').addEventListener('change',()=>{ $('storeChoice').value=''; loadStores(); });
  $('storeChoice').addEventListener('change', updateStoreState);
  $('setDefaultStoreBtn').addEventListener('click', async ()=>{
    const store = selectedStore(); if (!store) return;
    try {
      const result = await request('/api/context/default-store', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({store_id:store.store_id,marketplace:store.marketplace})});
      $('defaultStoreState').textContent = `${result.default_store.store_name || store.name} · ${store.marketplace}`;
      $('storeStatus').textContent = '当前任务店铺已确认，且已设为默认店铺';
    } catch (error) { alert('保存默认店铺失败：' + error.message); }
  });
  $('disconnectBtn').addEventListener('click',()=>{
    sessionStorage.removeItem(sessionKey);$('pairKey').value='';
    setConnection(false,'已断开');
  });

  function addTextList(element, values, fallback) {
    element.replaceChildren();
    for (const value of values.length ? values : [fallback]) {
      const li=document.createElement('li');li.textContent=String(value);element.append(li);
    }
  }
  function textFact(label, value) {
    const box=document.createElement('div');box.className='fact';
    const small=document.createElement('small');small.textContent=label;
    const strong=document.createElement('strong');strong.textContent=value;
    box.append(small,strong);return box;
  }
  function renderTable(host, headers, rows, emptyText) {
    if (!rows.length) { const empty=document.createElement('div');empty.className='empty-state';empty.textContent=emptyText;host.replaceChildren(empty);return; }
    const wrap=document.createElement('div');wrap.className='table-scroll';const table=document.createElement('table');
    const thead=document.createElement('thead'),trh=document.createElement('tr');
    for(const label of headers){const th=document.createElement('th');th.textContent=label;trh.append(th);}thead.append(trh);table.append(thead);
    const tbody=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const value of row){const td=document.createElement('td');td.textContent=value===null||value===undefined||value===''?'待核对':String(value);tr.append(td);}tbody.append(tr);}table.append(tbody);wrap.append(table);host.replaceChildren(wrap);
  }
  function renderResult(result) {
    currentResult = result;
    $('resultSummary').textContent=result.summary||'';
    const identity=result.product_identity||{};
    $('facts').replaceChildren(
      textFact('核对状态',({ready:'有条件可预览',needs_review:'需要人工核对',blocked:'数据不足，已阻止估算'})[result.status]||result.status),
      textFact('真实产品名称',identity.product_name||result.product||'待确认'),
      textFact('父 ASIN',identity.parent_asin||'待确认'),
      textFact('子体数量',Array.isArray(identity.child_asins)?String(identity.child_asins.length):'待确认'),
      textFact('规划库存',Number.isInteger(result.inventory_total)?result.inventory_total.toLocaleString()+' 件':'待确认'),
      textFact('库存数据时间',result.data_timestamp||'未取得')
    );
    const moduleLabels={lingxing:'领星采集',feishu:'飞书读取',codex:'Codex分析',mapping:'父子映射',inventory:'库存核验',history:'历史销量',calculation:'计划计算'};
    const goodStates=new Set(['ok','ready','complete_candidate']);$('moduleStates').replaceChildren();
    for(const [key,value] of Object.entries(result.module_status||{})){const item=document.createElement('div');item.className='status-item '+(goodStates.has(value)?'good':'warn');item.textContent=(moduleLabels[key]||key)+'：'+value;$('moduleStates').append(item);}
    if(!$('moduleStates').children.length){const item=document.createElement('div');item.className='empty-state';item.textContent='未返回模块状态';$('moduleStates').append(item);}
    renderTable($('mapping'),['子 ASIN','SKU','MSKU','FNSKU','来源'],(identity.sku_map||[]).map(row=>[row.asin,row.sku,row.msku,row.fnsku,(row.sources||[]).join(' / ')]),'尚未建立可信SKU映射');
    $('confirmMappingBtn').hidden = !selectedStore() || identity.mapping_status !== 'complete_candidate' || !(identity.sku_map||[]).length;
    const inventoryRows=[];for(const item of ((result.inventory_details||{}).sku_details||[])){for(const [name,value] of Object.entries(item.components||{})){inventoryRows.push([item.sku||item.msku||item.asin,name,value,item.dedupe_verified?'已核对':'待去重',item.date_aligned?'时间一致':'时间不一致']);}}
    renderTable($('inventoryDetails'),['SKU主体','库存类别','数量','去重状态','时间状态'],inventoryRows,'尚无可展示的库存明细');
    const history=result.historical_details||{},historyRows=[];for(const [sku,values] of Object.entries(history.values_by_sku||{})){for(const [month,units] of Object.entries(values)){historyRows.push([sku,month,units,history.source||'']);}}
    renderTable($('historyDetails'),['SKU主体','自然月','销量','来源'],historyRows,'尚无完整自然月历史销量');
    const table=document.createElement('table');
    const head=document.createElement('thead');const headRow=document.createElement('tr');
    for(const t of ['月份','预计销量','计算说明']){const th=document.createElement('th');th.textContent=t;headRow.append(th);}
    head.append(headRow);table.append(head);
    const body=document.createElement('tbody');
    for(const row of (result.monthly_plan||[])){
      const tr=document.createElement('tr');
      for(const [i,value] of [row.month,Number.isInteger(row.target_units)?row.target_units.toLocaleString():'待确认',row.note].entries()){
        const td=document.createElement('td');td.textContent=String(value||'');if(i===1)td.className='num';tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);$('monthly').replaceChildren(table);
    const skuPlanRows=[];for(const item of (result.sku_plan||[])){for(const month of (item.monthly||[])){skuPlanRows.push([item.sku||item.msku||item.asin,month.month,month.target_units,item.planning_inventory,month.seasonality_basis]);}}
    renderTable($('skuPlan'),['SKU主体','月份','目标销量','SKU规划库存','同期销量依据'],skuPlanRows,'数据校验未通过，未生成SKU月度分配');
    addTextList($('skuNotes'),[result.inventory_basis,result.historical_basis,...(result.sku_notes||[])].filter(Boolean),'没有额外说明');
    const sourceLabels={lingxing:'领星',feishu:'飞书'};
    const statusLabels={ok:'读取成功',partial:'部分读取',missing:'未找到匹配数据',error:'读取失败'};
    const sourceStates=Object.entries(result.source_status||{}).map(([name,status])=>(sourceLabels[name]||name)+'：'+(statusLabels[status]||status));
    addTextList($('warnings'),[...sourceStates,...(result.warnings||[])],'未列出异常；仍需人工核对');
    addTextList($('sources'),[...(result.data_sources||[]),result.feishu_target&&('飞书目标：'+result.feishu_target)].filter(Boolean),'未取得来源，请检查授权');
  }
  $('confirmMappingBtn').addEventListener('click', async ()=>{
    const store = selectedStore(); const rows = currentResult?.product_identity?.sku_map || [];
    if (!store || !rows.length) return;
    try {
      await request('/api/context/product-mapping', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        store_id:store.store_id, marketplace:store.marketplace, scope_status:'confirmed',
        mapping_status:currentResult?.product_identity?.mapping_status, mappings:rows
      })});
      $('mappingStatus').textContent = '已保存为当前店铺的已确认映射';
    } catch (error) { $('mappingStatus').textContent = '保存失败：' + error.message; }
  });
  function setJobStatus(text,kind=''){
    $('jobState').textContent=text;$('jobState').className='chip '+kind;
  }
  async function pollJob(jobId){
    if(!running)return;
    try{
      const job=await request('/api/jobs/'+jobId);
      if(job.status==='completed'){
        const result=job.result||{};
        const outcome=result.status;
        setJobStatus(outcome==='ready'?'预览已生成':outcome==='needs_review'?'数据待核对':outcome==='blocked'?'数据不足，无法生成计划':'预览结果异常',outcome==='ready'?'good':'warn');
        renderResult(result);
        running=false;updateStoreState();return;
      }
      setJobStatus(labels[job.status]||job.status,'warn');
      if(job.status==='failed'){
        $('resultSummary').textContent=job.error||'执行失败';
        running=false;updateStoreState();return;
      }
      timer=setTimeout(()=>pollJob(jobId),2600);
    }catch(err){
      setJobStatus('查询状态失败','warn');$('resultSummary').textContent=err.message;
      running=false;updateStoreState();
    }
  }
  $('planForm').addEventListener('submit',async e=>{
    e.preventDefault();if(!connected||running)return;
    if(!selectedStore()){alert('请先选择并确认店铺');return;}
    const payload={
      product:$('product').value.trim(),asin:$('asin').value.trim().toUpperCase(),
      site:$('marketplace').value,store_id:$('storeChoice').value,scope_status:'confirmed',
      start_month:$('startMonth').value,end_month:$('endMonth').value,
      sell_through:Number($('goal').value),knowledge_base:$('knowledgeBase').value.trim(),notes:$('notes').value.trim(),
    };
    if(payload.end_month<payload.start_month){alert('结束月份不能早于开始月份');return;}
    if(!/^[A-Z0-9]{10}$/.test(payload.asin)){alert('请填写 10 位 ASIN');return;}
    running=true;$('startBtn').disabled=true;
    $('results').hidden=false;$('facts').replaceChildren();$('monthly').replaceChildren();
    $('skuNotes').replaceChildren();$('warnings').replaceChildren();$('sources').replaceChildren();$('moduleStates').replaceChildren();$('mapping').replaceChildren();$('inventoryDetails').replaceChildren();$('historyDetails').replaceChildren();$('skuPlan').replaceChildren();
    $('resultSummary').textContent='Agent 正在执行只读查询。任务完成后显示实际数据、月度计划与需要核对的字段。';
    setJobStatus('正在提交任务','warn');$('results').scrollIntoView({behavior:'smooth',block:'start'});
    try{
      const job=await request('/api/jobs/preview',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      });
      pollJob(job.id);
    }catch(err){
      setJobStatus('启动失败','warn');$('resultSummary').textContent=err.message;
      running=false;updateStoreState();
    }
  });

  async function loadLocalProducts(){
    if(!window.indexedDB)return;
    try{
      const db=await new Promise((resolve,reject)=>{
        const req=indexedDB.open('amazonOpsToolkit',2);
        req.onupgradeneeded=()=>{};
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      if(!db.objectStoreNames.contains('products')){db.close();return;}
      const records=await new Promise((resolve,reject)=>{
        const tx=db.transaction('products','readonly');
        const req=tx.objectStore('products').getAll();
        req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
      });
      for(const p of records.sort((a,b)=>String(a.parentAsin).localeCompare(String(b.parentAsin)))){
        const asin=String(p.parentAsin||'').toUpperCase();if(!/^[A-Z0-9]{10}$/.test(asin))continue;
        const name=String(p.productName||p.name||p.title||p.children?.find(c=>c.title)?.title||'').trim();localProducts.set(asin,{...p,name});
        const option=document.createElement('option');option.value=asin;
        option.textContent=(name?name+' · ':'')+asin+' · '+(p.children||[]).length+' 个子体';
        $('productChoice').append(option);
      }
      db.close();
    }catch(_){/* Browser local library is optional */}
  }
  $('productChoice').addEventListener('change',()=>{
    if($('productChoice').value){const asin=$('productChoice').value,p=localProducts.get(asin);$('asin').value=asin;if(p?.name)$('product').value=p.name;}
  });
  const now=new Date(),startYear=now.getFullYear(),startMonth=now.getMonth()+1;
  const toYM=(year,month)=>`${year}-${String(month).padStart(2,'0')}`;
  $('startMonth').value=toYM(startYear,startMonth);
  const endDate=new Date(startYear,startMonth+2,1);
  $('endMonth').value=toYM(endDate.getFullYear(),endDate.getMonth()+1);
  loadLocalProducts();
  if(sessionStorage.getItem(sessionKey))connect(true);
})();
