import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {TaskLogPanel} from '../../native-extension/copilot-task-logs.mjs';

const entry=(id,task='one',event='execute_step',details={})=>({id,time:Date.now()/1000,type:'execution',event,summary:'PRIVATE_RESULT_BODY',details:{task_id:task,step_index:2,step_name:'browser_read',provider:'local',count:3,...details}});
function fixture(command=async()=>({entries:[],revision:1}),options){
 const dom=new JSDOM('<div id="work-view"><button id="opener">日志</button></div><section id="settings-view" inert data-active="false"></section>',{pretendToBeVisual:true});const doc=dom.window.document;
 doc.getElementById('opener').focus();const panel=new TaskLogPanel(doc,command,options);return {dom,doc,panel,close(){panel.dispose();dom.window.close();}};
}

test('task detail isolates execution logs and projects safe fields without raw values',async()=>{
 const calls=[],f=fixture(async(name,args)=>{calls.push([name,args]);return {revision:4,entries:[entry(1),entry(2,'two'),{...entry(3),type:'inference'},entry(4,'one','execute_complete',{argv:['PRIVATE_ARGV'],params:{value:'PRIVATE_VALUE'},result:'PRIVATE_RESULT',step_name:'terminal --secret=PRIVATE_STEP',provider:'Bearer_PRIVATE',capability:'keyword.metrics',duration_ms:1250})]};});
 try{await f.panel.open({id:'one',title:'读取页面',status:'completed',started_at:100,finished_at:109});
  assert.deepEqual(calls,[['logs_read',{}]]);assert.equal(f.panel.list.querySelectorAll('article').length,2);assert.match(f.panel.root.textContent,/任务完成/);assert.match(f.panel.root.textContent,/keyword.metrics/);assert.match(f.panel.root.textContent,/1.3s/);assert.match(f.panel.elapsed.textContent,/9 秒/);assert.doesNotMatch(f.panel.root.textContent,/PRIVATE|Bearer|terminal --/);
  assert.equal(f.doc.getElementById('work-view').hasAttribute('inert'),true);assert.equal(f.doc.getElementById('settings-view').dataset.active,'false');assert.equal(f.panel.root.hasAttribute('inert'),false);
  f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.panel.active,false);assert.equal(f.panel.root.hasAttribute('inert'),true);assert.equal(f.doc.activeElement.id,'opener');assert.equal(f.doc.getElementById('work-view').hasAttribute('inert'),false);
 }finally{f.close();}
});

test('live updates replace folded rows, respect pause and retain terminal task after state eviction',async()=>{
 const f=fixture();try{await f.panel.open({id:'one',title:'任务',status:'executing',started_at:Date.now()/1000-5,step:'browser_read'});
  assert.match(f.panel.step.textContent,/browser_read/);assert.ok(f.panel.timer);f.panel.append({revision:2,entries:[entry(1)]});assert.equal(f.panel.list.querySelectorAll('article').length,1);
  Object.defineProperties(f.panel.viewport,{scrollHeight:{value:900,configurable:true},clientHeight:{value:100,configurable:true}});f.panel.latest();assert.equal(f.panel.viewport.scrollTop,800);f.panel.pause.click();f.panel.viewport.scrollTop=70;
  f.panel.append({revision:3,entries:[entry(1,'one','execute_step',{count:8}),entry(2)]});assert.equal(f.panel.viewport.scrollTop,70);assert.equal(f.panel.list.querySelectorAll('article').length,2);assert.match(f.panel.list.firstChild.textContent,/8 条/);assert.equal(f.panel.pause.getAttribute('aria-pressed'),'true');f.panel.pause.click();assert.equal(f.panel.viewport.scrollTop,800);
  f.panel.update({suggestions:[{id:'one',title:'任务',status:'executing',started_at:100,step:'result_prepare'}]});assert.match(f.panel.step.textContent,/正在整理结果.*result_prepare/);
  f.panel.update({suggestions:[{id:'one',title:'任务',status:'completed',started_at:100,finished_at:112}]});assert.equal(f.panel.timer,null);assert.match(f.panel.elapsed.textContent,/12 秒/);f.panel.update({suggestions:[]});assert.match(f.panel.step.textContent,/已完成/);assert.match(f.panel.elapsed.textContent,/12 秒/);
  f.panel.append({revision:4,entries:[entry(3,'one','execute_complete')]});assert.equal(f.panel.list.querySelectorAll('article').length,3);
 }finally{f.close();}
});

test('all executions include other tasks, reset and stale load cannot resurrect cleared logs',async()=>{
 let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));try{const opening=f.panel.open(null);f.panel.append({revision:20,entries:[entry(1),entry(2,'two')]});assert.equal(f.panel.list.querySelectorAll('article').length,2);assert.equal(f.panel.summary.hidden,true);
  f.panel.append({revision:21,reset:true,entries:[]});resolve({revision:19,entries:[entry(1)]});await opening;assert.equal(f.panel.entries.length,0);assert.match(f.panel.list.textContent,/暂无执行日志/);
  f.panel.append({revision:22,entries:[entry(3,'two')]});assert.equal(f.panel.list.querySelectorAll('article').length,1);f.panel.append({revision:21,entries:[entry(4)]});assert.equal(f.panel.entries.length,1);
 }finally{f.close();}
});

test('out-of-order initial read merges history without overwriting fresher folded event',async()=>{
 let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));try{const opening=f.panel.open(null);f.panel.append({revision:10,entries:[entry(2,'one','execute_step',{count:9})]});resolve({revision:9,entries:[entry(1),entry(2)]});await opening;assert.equal(f.panel.entries.length,2);assert.match(f.panel.list.lastChild.textContent,/9 条/);
 }finally{f.close();}
});

test('timer ticks once per second and close/dispose remove it and keyboard listener',async()=>{
 const f=fixture();let tick,cleared=0;f.dom.window.setInterval=(callback,delay)=>{assert.equal(delay,1000);tick=callback;return 7;};f.dom.window.clearInterval=id=>{assert.equal(id,7);cleared++;};
 try{await f.panel.open({id:'one',status:'executing',started_at:Date.now()/1000-4});f.panel.row.started_at-=2;tick();assert.match(f.panel.elapsed.textContent,/6 秒/);f.panel.close();assert.equal(cleared,1);assert.equal(f.panel.timer,null);f.panel.dispose();assert.equal(f.doc.getElementById('task-log-view'),null);f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape'}));
 }finally{f.close();}
});

test('return restores task action focus even if the live dashboard replaced its button',async()=>{
 const f=fixture();try{const card=f.doc.createElement('article');card.dataset.id='one';const button=f.doc.createElement('button');button.dataset.action='task_logs';card.append(button);f.doc.getElementById('work-view').append(card);button.focus();await f.panel.open({id:'one',status:'completed'});const replacement=button.cloneNode();button.replaceWith(replacement);f.panel.back.click();assert.equal(f.doc.activeElement,replacement);assert.equal(f.doc.getElementById('settings-view').dataset.active,'false');
 }finally{f.close();}
});

test('Chinese descriptive steps update live and appear in logs while credential and argument text stays hidden',async()=>{
 const f=fixture();try{await f.panel.open({id:'one',status:'executing',step:'2/5 · 读取报表 · 第3页'});assert.match(f.panel.step.textContent,/2\/5 · 读取报表 · 第3页/);
  f.panel.update({suggestions:[{id:'one',status:'executing',step:'2/5 · 读取报表 · 第4页'}]});assert.match(f.panel.step.textContent,/第4页/);assert.doesNotMatch(f.panel.step.textContent,/第3页/);
  f.panel.append({revision:2,entries:[entry(1,'one','execute_step',{step_name:'读取报表 · 第4页'}),entry(2,'one','execute_step',{step_name:'Reading report page 5'})]});assert.match(f.panel.list.textContent,/读取报表 · 第4页/);assert.match(f.panel.list.textContent,/Reading report page 5/);
  let revision=3,identity=3;for(const step of ['terminal --secret=PRIVATE_STEP','Authorization: Bearer PRIVATE_VALUE','params {"value":"PRIVATE_VALUE"}','密码 PRIVATE_PASSWORD','run --file PRIVATE_FILE','password_PRIVATE_PASSWORD','argv_PRIVATE_ARGV']){
   f.panel.update({suggestions:[{id:'one',status:'executing',step}]});assert.doesNotMatch(f.panel.step.textContent,/PRIVATE/);
   f.panel.append({revision:revision++,entries:[entry(identity++,'one','execute_step',{step_name:step})]});assert.doesNotMatch(f.panel.list.textContent,/PRIVATE/);
  }
  f.panel.update({suggestions:[{id:'one',status:'executing',step:'读取 <b>报表</b> 页面'}]});assert.match(f.panel.step.textContent,/<b>报表<\/b>/);assert.equal(f.panel.step.querySelector('b'),null);
 }finally{f.close();}
});

test('failure notice stays useful, reopen loads again and abandoned requests cannot change active task',async()=>{
 let reject,resolve;let calls=0;const f=fixture(()=>{calls++;return calls===1?new Promise((_,fail)=>{reject=fail;}):calls===2?new Promise(done=>{resolve=done;}):Promise.resolve({revision:3,entries:[entry(3,'two')]});},{language:'en'});
 try{const abandoned=f.panel.open({id:'one',status:'executing'});f.panel.close();const next=f.panel.open({id:'two',status:'completed'});reject(new Error('PRIVATE_ERROR'));await abandoned;assert.equal(f.panel.notice.textContent,'');resolve({revision:2,entries:[entry(1,'one'),entry(2,'two')]});await next;assert.equal(f.panel.list.querySelectorAll('article').length,1);assert.equal(f.panel.entries.length,2);assert.match(f.panel.title.textContent,/Task logs/);
  f.panel.close();await f.panel.open(null);assert.equal(calls,3);f.panel.append({error:'event_log_write_failed'});assert.match(f.panel.notice.textContent,/Logs unavailable/);assert.doesNotMatch(f.panel.root.textContent,/PRIVATE/);
 }finally{f.close();}
});
