import {ordinaryPage,appendStep,safeURL} from './copilot-observation.mjs';
export class CopilotBackground {
 constructor(api,request){
  this.api=api;this.request=request;this.enabled=false;this.showBall=true;this.trace=[];this.pages=new Map();this.rows=new Map();this.unread=new Set();this.queue=Promise.resolve();
 }
 panel(sender){return sender?.id===this.api.runtime.id&&sender.url===this.api.runtime.getURL('copilot-panel.html');}
 collector(sender){return sender?.id===this.api.runtime.id&&sender.frameId===0&&Number.isInteger(sender.tab?.id)&&ordinaryPage(sender.url||'');}
 async synchronize(){const state=await this.request('state',{});this.trace=(await this.api.storage.session.get('copilotTrace')).copilotTrace||[];this.rows=new Map(state.suggestions.map(row=>[row.id,row]));await this.settings(state);return state;}
 async settings(state){
  this.enabled=state.enabled===true;this.showBall=state.show_ball!==false;
  const scripts=await this.api.scripting.getRegisteredContentScripts({ids:['copilot']});
  if(this.enabled&&!scripts.length)await this.api.scripting.registerContentScripts([{id:'copilot',matches:['http://*/*','https://*/*'],js:['copilot-entry.js'],runAt:'document_idle',allFrames:false,persistAcrossSessions:false}]);
  if(!this.enabled&&scripts.length)await this.api.scripting.unregisterContentScripts({ids:['copilot']});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(tab=>ordinaryPage(tab.url||'')).map(async tab=>{
   if(!this.enabled){await this.api.tabs.sendMessage(tab.id,{type:'copilot.teardown'}).catch(()=>{});return;}
   try{await this.api.scripting.executeScript({target:{tabId:tab.id},files:['copilot-entry.js']});await this.api.tabs.sendMessage(tab.id,{type:'copilot.visibility',visible:this.showBall});}catch{/* 中文注释：受限页保持不采集，不通过调试器绕过。 */}
  }));
  if(!this.enabled){this.trace=[];this.pages.clear();await this.api.storage.session.remove('copilotTrace');}
 }
 async observation(sender,page,description){
  if(!this.enabled||!this.collector(sender)||!page||!ordinaryPage(page.url)||typeof description!=='string')throw Error('采集已暂停或页面不可用');
  if(safeURL(sender.url)!==page.url)throw Error('页面已导航，请重新采集');
  if(new TextEncoder().encode(JSON.stringify(page)).length>6144)throw Error('页面快照超出预算');
  this.pages.set(sender.tab.id,page);
  this.trace=appendStep(this.trace,description,sender.tab.id,page);
  await this.api.storage.session.set({copilotTrace:this.trace});
  return this.request('observe',{trace:this.trace,page});
 }
 tabEvent(tabId,description,tab){
  if(!this.enabled)return;
  this.queue=this.queue.catch(()=>{}).then(async()=>{
   const page=this.pages.get(tabId)||(ordinaryPage(tab?.url||'')?{url:safeURL(tab.url),title:tab.title||'',items:[]}:null);
   if(!page)return;
   this.trace=appendStep(this.trace,description,tabId,page);
   await this.api.storage.session.set({copilotTrace:this.trace});
   await this.request('observe',{trace:this.trace,page});
   if(description==='关闭标签页')this.pages.delete(tabId);
  });
 }
 async notification(event){
  if(event.type==='add'||event.type==='update'){this.rows.set(event.suggestion.id,event.suggestion);if(event.type==='add')this.unread.add(event.suggestion.id);}
  if(event.type==='remove'){this.rows.delete(event.id);this.unread.delete(event.id);}
  if(event.type==='settings')await this.settings({...event,enabled:event.enabled??this.enabled,show_ball:event.show_ball??this.showBall});
  void this.api.runtime.sendMessage({type:'copilot.changed',event}).catch(()=>{});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(t=>ordinaryPage(t.url||'')).map(t=>this.api.tabs.sendMessage(t.id,{type:'copilot.badge',count:this.unread.size}).catch(()=>{})));
 }
 handle(message,sender,respond){
  if(!message?.type?.startsWith('copilot.')||message.type==='copilot.changed')return false;
  const content=this.collector(sender),panel=this.panel(sender);
  const popup=sender?.id===this.api.runtime.id&&sender.url===this.api.runtime.getURL('popup.html');
  if(message.type==='copilot.open'&&(content&&this.enabled||panel||popup)){
   // 中文注释：在当前点击消息栈立即调用，不能先 await 存储或 Native RPC 消耗用户手势。
   try{Promise.resolve(this.api.sidePanel.open({windowId:sender.tab?.windowId})).then(()=>respond({result:{opened:true}}),()=>respond({result:{opened:false}}));}catch{respond({result:{opened:false}});}return true;
  }
  let work;
  if(content&&message.type==='copilot.collector_state')work=Promise.resolve({enabled:this.enabled,show_ball:this.showBall});
  else if(content&&this.enabled&&message.type==='copilot.observe'){
   this.queue=this.queue.catch(()=>{}).then(()=>this.observation(sender,message.page,message.description));work=this.queue;
  }else if(content&&this.enabled&&message.type==='copilot.mini')work=Promise.resolve({suggestions:[...this.rows.values()].filter(row=>row.status==='pending')});
  else if(content&&this.enabled&&message.type==='copilot.hide_ball')work=this.request('settings',{show_ball:false}).then(state=>this.settings(state));
  else if(panel&&message.type==='copilot.command'&&['state','settings','execute','ignore','stop'].includes(message.command)){
   work=this.request(message.command,message.params||{}).then(async state=>{
    if(message.command==='settings')await this.settings(state);
    if(state.suggestions){this.rows=new Map(state.suggestions.map(row=>[row.id,row]));this.unread.clear();}
    return state;
   });
  }else return false;
  Promise.resolve(work).then(result=>respond({result}),()=>respond({error:'协作连接或请求失败，请检查本地配置并刷新侧栏。'}));return true;
 }
}
