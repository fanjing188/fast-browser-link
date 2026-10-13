// 中文注释：效果探针独立于冷启动语义声明，只存布尔状态，不保存页面正文、输入值或网络地址。
export function effectProbe(op,token){
 const key='__fastInputEffect',prior=globalThis[key];
 // 中文注释：迟到清理只能收回自己的探针，不能卸载下一动作的观察器。
 if(op==='clear'){if(prior?.token===token){prior.observer.disconnect();document.removeEventListener('submit',prior.submit,true);delete globalThis[key];}return true;}
 const focus=()=>{let node=document.activeElement;for(let depth=0;depth<16;depth++){const shadow=node?.shadowRoot||globalThis.__fastClosedShadowRoots?.get(node);if(!shadow?.activeElement)break;node=shadow.activeElement;}return node;};
 if(op==='read')return Boolean(prior?.token===token&&(prior.changed||prior.submitted||prior.url!==location.href||prior.focus!==focus()));
 if(prior){prior.observer.disconnect();document.removeEventListener('submit',prior.submit,true);}
 const own=node=>(node?.nodeType===1?node:node?.parentElement)?.closest?.('[data-fast-automation-overlay],[data-fast-preveil]');
 const state={token,changed:false,submitted:false,url:location.href,focus:focus()};
 state.submit=()=>{state.submitted=true};
 state.observer=new MutationObserver(rows=>{
  if(rows.some(row=>!own(row.target)&&(row.type!=='childList'||[...row.addedNodes,...row.removedNodes].some(node=>!own(node)))))state.changed=true;
 });
 // 中文注释：Shadow DOM 内的变化也计入；只观察已由当前隔离世界取得的根。
 const options={subtree:true,childList:true,attributes:true,characterData:true};
 const roots=[document];let visited=0;
 for(const root of roots){
  state.observer.observe(root,options);
  for(const host of root.querySelectorAll('*')){
   const shadow=host.shadowRoot||globalThis.__fastClosedShadowRoots?.get(host);
   if(shadow&&!own(host)&&visited++<128)roots.push(shadow);
  }
 }
 document.addEventListener('submit',state.submit,true);globalThis[key]=state;return true;
}
export const NO_EFFECT_HINT='输入已派发但未观察到效果；请读取目标页核对，检查按钮状态或改用页面支持的操作，不要反复重试。';
export async function observeInputEffect({api,target,contextId,frameId,guard,work,timeoutMs=1500,externalEffect=null}){
 const token=crypto.randomUUID();
 const probe=async op=>{
  const reply=await api.debugger.sendCommand(target,'Runtime.callFunctionOn',{executionContextId:contextId,functionDeclaration:effectProbe.toString(),arguments:[{value:op},{value:token}],returnByValue:true});
  if(reply.exceptionDetails)throw Error('INPUT_EFFECT_PROBE_FAILED');
  return reply.result?.value;
 };
 let changed=false,dispatched=false,navigation=null;
 const markDispatched=()=>{if(!dispatched){dispatched=true;navigation=null;}};
 const event=(source,method,params={})=>{
  if(source?.tabId!==target.tabId||(source.sessionId||null)!==(target.sessionId||null))return;
  if(['Network.requestWillBeSent','Page.frameNavigated','Page.navigatedWithinDocument','Page.javascriptDialogOpening'].includes(method))changed=true;
  if(!dispatched)return;
  if(method==='Page.frameNavigated'&&!params.frame?.parentId&&(!frameId||params.frame?.id===frameId))navigation={kind:'document'};
  if(method==='Page.navigatedWithinDocument'&&(!frameId||params.frameId===frameId))navigation={kind:'same_document'};
  if(navigation){try{const url=new URL(params.frame?.url||params.url);if(['http:','https:'].includes(url.protocol))navigation.origin=url.origin;}catch{}}
 };
 await api.debugger.sendCommand(target,'Network.enable');guard();
 // 中文注释：记录点击前网址；跨站跳转会换进程，导航事件可能收不到，靠网址变化确认。
 const tabUrl=async()=>{try{const tab=await api.tabs?.get?.(target.tabId);return tab?.pendingUrl||tab?.url||null;}catch{return null;}};
 const startUrl=frameId?null:await tabUrl();
 api.debugger.onEvent.addListener(event);
 let armed=false;
 try{
  await probe('arm');armed=true;guard();
  let result;
  try{result=await work(markDispatched);guard();}
  catch(error){
   // 中文注释：点击后页面被替换（上下文销毁）且网址已变，按点击成功并已跳转返回；绝不重新点击。
   if(!navigation&&error?.preDispatch!==true&&startUrl&&/Execution context was destroyed|Inspected target navigated|Cannot find context|Frame with the given id was not found|No frame for given id|PAGE_NOT_READY|navigation timeout/i.test(String(error?.message||''))){
    const now=await tabUrl();
    if(now&&now!==startUrl){try{const url=new URL(now);navigation={kind:'document',...(['http:','https:'].includes(url.protocol)?{origin:url.origin}:{})};}catch{navigation={kind:'document'};}}
   }
   if(!navigation||error?.preDispatch===true)throw error;
   guard();return {clicked:true,kind:'trusted-input',delivery:'confirmed',effect:'observed',outcomeUnknown:false,navigation};
  }
  // 中文注释：填写值有独立回读；这里只观察合成点击或明确未核实的动作。
  const requires=result?.effect==='unverified'||(String(result?.kind||'').includes('synthetic')&&result?.filled!==true);
  if(requires&&result?.verified===true)return {...result,effect:'observed'};
  if(!requires)return result;
  const deadline=Date.now()+timeoutMs;
  do{
   if(result?.dialogOpened||changed||externalEffect?.()||await probe('read')){guard();return {...result,effect:'observed',...(navigation?{navigation}:{})};}
   guard();if(Date.now()>=deadline)break;
   await new Promise(resolve=>setTimeout(resolve,60));
  }while(Date.now()<=deadline);
  // 中文注释：输入已送达但页面无可见变化（如只改脚本变量）时按成功返回并附提示，不当作错误让调用方停下；不补发。
  return {...result,effect:'unobserved',suggestion:NO_EFFECT_HINT};
 }finally{api.debugger.onEvent.removeListener(event);if(armed)await probe('clear').catch(()=>{});}
}
