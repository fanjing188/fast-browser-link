import {renderChains} from './copilot-readiness.mjs';
import {mountControls,boardName,renderConnection} from './copilot-controls.mjs';
// 中文注释：只用当前宿主回执证明连接/任务状态，缓存和旧授权都不能充当在线证据。
const $=selector=>document.querySelector(selector);
const chinese=(chrome.i18n?.getUILanguage?.()||navigator.language||'zh').startsWith('zh');
const t=(zh,en)=>chinese?zh:en;
document.documentElement.lang=chinese?'zh-CN':'en';
for(const el of document.querySelectorAll('[data-zh]'))el.textContent=t(el.dataset.zh,el.dataset.en);
for(const [id,zh,en] of [['copilot-toggle','协作开关','Toggle Copilot'],['error-close','关闭错误提示','Dismiss error'],['version-label','扩展版本','Extension version']])$('#'+id).setAttribute('aria-label',t(zh,en));
if(!chinese)document.querySelector('.connections').setAttribute('aria-label','Connection status');
for(const [selector,en] of [['#local-row .info-button','Local connection information'],['.cloud-row .info-button','Cloud connection information'],['#page-task .info-button','Task controls information']])if(!chinese)$(selector).setAttribute('aria-label',en);
if(!chinese)$('#connection-detail').textContent='Confirming connection lets Fast-browser-link read, click and run scripts on task pages without per-site or per-action approval. Takeover, stop and task isolation remain available; password values are never echoed.';
const controls=mountControls(document);
let connected=false,known=false,statusData=null,refreshing=false,uncertainControl=null,busy=false,revision=0,controlPending=null,stoppedReceipt=null,windowId;
$('#version-label').textContent=`v${chrome.runtime.getManifest().version}`;
void chrome.windows?.getCurrent?.().then(view=>{windowId=view.id;}).catch(()=>{});
function error(message){$('#error').textContent=message;$('#error').hidden=false;$('#error-bar').hidden=false;}
$('#error-close').addEventListener('click',()=>{$('#error').hidden=true;$('#error-bar').hidden=true;});
async function call(message){const response=await chrome.runtime.sendMessage(message);if(!response||response.error||!Object.hasOwn(response,'result'))throw Error(t('状态未确认','Status not confirmed'));return response.result;}
async function feedback(button,action){
 if(button.disabled||button.dataset.feedback==='loading')return;
 button.disabled=true;button.dataset.feedback='loading';button.setAttribute('aria-busy','true');
 try{await action();button.dataset.feedback='success';setTimeout(()=>{if(button.dataset.feedback==='success')delete button.dataset.feedback;},900);}
 catch(failure){delete button.dataset.feedback;error(failure.message||t('操作失败，请重试','Action failed. Try again.'));}
 finally{button.disabled=false;button.removeAttribute('aria-busy');}
}
function render(){
 const state=!known?'error':connected?'connected':busy?'connecting':'disconnected';
 $('#connection-label').dataset.state=state;$('#connection-label').setAttribute('aria-label',t(!known?'状态待确认':connected?'本地已连接':busy?'连接中':'未连接',!known?'Status unknown':connected?'Local connected':busy?'Connecting':'Disconnected'));
 $('#access-status').dataset.state=state;$('#access-status').textContent=t(!known?'状态待确认':connected?'已连接':busy?'连接中':'未连接',!known?'Unknown':connected?'Connected':busy?'Connecting':'Disconnected');
 $('#access-detail').textContent=t(!known?'连接状态待确认。':connected?'已连接 · 任务页可由 Fast-browser-link 直接访问。':'未连接 · 确认连接后才能直接访问任务页。',!known?'Connection status is unknown.':connected?'Connected. Fast-browser-link can directly access task pages.':'Disconnected. Confirm connection before accessing task pages.');
 const empty=!known||!connected;$('#connection-card').hidden=true;$('#connect').hidden=true;$('#connect').disabled=busy;
 const first=known&&!connected&&statusData?.browserFullConsentStatus==='disabled';
 $('#empty-label').textContent=t(first?'尚未授权连接':'本地服务未运行',first?'Connection not authorized':'Local service is not running');$('#connect').textContent=t(first?'连接':'重试',first?'Connect':'Retry');$('#connect').classList.remove('primary');$('#local-connect').classList.toggle('primary',first);
 $('#open-copilot').classList.remove('primary');$('#local-connect').hidden=connected||busy;$('#local-connect').textContent=t(known?'连接':'重试',known?'Connect':'Retry');
 const copilot=statusData?.copilot;$('#popup-setup').hidden=!connected||copilot?.enabled===true;renderChains(document,$('#popup-chains'),{extension:known?connected:null,host:known?connected:null,daemon:known?connected:null,inference:copilot?.ready===true,execution:copilot?.execution_health?.state==='connected'},chinese?'zh':'en');$('#popup-board-name').textContent=boardName(copilot?.board_name,chinese?'zh':'en');$('#open-copilot').hidden=!known||!connected||copilot?.enabled!==true;renderConnection($('#popup-hermes-status'),connected?copilot?.hermes_health:null,chinese?'zh':'en');$('#hermes-refresh').hidden=!connected||!['error','disconnected'].includes(copilot?.hermes_health?.state);controls.sync();$('#copilot-toggle').setAttribute('aria-checked',String(copilot?.enabled===true));$('#copilot-toggle').disabled=!known||!connected;
 $('#copilot-summary').hidden=true;
 $('#copilot-summary').textContent=[t(copilot?.running?'跟随中':'跟随中','Following'),copilot?.running?t(`进行中 ${copilot.running}`,`Running ${copilot.running}`):'',copilot?.unread?t(`新结果 ${copilot.unread}`,`New ${copilot.unread}`):''].filter(Boolean).join(' · ');
 renderWork();window.dispatchEvent(new CustomEvent('fast-browser-link-status',{detail:known?{...statusData?.cloud,localConnected:connected}:null}));
}
async function refresh(){
 if(busy||refreshing)return;refreshing=true;const token=++revision;
 try{
  const result=await call({type:'popup_status'});if(token!==revision)return;known=true;statusData=result;connected=result.connected===true;
  if(uncertainControl){const task=result.tasks?.find(row=>row.id===uncertainControl.taskId);if(!task||['cancelled','closed'].includes(task.state)||task.generation!==uncertainControl.generation||uncertainControl.kind==='takeover'&&task.state==='paused'||uncertainControl.kind==='resume'&&['paused','ready','running'].includes(task.state))uncertainControl=null;}
 }catch{if(token!==revision)return;known=false;connected=false;error(t('连接状态暂时无法读取。','Cannot read connection status.'));}
 finally{refreshing=false;}render();
}
function renderWork(){
 const page=known&&connected?statusData?.page:null,task=page?statusData.tasks?.find(row=>row.id===page.taskId&&!['closed','cancelled'].includes(row.state)):null;
 const receipt=!task&&known&&connected&&stoppedReceipt&&(!page||page.tabId===stoppedReceipt.tabId)?stoppedReceipt:null;
 $('#page-task').dataset.taskId=task?.id||'';$('#page-task').dataset.tabId=task?String(page.tabId):'';$('#page-task').hidden=!task&&!receipt;
 $('#task-title').textContent=task?.title||page?.title||t('当前页任务','Current task');$('#task-title').title=$('#task-title').textContent;
 $('#operation').textContent=receipt?t('已停止','Stopped'):t(task?.state==='pausing'?'正在暂停任务…':task?.state==='paused'?'任务已暂停':task?.pendingInteraction?(task.pendingInteraction.kind==='manual_input'?'等待人工输入':'等待确认'):task?.state==='running'?'执行中':'已就绪',task?.state==='pausing'?'Pausing…':task?.state==='paused'?'Paused':task?.pendingInteraction?'Waiting for user':task?.state==='running'?'Running':'Ready');
 const uncertain=!!uncertainControl&&uncertainControl.taskId===task?.id&&uncertainControl.generation===task?.generation;
 $('#stop-task').disabled=busy||!task||uncertain&&uncertainControl.kind==='stop';$('#takeover').disabled=busy||!task||task.state==='pausing'||uncertain;$('#takeover').textContent=t(task?.state==='paused'?'继续':'接管',task?.state==='paused'?'Resume':'Take over');
 $('#stop-task').textContent=receipt?t('已停止','Stopped'):t('停止','Stop');
 for(const id of ['takeover','stop-task']){const pending=controlPending===(id==='takeover'?'takeover':'stop');if(pending)$('#'+id).dataset.feedback='loading';else if($('#'+id).dataset.feedback==='loading')delete $('#'+id).dataset.feedback;$('#'+id).setAttribute('aria-busy',String(pending));}
}
async function controlTask(kind){
 const page=statusData?.page,task=statusData?.tasks?.find(row=>row.id===page?.taskId);
 if(!known||!connected||busy||!page||!task||kind!=='stop'&&task.state==='pausing'||uncertainControl?.kind===kind&&uncertainControl.taskId===task.id&&uncertainControl.generation===task.generation)return;
 busy=true;controlPending=kind==='stop'?'stop':'takeover';++revision;render();
 try{
  const result=await call({type:'popup_action',taskId:task.id,generation:task.generation,tabId:page.tabId,kind});if(result.verified!==true)throw Error('unverified');uncertainControl=null;
  const button=$(kind==='stop'?'#stop-task':'#takeover');button.dataset.feedback='success';setTimeout(()=>{if(button.dataset.feedback==='success')delete button.dataset.feedback;},900);
  if(kind==='stop'){stoppedReceipt={tabId:page.tabId};setTimeout(()=>{stoppedReceipt=null;renderWork();},1500);}
 }catch{uncertainControl={kind,taskId:task.id,generation:task.generation};error(t('操作结果尚未确认，正在读取状态，不会重复发送。','Result unconfirmed. Checking status without replaying the command.'));}
 finally{busy=false;controlPending=null;await refresh();}
}
$('#stop-task').addEventListener('click',()=>void controlTask('stop'));
$('#takeover').addEventListener('click',()=>{const task=statusData?.tasks?.find(row=>row.id===statusData?.page?.taskId);void controlTask(task?.state==='paused'?'resume':'takeover');});
async function connect(button){await feedback(button,async()=>{if(busy)return;busy=true;++revision;render();try{const result=await call({type:'connect'});if(result.connected!==true)throw Error(t('本地服务未运行','Local service is not running'));}finally{busy=false;await refresh();}});}
for(const id of ['connect','local-connect'])$('#'+id).addEventListener('click',()=>void connect($('#'+id)));
function openCopilot(button){return feedback(button,async()=>{const result=await call({type:'copilot.open',windowId});if(result.opened!==true)throw Error(t('侧栏未打开，请重试','Could not open the side panel. Try again.'));window.close();});}
$('#open-copilot').addEventListener('click',()=>void openCopilot($('#open-copilot')));$('#copilot-summary').addEventListener('click',()=>void openCopilot($('#copilot-summary')));
$('#copilot-toggle').addEventListener('click',()=>void feedback($('#copilot-toggle'),async()=>{const state=await call({type:'copilot.popup_settings',enabled:$('#copilot-toggle').getAttribute('aria-checked')!=='true'});if(typeof state.enabled!=='boolean')throw Error(t('协作状态未确认','Copilot state not confirmed'));await refresh();}));
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;event.preventDefault();if($('#cloud-dialog').dataset.open==='true')window.dispatchEvent(new CustomEvent('fast-collapse-cloud'));else window.close();});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='changed'||message?.type==='copilot.changed')void refresh();});
$('#hermes-refresh').onclick=()=>void feedback($('#hermes-refresh'),async()=>{await call({type:'copilot.fbl_fix'});await refresh();});
void refresh();setInterval(refresh,1500);

$('#popup-setup').onclick=()=>void openCopilot($('#popup-setup'));
