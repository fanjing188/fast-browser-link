import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {TablePanel} from '../../native-extension/copilot-table-panel.mjs';

const markup=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
const capture={url:'https://example.test/',tables:[{id:'0',name:'关键词表',headers:['关键词','数量'],rows:[['sample','1']],pagination:{totalPages:3,totalRows:9},incomplete:true}]};
const saved={key:`${capture.url}|0`,result:{id:'saved-table',files:[{id:'file-1',path:'/exports/table.xlsx'}]}};
function fixture(state={},handler=async()=>({})){
 const dom=new JSDOM(markup),doc=dom.window.document,calls=[];
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};
 const panel=new TablePanel(doc,async(name,params)=>{calls.push([name,params]);return name==='table_state'?state:handler(name,params);});
 panel.state=state;
 return {dom,doc,panel,calls,root:doc.getElementById('table-tools'),close:()=>dom.window.close()};
}
async function click(root,label){const button=[...root.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(button,label);await button.onclick();}
test('Excel and CSV receipts survive panel recreation and deduplicate native result copies',async()=>{
 const second={key:saved.key,result:{id:'csv-table',files:[{id:'csv-file',path:'/exports/table.csv'}]}},f=fixture({capture,receipts:[saved,second]});
 try{await f.panel.refresh();const rows=f.panel.mergeSuggestions([{id:'table-saved-table',status:'completed'},{id:'table-csv-table',status:'completed'},{id:'other',action:'general.task',status:'completed'}]);assert.equal(rows.length,2);const receipt=rows.find(row=>row.local_table);assert.equal(receipt.result.export.files.length,2);await f.panel.command('open_result',{id:receipt.id});assert.match(f.root.textContent,/table.xlsx/);assert.match(f.root.textContent,/table.csv/);await f.panel.refresh();assert.equal(f.panel.suggestions()[0].result.export.files.length,2);}finally{f.close();}
});
test('local table entries replace redundant model exports while preserving explicit or analytical tasks',async()=>{
 const f=fixture({capture});try{await f.panel.refresh();const rows=f.panel.mergeSuggestions([{id:'export',action:'table.export',status:'pending'},{id:'plain',title:'保存本页表格',action:'general.task',status:'pending',params:{task:'保存本页表格'}},{id:'analysis',title:'保存本页表格',action:'general.task',status:'pending',params:{task:'保存本页表格并分析增长'}},{id:'explicit',action:'table.export',status:'pending',explicit:true}]);assert.deepEqual(rows.filter(row=>!row.local_table).map(row=>row.id),['analysis','explicit']);assert.equal(rows.filter(row=>row.local_table).length,1);}finally{f.close();}
});
test('saved receipts from an older document never suppress a fresh table at the same URL',async()=>{
 const f=fixture({capture:{...capture,documentId:'new-document',epoch:2}});try{
  const oldCapture={...capture,documentId:'old-document',epoch:0};f.panel.state.receipts=[{...saved,identity:f.panel.key(oldCapture,oldCapture.tables[0])}];await f.panel.refresh();const rows=f.panel.suggestions();assert.equal(rows.filter(row=>row.status==='pending').length,1);assert.equal(rows.filter(row=>row.status==='completed').length,1);assert.notEqual(rows[0].id,rows[1].id);
 }finally{f.close();}
});
test('a delayed old sidebar read cannot restore stale rows after the latest empty document read',async()=>{
 for(const fail of [false,true]){const f=fixture({capture});try{
  await f.panel.refresh();const original=f.panel.suggestions()[0];await f.panel.command('execute',{id:original.id});let finishOld;
  f.panel.request=()=>new Promise((resolve,reject)=>{finishOld=fail?reject:resolve;});const old=f.panel.refresh();f.panel.request=async()=>({capture:{url:capture.url,documentId:'new',tables:[]}});await f.panel.refresh();finishOld(fail?Error('late failure'):{capture});await old;
  assert.equal(f.panel.suggestions().some(row=>row.status==='pending'),false);assert.doesNotMatch(f.root.textContent,/已识别 1 行|表格连接未就绪/);
 }finally{f.close();}}
});

test('table controls stay out of settings and empty context has no recognition button',async()=>{
 const f=fixture();try{assert.ok(f.doc.querySelector('#table-export-dialog #table-tools'));assert.equal(f.doc.querySelector('#work-view #table-tools'),null);assert.ok(f.doc.querySelector('#table-export-dialog #table-confirmation-live'));assert.equal(f.doc.getElementById('table-export-dialog').open,false);assert.equal(f.doc.querySelector('#settings-view #table-tools'),null);assert.equal(f.root.hasAttribute('aria-label'),false);await f.panel.refresh();assert.equal(f.root.hidden,true);assert.equal(f.root.childElementCount,0);assert.doesNotMatch(f.doc.getElementById('settings-view').textContent,/识别当前表格|页面表格/);assert.equal(f.calls.some(([name])=>name==='recognize_tables'),false);}finally{f.close();}
});

test('capture retains export, copy, multipage, receipt, column and basket actions',async()=>{
 const f=fixture({capture,saved});try{await f.panel.refresh();assert.equal(f.root.hidden,true);const row=f.panel.suggestions()[0];await f.panel.command('open_result',{id:row.id});assert.equal(f.root.hidden,false);assert.doesNotMatch(f.root.textContent,/识别当前表格/);assert.equal(f.root.querySelectorAll('.table-strip').length,1);
 for(const label of ['保存为 Excel','保存为 CSV','复制为表格','保存全部','只存当前页','打开文件','打开所在文件夹','整表加入工作篮'])await click(f.root,label);
 const select=f.root.querySelector('select');select.value='1';select.onchange();await click(f.root,'所选列加入工作篮');await click(f.root,'批量查词');await click(f.root,'存词池');
 assert.ok(f.calls.some(([name,params])=>name==='save_table'&&params.format==='xlsx'));assert.ok(f.calls.some(([name,params])=>name==='save_table'&&params.format==='csv'));assert.ok(f.calls.some(([name])=>name==='copy_table'));assert.ok(f.calls.some(([name])=>name==='collect_table'));
 assert.deepEqual(f.calls.find(([name,params])=>name==='table_open'&&params.folder),['table_open',{id:'file-1',folder:true}]);assert.deepEqual(f.calls.filter(([name])=>name==='basket_add').map(([,params])=>params.items),[[{type:'table',value:'saved-table'}],[{type:'table',value:'saved-table',columns:[1]}]]);assert.deepEqual(f.calls.filter(([name])=>name==='table_column_action').map(([,params])=>params),[{id:'saved-table',column:1,operation:'check'},{id:'saved-table',column:1,operation:'save'}]);
 }finally{f.close();}
});

test('confirmation remains in its live region, preserving switch, save, clipboard and cancel',async()=>{
 const confirmation={token:'confirm-token',name:'关键词表',headers:['关键词','数量'],rows:1,pages:3,format:'xlsx',all:true,candidate_count:2};let copied='';
 const f=fixture({confirmation},async name=>name==='confirm_table'?{clipboard:'sample\t1',files:saved.result.files}:{});Object.defineProperty(f.dom.window.navigator,'clipboard',{value:{writeText:async text=>copied=text}});
 try{f.panel.render();const live=f.doc.getElementById('table-confirmation-live');assert.equal(f.root.hidden,true);assert.ok(live.querySelector('.confirmation-card'));for(const label of ['换一个表格','确认保存','取消'])await click(live,label);assert.deepEqual(f.calls.filter(([name])=>name==='confirm_table').map(([,params])=>params),[{kind:'switch',token:'confirm-token'},{kind:'confirm',token:'confirm-token'},{kind:'cancel',token:'confirm-token'}]);assert.equal(copied,'sample\t1');assert.match(f.doc.getElementById('notice').textContent,/已保存/);
 f.doc.getElementById('table-export-dialog').showModal();f.doc.getElementById('table-export-dialog').dispatchEvent(new f.dom.window.Event('cancel',{cancelable:true}));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(f.calls.filter(([name])=>name==='confirm_table').at(-1)[1],{kind:'cancel',token:'confirm-token'});
 }finally{f.close();}
});

test('collecting jobs stay in running and support stopping without exposing an empty context',async()=>{
 const f=fixture({jobs:[{id:'collect-1',status:'executing',pages:2,totalPages:3,rowCount:6}]});try{const count=f.doc.getElementById('running-count');count.dataset.native='2';f.panel.render();assert.equal(f.root.hidden,true);assert.equal(f.root.querySelector('.table-job'),null);const running=f.doc.getElementById('running');assert.match(running.textContent,/第 2\/3 页 · 已收 6 行/);assert.equal(count.textContent,'3');await click(running,'停止并保存部分');assert.deepEqual(f.calls.at(-1),['stop_table',{id:'collect-1'}]);f.panel.render();assert.equal(running.querySelectorAll('.table-job').length,1);}finally{f.close();}
});

test('saved receipts and failed collection remain visible without a current capture',async()=>{
 const f=fixture({saved,jobs:[{status:'failed',reason:'来源页面需要重新登录'}]});try{await f.panel.refresh();assert.equal(f.root.hidden,true);const row=f.panel.suggestions().find(item=>item.status==='completed');await f.panel.command('open_result',{id:row.id});assert.equal(f.root.hidden,false);assert.equal(row.result.verdict,'表格已保存');assert.match(f.root.textContent,/\/exports\/table.xlsx/);assert.match(f.root.textContent,/来源页面需要重新登录/);await click(f.root,'打开所在文件夹');assert.deepEqual(f.calls.at(-1),['table_open',{id:'file-1',folder:true}]);await f.panel.close();assert.equal(f.doc.getElementById('table-export-dialog').open,false);f.panel.state={};f.panel.render();assert.ok(f.panel.suggestions().some(item=>item.status==='completed'),'saved receipts remain available after the current capture disappears');}finally{f.close();}
});

test('refresh errors are contextual, readable and never written into settings',async()=>{
 for(const hasContext of [false,true]){const f=fixture(hasContext?{capture}:{});try{f.panel.render();if(hasContext)await f.panel.command('execute',{id:f.panel.suggestions()[0].id});f.panel.request=async()=>{throw Error('offline');};await f.panel.refresh();await f.panel.refresh();assert.equal(f.root.hidden,!hasContext);assert.equal(f.root.querySelectorAll('.local-table-error').length,hasContext?1:0);if(hasContext)assert.match(f.root.textContent,/表格连接未就绪/);assert.doesNotMatch(f.doc.getElementById('settings-view').textContent,/表格连接未就绪/);}finally{f.close();}}
});
