import {renderStatus} from '../../native-extension/ui-design.mjs';
import {renderChains} from '../../native-extension/copilot-readiness.mjs';
import {mountControls,boardName,renderConnection} from '../../native-extension/copilot-controls.mjs';
import {taskTableAdapter} from '../../native-extension/copilot-table-job.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
import {CloudLink} from '../support/cloud-link-stub.mjs';
// 中文注释：VM 夹具显式注入独立 Cookie 模块，保持生产后台模块依赖一致。
import {CookieMirror} from '../../native-extension/cookie-mirror.mjs';
// Real popup -> real background dispatcher -> real Bridge request envelope.
// Browser/Executor and daemon replies are in-memory doubles; NO browser or host starts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {Bridge,isUiSender,BrowserConsent} from '../../native-extension/bridge.mjs';
import {DiagnosticEventBuffer} from '../../browser-diagnostics/js/diagnostics.mjs';
const packageVersion=JSON.parse(await readFile('package.json','utf8')).version;
const root=new URL('../../native-extension/',import.meta.url);
const [html,popup,background]=await Promise.all(['popup.html','popup.mjs','background.mjs'].map(f=>readFile(new URL(f,root),'utf8')));
const clone=v=>structuredClone(v);
const seed=()=>({id:'native-task',generation:3,title:'真实路由测试（合成数据）',state:'pending_approval',activeMode:'smart',modeGeneration:1,tabIds:[],allowedOrigins:['https://example.test']});
async function harness(initialStorage={},manifestVersion=packageVersion){
 let task=seed(),queue=[],receive,dispatch,executor,poll;const nativeCalls=[],popupCalls=[];
 const port={onDisconnect:{addListener(){}},onMessage:{addListener:f=>receive=f},postMessage:m=>{
  nativeCalls.push(clone(m));queueMicrotask(()=>{let result;
   switch(m.method){
    case 'extension.copilot.state':result={enabled:false,show_ball:true,suggestions:[]};break;case 'extension.hello':result={};break;
    // 中文注释：弹窗状态复用在线实例清单，夹具只返回脱敏元信息。
    case 'extension.browser_list':result=[];break;
    case 'extension.cdp_events':result={};break;
    case 'extension.tasks':result=[clone(task)];break;
    case 'extension.approvals':result=clone(queue);break;
    case 'extension.popup_adopted':receive({id:m.id,error:{message:'synthetic audit rejected'}});return;
    case 'extension.approve':task={...task,...m.params,state:m.params.workspaceOnly?'authorizing':'ready',id:task.id};result=clone(task);break;
    case 'extension.mode':task={...task,state:'ready',activeMode:m.params.mode,modeGeneration:task.modeGeneration+1};result=clone(task);break;
    case 'extension.decide':queue=[];result={status:'accepted'};break;
    case 'extension.stop':task={...task,state:'cancelled'};result=clone(task);break;
    case 'extension.reject':task={...task,state:'failed'};result=clone(task);break;
    default:throw Error(`unexpected native method ${m.method}`);
   }
   receive({id:m.id,result});
  });
 }};
 class TestExecutor{
  // 中文注释：本夹具不创建页面浮层，握手清理能力由专项 DOM 回归覆盖。
  async cleanupOrphanOverlays(){}
  constructor(_api,_event,options={}){this.options=options;this.releases=[];executor=this;this.tasks=new Map();this.leases=new Map();this.actionGrants=new Map();this.attached=new Set();this.diagnostics=new DiagnosticEventBuffer();}
  async approve(t){this.tasks.set(t.id,{...t,policy:{activeMode:'smart',modeGeneration:t.modeGeneration}});for(const id of t.tabIds)this.leases.set(id,t.id);}
  revokeMode(id){this.tasks.get(id).policy.activeMode='smart';}
  setMode(t){this.tasks.get(t.id).policy={activeMode:t.activeMode,modeGeneration:t.modeGeneration};}
  approveAction(a){this.actionGrants.set(a.nonce,a);}
  async release(params){this.releases.push(clone(params));const {taskId}=params;const t=this.tasks.get(taskId);if(t){t.revoked=true;t.policy.activeMode='smart';}}
  async disconnect(){}
 }
 class TestWorkspaces{constructor(){this.manager={reconcile:async()=>{}};}async status(){return [];}}
 const event={addListener(){}};const storage=clone(initialStorage);const api={
  runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,getManifest:()=>({version:manifestVersion}),onMessage:{addListener:f=>dispatch=f},connectNative:()=>port,sendMessage:async()=>({})},
  storage:{session:{get:async()=>({instanceId:'test-instance'}),set:async()=>{}},local:{get:async()=>clone(storage),set:async v=>Object.assign(storage,v)}},
  notifications:{onClicked:event},
  windows:{onFocusChanged:event,get:async id=>({id,focused:true})},
  alarms:{create(){},onAlarm:event},tabs:{onCreated:event,onRemoved:event,onUpdated:event,query:async()=>[{id:7,windowId:4,active:true,url:'https://example.test/work',title:'工作页'}],get:async()=>({id:7,windowId:4,active:true,url:'https://example.test/work'})},debugger:{onDetach:event}
 };
 // Only ES module linking is replaced. The background handler body is unchanged.
 vm.runInNewContext(background.replace(/^import .*;\n/gm,''),{taskTableAdapter,CopilotBackground,CloudLink,CookieMirror,Executor:TestExecutor,NativeWorkspaces:TestWorkspaces,Bridge,BrowserConsent,isUiSender,reloadForInstalledBuild:async()=>false,BUILD_ID:'',registerWorkspaceStartup:()=>{},origin:u=>new URL(u).origin,chrome:api,navigator:{userAgent:'Node DOM harness'},crypto:globalThis.crypto,console});
 const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};await flush();
 const sender={id:'test',url:'chrome-extension://test/popup.html'};
 const send=m=>new Promise(resolve=>{popupCalls.push(clone(m));assert.equal(dispatch(m,sender,resolve),true);});
 const dom=new JSDOM(html,{url:sender.url,runScripts:'outside-only',pretendToBeVisual:true});
 dom.window.chrome={i18n:{getUILanguage:()=> 'zh-CN'},tabs:api.tabs,runtime:{getManifest:api.runtime.getManifest,sendMessage:send,onMessage:{addListener(){}}}};dom.window.setInterval=f=>{poll=f;return 1;};dom.window.clearInterval=()=>{};
 Object.assign(dom.window,{renderStatus,renderChains,mountControls,boardName,renderConnection});dom.window.eval(popup.replace(/^import .*;\n/gm,''));await flush();
 const d=dom.window.document;
 const click=async selector=>{const b=d.querySelector(selector);assert.ok(b,selector);assert.equal(b.disabled,false,selector);b.click();await flush();};
 return {dom,d,click,send,flush,storage,api,poll:async()=>{await poll();await flush();},nativeCalls,popupCalls,dispatch,executor,queue:(nonce='nonce-real-routing')=>{queue=[{taskId:task.id,nonce,digest:'digest-real-routing',request:{action:'click',tabId:7,selector:'#save'}}];},reset:()=>{task={...seed(),generation:4};executor.tasks.clear();executor.leases.clear();}};
}
test('握手与弹窗状态读取浏览器 manifest，而非源码版本常量',async()=>{
 const parts=packageVersion.split('.').map(BigInt),version=`${parts[0]}.${parts[1]}.${parts[2]+1n}`;
 const h=await harness({},version);
 assert.equal(h.nativeCalls.find(m=>m.method==='extension.hello').params.version,version);
 assert.equal((await h.send({type:'popup_status'})).result.version,version);
 assert.equal(h.d.querySelector('#version-label').textContent,`v${version}`);
 h.dom.window.close();
});

test('browser identity survives sessions and obsolete smart preference cannot require another grant',async()=>{
 const old=await harness({preferredMode:'smart',browserFullConsent:{version:1,enabled:false},browserInstanceId:'durable-instance'});
 assert.equal(old.nativeCalls.find(m=>m.method==='extension.hello').params.instanceId,'durable-instance');
 assert.equal(old.nativeCalls.some(m=>m.method==='extension.approve'),true);
 assert.equal(old.executor.tasks.get('native-task').policy.activeMode,'full');
 const restored=await harness({browserFullConsent:{version:1,enabled:true},browserInstanceId:'durable-instance'});
 assert.equal(restored.executor.tasks.get('native-task').policy.activeMode,'full');
});

test('connected task is full-only without selecting user tabs or a mode confirmation',async()=>{
 const h=await harness();
 assert.equal(h.nativeCalls.some(x=>x.method==='extension.approve'),true);
 const approval=h.nativeCalls.find(x=>x.method==='extension.approve');
 assert.deepEqual(approval.params.tabIds,[]);assert.equal(approval.params.workspaceOnly,true);
 assert.equal(Object.hasOwn(approval.params,'apiBridgeApproved'),false);
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'full');
 const status=await h.send({type:'status'});assert.equal(status.result.browserFullConsent,true);
 assert.equal(h.d.querySelector('#access-toggle,#confirm-enable'),null);
 assert.equal((await h.send({type:'browser_consent',enabled:false})).error,'不支持的操作');
 assert.equal((await h.send({type:'mode',taskId:'native-task',mode:'smart'})).error,'不支持的操作');
 assert.equal(h.executor.tasks.get('native-task').policy.activeMode,'full');
 assert.equal((await h.send({type:'status'})).result.browserFullConsent,true);
 assert.equal(h.dispatch({type:'browser_consent',enabled:true},{id:'test',url:'https://evil.test'},()=>assert.fail()),false);
});

test('popup exposes connection status without mode switch; foreign senders cannot change authorization',async()=>{
 const h=await harness();
 assert.match(h.d.querySelector('#connection-label').getAttribute('aria-label'),/已连接/);
 assert.equal(h.d.querySelector('#tasks'),null);
 assert.equal(h.d.querySelector('#diagnostics'),null);
 assert.equal(h.d.querySelector('#access-toggle'),null);
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'test',url:'chrome-extension://test/other.html'},()=>assert.fail('foreign sender accepted')),false);
 assert.equal(h.dispatch({type:'mode',taskId:'native-task',mode:'full'},{id:'foreign',url:'chrome-extension://test/popup.html'},()=>assert.fail('foreign extension accepted')),false);
});

// 中文注释：使用真实后台消息处理器验证受信配置、持久化读回及恶意发起者拒绝。
test('旧过滤设置被忽略，弹窗无过滤入口，原始事件正常推送',async()=>{
 const h=await harness({pageContentFilter:'invalid',pageContentShieldRules:{bad:['[']}});
 try{
  assert.equal(h.d.querySelector('#filter-toggle,#shield-settings'),null);
  assert.equal(h.d.querySelector('#version-label').textContent,`v${packageVersion}`);
  assert.equal((await h.send({type:'popup_status'})).error,undefined);
  const before=h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length;
  await h.executor.options.onCdpEvents({events:[{text:'原始事件正文'}]});
  assert.equal(h.nativeCalls.filter(m=>m.method==='extension.cdp_events').length,before+1);
 }finally{h.dom.window.close();}
});

test('automatic popup audit rejection stops the exact task and releases overlays without deleting tabs or replaying',async()=>{
 const h=await harness();
 try{
  const task=h.executor.tasks.get('native-task');
  await assert.rejects(h.executor.options.onPopupAdopt({taskId:task.id,generation:task.generation,modeGeneration:task.policy.modeGeneration,popupScope:{}}),/synthetic audit rejected/);
  await h.flush();
  assert.equal(task.revoked,true);
  assert.deepEqual(h.executor.releases.at(-1),{taskId:task.id,generation:task.generation,closeAgentTabs:false});
  assert.equal(h.nativeCalls.filter(call=>call.method==='extension.popup_adopted').length,1);
  const stopped=h.nativeCalls.filter(call=>call.method==='extension.stop');assert.equal(stopped.length,1);
  assert.deepEqual(stopped[0].params,{taskId:task.id,generation:task.generation});
 }finally{h.dom.window.close();}
});

test('侧栏仅有连接摘要只读入口，网页不能读取或借此调用模型/配对',async()=>{
 const h=await harness();try{const count=h.nativeCalls.length;let result;
 assert.equal(h.dispatch({type:'copilot.connections'},{id:'test',url:'chrome-extension://test/copilot-panel.html'},value=>{result=value;}),false);assert.ok(Object.hasOwn(result.result,'cloud'));assert.equal(h.nativeCalls.length,count);
 for(const url of ['https://example.test/','chrome-extension://test/unrelated.html']){let called=false;assert.equal(h.dispatch({type:'copilot.connections'},{id:'test',url,tab:{id:9}},()=>{called=true;}),false);assert.equal(called,false);}assert.equal(h.nativeCalls.length,count);
 }finally{h.dom.window.close();}
});
