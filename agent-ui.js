'use strict';
(() => {
  const URL_BASE = 'http://127.0.0.1:8765';
  const $ = id => document.getElementById(id);
  const sessionKey = 'amazonAgentPairKey';
  let connected = false, running = false;
  let timer = null;
  const labels = { queued:'任务排队中',running:'Agent 正在读取领星与飞书',completed:'预览完成',failed:'执行失败' };
  function setConnection(ok, label) {
    connected = ok;
    $('connectionState').textContent = label;
    $('connectionState').className = 'chip ' + (ok ? 'good' : 'warn');
    $('startBtn').disabled = !ok || running;
    $('formStatus').textContent = ok ? '已连接本机 Agent，可以生成预览' : '请先连接本机 Agent';
  }
  function optionText(on) { return on ? '已安装' : '未检测到'; }
  async function request(path, init={}) {
    const key = sessionStorage.getItem(sessionKey) || '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
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
      $('codexState').textContent = optionText(health.codex_found);
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
    } catch (error) {
      setConnection(false,'连接失败');
      if(!quiet) alert('连接失败：'+error.message+'。请确认已启动本机 Agent，并允许浏览器访问本地网络。');
    }
  }
  $('connectBtn').addEventListener('click',()=>connect());
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
  function renderResult(result) {
    $('resultSummary').textContent=result.summary||'';
    $('facts').replaceChildren(
      textFact('核对状态',({ready:'有条件可预览',needs_review:'需要人工核对',blocked:'数据不足，已阻止估算'})[result.status]||result.status),
      textFact('规划库存',Number.isInteger(result.inventory_total)?result.inventory_total.toLocaleString()+' 件':'待确认'),
      textFact('库存数据时间',result.data_timestamp||'未取得')
    );
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
    addTextList($('skuNotes'),[result.inventory_basis,result.historical_basis,...(result.sku_notes||[])].filter(Boolean),'没有额外说明');
    const sourceLabels={lingxing:'领星',feishu:'飞书'};
    const statusLabels={ok:'读取成功',partial:'部分读取',missing:'未找到匹配数据',error:'读取失败'};
    const sourceStates=Object.entries(result.source_status||{}).map(([name,status])=>(sourceLabels[name]||name)+'：'+(statusLabels[status]||status));
    addTextList($('warnings'),[...sourceStates,...(result.warnings||[])],'未列出异常；仍需人工核对');
    addTextList($('sources'),[...(result.data_sources||[]),result.feishu_target&&('飞书目标：'+result.feishu_target)].filter(Boolean),'未取得来源，请检查授权');
  }
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
        running=false;$('startBtn').disabled=!connected;return;
      }
      setJobStatus(labels[job.status]||job.status,'warn');
      if(job.status==='failed'){
        $('resultSummary').textContent=job.error||'执行失败';
        running=false;$('startBtn').disabled=!connected;return;
      }
      timer=setTimeout(()=>pollJob(jobId),2600);
    }catch(err){
      setJobStatus('查询状态失败','warn');$('resultSummary').textContent=err.message;
      running=false;$('startBtn').disabled=!connected;
    }
  }
  $('planForm').addEventListener('submit',async e=>{
    e.preventDefault();if(!connected||running)return;
    const payload={
      product:$('product').value.trim(),asin:$('asin').value.trim().toUpperCase(),
      site:$('site').value,start_month:$('startMonth').value,end_month:$('endMonth').value,
      sell_through:Number($('goal').value),knowledge_base:$('knowledgeBase').value.trim(),notes:$('notes').value.trim(),
    };
    if(payload.end_month<payload.start_month){alert('结束月份不能早于开始月份');return;}
    if(!/^[A-Z0-9]{10}$/.test(payload.asin)){alert('请填写 10 位 ASIN');return;}
    running=true;$('startBtn').disabled=true;
    $('results').hidden=false;$('facts').replaceChildren();$('monthly').replaceChildren();
    $('skuNotes').replaceChildren();$('warnings').replaceChildren();$('sources').replaceChildren();
    $('resultSummary').textContent='Agent 正在执行只读查询。任务完成后显示实际数据、月度计划与需要核对的字段。';
    setJobStatus('正在提交任务','warn');$('results').scrollIntoView({behavior:'smooth',block:'start'});
    try{
      const job=await request('/api/jobs/preview',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      });
      pollJob(job.id);
    }catch(err){
      setJobStatus('启动失败','warn');$('resultSummary').textContent=err.message;
      running=false;$('startBtn').disabled=!connected;
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
        const option=document.createElement('option');option.value=asin;
        option.textContent=asin+' · '+(p.children||[]).length+' 个子体';
        $('productChoice').append(option);
      }
      db.close();
    }catch(_){/* Browser local library is optional */}
  }
  $('productChoice').addEventListener('change',()=>{
    if($('productChoice').value){$('asin').value=$('productChoice').value;if(!$('product').value.trim())$('product').value='产品 '+$('productChoice').value;}
  });
  const now=new Date(),startYear=now.getFullYear(),startMonth=now.getMonth()+1;
  const toYM=(year,month)=>`${year}-${String(month).padStart(2,'0')}`;
  $('startMonth').value=toYM(startYear,startMonth);
  const endDate=new Date(startYear,startMonth+2,1);
  $('endMonth').value=toYM(endDate.getFullYear(),endDate.getMonth()+1);
  loadLocalProducts();
  if(sessionStorage.getItem(sessionKey))connect(true);
})();
