import {mountControls,boardName,renderConnection} from './copilot-controls.mjs';
import {LogPanel} from './copilot-logs.mjs';
import {CapabilitiesPanel} from './copilot-capabilities-panel.mjs';
import {localize} from './copilot-i18n.mjs';
import {TablePanel} from './copilot-table-panel.mjs';
import {SettingsForm} from './copilot-settings.mjs';
import {renderDashboard,PanelViews} from './copilot-view.mjs';
const controls=mountControls(document);
let state=null,revision=0;
const uiLanguage=chrome.i18n?.getUILanguage?.()||navigator.language;document.title=boardName('',uiLanguage);document.getElementById('board-name').textContent=document.title;
const logs=new LogPanel(document,command,{language:uiLanguage,download:async text=>{const url=URL.createObjectURL(new Blob([text],{type:'application/x-ndjson'}));try{await chrome.downloads.download({url,filename:'fast-browser-link-logs-'+new Date().toISOString().slice(0,10)+'.jsonl',saveAs:true});}finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}}});
const views=new PanelViews(document,name=>{logs.active=name==='logs';if(name==='logs')void logs.load().then(()=>logs.latest());if(name==='settings')void settings.load();});
const capabilities=new CapabilitiesPanel(document,async(name,params={})=>{if(name==='learn_current'){const response=await chrome.runtime.sendMessage({type:'copilot.local',command:name,params});if(response?.error)throw Error(response.error);return response.result;}return command(name,params);},{language:chrome.i18n?.getUILanguage?.()||navigator.language});
const settings=new SettingsForm(document,command);
const tables=new TablePanel(document,async(name,params={})=>{
 if(['table_open','table_column_action'].includes(name))return command(name,params);
 if(name==='configuration')return state;
 const response=await chrome.runtime.sendMessage({type:'copilot.local',command:name,params});if(response?.error||!response?.result)throw Error('表格连接不可用');return response.result;
});
chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.tables_changed')void tables.refresh();if(message.type==='copilot.changed'&&message.event.type==='capabilities'&&document.getElementById('local-capabilities').open)void capabilities.refresh();});
async function command(name,params={}){
 if(name==='open_capabilities'){views.show('settings');document.getElementById('local-capabilities').open=true;await capabilities.refresh();return {};}

 let response;try{response=await chrome.runtime.sendMessage({type:'copilot.command',command:name,params});}catch(error){if(name==='state')void logs.connection(false);throw error;}
 if(response?.error||!response?.result){if(name==='state')void logs.connection(false);throw Error('本地连接未完成，请重新连接。');}
 if(name==='state')void logs.connection(true);
 if(name==='models')return response.result;
 if(name==='open_result')document.getElementById('notice').textContent='已在后台新标签页打开完整表';
 if(!Array.isArray(response.result.suggestions))return response.result;
 state=response.result;revision=state.revision;render();return state;
}
function render(){if(state){const title=boardName(state.board_name,uiLanguage);document.title=title;document.getElementById('board-name').textContent=title;renderConnection(document.getElementById('bridge-status'),{state:state.diagnostic==='bridge_disconnected'?'disconnected':'connected'},uiLanguage);renderConnection(document.getElementById('hermes-status'),state.hermes_health,uiLanguage);document.getElementById('hermes-retry').hidden=!['disconnected','error'].includes(state.hermes_health?.state);if(state.capability_focus&&render.capabilityFocus!==state.capability_focus){views.show('settings');document.getElementById('local-capabilities').open=true;render.capabilityFocus=state.capability_focus;void capabilities.refresh();}document.getElementById('selection-popup').checked=state.selection_popup!==false;const selected=document.getElementById('selected-text');selected.hidden=!state.selection_text;selected.querySelector('p').textContent=state.selection_text?.slice(0,300)||'';const tooLong=(state.selection_text?.length||0)>11800;document.getElementById('process-selection').disabled=tooLong;document.getElementById('selection-limit').hidden=!tooLong;renderDashboard(document,state,{command});settings.update(state);const history=document.getElementById('result-history');history.querySelector('summary').textContent=`历史结果 ${state.result_history?.length||0}`;const list=history.querySelector('div');list.replaceChildren();for(const row of [...state.result_history||[]].reverse()){const p=document.createElement('p');p.textContent=row.result?.verdict||row.title;const open=document.createElement('button');open.textContent='打开历史结果';open.onclick=()=>command('open_result',{id:row.id}).catch(failed);p.append(open);list.append(p);}if(state.focused_result&&state.focused_result!==render.focused){const card=[...document.querySelectorAll('article[data-id]')].find(item=>item.dataset.id===state.focused_result);if(card){card.querySelector('.result-preview')?.setAttribute('open','');card.querySelector('.result-details')?.setAttribute('open','');card.scrollIntoView({block:'nearest'});render.focused=state.focused_result;}}localize(document);controls.sync();}}
function failed(){document.getElementById('notice').textContent='连接暂时不可用，请确认本地服务已启动后刷新看板。';}
document.getElementById('process-selection').onclick=()=>command('quick_task',{action:'general.task',params:{task:(state.locale==='en'?'Explain the selected text:\n':'解释选中文本：\n')+state.selection_text}}).catch(failed);
document.getElementById('result-filter').onchange=render;
document.getElementById('clear-read').onclick=()=>command('clear_read').catch(failed);
document.getElementById('enabled').onchange=async event=>{const before=state?.enabled===true;event.target.disabled=true;event.target.dataset.busy='true';controls.sync();try{if(event.target.checked)await settings.enable();else await command('settings',{enabled:false});}catch{event.target.checked=before;failed();}finally{delete event.target.dataset.busy;event.target.disabled=false;event.target.checked=state?.enabled===true;controls.sync();}};
document.getElementById('open-settings').onclick=()=>views.show('settings');
document.getElementById('open-logs').onclick=()=>views.show('logs');document.getElementById('hermes-retry').onclick=async event=>{event.target.disabled=true;event.target.setAttribute('aria-busy','true');renderConnection(document.getElementById('hermes-status'),{state:'connecting'},uiLanguage);try{if(state?.startup_error)await settings.enable();else await command('state');}catch{failed();renderConnection(document.getElementById('hermes-status'),{state:'error',reason:'Local status unavailable'},uiLanguage);}finally{event.target.disabled=false;event.target.removeAttribute('aria-busy');}};
document.getElementById('dismiss-balanced').onclick=()=>{document.getElementById('balanced-notice').hidden=true;};
async function reconnect(){const button=document.getElementById('reconnect');button.disabled=true;try{const response=await chrome.runtime.sendMessage({type:'copilot.reconnect'});if(response?.error||!response?.result)throw Error('reconnect failed');state=response.result;revision=state.revision;render();await logs.connection(true);}catch{failed();}finally{button.disabled=false;}}
document.getElementById('reconnect').onclick=reconnect;
document.getElementById('retry-session').onclick=()=>{if(state?.diagnostic==='bridge_disconnected'){void reconnect();return;}if(state?.diagnostic?.startsWith('execution_acp')){void command('settings',{enabled:false}).then(()=>settings.enable()).catch(failed);return;}if(!state?.enabled)void settings.enable();else void command('retry_inference').catch(failed);};
chrome.runtime.connect({name:'copilot-panel'});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='copilot.changed'&&message.event.revision>revision)void command('state').catch(failed);});
setInterval(render,1000);
void command('locale',{language:chrome.i18n?.getUILanguage?.()||navigator.language}).then(()=>command('state')).then(()=>{void tables.refresh();return logs.load();}).catch(failed);

const localeObserver=new MutationObserver(records=>{if(records.every(record=>(record.target.nodeType===1?record.target:record.target.parentElement)?.closest('#logs-view')))return;localize(document,uiLanguage);});localeObserver.observe(document.body,{subtree:true,childList:true,characterData:true});localize(document,uiLanguage);

chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.open_capabilities'){views.show('settings');document.getElementById('local-capabilities').open=true;void capabilities.refresh();}});

chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.logs')logs.append({...message.event,revision:message.event.log_revision});});
window.addEventListener('unload',()=>{logs.dispose();settings.dispose();controls.dispose();});

chrome.runtime.onMessage.addListener(message=>{if(message.type!=='copilot.connection')return;void logs.connection(message.connected===true);if(message.connected)void command('state').catch(failed);else if(state){state={...state,diagnostic:'bridge_disconnected',ready:false};render();}});

chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.table_notice')document.getElementById('notice').textContent=message.removed?(uiLanguage.startsWith('zh')?'目标表格已消失，已取消':'Target removed; cancelled'):(uiLanguage.startsWith('zh')?'表格操作未完成，请重试':'Table action failed. Retry.');});

async function connections(){try{const response=await chrome.runtime.sendMessage({type:'copilot.connections'});const cloud=response?.result?.cloud;document.getElementById('sidebar-cloud').hidden=!cloud;if(cloud)renderConnection(document.getElementById('sidebar-cloud-status'),cloud,uiLanguage);}catch{document.getElementById('sidebar-cloud').hidden=true;}}
chrome.runtime.onMessage.addListener(message=>{if(message.type==='changed')void connections();});void connections();
