import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Executor,semanticWorldDeclaration,actionObservationOptions,compactSemanticSource,editableInputTarget} from '../../native-extension/core.mjs';
import {fillThroughInput} from './editable-fixture.mjs';

function fixture(html='<main id="result"><button>结果</button><p>正文</p></main>'){
 const dom=new JSDOM(html,{url:'https://fixture.test/',runScripts:'outside-only'}),w=dom.window;
 w.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
 w.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:120,bottom:50,width:100,height:30});
 w.document.elementFromPoint=()=>w.document.querySelector('button,[contenteditable],input,textarea');
 const calls=[],state={loader:'doc-1',writes:0,onWrite:null,onRead:null};
 const api={tabs:{get:async()=>({url:w.location.href})},debugger:{sendCommand:async(_target,method,params={})=>{
  calls.push({method,params});
  if(method==='Page.createIsolatedWorld')return {executionContextId:17};
  if(method==='Runtime.callFunctionOn'){
   try{return {result:{value:await w.eval(`(${params.functionDeclaration})`)(...(params.arguments||[]).map(arg=>arg.value))}};}
   catch(error){return {exceptionDetails:{exception:{description:error.toString()}}};}
  }
  throw Error('unexpected CDP command: '+method);
 }}};
 const e=new Executor(api),t={id:'task',generation:1,policy:{modeGeneration:1},semanticBindings:new Map(),frameSessions:new Map(),overlays:new Map()};
 e.tasks.set(t.id,t);e.leases.set(7,t.id);e.attached.add(7);
 e.authorize=async()=>{};e.allowed=()=>{};e.ensurePageEvents=async()=>{};
 e.ensureOverlay=async()=>({contextId:17});e.overlayCall=async()=>true;e.syncPreveil=async()=>{};
 e.checkedFrameTree=async(_target,_task,guard)=>{guard();return {frame:{id:'main',loaderId:state.loader,url:w.location.href}};};
 e.exposeClosedShadowRoots=async(_target,_frame,guard)=>{guard();return 17;};e.raceDialog=async(_task,_tab,work)=>work;
 e.performSettled=async(task,p)=>{
  if(p.action==='semantic_snapshot'){await state.onRead?.();return e.perform(task,p);}
  state.writes++;await state.onWrite?.();return {clicked:true,delivery:'confirmed',effect:'unverified'};
 };
 const request={taskId:'task',generation:1,tabId:7,action:'ref_click'};
 const call=w.eval(`(${semanticWorldDeclaration})`);
 return {dom,w,document:w.document,e,t,state,calls,request,call,close:()=>w.close()};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('S3 不开启 after 时输出与原动作/恢复回执完全一致，不追加读取',async()=>{
 const f=fixture();try{
  const result=await f.e.performRecovering(f.t,f.request);
  assert.deepEqual(result,{clicked:true,delivery:'confirmed',effect:'unverified',recovery:{triggered:false,rounds:0,locator:'original',clickMethod:'confirmed',strategies:[]}});
  assert.equal(f.state.writes,1);assert.equal(f.calls.length,0);
 }finally{f.close();}
});
test('S3 开启 after 返回限定根/模式/预算的实际语义快照，密码值不回显',async()=>{
 const f=fixture('<main id="result"><button aria-label="密码值 SECRET_PASSWORD">结果</button><input type="password" value="SECRET_PASSWORD"><p>正文</p></main><button>范围外</button>');try{
  const result=await f.e.performRecovering(f.t,{...f.request,after:{root:'#result',mode:'interactive',budget:1800}});
  assert.equal(result.observation.mode,'interactive');assert.equal(result.observation.budget.limit,1800);
  assert.equal(result.observation.items.length,2);assert.equal(result.observation.binding.taskId,'task');
  assert.doesNotMatch(JSON.stringify(result.observation),/SECRET_PASSWORD|范围外/);assert.equal(f.state.writes,1);
 }finally{f.close();}
});
test('S3 observation 失败只附加独立错误，不重发写动作或改变 delivery/effect',async()=>{
 const f=fixture();try{
  const result=await f.e.performRecovering(f.t,{...f.request,after:{root:'#missing'}});
  assert.match(result.observation.error,/INVALID_ROOT/);assert.equal(result.delivery,'confirmed');assert.equal(result.effect,'unverified');assert.equal(f.state.writes,1);
 }finally{f.close();}
});
test('S3 导航后重新 mint binding，同 loader 的文档替换只重读一次并撤销旧引用',async()=>{
 for(const replace of [false,true]){
  const f=fixture();try{
   const old=await f.e.perform(f.t,{...f.request,action:'semantic_snapshot',options:{budget:3000}});
   f.state.onWrite=()=>{
    if(replace){const html=f.document.createElement('html');html.innerHTML='<head></head><body><button>新文档</button></body>';f.document.documentElement.replaceWith(html);}
    else {f.state.loader='doc-2';f.document.body.innerHTML='<button>导航后</button>';}
   };
   const result=await f.e.performRecovering(f.t,{...f.request,after:{}});
   assert.equal(result.observation.kind,'full');assert.notEqual(result.observation.binding.leaseId,old.binding.leaseId);
   assert.equal(result.observation.binding.documentId,replace?'doc-1':'doc-2');assert.equal(f.state.writes,1);
   assert.throws(()=>f.call('confirm_ref',{binding:old.binding,snapshotId:old.snapshotId,ref:old.items[0].ref}),/BINDING_MISMATCH/);
  }finally{f.close();}
 }
});
test('S3 回读前暂停、撤权、租约转移或模式变更均停止读取，不影响已派发证据',async()=>{
 for(const change of [f=>f.t.paused=true,f=>f.t.revoked=true,f=>f.e.leases.set(7,'peer'),f=>f.t.policy.modeGeneration++]){
  const f=fixture();try{
   f.state.onWrite=()=>change(f);const result=await f.e.performRecovering(f.t,{...f.request,after:{}});
   assert.ok(result.observation.error);assert.equal(result.delivery,'confirmed');assert.equal(f.calls.length,0);assert.equal(f.state.writes,1);
  }finally{f.close();}
 }
});
test('S3 参数越界在写入前拒绝，读动作不能借 after 开写动作入口',async()=>{
 for(const after of [true,[],{budget:511},{budget:6001},{mode:'all'},{root:''},{query:'wide'},{baselineId:'old'}]){
  const f=fixture();try{
   await assert.rejects(f.e.performRecovering(f.t,{...f.request,after}),error=>error.preDispatch===true&&error.message==='INVALID_OPTIONS');assert.equal(f.state.writes,0);
  }finally{f.close();}
 }
 assert.throws(()=>actionObservationOptions({action:'semantic_snapshot',after:{}}),/INVALID_OPTIONS/);
});
test('S3 未知送达只执行一次写入，并复用恢复 observation',async()=>{
 const f=fixture();try{
  const perform=f.e.performSettled;
  f.e.performSettled=async(t,p)=>p.action==='semantic_snapshot'?perform(t,p):(f.state.writes++,{delivery:'unconfirmed',outcomeUnknown:true});
  const result=await f.e.performRecovering(f.t,{...f.request,after:{root:'#result'}});
  assert.equal(result.outcomeUnknown,true);assert.equal(result.observation,result.recovery.observation);assert.equal(f.state.writes,1);
 }finally{f.close();}
});
test('S3 回读超时丢弃迟到结果，不派发第二次写入',async context=>{
 const f=fixture();context.mock.timers.enable({apis:['setTimeout']});try{
  let release,started;const ready=new Promise(resolve=>{started=resolve;});
  f.state.onRead=()=>{started();return new Promise(resolve=>{release=resolve;});};
  const pending=f.e.performRecovering(f.t,{...f.request,after:{}});await ready;context.mock.timers.tick(5000);
  const result=await pending;assert.equal(result.observation.error,'OBSERVATION_TIMEOUT');assert.equal(f.state.writes,1);
  release();await Promise.resolve();assert.equal(f.calls.length,0);
 }finally{context.mock.timers.reset();f.close();}
});

test('S4 contenteditable 使用聚焦/全选/受控 insertText 和目标回读，禁止 textContent 写入',async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector('div');
  const getter=Object.getOwnPropertyDescriptor(f.w.Node.prototype,'textContent').get;
  Object.defineProperty(node,'textContent',{get(){return getter.call(this);},set(){throw Error('禁止 DOM 替代编辑输入');}});
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'真实编辑文本'});
  assert.equal(result.verified,true);assert.equal(result.delivery,'confirmed');assert.equal(node.textContent,'真实编辑文本');
  assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);assert.equal(f.document.activeElement,node);
  assert.doesNotMatch(JSON.stringify(result),/真实编辑文本/);assert.ok(!calls.some(call=>call.method==='Input.dispatchKeyEvent'));
 }finally{f.close();}
});
test('S4 编辑器拒绝输入时只返回 unconfirmed/outcomeUnknown，不回退或重写',async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding});
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'要求的新正文'},{onInsert:()=>({})});
  assert.equal(result.delivery,'unconfirmed');assert.equal(result.outcomeUnknown,true);assert.equal(result.verified,false);
  assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);assert.equal(f.document.querySelector('div').textContent,'旧正文');
 }finally{f.close();}
});
test('S4 输入前焦点变化拒绝派发，部分送达后错误不得重试',async()=>{
 for(const phase of ['focus','partial']){
  const f=fixture('<div contenteditable aria-label="正文">旧正文</div><input aria-label="其他">');try{
   const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),payload={binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'新正文'};let writes=0;
   if(phase==='focus')await assert.rejects(fillThroughInput(f,payload,{onCommand:(method,params)=>{if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='check')f.document.querySelector('input').focus();},onInsert:()=>{writes++;}}),/PRESS_TARGET_CHANGED/);
   else{
    const {result}=await fillThroughInput(f,payload,{onInsert:()=>{writes++;throw Error('input transport lost');}});assert.equal(result.delivery,'unconfirmed');assert.equal(result.outcomeUnknown,true);
   }
   assert.equal(writes,phase==='focus'?0:1);
  }finally{f.close();}
 }
});
test('S4 input/textarea 保持 prototype setter 和 input/change 事件，回执不变',()=>{
 for(const tag of ['input','textarea']){
  const f=fixture(`<${tag} aria-label="普通字段"></${tag}>`);try{
   const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector(tag),events=[];
   for(const type of ['input','change'])node.addEventListener(type,()=>events.push(type));
   Object.defineProperty(node,'value',{get(){return Object.getOwnPropertyDescriptor((tag==='input'?f.w.HTMLInputElement:f.w.HTMLTextAreaElement).prototype,'value').get.call(this);},set(){throw Error('must use prototype setter');}});
   const result=f.call('ref_fill',{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'普通值'});
   assert.deepEqual(plain(result),{filled:true,verified:true,kind:'dom-synthetic'});assert.deepEqual(events,['input','change']);assert.equal(node.value,'普通值');
  }finally{f.close();}
 }
});
test('S4 全选规整到内部首尾文本节点时允许一次真实输入',async()=>{
 const f=fixture('<div contenteditable aria-label="正文"><p><strong>旧内容一</strong></p><p>旧内容二</p></div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector('div');
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'新内容 😀'},{onCommand:(method,params)=>{
   if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='check'){
    const range=f.document.createRange(),last=node.lastChild.firstChild;range.setStart(node.querySelector('strong').firstChild,0);range.setEnd(last,last.length);
    const selection=f.document.getSelection();selection.removeAllRanges();selection.addRange(range);
   }
  }});
  assert.equal(result.verified,true);assert.equal(node.textContent,'新内容 😀');assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);
 }finally{f.close();}
});
test('S4 内部选区漏选开头或结尾文本时仍拒绝派发',async()=>{
 for(const partial of ['start','end']){
  const f=fixture('<div contenteditable aria-label="正文"><p>旧内容一</p><p>旧内容二</p></div>');try{
   const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector('div');let writes=0;
   await assert.rejects(fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'新正文'},{onCommand:(method,params)=>{
    if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='check'){
     const range=f.document.createRange(),last=node.lastChild.firstChild;range.setStart(node.firstChild.firstChild,partial==='start'?1:0);range.setEnd(last,last.length-(partial==='end'?1:0));
     const selection=f.document.getSelection();selection.removeAllRanges();selection.addRange(range);
    }
   },onInsert:()=>{writes++;}}),/PRESS_TARGET_CHANGED/);
   assert.equal(writes,0);assert.equal(node.textContent,'旧内容一旧内容二');
  }finally{f.close();}
 }
});
test('S4 异步提交 DOM 超过原回读窗口后仍能确认，不重发输入',async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');let timer;try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding});let reads=0;
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'异步正文 😀'},{onCommand:(method,params)=>{
   if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='read')reads++;
  },onInsert:text=>{
   timer=setTimeout(()=>{const range=f.document.getSelection().getRangeAt(0);range.deleteContents();range.insertNode(f.document.createTextNode(text));},420);
   return {};
  }});
  assert.equal(result.delivery,'confirmed');assert.equal(result.verified,true);assert.ok(reads>2);
  assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);assert.equal(f.document.querySelector('div').textContent,'异步正文 😀');
 }finally{clearTimeout(timer);f.close();}
});
test('S4 两次匹配之间文本变化会重新累计连续核对，不提前确认',async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding});let reads=0;
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'稳定正文'},{onCommand:(method,params)=>{
   if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='read'){
    reads++;if(reads===2||reads===3)f.document.querySelector('div').replaceChildren(f.document.createTextNode(reads===2?'暂时回滚':'稳定正文'));
   }
  }});
  assert.equal(result.verified,true);assert.equal(result.delivery,'confirmed');assert.equal(reads,4);assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);
 }finally{f.close();}
});
test('S4 回读失联也在截止点返回未知送达，不再输入',{timeout:3000},async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding});
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:'新正文'},{onCommand:(method,params)=>{
   if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='read')return new Promise(()=>{});
  }});
  assert.equal(result.delivery,'unconfirmed');assert.equal(result.verified,false);assert.equal(result.outcomeUnknown,true);
  assert.equal(calls.filter(call=>call.method==='Input.insertText').length,1);
  assert.equal(calls.filter(call=>call.method==='Runtime.callFunctionOn'&&call.params.arguments?.[0]?.value==='read').length,1);
 }finally{f.close();}
});
test('S4 注入压缩保留字面量、模板、正则、相邻运算符与 ASI；主声明保持 76 KB 门禁',()=>{
 const source="function(){const x='a  b',y=`c  d ${1+2}`;let n=2;const r=/a +b/;n + +n;return [x,y,n,r.source]}";
 const dom=new JSDOM('',{runScripts:'outside-only'});try{
 const compact=compactSemanticSource(source);assert.deepEqual(plain(dom.window.eval(`(${compact})`)()),plain(dom.window.eval(`(${source})`)()));
 assert.equal(dom.window.eval(`(${compactSemanticSource('function(){return\n{value:1}}')})`)(),undefined);
 }finally{dom.window.close();}
 assert.ok(Buffer.byteLength(semanticWorldDeclaration)<=76000);
});

test('S4 空文本通过真实 Backspace 清空选区，不写 textContent 或自动提交',async()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding});
  const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:''});
  assert.equal(result.verified,true);assert.equal(f.document.querySelector('div').textContent,'');
  assert.deepEqual(calls.filter(call=>call.method==='Input.dispatchKeyEvent').map(call=>call.params.type),['keyDown','keyUp']);
  assert.equal(calls.filter(call=>call.method==='Input.insertText').length,0);
 }finally{f.close();}
});

test('S4 清空后保留空段落时，换行或空白回读仍确认成功',async()=>{
 for(const value of ['\n',' \t\r\n']){
  const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
   const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector('div');
   // 中文注释：jsdom 不计算 innerText，显式模拟浏览器空段落的渲染回读。
   Object.defineProperty(node,'innerText',{get:()=>node.querySelector('p > br')?value:node.textContent});
   const {result,calls}=await fillThroughInput(f,{binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref,text:''},{onCommand:(method,params)=>{
    if(method==='Input.dispatchKeyEvent'&&params.type==='keyUp')node.innerHTML='<p><br></p>';
   }});
   assert.equal(node.innerHTML,'<p><br></p>');assert.equal(node.textContent,'');
   assert.deepEqual(plain(result),{filled:true,verified:true,kind:'trusted-input',delivery:'confirmed'});
   assert.deepEqual(calls.filter(call=>call.method==='Input.dispatchKeyEvent').map(call=>call.params.type),['keyDown','keyUp']);
   assert.equal(calls.filter(call=>call.method==='Input.insertText').length,0);
  }finally{f.close();}
 }
});
test('S4 非空目标只规范 CRLF，额外换行或空白仍不一致，清空不能接受正文',()=>{
 const f=fixture('<div contenteditable aria-label="正文">旧正文</div>');try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},snap=f.call('semantic_snapshot',{binding}),node=f.document.querySelector('div');
  const payload={binding,snapshotId:snap.snapshotId,ref:snap.items[0].ref},edit=f.w.eval(`(${editableInputTarget.toString()})`);let value;
  Object.defineProperty(node,'innerText',{get:()=>value});edit('prepare',payload);
  for(const [text,readBack,verified] of [['abc','abc',true],['abc','abc\n\n',false],['abc','abc ',false],['a\nb','a\r\nb',true],['a\r\nb','a\nb',true],[' ','\n',false],['','abc',false]]){
   value=readBack;
   assert.deepEqual(plain(edit('read',{...payload,text})),{filled:verified,verified,kind:'trusted-input',delivery:verified?'confirmed':'unconfirmed',...(verified?{}:{outcomeUnknown:true})},JSON.stringify({text,readBack}));
  }
 }finally{f.close();}
});

test('S1 同版本旧语义实例缺少共用可见性函数时重新安装并撤销旧引用',()=>{
 const f=fixture();try{
  const binding={taskId:'task',documentId:'doc',leaseId:'lease'},old=f.call('semantic_snapshot',{binding}),prior=f.w.__fastNativeSemanticsV2.semantics;
  prior.interactionVisibility=undefined;
  const next=f.call('semantic_snapshot',{binding});
  assert.notEqual(next.snapshotId,old.snapshotId);assert.equal(prior.stats().activeRefs,0);
  assert.equal(typeof f.w.__fastNativeSemanticsV2.semantics.interactionVisibility,'function');
 }finally{f.close();}
});
