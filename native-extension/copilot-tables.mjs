// 中文注释：此函数可直接在隔离世界执行；只读渲染后的表格文字，不读控件值或隐藏节点。
export function captureTables(doc=globalThis.document,minimumRows=3){
 if(doc?.nodeType!==9){minimumRows=doc?.minimumRows||3;doc=globalThis.document;}minimumRows=Math.max(1,Math.min(3,minimumRows));
 const controls='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=textbox],[role=searchbox]';
 const cache=new WeakMap(),win=doc.defaultView||globalThis,visible=el=>{if(cache.has(el))return cache.get(el);for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=win.getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity==='0'){cache.set(el,false);return false;}}const result=el.getClientRects().length>0;cache.set(el,result);return result;};
 const text=el=>{if(!el||el.closest(controls))return '';let value='';const walk=n=>{if(n.nodeType===3){value+=n.nodeValue+' ';return;}if(n.nodeType!==1||n.matches(controls+',script,style')||!visible(n))return;for(const child of n.childNodes)walk(child);};walk(el);return value.replace(/\s+/g,' ').trim();};
 const hints=[...doc.querySelectorAll('[class*=header-row i],[class*=headrow i],[data-ui-name*="Head.Row" i]')].map(row=>row.parentElement);
 const tables=[],seen=new Set(),roots=[...new Set([...doc.querySelectorAll('table,[role=grid],[role=table],[role=treegrid],[class*=table i],[class*=grid i],[data-ui-name*=Table i],[data-ui-name*=Grid i]'),...hints])].slice(0,100);
 for(const root of roots){
  if([...seen].some(previous=>previous.contains(root))||!visible(root)||root.closest('[data-fast-automation-overlay]'))continue;
  const native=root.tagName==='TABLE',aria=root.matches('[role=grid],[role=table],[role=treegrid]');
  let rows=[...root.querySelectorAll(native?'tr':aria?'[role=row]':':scope > *, :scope > * > *')].filter(visible);
  const cells=row=>[...row.children].filter(el=>visible(el));
  if(!native&&!aria)rows=[...root.querySelectorAll('[role=row],[class*=row i],[data-ui-name*=Row i]')].filter(visible);
  if(!native&&!aria){const signaled=rows.filter(row=>cells(row).length>=2&&(/row|head/i.test(String(row.className)+' '+row.getAttribute('data-ui-name'))||row.querySelector('[role=columnheader]')));rows=signaled.length>=minimumRows+1?signaled:[...root.querySelectorAll(':scope > *, :scope > * > *')].filter(row=>visible(row)&&cells(row).length>=2);}
  if(rows.length<minimumRows+1)continue;
  const header=rows.find(row=>row.querySelector('th,[role=columnheader]')||/head/i.test(String(row.className)+' '+row.getAttribute('data-ui-name')));
  if(!header)continue;const heads=cells(header);if(heads.length<2||heads.length>100)continue;
  const headers=heads.map(cell=>text(cell)||cell.getAttribute('aria-label')||'');

  const data=[];let truncated=false,bytes=0;
  for(const row of rows){
   if(row===header||row.querySelector('[role=columnheader]'))continue;
   const values=cells(row);if(values.length!==headers.length)continue;
   const line=values.map(cell=>({text:text(cell),links:[...cell.querySelectorAll('a[href]')].filter(a=>visible(a)&&!a.closest(controls)).map(a=>a.href).filter(url=>/^https?:\/\//.test(url))}));
   bytes+=JSON.stringify(line).length;
   if(line.some(cell=>cell.text.length>10000)||data.length>=2000||bytes>1500000){truncated=true;break;}
   if(line.some(cell=>cell.text))data.push(line);
  }
  if(data.length<minimumRows)continue;
  const name=text(root.querySelector('caption'))||text(root.previousElementSibling?.matches('h1,h2,h3,h4')?root.previousElementSibling:root.closest('section')?.querySelector('h1,h2,h3'))||doc.title||'页面表格';
  const url=new URL(doc.location.href),key=[...url.searchParams.keys()].find(k=>/^(page|pageno|page_number|offset|start)$/i.test(k));
  const buttons=[...doc.querySelectorAll('a[rel=next],button,[role=button],a')].filter(el=>visible(el)&&/^(下一页|下页|next(?: page)?|[›»→]|加载更多|load more)$/i.test((el.getAttribute('aria-label')||text(el)).trim()));
  const next=buttons.filter(el=>!el.disabled&&el.getAttribute('aria-disabled')!=='true');
  const info=[...doc.querySelectorAll('[aria-label],[data-total-pages],[data-total],.pagination,[class*=pagination]')].filter(visible).map(el=>(el.getAttribute('aria-label')||'')+' '+text(el)).join(' ').slice(0,10000);
  const pageMatch=info.match(/共\s*(\d+)\s*页|(?:of|共)\s*(\d+)\s*pages?|page\s*\d+\s+of\s+(\d+)/i),rowMatch=info.match(/共\s*([\d,]+)\s*(?:条|行|个)|(?:of|total)\s*([\d,]+)\s*(?:rows|items)/i);
  const totalRows=Number(root.getAttribute('aria-rowcount')||rowMatch?.[1]?.replaceAll(',','')||rowMatch?.[2]?.replaceAll(',',''))||null;
  const totalPages=Number(root.dataset.totalPages||pageMatch?.[1]||pageMatch?.[2]||pageMatch?.[3])||null;
  let scroll=root;while(scroll&&scroll!==doc.body&&scroll.scrollHeight<=scroll.clientHeight+4)scroll=scroll.parentElement;
  const virtual=/virtual|infinite/i.test(root.className)||!!root.closest('[data-infinite-scroll],[data-virtual]')||(totalRows!==null&&totalRows>data.length&&!key&&!buttons.length);
  const kind=key?'url':buttons.length?'button':virtual?'scroll':'none';
  const current=key?Number(url.searchParams.get(key))||0:null;
  const pagination={kind,key:key||null,current,totalPages,totalRows,next:next.length===1,ambiguous:next.length>1,offsetStep:/offset|start/i.test(key||'')?data.length:1};
  const incomplete=truncated||kind!=='none'||(totalRows!==null&&totalRows>data.length);
  tables.push({id:String(tables.length),dom_id:root.id&&doc.getElementById(root.id)===root?root.id:null,name:name.slice(0,200),headers,rows:data,pagination,incomplete,truncated});seen.add(root);
  if(tables.length>=10)break;
 }
 return {url:doc.location.href,tables};
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
  const roots=[...doc.querySelectorAll('table,[role=grid],[role=table],[role=treegrid],[class*=table i],[class*=grid i],[data-ui-name*=Table i],[data-ui-name*=Grid i]')];
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
