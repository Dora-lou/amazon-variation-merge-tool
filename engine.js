/* Amazon variation template engine; all workbook data is handled locally in the browser. */
(function(root){
'use strict';
const M='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XNS='http://www.w3.org/XML/1998/namespace';
const rules={
 sku:['contribution_sku#1.value',null],product_type:['product_type#1.value',null],action:['::record_action',null],
 parentage:[null,'parentage_level['],parent_sku:[null,'child_parent_sku_relationship['],
 theme:['variation_theme#1.name',null],item_name:[null,'item_name['],brand:[null,'brand['],
 product_id_type:['amzn1.volt.ca.product_id_type',null],product_id:['amzn1.volt.ca.product_id_value',null],
 item_type_keyword:[null,'item_type_keyword['],description:[null,'product_description['],
 origin:[null,'country_of_origin['],batteries:[null,'batteries_required['],hazmat:[null,'supplier_declared_dg_hz_regulation[']
};
const aliases={COLOR:['color'],SIZE:['size'],STYLE:['style_name','style'],STYLE_NAME:['style_name','style'],
 MATERIAL:['material','material_type'],COVER_MATERIAL:['cover_material'],FILL_MATERIAL:['fill_material'],
 SET_NAME:['set_name'],ITEM_SHAPE:['item_shape'],SHAPE:['item_shape'],NUMBER_OF_ITEMS:['number_of_items'],
 SCENT:['scent'],PATTERN:['pattern'],FLAVOR:['flavor'],CAPACITY:['capacity'],LENGTH:['length']};
function fail(msg){throw new Error(msg)}
function parse(xml){const doc=new DOMParser().parseFromString(xml,'application/xml');
 if(doc.getElementsByTagName('parsererror').length)fail('Excel 模板 XML 解析失败');return doc}
function node(parent,name){return [...parent.childNodes].find(n=>n.nodeType===1&&n.localName===name)||null}
function nodes(parent,name){return [...parent.childNodes].filter(n=>n.nodeType===1&&n.localName===name)}
function attr(n,name){return n?.getAttribute(name)||''}
function colnum(ref){const a=/^[A-Z]+/.exec(ref||'');if(!a)fail('无效单元格地址：'+ref);return [...a[0]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)}
function colname(n){let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}
function ctext(c,shared){if(!c)return '';
 const typ=attr(c,'t');const v=node(c,'v');
 if(typ==='s'&&v)return shared[Number(v.textContent)]||'';
 if(typ==='inlineStr'){const is=node(c,'is');return is?[...is.getElementsByTagNameNS(M,'t')].map(x=>x.textContent||'').join(''):''}
 return v?.textContent||''}
function values(sheet,shared){const sd=node(sheet.documentElement,'sheetData'),out=new Map();if(!sd)return out;
 for(const r of nodes(sd,'row')){let cols={};for(const c of nodes(r,'c'))cols[colnum(attr(c,'r'))]=ctext(c,shared);out.set(Number(attr(r,'r')),cols)}
 return out}
function relTarget(wb,rels,name){const ss=node(wb.documentElement,'sheets');const tab=nodes(ss,'sheet').find(s=>attr(s,'name')===name);
 if(!tab)fail('没有找到工作表：'+name);
 const rid=tab.getAttributeNS(REL,'id')||attr(tab,'r:id');
 const link=nodes(rels.documentElement,'Relationship').find(r=>attr(r,'Id')===rid);
 if(!link)fail('工作表关联记录不存在：'+name);
 let target=attr(link,'Target').replace(/\\/g,'/');
 if(target.startsWith('/'))return target.substring(1);
 const parts=['xl',...target.split('/')];let path=[];
 for(const p of parts){if(!p||p==='.')continue;if(p==='..')path.pop();else path.push(p)}
 return path.join('/')}
async function fileText(zip,p){const f=zip.file(p);if(!f)fail('模板缺少内部文件：'+p);return f.async('string')}
function isExampleCopy(value){
 const s=String(value||'').toLowerCase().trim();
 if(!s)return false;
 return /this summer, boots by jette|breathable leather lining|adidas blue sneakers|^lorem ipsum|^example product (description|bullet)/i.test(s);
}
function findField(ids,[ex,pr]){if(ex){for(const [k,v] of Object.entries(ids))if(v===ex)return Number(k)}
 if(pr){for(const [k,v] of Object.entries(ids))if(v.startsWith(pr))return Number(k)}return null}
function inferCol(headers,token){for(const prefix of aliases[token]||[token.toLowerCase()]){
 const cand=Object.entries(headers).filter(([,id])=>id.startsWith(prefix+'[')||id.startsWith(prefix+'#'));
 if(cand.length){const best=cand.find(([,id])=>id.includes('#1.')&&id.endsWith('.value'))||cand[0];return Number(best[0])}}
 return null}
function commonParent(children,fields,parent){let counts={};for(const x of children){const v=x[fields.parent_sku];if(v)counts[v]=(counts[v]||0)+1}
 let a=Object.entries(counts).sort((x,y)=>y[1]-x[1]);return a[0]?.[0]||parent[fields.sku]||''}
async function inspect(buffer,filename){
 if(!/\.(xlsx|xlsm)$/i.test(filename))fail('只支持 .xlsx / .xlsm 文件');
 if(buffer.byteLength>22*1024*1024)fail('文件超过 22 MB 上限');
 let zip;try{zip=await JSZip.loadAsync(buffer)}catch(e){fail('不是有效的 Excel 文件：'+e.message)}
 if(Object.keys(zip.files).some(x=>x.startsWith('_xmlsignatures/')))fail('不支持修改已数字签名的模板');
 const wb=parse(await fileText(zip,'xl/workbook.xml')),rel=parse(await fileText(zip,'xl/_rels/workbook.xml.rels'));
 const tabs=nodes(node(wb.documentElement,'sheets'),'sheet').map(x=>attr(x,'name'));
 const sheetName=tabs.includes('Template')?'Template':tabs[0];if(!sheetName)fail('工作簿没有工作表');
 const sheetPath=relTarget(wb,rel,sheetName),sheet=parse(await fileText(zip,sheetPath));
 let shared=[];
 if(zip.file('xl/sharedStrings.xml')){const doc=parse(await fileText(zip,'xl/sharedStrings.xml'));
 shared=[...doc.getElementsByTagNameNS(M,'si')].map(x=>[...x.getElementsByTagNameNS(M,'t')].map(t=>t.textContent||'').join(''))}
 const rr=values(sheet,shared);
 const found=[...rr.entries()].find(([,cols])=>Object.values(cols).includes('contribution_sku#1.value')&&Object.values(cols).includes('::record_action'));
 if(!found)fail('未找到亚马逊模板技术字段标题行');
 const headerRow=found[0],headers=Object.fromEntries(Object.entries(found[1]).filter(([,v])=>v)),labels=rr.get(headerRow-1)||{};
 const fields=Object.fromEntries(Object.entries(rules).map(([key,rule])=>[key,findField(headers,rule)]));
 const missing=['sku','product_type','action','parentage','parent_sku','theme'].filter(k=>!fields[k]);
 if(missing.length)fail('模板缺少必要字段：'+missing.join(', '));
 let dataStart=headerRow+3;
 for(let i=headerRow+1;i<headerRow+5;i++)if(Object.values(rr.get(i)||{}).join(' ').toLowerCase().includes('prefilled attributes')){dataStart=i+1;break}
 const dataRows=[...rr.entries()].filter(([row,cols])=>row>=dataStart&&(cols[fields.sku]||'').trim()).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
 const parents=dataRows.filter(row=>(row[fields.parentage]||'').toLowerCase()==='parent');
 const parent=parents[0]||{},children=dataRows.filter(row=>(row[fields.parentage]||'').toLowerCase()==='child');
 let themes=[],dropdown_options={},templateProductType='';
 if(tabs.includes('Dropdown Lists')){
  const dr=values(parse(await fileText(zip,relTarget(wb,rel,'Dropdown Lists'))),shared);
  const typeSamples=[...new Set(Object.values(dr.get(2)||{}).filter(v=>/^[A-Z][A-Z_0-9-]+$/.test(v)))];
  if(typeSamples.length===1)templateProductType=typeSamples[0];
  const head=[...dr.entries()].find(([,cells])=>Object.values(cells).includes('variation_theme#1.name'));
  if(head){
   const rowNo=head[0],columns=head[1],last=Math.max(...dr.keys());
   for(const key of ['theme','item_type_keyword','product_id_type','brand','origin','batteries','hazmat']){
    const col=fields[key];if(!col)continue;
    const id=headers[col],hit=Object.entries(columns).find(([,v])=>v===id);
    if(!hit)continue;
    const opts=[];
    for(let row=rowNo+1;row<=last;row++){
     const v=String((dr.get(row)||{})[Number(hit[0])]||'').trim();
     if(v&&!opts.includes(v))opts.push(v);
    }
    dropdown_options[key]=opts;
   }
   themes=dropdown_options.theme||[];
  }
 }
 const fieldValue=(obj,key)=>obj[fields[key]]||'';
 const resolvedProductType=fieldValue(parent,'product_type')||fieldValue(children[0]||{},'product_type')||templateProductType;
 const parentSku=commonParent(children,fields,parent);
 const theme=fieldValue(parent,'theme')||fieldValue(children[0]||{},'theme')||themes[0]||'COLOR/SIZE';
 const basic={};for(const key of ['item_name','brand','item_type_keyword','description','origin','batteries','hazmat'])basic[key]=fieldValue(parent,key)||fieldValue(children[0]||{},key);
 const defaults={origin:'China',batteries:'No',hazmat:'Not Applicable'};
 for(const [key,choice] of Object.entries(defaults)){
  if((dropdown_options[key]||[]).some(v=>v.toLowerCase()===choice.toLowerCase()))basic[key]=choice;
  else if(!basic[key]&&(dropdown_options[key]||[]).length===1)basic[key]=dropdown_options[key][0];
 }
 for(const key of ['item_type_keyword','brand']){
  const opts=dropdown_options[key]||[];
  if(!basic[key]&&opts.length===1)basic[key]=opts[0];
 }
 if(!basic.item_type_keyword){
  const slug=resolvedProductType.toLowerCase().replace(/_/g,'-');
  const matching=(dropdown_options.item_type_keyword||[]).filter(v=>{
   const m=/\(([^()]*)\)\s*$/.exec(v);
   return m&&((m[1]===slug)||(m[1]===slug+'s')||(slug&&m[1].startsWith(slug)));
  });
  if(matching.length===1)basic.item_type_keyword=matching[0];
 }
 // Collect bullet columns from schema, NOT only from already-filled data rows.
 // Blank official templates still have five available bullet fields.
 const bullets=Object.entries(headers).filter(([,id])=>id.startsWith('bullet_point['))
 .map(([c,id])=>({
  col:Number(c),
  order:Number((/#(\d+)\.value$/.exec(id)||[])[1]||1),
  label:'Bullet Point '+((/#(\d+)\.value$/.exec(id)||[])[1]||1),
  value:isExampleCopy(parent[c])?'':String(parent[c]||'')
 })).sort((a,b)=>a.order-b.order).slice(0,5);
 const sampleChildren=children.map(row=>({sku:fieldValue(row,'sku'),asin:fieldValue(row,'product_id'),title:fieldValue(row,'item_name'),col_values:Object.fromEntries(Object.entries(row).filter(([,v])=>v))}));
 const meta={header_count:Object.keys(headers).length,theme_options:themes.length?themes:[theme],default_theme:theme,
 field_options:Object.entries(headers).map(([c,id])=>({col:Number(c),label:labels[c]||'',id})).sort((x,y)=>x.col-y.col),
 parent_sku:parentSku,parent_original_sku:fieldValue(parent,'sku'),sample_children_count:children.length,
 basic,dropdown_options,product_type:resolvedProductType,bullets,
 sample_children:sampleChildren,has_sample_parent:Object.keys(parent).length>0,has_sample_child:children.length>0,
 schema_field_indices:fields,default_theme_cols:Object.fromEntries(theme.split('/').map(t=>[t,inferCol(headers,t)]))};
 return {zip,sheetPath,sheet,headers,labels,fields,rr,shared,dataStart,parent,child:children[0]||{},meta,filename};
}
function validate(t,cfg){const errors=[],warnings=[],parentSku=String(cfg.parent_sku||'').trim();
 const theme=String(cfg.theme||'').trim(),children=cfg.children||[],mapping=cfg.theme_cols||{};
 if(!parentSku)errors.push('新父体 SKU 不能为空');
 if(!theme)errors.push('必须选择变体主题');
 if(t.meta.theme_options.length&&!t.meta.theme_options.includes(theme))errors.push('变体主题不在模板可选列表中：'+theme);
 const tokens=theme.split('/').map(x=>x.trim()).filter(Boolean);
 for(const token of tokens){if(!t.headers[mapping[token]])errors.push('缺少变体属性字段映射：'+token)}
 if(children.length<2)warnings.push('子体不足两个，请核对是否需要变体关系');
 const skus=new Set(),asins=new Set(),combos=new Set();
 children.forEach((item,index)=>{const n=index+1,sku=String(item.sku||'').trim(),asin=String(item.asin||'').trim().toUpperCase();
 if(!sku)errors.push('第 '+n+' 个子体缺少 SKU');else if(sku===parentSku)errors.push('第 '+n+' 个子体 SKU 和父 SKU 相同');
 else if(skus.has(sku))errors.push('重复子 SKU：'+sku);skus.add(sku);
 if(!asin)errors.push('第 '+n+' 个子体缺少 ASIN');
 else if(!/^[A-Z0-9]{10}$/.test(asin))errors.push('ASIN 格式异常：'+asin);
 else if(asins.has(asin))errors.push('重复 ASIN：'+asin);asins.add(asin);
 const combo=tokens.map(token=>{const v=String(item.col_values?.[String(mapping[token])]||'').trim();
 if(!v)errors.push('第 '+n+' 个子体缺少 '+token);return v.toLowerCase()}).join('\u0000');
 if(combos.has(combo))errors.push('第 '+n+' 个子体变体属性组合重复');combos.add(combo)});
 if(!String(cfg.product_type||'').trim())errors.push('Product Type 不能为空');
 if(!String(cfg.item_name||'').trim())errors.push('父体标题不能为空');
 const description=String(cfg.description||'').trim();
 if(!description)errors.push('父体商品描述（Product Description）不能为空');
 else if(isExampleCopy(description))errors.push('父体描述包含亚马逊模板的示例文案，请替换为真实商品信息');
 else if(description.length<35)errors.push('父体商品描述过短，请填写完整的真实商品描述');
 const bulletList=t.meta.bullets||[];
 for(const b of bulletList){
  const value=String((cfg.bullets||{})[b.col]||'').trim();
  if(!value)errors.push('缺少父体卖点 '+b.order+'（Bullet Point '+b.order+'）');
  else if(isExampleCopy(value))errors.push('卖点 '+b.order+' 仍是模板示例文案，请替换');
  else if(value.length<12)errors.push('卖点 '+b.order+' 过短，请填写真实商品卖点');
 }
 if(t.fields.item_type_keyword&&!String(cfg.item_type_keyword||'').trim())errors.push('Item Type Keyword 未确定，请从模板允许值中选择');
 for(const key of ['item_type_keyword','brand','origin','batteries','hazmat']){
  const opts=t.meta.dropdown_options?.[key]||[],v=String(cfg[key]||'').trim();
  if(v&&opts.length&&!opts.includes(v))errors.push(key+' 的填写值不在模板下拉选项中：'+v);
 }
 const idTypes=t.meta.dropdown_options?.product_id_type||[];
 if(idTypes.length&&!idTypes.includes('ASIN'))errors.push('当前模板的 Product ID Type 下拉选项中没有 ASIN');
 return {errors,warnings}}
function setInline(cell,v,doc){for(const x of [...cell.childNodes])if(x.nodeType===1&&['v','is','f'].includes(x.localName))cell.removeChild(x);
 cell.setAttribute('t','inlineStr');const is=doc.createElementNS(M,'is'),text=doc.createElementNS(M,'t');
 text.textContent=String(v);if(/^\s|\s$/.test(String(v)))text.setAttributeNS(XNS,'xml:space','preserve');is.appendChild(text);cell.appendChild(is)}
function makeRow(doc,template,num,vals){const row=template?template.cloneNode(true):doc.createElementNS(M,'row');row.setAttribute('r',String(num));
 const old=new Map();for(const c of nodes(row,'c')){old.set(colnum(attr(c,'r')),c.cloneNode(true));row.removeChild(c)}
 for(const [cs,v] of Object.entries(vals).sort((a,b)=>Number(a[0])-Number(b[0]))){if(v==null||String(v)==='')continue;
 const col=Number(cs),cell=old.get(col)||doc.createElementNS(M,'c');cell.setAttribute('r',colname(col)+num);
 if(!cell.hasAttribute('s'))cell.setAttribute('s','0');setInline(cell,v,doc);row.appendChild(cell)}
 return row}
function setVal(obj,key,fields,v){if(fields[key])obj[fields[key]]=v}
async function generate(t,cfg){const report=validate(t,cfg);if(report.errors.length)fail(report.errors.join('；'));
 const fields=t.fields,parentSku=cfg.parent_sku.trim(),theme=cfg.theme,tokens=theme.split('/').map(x=>x.trim()).filter(Boolean);
 const identity=new Set(['sku','action','parentage','parent_sku','theme','product_id_type','product_id'].map(k=>fields[k]).filter(Boolean));
 const attrCols=new Set(Object.values(cfg.theme_cols).map(x=>Number(x)).filter(Boolean));
 function base(sample,reuse){return reuse?Object.fromEntries(Object.entries(sample).filter(([c])=>!identity.has(Number(c))&&!attrCols.has(Number(c)))):{}}
 const po=base(t.parent,cfg.reuse_sample_parent),co=base(t.child,cfg.reuse_sample_child);
 const shared=['product_type','brand','item_type_keyword','origin','batteries','hazmat'];
 for(const key of shared){setVal(po,key,fields,cfg[key]||'');setVal(co,key,fields,cfg[key]||'')}
 setVal(po,'item_name',fields,cfg.item_name||'');
 setVal(co,'item_name',fields,'');
 setVal(po,'description',fields,String(cfg.description||'').trim());
 setVal(co,'description',fields,'');
 for(const [col,id] of Object.entries(t.headers))if(id.startsWith('bullet_point['))delete co[col];
 for(const [col,v] of Object.entries(cfg.bullets||{}))if((t.headers[col]||'').startsWith('bullet_point['))po[col]=String(v||'').trim();
 for(const entry of cfg.extras||[]){const col=Number(entry.col),v=String(entry.value||'');
 if(!t.headers[col]||!v.trim())continue;
 if(entry.scope==='parent'||entry.scope==='both')po[col]=v;
 if(entry.scope==='child'||entry.scope==='both')co[col]=v}
 setVal(po,'sku',fields,parentSku);setVal(po,'action',fields,'Create or Replace (Full Update)');
 setVal(po,'parentage',fields,'Parent');setVal(po,'theme',fields,theme);
 const sheet=t.sheet;const sd=node(sheet.documentElement,'sheetData');if(!sd)fail('模板没有 sheetData');
 const oldRows=nodes(sd,'row').filter(x=>Number(attr(x,'r'))>=t.dataStart);
 const templateParent=oldRows[0]||null,templateChild=oldRows[1]||templateParent;
 for(const r of oldRows)sd.removeChild(r);
 sd.appendChild(makeRow(sheet,templateParent,t.dataStart,po));
 cfg.children.forEach((item,i)=>{const child={...co};
 setVal(child,'sku',fields,String(item.sku).trim());setVal(child,'action',fields,'Edit (Partial Update)');
 setVal(child,'parentage',fields,'Child');setVal(child,'parent_sku',fields,parentSku);setVal(child,'theme',fields,theme);
 setVal(child,'product_id_type',fields,'ASIN');setVal(child,'product_id',fields,String(item.asin).trim().toUpperCase());
 setVal(child,'item_name',fields,String(item.title||'').trim());
 for(const token of tokens)child[cfg.theme_cols[token]]=String(item.col_values[String(cfg.theme_cols[token])]||'').trim();
 sd.appendChild(makeRow(sheet,templateChild,t.dataStart+i+1,child))});
 const dim=node(sheet.documentElement,'dimension');if(dim){const old=dim.getAttribute('ref')||'';
 const matched=/:([A-Z]+)\d+$/.exec(old),far=matched?matched[1]:colname(Math.max(...Object.keys(t.headers).map(Number)));
 dim.setAttribute('ref','A1:'+far+(t.dataStart+cfg.children.length))}
 t.zip.file(t.sheetPath,new XMLSerializer().serializeToString(sheet));
 const content=await t.zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
 return {blob:content,warnings:report.warnings}}
root.VariationEngine={inspect,validate,generate};
})(typeof window!=='undefined'?window:globalThis);
