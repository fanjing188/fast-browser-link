import {AnnotationLayer} from './copilot-annotations.mjs';
import {BRAND_CSS,createBrandMark} from './brand.mjs';
import {SelectionPopup} from './copilot-selection.mjs';
import {captureTables} from './copilot-tables.mjs';
import {ordinaryPage,pageSnapshot,describeEvent,stableSnapshots,tableSummary,pageIdentity} from './copilot-observation.mjs';
let active=false;
export async function start(){
 if(active||!ordinaryPage(location.href,document.contentType))return;
 const response=await chrome.runtime.sendMessage({type:'copilot.collector_state'}).catch(()=>null);
 if(!response?.result?.enabled)return;
 active=true;
 let lastTable='',last='',previousURL=location.href,drag=null,moved=false,stopped=false;
 const abort=new AbortController(),signal=abort.signal;
 const language=chrome.i18n?.getUILanguage?.()||navigator.language||'zh';
 const selection=new SelectionPopup(document,{language,signal,request:async(command,params)=>{const response=await chrome.runtime.sendMessage({type:'copilot.selection',command,params});if(response?.error)throw Error(response.error);return response?.result||{};},related:()=>{try{const tables=JSON.parse(lastTable).tables;return [...new Set(tables.flatMap(table=>{const col=table.headers.findIndex(name=>/keyword|关键词|^词$/i.test(name));return col<0?[]:table.rows.map(row=>row[col]?.text).filter(Boolean);} ))].slice(0,20);}catch{return [];}}});
 selection.setEnabled(response.result.selection_popup!==false);
 const annotations=new AnnotationLayer(document,{language,enabled:response.result.page_annotations!==false,density:response.result.annotation_density||'compact',profiles:response.result.annotation_profiles||[],request:async(command,params)=>{const response=await chrome.runtime.sendMessage(command==='lookup'?{type:'copilot.annotation_lookup',params}:{type:'copilot.selection',command,params});if(response?.error)throw Error(response.error);return response?.result||{};}});
 const host=document.createElement('div');host.setAttribute('data-fast-automation-overlay','copilot');
 const shadow=host.attachShadow({mode:'closed'});
 const style=document.createElement('style');style.textContent=BRAND_CSS+':host{position:fixed;right:20px;bottom:24px;z-index:2147483647;font:14px/1.5 system-ui;color:var(--brand-ink)}button{font:inherit;cursor:pointer;min-height:40px;border:1px solid var(--brand-line);background:var(--brand-surface);color:var(--brand-ink);border-radius:var(--brand-control-radius);padding:8px 12px}button:focus-visible{outline:3px solid var(--brand-primary);outline-offset:2px}#ball{background:var(--brand-primary);color:var(--brand-on-primary);touch-action:none;border-radius:50%;width:52px;height:52px;padding:0;border:1px solid var(--brand-line)}#ball{position:relative;display:grid;place-items:center}#ball svg{width:30px;height:30px}#badge{position:absolute;right:-4px;top:-4px;background:var(--brand-primary);color:var(--brand-on-primary);font-size:11px;padding:0 5px;border-radius:var(--brand-radius);min-width:18px}.pulse{animation:pulse .7s ease-out 2}@keyframes pulse{50%{transform:scale(1.05)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}#mini{width:270px;max-height:360px;overflow:auto;background:var(--brand-surface);padding:16px;border:1px solid var(--brand-line);border-radius:var(--brand-radius);margin-bottom:8px}p{margin:8px 0}';
 const ball=document.createElement('button');ball.id='ball';ball.append(createBrandMark(document));ball.setAttribute('aria-label',language.startsWith('zh')?'打开协作建议':'Open Copilot suggestions');
 const badge=document.createElement('span');badge.id='badge';badge.hidden=true;ball.append(badge);
 const mini=document.createElement('section');mini.id='mini';mini.hidden=true;
 const position=response.result.position;
 if(position){host.style.right='auto';host.style.bottom='auto';host.style.left=`${Math.min(window.innerWidth-60,position.x*window.innerWidth)}px`;host.style.top=`${Math.min(window.innerHeight-60,position.y*window.innerHeight)}px`;}
 const hide=document.createElement('button');hide.textContent=language.startsWith('zh')?'隐藏悬浮球':'Hide floating button';hide.onclick=()=>{host.hidden=true;void chrome.runtime.sendMessage({type:'copilot.hide_ball'});};
 shadow.append(style,mini,ball);document.documentElement.append(host);host.hidden=!response.result.show_ball;
 const stability=stableSnapshots(description=>snapshot(description));
 function schedule(description){stability.change(description);}
 async function snapshot(description){
  if(stopped)return;
  try {
   const state=await chrome.runtime.sendMessage({type:'copilot.collector_state'});
   if(!state?.result?.enabled){stop();return;}
   const captured=captureTables(document,{minimumRows:3,...state.result.table_hints}),tableKey=JSON.stringify(captured);
   if(tableKey!==lastTable){const hadTables=lastTable&&JSON.parse(lastTable).tables.length;lastTable=tableKey;if(captured.tables.length||hadTables)await chrome.runtime.sendMessage({type:'copilot.tables',capture:captured});}
   const page=pageSnapshot(document,location.href);if(!page)return;
   if(captured.tables.length)page.items=tableSummary(captured);
   const serialized=pageIdentity(page);
   if((!description||description==='页面显著变化'||description==='导航到新页面')&&serialized===last)return;
   last=serialized;
   await chrome.runtime.sendMessage({type:'copilot.observe',page,description:description||'页面显著变化'});
  }catch{/* 中文注释：页面卸载或扩展重载时停止传输，不读取备用 DOM。 */}
 }
 function handle(event){if(!event.isTrusted)return;if(event.type==='selectionchange'&&(document.getSelection()?.toString().length||0)>300)return;const step=describeEvent(event,document);if(step)schedule(step);}
 for(const type of ['click','change','selectionchange','copy'])document.addEventListener(type,handle,{capture:true,signal});
 window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const max=document.documentElement.scrollHeight-window.innerHeight;schedule(`滚动到 页面 ${Math.round(max>0?window.scrollY/max*100:0)}%`);},500);},{passive:true,signal});
 let scrollTimer;
 const observer=new MutationObserver(records=>{if(records.some(r=>!host.contains(r.target)&&r.target!==host&&!r.target.closest?.('[data-fast-automation-overlay]')))schedule();});
 observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-expanded','aria-selected','hidden','class']});
 let dwellTimer;
 function dwellOnce(){clearTimeout(dwellTimer);dwellTimer=setTimeout(()=>{if(document.visibilityState==='visible')schedule('停留 3s');},3000);}
 dwellOnce();
 const dwell=setInterval(()=>{if(location.href!==previousURL){previousURL=location.href;schedule('导航到新页面');dwellOnce();}},1000);
 ball.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,left:host.getBoundingClientRect().left,top:host.getBoundingClientRect().top};moved=false;ball.setPointerCapture(event.pointerId);});
 ball.addEventListener('pointermove',event=>{if(!drag)return;if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>5)moved=true;if(moved){host.style.right='auto';host.style.bottom='auto';host.style.left=`${Math.min(window.innerWidth-60,Math.max(0,drag.left+event.clientX-drag.x))}px`;host.style.top=`${Math.min(window.innerHeight-60,Math.max(0,drag.top+event.clientY-drag.y))}px`;}});
 let longPress;
 ball.addEventListener('contextmenu',event=>{event.preventDefault();hide.click();});
 ball.addEventListener('pointerdown',()=>{longPress=setTimeout(()=>{moved=true;hide.click();},650);});
 ball.addEventListener('pointermove',()=>{if(moved)clearTimeout(longPress);});
 ball.addEventListener('pointerup',()=>{clearTimeout(longPress);if(moved){const rect=host.getBoundingClientRect();void chrome.runtime.sendMessage({type:'copilot.position',x:rect.left/window.innerWidth,y:rect.top/window.innerHeight});}drag=null;});
 ball.addEventListener('pointercancel',()=>{clearTimeout(longPress);drag=null;});
 ball.addEventListener('click',async event=>{
  if(moved||host.hidden||!event.isTrusted)return;
  const opened=await chrome.runtime.sendMessage({type:'copilot.open'}).catch(()=>null);
  if(opened?.result?.opened){mini.hidden=true;return;}
  const panel=await chrome.runtime.sendMessage({type:'copilot.panel_status'}).catch(()=>null);
  if(panel?.result?.open){mini.hidden=true;return;}
  mini.hidden=!mini.hidden;if(mini.hidden)return;
  mini.replaceChildren();const title=document.createElement('strong');title.textContent=language.startsWith('zh')?'当前建议':'Suggestions';mini.append(title);
  const state=await chrome.runtime.sendMessage({type:'copilot.mini'}).catch(()=>null);
  const rows=state?.result?.suggestions||[];
  for(const row of rows){const p=document.createElement('p');p.textContent=row.title;mini.append(p);}
  if(!rows.length){const p=document.createElement('p');p.textContent=language.startsWith('zh')?'暂时没有新建议；请从扩展菜单打开协作侧栏。':'No new suggestions. Open Copilot from the extension menu.';mini.append(p);}
  mini.append(hide);
 });
 const listener=message=>{
  if(message.type==='copilot.annotation_settings'){annotations.configure({enabled:message.enabled,density:message.density,profiles:message.profiles||[]});return;}
  if(message.type==='copilot.annotation_refresh'){void annotations.refresh(true);return;}
  if(message.type==='copilot.selection_settings'){selection.setEnabled(message.enabled);return;}
  if(message.type==='copilot.selection_suggestions'){selection.setSuggestions(message.suggestions||[]);return;}
  if(message.type==='copilot.navigation'){schedule('导航到新页面');return;}
  if(message.type==='copilot.teardown'){stop();return;}
  if(message.type==='copilot.badge'){if(message.panel_open)mini.hidden=true;badge.hidden=!message.count&&!message.running&&!message.tables&&!message.suggestions;badge.textContent=message.running||message.count?`${message.running||0} / ${message.count||0}`:message.suggestions?(language.startsWith('zh')?'建议 ':'Suggestions ')+message.suggestions:message.tables?(language.startsWith('zh')?'表 ':'Tables ')+message.tables:'';if(message.count||message.suggestions){ball.classList.remove('pulse');requestAnimationFrame(()=>ball.classList.add('pulse'));}ball.title=language.startsWith('zh')?`进行中 ${message.running||0} / 新结果 ${message.count} · 表格 ${message.tables||0}`:`Running ${message.running||0} / New results ${message.count||0} · Tables ${message.tables||0}`;ball.setAttribute('aria-label',ball.title);}
  if(message.type==='copilot.visibility')host.hidden=!message.visible;
 };
 chrome.runtime.onMessage.addListener(listener);
 function stop(){if(stopped)return;stopped=true;active=false;annotations.destroy();abort.abort();observer.disconnect();stability.stop();clearTimeout(longPress);clearTimeout(scrollTimer);clearInterval(dwell);clearTimeout(dwellTimer);chrome.runtime.onMessage.removeListener(listener);host.remove();}
 window.addEventListener('pagehide',stop,{once:true,signal});
 schedule('打开页面');
}
