import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {SessionRetry} from '../../native-extension/copilot-retry.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
import {CapabilitiesPanel} from '../../native-extension/copilot-capabilities-panel.mjs';
import {statePresentation} from '../../native-extension/copilot-view.mjs';
import {renderConnection} from '../../native-extension/copilot-controls.mjs';

function timers(){let next=0;const jobs=new Map(),delays=[];return {jobs,delays,schedule(fn,delay){delays.push(delay);jobs.set(++next,fn);return next;},cancel(id){jobs.delete(id);},async tick(){const [id,fn]=jobs.entries().next().value;jobs.delete(id);await fn();}};}
test('startup retry backs off 5/15/60 seconds, stops, and resets only explicitly or on ready',async()=>{
 const clock=timers();let calls=0;const retry=new SessionRetry(async()=>{calls++;throw Error('synthetic');},clock);
 retry.failed();retry.failed();assert.equal(clock.jobs.size,1);
 await clock.tick();await clock.tick();await clock.tick();retry.failed();
 assert.deepEqual(clock.delays,[5000,15000,60000]);assert.equal(calls,3);assert.equal(clock.jobs.size,0);
 retry.reset();retry.failed();assert.equal(clock.jobs.size,1);retry.reset();assert.equal(clock.jobs.size,0);
});
test('background startup failure schedules bounded retries; manual off cancels and untrusted messages cannot reset',async()=>{
 const clock=timers(),calls=[];
 const api={storage:{local:{get:async()=>({})},session:{remove:async()=>{}}},runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,sendMessage:async()=>{}},scripting:{getRegisteredContentScripts:async()=>[],registerContentScripts:async()=>{},unregisterContentScripts:async()=>{}},tabs:{query:async()=>[]}};
 const app=new CopilotBackground(api,async(method,params)=>{calls.push([method,params]);return {enabled:params.enabled,suggestions:[]};});
 app.sessionRetry=new SessionRetry(async()=>{await app.request('settings',{enabled:true});},clock);
 const failure={type:'settings',enabled:false,startup_error:{reason:'Hermes 命令不可用'}};
 for(let i=0;i<3;i++){await app.notification(failure);await clock.tick();}
 await app.notification(failure);assert.equal(clock.jobs.size,0);assert.equal(calls.length,3);
 const sender={id:'fixture',url:api.runtime.getURL('copilot-panel.html')};
 await new Promise(resolve=>app.handle({type:'copilot.command',command:'settings',params:{enabled:false}},sender,resolve));
 assert.equal(app.sessionRetry.attempts,0);
 await app.notification(failure);assert.equal(clock.jobs.size,1);
 assert.equal(app.handle({type:'copilot.command',command:'settings',params:{enabled:true}},{id:'untrusted',url:'https://example.test/'},()=>{}),false);
 assert.equal(clock.jobs.size,1);
 await app.notification({type:'ready'});assert.equal(clock.jobs.size,0);
});
test('merge and disabled template notices render in local capabilities in both languages',async()=>{
 const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
 for(const language of ['zh','en']){
  const dom=new JSDOM(html);try{
   const panel=new CapabilitiesPanel(dom.window.document,async()=>({pending_templates:['seo.keyword_check.json'],disabled_templates:{'seo.longtail':'ValueError'},capabilities:{}}),{language});
   await panel.refresh();const text=dom.window.document.getElementById('capability-notice').textContent;
   assert.match(text,language==='zh'?/有模板需要合并/:/Templates need merging/);assert.match(text,/seo.keyword_check/);assert.match(text,/seo.longtail/);
  }finally{dom.window.close();}
 }
});
test('specific startup reason and retry action appear in sidebar status and shared health component',()=>{
 const dom=new JSDOM('<span></span>');try{
  const startup_error={reason:'推理 profile 不存在',reason_en:'Inference profile missing'};
  assert.equal(statePresentation({diagnostic:'acp_start_blocked',startup_error}).label,'出错 · 重试');
  assert.equal(statePresentation({diagnostic:'acp_start_blocked',startup_error}).message,'推理 配置 不存在');
  assert.equal(statePresentation({diagnostic:'acp_start_blocked',startup_error,locale:'en'}).message,'Inference configuration missing');
  const el=dom.window.document.querySelector('span');renderConnection(el,{state:'error',...startup_error},'en');assert.equal(el.title,'Inference configuration missing');
 }finally{dom.window.close();}
});


test('single inference failure shows a notice, three failures show the reason, and recovery is connecting',async()=>{
 const {renderDashboard}=await import('../../native-extension/copilot-view.mjs');
 const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8'),dom=new JSDOM(html);
 try{
  const state={enabled:true,ready:true,suggestions:[],inference_failures:1,inference_failure:{reason:'model_output_invalid',message:'模型返回格式不对，已保留原建议'}};
  renderDashboard(dom.window.document,state,{command:async()=>{}});
  assert.equal(dom.window.document.getElementById('error').hidden,true);
  assert.match(dom.window.document.getElementById('notice').textContent,/模型返回格式不对/);
  state.inference_failures=3;state.diagnostic='model_output_invalid';renderDashboard(dom.window.document,state,{command:async()=>{}});
  assert.equal(dom.window.document.getElementById('connection-notice').hidden,false);assert.match(dom.window.document.getElementById('connection-message').textContent,/模型返回格式不对/);assert.equal(dom.window.document.getElementById('error').hidden,true);assert.equal(dom.window.document.getElementById('notice').hidden,true);
  assert.equal(statePresentation({...state,recovering:true}).label,'正在重连');
  state.inference_failure=null;state.diagnostic=null;renderDashboard(dom.window.document,state,{command:async()=>{}});
  assert.equal(dom.window.document.getElementById('notice').textContent,'');
 }finally{dom.window.close();}
});


test('daemon recovery exhaustion cannot trigger a second frontend restart budget',async()=>{
 const clock=timers(),api={storage:{local:{get:async()=>({})},session:{remove:async()=>{}}},runtime:{sendMessage:async()=>{}},tabs:{query:async()=>[]},scripting:{getRegisteredContentScripts:async()=>[]}};
 const app=new CopilotBackground(api,async()=>({enabled:true}));app.sessionRetry=new SessionRetry(async()=>{},clock);
 for(let i=0;i<4;i++)await app.notification({type:'settings',enabled:false,startup_error:{reason:'synthetic',recovery_exhausted:true}});
 assert.equal(clock.jobs.size,0);assert.deepEqual(clock.delays,[]);
});
