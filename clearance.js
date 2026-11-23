/* FBA liquidation and removal cost calculator. All data stays in this browser. */
(function(){
'use strict';
const DB_NAME='amazonOpsToolkit', DB_VERSION=3, STORE='clearanceProducts';
const HEADERS=['父ASIN','子ASIN','毛重','长','宽','高','ASP'];
const $=id=>document.getElementById(id);
const state={db:null,products:[],pendingImport:null,search:''};
const moneyFmt=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
const numberFmt=new Intl.NumberFormat('en-US',{maximumFractionDigits:3});
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]))}
function money(v){return moneyFmt.format(Number.isFinite(v)?v:0)}
function num(v){return numberFmt.format(Number(v)||0)}
function status(id,msg,kind){const el=$(id);if(!el)return;el.textContent=msg;el.className='status'+(kind?' '+kind:'')}
function keyOf(parent,child){return String(parent).toUpperCase()+'::'+String(child).toUpperCase()}
function normalizeAsin(v){return String(v==null?'':v).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\u00A0]/g,'').trim().replace(/^['’]/,'').toUpperCase()}
function validAsin(v){return /^[A-Z0-9]{10}$/.test(normalizeAsin(v))}
function normalizeProduct(p){
 const parentAsin=normalizeAsin(p.parentAsin),childAsin=normalizeAsin(p.childAsin);
 return {
  id:String(p.id||keyOf(parentAsin,childAsin)),parentAsin,childAsin,
  grossWeightLb:Number(p.grossWeightLb)||0,lengthIn:Number(p.lengthIn)||0,widthIn:Number(p.widthIn)||0,heightIn:Number(p.heightIn)||0,asp:Number(p.asp)||0,
  fbaAvailableAndTransfer:Math.max(0,Math.floor(Number(p.fbaAvailableAndTransfer)||0)),
  fbaActualInTransit:Math.max(0,Math.floor(Number(p.fbaActualInTransit)||0)),
  sourceFileName:String(p.sourceFileName||''),createdAt:p.createdAt||new Date().toISOString(),updatedAt:p.updatedAt||p.createdAt||new Date().toISOString()
 };
}
function openDB(){return new Promise((resolve,reject)=>{
 if(!window.indexedDB){reject(new Error('当前浏览器不支持本地商品资料库'));return}
 const req=indexedDB.open(DB_NAME,DB_VERSION);
 req.onupgradeneeded=()=>{
  const db=req.result;
  for(const name of ['products','templates',STORE])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
 };
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
})}
function getAll(){return new Promise((resolve,reject)=>{
 const req=state.db.transaction(STORE,'readonly').objectStore(STORE).getAll();
 req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
})}
function put(record){return new Promise((resolve,reject)=>{
 const tx=state.db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record);
 tx.oncomplete=()=>resolve(record);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
})}
function remove(id){return new Promise((resolve,reject)=>{
 const tx=state.db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);
 tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
})}
function replaceAll(records){return new Promise((resolve,reject)=>{
 const tx=state.db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);store.clear();
 records.forEach(p=>store.put(p));
 tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
})}
function parseNumber(value,label,line,allowZero){
 let raw=String(value==null?'':value).trim();
 if(typeof value==='number')raw=String(value);
 raw=raw.replace(/[$,\s]/g,'').replace(/lbs?|inches|inch|in/ig,'');
 if(!raw)throw new Error('第 '+line+' 行「'+label+'」为空');
 const n=Number(raw);
 if(!Number.isFinite(n)||n<0||(!allowZero&&n===0))throw new Error('第 '+line+' 行「'+label+'」不是有效的'+(allowZero?'非负':'大于 0 的')+'数字');
 return n;
}
function parseRows(rows,fileName){
 if(!rows.length)throw new Error('文件中没有商品数据');
 const header=(rows[0]||[]).slice();
 while(header.length&&String(header[header.length-1]||'').trim()==='')header.pop();
 const normalizeHeader=s=>String(s==null?'':s).normalize('NFKC').replace(/[\s_（）()\-]/g,'').toLowerCase();
 const actual=header.map(normalizeHeader),expected=HEADERS.map(normalizeHeader);
 if(actual.length!==expected.length||actual.some((v,i)=>v!==expected[i])){
  throw new Error('表头或列顺序不正确。必须严格按照：父ASIN、子ASIN、毛重、长、宽、高、ASP。不要添加库存列。');
 }
 const products=[],seen=new Set(),errors=[];
 for(let i=1;i<rows.length;i++){
  const row=(rows[i]||[]).slice();
  if(row.every(v=>String(v==null?'':v).trim()===''))continue;
  const line=i+1;
  try{
   if(row.slice(7).some(v=>String(v==null?'':v).trim()!==''))throw new Error('第 '+line+' 行包含第 8 列以后的额外数据');
   const parentAsin=normalizeAsin(row[0]),childAsin=normalizeAsin(row[1]);
   if(!validAsin(parentAsin))throw new Error('第 '+line+' 行父 ASIN 无效');
   if(!validAsin(childAsin))throw new Error('第 '+line+' 行子 ASIN 无效');
   const id=keyOf(parentAsin,childAsin);
   if(seen.has(id))throw new Error('第 '+line+' 行父 ASIN + 子 ASIN 重复');
   seen.add(id);
   const product=normalizeProduct({
    id,parentAsin,childAsin,
    grossWeightLb:parseNumber(row[2],'毛重（lb）',line,false),
    lengthIn:parseNumber(row[3],'长（in）',line,false),
    widthIn:parseNumber(row[4],'宽（in）',line,false),
    heightIn:parseNumber(row[5],'高（in）',line,false),
    asp:parseNumber(row[6],'ASP（USD）',line,true),
    sourceFileName:fileName
   });
   products.push(product);
  }catch(err){errors.push(err.message)}
 }
 if(!products.length)throw new Error(errors.length?errors.slice(0,8).join('；'):'没有可导入的商品行');
 if(errors.length)throw new Error('发现数据错误，未导入任何商品：'+errors.slice(0,10).join('；')+(errors.length>10?'；另有 '+(errors.length-10)+' 项错误':''));
 return products;
}
async function readFile(file){
 if(!window.XLSX)throw new Error('Excel 解析组件未加载，请刷新页面重试');
 const isCsv=/\.csv$/i.test(file.name);
 const input=isCsv?await file.text():await file.arrayBuffer();
 const workbook=XLSX.read(input,{type:isCsv?'string':'array',raw:true,cellDates:false});
 const first=workbook.SheetNames[0];
 if(!first)throw new Error('文件中没有工作表');
 const rows=XLSX.utils.sheet_to_json(workbook.Sheets[first],{header:1,defval:'',raw:true,blankrows:false});
 return parseRows(rows,file.name);
}
async function previewImport(){
 const file=$('productFile').files[0];if(!file)throw new Error('请先选择商品资料表');
 const products=await readFile(file);
 const parents=new Set(products.map(p=>p.parentAsin));
 state.pendingImport={products,fileName:file.name};
 $('confirmImport').disabled=false;
 $('importPreview').textContent='识别成功：'+parents.size+' 个父 ASIN、'+products.length+' 个子 ASIN。库存不在 Excel 中，导入后请在下方手动填写。相同父 ASIN + 子 ASIN 将更新商品资料，并保留已填写的库存。';
 status('importStatus','文件已通过格式与数据检查，确认后即可导入。','success');
}
async function saveImport(){
 if(!state.pendingImport)throw new Error('请先识别商品资料表');
 const importedFileName=state.pendingImport.fileName; const now=new Date().toISOString(),map=new Map(state.products.map(p=>[p.id,p]));
 let added=0,updated=0;
 for(const incoming of state.pendingImport.products){
  const old=map.get(incoming.id);
  const record=normalizeProduct({
   ...incoming,
   fbaAvailableAndTransfer:old?old.fbaAvailableAndTransfer:0,
   fbaActualInTransit:old?old.fbaActualInTransit:0,
   createdAt:old?old.createdAt:now,updatedAt:now
  });
  map.set(record.id,record);
  if(old)updated++;else added++;
 }
 const merged=[...map.values()].sort((a,b)=>a.parentAsin.localeCompare(b.parentAsin)||a.childAsin.localeCompare(b.childAsin));
 await replaceAll(merged);state.products=merged;state.pendingImport=null;$('confirmImport').disabled=true;$('productFile').value='';
 $('importPreview').textContent='已导入：'+importedFileName+'。库存数量已保留；新商品库存默认为 0。';
 status('importStatus','导入完成：新增 '+added+' 个子 ASIN，更新 '+updated+' 个子 ASIN。原有库存输入已保留；新商品库存默认为 0。','success');
 renderAll();
}
function sizeInfo(p){
 const dims=[p.lengthIn,p.widthIn,p.heightIn].sort((a,b)=>b-a);
 const standard=dims[0]<=18&&dims[1]<=14&&dims[2]<=8&&p.grossWeightLb<=20;
 return {standard,label:standard?'标准件':'大件',dims};
}
function removalUnitFee(p){
 const w=p.grossWeightLb,standard=sizeInfo(p).standard;
 if(standard){
  if(w<=0.5)return 0.84;if(w<=1)return 1.53;if(w<=2)return 2.27;
  return 2.89+(w-2)*1.06;
 }
 if(w<=1)return 3.12;if(w<=2)return 4.30;if(w<=4)return 6.36;if(w<=10)return 10.04;
 return 14.32+(w-10)*1.06;
}
function liquidationUnitFee(p){
 const w=p.grossWeightLb,standard=sizeInfo(p).standard;
 if(standard){
  if(w<=0.5)return 0.25;if(w<=1)return 0.30;if(w<=2)return 0.35;
  return 0.40+(w-2)*0.20;
 }
 if(w<=1)return 0.60;if(w<=2)return 0.70;if(w<=4)return 0.90;if(w<=10)return 1.45;
 return 1.90+(w-10)*0.20;
}
function calculate(p){
 const qty=p.fbaAvailableAndTransfer+p.fbaActualInTransit,removeFee=removalUnitFee(p),liquidationFee=liquidationUnitFee(p);
 const recovery5=qty*p.asp*0.05,recovery10=qty*p.asp*0.10;
 const commission5=recovery5*0.15,commission10=recovery10*0.15;
 const processing=qty*liquidationFee;
 return {
  qty,size:sizeInfo(p),removeUnit:removeFee,removeTotal:qty*removeFee,liquidationUnit:liquidationFee,processing,
  recovery5,commission5,net5:recovery5-commission5-processing,
  recovery10,commission10,net10:recovery10-commission10-processing
 };
}
function getTotals(products){
 return products.reduce((a,p)=>{
  const c=calculate(p);a.qty+=c.qty;a.removeTotal+=c.removeTotal;a.processing+=c.processing;
  a.recovery5+=c.recovery5;a.commission5+=c.commission5;a.net5+=c.net5;
  a.recovery10+=c.recovery10;a.commission10+=c.commission10;a.net10+=c.net10;
  return a;
 },{qty:0,removeTotal:0,processing:0,recovery5:0,commission5:0,net5:0,recovery10:0,commission10:0,net10:0});
}
function renderSummary(products){
 const t=getTotals(products),cards=[
  ['总库存',num(t.qty)+' 件','可售+待调仓+实际在途'],
  ['移除退回费用',money(t.removeTotal),'按当前移除费率估算'],
  ['弃置费用',money(t.removeTotal),'与移除费使用同一费率表'],
  ['清货处理费',money(t.processing),'按尺寸等级和毛重逐件计算'],
  ['清货净回款 · 5%',money(t.net5),'扣除 15% 佣金及处理费'],
  ['清货净回款 · 10%',money(t.net10),'扣除 15% 佣金及处理费']
 ];
 $('summaryCards').innerHTML=cards.map((x,i)=>'<div class="kpi"><span>'+esc(x[0])+'</span><strong class="'+(i>=3?(Number(x[1].replace(/[^0-9.-]/g,''))<0?'negative':''):'')+'">'+esc(x[1])+'</strong><small>'+esc(x[2])+'</small></div>').join('');
}
function renderProducts(){
 const host=$('productTable'),query=state.search.trim().toUpperCase();
 const items=state.products.filter(p=>!query||p.parentAsin.includes(query)||p.childAsin.includes(query));
 if(!items.length){host.innerHTML='<div class="empty">'+(state.products.length?'没有匹配的 ASIN。':'尚未导入商品资料，请先上传 Excel/CSV。')+'</div>';return}
 let html='<table><thead><tr><th>父 ASIN</th><th>子 ASIN</th><th>毛重<br>lb</th><th>包装尺寸<br>长 × 宽 × 高（in）</th><th>自动尺寸等级</th><th>ASP<br>USD</th><th>FBA 可售+待调仓<br>手动填写</th><th>FBA 实际在途<br>手动填写</th><th>总库存</th><th>移除/弃置<br>单件费</th><th>移除/弃置<br>总费用</th><th>清货处理费<br>总费用</th><th>清货净回款<br>5%</th><th>清货净回款<br>10%</th><th>操作</th></tr></thead><tbody>';
 for(const p of items){
  const c=calculate(p),id=esc(p.id);
  html+='<tr><td>'+esc(p.parentAsin)+'</td><td class="asin">'+esc(p.childAsin)+'</td><td class="numeric">'+num(p.grossWeightLb)+'</td><td>'+num(p.lengthIn)+' × '+num(p.widthIn)+' × '+num(p.heightIn)+'</td><td><span class="size-tag '+(c.size.standard?'standard':'large')+'">'+c.size.label+'</span></td><td class="numeric">'+money(p.asp)+'</td>';
  html+='<td><input class="stock-input" type="number" min="0" step="1" inputmode="numeric" data-id="'+id+'" data-field="fbaAvailableAndTransfer" aria-label="FBA 可售加待调仓数量" value="'+p.fbaAvailableAndTransfer+'"></td>';
  html+='<td><input class="stock-input" type="number" min="0" step="1" inputmode="numeric" data-id="'+id+'" data-field="fbaActualInTransit" aria-label="FBA 实际在途数量" value="'+p.fbaActualInTransit+'"></td>';
  html+='<td class="numeric strong">'+c.qty+'</td><td class="numeric">'+money(c.removeUnit)+'</td><td class="numeric">'+money(c.removeTotal)+'</td><td class="numeric">'+money(c.processing)+'</td><td class="numeric '+(c.net5<0?'negative':'')+'">'+money(c.net5)+'</td><td class="numeric '+(c.net10<0?'negative':'')+'">'+money(c.net10)+'</td><td><button class="text-button delete-product" data-id="'+id+'" type="button">删除</button></td></tr>';
 }
 html+='</tbody></table>';
 host.innerHTML=html;
 $('productCount').textContent='显示 '+items.length+' / '+state.products.length+' 个子 ASIN';
}
function renderComparison(products){
 const t=getTotals(products),rows=[
  ['批量清货（回收比例 5%）',t.recovery5,t.commission5,t.processing,t.net5,'按 ASP × 总库存 × 5% 估算回收价值'],
  ['批量清货（回收比例 10%）',t.recovery10,t.commission10,t.processing,t.net10,'按 ASP × 总库存 × 10% 估算回收价值'],
  ['移除退回（Return）',null,null,null,-t.removeTotal,'支付移除费用，商品退回后仍由你自行处理'],
  ['弃置（Disposal）',null,null,null,-t.removeTotal,'支付弃置费用，商品不再保留']
 ];
 $('comparisonTable').innerHTML='<table><thead><tr><th>处理方案</th><th>回收价值</th><th>销售佣金</th><th>处理费用</th><th>净现金结果</th><th>说明</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="strong">'+esc(r[0])+'</td><td class="numeric">'+(r[1]==null?'—':money(r[1]))+'</td><td class="numeric">'+(r[2]==null?'—':money(r[2]))+'</td><td class="numeric">'+(r[3]==null?'—':money(r[3]))+'</td><td class="numeric strong '+(r[4]<0?'negative':'positive')+'">'+(r[4]>=0?'+':'')+money(r[4])+'</td><td>'+esc(r[5])+'</td></tr>').join('')+'</tbody></table>';
 $('comparisonNote').textContent='退回与弃置按你提供的费率资料使用同一单件收费标准，因此现金费用相同；两者的区别是退回后保留商品，弃置则不保留。退回商品的后续残值/二次销售收入未计入净现金结果。移除/弃置费用按商品实际移除或弃置数量逐件计算。';
}
function renderAll(){
 const filtered=state.products.filter(p=>!state.search||p.parentAsin.includes(state.search.toUpperCase())||p.childAsin.includes(state.search.toUpperCase()));
 renderSummary(state.products);renderProducts();renderComparison(state.products);
 $('emptyState').classList.toggle('hidden',state.products.length>0);
 $('resultSections').classList.toggle('hidden',state.products.length===0);
 $('downloadResults').disabled=state.products.length===0;
 $('productCount').textContent='共 '+state.products.length+' 个子 ASIN';
}
function downloadTemplate(){
 if(!window.XLSX)throw new Error('Excel 组件未加载');
 const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([HEADERS]);
 ws['!cols']=[{wch:18},{wch:18},{wch:12},{wch:10},{wch:10},{wch:10},{wch:12}];
 XLSX.utils.book_append_sheet(wb,ws,'商品资料');
 const note=XLSX.utils.aoa_to_sheet([
  ['清货与移除费用计算器｜商品资料表填写说明'],
  ['第一张工作表必须按以下顺序提供 7 列：父ASIN、子ASIN、毛重、长、宽、高、ASP。'],
  ['每行对应一个子 ASIN；父 ASIN 需要在每一行填写。'],
  ['毛重：领星商品信息中的毛重，单位 lb。不要使用净重或其他重量字段。'],
  ['长、宽、高：商品包装尺寸，单位 in（英寸）。'],
  ['ASP：平均销售价格，单位 USD（美元）。'],
  ['库存不放在本 Excel 中；导入后在计算器页面手动填写 FBA 可售+待调仓、FBA 实际在途。'],
  ['计费重量暂时直接使用领星毛重，不额外进位，不计算体积重。']
 ]);
 note['!cols']=[{wch:115}];XLSX.utils.book_append_sheet(wb,note,'填写说明');
 XLSX.writeFile(wb,'清货与移除费用计算器_商品资料模板.xlsx');
}
function exportResults(){
 const rows=[['父ASIN','子ASIN','毛重(lb)','长(in)','宽(in)','高(in)','自动尺寸等级','ASP(USD)','FBA可售+待调仓','FBA实际在途','总库存','移除/弃置单件费','移除/弃置总费用','清货处理费单件','清货处理费总额','5%清货回收价值','5%销售佣金','5%清货净回款','10%清货回收价值','10%销售佣金','10%清货净回款']];
 for(const p of state.products){
  const c=calculate(p);
  rows.push([p.parentAsin,p.childAsin,p.grossWeightLb,p.lengthIn,p.widthIn,p.heightIn,c.size.label,p.asp,p.fbaAvailableAndTransfer,p.fbaActualInTransit,c.qty,c.removeUnit,c.removeTotal,c.liquidationUnit,c.processing,c.recovery5,c.commission5,c.net5,c.recovery10,c.commission10,c.net10]);
 }
 const ws=XLSX.utils.aoa_to_sheet(rows);ws['!cols']=rows[0].map((_,i)=>({wch:i<2?18:i===6?15:16}));
 const totals=getTotals(state.products);
 const compare=XLSX.utils.aoa_to_sheet([
  ['处理方案','净现金结果（USD）','说明'],
  ['批量清货（5%）',totals.net5,'已扣除 15% 销售佣金和清货处理费'],
  ['批量清货（10%）',totals.net10,'已扣除 15% 销售佣金和清货处理费'],
  ['移除退回（Return）',-totals.removeTotal,'退回后仍保留商品；未计入后续残值'],
  ['弃置（Disposal）',-totals.removeTotal,'弃置后不再保留商品']
 ]);
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'商品费用明细');XLSX.utils.book_append_sheet(wb,compare,'方案对比');
 XLSX.writeFile(wb,'FBA清货与移除费用对比_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
async function onTableChange(event){
 const input=event.target.closest('.stock-input');if(!input)return;
 const record=state.products.find(p=>p.id===input.dataset.id);if(!record)return;
 const value=Number(input.value);
 if(!Number.isFinite(value)||value<0||!Number.isInteger(value)){input.value=record[input.dataset.field];status('inventoryStatus','库存数量必须填写大于或等于 0 的整数。','error');return}
 record[input.dataset.field]=value;record.updatedAt=new Date().toISOString();
 try{await put(record);status('inventoryStatus','库存已保存到当前浏览器商品库。','success');renderAll()}catch(err){status('inventoryStatus','库存保存失败：'+err.message,'error')}
}
async function onTableClick(event){
 const button=event.target.closest('.delete-product');if(!button)return;
 const id=button.dataset.id,record=state.products.find(p=>p.id===id);if(!record)return;
 if(!confirm('确定删除 '+record.childAsin+' 的清货计费资料和库存记录吗？'))return;
 await remove(id);state.products=state.products.filter(p=>p.id!==id);renderAll();
 status('inventoryStatus','已删除 '+record.childAsin+'。','success');
}
function initEvents(){
 $('productFile').addEventListener('change',()=>{
  state.pendingImport=null;$('confirmImport').disabled=true;
  const file=$('productFile').files[0];if(file)status('importStatus','已选择 '+file.name+'。点击「识别并检查」读取表格。');
 });
 $('previewImport').addEventListener('click',async()=>{
  const button=$('previewImport');button.disabled=true;
  try{status('importStatus','正在读取并检查商品资料…');await previewImport()}
  catch(err){state.pendingImport=null;$('confirmImport').disabled=true;status('importStatus',err.message,'error')}
  finally{button.disabled=false}
 });
 $('confirmImport').addEventListener('click',async()=>{
  const button=$('confirmImport');button.disabled=true;
  try{await saveImport()}
  catch(err){status('importStatus','导入失败：'+err.message,'error');button.disabled=false}
 });
 $('downloadTemplate').addEventListener('click',()=>{try{downloadTemplate()}catch(err){status('importStatus',err.message,'error')}});
 $('downloadResults').addEventListener('click',()=>{try{exportResults()}catch(err){status('inventoryStatus',err.message,'error')}});
 $('productSearch').addEventListener('input',()=>{state.search=$('productSearch').value.trim();renderProducts()});
 $('productTable').addEventListener('change',onTableChange);
 $('productTable').addEventListener('click',onTableClick);
}
async function start(){
 try{
  state.db=await openDB();state.products=(await getAll()).map(normalizeProduct).sort((a,b)=>a.parentAsin.localeCompare(b.parentAsin)||a.childAsin.localeCompare(b.childAsin));
  initEvents();renderAll();
  status('inventoryStatus',state.products.length?'已读取本地商品资料。库存修改后自动保存。':'导入商品资料后，在列表中填写库存。');
 }catch(err){status('importStatus','本地商品库启动失败：'+err.message,'error')}
}
document.addEventListener('DOMContentLoaded',start);
})();