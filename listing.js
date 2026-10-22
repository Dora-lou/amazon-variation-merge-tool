/* Amazon Listing editor and local product library. All Excel files stay in this browser. */
(function(){
'use strict';
const DB_NAME='amazonOpsToolkit', DB_VERSION=2;
const $=id=>document.getElementById(id);
const state={db:null,products:[],templates:[],template:null,templateRecord:null,product:null,editingProductId:null,bulletCount:5,pendingProductImport:null,productPage:1,pendingBackupFile:null};
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XNS='http://www.w3.org/XML/1998/namespace';
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function safe(v){return String(v==null?'':v).replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]))}
function setStatus(id,msg,kind){const el=$(id);if(!el)return;el.textContent=msg;el.className='notice'+(kind?' '+kind:'')}
function showPage(which){
 $('listingWorkspace').classList.toggle('hidden',which!=='listing');
 $('libraryWorkspace').classList.toggle('hidden',which!=='library');
 $('openListingTab').classList.toggle('active',which==='listing');
 $('openLibraryTab').classList.toggle('active',which==='library');
 if(which==='library')showLibraryTab('templates');
}
function showLibraryTab(which){
 $('templateLibraryPane').classList.toggle('hidden',which!=='templates');
 $('productLibraryPane').classList.toggle('hidden',which!=='products');
 $('openTemplateLibraryTab').classList.toggle('active',which==='templates');
 $('openProductLibraryTab').classList.toggle('active',which==='products');
}
function openDB(){return new Promise((resolve,reject)=>{
 if(!window.indexedDB){reject(new Error('当前浏览器不支持本地资料库'));return}
 const req=indexedDB.open(DB_NAME,DB_VERSION);
 req.onupgradeneeded=()=>{
  const db=req.result;
  if(db.objectStoreNames.contains('history'))db.deleteObjectStore('history');
  for(const name of ['products','templates'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
 };
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
})}
function getAll(store){return new Promise((resolve,reject)=>{const req=state.db.transaction(store,'readonly').objectStore(store).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error)})}
function put(store,record){return new Promise((resolve,reject)=>{const tx=state.db.transaction(store,'readwrite');tx.objectStore(store).put(record);tx.oncomplete=()=>resolve(record);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
function remove(store,id){return new Promise((resolve,reject)=>{const tx=state.db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
async function refreshAll(){
 const saved=await getAll('products');
 state.products=saved.map(p=>({
  id:p.id||uid(),parentAsin:String(p.parentAsin||'').trim().toUpperCase(),
  children:(p.children||[]).map(c=>({asin:String(c.asin||'').trim().toUpperCase(),sku:String(c.sku||'').trim()})),
  createdAt:p.createdAt||new Date().toISOString(),updatedAt:p.updatedAt||p.createdAt||new Date().toISOString()
 })).sort((a,b)=>a.parentAsin.localeCompare(b.parentAsin));
 state.templates=(await getAll('templates')).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
 if(state.product)state.product=state.products.find(p=>p.id===state.product.id)||null;
 renderTemplates();renderProducts();renderProductOptions();renderTemplateTable();
 if(state.product)renderChildChoices(state.product);
}
function bytesLabel(n){if(!n)return '—';return n>1024*1024?(n/1024/1024).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
function dateLabel(v){try{return new Date(v).toLocaleString()}catch(_){return String(v||'')}}
function addOption(sel,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;sel.appendChild(o)}
function normalizeHeader(s){return String(s||'').toLowerCase().replace(/[\s_\-./（）()：:]+/g,'').trim()}
function splitLine(line){const delim=line.includes('\t')?'\t':',';if(delim==='\t')return line.split('\t').map(x=>x.trim());const out=[];let cell='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&line[i+1]==='"'&&quoted){cell+='"';i++}else if(ch==='"'){quoted=!quoted}else if(ch===','&&!quoted){out.push(cell.trim());cell=''}else cell+=ch}out.push(cell.trim());return out}
function parseDelimited(text){const lines=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());if(lines.length<2)throw new Error('请至少粘贴一行表头和一行商品数据');const delim=lines[0].includes('\t')?'\t':',';return lines.map(line=>delim==='\t'?line.split('\t').map(x=>x.trim()):splitLine(line))}
function parseChildLines(text){
 const rows=[];
 for(const line of String(text||'').split(/\r?\n/).filter(x=>x.trim())){
  const vals=line.includes('\t')?line.split('\t'):line.split(',');
  const asin=normalizeAsin(vals[0]),sku=String(vals[1]||'').trim();
  if(asin||sku)rows.push({asin,sku});
 }
 return rows;
}
function normalizeAsin(v){return String(v??'').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\u00A0]/g,'').trim().replace(/^['’]/,'').toUpperCase()}
 function validateAsin(v){return /^[A-Z0-9]{10}$/.test(normalizeAsin(v))}
function assertNoCrossGroupConflicts(parentAsin,children,excludeId){
 const otherChildren=state.products.filter(p=>p.id!==excludeId&&p.parentAsin!==parentAsin).flatMap(p=>(p.children||[]).map(c=>({...c,parentAsin:p.parentAsin})));
 for(const child of children){
  const sameAsin=otherChildren.find(c=>c.asin===child.asin);
  if(sameAsin)throw new Error('子 ASIN '+child.asin+' 已在商品库中归属于父 ASIN '+sameAsin.parentAsin+'，请先核对重复关系');
  // SKU 可以在不同父 ASIN 分组中重复；后续先筛选父 ASIN，再选择 SKU，因此不做跨父体 SKU 唯一性校验。
 }
}
function resetProductForm(){
 state.editingProductId=null;
 $('productParentAsin').value='';$('productChildren').value='';
 $('saveProductGroup').textContent='保存商品组';
 setStatus('productFormStatus','每行一个子体，按「子 ASIN、SKU」顺序填写。');
}
function editProduct(id){
 const p=state.products.find(x=>x.id===id);if(!p)return;
 state.editingProductId=id;$('productParentAsin').value=p.parentAsin||'';
 $('productChildren').value=(p.children||[]).map(c=>[c.asin,c.sku].join('\t')).join('\n');
 $('saveProductGroup').textContent='保存修改';
 setStatus('productFormStatus','正在编辑父 ASIN：'+p.parentAsin);
 showPage('library');showLibraryTab('products');
 window.scrollTo({top:0,behavior:'smooth'});
}
async function saveProductGroup(){
 const parentAsin=normalizeAsin($('productParentAsin').value);
 const children=parseChildLines($('productChildren').value);
 if(!validateAsin(parentAsin))throw new Error('父 ASIN 格式应为 10 位字母或数字');
 if(!children.length)throw new Error('请至少添加一个子 ASIN 和子 SKU');
 const seenAsin=new Set(),seenSku=new Set();
 for(let i=0;i<children.length;i++){
  const c=children[i];
  if(!validateAsin(c.asin))throw new Error('第 '+(i+1)+' 个子体 ASIN 格式不正确');
  if(!c.sku)throw new Error('第 '+(i+1)+' 个子体缺少 SKU');
  if(seenAsin.has(c.asin))throw new Error('子 ASIN 重复：'+c.asin);
  if(seenSku.has(c.sku))throw new Error('子 SKU 重复：'+c.sku);
  seenAsin.add(c.asin);seenSku.add(c.sku);
 }
 const old=state.products.find(p=>p.id===state.editingProductId)||state.products.find(p=>p.parentAsin===parentAsin);
 assertNoCrossGroupConflicts(parentAsin,children,old?.id);
 const record={id:old?old.id:uid(),parentAsin,children,createdAt:old?old.createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 await put('products',record);await refreshAll();resetProductForm();
 setStatus('productFormStatus','商品组已保存。生成上传表时，程序会根据子 ASIN 自动匹配 SKU。');
}
function renderProducts(){
 const host=$('productLibraryTable'),query=String($('productLibrarySearch')?.value||'').trim().toUpperCase();
 host.innerHTML='';
 const items=state.products.filter(p=>!query||p.parentAsin.includes(query));
 const pageSize=5,pageCount=Math.max(1,Math.ceil(items.length/pageSize));
 state.productPage=Math.min(Math.max(1,state.productPage||1),pageCount);
 if(!items.length){host.textContent=state.products.length?'没有匹配的父 ASIN。':'暂无商品资料。请先在上方「模块一｜导入商品」中添加或导入。';return}
 const table=document.createElement('table');table.className='data-table';
 table.innerHTML='<thead><tr><th>父 ASIN</th><th>子体数量</th><th>子 ASIN / SKU 对应关系</th><th>操作</th></tr></thead><tbody></tbody>';
 const body=table.querySelector('tbody'),start=(state.productPage-1)*pageSize,pageItems=items.slice(start,start+pageSize);
 for(const p of pageItems){
  const tr=document.createElement('tr');
  [p.parentAsin,String((p.children||[]).length),(p.children||[]).map(c=>c.asin+'　→　'+c.sku).join('\n')].forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===2)td.style.whiteSpace='pre-line';tr.appendChild(td)});
  const actions=document.createElement('td'),edit=document.createElement('button'),del=document.createElement('button');
  edit.textContent='编辑';edit.addEventListener('click',()=>editProduct(p.id));
  del.textContent='删除';del.className='danger';del.addEventListener('click',async()=>{if(!confirm('确定从商品库删除父 ASIN '+p.parentAsin+' 及其 SKU 对应关系？'))return;await remove('products',p.id);if(state.product?.id===p.id){state.product=null;renderChildChoices(null)}await refreshAll()});
  actions.append(edit,del);tr.appendChild(actions);body.appendChild(tr);
 }
 host.appendChild(table);
 const pager=document.createElement('div');pager.className='pagination';
 const info=document.createElement('span');info.className='pagination-info';info.textContent='共 '+items.length+' 个父 ASIN，每页最多 5 行';
 const controls=document.createElement('div');controls.className='pagination-buttons';
 const prev=document.createElement('button');prev.type='button';prev.textContent='上一页';prev.disabled=state.productPage<=1;prev.addEventListener('click',()=>{state.productPage--;renderProducts()});
 const page=document.createElement('span');page.className='page-number';page.textContent='第 '+state.productPage+' / '+pageCount+' 页';
 const next=document.createElement('button');next.type='button';next.textContent='下一页';next.disabled=state.productPage>=pageCount;next.addEventListener('click',()=>{state.productPage++;renderProducts()});
 controls.append(prev,page,next);pager.append(info,controls);host.appendChild(pager);
}
function importHeaderMap(row){const h=row.map(normalizeHeader),idx=names=>h.findIndex(x=>names.includes(x));const parentAsin=idx(['parentasin','父asin','父体asin','父级asin','父商品asin','父asin码']);let childAsin=idx(['childasin','子asin','子体asin','子级asin','子商品asin','子asin码']);if(childAsin<0)childAsin=idx(['asin','商品asin','亚马逊asin']);const childSku=idx(['childsku','childsellersku','childmerchantsku','子sku','子体sku','子级sku','sellersku','merchantsku','sku','卖家sku','商家sku','商品sku']);return{category:idx(['category','productcategory','itemcategory','商品分类','商品类目','类目','分类']),parentAsin,parentSku:idx(['parentsku','父sku','父体sku','父级sku']),childAsin,childSku,brand:idx(['brand','brandname','品牌','品牌名称']),title:idx(['childtitle','title','itemname','商品标题','标题','原标题','子体标题']),color:idx(['color','颜色']),size:idx(['size','尺寸','大小']),header:h}}
function detectImportHeader(rows){let best=null;for(let r=0;r<Math.min(rows.length,30);r++){const map=importHeaderMap(rows[r]||[]);if(map.parentAsin>=0&&map.childAsin>=0&&map.childSku>=0){const score=4+(map.category>=0?1:0)+(map.brand>=0?1:0)+(map.parentSku>=0?1:0);if(!best||score>best.score)best={rowIndex:r,map,score}}}return best}
function parseProductImportSheet(rows,defaultCategory,sheetName){
 const found=detectImportHeader(rows);if(!found)return null;
 const ix=found.map,grouped=new Map(),errors=[],childToParent=new Map();
 let lastParent='',validRows=0;
 for(let r=found.rowIndex+1;r<rows.length;r++){
  const row=rows[r]||[],get=k=>ix[k]>=0?String(row[ix[k]]??'').trim():'';
  const childRaw=get('childAsin'),sku=get('childSku');if(!childRaw&&!sku)continue;
  const parentRaw=normalizeAsin(get('parentAsin'));if(parentRaw)lastParent=parentRaw;
  const parentAsin=normalizeAsin(parentRaw||lastParent),childAsin=normalizeAsin(childRaw),lineNo=r+1;
  if(!validateAsin(parentAsin)){const rawParent=ix.parentAsin>=0?String(row[ix.parentAsin]??''):'';errors.push('「'+sheetName+'」第 '+lineNo+' 行父 ASIN 缺失或格式不正确（读取值：'+JSON.stringify(rawParent)+'；识别列：'+String(rows[found.rowIndex][ix.parentAsin]??'父 ASIN')+'）');continue}
  if(!validateAsin(childAsin)){const rawChild=ix.childAsin>=0?String(row[ix.childAsin]??''):'';errors.push('「'+sheetName+'」第 '+lineNo+' 行子 ASIN 缺失或格式不正确（读取值：'+JSON.stringify(rawChild)+'）');continue}
  if(!sku){errors.push('「'+sheetName+'」第 '+lineNo+' 行缺少 SKU');continue}
  const prevParent=childToParent.get(childAsin);
  if(prevParent&&prevParent!==parentAsin){errors.push('子 ASIN '+childAsin+' 被分配给多个父 ASIN：'+prevParent+' / '+parentAsin);continue}
  childToParent.set(childAsin,parentAsin);
  let g=grouped.get(parentAsin);if(!g){g={parentAsin,children:[],sourceSheet:sheetName};grouped.set(parentAsin,g)}
  const c={asin:childAsin,sku},prior=g.children.find(x=>x.asin===childAsin);
  if(prior&&prior.sku!==sku)errors.push('同一子 ASIN '+childAsin+' 出现不同 SKU：'+prior.sku+' / '+sku);
  else if(!prior)g.children.push(c);
  validRows++;
 }
 return{groups:[...grouped.values()],errors,validRows,sheetName,headerRow:found.rowIndex+1,columns:{parentAsin:rows[found.rowIndex][ix.parentAsin],childAsin:rows[found.rowIndex][ix.childAsin],sku:rows[found.rowIndex][ix.childSku]}};
}
function mergeImportResults(parts){
 const groups=new Map(),errors=[],childToParent=new Map();let validRows=0;
 for(const part of parts){
  errors.push(...part.errors);validRows+=part.validRows;
  for(const g of part.groups){
   let target=groups.get(g.parentAsin);
   if(!target){target={parentAsin:g.parentAsin,children:[],sourceSheets:[g.sourceSheet]};groups.set(g.parentAsin,target)}
   else target.sourceSheets.push(g.sourceSheet);
   for(const c of g.children){
    const previousParent=childToParent.get(c.asin);
    if(previousParent&&previousParent!==g.parentAsin){errors.push('子 ASIN '+c.asin+' 在多个父 ASIN 中出现：'+previousParent+' / '+g.parentAsin);continue}
    childToParent.set(c.asin,g.parentAsin);
    const same=target.children.find(x=>x.asin===c.asin);
    if(same){if(same.sku!==c.sku)errors.push('子 ASIN '+c.asin+' 出现不同 SKU：'+same.sku+' / '+c.sku)}
    else target.children.push({asin:c.asin,sku:c.sku});
   }
  }
 }
 return{groups:[...groups.values()],errors,validRows,sheets:parts.map(p=>p.sheetName)};
}
async function previewProductExcel(){
 const file=$('productExcelFile').files[0];if(!file)throw new Error('请先选择商品资料 Excel 文件');
 const parts=[];
 if(/\.csv$/i.test(file.name)){
  const parsed=parseProductImportSheet(parseDelimited(await file.text()),'',file.name);if(parsed)parts.push(parsed);
 }else{
  if(!window.XLSX)throw new Error('Excel 解析组件未加载，请刷新页面后重试');
  const wb=XLSX.read(await file.arrayBuffer(),{type:'array',raw:false,cellDates:false});
  for(const name of wb.SheetNames){const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,defval:'',raw:false,blankrows:false});const parsed=parseProductImportSheet(rows,'',name);if(parsed&&parsed.groups.length)parts.push(parsed)}
 }
 if(!parts.length)throw new Error('没有识别到包含「父 ASIN、子 ASIN、SKU」的表头。请确认表头在前 30 行内，且列名清晰。');
 const result=mergeImportResults(parts);
 if(!result.groups.length)throw new Error('没有识别到有效商品记录。');
 if(result.errors.length)throw new Error('发现资料冲突或缺失，暂未导入：'+result.errors.slice(0,8).join('；')+(result.errors.length>8?'；另有 '+(result.errors.length-8)+' 项问题':''));
 const childCount=result.groups.reduce((n,g)=>n+g.children.length,0);
 state.pendingProductImport={...result,fileName:file.name};
 $('importExcelProducts').disabled=false;
 setStatus('importPreview','识别成功：'+parts.length+' 个工作表，'+result.groups.length+' 个父 ASIN，'+childCount+' 个唯一子 ASIN，'+result.validRows+' 行有效记录。识别列：'+parts.map(p=>p.sheetName+'（父 ASIN：'+p.columns.parentAsin+'；子 ASIN：'+p.columns.childAsin+'；SKU：'+p.columns.sku+'）').join('；')+'。请确认无误后点击「确认导入并保存」。');
}
async function saveProductExcelImport(){
 const data=state.pendingProductImport;if(!data)throw new Error('请先识别并统计 Excel 文件');
 let importedChildren=0;
 for(const g of data.groups){
  const old=state.products.find(p=>p.parentAsin===g.parentAsin),merged=old?(old.children||[]).map(c=>({asin:c.asin,sku:c.sku})):[];
  for(const c of g.children){const at=merged.findIndex(x=>x.asin===c.asin);if(at>=0)merged[at]={asin:c.asin,sku:c.sku};else merged.push({asin:c.asin,sku:c.sku})}
  const seenSku=new Map(),seenAsin=new Set();
  for(const c of merged){
   if(seenAsin.has(c.asin))throw new Error('保存前发现重复子 ASIN：'+c.asin);
   seenAsin.add(c.asin);
   if(seenSku.has(c.sku)&&seenSku.get(c.sku)!==c.asin)throw new Error('保存前发现重复 SKU：'+c.sku+'，请先核对商品库');
   seenSku.set(c.sku,c.asin);
  }
  assertNoCrossGroupConflicts(g.parentAsin,merged,old?.id);
  importedChildren+=g.children.length;
  await put('products',{id:old?old.id:uid(),parentAsin:g.parentAsin,children:merged,createdAt:old?old.createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 }
 await refreshAll();
 setStatus('importStatus','导入完成：更新 '+data.groups.length+' 个父 ASIN、'+importedChildren+' 个子 ASIN。商品库已保存到当前浏览器。');
 setStatus('importPreview','最近一次导入：'+data.fileName+'；'+data.groups.length+' 个父体、'+importedChildren+' 个子体。再次导入同一父 ASIN 时，会更新匹配到的子体，并保留该组中未出现在文件里的旧子体。');
 state.pendingProductImport=null;$('importExcelProducts').disabled=true;
}
async function importProductRows(){
 const rows=parseDelimited($('productImportText').value),parsed=parseProductImportSheet(rows,'','粘贴内容');
 if(!parsed)throw new Error('没有识别到父 ASIN、子 ASIN 和 SKU 表头');
 const result=mergeImportResults([parsed]);if(result.errors.length)throw new Error(result.errors.slice(0,8).join('；'));
 if(!result.groups.length)throw new Error('没有识别到有效商品行');
 state.pendingProductImport={...result,fileName:'粘贴内容'};await saveProductExcelImport();$('productImportText').value='';
}
function renderTemplates(){const sel=$('listingTemplateSelect'),prior=sel.value;sel.innerHTML='';addOption(sel,'','请选择已保存的类目模板');for(const t of state.templates)addOption(sel,t.id,t.category+'｜'+t.filename);if(state.templates.some(t=>t.id===prior))sel.value=prior}
function renderTemplateTable(){
 const host=$('savedTemplateTable');host.innerHTML='';
 if(!state.templates.length){host.textContent='暂无已保存模板。请在这里添加对应类目的空白 Excel 模板。';return}
 const table=document.createElement('table');table.className='data-table';
 table.innerHTML='<thead><tr><th>类目名称</th><th>模板文件</th><th>大小</th><th>更新时间</th><th>操作</th></tr></thead><tbody></tbody>';
 const body=table.querySelector('tbody');
 for(const t of state.templates){
  const tr=document.createElement('tr');
  [t.category,t.filename,bytesLabel(t.size),dateLabel(t.updatedAt||t.createdAt)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});
  const td=document.createElement('td'),del=document.createElement('button');del.textContent='删除模板';del.className='danger';
  del.addEventListener('click',async()=>{if(!confirm('确定删除类目模板 '+t.category+'？'))return;await remove('templates',t.id);if(state.templateRecord?.id===t.id){state.template=null;state.templateRecord=null}await refreshAll();setStatus('libraryStatus','模板已删除。');setStatus('templateLibraryStatus','模板已删除。')});
  td.appendChild(del);tr.appendChild(td);body.appendChild(tr);
 }
 host.appendChild(table);
}
function renderProductOptions(){
 const sel=$('listingProductSelect'),prior=sel.value,query=String($('listingParentAsinSearch')?.value||'').trim().toUpperCase();
 sel.innerHTML='';addOption(sel,'','请选择父 ASIN');
 const visible=state.products.filter(p=>!query||p.parentAsin.includes(query));
 for(const p of visible)addOption(sel,p.id,p.parentAsin+'（'+(p.children||[]).length+' 个子体）');
 if(visible.some(p=>p.id===prior))sel.value=prior;else sel.value='';
}
function renderChildChoices(product,onlyAsin){
 const sel=$('listingChildSelect'),host=$('listingChildChecklist');sel.innerHTML='';host.innerHTML='';
 if(!product){sel.disabled=true;addOption(sel,'','请先搜索父 ASIN');host.textContent='选择父 ASIN 后，程序会列出全部子 ASIN。';return}
 sel.disabled=false;addOption(sel,'__all__','全部子体（下方可勾选）');
 for(const c of product.children||[])addOption(sel,c.asin,c.asin);
 sel.value=onlyAsin||'__all__';
 for(const c of product.children||[]){
  const label=document.createElement('label');label.className='child-choice';
  const box=document.createElement('input');box.type='checkbox';box.value=c.asin;box.checked=!onlyAsin||onlyAsin===c.asin;
  const span=document.createElement('span');span.textContent=c.asin;
  label.append(box,span);host.appendChild(label);
 }
}
function searchParentAsin(){
 const query=String($('listingParentAsinSearch').value||'').trim().toUpperCase();
 renderProductOptions();
 const exact=query?state.products.find(p=>p.parentAsin===query):null;
 if(exact){$('listingProductSelect').value=exact.id;onProductChange();return}
 $('listingProductSelect').value='';state.product=null;renderChildChoices(null);
 setStatus('listingProductStatus',query?'请选择下拉列表中匹配的父 ASIN；输入完整父 ASIN 时会自动选中。':'搜索并选择父 ASIN 后，程序会匹配全部子 ASIN。');
}
function setChildChecks(checked){$('listingChildChecklist').querySelectorAll('input[type="checkbox"]').forEach(box=>{box.checked=checked})}
function findTemplateForCategory(category){return state.templates.find(t=>t.category.toLowerCase()===String(category||'').toLowerCase())}
async function loadTemplate(id){
 const rec=state.templates.find(t=>t.id===id);
 if(!rec){state.template=null;state.templateRecord=null;setStatus('listingTemplateStatus','请先选择已保存的类目模板。','warn');$('advancedFieldSelect').innerHTML='';return}
 try{
  setStatus('listingTemplateStatus','正在识别模板字段…');
  state.template=await VariationEngine.inspect(await rec.blob.arrayBuffer(),rec.filename);state.templateRecord=rec;renderAdvancedOptions();
  const count=bulletColumns(state.template).length;
  setStatus('listingTemplateStatus','已加载「'+rec.category+'」模板：识别到 '+Object.keys(state.template.headers).length+' 个字段、'+count+' 个 Bullet Point 列。');
  setStatus('templateLibraryStatus','已加载模板：'+rec.category);
 }catch(err){state.template=null;state.templateRecord=null;setStatus('listingTemplateStatus',err.message,'error');setStatus('templateLibraryStatus',err.message,'error')}
}
async function uploadTemplate(){
 const file=$('listingTemplateFile').files[0];if(!file)return;
 const category=$('listingTemplateName').value.trim();
 if(!category){setStatus('templateLibraryStatus','请先填写类目名称。','error');return}
 if(!/\.(xlsx|xlsm)$/i.test(file.name)){setStatus('templateLibraryStatus','只支持 .xlsx 或 .xlsm 模板。','error');return}
 try{
  await VariationEngine.inspect(await file.arrayBuffer(),file.name);
  const old=state.templates.find(t=>t.category.toLowerCase()===category.toLowerCase());
  if(old&&!confirm('已存在「'+category+'」模板：'+old.filename+'。是否用新文件替换？'))return;
  const record={id:old?old.id:uid(),category,filename:file.name,blob:new Blob([await file.arrayBuffer()],{type:file.type||'application/octet-stream'}),size:file.size,createdAt:old?old.createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await put('templates',record);await refreshAll();
  $('listingTemplateSelect').value=record.id;$('listingTemplateName').value='';$('listingTemplateFile').value='';
  await loadTemplate(record.id);
  setStatus('templateLibraryStatus','类目模板已保存。下次可在「修改商品信息」中直接选择。');
 }catch(err){setStatus('templateLibraryStatus',err.message,'error')}
}
function bulletColumns(t){return Object.entries(t.headers).map(([col,id])=>{const m=/^bullet_point\[/.test(id)?/#(\d+)\.value$/.exec(id):null;return m?{col:Number(col),order:Number(m[1]),id}:null}).filter(Boolean).sort((a,b)=>a.order-b.order)}
function highlightColumns(t){return Object.entries(t.headers).map(([col,id])=>({col:Number(col),id:String(id||''),label:String(t.labels?.[col]||'')})).filter(x=>/^(title_differentiation|product_highlights?|key_product_features)(\[|#|$)/i.test(x.id)||/(item\s*highlight|product\s*highlights?|key\s*product\s*features|亮点)/i.test(x.label)).sort((a,b)=>{const ma=/#(\d+)\.value$/i.exec(a.id),mb=/#(\d+)\.value$/i.exec(b.id);return (ma?Number(ma[1]):a.col)-(mb?Number(mb[1]):b.col)})}
function renderBulletInputs(values){const host=$('listingBulletFields');host.innerHTML='';const count=Math.max(5,values?values.length:0);state.bulletCount=count;for(let i=0;i<count;i++){const wrap=document.createElement('div'),label=document.createElement('label'),area=document.createElement('textarea');label.textContent='Bullet Point '+(i+1);area.dataset.bulletIndex=String(i+1);area.placeholder='填写要更新的第 '+(i+1)+' 条卖点；留空则不写入该字段';area.value=values&&values[i]||'';wrap.append(label,area);if(i>=5){const del=document.createElement('button');del.type='button';del.className='quiet danger';del.textContent='移除此条';del.addEventListener('click',()=>{const vals=readBulletValues();vals.splice(i,1);renderBulletInputs(vals)});wrap.appendChild(del)}host.appendChild(wrap)}}
function readBulletValues(){return [...$('listingBulletFields').querySelectorAll('textarea[data-bullet-index]')].map(el=>el.value.trim())}
function renderAdvancedOptions(){const sel=$('advancedFieldSelect');sel.innerHTML='';addOption(sel,'','选择一个额外字段');if(!state.template)return;const reserved=['contribution_sku','::record_action','product_id','parentage_level','child_parent_sku_relationship','variation_theme','item_name[','product_description[','bullet_point[','title_differentiation[','product_highlight[','product_highlights[','key_product_features['];for(const f of state.template.meta.field_options){if(reserved.some(x=>f.id.toLowerCase().includes(x)))continue;addOption(sel,f.id,(f.label||f.id)+' ['+f.id+']')}}
function addAdvancedField(){const sel=$('advancedFieldSelect'),fieldId=sel.value;if(!fieldId)return;const existing=[...$('advancedFieldRows').querySelectorAll('[data-field-id]')].some(el=>el.dataset.fieldId===fieldId);if(existing){setStatus('listingResult','这个字段已经添加过了。','warn');return}const opt=sel.options[sel.selectedIndex],wrap=document.createElement('div');wrap.className='advanced-row';wrap.dataset.fieldId=fieldId;const label=document.createElement('label');label.textContent=opt.textContent;const input=document.createElement('textarea');input.rows=2;input.placeholder='填写需要更新的字段值';const del=document.createElement('button');del.type='button';del.className='quiet danger';del.textContent='移除';del.addEventListener('click',()=>wrap.remove());wrap.append(label,input,del);$('advancedFieldRows').appendChild(wrap)}
function selectedChildren(){if(!state.product)return[];const checked=[...$('listingChildChecklist').querySelectorAll('input[type=checkbox]:checked')].map(x=>x.value);return (state.product.children||[]).filter(c=>checked.includes(c.asin))}
function setDownload(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000)}
async function generateListing(){
 if(!state.template||!state.templateRecord)throw new Error('请先选择已保存的类目模板');
 if(!state.product)throw new Error('请先搜索并选择父 ASIN');
 const children=selectedChildren();if(!children.length)throw new Error('请至少勾选一个需要修改的子 ASIN');
 const cfg={children,brand:String($('listingBrand').value||'').trim(),updates:{},advanced:[]};
 if(!cfg.brand)throw new Error('请填写本次商品的真实 Brand Name');
 if($('editTitle').checked){cfg.updates.title=$('listingTitle').value.trim();if(!cfg.updates.title)throw new Error('已勾选标题修改，请填写新标题')}
 if($('editDescription').checked){cfg.updates.description=$('listingDescription').value.trim();if(!cfg.updates.description)throw new Error('已勾选商品描述修改，请填写内容')}
 if($('editHighlights').checked){cfg.updates.highlights=$('listingHighlights').value.trim();if(!cfg.updates.highlights)throw new Error('已勾选亮点修改，请填写内容')}
 if($('editBullets').checked){cfg.updates.bullets=readBulletValues();if(!cfg.updates.bullets.some(Boolean))throw new Error('已勾选五点修改，请至少填写一条卖点')}
 for(const row of $('advancedFieldRows').querySelectorAll('[data-field-id]')){const value=row.querySelector('textarea').value.trim();if(value)cfg.advanced.push({fieldId:row.dataset.fieldId,value,label:row.querySelector('label').textContent})}
 if(!Object.keys(cfg.updates).length&&!cfg.advanced.length)throw new Error('请勾选或添加至少一个需要修改的字段');
 setStatus('listingResult','正在检查模板并生成文件…');
 state.template=await VariationEngine.inspect(await state.templateRecord.blob.arrayBuffer(),state.templateRecord.filename);renderAdvancedOptions();
 const result=await ListingEngine.generate(state.template,cfg);
 const base=(state.product.parentAsin||'listing').replace(/[^A-Z0-9_-]/gi,'_');
 const ext=/\.xlsm$/i.test(state.templateRecord.filename)?'.xlsm':'.xlsx';
 const filename='Listing_Update_'+base+'_'+new Date().toISOString().slice(0,10)+ext;
 setDownload(result.blob,filename);
 setStatus('listingResult','已生成 '+filename+'。本次更新 '+children.length+' 个子体；请先检查 Excel，再上传亚马逊并查看处理报告。'+(result.warnings.length?' 提示：'+result.warnings.join('；'):''));
}
function exportProductCsv(){
 if(!state.products.length)throw new Error('商品库目前没有记录，暂时无法导出。');
 const quote=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
 const rows=[['Parent ASIN','Child ASIN','SKU']];
 for(const p of state.products){
  for(const c of p.children||[])rows.push([p.parentAsin,c.asin,c.sku]);
 }
 const csv='\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
 const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
 setDownload(blob,'Amazon_Product_Library_'+new Date().toISOString().slice(0,10)+'.csv');
 setStatus('productCsvStatus','已导出 '+state.products.length+' 个父 ASIN、'+(rows.length-1)+' 条子 ASIN / SKU 对应记录。需要恢复时，请在「批量导入商品库」中选择该 CSV，先识别检查，再确认导入。');
}
async function exportBackup(){
 const zip=new JSZip(),manifest={schemaVersion:2,exportedAt:new Date().toISOString(),products:state.products,templates:[]};
 for(const t of state.templates){
  const path='templates/'+t.id+'_'+String(t.filename||'template.xlsx').replace(/[\\/:*?"<>|]/g,'_');
  zip.file(path,t.blob);
  manifest.templates.push({id:t.id,category:t.category,filename:t.filename,size:t.size,createdAt:t.createdAt,updatedAt:t.updatedAt,path});
 }
 const csvRows=[['Parent ASIN','Child ASIN','SKU']];
 for(const p of state.products)for(const c of p.children||[])csvRows.push([p.parentAsin,c.asin,c.sku]);
 const quote=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
 zip.file('products.csv','\uFEFF'+csvRows.map(row=>row.map(quote).join(',')).join('\r\n'));
 zip.file('manifest.json',JSON.stringify(manifest,null,2));
 const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
 setDownload(blob,'Amazon_Ops_Toolkit_Full_Backup_'+new Date().toISOString().slice(0,10)+'.zip');
 setStatus('backupStatus','完整备份已下载：包含 '+state.products.length+' 个父 ASIN 商品组、'+state.templates.length+' 个类目模板，以及便于查看的 products.csv。');
}
function replaceAllLibrary(products,templates){
 return new Promise((resolve,reject)=>{
  const tx=state.db.transaction(['products','templates'],'readwrite');
  const productStore=tx.objectStore('products'),templateStore=tx.objectStore('templates');
  productStore.clear();templateStore.clear();
  products.forEach(record=>productStore.put(record));
  templates.forEach(record=>templateStore.put(record));
  tx.oncomplete=()=>resolve();
  tx.onerror=()=>reject(tx.error||new Error('恢复资料库失败'));
  tx.onabort=()=>reject(tx.error||new Error('恢复资料库已取消'));
 });
}
async function importBackup(file){
 if(!file)throw new Error('请先选择完整备份 ZIP');
 const zip=await JSZip.loadAsync(await file.arrayBuffer()),manifestFile=zip.file('manifest.json');
 if(!manifestFile)throw new Error('备份文件中没有 manifest.json，不是有效的完整资料库备份');
 let manifest;
 try{manifest=JSON.parse(await manifestFile.async('string'))}catch(_){throw new Error('备份文件的索引内容无法读取')}
 if(!Array.isArray(manifest.products)||!Array.isArray(manifest.templates))throw new Error('备份不完整：必须同时包含商品库和类目模板清单');
 const products=[],templates=[],parentSet=new Set(),childOwners=new Map(),templateNames=new Set(),productIds=new Set(),templateIds=new Set();
 for(const p of manifest.products){
  const parentAsin=normalizeAsin(p.parentAsin);
  if(!validateAsin(parentAsin))throw new Error('备份中发现无效父 ASIN：'+(p.parentAsin||'空白'));
  if(parentSet.has(parentAsin))throw new Error('备份中父 ASIN 重复：'+parentAsin);
  parentSet.add(parentAsin);
  if(!Array.isArray(p.children)||!p.children.length)throw new Error('父 ASIN '+parentAsin+' 没有子 ASIN / SKU 记录');
  const children=[],localAsins=new Set(),localSkus=new Set();
  for(const c of p.children){
   const asin=normalizeAsin(c.asin),sku=String(c.sku||'').trim();
   if(!validateAsin(asin)||!sku)throw new Error('父 ASIN '+parentAsin+' 中存在无效的子 ASIN 或空 SKU');
   if(localAsins.has(asin))throw new Error('父 ASIN '+parentAsin+' 中子 ASIN 重复：'+asin);
   if(localSkus.has(sku))throw new Error('父 ASIN '+parentAsin+' 中 SKU 重复：'+sku);
   if(childOwners.has(asin)&&childOwners.get(asin)!==parentAsin)throw new Error('子 ASIN '+asin+' 同时归属多个父 ASIN');
   localAsins.add(asin);localSkus.add(sku);childOwners.set(asin,parentAsin);
   children.push({asin,sku});
  }
  const id=String(p.id||uid());
  if(productIds.has(id))throw new Error('备份中商品记录 ID 重复');
  productIds.add(id);
  products.push({id,parentAsin,children,createdAt:p.createdAt||new Date().toISOString(),updatedAt:p.updatedAt||p.createdAt||new Date().toISOString()});
 }
 for(const t of manifest.templates){
  const category=String(t.category||'').trim(),path=String(t.path||'').trim();
  if(!category||!path)throw new Error('备份中存在缺少类目名称或模板文件路径的记录');
  const norm=category.toLowerCase();
  if(templateNames.has(norm))throw new Error('备份中类目名称重复：'+category);
  templateNames.add(norm);
  const entry=zip.file(path);
  if(!entry)throw new Error('备份缺少类目模板文件：'+category+'（'+path+'）');
  const blob=await entry.async('blob'),id=String(t.id||uid());
  if(templateIds.has(id))throw new Error('备份中类目模板 ID 重复');
  templateIds.add(id);
  templates.push({id,category,filename:String(t.filename||path.split('/').pop()),size:Number(t.size)||blob.size,createdAt:t.createdAt||new Date().toISOString(),updatedAt:t.updatedAt||t.createdAt||new Date().toISOString(),blob});
 }
 await replaceAllLibrary(products,templates);
 await refreshAll();
 state.productPage=1;
 setStatus('backupStatus','完整恢复成功：已恢复 '+products.length+' 个父 ASIN 商品组和 '+templates.length+' 个类目模板。当前资料库已被备份内容整体替换。');
}
function onProductChange(){
 const previous=state.product?.id||'';
 const id=$('listingProductSelect').value;state.product=state.products.find(p=>p.id===id)||null;
 if(previous!==(state.product?.id||''))$('listingBrand').value='';
 renderChildChoices(state.product);
 if(state.product)setStatus('listingProductStatus','已匹配 '+state.product.children.length+' 个子 ASIN。SKU 不显示在选择清单中，生成表格时会自动匹配。');
 else setStatus('listingProductStatus','搜索并选择父 ASIN 后，程序会匹配全部子 ASIN。');
}
function syncEditPanels(){for(const [checkbox,panel] of [['editTitle','titleFields'],['editDescription','descriptionFields'],['editHighlights','highlightsFields'],['editBullets','bulletFieldsPanel']])$(panel).classList.toggle('hidden',!$(checkbox).checked)}
function initEvents(){
 $('openListingTab').addEventListener('click',()=>showPage('listing'));
 $('openLibraryTab').addEventListener('click',()=>showPage('library'));
 $('openTemplateLibraryTab').addEventListener('click',()=>showLibraryTab('templates'));
 $('openProductLibraryTab').addEventListener('click',()=>showLibraryTab('products'));
 $('listingTemplateFile').addEventListener('change',()=>{if($('listingTemplateFile').files[0])setStatus('templateLibraryStatus','已选择模板文件。请确认类目名称后保存。')});
 $('saveListingTemplate').addEventListener('click',async()=>{try{await uploadTemplate()}catch(err){setStatus('templateLibraryStatus',err.message,'error')}});
 ['editTitle','editDescription','editHighlights','editBullets'].forEach(id=>$(id).addEventListener('change',syncEditPanels));syncEditPanels();
 $('listingTemplateSelect').addEventListener('change',()=>loadTemplate($('listingTemplateSelect').value));
 $('listingProductSelect').addEventListener('change',onProductChange);
 $('listingParentAsinSearch').addEventListener('input',searchParentAsin);
 $('listingChildSelect').addEventListener('change',()=>{const v=$('listingChildSelect').value;renderChildChoices(state.product,v==='__all__'?'':v)});
 $('selectAllChildren').addEventListener('click',()=>setChildChecks(true));
 $('clearAllChildren').addEventListener('click',()=>setChildChecks(false));
 $('saveProductGroup').addEventListener('click',async()=>{try{await saveProductGroup()}catch(err){setStatus('productFormStatus',err.message,'error')}});
 $('resetProductForm').addEventListener('click',resetProductForm);
 $('productLibrarySearch').addEventListener('input',()=>{state.productPage=1;renderProducts()});
 $('importProducts').addEventListener('click',async()=>{try{await importProductRows()}catch(err){setStatus('importStatus',err.message,'error')}});
 $('productExcelFile').addEventListener('change',()=>{state.pendingProductImport=null;$('importExcelProducts').disabled=true;if($('productExcelFile').files[0])setStatus('importPreview','已选择：'+$('productExcelFile').files[0].name+'。点击「识别文件并统计」开始读取。')});
 $('previewProductExcel').addEventListener('click',async()=>{try{$('previewProductExcel').disabled=true;setStatus('importPreview','正在读取 Excel 并识别父子 ASIN/SKU…');await previewProductExcel()}catch(err){state.pendingProductImport=null;$('importExcelProducts').disabled=true;setStatus('importPreview',err.message,'error')}finally{$('previewProductExcel').disabled=false}});
 $('importExcelProducts').addEventListener('click',async()=>{try{$('importExcelProducts').disabled=true;await saveProductExcelImport()}catch(err){setStatus('importStatus',err.message,'error');$('importExcelProducts').disabled=false}});
 $('addListingBullet').addEventListener('click',()=>{const vals=readBulletValues();vals.push('');renderBulletInputs(vals)});
 $('addAdvancedField').addEventListener('click',addAdvancedField);
 $('generateListing').addEventListener('click',async()=>{const btn=$('generateListing');btn.disabled=true;try{await generateListing()}catch(err){setStatus('listingResult',err.message,'error')}finally{btn.disabled=false}});
 $('exportProductCsv').addEventListener('click',()=>{try{exportProductCsv()}catch(err){setStatus('productCsvStatus',err.message,'error')}});
 $('exportBackup').addEventListener('click',async()=>{try{await exportBackup()}catch(err){setStatus('backupStatus',err.message,'error')}});
 $('importBackup').addEventListener('change',()=>{
 state.pendingBackupFile=$('importBackup').files[0]||null;
 $('restoreBackup').disabled=!state.pendingBackupFile;
 if(state.pendingBackupFile)setStatus('backupStatus','已选择备份文件：'+state.pendingBackupFile.name+'。点击「上传并恢复全部资料」后，当前商品库和类目模板会被完整替换。');
});
$('restoreBackup').addEventListener('click',async()=>{
 const file=state.pendingBackupFile;
 if(!file){setStatus('backupStatus','请先选择完整备份 ZIP。','warn');return}
 if(!confirm('恢复会完整替换当前商品库和类目模板，当前未备份的内容将被覆盖。建议先下载当前完整备份。确定继续吗？'))return;
 const btn=$('restoreBackup');btn.disabled=true;
 try{
  state.product=null;state.template=null;state.templateRecord=null;
  await importBackup(file);
  state.pendingBackupFile=null;$('importBackup').value='';btn.disabled=true;
 }catch(err){
  setStatus('backupStatus',err.message,'error');
  btn.disabled=!state.pendingBackupFile;
 }
});
}
function start(){
 openDB().then(async db=>{
  state.db=db;await refreshAll();initEvents();renderBulletInputs();
  if(state.products.length){$('listingProductSelect').value='';state.product=null}
  setStatus('listingTemplateStatus','请选择已保存的类目模板。');
  setStatus('templateLibraryStatus',state.templates.length?'已加载 '+state.templates.length+' 个类目模板。':'尚未保存模板。');
 }).catch(err=>setStatus('listingTemplateStatus','本地资料库无法启动：'+err.message,'error'));
}
document.addEventListener('DOMContentLoaded',start);
})();

/* Excel listing-update engine: uses the Amazon template structure and preserves other workbook parts. */
const ListingEngine=(function(){
'use strict';
const M='http://schemas.openxmlformats.org/spreadsheetml/2006/main',REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships',XNS='http://www.w3.org/XML/1998/namespace';
function fail(msg){throw new Error(msg)}
function node(parent,name){return [...parent.childNodes].find(n=>n.nodeType===1&&n.localName===name)||null}
function nodes(parent,name){return [...parent.childNodes].filter(n=>n.nodeType===1&&n.localName===name)}
function attr(n,name){return n?.getAttribute(name)||''}
function colnum(ref){const m=/^[A-Z]+/.exec(ref||'');if(!m)fail('无效列地址：'+ref);return [...m[0]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)}
function colname(n){let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}
function cellText(cell,shared){if(!cell)return'';const typ=attr(cell,'t'),v=node(cell,'v');if(typ==='s'&&v)return shared[Number(v.textContent)]||'';if(typ==='inlineStr'){const is=node(cell,'is');return is?[...is.getElementsByTagNameNS(M,'t')].map(x=>x.textContent||'').join(''):''}return v?.textContent||''}
function setInline(cell,value,doc){for(const x of [...cell.childNodes])if(x.nodeType===1&&['v','is','f'].includes(x.localName))cell.removeChild(x);cell.setAttribute('t','inlineStr');const is=doc.createElementNS(M,'is'),text=doc.createElementNS(M,'t');text.textContent=String(value);if(/^\s|\s$/.test(String(value)))text.setAttributeNS(XNS,'xml:space','preserve');is.appendChild(text);cell.appendChild(is)}
function clearCell(cell){for(const x of [...cell.childNodes])if(x.nodeType===1&&['v','is','f'].includes(x.localName))cell.removeChild(x);cell.removeAttribute('t')}
function getCells(row){return nodes(row,'c')}
function bulletColumns(t){return Object.entries(t.headers).map(([col,id])=>{const m=/^bullet_point\[/.test(id)?/#(\d+)\.value$/.exec(id):null;return m?{col:Number(col),order:Number(m[1]),id}:null}).filter(Boolean).sort((a,b)=>a.order-b.order)}
function shiftCellRefs(text,insertAt,count){return String(text||'').replace(/(^|[^A-Z0-9_])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Z0-9_])/g,(all,before,dollar,col,rowDollar,row)=>{const n=colnum(col);return before+dollar+colname(n>=insertAt?n+count:n)+rowDollar+row})}
function shiftSheetRefs(sheet,insertAt,count){for(const el of [...sheet.getElementsByTagName('*')]){if(el.localName==='c'){const ref=attr(el,'r'),m=/^([A-Z]+)(\d+)$/.exec(ref);if(m){const n=colnum(m[1]);if(n>=insertAt)el.setAttribute('r',colname(n+count)+m[2])}}for(const a of [...el.attributes]){if(el.localName==='c'&&a.name==='r')continue;if(['ref','sqref','topLeftCell','activeCell'].includes(a.name)&&/[A-Z]+\d+/.test(a.value))el.setAttribute(a.name,shiftCellRefs(a.value,insertAt,count))}if(el.localName==='f'&&el.textContent)el.textContent=shiftCellRefs(el.textContent,insertAt,count)}}
function shiftCols(sheet,sourceCol,insertAt,count){const cols=node(sheet.documentElement,'cols');if(!cols)return;const old=nodes(cols,'col').map(c=>c.cloneNode(true));const source=old.find(c=>Number(attr(c,'min'))<=sourceCol&&Number(attr(c,'max'))>=sourceCol);const next=[];for(const c of old){const min=Number(attr(c,'min')),max=Number(attr(c,'max'));if(max<insertAt){next.push(c);continue}if(min>=insertAt){c.setAttribute('min',String(min+count));c.setAttribute('max',String(max+count));next.push(c);continue}if(min<insertAt&&max>=insertAt){const before=c.cloneNode(true);before.setAttribute('min',String(min));before.setAttribute('max',String(insertAt-1));next.push(before);const after=c.cloneNode(true);after.setAttribute('min',String(insertAt+count));after.setAttribute('max',String(max+count));next.push(after)}}if(source){for(let i=0;i<count;i++){const c=source.cloneNode(true);c.setAttribute('min',String(insertAt+i));c.setAttribute('max',String(insertAt+i));next.push(c)}}for(const c of nodes(cols,'col'))cols.removeChild(c);next.sort((a,b)=>Number(attr(a,'min'))-Number(attr(b,'min'))).forEach(c=>cols.appendChild(c))}
function expandBullets(t,required){let bullets=bulletColumns(t);if(required<=bullets.length)return; if(!bullets.length)fail('模板未识别到 Bullet Point 字段，无法自动扩展列');const count=required-bullets.length,sourceCol=bullets[bullets.length-1].col,insertAt=sourceCol+1,headerRowEntry=[...t.rr.entries()].find(([,cols])=>Object.values(cols).includes('contribution_sku#1.value')&&Object.values(cols).includes('::record_action'));const headerRow=headerRowEntry?headerRowEntry[0]:t.dataStart-3;const sd=node(t.sheet.documentElement,'sheetData');if(!sd)fail('模板缺少 sheetData');const rows=nodes(sd,'row');const sourceCells=new Map();for(const row of rows){const rn=Number(attr(row,'r')),src=getCells(row).find(c=>colnum(attr(c,'r'))===sourceCol);if(src)sourceCells.set(rn,src.cloneNode(true))}shiftCols(t.sheet,sourceCol,insertAt,count);shiftSheetRefs(t.sheet,insertAt,count);for(const row of rows){const rn=Number(attr(row,'r')),src=sourceCells.get(rn);if(!src)continue;for(let i=0;i<count;i++){const clone=src.cloneNode(true),newCol=insertAt+i;clone.setAttribute('r',colname(newCol)+rn);if(rn===headerRow){const oldText=cellText(src,t.shared),nextOrder=bullets.length+i+1;setInline(clone,oldText.replace(/#\d+\.value$/,'#'+nextOrder+'.value'),t.sheet)}else if(rn!==headerRow-1){clearCell(clone)}row.appendChild(clone)}const cells=getCells(row).sort((a,b)=>colnum(attr(a,'r'))-colnum(attr(b,'r')));for(const c of cells)row.removeChild(c);cells.forEach(c=>row.appendChild(c))}const shifted={};for(const [c,id] of Object.entries(t.headers)){const n=Number(c);shifted[String(n>=insertAt?n+count:n)]=id}for(let i=0;i<count;i++){const order=bullets.length+i+1;shifted[String(insertAt+i)]=bullets[bullets.length-1].id.replace(/#\d+\.value$/,'#'+order+'.value')}t.headers=shifted;const newLabels={};for(const [c,v] of Object.entries(t.labels||{})){const n=Number(c);newLabels[String(n>=insertAt?n+count:n)]=v}for(let i=0;i<count;i++)newLabels[String(insertAt+i)]=t.labels?.[String(sourceCol)]||'Bullet Point';t.labels=newLabels;for(const [k,v] of Object.entries(t.fields||{}))if(v&&v>=insertAt)t.fields[k]=v+count;if(t.meta){t.meta.field_options=Object.entries(t.headers).map(([c,id])=>({col:Number(c),label:t.labels[c]||'',id})).sort((a,b)=>a.col-b.col);t.meta.header_count=Object.keys(t.headers).length}return bulletColumns(t)}
function makeRow(doc,template,num,vals){const row=template?template.cloneNode(true):doc.createElementNS(M,'row');row.setAttribute('r',String(num));const old=new Map();for(const c of getCells(row)){old.set(colnum(attr(c,'r')),c.cloneNode(true));row.removeChild(c)}for(const [cs,v] of Object.entries(vals).sort((a,b)=>Number(a[0])-Number(b[0]))){if(v==null||String(v)==='')continue;const col=Number(cs),cell=old.get(col)||doc.createElementNS(M,'c');cell.setAttribute('r',colname(col)+num);if(!cell.hasAttribute('s'))cell.setAttribute('s','0');setInline(cell,v,doc);row.appendChild(cell)}return row}
function findColumn(t,prefixes){for(const [col,id] of Object.entries(t.headers)){const lower=id.toLowerCase();if(prefixes.some(p=>lower.startsWith(p)))return Number(col)}return null}
function findPriceColumn(t){for(const [col,id] of Object.entries(t.headers||{})){if(id.startsWith('purchasable_offer[')&&id.includes('[audience=ALL]')&&id.includes('our_price#1.schedule#1.value_with_tax'))return Number(col)}return null}
async function generate(t,cfg){const errors=[],children=cfg.children||[],updates=cfg.updates||{};if(!children.length)errors.push('没有选择需要更新的子体');const fields=t.fields||{};if(!fields.sku)errors.push('模板缺少 SKU 字段');if(!fields.action)errors.push('模板缺少 Listing Action 字段');if(!fields.product_type)errors.push('模板缺少 Product Type 字段');if(!fields.brand)errors.push('模板缺少 Brand Name 字段');if(!fields.product_id_type)errors.push('模板缺少 Product Id Type 字段');if(!fields.product_id)errors.push('模板缺少 Product Id 字段');if(!String(cfg.brand||'').trim())errors.push('请先为商品组填写真实品牌名称');if(!String(t.meta?.product_type||'').trim())errors.push('无法从当前类目模板识别 Product Type，请确认上传的是正确的类目模板');if(updates.title&&!fields.item_name)errors.push('当前模板没有识别到标题字段');if(updates.description&&!fields.description)errors.push('当前模板没有识别到 Product Description 字段');if(updates.highlights){const hs=highlightColumns(t);if(!String(updates.highlights||'').trim())errors.push('亮点修改至少需要一条非空内容');if(!hs.length)errors.push('当前类目模板没有识别到 Item Highlight / 亮点字段，请检查模板是否包含该属性')}if(updates.bullets&&!updates.bullets.some(v=>String(v||'').trim()))errors.push('五点修改至少需要一条非空内容');if(updates.bullets)updates.bullets.forEach((v,i)=>{if(String(v||'').length>255)errors.push('Bullet Point '+(i+1)+' 超过 255 个字符，请精简后再生成')});if(updates.searchTerms&&!findColumn(t,['generic_keyword[','generic_keywords[','search_terms[']))errors.push('当前模板没有识别到 Search Terms / Generic Keyword 字段');if(updates.price&&!findPriceColumn(t))errors.push('当前模板没有识别到普通售价（Your Price USD）字段');if(updates.price&&(!Number.isFinite(Number(updates.price))||Number(updates.price)<=0))errors.push('售价必须是大于 0 的数字');const seenSku=new Set(),seenAsin=new Set();for(const c of children){const sku=String(c.sku||'').trim(),asin=String(c.asin||'').trim().toUpperCase();if(!sku)errors.push('子 ASIN '+(c.asin||'')+' 缺少 SKU');else if(seenSku.has(sku))errors.push('重复子 SKU：'+sku);seenSku.add(sku);if(!/^[A-Z0-9]{10}$/.test(asin))errors.push('子 ASIN 格式异常：'+(c.asin||''));else if(seenAsin.has(asin))errors.push('重复子 ASIN：'+asin);seenAsin.add(asin)}for(const a of cfg.advanced||[]){if(!Object.values(t.headers).includes(a.fieldId))errors.push('模板中未找到额外字段：'+a.fieldId)}if(errors.length)fail(errors.join('；'));const bulletValues=updates.bullets||[],needed=bulletValues.reduce((n,v,i)=>String(v||'').trim()?Math.max(n,i+1):n,0);const bullets=expandBullets(t,needed);const sd=node(t.sheet.documentElement,'sheetData'),oldRows=nodes(sd,'row').filter(r=>Number(attr(r,'r'))>=t.dataStart),rowTemplate=oldRows[0]||null;for(const row of oldRows)sd.removeChild(row);const outputChildren=children;outputChildren.forEach((child,index)=>{const vals={};vals[fields.sku]=String(child.sku).trim();vals[fields.action]='Edit (Partial Update)';if(fields.product_type)vals[fields.product_type]=t.meta.product_type;if(fields.brand)vals[fields.brand]=String(cfg.brand).trim();if(fields.product_id_type)vals[fields.product_id_type]='ASIN';if(fields.product_id)vals[fields.product_id]=String(child.asin).trim().toUpperCase();if(updates.title)vals[fields.item_name]=updates.title;if(updates.description)vals[fields.description]=updates.description;if(updates.highlights){const hCols=highlightColumns(t);if(hCols[0])vals[hCols[0].col]=String(updates.highlights).trim()}if(updates.price){const priceCol=findPriceColumn(t);vals[priceCol]=Number(updates.price).toFixed(2)}if(updates.bullets)bulletValues.forEach((v,i)=>{if(String(v||'').trim()){const col=bullets.find(b=>b.order===i+1)?.col;if(col)vals[col]=String(v).trim()}});if(updates.searchTerms){const col=findColumn(t,['generic_keyword[','generic_keywords[','search_terms[']);vals[col]=updates.searchTerms}for(const a of cfg.advanced||[]){const col=Object.entries(t.headers).find(([,id])=>id===a.fieldId)?.[0];if(col)vals[Number(col)]=a.value}sd.appendChild(makeRow(t.sheet,rowTemplate,t.dataStart+index,vals))});const maxCol=Math.max(...Object.keys(t.headers).map(Number));const dim=node(t.sheet.documentElement,'dimension');if(dim)dim.setAttribute('ref','A1:'+colname(maxCol)+(t.dataStart+outputChildren.length-1));t.zip.file(t.sheetPath,new XMLSerializer().serializeToString(t.sheet));const blob=await t.zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});return{blob,warnings:needed>5?['本次已自动扩展到 '+needed+' 列 Bullet Point；请先检查新增字段编号再上传。']:[]}}
return{generate};
})();