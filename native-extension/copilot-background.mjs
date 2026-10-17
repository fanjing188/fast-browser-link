import {collectToolReport} from './copilot-tool-reports.mjs';
import {collectBrowserData} from './copilot-browser-data.mjs';
import {captureTables} from './copilot-tables.mjs';
import {TableJobs} from './copilot-table-job.mjs';
import {ordinaryPage,appendStep,safeURL} from './copilot-observation.mjs';
export class CopilotBackground {
 constructor(api,request,isWorkTab=()=>false){
  this.protectedHosts=null;this.selectionSeen=new Map();this.selectionPopup=true;this.tableCaptures=new Map();this.tableTab=null;this.tableJobs=null;this.localJobs=new Map();
  this.api=api;this.request=request;this.liveWorkTab=isWorkTab;this.workspaceTabs=new Set();this.workspaceWindows=new Set();this.isWorkTab=id=>this.liveWorkTab(id)||this.workspaceTabs.has(id);this.panelPorts=new Set();this.lastNavigation=new Map();this.enabled=false;this.showBall=true;this.trace=[];this.pages=new Map();this.rows=new Map();this.unread=new Set();this.suggestionsUnread=new Set();this.queue=Promise.resolve();
 }
 panel(sender){return sender?.id===this.api.runtime.id&&(sender.url===this.api.runtime.getURL('copilot-panel.html')||sender.url?.startsWith(this.api.runtime.getURL('copilot-result.html')+'?'));}
 collector(sender){return sender?.id===this.api.runtime.id&&sender.frameId===0&&Number.isInteger(sender.tab?.id)&&ordinaryPage(sender.url||'')&&!this.owned(sender.tab);}
 attachTableAdapter(adapter){this.dataAdapter=adapter;this.tableJobs=new TableJobs({...adapter,upload:(table,format)=>this.exportTable(table,format),progress:job=>{if(job.status==='executing')void this.request('table_activity',{}).catch(()=>{});this.localJobs.set(job.id,job);void this.api.runtime.sendMessage({type:'copilot.tables_changed'}).catch(()=>{});void this.notification({type:'local_progress'});}});}
 async exportTable(table,format){
  const begin=await this.request('table_begin',{name:table.name,site:table.site,headers:table.headers});
  let chunk=[];
  for(const row of table.rows){if(new TextEncoder().encode(JSON.stringify(row)).length>200000)throw Error('单行内容超过本机分块限制');if(new TextEncoder().encode(JSON.stringify([...chunk,row])).length>200000){await this.request('table_append',{id:begin.id,rows:chunk});chunk=[];}chunk.push(row);}
  if(chunk.length)await this.request('table_append',{id:begin.id,rows:chunk});
  return this.request('table_finish',{id:begin.id,format,pages:table.pages||1,unit:table.unit||'页',partial:!!table.partial,reason:table.reason||''});
 }
 async localCommand(name,params){
  if(name==='learn_current'){
   const [tab]=await this.api.tabs.query({active:true,currentWindow:true});await this.refreshOwnership();if(!tab||this.owned(tab)||!ordinaryPage(tab.url))throw Error('unsupported tool page');const [result]=await this.api.scripting.executeScript({target:{tabId:tab.id},func:captureTables});return this.request('tool_learn_context',{url:tab.url,title:result.result.title||tab.title||'',tables:result.result.tables.slice(0,3).map(table=>({headers:table.headers,rows:table.rows.length}))});
  }
  if(name==='recognize_tables'){
   const tabs=await this.api.tabs.query({active:true,currentWindow:true}),tab=tabs[0];await this.refreshOwnership();
   if(!tab||this.owned(tab)||!ordinaryPage(tab.url||''))throw Error('此页不支持表格读取');
   const captured=await this.api.scripting.executeScript({target:{tabId:tab.id},func:captureTables});
   this.tableCaptures.set(tab.id,{...captured[0].result,incognito:!!tab.incognito});this.tableTab=tab.id;void this.notification({type:'table_detected'});
  }
  if(name==='open_result'){await this.request('result',{id:params.id});await this.api.tabs.create({url:this.api.runtime.getURL('copilot-result.html')+'?id='+encodeURIComponent(params.id),active:false});return {};}
  if(name==='table_state'||name==='recognize_tables')return {capture:this.tableCaptures.get(this.tableTab)||null,jobs:[...this.localJobs.values()]};
  const capture=this.tableCaptures.get(this.tableTab),table=capture?.tables.find(item=>item.id===params.id);
  if(name==='stop_table'){this.tableJobs?.stop(params.id);return {};}
  if(!table)throw Error('表格已变化，请重新识别');
  if(name==='save_table')return this.exportTable({name:table.name,site:new URL(capture.url).hostname,headers:table.headers,rows:table.rows,pages:1,partial:table.incomplete,reason:table.incomplete?'只保存当前可见页，可能不完整':''},params.format);
  if(name==='collect_table'){
   if(!this.tableJobs)throw Error('工作区尚未连接');
   const state=await this.request('state',{}),id=crypto.randomUUID();
   void this.tableJobs.run(id,capture,table,state.table_config,params.confirmed===true,Number.isInteger(params.approved_limit)?params.approved_limit:0).catch(()=>{this.localJobs.set(id,{id,status:'failed',reason:'后台收集未完成，请核对连接与已保存部分'});void this.api.runtime.sendMessage({type:'copilot.tables_changed'}).catch(()=>{});});return {id};
  }
  throw Error('未知表格命令');
 }
 owned(tab){return this.isWorkTab(tab.id)||this.workspaceWindows.has(tab.windowId);}
 async refreshOwnership(){
  const saved=await this.api.storage.local.get(['fast.backgroundWorkspaces.v1','fast.workWindow.v1','fast.workWindow.v1.incognito']);
  const windows=[];
  for(const key of ['fast.workWindow.v1','fast.workWindow.v1.incognito']){const marker=saved[key];if(!Number.isInteger(marker?.windowId)||!Number.isInteger(marker?.tabId))continue;let tab;try{tab=await this.api.tabs.get(marker.tabId);}catch(error){if(new RegExp('^No tab with id: ?'+marker.tabId+'\\.?$').test(error.message))continue;throw error;}if(tab.windowId===marker.windowId&&(tab.url===this.api.runtime.getURL('work-window.html')||tab.url?.startsWith('data:text/html,<title>Fast-browser-link</title>')))windows.push(marker.windowId);}
  this.workspaceWindows=new Set(windows);
  this.workspaceTabs=new Set((saved['fast.backgroundWorkspaces.v1']?.tasks||[]).flatMap(([,task])=>(task.requests||[]).map(([,request])=>request.tabId)).filter(Number.isInteger));
 }
 async synchronize(){const state=await this.request('state',{});this.trace=(await this.api.storage.session.get('copilotTrace')).copilotTrace||[];this.rows=new Map(state.suggestions.map(row=>[row.id,row]));await this.settings(state);return state;}
 async settings(state){
  const started=!this.enabled&&state.enabled;this.protectedHosts=state.protected_hosts||this.protectedHosts||[];
  await this.refreshOwnership();
  if(this.enabled&&!state.enabled){this.tableCaptures.clear();this.tableTab=null;}
  this.enabled=state.enabled===true;this.showBall=state.show_ball!==false;this.selectionPopup=state.selection_popup!==false;
  const scripts=await this.api.scripting.getRegisteredContentScripts({ids:['copilot']});
  if(this.enabled&&!scripts.length)await this.api.scripting.registerContentScripts([{id:'copilot',matches:['http://*/*','https://*/*'],js:['copilot-entry.js'],runAt:'document_idle',allFrames:false,persistAcrossSessions:false}]);
  if(!this.enabled&&scripts.length)await this.api.scripting.unregisterContentScripts({ids:['copilot']});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(tab=>ordinaryPage(tab.url||'')).map(async tab=>{
   if(!this.enabled||this.owned(tab)){await this.api.tabs.sendMessage(tab.id,{type:'copilot.teardown'}).catch(()=>{});return;}
   try{await this.api.scripting.executeScript({target:{tabId:tab.id},files:['copilot-entry.js']});await this.api.tabs.sendMessage(tab.id,{type:'copilot.visibility',visible:this.showBall});await this.api.tabs.sendMessage(tab.id,{type:'copilot.selection_settings',enabled:this.selectionPopup});}catch{/* 中文注释：受限页保持不采集，不通过调试器绕过。 */}
  }));
  if(started)void this.request('capability_health',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome'}).catch(()=>{});
  if(!this.enabled){this.selectionSeen.clear();if(this.tableJobs)for(const id of this.tableJobs.jobs.keys())this.tableJobs.stop(id);this.trace=[];this.pages.clear();await this.api.storage.session.remove('copilotTrace');}
 }
 async observation(sender,page,description){
  await this.refreshOwnership();
  if(!this.enabled||!this.collector(sender)||!page||!ordinaryPage(page.url)||typeof description!=='string')throw Error('采集已暂停或页面不可用');
  if(safeURL(sender.url)!==page.url)throw Error('页面已导航，请重新采集');
  if(new TextEncoder().encode(JSON.stringify(page)).length>6144)throw Error('页面快照超出预算');
  if(description.startsWith('选中 ')){const key=description.slice(3).normalize('NFKC').trim().toLowerCase(),now=Date.now();if(now-(this.selectionSeen.get(key)||0)<600000)return {accepted:false};this.selectionSeen.set(key,now);for(const [word,at] of this.selectionSeen)if(now-at>=600000)this.selectionSeen.delete(word);}
  const previous=this.pages.get(sender.tab.id);
  if(description==='导航到新页面'&&this.lastNavigation.get(sender.tab.id)===page.url)description='页面显著变化';
  if(['页面显著变化','打开页面'].includes(description)&&JSON.stringify(previous)===JSON.stringify(page))return {accepted:false};
  this.lastNavigation.set(sender.tab.id,page.url);
  this.pages.set(sender.tab.id,page);
  this.trace=appendStep(this.trace,description,sender.tab.id,page);
  await this.api.storage.session.set({copilotTrace:this.trace});
  await this.request('page_context',{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito});
  await this.request('capability_context',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome',tables:(this.tableCaptures.get(sender.tab.id)?.tables||[]).slice(0,3).map(table=>({headers:table.headers,rows:table.rows.length}))});
  return this.request('observe',{trace:this.trace,page});
 }
 tabEvent(tabId,description,tab){
  if(!this.enabled||this.isWorkTab(tabId))return;
  this.queue=this.queue.catch(()=>{}).then(async()=>{
   await this.refreshOwnership();if(this.isWorkTab(tabId))return;
   if(description==='导航到新页面'||description==='打开标签页'){
    await this.api.tabs.sendMessage(tabId,{type:'copilot.navigation'}).catch(()=>{});return;
   }
   const page=this.pages.get(tabId)||(ordinaryPage(tab?.url||'')?{url:safeURL(tab.url),title:tab.title||'',items:[]}:null);
   if(!page)return;
   this.trace=appendStep(this.trace,description,tabId,page);
   await this.api.storage.session.set({copilotTrace:this.trace});
   await this.request('observe',{trace:this.trace,page});
   if(description==='关闭标签页')this.pages.delete(tabId);
  });
 }
 async browserResult(id,data){
  const text=JSON.stringify(data);if(new TextEncoder().encode(text).length<=120000)return this.request('browser_fetch_result',{id,data});
  for(let start=0,index=0;start<text.length;start+=40000,index++){const response=await this.request('browser_fetch_chunk',{id,index,text:text.slice(start,start+40000)});if(!response.accepted)return;}return this.request('browser_fetch_result',{id,data:{chunked:true}});
 }
 async notification(event){
  if(event.type==='browser_fetch'){const enabled=this.enabled;const collect=['capability','capability_probe'].includes(event.kind)?(adapter,event,permitted)=>collectToolReport(adapter,event,permitted,params=>this.request('capability_progress',params)):collectBrowserData;void collect(this.dataAdapter,event,async()=>enabled&&this.enabled&&(await this.request('browser_fetch_status',{id:event.id})).allowed).then(data=>this.browserResult(event.id,data),()=>this.browserResult(event.id,{error:'background_data_unavailable'})).catch(()=>{});return;}

  if(event.type==='add'||event.type==='update'){const previous=this.rows.get(event.suggestion.id);this.rows.set(event.suggestion.id,event.suggestion);if(!this.panelPorts.size){if(event.type==='add'&&event.suggestion.status==='pending')this.suggestionsUnread.add(event.suggestion.id);if(event.suggestion.status==='completed'&&previous?.status!=='completed')this.unread.add(event.suggestion.id);}}
  if(event.type==='remove'){this.rows.delete(event.id);this.unread.delete(event.id);this.suggestionsUnread.delete(event.id);}
  if(event.type==='settings')await this.settings({...event,enabled:event.enabled??this.enabled,show_ball:event.show_ball??this.showBall});
  void this.api.runtime.sendMessage({type:'copilot.changed',event}).catch(()=>{});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(t=>ordinaryPage(t.url||'')&&!this.owned(t)).map(async t=>{await this.api.tabs.sendMessage(t.id,{type:'copilot.selection_suggestions',suggestions:[...this.rows.values()].filter(row=>row.status==='pending')}).catch(()=>{});return this.api.tabs.sendMessage(t.id,{type:'copilot.badge',count:this.unread.size,suggestions:this.suggestionsUnread.size,running:[...this.rows.values()].filter(r=>['queued','executing','stopping'].includes(r.status)).length+[...this.localJobs.values()].filter(j=>j.status==='executing').length,tables:this.tableCaptures.get(t.id)?.tables.length||0,panel_open:this.panelPorts.size>0}).catch(()=>{});}));
 }
 attachPanel(port){
  if(port.name!=='copilot-panel'||!this.panel(port.sender))return;
  this.panelPorts.add(port);
  port.onDisconnect.addListener(()=>this.panelPorts.delete(port));
  this.unread.clear();this.suggestionsUnread.clear();
  void this.notification({type:'read'});
 }
 handle(message,sender,respond){
  if(!message?.type?.startsWith('copilot.')||message.type==='copilot.changed')return false;
  const content=this.collector(sender),panel=this.panel(sender);
  const popup=sender?.id===this.api.runtime.id&&sender.url===this.api.runtime.getURL('popup.html');
  if(message.type==='copilot.open'&&(content&&this.enabled||panel||popup)){
   // 中文注释：在当前点击消息栈立即调用，不能先 await 存储或 Native RPC 消耗用户手势。
   try{Promise.resolve(this.api.sidePanel.open({windowId:sender.tab?.windowId??(popup&&Number.isInteger(message.windowId)?message.windowId:undefined)})).then(()=>respond({result:{opened:true}}),()=>respond({result:{opened:false}}));}catch{respond({result:{opened:false}});}return true;
  }
  let work;
  if(popup&&message.type==='copilot.popup_settings'&&typeof message.enabled==='boolean'){work=this.request('settings',{enabled:message.enabled}).then(async state=>{await this.settings(state);return {enabled:state.enabled};});}
  else if(content&&this.enabled&&message.type==='copilot.selection'){
   if(message.command==='open_capabilities'){try{void this.api.sidePanel.open({windowId:sender.tab.windowId});}catch{}}
    if(message.command==='open_cached'){try{void this.api.sidePanel.open({windowId:sender.tab.windowId});}catch{}}
   work=this.refreshOwnership().then(async()=>{if(this.owned(sender.tab))throw Error('work page excluded');
    const params=message.params||{};
    if(message.command==='selection_info'){await this.request('page_context',{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito});await this.request('capability_context',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome',tables:(this.tableCaptures.get(sender.tab.id)?.tables||[]).slice(0,3).map(table=>({headers:table.headers,rows:table.rows.length}))});const info=await this.request('selection_info',params);return {...info,suggestions:[...(info.workflows||[]),...[...this.rows.values()].filter(row=>row.status==='pending')]};}
    if(message.command==='selection_context')return this.request('selection_context',params);
    if(message.command==='quick_task')return this.request('quick_task',{action:params.action,params:params.params,context:{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito}});
    if(message.command==='open_capabilities')return this.request('capability_focus',{});
    if(message.command==='open_cached')return this.request('focus_result',{id:params.id});
    if(message.command==='selection_error')return this.request('selection_context',{text:params.text});
    throw Error('unknown selection command');});
  }else if(content&&message.type==='copilot.tables'){
   work=this.refreshOwnership().then(()=>{if(this.owned(sender.tab)||message.capture?.url!==sender.url)throw Error('页面范围已变化');this.tableCaptures.set(sender.tab.id,{...message.capture,incognito:!!sender.tab.incognito});if(sender.tab.active||this.tableTab===null)this.tableTab=sender.tab.id;void this.notification({type:'table_detected'});void this.api.runtime.sendMessage({type:'copilot.tables_changed'}).catch(()=>{});return {};});
  }else if(panel&&message.type==='copilot.local')work=this.localCommand(message.command,message.params||{});
  else
  if(sender?.id===this.api.runtime.id&&Number.isInteger(sender.tab?.id)&&message.type==='copilot.collector_state')work=this.refreshOwnership().then(()=>this.api.storage.local.get('copilotBallPosition')).then(saved=>({enabled:this.enabled&&!this.owned(sender.tab),selection_popup:this.selectionPopup,show_ball:this.showBall,position:saved.copilotBallPosition,panel_open:this.panelPorts.size>0}));
  else if(content&&message.type==='copilot.position'&&Number.isFinite(message.x)&&Number.isFinite(message.y))work=this.api.storage.local.set({copilotBallPosition:{x:Math.max(0,Math.min(1,message.x)),y:Math.max(0,Math.min(1,message.y))}});
  else if(content&&message.type==='copilot.panel_status')work=Promise.resolve({open:this.panelPorts.size>0});
  else if(content&&this.enabled&&message.type==='copilot.observe'){
   this.queue=this.queue.catch(()=>{}).then(()=>this.observation(sender,message.page,message.description));work=this.queue;
  }else if(content&&this.enabled&&message.type==='copilot.mini')work=Promise.resolve({suggestions:[...this.rows.values()].filter(row=>row.status==='pending')});
  else if(content&&this.enabled&&message.type==='copilot.hide_ball')work=this.request('settings',{show_ball:false}).then(state=>this.settings(state));
  else if(panel&&message.type==='copilot.command'&&['capability_state','capability_reload','capability_health','capability_discover','capability_bind','tool_learn_context','tool_draft','tool_save','locale','quick_task','selection_context','open_result','export_results','result','clear_read','batch','replenish','next_action','table_begin','table_append','table_finish','table_read','table_column_action','table_open','models','configure','state','settings','execute','ignore','stop','open_report','save_result','followup','retry','retry_inference'].includes(message.command)){
   work=(message.command==='open_result'?this.localCommand('open_result',message.params||{}):this.request(message.command,message.params||{})).then(async state=>{
    if(message.command==='settings')await this.settings(state);if(state.protected_hosts)this.protectedHosts=state.protected_hosts;
    if(state.suggestions){this.rows=new Map(state.suggestions.map(row=>[row.id,row]));this.unread.clear();this.suggestionsUnread.clear();}
    return state;
   });
  }else return false;
  Promise.resolve(work).then(result=>respond({result}),()=>respond({error:'协作连接或请求失败，请检查本地配置并刷新侧栏。'}));return true;
 }
}
