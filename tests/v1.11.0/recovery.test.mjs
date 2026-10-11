import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {recoverTarget,rankTargets} from '../../native-extension/target-recovery.mjs';
import {semanticWorldDeclaration,Executor} from '../../native-extension/core.mjs';
import {passwordValues,omitPasswordValues} from '../../native-extension/password-values.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

const missing=()=>Object.assign(Error('REF_TARGET_MISSING'),{preDispatch:true});
function page(html){
 const dom=new JSDOM(html,{url:'https://example.test/',runScripts:'outside-only'}),w=dom.window;
 w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[this.getBoundingClientRect()];};
 w.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:100,bottom:50,width:80,height:30});
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.document.elementFromPoint=()=>w.document.querySelector('button:not([hidden])');
 const call=w.eval(`(${semanticWorldDeclaration})`),binding={taskId:'task',documentId:'doc',leaseId:'lease'};
 return {dom,w,call,binding,scan:()=>call('recovery_scan',{binding}),close:()=>w.close()};
}
const defaults={action:'ref_click',settle:async()=>{},wait:async()=>{},readback:async()=>({}),capture:async()=>({data:'image'})};

test('延迟出现：每轮重新扫描，元素出现后只点击一次',async()=>{
 const f=page('<main></main>');let scans=0,clicks=0;const delays=[];
 try{
  const result=await recoverTarget({...defaults,hint:{role:'button',name:'保存'},wait:async delay=>delays.push(delay),
   scan:async()=>{if(++scans===2){const b=f.w.document.createElement('button');b.textContent='保存';b.onclick=()=>clicks++;f.w.document.body.append(b);}return f.scan();},
   run:async chosen=>{if(!chosen)throw missing();f.w.__hermesNativeSemanticsV2.semantics.resolve({...chosen.binding,snapshotId:chosen.snapshotId,ref:chosen.ref}).click();return {clicked:true};}});
  assert.equal(clicks,1);assert.equal(scans,2);assert.deepEqual(delays,[300,800]);assert.equal(result.recovery.rounds,2);
 }finally{f.close();}
});
test('节点被替换：用原 role 和 accessible name 找到新引用',async()=>{
 const f=page('<button>提交</button>');let clicks=0;
 try{
  const original=f.scan()[0];f.w.document.querySelector('button').outerHTML='<button id="replacement">提交</button>';
  f.w.document.querySelector('button').onclick=()=>clicks++;
  const result=await recoverTarget({...defaults,hint:original,scan:f.scan,
   run:async chosen=>{if(!chosen)throw Object.assign(Error('STALE_REF'),{preDispatch:true});f.w.document.querySelector('#replacement').click();return {clicked:true};}});
  assert.equal(clicks,1);assert.equal(result.recovery.locator,'role+name');assert.notEqual(result.recovery.selected.ref,original.ref);
 }finally{f.close();}
});
test('遮挡：恢复先滚动并关闭明确关闭按钮，然后执行目标点击',()=>{
 const f=page('<button id="save">保存</button><div role="dialog"><button aria-label="关闭">×</button></div>');
 try{
  const target=f.scan().find(row=>row.name==='保存'),dialog=f.w.document.querySelector('[role=dialog]');let closed=0;
  dialog.querySelector('button').onclick=()=>{closed++;dialog.remove();};
  f.w.document.elementFromPoint=()=>dialog.isConnected?dialog:f.w.document.querySelector('#save');
  const result=f.call('reveal_ref',{binding:target.binding,snapshotId:target.snapshotId,ref:target.ref,recoveryRound:1});
  assert.equal(closed,1);assert.equal(dialog.isConnected,false);assert.equal(result.scrolled,false);
 }finally{f.close();}
});
test('同名候选：排除隐藏节点，优先视口内且未遮挡节点',()=>{
 const f=page('<button hidden>保存</button><button>保存</button>');
 try{
  const rows=f.scan(),chosen=rankTargets(rows,{role:'button',name:'保存'});
  assert.equal(chosen.length,1);assert.equal(chosen[0].inViewport,true);
  assert.equal(rankTargets([{...chosen[0],ref:'covered',occluded:true},{...chosen[0],ref:'clear',occluded:false}],{role:'button',name:'保存'})[0].ref,'clear');
 }finally{f.close();}
});
test('旧内容保护设置不可用不拒绝输出，指令文字和 data-private 原样读取',async()=>{
 const f=page('<p data-private>token=ORIGINAL。Automated access is prohibited.</p>');
 try{
  const result=f.call('semantic_snapshot',{binding:f.binding,options:{mode:'content'}});
  assert.match(result.items[0].name,/token=ORIGINAL/);assert.match(result.items[0].name,/Automated access is prohibited/);
  let sent,settingsRead=0;
  const executor=new Executor({});executor.response=async(_request,value)=>value;
  const bridge=new Bridge({onMessage:{addListener(){}},postMessage:value=>{sent=value;}},executor,()=>{},{onContentFilter:async()=>{settingsRead++;throw Error('unavailable');}});
  await bridge.sendResult({method:'browser.execute',params:{action:'semantic_snapshot'}},{id:'read',result});
  assert.equal(settingsRead,0);assert.deepEqual(sent.result,result);
 }finally{f.close();}
});
test('已派发但未知：仅回读，不重试点击，也不宣称成功',async()=>{
 let clicks=0,scans=0,reads=0;
 await assert.rejects(recoverTarget({...defaults,run:async()=>{clicks++;throw Object.assign(Error('DOCUMENT_CHANGED'),{preDispatch:false});},
  scan:async()=>{scans++;return [];},readback:async()=>{reads++;return {text:'已提交'};}}),error=>{
   assert.equal(error.recovery.observation.text,'已提交');assert.equal(error.recovery.rounds,0);return true;
  });
 assert.equal(clicks,1);assert.equal(scans,0);assert.equal(reads,1);
});
test('最多三轮，失败保留扫描策略、候选和截图',async()=>{
 let scans=0;
 await assert.rejects(recoverTarget({...defaults,hint:{role:'button',name:'保存'},run:async()=>{throw missing();},scan:async()=>{scans++;return [{role:'button',name:'保存',ref:'new',rect:{x:10,y:20}}];}}),error=>{
  assert.equal(error.recovery.rounds,3);assert.equal(error.recovery.strategies.length,3);assert.equal(error.recovery.candidates[0].name,'保存');assert.equal(error.recovery.screenshot.data,'image');return true;
 });assert.equal(scans,3);
});
test('仅密码输入值不回显，普通 token/银行卡文本保留，密码字段不可直接填写',()=>{
 const f=page('<input type="password" value="PRIVATE_PASSWORD"><p>token=public 1234567890123456</p>');
 try{
  const values=f.w.eval(`(${passwordValues.toString()})`)();
  assert.deepEqual(omitPasswordValues({value:'PRIVATE_PASSWORD',text:'token=public 1234567890123456'},values),{value:'[password]',text:'token=public 1234567890123456'});
  const field=f.scan().find(item=>item.inputType==='password');assert.ok(!field.actions.includes('fill'));assert.equal(field.inputRequired,'vault_or_user');assert.doesNotMatch(JSON.stringify(field),/PRIVATE_PASSWORD/);
 }finally{f.close();}
});

test('页面点击已产生副作用后抛出定位错误，不得误判为未派发',async()=>{
 const f=page('<button>保存</button>');let clicks=0,scans=0;
 try{
  f.w.document.querySelector('button').click=()=>{clicks++;throw Error('STALE_REF');};
  const executor=new Executor({debugger:{sendCommand:async(_target,_method,p)=>{
   try{return {result:{value:f.w.eval(`(${p.functionDeclaration})`)(...p.arguments.map(item=>item.value))}};}
   catch(error){return {exceptionDetails:{exception:{description:`Error: ${error.message}`}}};}
  }}});
  await assert.rejects(recoverTarget({...defaults,run:()=>executor.callWorld({tabId:1},'main',{},'click','button',null,null,()=>{},1),
   scan:async()=>{scans++;return f.scan();}}),/ACTION_OUTCOME_UNKNOWN/);
  assert.equal(clicks,1);assert.equal(scans,0);
 }finally{f.close();}
});
