import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {captureTables} from '../../native-extension/copilot-tables.mjs';
import {inspectToolPage,collectToolReport} from '../../native-extension/copilot-tool-reports.mjs';
import {CapabilitiesPanel} from '../../native-extension/copilot-capabilities-panel.mjs';
import {selectionTasks} from '../../native-extension/copilot-selection.mjs';
import {renderDashboard} from '../../native-extension/copilot-view.mjs';
import {renderResult} from '../../native-extension/copilot-result-view.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
const fixture=page=>{const dom=new JSDOM('<h1>Report</h1><table><tr><th>Keyword</th><th>Volume</th></tr>'+[1,2,3].map(n=>`<tr><td>word ${(page-1)*3+n}</td><td>${n}K</td></tr>`).join('')+'</table><p class="pagination">Page '+page+' of 2</p>',{url:'https://seo.example.test/report?page='+page});dom.window.HTMLElement.prototype.getClientRects=function(){return [{left:1,top:1,right:201,bottom:31,width:200,height:30}];};return dom;};
test('health inspects visible state markers without reading credential values',()=>{
 const dom=new JSDOM('<h1>Report</h1><div role="alert" hidden>captcha</div><input type="password" value="CREDENTIAL_PRIVATE" hidden><table></table>');try{let value=inspectToolPage({ready_selectors:['table']},dom.window.document);assert.equal(value.ready,true);assert.doesNotMatch(JSON.stringify(value),/CREDENTIAL|captcha/);dom.window.document.querySelector('input').hidden=false;assert.equal(inspectToolPage({},dom.window.document).blocked,'login');dom.window.document.querySelector('input').hidden=true;const alert=dom.window.document.querySelector('[role=alert]');alert.hidden=false;assert.equal(inspectToolPage({},dom.window.document).blocked,'captcha');alert.textContent='Daily limit exceeded';assert.equal(inspectToolPage({},dom.window.document).blocked,'quota');}finally{dom.window.close();}
});
test('report collection reuses the table paginator in one owned work page, preserving resource lease',async()=>{
 let dom=fixture(1);const opens=[],closes=[],pages=[];const adapter={delay:async()=>{},open:async(url,context)=>{opens.push([url,context]);return {id:1};},readData:async(work,func,args)=>func(...args,dom.window.document),read:async()=>captureTables(dom.window.document),navigate:async(work,url)=>{pages.push(url);dom.window.close();dom=fixture(2);},advance:async()=>({done:true}),close:async work=>closes.push(work.id)};
 try{const result=await collectToolReport(adapter,{id:'resource-nonce',kind:'capability',params:{binding:{id:'fixture',max_pages:2},tool:{},page:{columns:{keyword:['Keyword'],vol:['Volume']}},input:{keyword:'sample'},url:'https://seo.example.test/report?page=1'}},async()=>true);assert.equal(opens.length,1);assert.equal(opens[0][1].resourceId,'resource-nonce');assert.equal(closes.length,1);assert.equal(result.table.rows.length,6);assert.equal(result.pages,2);assert.equal(pages.length,1);}finally{dom.window.close();}
});
test('blocked source stops report reads before table or pagination actions',async()=>{
 const events=[];const adapter={open:async()=>({id:1}),readData:async()=>({blocked:'quota'}),read:async()=>{events.push('read');},close:async()=>events.push('closed')};const result=await collectToolReport(adapter,{id:'x',kind:'capability',params:{binding:{id:'fixture'},tool:{},page:{},input:{},url:'https://seo.example.test/'}},()=>true);assert.equal(result.blocked,'quota');assert.deepEqual(events,['closed']);
});
test('local capability UI requires explicit binding and tool-profile confirmation',async()=>{
 const dom=new JSDOM('<details id="local-capabilities"><summary>Local</summary><p id="capability-notice"></p><div class="capability-body"></div></details>'),doc=dom.window.document,calls=[];const state={capabilities:{'keyword.metrics':{status:'missing',bindings:[]}},candidates:[{id:'candidate',name:'Example skill',capabilities:['keyword.metrics']}],running:false};const profile={id:'example-tool',hosts:['example.test'],name:{en:'Example',zh:'示例'},pages:[],links:{}};
 const panel=new CapabilitiesPanel(doc,async(method,params)=>{calls.push([method,params]);return method==='tool_draft'?{id:'draft',profile}:state;},{language:'en'});try{await panel.refresh();assert.match(doc.body.textContent,/Needs binding/);const remember=[...doc.querySelectorAll('button')].find(button=>button.textContent==='Remember this tool');await remember.onclick();assert.equal(calls.filter(([method])=>method==='tool_draft').length,1);assert.equal(calls.filter(([method])=>method==='tool_save').length,0);const confirm=[...doc.querySelectorAll('button')].find(button=>button.textContent==='Confirm and save tool profile');await confirm.onclick();assert.equal(calls.filter(([method])=>method==='tool_save').length,1);}finally{dom.window.close();}
});
test('tool-aware selection recommendations promote executable flows and route missing ones to binding',()=>{
 const suggestions=[{action:'workflow.run',params:{flow:'leaders',object:'sample'},title:'Leading sites',why:'Use measured sources',available:true,contextual:true},{action:'workflow.run',params:{flow:'pool_gap',object:'site.example.test'},title:'Pool gap',why:'Needs local source',available:false,missing_capabilities:['pool.lookup'],contextual:true}];const tasks=selectionTasks('sample',{suggestions,language:'en'}).tasks;assert.equal(tasks[0].action,'workflow.run');assert.equal(tasks[1].action,'bindings');assert.match(tasks[1].description,/pool.lookup/);
});
test('workflow progress and stopped results remain readable without raw JSON',async()=>{
 const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8'),dom=new JSDOM(html),doc=dom.window.document;
 const running={id:'running',action:'workflow.run',status:'executing',title:'Workflow',step:'2/5 · Read domain · page 3',params:{}},stopped={id:'stopped',action:'workflow.run',status:'stopped',title:'Stopped',params:{},result:{verdict:'Stopped with saved steps',level:'info',metrics:[],missing:[],process:[],next:[],records:[{keyword:'sample',vol:123,kd:4,tier:'fixture',source:'example-seo-tool',field_sources:{kd:'example-seo-tool exact'}}],steps:[{label:'Fetch metrics',status:'completed',source:'fixture',count:1}],artifacts:[]}};
 try{
  renderDashboard(doc,{enabled:true,ready:true,suggestions:[running,stopped]},{command:async()=>{}});assert.match(doc.querySelector('#running').textContent,/2\/5.*page 3/);
  const result=doc.querySelector('#results');assert.match(result.textContent,/Stopped with saved steps/);assert.equal(result.querySelector('table'),null);
  const detail=doc.createElement('section');doc.body.append(detail);renderResult(doc,detail,stopped,{command:async()=>{},full:true});assert.match(detail.textContent,/sample/);assert.match(detail.textContent,/Fetch metrics/);assert.equal(detail.querySelector('pre'),null);
 }finally{dom.window.close();}
});
test('large browser responses use ordered private chunks, not one oversized message',async()=>{
 const calls=[],api={runtime:{id:'x',getURL:name=>'chrome-extension://x/'+name}};const background=new CopilotBackground(api,async(method,params)=>{calls.push([method,params]);return {accepted:true};});const data={records:Array.from({length:3000},()=>({keyword:'合成词'.repeat(20)})),source:'fixture'};await background.browserResult('id',data);assert.ok(calls.length>2);assert.ok(calls.slice(0,-1).every(([method,params],index)=>method==='browser_fetch_chunk'&&params.index===index));assert.deepEqual(JSON.parse(calls.slice(0,-1).map(([,params])=>params.text).join('')),data);assert.equal(calls.at(-1)[0],'browser_fetch_result');
});

test('cleanup uncertainty is returned and never silently upgraded to success',async()=>{
 const adapter={open:async()=>({}),readData:async()=>({ready:true}),close:async()=>{throw Error('unknown');}};const value=await collectToolReport(adapter,{id:'probe',kind:'capability_probe',params:{binding:{id:'fixture'},tool:{probe:{}},url:'https://seo.example.test/'}},()=>true);assert.equal(value.ready,false);assert.equal(value.blocked,'cleanup_unverified');
});
test('binding edits survive health refresh and report readers can opt into one-row tables',async()=>{
 const dom=new JSDOM('<details id="local-capabilities"><summary>Local</summary><p id="capability-notice"></p><div class="capability-body"></div></details>'),state={capabilities:{'keyword.metrics':{status:'missing',bindings:[]}},candidates:[]};const panel=new CapabilitiesPanel(dom.window.document,async()=>state,{language:'en'});try{await panel.refresh();const field=dom.window.document.querySelector('textarea');field.value='{"id":"my-edited-binding"}';field.dispatchEvent(new dom.window.Event('input'));await panel.refresh();assert.equal(dom.window.document.querySelector('textarea').value,'{"id":"my-edited-binding"}');}finally{dom.window.close();}
 const table=new JSDOM('<table><tr><th>Keyword</th><th>Volume</th></tr><tr><td>sample</td><td>12</td></tr></table>',{url:'https://seo.example.test/'});try{table.window.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];assert.equal(captureTables(table.window.document).tables.length,0);assert.equal(captureTables(table.window.document,1).tables[0].rows.length,1);}finally{table.window.close();}
});
test('workflow bodies load only when expanded and are cached by result token',async()=>{
 const {renderResult}=await import('../../native-extension/copilot-result-view.mjs');const dom=new JSDOM('<article></article><p id="notice"></p>'),doc=dom.window.document;const head={verdict:'Intent verified',level:'info',metrics:[],missing:[]},row={id:'lazy',action:'workflow.run',status:'completed',params:{},result_token:'one',result_deferred:true,result:head};let calls=0;const complete={...row,result_deferred:false,result:{...head,process:[],next:[],records:[{keyword:'sample',vol:123,kd:4,source:'fixture'}],steps:[],artifacts:[]}};
 try{renderResult(doc,doc.querySelector('article'),row,{command:async method=>{assert.equal(method,'result');calls++;return complete;}});assert.doesNotMatch(doc.querySelector('article').textContent,/sample/);const details=doc.querySelector('.result-details');details.open=true;details.dispatchEvent(new dom.window.Event('toggle'));await new Promise(resolve=>setTimeout(resolve,10));assert.match(doc.querySelector('article').textContent,/sample/);assert.equal(calls,1);}finally{dom.window.close();}
});
