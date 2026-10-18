// 中文注释：跨扩展消息和脚本返回的对象键顺序可能不同，行身份只取实际单元格内容。
export function tableRowKey(row){return JSON.stringify(row.map(cell=>[cell.text,cell.links||[]]));}
export function tableIdentity(capture,table){return JSON.stringify([capture.url,capture.documentId||'',capture.epoch||0,table.dom_path||table.id,table.headers]);}

// 中文注释：此函数可直接在隔离世界执行；只读渲染后的表格文字，不读控件值或隐藏节点。
export function captureTables(doc=globalThis.document,minimumRows=3,depth=0){
 if(![9,11].includes(doc?.nodeType)){minimumRows=doc||{};doc=globalThis.document;}const options=typeof minimumRows==='object'?minimumRows:{};minimumRows=Math.max(1,Math.min(3,options.minimumRows||(typeof minimumRows==='number'?minimumRows:3)));const owner=doc.nodeType===9?doc:doc.ownerDocument;
 const aliases=new Set(['keyword','关键词','搜索量','volume','kd','position','排名',...(options.headers||[])].map(value=>String(value).toLowerCase().trim()));
 const controls='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=textbox],[role=searchbox],[data-private]';
 const cache=new WeakMap(),win=owner.defaultView||globalThis,visible=el=>{if(cache.has(el))return cache.get(el);for(let n=el;n&&n.nodeType===1;n=n.parentElement||n.getRootNode()?.host){const s=n.ownerDocument.defaultView.getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity==='0'){cache.set(el,false);return false;}}const result=el.getClientRects().length>0;cache.set(el,result);return result;};
 const text=el=>{if(!el||el.closest(controls)||!visible(el))return '';let value='',count=0;const walker=owner.createTreeWalker(el,5,{acceptNode:n=>n.nodeType===1&&(n.matches(controls+',script,style,table,[role=table],[role=grid],[role=treegrid]')||!visible(n))?2:1});let node;while((node=walker.nextNode())&&count++<5000&&value.length<=10000)if(node.nodeType===3)value+=node.nodeValue.slice(0,10001-value.length)+' ';return value.replace(/\s+/g,' ').trim();};
 const hints=[...doc.querySelectorAll('[class*=header-row i],[class*=headrow i],[data-ui-name*="Head.Row" i]')].map(row=>row.parentElement);
 const custom=[];for(const selector of options.selectors||[])try{custom.push(...doc.querySelectorAll(selector));}catch{}
 const tables=[],seen=new Set(),roots=[...new Set([...custom,...doc.querySelectorAll('table,[role=grid],[role=table],[role=treegrid],[class*=table i],[class*=grid i],[data-ui-name*=Table i],[data-ui-name*=Grid i],.ag-root,.ag-root-wrapper,.el-table,.ant-table,.vxe-table,[data-testid*=table i],[data-testid*=grid i]'),...hints])].slice(0,100);
 for(const root of roots){
  if([...seen].some(previous=>previous.contains(root))||!visible(root)||root.closest('[data-fast-automation-overlay]'))continue;
  const native=root.tagName==='TABLE',aria=root.matches('[role=grid],[role=table],[role=treegrid]');
  let rows=[...root.querySelectorAll(native?'tr':aria?'[role=row]':':scope > *, :scope > * > *')].filter(row=>visible(row)&&(!(native||aria)||row.closest('table,[role=grid],[role=table],[role=treegrid]')===root));
  const cells=row=>{if(native||aria)return [...row.querySelectorAll('th,td,[role=columnheader],[role=rowheader],[role=cell],[role=gridcell]')].filter(cell=>visible(cell)&&cell.closest('tr,[role=row]')===row&&cell.closest('table,[role=grid],[role=table],[role=treegrid]')===root);let values=[...row.children].filter(el=>visible(el));if(values.length===1&&values[0].children.length>1)values=[...values[0].children].filter(visible);return values;};
  if(!native&&!aria)rows=[...root.querySelectorAll('tr,[role=row],[class*=row i],[data-ui-name*=Row i]')].filter(visible);
  if(!native&&!aria){const signaled=rows.filter(row=>cells(row).length>=2&&(row.matches('tr')||/row|head/i.test(String(row.className)+' '+row.getAttribute('data-ui-name'))||row.querySelector('[role=columnheader]')));rows=signaled.length>=minimumRows+1?signaled:[...root.querySelectorAll(':scope > *, :scope > * > *')].filter(row=>visible(row)&&cells(row).length>=2);}
  const required=root.getAttribute('aria-rowcount')||/virtual|ag-root/i.test(root.className)?1:minimumRows;
  if(rows.length<required+1)continue;
  const header=rows.find(row=>row.querySelector('th,[role=columnheader]')||/head/i.test(String(row.className)+' '+row.getAttribute('data-ui-name'))||cells(row).filter(cell=>aliases.has(text(cell).toLowerCase().trim())).length>=2);
  if(!header)continue;
  // 中文注释：按逻辑列展开合并单元格；连续列表头合成路径，行合并沿用同一个原始单元格。
  const carried=new Map(),grid=[];let invalid=false;
  for(const [index,row] of rows.entries()){
   const values=[];for(const [column,value] of carried)if(value.until>index)values[column]=value.cell;else carried.delete(column);
   let column=0;
   for(const cell of cells(row)){
    while(values[column])column++;
    const colSpan=Number(cell.getAttribute('colspan')||cell.getAttribute('aria-colspan')||1),rawRowSpan=Number(cell.getAttribute('rowspan')??cell.getAttribute('aria-rowspan')??1),rowSpan=rawRowSpan===0?rows.slice(index).filter(other=>other.parentElement===row.parentElement).length:rawRowSpan;
    if(!Number.isInteger(colSpan)||!Number.isInteger(rowSpan)||colSpan<1||rowSpan<1||colSpan>100||rowSpan>100||column+colSpan>100){invalid=true;break;}
    for(let c=0;c<colSpan;c++){if(values[column+c]){invalid=true;break;}values[column+c]=cell;if(rowSpan>1)carried.set(column+c,{cell,until:index+rowSpan});}column+=colSpan;
   }
   if(invalid)break;grid.push({row,values});
  }
  if(invalid)continue;
  const start=rows.indexOf(header),headerRows=[];let firstData=start;
  while(firstData<grid.length&&(firstData===start||cells(grid[firstData].row).every(cell=>cell.matches('th,[role=columnheader]')))){headerRows.push(grid[firstData++].values);}
  const width=Math.max(0,...headerRows.map(values=>values.length));if(width<2||width>100)continue;
  const headers=Array.from({length:width},(_,column)=>[...new Set(headerRows.map(values=>{const cell=values[column];return !cell||cell.closest(controls)?'':text(cell)||cell.getAttribute('aria-label')||'';}).filter(Boolean))].join(' / '));
  const data=[],rowKeys=[];let truncated=false,bytes=0;
  for(const {row,values} of grid.slice(firstData)){
   if(values.length>width){truncated=true;continue;}
   const line=Array.from({length:width},(_,i)=>{const cell=values[i];return {text:text(cell),links:cell?[...cell.querySelectorAll('a[href]')].filter(a=>visible(a)&&!a.closest(controls)).map(a=>a.href).filter(url=>/^https?:\/\//.test(url)):[]};});
   bytes+=new TextEncoder().encode(JSON.stringify(line)).length;
   if(line.some(cell=>cell.text.length>10000)||data.length>=2000||bytes>1500000){truncated=true;break;}
   if(line.some(cell=>cell.text)){data.push(line);const index=Number(row.getAttribute('aria-rowindex'));rowKeys.push(Number.isSafeInteger(index)&&index>0?'aria-rowindex:'+index:null);}
  }
  if(data.length<required)continue;
  const chart=root.closest('[aria-label="A tabular representation of the data in the chart."]')?.parentElement;
  const scope=root.closest('widget,section,article,[role=region]')||root.parentElement||doc;
  const name=text(root.querySelector('caption'))||text(root.previousElementSibling?.matches('h1,h2,h3,h4')?root.previousElementSibling:scope.querySelector('h1,h2,h3,.widget-title'))||owner.title||'页面表格';
  const url=new URL(owner.location.href),key=[...url.searchParams.keys()].find(k=>/^(page|pageno|page_number|offset|start)$/i.test(k));
  const query=url.searchParams.get('q')?.split(',')||[];
  if(chart&&url.hostname==='trends.google.com'&&headers[0]==='x'&&query.length===headers.length-1&&query.every((word,i)=>word&&!word.startsWith('/')&&headers[i+1]==='y'+(i+1)))headers.splice(0,headers.length,/^zh/i.test(owner.documentElement.lang)?'日期':'Date',...query);
  const buttons=[...scope.querySelectorAll('a[rel=next],button,[role=button],a')].filter(el=>visible(el)&&/^(下一页|下页|next(?: page)?|[›»→]|加载更多|load more)$/i.test((el.getAttribute('aria-label')||text(el)).trim()));
  const next=buttons.filter(el=>!el.disabled&&el.getAttribute('aria-disabled')!=='true');
  const info=[...scope.querySelectorAll('[aria-label],[data-total-pages],[data-total],.pagination,[class*=pagination]')].filter(visible).map(el=>(el.getAttribute('aria-label')||'')+' '+text(el)).join(' ').slice(0,10000);
  const pageMatch=info.match(/共\s*(\d+)\s*页|(?:of|共)\s*(\d+)\s*pages?|page\s*\d+\s+of\s+(\d+)/i),rowMatch=info.match(/共\s*([\d,]+)\s*(?:条|行|个)|(?:of|total)\s*([\d,]+)\s*(?:rows|items)/i);
  const totalRows=Number(root.getAttribute('aria-rowcount')||rowMatch?.[1]?.replaceAll(',','')||rowMatch?.[2]?.replaceAll(',',''))||null;
  const totalPages=Number(root.dataset.totalPages||pageMatch?.[1]||pageMatch?.[2]||pageMatch?.[3])||null;
  let scroll=root;while(scroll&&scroll!==owner.body&&scroll.scrollHeight<=scroll.clientHeight+4)scroll=scroll.parentElement;
  const virtual=/virtual|infinite/i.test(root.className)||!!root.closest('[data-infinite-scroll],[data-virtual]')||(totalRows!==null&&totalRows>data.length&&!key&&!buttons.length);
  const kind=chart?'none':key?'url':buttons.length?'button':virtual?'scroll':'none';
  const current=key?Number(url.searchParams.get(key))||0:null;
  const pagination={kind,key:key||null,current,totalPages,totalRows,next:next.length===1,ambiguous:next.length>1,offsetStep:/offset|start/i.test(key||'')?data.length:1};
  const incomplete=truncated||kind!=='none'||(totalRows!==null&&totalRows>data.length);
  const pathTo=el=>{const path=[];for(let node=el;node?.nodeType===1;node=node.parentElement)path.unshift(node.localName+':nth-child('+([...node.parentElement?.children||[node]].indexOf(node)+1)+')');return path.join(' > ');};
  tables.push({dom_path:pathTo(root),...(chart?{visual_path:pathTo(chart)}:{}),id:String(tables.length),dom_id:root.id&&doc.getElementById(root.id)===root?root.id:null,name:name.slice(0,200),headers,rows:data,...(rowKeys.some(Boolean)?{row_keys:rowKeys}:{}),pagination,incomplete,truncated});seen.add(root);
  if(tables.length>=10)break;
 }
 if(depth<3&&tables.length<10){
  const pathTo=el=>{const parts=[];for(let node=el;node?.nodeType===1;node=node.parentElement)parts.unshift(node.localName+':nth-child('+([...node.parentElement?.children||[node]].indexOf(node)+1)+')');return parts.join(' > ');};
  for(const el of [...doc.querySelectorAll('*')].slice(0,3000)){
   if(tables.length>=10)break;let child=null,separator='';
   if(el.shadowRoot){child=el.shadowRoot;separator=' >>> ';}
   else if(el.localName==='iframe'&&visible(el)){try{child=el.contentDocument;if(child&&child.defaultView.location.origin!==owner.location.origin&&child.defaultView.location.href!=='about:blank')child=null;}catch{}separator=' ::frame:: ';}
   if(!child)continue;const captured=captureTables(child,{...options,minimumRows},depth+1);
   for(const table of captured.tables){tables.push({...table,id:String(tables.length),pagination:{...table.pagination,kind:'none'},truncated:table.truncated||table.pagination.kind!=='none',incomplete:table.incomplete||table.pagination.kind!=='none',dom_path:pathTo(el)+separator+table.dom_path,...(table.visual_path?{visual_path:pathTo(el)+separator+table.visual_path}:{})});if(tables.length>=10)break;}
  }
 }
 return {url:owner.location.href,tables};
}

// 中文注释：只对当前任务工作页中已重新识别的分页控件动作，不选站点“导出”按钮。
export function advanceTable({headers,kind,inspect=false},doc=globalThis.document){
 const selector=el=>{const parts=[];for(let node=el;node?.nodeType===1;node=node.parentElement)parts.unshift(node.localName+':nth-child('+([...node.parentElement?.children||[node]].indexOf(node)+1)+')');return parts.join(' > ');};
 const visible=el=>!el.hidden&&el.getAttribute('aria-hidden')!=='true'&&doc.defaultView.getComputedStyle(el).display!=='none'&&el.getClientRects().length>0;
 const alerts=[...doc.querySelectorAll('h1,h2,[role=alert],iframe[src*=captcha],input[type=password]')].filter(visible);
 if(alerts.some(el=>el.matches('iframe,input')||/验证码|captcha|sign in|log in|请登录|额度不足|quota exceeded|limit reached/i.test(el.textContent||'')))return {blocked:'遇到登录、验证码或额度提示'};
 if(kind==='button'){
  const choices=[...doc.querySelectorAll('a[rel=next],button,[role=button],a')].filter(el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&/^(下一页|下页|next(?: page)?|[›»→]|加载更多|load more)$/i.test((el.getAttribute('aria-label')||el.textContent).trim()));
  if(choices.length!==1)return {done:!choices.length,blocked:choices.length?'分页控件不唯一':null};if(choices[0].target&&choices[0].target!=='_self'||/window\.open|showModalDialog/.test(choices[0].getAttribute('onclick')||''))return {blocked:'分页要求新窗口，停止后台收集'};if(inspect)return {control:'click',root:selector(choices[0]),name:(choices[0].getAttribute('aria-label')||choices[0].textContent).trim()};choices[0].click();return {advanced:true};
 }
 if(kind==='scroll'){
  const roots=[...doc.querySelectorAll('table,[role=grid],[role=table],[role=treegrid],[class*=table i],[class*=grid i],[data-ui-name*=Table i],[data-ui-name*=Grid i],.ag-root,.ag-root-wrapper,.el-table,.ant-table,.vxe-table,[data-testid*=table i],[data-testid*=grid i]')];
  let root=roots.find(el=>headers.every(name=>el.textContent.includes(name)));
  if(!root)return {blocked:'表格结构已变化'};
  while(root&&root!==doc.body&&root.scrollHeight<=root.clientHeight+4)root=root.parentElement;
  root=root||doc.scrollingElement;
  if(root.scrollTop+root.clientHeight>=root.scrollHeight-2)return {done:true};
  if(inspect)return {control:'scroll',root:selector(root)};
  root.scrollTop+=Math.max(1,root.clientHeight*.8);root.dispatchEvent(new doc.defaultView.Event('scroll',{bubbles:true}));return {advanced:true};
 }
 return {done:true};
}
