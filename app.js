/* Web UI for Amazon variation family generation (local-only). */
let meta=null, selectedFile=null, currentTemplate=null, children=[], currentMapping={};
const $=(id)=>document.getElementById(id);
const safe=(v)=>String(v??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const setText=(id,v)=>{$(id).textContent=String(v??'')};
const setVal=(id,v)=>{$(id).value=String(v??'')};
const tokens=()=>($('theme').value||'').split('/').map(x=>x.trim()).filter(Boolean);
function notify(id,msg,kind=''){let el=$(id);el.textContent=msg;el.className='notice'+(kind?' '+kind:'')}
function optionEl(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o}
$('file').addEventListener('change',async(e)=>{
 const file=e.target.files[0];if(!file)return;
 $('editor').classList.add('hidden');$('metrics').classList.add('hidden');selectedFile=file;
 notify('loadStatus','正在解析模板，请稍候…');
 try{
  if(typeof JSZip==='undefined')throw new Error('Excel 文件处理库未加载成功，请刷新网页重试');
  currentTemplate=await VariationEngine.inspect(await file.arrayBuffer(),file.name);meta=currentTemplate.meta;initEditor();
  $('editor').classList.remove('hidden');
  $('metrics').innerHTML='<div class="pill"><strong>'+meta.header_count+'</strong>列字段</div><div class="pill"><strong>'+meta.theme_options.length+'</strong>种变体主题</div><div class="pill"><strong>'+meta.sample_children_count+'</strong>个样例子体</div>';
  $('metrics').classList.remove('hidden');
  notify('loadStatus','模板已识别。请检查标题、SKU、变体属性和其他必填字段。');
 }catch(err){notify('loadStatus',err.message,'error')}
});
function initEditor(){
 setVal('parent_sku',meta.parent_sku);setVal('product_type',meta.product_type);
 for(const key of ['item_name','brand','item_type_keyword','description','origin','batteries','hazmat'])setVal(key,meta.basic[key]);
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
  label.textContent='Bullet Point '+b.order+'｜父体卖点 '+b.order+' *';
  const textarea=document.createElement('textarea');
  textarea.dataset.bullet=String(b.col);
  textarea.placeholder='填写与所有变体一致的真实卖点 '+b.order;
  textarea.value=b.value||'';
  wrap.append(label,textarea);$('bulletFields').appendChild(wrap);
 }
 const catMode=String(meta.product_type||'').toUpperCase()==='ANIMAL_SHELTER';
 $('catCopy').classList.toggle('hidden',!catMode);
 $('copyWarning').classList.add('hidden');
 $('extraFields').innerHTML='';currentMapping={...meta.default_theme_cols};
 children=meta.sample_children.map(row=>({sku:row.sku,asin:row.asin,title:row.title||'',col_values:row.col_values}));
 if(!children.length)children=[{sku:'',asin:'',title:'',col_values:{}},{sku:'',asin:'',title:'',col_values:{}}];
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
$('addChild').addEventListener('click',()=>{saveChildren();children.push({sku:'',asin:'',title:'',col_values:{}});renderChildren()});
$('showTitles').addEventListener('change',()=>{$('childrenTable').classList.toggle('show-titles',$('showTitles').checked)});
$('catCopy').addEventListener('click',()=>{
 if(!meta||String(meta.product_type||'').toUpperCase()!=='ANIMAL_SHELTER')return;
 const yes=window.confirm('这些英文文案适用于有保温层、防水顶篷、可洗垫的户外猫屋。请在使用前逐条核对实际功能。是否填入参考文案？');
 if(!yes)return;
 const brand=$('brand').value.trim();
 const prefix=brand?brand+' ':'';
 $('description').value=prefix+'outdoor cat house offers a sheltered resting space for feral, stray, and outdoor cats. The weather-resistant outer material and protective canopy help reduce direct exposure to rain and wind. An insulating layer helps create a more comfortable resting area in cooler weather. A removable mat makes routine cleaning more convenient. Review the selected size and variation details to choose the right shelter for your cats.';
 const bulletCopy=[
  'Weather-Resistant Shelter: A protective canopy and weather-resistant materials help shield outdoor cats from rain and wind.',
  'Insulated for Cooler Weather: The built-in insulation layer helps create a more comfortable resting place for feral and stray cats.',
  'Removable Washable Mat: The included mat can be removed for regular cleaning and everyday pet comfort.',
  'Convenient Assembly: Designed for easy setup and routine maintenance with secure fastening details.',
  'Outdoor Cat Resting Space: Provides a dedicated shelter for community, stray, and feral cats in suitable outdoor locations.'
 ];
 [...document.querySelectorAll('textarea[data-bullet]')].forEach((el,i)=>{if(bulletCopy[i])el.value=bulletCopy[i]});
 $('copyWarning').classList.remove('hidden');
 $('description').focus();
});
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
