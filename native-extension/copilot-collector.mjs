import {ordinaryPage,pageSnapshot,describeEvent} from './copilot-observation.mjs';
let active=false;
export async function start(){
 if(active||!ordinaryPage(location.href,document.contentType))return;
 const response=await chrome.runtime.sendMessage({type:'copilot.collector_state'}).catch(()=>null);
 if(!response?.result?.enabled)return;
 active=true;
 let timer,last='',previousURL=location.href,drag=null,moved=false,stopped=false;
 const abort=new AbortController(),signal=abort.signal;
 const host=document.createElement('div');host.setAttribute('data-fast-automation-overlay','copilot');
 const shadow=host.attachShadow({mode:'closed'});
 const style=document.createElement('style');style.textContent=':host{position:fixed;right:20px;bottom:24px;z-index:2147483647;font:14px/1.5 system-ui;color:#17251d}button{font:inherit;cursor:pointer;min-height:40px;border:1px solid #c5d3ca;background:#fff;color:#17251d;border-radius:8px;padding:8px 12px}button:focus-visible{outline:3px solid #1f754b;outline-offset:2px}#ball{background:#1f754b;color:white;touch-action:none;border-radius:50%;width:52px;height:52px;padding:0;box-shadow:0 3px 12px #0003}#mini{width:270px;max-height:360px;overflow:auto;background:#fff;padding:16px;border:1px solid #c5d3ca;border-radius:12px;margin-bottom:8px}p{margin:8px 0}';
 const ball=document.createElement('button');ball.id='ball';ball.textContent='协作';ball.setAttribute('aria-label','打开协作建议');
 const mini=document.createElement('section');mini.id='mini';mini.hidden=true;
 const hide=document.createElement('button');hide.textContent='隐藏悬浮球';hide.onclick=()=>{host.hidden=true;void chrome.runtime.sendMessage({type:'copilot.hide_ball'});};
 shadow.append(style,mini,ball);document.documentElement.append(host);host.hidden=!response.result.show_ball;
 function schedule(description){clearTimeout(timer);timer=setTimeout(()=>snapshot(description),350);}
 async function snapshot(description){
  if(stopped)return;
  try {
   const page=pageSnapshot(document,location.href);if(!page)return;
   const serialized=JSON.stringify(page);
   if(!description&&serialized===last)return;
   last=serialized;
   await chrome.runtime.sendMessage({type:'copilot.observe',page,description:description||'页面显著变化'});
  }catch{/* 中文注释：页面卸载或扩展重载时停止传输，不读取备用 DOM。 */}
 }
 function handle(event){if(!event.isTrusted)return;const step=describeEvent(event,document);if(step)void snapshot(step);}
 for(const type of ['click','change','selectionchange','copy'])document.addEventListener(type,handle,{capture:true,signal});
 window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const max=document.documentElement.scrollHeight-window.innerHeight;schedule(`滚动到 页面 ${Math.round(max>0?window.scrollY/max*100:0)}%`);},500);},{passive:true,signal});
 let scrollTimer;
 const observer=new MutationObserver(records=>{if(records.some(r=>!host.contains(r.target)&&r.target!==host))schedule();});
 observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-expanded','aria-selected','hidden','class']});
 let dwellTimer;
 function dwellOnce(){clearTimeout(dwellTimer);dwellTimer=setTimeout(()=>{if(document.visibilityState==='visible')void snapshot('停留 3s');},3000);}
 dwellOnce();
 const dwell=setInterval(()=>{if(location.href!==previousURL){previousURL=location.href;schedule('导航到新页面');dwellOnce();}},1000);
 ball.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,left:host.getBoundingClientRect().left,top:host.getBoundingClientRect().top};moved=false;ball.setPointerCapture(event.pointerId);});
 ball.addEventListener('pointermove',event=>{if(!drag)return;if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>5)moved=true;if(moved){host.style.right='auto';host.style.bottom='auto';host.style.left=`${Math.min(window.innerWidth-60,Math.max(0,drag.left+event.clientX-drag.x))}px`;host.style.top=`${Math.min(window.innerHeight-60,Math.max(0,drag.top+event.clientY-drag.y))}px`;}});
 ball.addEventListener('pointerup',()=>{drag=null;});
 ball.addEventListener('click',async event=>{
  if(moved||!event.isTrusted)return;
  const opened=await chrome.runtime.sendMessage({type:'copilot.open'}).catch(()=>null);
  if(opened?.result?.opened)return;
  mini.hidden=!mini.hidden;if(mini.hidden)return;
  mini.replaceChildren();const title=document.createElement('strong');title.textContent='当前建议';mini.append(title);
  const state=await chrome.runtime.sendMessage({type:'copilot.mini'}).catch(()=>null);
  const rows=state?.result?.suggestions||[];
  for(const row of rows){const p=document.createElement('p');p.textContent=row.title;mini.append(p);}
  if(!rows.length){const p=document.createElement('p');p.textContent='暂时没有新建议；请从扩展菜单打开协作侧栏。';mini.append(p);}
  mini.append(hide);
 });
 const listener=message=>{
  if(message.type==='copilot.teardown'){stop();return;}
  if(message.type==='copilot.badge'){ball.textContent=message.count?String(message.count):'协作';ball.setAttribute('aria-label',`协作建议 ${message.count} 条未读`);}
  if(message.type==='copilot.visibility')host.hidden=!message.visible;
 };
 chrome.runtime.onMessage.addListener(listener);
 function stop(){if(stopped)return;stopped=true;active=false;abort.abort();observer.disconnect();clearTimeout(timer);clearTimeout(scrollTimer);clearInterval(dwell);clearTimeout(dwellTimer);chrome.runtime.onMessage.removeListener(listener);host.remove();}
 window.addEventListener('pagehide',stop,{once:true,signal});
 void snapshot('打开页面');
}
