/* Web UI for Amazon variation family generation (local-only). */
let meta=null, selectedFile=null, currentTemplate=null, children=[], currentMapping={};
let libraryDb=null, savedTemplates=[], libraryProducts=[];
const $=(id)=>document.getElementById(id);
const safe=(v)=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const setText=(id,v)=>{$(id).textContent=String(v??'')};
const setVal=(id,v)=>{$(id).value=String(v??'')};
const tokens=()=>($('theme').value||'').split('/').map(x=>x.trim()).filter(Boolean);
function notify(id,msg,kind=''){let el=$(id);el.textContent=msg;el.className='notice'+(kind?' '+kind:'')}
function optionEl(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o}
function openLibraryDB(){
 return new Promise((resolve,reject)=>{
  if(!window.indexedDB){reject(new Error('当前浏览器不支持本地资料库'));return}
  const req=indexedDB.open('amazonOpsToolkit');
  req.onupgradeneeded=()=>{
   const db=req.result;
   for(const name of ['products','templates'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
  };
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error||new Error('无法读取本地资料库'));
 });
}
function readLibraryStore(store){
 return new Promise((resolve,reject)=>{
  if(!libraryDb.objectStoreNames.contains(store)){resolve([]);return}
  const req=libraryDb.transaction(store,'readonly').objectStore(store).getAll();
  req.onsuccess=()=>resolve(req.result||[]);
  req.onerror=()=>reject(req.error||new Error('读取 '+store+' 失败'));
 });
}
function renderSavedTemplateOptions(){
 const search=String($('savedTemplateSearch').value||'').trim().toLowerCase();
 const select=$('savedTemplateSelect'),previous=select.value;
 const items=savedTemplates.filter(t=>String(t.category||'').toLowerCase().includes(search)||String(t.filename||'').toLowerCase().includes(search))
  .sort((a,b)=>String(a.category||'').localeCompare(String(b.category||''),'zh-CN'));
 select.innerHTML='';
 select.appendChild(optionEl('',items.length?'请选择已保存模板':(savedTemplates.length?'没有匹配的模板':'暂无已保存模板')));
 for(const t of items)select.appendChild(optionEl(t.id,String(t.category||'未命名类目')+'｜'+String(t.filename||'template.xlsx')));
 if(items.some(t=>String(t.id)===previous))select.value=previous;
}
function renderMergeParentOptions(){
 const list=$('mergeParentOptions');list.innerHTML='';
 [...libraryProducts].sort((a,b)=>String(a.parentAsin||'').localeCompare(String(b.parentAsin||''))).forEach(p=>{
  const option=optionEl(String(p.parentAsin||''),String((p.children||[]).length)+' 个 SKU');
  list.appendChild(option);
 });
}
function renderMergeSkuChoices(){
 const query=String($('mergeParentSearch').value||'').trim().toUpperCase();
 const host=$('mergeSkuChoices');host.innerHTML='';host.classList.add('hidden');
 if(!libraryProducts.length){
  notify('mergeSkuStatus','商品库目前没有商品记录。可先到「Listing 修改 → 商品库」添加/导入，或继续在下方手动填写子体。','warn');return;
 }
 if(!query){notify('mergeSkuStatus','输入或选择完整父 ASIN 后，这里会显示该父体下可选的 SKU。');return}
 const exact=libraryProducts.find(p=>String(p.parentAsin||'').toUpperCase()===query);
 if(!exact){
  const matches=libraryProducts.filter(p=>String(p.parentAsin||'').toUpperCase().includes(query));
  notify('mergeSkuStatus',matches.length?'找到 '+matches.length+' 个匹配的父 ASIN。请从输入框建议中选择完整父 ASIN，再勾选 SKU。':'商品库中没有找到匹配的父 ASIN。你仍可在下方手动填写子体。',matches.length?'':'warn');
  return;
 }
 const choices=(exact.children||[]).filter(c=>String(c.sku||'').trim()&&String(c.asin||'').trim());
 if(!choices.length){notify('mergeSkuStatus','已找到父 ASIN，但没有完整的 SKU / 子 ASIN 对应记录。请检查商品库。','warn');return}
 notify('mergeSkuStatus','已找到 '+choices.length+' 个 SKU。选项只显示 SKU；加入子体表后会自动带入对应子 ASIN。');
 for(const child of choices){
  const label=document.createElement('label');label.className='sku-choice';
  const input=document.createElement('input');input.type='checkbox';input.dataset.mergeSku=String(child.sku);input.dataset.mergeAsin=String(child.asin).toUpperCase();
  const name=document.createElement('span');name.className='sku-name';name.textContent=String(child.sku);
  label.append(input,name);host.appendChild(label);
 }
 host.classList.remove('hidden');
}
async function refreshLibraryData(){
 try{
  if(!libraryDb)libraryDb=await openLibraryDB();
  savedTemplates=await readLibraryStore('templates');
  libraryProducts=(await readLibraryStore('products')).map(p=>({...p,parentAsin:String(p.parentAsin||'').trim().toUpperCase(),children:(p.children||[]).map(c=>({asin:String(c.asin||'').trim().toUpperCase(),sku:String(c.sku||'').trim()}))}));
  renderSavedTemplateOptions();renderMergeParentOptions();renderMergeSkuChoices();
  if(!savedTemplates.length)notify('savedTemplateStatus','暂无已保存的类目模板。你可以直接上传模板，或先到「Listing 修改 → 类目模板库」保存常用模板。','warn');
  else notify('savedTemplateStatus','已读取 '+savedTemplates.length+' 个已保存的类目模板。');
 }catch(err){
  notify('savedTemplateStatus','读取本地模板库失败：'+err.message+'。你仍然可以直接上传模板。','warn');
  notify('mergeSkuStatus','读取商品库失败：'+err.message+'。你仍然可以手动填写子体。','warn');
 }
}
async function activateTemplate(source,name,sourceLabel){
 $('editor').classList.add('hidden');$('metrics').classList.add('hidden');
 selectedFile={name,arrayBuffer:()=>source.arrayBuffer()};
 notify('loadStatus','正在解析模板，请稍候…');
 try{
  if(typeof JSZip==='undefined')throw new Error('Excel 文件处理库未加载成功，请刷新网页重试');
  currentTemplate=await VariationEngine.inspect(await source.arrayBuffer(),name);meta=currentTemplate.meta;initEditor();
  $('editor').classList.remove('hidden');
  $('metrics').innerHTML='<div class="pill"><strong>'+meta.header_count+'</strong>列字段</div><div class="pill"><strong>'+meta.theme_options.length+'</strong>种变体主题</div><div class="pill"><strong>'+meta.sample_children_count+'</strong>个样例子体</div>';
  $('metrics').classList.remove('hidden');
  notify('loadStatus',sourceLabel+'已识别。请检查标题、SKU、变体属性和其他必填字段。');
  notify('savedTemplateStatus','当前使用：'+sourceLabel+'｜'+name);
  return true;
 }catch(err){
  currentTemplate=null;meta=null;
  notify('loadStatus',err.message,'error');
  return false;
 }
}
$('file').addEventListener('change',async(e)=>{
 const file=e.target.files[0];if(!file)return;
 $('savedTemplateSelect').value='';
 await activateTemplate(file,file.name,'手动上传的模板');
});
$('loadSavedTemplate').addEventListener('click',async()=>{
 const record=savedTemplates.find(t=>String(t.id)===$('savedTemplateSelect').value);
 if(!record){notify('savedTemplateStatus','请先选择一个已保存的类目模板。','warn');return}
 if(!record.blob||typeof record.blob.arrayBuffer!=='function'){notify('savedTemplateStatus','这个模板文件无法读取，请重新上传并保存该模板。','error');return}
 await activateTemplate(record.blob,record.filename||'template.xlsx','已保存模板「'+record.category+'」');
});
$('refreshSavedTemplates').addEventListener('click',refreshLibraryData);
$('savedTemplateSearch').addEventListener('input',renderSavedTemplateOptions);
$('mergeParentSearch').addEventListener('input',renderMergeSkuChoices);
$('mergeParentSearch').addEventListener('change',renderMergeSkuChoices);
$('selectAllMergeSkus').addEventListener('click',()=>document.querySelectorAll('#mergeSkuChoices input[data-merge-sku]').forEach(input=>input.checked=true));
$('clearAllMergeSkus').addEventListener('click',()=>document.querySelectorAll('#mergeSkuChoices input[data-merge-sku]').forEach(input=>input.checked=false));
function normalizedColValues(values){
 return Object.entries(values||{}).filter(([,v])=>String(v??'').trim()!=='').sort(([a],[b])=>a.localeCompare(b));
}
function isUntouchedTemplateSample(row,index){
 const original=(meta?.sample_children||[])[index];if(!original)return false;
 return String(row.sku||'').trim()===String(original.sku||'').trim()
  &&String(row.asin||'').trim().toUpperCase()===String(original.asin||'').trim().toUpperCase()
  &&String(row.title||'')===String(original.title||'')
  &&JSON.stringify(normalizedColValues(row.col_values))===JSON.stringify(normalizedColValues(original.col_values));
}
function isBlankChildRow(row){
 return !String(row.sku||'').trim()&&!String(row.asin||'').trim()&&!String(row.title||'').trim()
  &&!Object.values(row.col_values||{}).some(v=>String(v??'').trim());
}
function addSelectedLibraryChildren(){
 if(!meta){notify('mergeSkuStatus','请先选择或上传类目模板，再添加 SKU。','warn');return}
 saveChildren();
 const checked=[...document.querySelectorAll('#mergeSkuChoices input[data-merge-sku]:checked')];
 if(!checked.length){notify('mergeSkuStatus','请先勾选至少一个 SKU。','warn');return}
 const selected=checked.map(input=>({sku:String(input.dataset.mergeSku||'').trim(),asin:String(input.dataset.mergeAsin||'').trim().toUpperCase()}));
 const toAdd=[];let skipped=0;
 for(const item of selected){
  if(children.some(row=>String(row.sku||'').trim()===item.sku||String(row.asin||'').trim().toUpperCase()===item.asin)){skipped++;continue}
  toAdd.push(item);
 }
 if(!toAdd.length){notify('mergeSkuStatus','所选 SKU 已经在子体表中，无需重复添加。','warn');return}
 for(const item of toAdd){
  let index=children.findIndex((row,i)=>isUntouchedTemplateSample(row,i));
  if(index<0)index=children.findIndex(isBlankChildRow);
  const row={sku:item.sku,asin:item.asin,title:'',col_values:{}};
  if(index>=0)children[index]=row;else children.push(row);
 }
 // Clear unused example rows from the blank Amazon template so sample SKUs/ASINs are not accidentally exported.
 children=children.map((row,index)=>isUntouchedTemplateSample(row,index)?{sku:'',asin:'',title:'',col_values:{}}:row);
 renderChildren();
 document.querySelectorAll('#mergeSkuChoices input[data-merge-sku]').forEach(input=>input.checked=false);
 notify('mergeSkuStatus','已添加 '+toAdd.length+' 个 SKU，并自动填入对应子 ASIN。'+(skipped?'另有 '+skipped+' 个因已存在于表格而跳过。':'')+'请继续填写每个子体真实的颜色、尺寸等变体属性。');
}
$('addMergeSkus').addEventListener('click',addSelectedLibraryChildren);
function updateBulletCount(){
 const count=[...document.querySelectorAll('textarea[data-bullet]')].filter(el=>el.value.trim()).length;
 setText('bulletCount','已填写 '+count+' / 5 条卖点（至少填写 1 条）；空白行不会写入上传表格。');
}
function initEditor(){
 setVal('parent_sku',meta.parent_sku);setVal('product_type',meta.product_type);
 for(const key of ['item_name','brand','item_type_keyword','description','origin','batteries','hazmat']){
  let value=meta.basic[key]||'';
  if(key==='description'&&/this summer, boots by jette|breathable leather lining|adidas blue sneakers|^lorem ipsum|^example product description/i.test(value))value='';
  setVal(key,value);
 }
 $('theme').innerHTML='';for(const theme of meta.theme_options)$('theme').appendChild(optionEl(theme,theme));
 if(!meta.theme_options.includes(meta.default_theme))$('theme').appendChild(optionEl(meta.default_theme,meta.default_theme));
 $('theme').value=meta.default_theme;
 const kw=$('item_type_keyword');kw.innerHTML='';
 const keywordChoices=meta.dropdown_options?.item_type_keyword||[];
 kw.disabled=false;
 if(keywordChoices.length===1){
  kw.appendChild(optionEl(keywordChoices[0],keywordChoices[0]));
  kw.value=keywordChoices[0];
  kw.disabled=true;
  setText('autoKeywordStatus','模板仅有 1 个有效选项，程序已自动填入，无需操作');
 }else{
  kw.appendChild(optionEl('','请选择对应的类目节点'));
  for(const value of keywordChoices)kw.appendChild(optionEl(value,value));
  if(meta.basic.item_type_keyword&&!Array.from(kw.options).some(opt=>opt.value===meta.basic.item_type_keyword)){
   kw.appendChild(optionEl(meta.basic.item_type_keyword,meta.basic.item_type_keyword));
  }
  kw.value=meta.basic.item_type_keyword||'';
  setText('autoKeywordStatus',kw.value?'已根据原模板预选；多个选项可手动调整':'模板有多个选项，请确认需要的类目节点');
 }
 const pt=$('product_type');
 pt.readOnly=!!meta.product_type;
 pt.title=meta.product_type?'已从当前类目模板自动识别':'此模板尚未找到产品类型，需要填写';
 $('reuse_parent').checked=false;$('reuse_child').checked=false;
 $('showTitles').checked=false;
 $('childrenTable').classList.remove('show-titles');
 $('parentMismatch').classList.toggle('hidden',!meta.parent_original_sku||meta.parent_original_sku===meta.parent_sku);
 if(meta.parent_original_sku!==meta.parent_sku&&meta.parent_original_sku){
  setText('parentMismatch','原样例父 SKU 为 '+meta.parent_original_sku+'，但子体共同引用 '+meta.parent_sku+'。已按子体引用值预填，请核对。');
 }
 $('bulletFields').innerHTML='';
 for(const b of meta.bullets){
  const wrap=document.createElement('div');
  const label=document.createElement('label');
  label.textContent='Bullet Point '+b.order+'｜父体卖点 '+b.order+'（可留空）';
  const textarea=document.createElement('textarea');
  textarea.dataset.bullet=String(b.col);
  textarea.placeholder='填写与所有变体一致的真实卖点 '+b.order;
  textarea.value=b.value||'';
  textarea.addEventListener('input',updateBulletCount);
  wrap.append(label,textarea);$('bulletFields').appendChild(wrap);
 }
 updateBulletCount();

 $('extraFields').innerHTML='';currentMapping={...meta.default_theme_cols};
 children=meta.sample_children.map(row=>({sku:row.sku,asin:row.asin,title:row.title||'',col_values:row.col_values}));
 while(children.length<10)children.push({sku:'',asin:'',title:'',col_values:{}});
 // If the source template contains more than ten sample products, retain all of them.
 renderMapping();renderChildren();notify('result','等待生成：请先复核父体和子体信息。');
}
function colGuess(token){
 const aliases={COLOR:['color'],SIZE:['size'],STYLE:['style_name','style'],MATERIAL:['material'],COVER_MATERIAL:['cover_material'],FILL_MATERIAL:['fill_material'],ITEM_SHAPE:['item_shape'],NUMBER_OF_ITEMS:['number_of_items'],SET_NAME:['set_name'],STYLE_NAME:['style_name'],FLAVOR:['flavor'],PATTERN:['pattern'],SCENT:['scent'],CAPACITY:['capacity'],LENGTH:['length']};
 for(const prefix of (aliases[token]||[token.toLowerCase()])){
  const candidates=meta.field_options.filter(f=>f.id.startsWith(prefix+'[')||f.id.startsWith(prefix+'#'));
  const best=candidates.find(f=>f.id.includes('#1.')&&f.id.endsWith('.value'))||candidates[0];
  if(best)return best.col}
 return null;
}
function saveChildren(){
 if(!$('childBody').children.length)return;
 children=[...$('childBody').querySelectorAll('tr')].map(tr=>{
  const idx=Number(tr.dataset.row),prev=children[idx]||{col_values:{}},col_values={...(prev.col_values||{})};
  for(const inp of tr.querySelectorAll('input[data-token]')){
   const column=currentMapping[inp.dataset.token];if(column)col_values[String(column)]=inp.value}
  const sku=tr.querySelector('input[data-name="sku"]').value;
  const asin=tr.querySelector('input[data-name="asin"]').value;
  let title=tr.querySelector('input[data-name="title"]').value;
  const old=(meta?.sample_children||[])[idx];
  if(old&&(sku.trim()!==old.sku.trim()||asin.trim().toUpperCase()!==old.asin.trim().toUpperCase())&&title===(old.title||''))title='';
  return {sku,asin,title,col_values};
 });
}
function renderMapping(){
 const area=$('mapArea');area.innerHTML='';
 for(const token of tokens()){
  if(!Object.prototype.hasOwnProperty.call(currentMapping,token))currentMapping[token]=colGuess(token);
  const div=document.createElement('div'),label=document.createElement('label');label.textContent=token+' → 模板字段';div.appendChild(label);
  const sel=document.createElement('select');sel.dataset.token=token;sel.appendChild(optionEl('','未找到：请手动选择'));
  meta.field_options.forEach(f=>sel.appendChild(optionEl(String(f.col),f.label+' ['+f.id+']')));
  sel.value=String(currentMapping[token]||'');
  sel.addEventListener('change',()=>{saveChildren();currentMapping[token]=Number(sel.value)||null;renderChildren()});
  div.appendChild(sel);area.appendChild(div)}
}
function renderChildren(){
 const t=tokens();$('childHeader').innerHTML='<tr><th>子 SKU *</th><th>子 ASIN *</th><th class="optional-col">子体原标题（可选）</th>'+t.map(x=>'<th>'+safe(x)+' *</th>').join('')+'<th>操作</th></tr>';
 const body=$('childBody');body.innerHTML='';
 setText('childRowCount','当前 '+children.length+' 个子体填写位置；没有填写内容的行不会导出。');
 children.forEach((row,idx)=>{
  const tr=document.createElement('tr');tr.dataset.row=idx;
  tr.innerHTML='<td><input data-name="sku" value="'+safe(row.sku)+'" placeholder="已上架 SKU"/></td>'+
  '<td><input data-name="asin" value="'+safe(row.asin)+'" placeholder="B0XXXXXXXX"/></td>'+
  '<td class="optional-col"><input data-name="title" value="'+safe(row.title||'')+'" placeholder="原有标题（留空不更新）" style="min-width:235px"/></td>'+
  t.map(token=>{const col=currentMapping[token],val=(row.col_values||{})[String(col)]||'';
   return '<td><input data-token="'+safe(token)+'" value="'+safe(val)+'" placeholder="'+safe(token)+'"/></td>'}).join('')+
  '<td><button type="button" class="ghost" data-remove="'+idx+'">移除</button></td>';
  body.appendChild(tr);
 });
 body.querySelectorAll('button[data-remove]').forEach(b=>b.addEventListener('click',()=>{
  saveChildren();children.splice(Number(b.dataset.remove),1);renderChildren()
 }));
}
const addEmptyChildren=(count)=>{
 saveChildren();
 for(let i=0;i<count;i++)children.push({sku:'',asin:'',title:'',col_values:{}});
 renderChildren();
};
$('addChild').addEventListener('click',()=>addEmptyChildren(1));
$('addFiveChildren').addEventListener('click',()=>addEmptyChildren(5));
$('showTitles').addEventListener('change',()=>{$('childrenTable').classList.toggle('show-titles',$('showTitles').checked)});
$('theme').addEventListener('change',()=>{
 saveChildren();currentMapping=Object.fromEntries(tokens().map(t=>[t,colGuess(t)]));renderMapping();renderChildren();
});
$('addExtra').addEventListener('click',()=>{
 if(!meta)return;
 const div=document.createElement('div');div.className='three-grid';div.style.marginBottom='12px';
 const scope=document.createElement('select');scope.appendChild(optionEl('parent','只填父体'));
 scope.appendChild(optionEl('child','只填所有子体'));scope.appendChild(optionEl('both','父体及所有子体'));
 const field=document.createElement('select');field.appendChild(optionEl('','请选择模板字段'));
 meta.field_options.forEach(f=>field.appendChild(optionEl(String(f.col),f.label+' ['+f.id+']')));
 const value=document.createElement('input');value.placeholder='填写值';
 const a=document.createElement('div'),b=document.createElement('div'),c=document.createElement('div');
 a.appendChild(scope);b.appendChild(field);c.appendChild(value);div.append(a,b,c);$('extraFields').appendChild(div);
});
function gather(){
 saveChildren();const theme=$('theme').value;
 const extras=[...$('extraFields').children].map(div=>({
  scope:div.children[0].querySelector('select').value,
  col:Number(div.children[1].querySelector('select').value),
  value:div.children[2].querySelector('input').value
 })).filter(x=>x.col&&x.value.trim());
 const bullets={};for(const el of document.querySelectorAll('textarea[data-bullet]'))bullets[el.dataset.bullet]=el.value;
 return {
  parent_sku:$('parent_sku').value,theme,theme_cols:Object.fromEntries(tokens().map(t=>[t,currentMapping[t]])),
  children:children.filter(x=>x.sku||x.asin||x.title||tokens().some(t=>x.col_values[String(currentMapping[t])])),
  product_type:$('product_type').value,item_name:$('item_name').value,brand:$('brand').value,
  item_type_keyword:$('item_type_keyword').value,description:$('description').value,
  origin:$('origin').value,batteries:$('batteries').value,hazmat:$('hazmat').value,
  reuse_sample_parent:$('reuse_parent').checked,reuse_sample_child:$('reuse_child').checked,
  extras,bullets
 };
}
$('generate').addEventListener('click',async()=>{
 const button=$('generate');button.disabled=true;notify('result','正在检查、生成 Excel，请稍候…');
 try{
  const cfg=gather(),out=await VariationEngine.generate(currentTemplate,cfg);
  const safeSku=cfg.parent_sku.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,45)||'parent';
  const ext=/\.xlsm$/i.test(selectedFile.name)?'.xlsm':'.xlsx';
  const name='Variation_Merge_'+safeSku+ext;
  const url=URL.createObjectURL(out.blob),a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  notify('result','已生成：1 个父体 + '+cfg.children.length+' 个子体。所有子体 Parent SKU 均为 '+cfg.parent_sku+'。'+(out.warnings.length?out.warnings.join('；')+'。':'')+'请上传到亚马逊并检查处理报告。');
 }catch(err){notify('result',err.message,'error')}
 finally{button.disabled=false}
});

refreshLibraryData();

