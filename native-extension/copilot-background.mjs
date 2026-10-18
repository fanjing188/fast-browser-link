import {SessionRetry} from './copilot-retry.mjs';
import {tableConfirmation} from './copilot-table-confirm.mjs';
import {collectToolReport} from './copilot-tool-reports.mjs';
import {collectBrowserData} from './copilot-browser-data.mjs';
import {captureTables} from './copilot-tables.mjs';
import {TableJobs} from './copilot-table-job.mjs';
import {ordinaryPage,appendStep,safeURL,pageIdentity} from './copilot-observation.mjs';
export class CopilotBackground {
 constructor(api,request,isWorkTab=()=>false,reconnect=async()=>{}){
  this.sessionRetry=new SessionRetry(async()=>{const state=await this.request('settings',{enabled:true});await this.settings(state);});
  this.reconnectBridge=reconnect;this.protectedHosts=null;this.selectionSeen=new Map();this.selectionPopup=true;this.tableHints=new Map();this.annotationProfiles=new Map();this.tableCaptures=new Map();this.tableTab=null;this.tableJobs=null;this.localJobs=new Map();
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
  if(name==='table_state'||name==='recognize_tables')return {saved:this.lastTableSaved||null,confirmation:this.tableConfirmation?.view||null,capture:this.tableCaptures.get(this.tableTab)||null,jobs:[...this.localJobs.values()]};
  if(name==='confirm_table')return this.resolveTableConfirmation(params.kind,params.token);
  const capture=this.tableCaptures.get(this.tableTab),table=capture?.tables.find(item=>item.id===params.id);
  if(name==='stop_table'){this.tableJobs?.stop(params.id);return {};}
  if(!table)throw Error('表格已变化，请重新识别');
  if(['save_table','copy_table','collect_table'].includes(name)){
   const [active]=await this.api.tabs.query({active:true,currentWindow:true});await this.refreshOwnership();
   if(!active||active.id!==this.tableTab||active.url!==capture.url||this.owned(active))throw Error('目标页面已变化');
   if(this.tableConfirmation)await this.resolveTableConfirmation('cancel',this.tableConfirmation.token);
   const token=crypto.randomUUID(),pending={token,tab:active.id,url:capture.url,capture:structuredClone(capture),name,format:name==='copy_table'?'clipboard':params.format||'xlsx'};
   const [result]=await this.api.scripting.executeScript({target:{tabId:active.id},func:tableConfirmation,args:[{token,tables:capture.tables,index:capture.tables.indexOf(table),format:pending.format,all:name==='collect_table',url:capture.url,language:this.locale||'zh'}]});
   pending.view=result.result;this.tableConfirmation=pending;await this.tableConfirmationChanged();return {confirmation:pending.view};
  }
  throw Error('未知表格命令');
 }
 async tableConfirmationChanged(){await this.api.runtime.sendMessage({type:'copilot.tables_changed'}).catch(()=>{});}
 async resolveTableConfirmation(kind,token){
  const pending=this.tableConfirmation;if(!pending||token!==pending.token)throw Error('确认已失效');
  if(kind==='removed'||kind==='cancel'){this.tableConfirmation=null;try{await this.api.scripting.executeScript({target:{tabId:pending.tab},func:tableConfirmation,args:[{action:'cancel',token}]});}catch{}await this.tableConfirmationChanged();if(kind==='removed')void this.api.runtime.sendMessage({type:'copilot.table_notice',removed:true}).catch(()=>{});return {cancelled:true,removed:kind==='removed'};}
  if(!['switch','confirm'].includes(kind))throw Error('invalid confirmation');
  await this.refreshOwnership();const tab=await this.api.tabs.get(pending.tab);
  if(this.owned(tab)||tab.url!==pending.url){await this.resolveTableConfirmation('cancel',token);throw Error('页面归属已变化');}
  let result;try{[result]=await this.api.scripting.executeScript({target:{tabId:pending.tab},func:tableConfirmation,args:[{action:kind,token}]});}catch(error){await this.resolveTableConfirmation('cancel',token);throw error;}
  const view=result.result;if(!view||view.token!==token)throw Error('目标已取消');
  if(kind==='switch'){pending.view=view;await this.tableConfirmationChanged();return {confirmation:view};}
  this.tableConfirmation=null;await this.tableConfirmationChanged();
  const [fresh]=await this.api.scripting.executeScript({target:{tabId:pending.tab},func:captureTables});
  const capture=pending.capture,table=capture.tables.find(row=>row.id===view.id);if(!table||!fresh.result.tables.some(row=>row.dom_path===table.dom_path&&JSON.stringify(row.headers)===JSON.stringify(table.headers)&&JSON.stringify(row.rows)===JSON.stringify(table.rows)))throw Error('目标表格已变化，请重新识别');
  if(pending.name==='copy_table')return {clipboard:[table.headers,...table.rows.map(row=>row.map(cell=>cell.text))].map(row=>row.map(value=>value.replaceAll('\t',' ').replaceAll('\n',' ')).join('\t')).join('\n')};
  if(pending.name==='save_table'){const result=await this.exportTable({name:table.name,site:new URL(capture.url).hostname,headers:table.headers,rows:table.rows,pages:1,partial:table.incomplete},pending.format);this.lastTableSaved={key:capture.url+'|'+table.id,result};await this.tableConfirmationChanged();return result;}
  if(!this.tableJobs)throw Error('工作区尚未连接');const state=await this.request('state',{}),id=crypto.randomUUID();
  void this.tableJobs.run(id,capture,table,state.table_config,true,table.pagination.totalPages||state.table_config.max_pages).catch(()=>{this.localJobs.set(id,{id,status:'failed',reason:'后台收集未完成，请核对连接与已保存部分'});void this.tableConfirmationChanged();});return {id};
 }
 owned(tab){return this.isWorkTab(tab.id)||this.workspaceWindows.has(tab.windowId);}
 async refreshOwnership(){
  const saved=await this.api.storage.local.get(['fast.backgroundWorkspaces.v1','fast.workWindow.v1','fast.workWindow.v1.incognito']);
  const windows=[];
  for(const key of ['fast.workWindow.v1','fast.workWindow.v1.incognito']){const marker=saved[key];if(!Number.isInteger(marker?.windowId)||!Number.isInteger(marker?.tabId))continue;let tab;try{tab=await this.api.tabs.get(marker.tabId);}catch(error){if(new RegExp('^No tab with id: ?'+marker.tabId+'\\.?$').test(error.message))continue;throw error;}if(tab.windowId===marker.windowId&&(tab.url===this.api.runtime.getURL('work-window.html')||tab.url?.startsWith('data:text/html,<title>Fast-browser-link</title>')))windows.push(marker.windowId);}
  this.workspaceWindows=new Set(windows);
  this.workspaceTabs=new Set((saved['fast.backgroundWorkspaces.v1']?.tasks||[]).flatMap(([,task])=>(task.requests||[]).map(([,request])=>request.tabId)).filter(Number.isInteger));
 }
 async synchronize(){let state=await this.request('state',{});const saved=await this.api.storage.session.get('copilotBridgeEnabled');if(saved.copilotBridgeEnabled&&!state.enabled&&!state.startup_error&&!state.bridge_recovery_blocked)state=await this.request('settings',{enabled:true});await this.api.storage.session.set({copilotBridgeEnabled:false});this.trace=(await this.api.storage.session.get('copilotTrace')).copilotTrace||[];this.rows=new Map(state.suggestions.map(row=>[row.id,row]));await this.settings(state);return state;}
 async settings(state){
  this.locale=state.locale;this.boardName=state.board_name;this.hermesHealth=state.hermes_health||(state.startup_error?{state:'error',reason:state.startup_error.reason,reason_en:state.startup_error.reason_en}:this.hermesHealth);
  const started=!this.enabled&&state.enabled;this.protectedHosts=state.protected_hosts||this.protectedHosts||[];
  await this.refreshOwnership();
  if(this.enabled&&!state.enabled&&this.tableConfirmation)await this.resolveTableConfirmation('cancel',this.tableConfirmation.token);
  if(this.enabled&&!state.enabled){this.tableCaptures.clear();this.tableTab=null;this.lastTableSaved=null;}
  this.enabled=state.enabled===true;this.showBall=state.show_ball!==false;this.selectionPopup=state.selection_popup!==false;this.pageAnnotations=state.page_annotations!==false;this.annotationDensity=state.annotation_density||'compact';
  const scripts=await this.api.scripting.getRegisteredContentScripts({ids:['copilot']});
  if(this.enabled&&!scripts.length)await this.api.scripting.registerContentScripts([{id:'copilot',matches:['http://*/*','https://*/*'],js:['copilot-entry.js'],runAt:'document_idle',allFrames:false,persistAcrossSessions:false}]);
  if(!this.enabled&&scripts.length)await this.api.scripting.unregisterContentScripts({ids:['copilot']});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(tab=>ordinaryPage(tab.url||'')).map(async tab=>{
   if(!this.enabled||this.owned(tab)){await this.api.tabs.sendMessage(tab.id,{type:'copilot.teardown'}).catch(()=>{});return;}
   try{await this.api.scripting.executeScript({target:{tabId:tab.id},files:['copilot-entry.js']});await this.api.tabs.sendMessage(tab.id,{type:'copilot.visibility',visible:this.showBall});await this.api.tabs.sendMessage(tab.id,{type:'copilot.selection_settings',enabled:this.selectionPopup});await this.api.tabs.sendMessage(tab.id,{type:'copilot.annotation_settings',enabled:this.pageAnnotations,density:this.annotationDensity,profiles:this.annotationProfiles?.get(tab.id)||[]});}catch{/* 中文注释：受限页保持不采集，不通过调试器绕过。 */}
  }));
  if(started)void this.request('capability_state',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome'}).catch(()=>{});
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
  if(['页面显著变化','打开页面'].includes(description)&&pageIdentity(previous)===pageIdentity(page))return {accepted:false};
  const signature=sender.tab.id+'|'+pageIdentity(page)+'|'+description,at=Date.now();
  if(this.lastCapture?.signature===signature&&at-this.lastCapture.at<1000)return {accepted:false};
  this.lastCapture={signature,at};
  this.lastNavigation.set(sender.tab.id,page.url);
  this.pages.set(sender.tab.id,page);
  this.trace=appendStep(this.trace,description,sender.tab.id,page);
  await this.api.storage.session.set({copilotTrace:this.trace});
  await this.request('page_context',{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito});
  const capabilities=await this.request('capability_context',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome',tables:(this.tableCaptures.get(sender.tab.id)?.tables||[]).slice(0,3).map(table=>({headers:table.headers,rows:table.rows.length}))});
  this.tableHints.set(sender.tab.id,capabilities.table_hints||{});this.annotationProfiles.set(sender.tab.id,capabilities.annotation_profiles||[]);await this.api.tabs.sendMessage(sender.tab.id,{type:'copilot.annotation_settings',enabled:this.pageAnnotations!==false,density:this.annotationDensity||'compact',profiles:capabilities.annotation_profiles||[]}).catch(()=>{});
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
  if(event.type==='logs'){await this.api.runtime.sendMessage({type:'copilot.logs',event}).catch(()=>{});return;}
  if(event.type==='browser_fetch'){const enabled=this.enabled;const collect=['capability','capability_probe'].includes(event.kind)?(adapter,event,permitted)=>collectToolReport(adapter,event,permitted,params=>this.request('capability_progress',params)):collectBrowserData;void collect(this.dataAdapter,event,async()=>enabled&&this.enabled&&(await this.request('browser_fetch_status',{id:event.id})).allowed).then(data=>this.browserResult(event.id,data),()=>this.browserResult(event.id,{error:'background_data_unavailable'})).catch(()=>{});return;}

  if(event.type==='add'||event.type==='update'){const previous=this.rows.get(event.suggestion.id);this.rows.set(event.suggestion.id,event.suggestion);if(!this.panelPorts.size){if(event.type==='add'&&event.suggestion.status==='pending')this.suggestionsUnread.add(event.suggestion.id);if(event.suggestion.status==='completed'&&previous?.status!=='completed')this.unread.add(event.suggestion.id);}}
  if(event.suggestion?.action==='workflow.run')void this.onActivity?.(event.suggestion);
  if(event.type==='remove'){this.rows.delete(event.id);this.unread.delete(event.id);this.suggestionsUnread.delete(event.id);}
  if(event.type==='ready'&&!this.sessionRetry.recovery||event.type==='inference'&&event.succeeded===true)this.sessionRetry.reset();
  if(event.type==='settings'&&event.enabled===false){if(event.startup_error)event.startup_error.recovery_exhausted===true?this.sessionRetry.reset():this.sessionRetry.failed();else this.sessionRetry.reset();}
  if(event.type==='settings')await this.settings({...event,enabled:event.enabled??this.enabled,show_ball:event.show_ball??this.showBall});
  void this.api.runtime.sendMessage({type:'copilot.changed',event}).catch(()=>{});
  const tabs=await this.api.tabs.query({});
  await Promise.all(tabs.filter(t=>ordinaryPage(t.url||'')&&!this.owned(t)).map(async t=>{if(['update','basket'].includes(event.type))await this.api.tabs.sendMessage(t.id,{type:'copilot.annotation_refresh'}).catch(()=>{});await this.api.tabs.sendMessage(t.id,{type:'copilot.selection_suggestions',suggestions:[...this.rows.values()].filter(row=>row.status==='pending')}).catch(()=>{});return this.api.tabs.sendMessage(t.id,{type:'copilot.badge',count:this.unread.size,suggestions:this.suggestionsUnread.size,running:[...this.rows.values()].filter(r=>['queued','executing','stopping'].includes(r.status)).length+[...this.localJobs.values()].filter(j=>j.status==='executing').length,tables:this.tableCaptures.get(t.id)?.tables.length||0,panel_open:this.panelPorts.size>0}).catch(()=>{});}));
 }
 attachPanel(port){
  if(port.name!=='copilot-panel'||!this.panel(port.sender))return;
  this.panelPorts.add(port);
  port.onDisconnect.addListener(()=>{this.panelPorts.delete(port);if(!this.panelPorts.size)void this.request('suggestion_hold',{id:'',held:false}).catch(()=>{});});
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
  if(content&&message.type==='copilot.table_confirmation_error'){work=this.api.runtime.sendMessage({type:'copilot.table_notice',failed:true});}
  else if(content&&message.type==='copilot.table_confirmation'&&sender.tab.id===this.tableConfirmation?.tab){work=this.resolveTableConfirmation(message.kind,message.token);}
  else if(panel&&message.type==='copilot.reconnect'){work=this.reconnectBridge().then(()=>this.request('state',{}));}
  else if(popup&&message.type==='copilot.fbl_fix')work=this.request('fbl_fix',{});
  else   if(popup&&message.type==='copilot.popup_settings'&&typeof message.enabled==='boolean'){this.sessionRetry.reset();work=this.request('settings',{enabled:message.enabled}).then(async state=>{await this.settings(state);return {enabled:state.enabled};});}
  else if(content&&this.enabled&&message.type==='copilot.selection'){
   if(message.command==='open_capabilities'){try{void this.api.sidePanel.open({windowId:sender.tab.windowId});}catch{}}
    if(message.command==='open_cached'){try{void this.api.sidePanel.open({windowId:sender.tab.windowId});}catch{}}
   work=this.refreshOwnership().then(async()=>{if(this.owned(sender.tab))throw Error('work page excluded');
    const params=message.params||{};
    if(message.command==='selection_info'){await this.request('page_context',{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito});await this.request('capability_context',{browser:/Edg\//.test(globalThis.navigator?.userAgent||'')?'edge':'chrome',tables:(this.tableCaptures.get(sender.tab.id)?.tables||[]).slice(0,3).map(table=>({headers:table.headers,rows:table.rows.length}))});const info=await this.request('selection_info',params);return {...info,suggestions:[...(info.workflows||[]),...[...this.rows.values()].filter(row=>row.status==='pending')]};}
    if(message.command==='basket_add'){if(!Array.isArray(params.items)||params.items.some(item=>!['keyword','domain','url'].includes(item.type)))throw Error('invalid basket object');return this.request('basket_add',{items:params.items.map(item=>({...item,source:sender.tab.url||sender.url}))});}
    if(message.command==='confirm_task')return this.request('execute',{id:params.id,confirmation:params.confirmation});
    if(message.command==='selection_context')return this.request('selection_context',params);
    if(message.command==='quick_task')return this.request('quick_task',{action:params.action,params:params.params,context:{url:sender.tab.url||sender.url,incognito:!!sender.tab.incognito}});
    if(message.command==='open_capabilities')return this.request('capability_focus',{});
    if(message.command==='open_cached')return this.request('focus_result',{id:params.id});
    if(message.command==='selection_error')return this.request('selection_context',{text:params.text});
    throw Error('unknown selection command');});
  }else if(content&&this.enabled&&message.type==='copilot.annotation_lookup'){work=this.refreshOwnership().then(()=>{if(this.owned(sender.tab)||sender.url!==sender.tab.url)throw Error('work page excluded');return this.request('annotation_lookup',message.params||{});});
  }else if(content&&message.type==='copilot.tables'){
   work=this.refreshOwnership().then(()=>{if(this.owned(sender.tab)||message.capture?.url!==sender.url)throw Error('页面范围已变化');this.tableCaptures.set(sender.tab.id,{...message.capture,incognito:!!sender.tab.incognito});if(!sender.tab.incognito)void this.request('fbl_layout',{url:message.capture.url,tables:message.capture.tables.slice(0,3).map(table=>({headers:table.headers}))}).then(result=>{if(result.found)return this.api.runtime.sendMessage({type:'copilot.new_tool'});}).catch(()=>{});void this.request('log_client',{event:'table',tables:message.capture.tables.length,rows:message.capture.tables.reduce((count,table)=>count+table.rows.length,0)}).catch(()=>{});if(sender.tab.active||this.tableTab===null)this.tableTab=sender.tab.id;void this.notification({type:'table_detected'});void this.api.runtime.sendMessage({type:'copilot.tables_changed'}).catch(()=>{});return {};});
  }else if(panel&&message.type==='copilot.local')work=this.localCommand(message.command,message.params||{});
  else
  if(sender?.id===this.api.runtime.id&&Number.isInteger(sender.tab?.id)&&message.type==='copilot.collector_state')work=this.refreshOwnership().then(()=>this.api.storage.local.get('copilotBallPosition')).then(saved=>({enabled:this.enabled&&!this.owned(sender.tab),table_hints:this.tableHints.get(sender.tab.id)||{},page_annotations:this.pageAnnotations!==false,annotation_density:this.annotationDensity||'compact',annotation_profiles:this.annotationProfiles.get(sender.tab.id)||[],selection_popup:this.selectionPopup,show_ball:this.showBall,position:saved.copilotBallPosition,panel_open:this.panelPorts.size>0}));
  else if(content&&message.type==='copilot.position'&&Number.isFinite(message.x)&&Number.isFinite(message.y))work=this.api.storage.local.set({copilotBallPosition:{x:Math.max(0,Math.min(1,message.x)),y:Math.max(0,Math.min(1,message.y))}});
  else if(content&&message.type==='copilot.panel_status')work=Promise.resolve({open:this.panelPorts.size>0});
  else if(content&&this.enabled&&message.type==='copilot.observe'){
   this.queue=this.queue.catch(()=>{}).then(()=>this.observation(sender,message.page,message.description));work=this.queue;
  }else if(content&&this.enabled&&message.type==='copilot.mini')work=Promise.resolve({suggestions:[...this.rows.values()].filter(row=>row.status==='pending')});
  else if(content&&this.enabled&&message.type==='copilot.hide_ball')work=this.request('settings',{show_ball:false}).then(state=>this.settings(state));
  else if(panel&&message.type==='copilot.command'&&['basket_state','basket_add','basket_remove','basket_clear','basket_plan','basket_execute','fbl_readiness','fbl_fix','fbl_discover','fbl_confirm','preferences','logs_read','logs_clear','logs_export','log_client','capability_state','capability_reload','capability_health','capability_discover','capability_bind','tool_learn_context','tool_draft','tool_save','locale','quick_task','selection_context','open_result','export_results','result','clear_read','batch','replenish','next_action','table_begin','table_append','table_finish','table_read','table_column_action','table_open','models','configure','state','settings','execute','ignore','stop','open_report','save_result','followup','retry','retry_inference','suggestion_hold'].includes(message.command)){
   if(message.command==='settings'&&typeof message.params?.enabled==='boolean')this.sessionRetry.reset();
   work=(message.command==='open_result'?this.localCommand('open_result',message.params||{}):this.request(message.command,message.params||{})).then(async state=>{
    if(message.command==='settings'||message.command==='preferences')await this.settings(state);if(state.hermes_health)this.hermesHealth=state.hermes_health;if(state.protected_hosts)this.protectedHosts=state.protected_hosts;
    if(state.suggestions){this.rows=new Map(state.suggestions.map(row=>[row.id,row]));this.unread.clear();this.suggestionsUnread.clear();}
    return state;
   });
  }else return false;
  Promise.resolve(work).then(result=>respond({result}),()=>respond({error:'协作连接或请求失败，请检查本地配置并刷新侧栏。'}));return true;
 }
}
