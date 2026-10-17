import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {captureTables,advanceTable} from '../../native-extension/copilot-tables.mjs';
import {TableJobs} from '../../native-extension/copilot-table-job.mjs';
import {renderResult,ordered} from '../../native-extension/copilot-result-view.mjs';
import {renderDashboard} from '../../native-extension/copilot-view.mjs';
import {NativeWorkspaces} from '../../native-extension/workspace-adapter.mjs';
const panel=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
function dom(html,url='https://example.test/?page=1'){
 const fixture=new JSDOM(html,{url});fixture.window.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{width:200,height:20}];};return fixture;
}
const common={verdict:'建议先测一个用途',level:'test',metrics:[{label:'候选','value':'8'}],missing:[{field:'vol,kd',reason:'example-seo-tool 未登录'}],process:['取自合成数据，不代表真实市场指标'],next:[]};
test('native, ARIA and repeated div tables keep headers, links and visible text only',()=>{
 const native='<h2>关键词</h2><table><tr><th>词</th><th>量</th></tr>'+[1,2,3].map(i=>`<tr><td><a href="/word/${i}">word ${i}</a><input value="PRIVATE"><span hidden>HIDDEN</span></td><td>${i}K</td></tr>`).join('')+'</table>';
 const aria='<div role="grid"><div role="row"><div role="columnheader">词</div><div role="columnheader">KD</div></div>'+[1,2,3].map(i=>`<div role="row"><div role="gridcell">aria ${i}</div><div role="gridcell">${i}</div></div>`).join('')+'</div>';
 const div='<div class="data-table"><div class="header-row"><span>项目</span><span>数值</span></div><div class="body">'+[1,2,3].map(i=>`<div class="row"><span>div ${i}</span><span>${i}</span></div>`).join('')+'</div></div>';
 const fixture=dom(native+aria+div);const captured=captureTables(fixture.window.document);assert.equal(captured.tables.length,3);assert.deepEqual(captured.tables[0].headers,['词','量']);assert.equal(captured.tables[0].rows[0][0].links[0],'https://example.test/word/1');assert.doesNotMatch(JSON.stringify(captured),/PRIVATE|HIDDEN/);fixture.window.close();
});
test('pagination identifies URL/next/virtual totals and stops at login or ambiguous controls',()=>{
 const table='<table><tr><th>词</th><th>量</th></tr>'+[1,2,3].map(i=>`<tr><td>word${i}</td><td>10</td></tr>`).join('')+'</table>';
 let fixture=dom('<div class="pagination">共 12 页 · 共 600 条</div>'+table+'<button>下一页</button>');let capture=captureTables(fixture.window.document).tables[0];assert.equal(capture.pagination.totalPages,12);assert.equal(capture.pagination.totalRows,600);assert.equal(capture.pagination.kind,'url');fixture.window.close();
 fixture=dom(table+'<button>下一页</button>','https://example.test/');assert.equal(captureTables(fixture.window.document).tables[0].pagination.kind,'button');let clicks=0;fixture.window.document.querySelector('button').onclick=()=>clicks++;advanceTable({kind:'button'},fixture.window.document);assert.equal(clicks,1);fixture.window.document.body.insertAdjacentHTML('beforeend','<input type=password>');assert.match(advanceTable({kind:'button'},fixture.window.document).blocked,/登录/);fixture.window.close();
 fixture=dom(table.replace('<table>','<table class=virtual-grid aria-rowcount=100>'),'https://example.test/');assert.equal(captureTables(fixture.window.document).tables[0].pagination.kind,'scroll');fixture.window.close();
});
test('typed collapsed/expanded cards, groups limit5, column omission, selection and safe links',async()=>{
 const fixture=dom(panel),doc=fixture.window.document,article=doc.createElement('article');doc.body.append(article);const calls=[];
 const row={id:'a',action:'seo.longtail',result:{...common,groups:[{name:'用途',intent:'工具',recommended:true,keywords:Array.from({length:8},(_,i)=>({keyword:'word '+i,source:'fixture'}))}]},row_states:{'word 0':{pool:true,tier:'测一页'}}};
 renderResult(doc,article,row,{command:async(...args)=>calls.push(args),clipboard:{writeText:async()=>{}}});
 assert.equal(article.querySelector('.result-details').open,false);assert.equal(article.querySelectorAll('tbody tr').length,5);assert.deepEqual([...article.querySelectorAll('th')].map(el=>el.textContent),['选','词']);assert.match(article.textContent,/example-seo-tool 未登录/);assert.match(article.textContent,/✓池/);assert.equal(article.querySelector('pre'),null);
 const all=article.querySelector('label input');all.checked=true;all.onchange();await [...article.querySelectorAll('button')].find(b=>b.textContent==='批量查词').onclick();assert.equal(calls[0][1].keywords.length,8);assert.equal(calls.length,1);
 [...article.querySelectorAll('button')].find(b=>b.textContent==='展开其余 3 个').onclick();assert.equal(article.querySelectorAll('tbody tr').length,8);
 const bad=doc.createElement('article');doc.body.append(bad);renderResult(doc,bad,{id:'g',action:'general.task',result:{...common,bullets:['要点'],links:[{label:'bad',url:'javascript:alert(1)'}],artifacts:[]}},{command:async()=>{}});assert.equal(bad.querySelector('a'),null);fixture.window.close();
});
test('each typed result renders with closed process, full sort/filter and result hierarchy',()=>{
 const fixture=dom(panel),doc=fixture.window.document;
 const cases=[['seo.keyword_check',{keyword:'sample',tier:'测一页',intent:'工具',serp:[{rank:1,domain:'small.test',page_type:'tool',small_site:true}],reasons:['理由']}],['seo.competitor_keywords',{domain:'site.test',top_pages:[],keywords:[{keyword:'big',vol:100,kd:30,opportunity:false},{keyword:'small',vol:20,kd:5,opportunity:true}]}],['seo.serp_breakdown',{query:'sample',results:[{rank:1,domain:'site.test',page_type:'tool',small_site:true}],gaps:['缺口']}],['seo.save_pool',{written:2,skipped:[{keyword:'old',reason:'已存在'}]}],['general.task',{bullets:['要点'],links:[{label:'来源',url:'https://example.test'}],artifacts:[]}]];
 for(const [action,body] of cases){const article=doc.createElement('article');doc.body.append(article);renderResult(doc,article,{id:action,action,result:{...common,...body}},{command:async()=>{}});assert.equal(article.querySelector('.result-process').open,false);article.querySelector('.result-details').open=true;assert.ok(article.textContent.includes(common.verdict));}
 assert.deepEqual(ordered([{keyword:'a',vol:30},{keyword:'b',vol:5},{keyword:'c'}],'vol',1,'').map(r=>r.keyword),['b','a','c']);assert.equal(ordered([{keyword:'abc'},{keyword:'xyz'}],'keyword',1,'ab').length,1);
 renderDashboard(doc,{enabled:true,ready:true,suggestions:[{id:'child',parent_id:'parent',action:'general.task',title:'子结果',params:{task:'child'},status:'completed',finished_at:2,result:{...common,bullets:[],links:[],artifacts:[]}},{id:'parent',action:'seo.longtail',title:'父结果',params:{keyword:'parent'},status:'completed',finished_at:1,result:{...common,groups:[]}},{id:'failed',action:'general.task',title:'失败',params:{},status:'failed'}]},{command:async()=>{}});
 assert.ok(doc.querySelector('article[data-id=parent] article[data-id=child]'));doc.getElementById('result-filter').value='general.task';
 renderDashboard(doc,{enabled:true,ready:true,suggestions:[{id:'parent',action:'seo.longtail',title:'父结果',params:{keyword:'parent'},status:'completed',result:{...common,groups:[]}},{id:'child',parent_id:'parent',action:'general.task',title:'子结果',params:{task:'child'},status:'completed',result:{...common,bullets:[],links:[],artifacts:[]}},{id:'failed',action:'general.task',title:'失败',params:{},status:'failed'}]},{command:async()=>{}});
 assert.equal(doc.querySelector('article[data-id=parent]').hidden,false);assert.equal(doc.querySelector('article[data-id=child]').hidden,false);assert.ok(doc.querySelector('article[data-id=failed]').classList.contains('failed'));fixture.window.close();
});
function table(page,kind='url'){return {id:'0',name:'fixture',headers:['词','量'],rows:[[ {text:'shared'}, {text:'1'} ],[{text:'word'+page},{text:String(page)}],[{text:'extra'+page},{text:'20'}]],pagination:{kind,key:'page',current:page,totalPages:3,totalRows:null,next:page<3,offsetStep:1},incomplete:true};}
test('background URL/button/scroll collection deduplicates, jitters, caps and saves partial on stop/block',async()=>{
 for(const kind of ['url','button','scroll']){
  let page=1,closed=0;const waits=[],updates=[],source={url:'https://example.test/?page=1',tables:[table(1,kind)]};
  const jobs=new TableJobs({open:async()=>({owned:true}),read:async()=>({url:'https://example.test/?page='+page,tables:[table(page,kind)]}),navigate:async(_,url)=>{page=Number(new URL(url).searchParams.get('page'));},advance:async()=>page>=3?{done:true}:(page++,{advanced:true}),close:async()=>closed++,upload:async data=>data,progress:row=>updates.push(row),delay:async ms=>waits.push(ms),random:()=>.5});
  const result=await jobs.run('job',source,source.tables[0],{max_pages:50,delay_min:1.5,delay_max:3});assert.equal(result.rows.length,7);assert.equal(closed,1);assert.ok(waits.every(ms=>ms===2250));assert.equal(result.partial,false);assert.equal(updates.at(-1).status,'completed');
 }
 let jobs;const source={url:'https://example.test/?page=1',tables:[table(1)]};jobs=new TableJobs({open:async()=>({}),read:async()=>{jobs.stop('stop');return source;},navigate:async()=>{},advance:async()=>({}),close:async()=>{},upload:async d=>d,progress:()=>{},delay:async()=>{}});const partial=await jobs.run('stop',source,source.tables[0]);assert.match(partial.reason,/已停止/);assert.equal(partial.rows.length,3);
 source.tables[0].pagination.totalPages=60;await assert.rejects(()=>jobs.run('cap',source,source.tables[0],{max_pages:50}),/再次确认/);
});
test('silent task input skips activation queue',async()=>{
 const workspace=new NativeWorkspaces({runtime:{},storage:{local:{get:async()=>({}),set:async()=>{}}},tabs:{query:async()=>[]}},'fixture');await workspace.ready;workspace.workWindow.input=()=>{throw Error('must not activate');};
 assert.equal(await workspace.withInput({silent:true},{action:'click'},()=>{},async()=>42),42);
});

test('background collector uses real local DOM pagination and leaves the user document untouched',async()=>{
 const markup=page=>'<h2>本地分页样例</h2><table><tr><th>词</th><th>量</th></tr>'+[0,1,2].map(i=>`<tr><td>word ${page*3+i}</td><td>10</td></tr>`).join('')+`</table><button ${page>=3?'disabled':''}>下一页</button>`;
 const user=dom(markup(1),'https://fixture.test/'),work=dom(markup(1),'https://fixture.test/');let page=1;const original=user.serialize();
 const bind=()=>{work.window.document.querySelector('button').onclick=()=>{page++;work.window.document.body.innerHTML=markup(page);bind();};};bind();
 const captured=captureTables(user.window.document),jobs=new TableJobs({open:async()=>({}),read:async()=>captureTables(work.window.document),advance:async(_,step)=>advanceTable(step,work.window.document),close:async()=>{},navigate:async()=>{throw Error('not URL pagination');},upload:async value=>value,progress:()=>{},delay:async()=>{}});
 const result=await jobs.run('local',captured,captured.tables[0]);assert.equal(result.rows.length,9);assert.equal(result.pages,3);assert.equal(result.partial,false);assert.equal(user.serialize(),original);user.window.close();work.window.close();
});
test('blocker, schema drift and page cap save collected rows with an explicit reason',async()=>{
 const source={url:'https://fixture.test/?page=1',tables:[table(1)]};
 for(const failure of ['login','structure','cap']){
  let page=1;const initial={...source.tables[0],pagination:{...source.tables[0].pagination,totalPages:null}};
  const jobs=new TableJobs({open:async()=>({}),read:async()=>failure==='login'?{url:source.url,tables:[],blocked:'遇到验证码'}:failure==='structure'?{url:source.url,tables:[{...table(1),headers:['不同','字段']}]}:{url:'https://fixture.test/?page='+page,tables:[{...table(page),pagination:{...table(page).pagination,totalPages:null,next:true}}]},navigate:async()=>page++,advance:async()=>({advanced:true}),close:async()=>{},upload:async value=>value,progress:()=>{},delay:async()=>{}});
  const result=await jobs.run('job',source,initial,{max_pages:2,delay_min:1.5,delay_max:3});assert.equal(result.partial,true);assert.ok(result.rows.length>=3);assert.match(result.reason,failure==='login'?/验证码/:failure==='structure'?/结构/:/上限/);
 }
});
test('silent executor refuses focus RPC and rejects a moved or user-focused work tab',async()=>{
 const {Executor}=await import('../../native-extension/core.mjs');
 const task={id:'task',silent:true,agentTabs:new Set([2]),agentTabGroups:new Map([[2,9]]),workspaceCapability:{}};
 const calls=[],instance={tasks:new Map([['task',task]]),leases:new Map([[2,'task']]),check:()=>{},api:{tabs:{get:async()=>({id:2,windowId:4,groupId:9,active:false}),update:async(...args)=>calls.push(args)},windows:{get:async()=>({focused:false})}},workspaces:{authority:{resolve:()=>({windowId:4})}}};
 await assert.rejects(()=>Executor.prototype.gateway.call(instance,'browser.cdp_activate',{taskId:'task'}),/SILENT_TASK_FOCUS_DENIED/);assert.equal(calls.length,0);
 await Executor.prototype.assertSilentTarget.call(instance,task,2);
 instance.api.tabs.get=async()=>({id:2,windowId:99,groupId:9});await assert.rejects(()=>Executor.prototype.assertSilentTarget.call(instance,task,2),/归属/);
 instance.api.tabs.get=async()=>({id:2,windowId:4,groupId:9,active:true});instance.api.windows.get=async()=>({focused:true});await assert.rejects(()=>Executor.prototype.assertSilentTarget.call(instance,task,2),/查看/);
});

test('virtual rows are recycled in a local DOM and inference gets only table summaries',async()=>{
 const {tableSummary}=await import('../../native-extension/copilot-observation.mjs');
 const fixture=dom('<div id="grid" class="virtual-grid" role="grid" aria-rowcount="9"></div>','https://fixture.test/'),doc=fixture.window.document,root=doc.getElementById('grid');let top=0;
 const draw=()=>{const page=Math.min(2,Math.ceil(top/80));root.innerHTML='<div role="row"><div role="columnheader">词</div><div role="columnheader">量</div></div>'+Array.from({length:3},(_,i)=>`<div role="row"><div role="gridcell">private-cell-${page*3+i}</div><div role="gridcell">${i}</div></div>`).join('');};
 Object.defineProperties(root,{scrollHeight:{get:()=>280},clientHeight:{get:()=>100},scrollTop:{get:()=>top,set:value=>{top=value;}}});root.addEventListener('scroll',draw);draw();
 const captured=captureTables(doc);assert.doesNotMatch(JSON.stringify(tableSummary(captured)),/private-cell/);assert.match(JSON.stringify(tableSummary(captured)),/3 行/);
 const jobs=new TableJobs({open:async()=>({}),read:async()=>captureTables(doc),advance:async(_,step)=>advanceTable(step,doc),navigate:async()=>{},close:async()=>{},upload:async value=>value,progress:()=>{},delay:async()=>{}});
 const result=await jobs.run('virtual',captured,captured.tables[0]);assert.equal(result.rows.length,9);assert.equal(result.unit,'批');assert.equal(result.partial,false);fixture.window.close();
});
test('blank checkbox header is retained and controls never become exported values',()=>{
 const fixture=dom('<table><tr><th></th><th>关键词</th><th>量</th></tr>'+[1,2,3].map(i=>`<tr><td><input type="checkbox" value="PRIVATE_${i}"></td><td>word${i}</td><td>10</td></tr>`).join('')+'</table>');
 const table=captureTables(fixture.window.document).tables[0];assert.deepEqual(table.headers,['','关键词','量']);assert.equal(table.rows.length,3);assert.doesNotMatch(JSON.stringify(table),/PRIVATE/);fixture.window.close();
});

test('metadata-named and structurally repeated div tables do not require table-like root classes',()=>{
 const fixture=dom('<div class="random"><div class="header-row"><span>词</span><span>量</span></div>'+[1,2,3].map(i=>`<div class="entry"><span>structural ${i}</span><span>10</span></div>`).join('')+'</div><div data-ui-name="DataTable" class="hashed"><div data-ui-name="Head.Row"><div>关键词</div><div>KD</div></div>'+[1,2,3].map(i=>`<div data-ui-name="Body.Row"><div>meta ${i}</div><div>20</div></div>`).join('')+'</div>');
 const capture=captureTables(fixture.window.document);assert.equal(capture.tables.length,2);assert.equal(capture.tables[0].rows.length,3);assert.equal(capture.tables[1].rows.length,3);fixture.window.close();
});

test('editable cells keep column shape but never expose input text or edited links',()=>{
 const fixture=dom('<table><tr><th>词</th><th>量</th></tr>'+[1,2,3].map(i=>`<tr><td><span contenteditable=false>公开${i}</span><div contenteditable=true>PRIVATE_TEXT<a href="https://private.test/PRIVATE_LINK">PRIVATE_LINK</a></div></td><td><input value="PRIVATE_VALUE">10</td></tr>`).join('')+'</table>');
 const table=captureTables(fixture.window.document).tables[0];assert.equal(table.rows.length,3);assert.match(table.rows[0][0].text,/公开1/);assert.doesNotMatch(JSON.stringify(table),/PRIVATE/);fixture.window.close();
});

test('production pagination adapter dispatches a bound Executor click instead of raw DOM click',async()=>{
 const {taskTableAdapter}=await import('../../native-extension/copilot-table-job.mjs');
 const fixture=dom('<button>下一页</button>','https://fixture.test/');let clicked=0;fixture.window.document.querySelector('button').onclick=()=>clicked++;
 const task={id:'task',generation:1,silent:true,agentTabs:new Set([2]),agentTabGroups:new Map([[2,9]])},calls=[];
 const api={tabs:{get:async()=>({id:2,url:'https://fixture.test/',windowId:4,groupId:9,active:false})},windows:{get:async()=>({focused:false})},scripting:{executeScript:async({func,args})=>[{result:func(args[0],fixture.window.document)}]}};
 const executor={tasks:new Map([['task',task]]),leases:new Map([[2,'task']]),perform:async(_task,p)=>{calls.push(p);if(p.action==='semantic_snapshot'){assert.equal(clicked,0);return {binding:{taskId:'task'},snapshotId:'snapshot',items:[{ref:'next',name:'下一页',role:'button'}]};}assert.equal(p.action,'ref_click');assert.equal(p.ref,'next');clicked++;return {effect:'observed'};}};
 const adapter=taskTableAdapter(api,executor,()=>null,{});const result=await adapter.advance({taskId:'task',tabId:2,windowId:4,groupId:9,origin:'https://fixture.test'},{kind:'button',headers:[]});assert.equal(result.advanced,true);assert.equal(clicked,1);assert.deepEqual(calls.map(c=>c.action),['semantic_snapshot','ref_click']);fixture.window.close();
});
