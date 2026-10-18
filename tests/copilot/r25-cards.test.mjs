import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {renderDashboard,rankedSuggestions,stepName} from '../../native-extension/copilot-view.mjs';
const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
const suggestion=(id,keyword,status='pending',extra={})=>({id,title:`检查 ${keyword}`,why:'核对当前对象的公开指标和可用工作流',action:'seo.keyword_check',params:{keyword},status,...extra});
const fixture=()=>new JSDOM(html,{url:'https://example.test/'});
const state={enabled:true,ready:true,locale:'zh'};
test('suggestions show at most ten rows and rank current object similarity before availability and stable priority',()=>{
 const rows=[suggestion('other','unrelated'),suggestion('partial','job scheduler api'),suggestion('exact','job scheduler'),suggestion('blocked','job scheduler','pending',{missing_capabilities:['metrics']})];
 assert.deepEqual(rankedSuggestions(rows,{tool_context:{current:{object:'job scheduler'}}}).map(row=>row.id),['exact','blocked','partial','other']);
 assert.deepEqual(rankedSuggestions(rows,{tool_context:{selection:'unrelated',current:{object:'job scheduler'}}}).map(row=>row.id),['other','partial','exact','blocked']);
 const dom=fixture();try{const doc=dom.window.document;renderDashboard(doc,{...state,tool_context:{current:{object:'job scheduler'}},suggestions:[...Array.from({length:15},(_,i)=>suggestion('x'+i,'topic '+i)),...rows]},{command:async()=>{}});assert.equal(doc.querySelectorAll('#pending article:not([hidden]):not(.leaving)').length,10);assert.equal(doc.getElementById('suggestions-count').textContent,'10');assert.equal(doc.querySelector('#pending article').dataset.id,'exact');assert.equal(doc.querySelectorAll('#pending .primary').length,1);}finally{dom.window.close();}
});
test('recommendation cards keep bounded copy and right-side actions without embedding result details',async()=>{
 const dom=fixture(),calls=[];try{const doc=dom.window.document;const row=suggestion('cached','sample','completed',{automatic:true,result:{verdict:'已读取本机证据',metrics:[{label:'记录',value:'53'}],missing:[],process:['PRIVATE_PROCESS'],keywords:[{keyword:'sample'}]}});renderDashboard(doc,{...state,suggestions:[row]},{command:async(...args)=>calls.push(args)});const card=doc.querySelector('#pending article');assert.equal(card.dataset.group,'pending');assert.equal(card.querySelector('details'),null);assert.equal(card.querySelector('table'),null);assert.doesNotMatch(card.textContent,/展开结果|过程与来源|PRIVATE_PROCESS/);assert.ok(card.querySelector('.verdict.compact-copy'));await card.querySelector('[data-action=open_result]').onclick();await card.querySelector('[data-action=task_logs]').onclick();assert.deepEqual(calls,[['open_result',{id:'cached',popup:true}],['task_logs',{id:'cached'}]]);const css=await readFile(new URL('../../native-extension/copilot-panel.css',import.meta.url),'utf8');assert.match(css,/\.task>\.actions\{grid-column:2/);assert.match(css,/-webkit-line-clamp:2/);}finally{dom.window.close();}
});
test('running cards refresh elapsed seconds and current descriptive steps, and expose task-specific logs',async()=>{
 const dom=fixture(),calls=[];try{const doc=dom.window.document,row=suggestion('running','sample','executing',{started_at:90,step:'2/5 · 读取报表 · 第 3 页',workflow_total:5,workflow_completed:1}),context={command:async(...args)=>calls.push(args)};renderDashboard(doc,{...state,suggestions:[row]},context,100000);const card=doc.querySelector('#running article'),stop=card.querySelector('[data-action=stop]');assert.match(card.querySelector('.elapsed').textContent,/0:10/);assert.match(card.querySelector('.step').textContent,/第 3 页/);renderDashboard(doc,{...state,suggestions:[row]},context,101000);assert.equal(card.querySelector('[data-action=stop]'),stop);assert.match(card.querySelector('.elapsed').textContent,/0:11/);row.step='2/5 · 读取报表 · 第 4 页';renderDashboard(doc,{...state,suggestions:[row]},context,102000);assert.match(card.querySelector('.step').textContent,/第 4 页/);await card.querySelector('[data-action=task_logs]').onclick();assert.deepEqual(calls,[['task_logs',{id:'running'}]]);assert.equal(stepName('browser_snapshot'),'正在读取任务工作页…');}finally{dom.window.close();}
});
test('result cards keep short verdict and metrics and route details, logs and safe continuation separately',async()=>{
 const dom=fixture(),calls=[];try{const doc=dom.window.document,row=suggestion('failed','sample','failed',{reason:'需要登录后继续',resume_from:2,rerun_warning:'从头重跑，可能重复第 1 步',result:{verdict:'已保留数据',metrics:[{label:'记录',value:'53'}],missing:[{field:'judgment',reason:'登录'}],process:['INTERNAL_PROCESS']}});renderDashboard(doc,{...state,suggestions:[row]},{command:async(...args)=>calls.push(args)});const card=doc.querySelector('#results article');assert.equal(card.querySelector('details'),null);assert.doesNotMatch(card.textContent,/展开结果|过程与来源|INTERNAL_PROCESS/);assert.match(card.textContent,/从第 2 步继续|从头重跑/);for(const action of ['open_result','task_logs','retry'])await card.querySelector(`[data-action=${action}]`).onclick();assert.deepEqual(calls,[['open_result',{id:'failed',popup:true}],['task_logs',{id:'failed'}],['retry',{id:'failed'}]]);assert.ok(doc.getElementById('all-task-logs'));assert.ok(doc.getElementById('execution-logs'));}finally{dom.window.close();}
});

test('step updates preserve live action nodes and in-flight locks without detaching or reordering buttons',async()=>{
 const dom=fixture(),calls=[];let finish;
 const pending=new Promise(resolve=>{finish=resolve;}),command=async(name,params)=>{calls.push([name,params]);if(name==='stop')return pending;};
 try{
  const doc=dom.window.document,row=suggestion('stable-task','sample','executing',{started_at:90,step:'第 1 页'});
  renderDashboard(doc,{...state,suggestions:[row]},{command},100000);
  const card=doc.querySelector('#running article'),actions=card.querySelector(':scope > .actions'),stop=actions.querySelector('[data-action=stop]'),logs=actions.querySelector('[data-action=task_logs]');
  const mutations=[],observer=new dom.window.MutationObserver(records=>mutations.push(...records));observer.observe(actions,{childList:true,subtree:true});
  const stopping=stop.onclick();assert.equal(stop.disabled,true);assert.equal(stop.getAttribute('aria-busy'),'true');
  const next={...row,title:'更新标题',step:'第 2 页',workflow_total:5,workflow_completed:2};
  renderDashboard(doc,{...state,suggestions:[next]},{command},101000);
  assert.equal(card.querySelector(':scope > .actions'),actions);assert.equal(actions.querySelector('[data-action=stop]'),stop);assert.equal(actions.querySelector('[data-action=task_logs]'),logs);
  assert.equal(stop.isConnected,true);assert.equal(stop.disabled,true);assert.equal(stop.getAttribute('aria-busy'),'true');assert.match(card.querySelector('.step').textContent,/第 2 页/);
  await stop.onclick();assert.equal(calls.filter(([name])=>name==='stop').length,1);
  await logs.onclick();assert.deepEqual(calls.at(-1),['task_logs',{id:'stable-task'}]);
  await Promise.resolve();assert.equal(mutations.length,0);observer.disconnect();
  renderDashboard(doc,{...state,suggestions:[{...next,status:'stopping'}]},{command},102000);
  assert.equal(actions.querySelector('[data-action=stop]'),stop);assert.equal(stop.disabled,true);
  finish();await stopping;assert.equal(stop.hasAttribute('aria-busy'),false);assert.equal(stop.disabled,true,'host stopping status must keep the button disabled after its request settles');
  renderDashboard(doc,{...state,suggestions:[{...next,status:'completed',result:{verdict:'已保存',metrics:[],missing:[]}}]},{command},103000);
  assert.equal(card.querySelector('[data-action=stop]'),null);assert.equal(stop.isConnected,false);assert.equal(card.querySelector('[data-action=task_logs]'),logs);assert.ok(card.querySelector('[data-action=open_result]'));
  await stop.onclick();assert.equal(calls.filter(([name])=>name==='stop').length,1,'a removed action cannot be replayed through a stale reference');
 }finally{finish();dom.window.close();}
});

test('refreshed actions route each current task and restore enabled state after a settled request',async()=>{
 const dom=fixture(),calls=[];let finish;
 const pending=new Promise(resolve=>{finish=resolve;}),command=async(name,params)=>{calls.push([name,params]);if(name==='stop')return pending;};
 try{
  const doc=dom.window.document,first=suggestion('task-one','one','executing',{step:'读取第 1 页'}),second=suggestion('task-two','two','executing',{step:'读取第 1 页'});
  renderDashboard(doc,{...state,suggestions:[first,second]},{command});
  const stop=doc.querySelector('article[data-id=task-one] [data-action=stop]'),logs=doc.querySelector('article[data-id=task-two] [data-action=task_logs]'),request=stop.onclick();
  renderDashboard(doc,{...state,suggestions:[{...first,step:'读取第 2 页'},{...second,step:'读取第 3 页'}]},{command});
  assert.equal(doc.querySelector('article[data-id=task-two] [data-action=task_logs]'),logs);await logs.onclick();assert.deepEqual(calls.at(-1),['task_logs',{id:'task-two'}]);
  finish();await request;assert.equal(stop.disabled,false);assert.equal(stop.hasAttribute('aria-busy'),false);assert.deepEqual(calls[0],['stop',{id:'task-one'}]);
 }finally{finish();dom.window.close();}
});
