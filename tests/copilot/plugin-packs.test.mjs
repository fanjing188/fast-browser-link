import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {PacksPanel} from '../../native-extension/copilot-packs-panel.mjs';
import {readTrends,collectBrowserData} from '../../native-extension/copilot-browser-data.mjs';
const html='<details id="functional-plugins"><output id="plugins-notice"></output><div class="plugins-body"></div></details>';
const state={busy:false,plugins:[{id:'adapter',name:'适配包',release:'1.0.0',schema_version:1,path:'/synthetic/adapter',source:'managed',loaded:true,can_remove:true,capabilities:['case.inspect'],workflows:['review'],needs_setup:[]},{id:'custom',name:'个人包',schema_version:1,path:'/synthetic/custom',source:'local',loaded:true,modified:true,can_remove:false,capabilities:[],workflows:[],needs_setup:[]}],available:[]};
test('plugin list shows metadata, confirms uninstall and preserves unmanaged packages',async()=>{
 const dom=new JSDOM(html),calls=[];try{const panel=new PacksPanel(dom.window.document,async(...args)=>{calls.push(args);return state;});await panel.refresh();const root=dom.window.document.querySelector('[data-pack=adapter]');assert.match(root.textContent,/1.0.0|case.inspect|review/);assert.equal(dom.window.document.querySelector('[data-pack=custom] button'),null);
 root.querySelector('button').click();assert.deepEqual(calls,[['fbl_pack_state']]);await root.querySelector('button').onclick();assert.deepEqual(calls.at(-1),['fbl_pack_remove',{name:'adapter'}]);
 const input=dom.window.document.querySelector('input');input.value='/synthetic/new';await [...dom.window.document.querySelectorAll('button')].find(button=>button.textContent==='安装本地插件').onclick();assert.deepEqual(calls.at(-1),['fbl_pack_install',{name:'/synthetic/new'}]);
 panel.state={...state,busy:true};panel.render();assert.equal(dom.window.document.querySelector('[data-pack=adapter] button').disabled,true);
 }finally{dom.window.close();}
});
function page(html,url='https://trends.google.com/trends/explore?q=sample'){return new JSDOM(html,{url});}
test('real Trends accessible x/y labels and Chinese dates map only to the current query',()=>{
 const dom=page('<iframe title="reCAPTCHA" style="visibility:hidden"></iframe><div aria-label="A tabular representation of the data in the chart." style="position:absolute;left:-10000px"><table><tr><th>x</th><th>y1</th></tr><tr><td>\u202a2026年10月18日\u202c</td><td>21</td></tr></table></div>');
 try{assert.deepEqual(readTrends(['sample'],'US','12m',dom.window.document).series[0].points,[{date:'2026-10-18',value:21}]);assert.deepEqual(readTrends(['other'],'US','12m',dom.window.document).series,[]);dom.window.document.querySelector('iframe').style.visibility='visible';assert.equal(readTrends(['sample'],'US','12m',dom.window.document).error,'blocked');}finally{dom.window.close();}
});
test('rising reader excludes topics, hidden rows, Top reports and credentials',()=>{
 const dom=page('<widget>相关主题 搜索量上升<a href="/trends/explore?q=/m/topic">1 Topic +50%</a></widget><widget>相关查询 搜索量上升<a href="/trends/explore?q=sample+tool">1 sample tool +60%</a><a hidden href="/trends/explore?q=private">2 private +90%</a></widget><widget>Related queries Top<a href="/trends/explore?q=top">top +100%</a></widget><input type="password" hidden value="SECRET">');
 try{const result=readTrends({keywords:['sample'],report:'rising'},'US','12m',dom.window.document);assert.deepEqual(result.records.map(row=>row.keyword),['sample tool']);assert.doesNotMatch(JSON.stringify(result),/SECRET|private|topic/);}finally{dom.window.close();}
});
test('rising capability uses one owned report and closes it',async()=>{
 const opened=[],closed=[],contexts=[];const adapter={open:async(url,context)=>{opened.push(url);contexts.push(context);return {id:1};},readData:async(work,fn,args)=>({records:[{keyword:'sample tool'}],source:'synthetic rising'}),close:async work=>closed.push(work.id)};
 const result=await collectBrowserData(adapter,{id:'capability-resource',kind:'google_trends_rising',params:{keyword:'sample'}},async()=>true);assert.equal(result.records.length,1);assert.equal(opened.length,1);assert.deepEqual(contexts,[{incognito:false,resourceId:'capability-resource'}]);assert.deepEqual(closed,[1]);assert.equal(new URL(opened[0]).searchParams.get('geo'),'US');
});

test('background reports carry the executor authorization generation and stop after revocation',async()=>{
 const {taskTableAdapter}=await import('../../native-extension/copilot-table-job.mjs');
 const {Executor}=await import('../../native-extension/core.mjs');
 const task={id:'fixture',generation:1,silent:true,policy:{modeGeneration:2},agentTabs:new Set([7])},calls=[];
 const api={tabs:{get:async()=>({id:7,windowId:8,groupId:9,url:'https://report.example.test/report',active:false,status:'complete'})},windows:{get:async()=>({focused:false})}};
 const executor={tasks:new Map([['fixture',task]]),leases:new Map([[7,'fixture']]),perform:async(t,p)=>{await Executor.prototype.authorize.call(executor,t,p,()=>{});calls.push(p);return {tabId:7};}};
 const bridge={request:async(method)=>method==='extension.copilot.work_create'?{id:'fixture'}:{accepted:true}};
 const adapter=taskTableAdapter(api,executor,()=>bridge,{synchronize:async()=>{}});
 const workspace=await adapter.open('https://report.example.test/report');assert.equal(workspace.modeGeneration,2);assert.equal(calls[0].modeGeneration,2);
 await adapter.navigate(workspace,'https://report.example.test/report?next=1');assert.equal(calls[1].modeGeneration,2);
 task.policy.modeGeneration=3;await assert.rejects(()=>adapter.navigate(workspace,'https://report.example.test/report?next=2'),/授权已变化/);assert.equal(calls.length,2);
});

test('background data waits for a report that loads after the former eight second limit',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {taskTableAdapter}=await import('../../native-extension/copilot-table-job.mjs');let reads=0,parsed=0,done=false;
 const task={id:'slow',generation:1,silent:true,policy:{modeGeneration:2},agentTabs:new Set([7])};
 const api={tabs:{get:async()=>({id:7,windowId:8,groupId:9,url:'https://report.example.test/',active:false,status:++reads>24?'complete':'loading'})},windows:{get:async()=>({focused:false})},scripting:{executeScript:async()=>{parsed++;return [{result:{records:[{keyword:'measured'}]}}];}}};
 const adapter=taskTableAdapter(api,{tasks:new Map([['slow',task]]),leases:new Map([[7,'slow']])},()=>({request:async()=>({})}),{});
 const pending=adapter.readData({taskId:'slow',tabId:7,windowId:8,groupId:9,origin:'https://report.example.test',modeGeneration:2},()=>{}).then(value=>{done=true;return value;});
 for(let step=0;step<20&&!done;step++){await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(800);}
 assert.equal((await pending).records[0].keyword,'measured');assert.ok(reads>24);assert.equal(parsed,1);
});

test('chart rendering is scoped to its owned tab, restored after errors and denied on user focus',async()=>{
 const {taskTableAdapter}=await import('../../native-extension/copilot-table-job.mjs');let focused=false,fail=false;const calls=[];
 const task={id:'chart',generation:1,silent:true,policy:{modeGeneration:2},agentTabs:new Set([7])};
 const api={tabs:{get:async()=>({id:7,windowId:8,groupId:9,url:'https://report.example.test/',active:focused,status:'complete'})},windows:{get:async()=>({focused})},scripting:{executeScript:async()=>{if(fail)throw Error('parser failed');return [{result:{series:[{keyword:'sample'}]}}];}}};
 const adapter=taskTableAdapter(api,{tasks:new Map([['chart',task]]),leases:new Map([[7,'chart']]),perform:async(_task,params)=>calls.push(params)},()=>({request:async()=>({})}),{});
 const workspace={taskId:'chart',tabId:7,windowId:8,groupId:9,origin:'https://report.example.test',modeGeneration:2};
 await adapter.readData(workspace,()=>{},[],{render:true});fail=true;await assert.rejects(()=>adapter.readData(workspace,()=>{},[],{render:true}),/parser failed/);
 assert.deepEqual(calls.map(call=>call.params.enabled),[true,false,true,false]);assert.ok(calls.every(call=>call.method==='Emulation.setFocusEmulationEnabled'&&call.tabId===7&&call.modeGeneration===2));
 focused=true;await assert.rejects(()=>adapter.readData(workspace,()=>{},[],{render:true}),/用户正在查看/);assert.equal(calls.length,4);
});

test('report query clicks one scoped button and never repeats an unknown outcome',async()=>{
 const {taskTableAdapter}=await import('../../native-extension/copilot-table-job.mjs');const calls=[];
 const task={id:'query',generation:1,silent:true,policy:{modeGeneration:2},agentTabs:new Set([7])};
 const api={tabs:{get:async()=>({id:7,windowId:8,groupId:9,url:'https://report.example.test/',active:false})},windows:{get:async()=>({focused:false})}};
 const executor={tasks:new Map([['query',task]]),leases:new Map([[7,'query']]),perform:async(_task,params)=>{calls.push(params);return params.action==='semantic_snapshot'?{items:[{name:'分析',ref:'query-button'}],binding:{},snapshotId:'query-snapshot'}:{outcomeUnknown:true};}};
 const adapter=taskTableAdapter(api,executor,()=>({request:async()=>({})}),{});
 await assert.rejects(()=>adapter.submitQuery({taskId:'query',tabId:7,windowId:8,groupId:9,origin:'https://report.example.test',modeGeneration:2},{root:'#report',names:['分析','Analyze']}),/待核实/);
 assert.equal(calls.length,2);assert.deepEqual(calls[0].options.roles,['button']);assert.equal(calls[0].options.root,'#report');assert.equal(calls[1].ref,'query-button');assert.equal(calls[1].modeGeneration,2);
});

test('a complete report with no pagination is not marked partial at a one page budget',async()=>{
 const {TableJobs}=await import('../../native-extension/copilot-table-job.mjs');
 const table={name:'report',headers:['Keyword'],rows:[[{text:'sample'}]],pagination:{kind:'none'}};
 const snapshot={url:'https://report.example.test/',tables:[table]};
 const jobs=new TableJobs({open:async()=>({}),read:async()=>snapshot,close:async()=>{},upload:async value=>({...value,files:[{id:'fixture-file',path:'/synthetic/table.xlsx'}]}),progress:()=>{}});
 const result=await jobs.run('complete',snapshot,table,{max_pages:1});assert.equal(result.partial,false);assert.equal(result.reason,'');assert.equal(result.pages,1);
});
