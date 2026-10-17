import {selectedText} from './copilot-selection.mjs';
import {createPageSemantics} from '../page-semantics/index.js';

export function ordinaryPage(url, contentType='text/html') {
 try {const parsed=new URL(url);return ['http:','https:'].includes(parsed.protocol)&&!parsed.pathname.toLowerCase().endsWith('.pdf')&&!/pdf/i.test(contentType);}
 catch {return false;}
}
export const clipBytes=(value, budget)=>new TextDecoder().decode(new TextEncoder().encode(value).slice(0,budget)).replace(/\uFFFD$/u,'');
const controls='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]';
export function safeText(node, limit=220) {
 if(!node||node.closest?.(controls))return '';
 // 中文注释：行文字只读可见文本节点；不能通过祖先 textContent 把文本域和编辑区的值带出去。
 const walk=node.ownerDocument.createTreeWalker(node,4);let current, text='', scanned=0;
 while((current=walk.nextNode())&&scanned++<500&&text.length<limit*2){
  const parent=current.parentElement;if(!parent||parent.closest(`${controls},script,style,[hidden],[aria-hidden="true"],[data-fast-automation-overlay]`))continue;
  const style=parent.ownerDocument.defaultView.getComputedStyle(parent);
  if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')continue;
  text+=' '+current.textContent;
 }
 return text.replace(/\s+/g,' ').trim().slice(0,limit);
}
export function describeEvent(event, doc) {
 if(['selectionchange','copy'].includes(event.type)){
  const selection=selectedText(doc);if(!selection)return null;
  return `${event.type==='copy'?'复制':'选中'} ${selection.text.slice(0,220)}`;
 }
 const target=event.target?.nodeType===1?event.target:event.target?.parentElement;
 if(!target||target.closest('[data-fast-automation-overlay]')||target.closest(controls))return null;
 const row=target.closest('tr,[role="row"]'), element=target.closest('a,button,[role="button"],[role="option"]')||target;
 const kind=row?'表格行':element.matches('a')?'链接':element.matches('button,[role="button"]')?'按钮':'内容';
 const label=safeText(row||element)||element.getAttribute('aria-label')?.slice(0,220)||element.localName;
 if(event.type==='click')return `点击 ${kind} ${label}`;
 if(event.type==='change'&&element.getAttribute('role')==='option')return `选中 ${label}`;
 return null;
}
export function pageSnapshot(doc, url, budget=3072) {
 if(!ordinaryPage(url,doc.contentType))return null;
 const engine=createPageSemantics({document:doc,taskId:'copilot-readonly',documentId:'current',leaseId:'no-execution',maxScan:2500,maxItems:60,maxText:180});
 try {
  const items=[];
  for(const mode of ['table','content','interactive']){
   const snapshot=engine.snapshot({mode,budget:1600});
   for(const row of snapshot.items){
    // 中文注释：只投影语义库已经排除输入值的名称和角色，不输出动作引用、状态或表单值。
    const node=engine.resolve({...snapshot.binding,snapshotId:snapshot.snapshotId,ref:row.ref});
    if(node.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]'))continue;
    const field=node.matches('input,textarea,select');
    const label=field?[...(node.labels||[])].map(label=>safeText(label)).join(' '):safeText(node);
    const item={role:row.role,name:label||node.getAttribute('aria-label')?.slice(0,180)||''};
    if(item.name)items.push(item);
   }
  }
  const page={url:safeURL(url),title:doc.title.slice(0,200),items:[],truncated:false};
  for(const item of items){page.items.push(item);if(new TextEncoder().encode(JSON.stringify(page)).length>budget-32){page.items.pop();page.truncated=true;break;}}
  return page;
 } finally {engine.revoke();}
}
export function safeURL(raw) {
 const url=new URL(raw);url.username='';url.password='';url.hash='';
 // 中文注释：搜索词来自已导航的 URL，绝不读取搜索框值；其他查询参数可能携带凭据，删除。
 const search=url.searchParams.get('q')||url.searchParams.get('query');url.search='';
 if(search&&/^(www\.)?(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/.test(url.hostname))url.searchParams.set('q',search.slice(0,200));
 return clipBytes(url.toString(),1200);
}
export function appendStep(trace, description, tabId, page, now=Date.now()) {
 return [...trace,{at:now,tabId,description:description.slice(0,300),url:page.url,title:page.title?.slice(0,200)||''}].slice(-30);
}


// 中文注释：所有导航和SPA变更共用静默窗口，5秒上限只约束同一批变化。
export function stableSnapshots(capture,{quiet=800,maxWait=5000,schedule=setTimeout,cancel=clearTimeout}={}){
 let silence=null,deadline=null,reason=null;
 const flush=()=>{cancel(silence);cancel(deadline);silence=deadline=null;const current=reason;reason=null;capture(current);};
 return {change(description){if(description)reason=description;if(deadline===null)deadline=schedule(flush,maxWait);cancel(silence);silence=schedule(flush,quiet);},
  stop(){cancel(silence);cancel(deadline);silence=deadline=null;}};
}

// 中文注释：表格数据留在本机采集/导出通路；推理仅收到列名与已识别行数。
export function tableSummary(capture){
 return (capture.tables||[]).slice(0,3).map(table=>({role:'table',name:clipBytes(`识别到表格：${table.headers.length} 列 · ${table.rows.length} 行${table.incomplete?' · 可能不完整':''}；列名 ${table.headers.join(' / ')}`,280)}));
}
