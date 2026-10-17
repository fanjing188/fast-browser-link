import {CapabilitiesPanel} from './copilot-capabilities-panel.mjs';
import {localize} from './copilot-i18n.mjs';
import {TablePanel} from './copilot-table-panel.mjs';
import {SettingsForm} from './copilot-settings.mjs';
import {renderDashboard} from './copilot-view.mjs';
let state=null,revision=0;
const capabilities=new CapabilitiesPanel(document,async(name,params={})=>{if(name==='learn_current'){const response=await chrome.runtime.sendMessage({type:'copilot.local',command:name,params});if(response?.error)throw Error(response.error);return response.result;}return command(name,params);},{language:chrome.i18n?.getUILanguage?.()||navigator.language});
const settings=new SettingsForm(document,command);
const tables=new TablePanel(document,async(name,params={})=>{
 if(['table_open','table_column_action'].includes(name))return command(name,params);
 if(name==='configuration')return state;
 const response=await chrome.runtime.sendMessage({type:'copilot.local',command:name,params});if(response?.error||!response?.result)throw Error('表格连接不可用');return response.result;
});
chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.tables_changed')void tables.refresh();if(message.type==='copilot.changed'&&message.event.type==='capabilities'&&document.getElementById('local-capabilities').open)void capabilities.refresh();});
async function command(name,params={}){
 if(name==='open_capabilities'){document.getElementById('local-capabilities').open=true;await capabilities.refresh();return {};}

 const response=await chrome.runtime.sendMessage({type:'copilot.command',command:name,params});
 if(response?.error||!response?.result)throw Error('本地连接未完成，请刷新看板或重新开启协作。');
 if(name==='models')return response.result;
 if(name==='open_result')document.getElementById('notice').textContent='已在后台新标签页打开完整表';
 if(!Array.isArray(response.result.suggestions))return response.result;
 state=response.result;revision=state.revision;render();return state;
}
function render(){if(state){if(state.capability_focus&&render.capabilityFocus!==state.capability_focus){document.getElementById('local-capabilities').open=true;render.capabilityFocus=state.capability_focus;void capabilities.refresh();}document.getElementById('selection-popup').checked=state.selection_popup!==false;const selected=document.getElementById('selected-text');selected.hidden=!state.selection_text;selected.querySelector('p').textContent=state.selection_text?.slice(0,300)||'';const tooLong=(state.selection_text?.length||0)>11800;document.getElementById('process-selection').disabled=tooLong;document.getElementById('selection-limit').hidden=!tooLong;renderDashboard(document,state,{command});settings.update(state);const history=document.getElementById('result-history');history.querySelector('summary').textContent=`历史结果 ${state.result_history?.length||0}`;const list=history.querySelector('div');list.replaceChildren();for(const row of [...state.result_history||[]].reverse()){const p=document.createElement('p');p.textContent=row.result?.verdict||row.title;const open=document.createElement('button');open.textContent='打开历史结果';open.onclick=()=>command('open_result',{id:row.id}).catch(failed);p.append(open);list.append(p);}if(state.focused_result&&state.focused_result!==render.focused){const card=[...document.querySelectorAll('article[data-id]')].find(item=>item.dataset.id===state.focused_result);if(card){card.querySelector('.result-details')?.setAttribute('open','');card.scrollIntoView({block:'nearest'});render.focused=state.focused_result;}}localize(document);}}
function failed(){document.getElementById('notice').textContent='连接暂时不可用，请确认本地服务已启动后刷新看板。';}
document.getElementById('selection-popup').onchange=event=>command('settings',{selection_popup:event.target.checked}).catch(failed);
document.getElementById('process-selection').onclick=()=>command('quick_task',{action:'general.task',params:{task:(state.locale==='en'?'Explain the selected text:\n':'解释选中文本：\n')+state.selection_text}}).catch(failed);
document.getElementById('result-filter').onchange=render;
document.getElementById('clear-read').onclick=()=>command('clear_read').catch(failed);
document.getElementById('enabled').onchange=event=>{if(event.target.checked)void settings.submit(true);else void command('settings',{enabled:false}).catch(failed);};
document.getElementById('ball').onchange=event=>command('settings',{show_ball:event.target.checked}).catch(failed);
document.getElementById('refresh').onclick=()=>command('state').catch(failed);
document.getElementById('retry-session').onclick=()=>{if(state?.diagnostic?.startsWith('execution_acp')){void command('settings',{enabled:false}).then(()=>settings.submit(true)).catch(failed);return;}if(!state?.enabled)void settings.submit(true);else void command('retry_inference').catch(failed);};
chrome.runtime.connect({name:'copilot-panel'});
chrome.runtime.onMessage.addListener(message=>{if(message?.type==='copilot.changed'&&message.event.revision>revision)void command('state').catch(failed);});
setInterval(render,1000);
void command('locale',{language:chrome.i18n?.getUILanguage?.()||navigator.language}).then(()=>command('state')).then(()=>{void tables.refresh();return settings.load();}).catch(failed);

const uiLanguage=chrome.i18n?.getUILanguage?.()||navigator.language;
const localeObserver=new MutationObserver(()=>localize(document,uiLanguage));localeObserver.observe(document.body,{subtree:true,childList:true,characterData:true});localize(document,uiLanguage);

chrome.runtime.onMessage.addListener(message=>{if(message.type==='copilot.open_capabilities'){document.getElementById('local-capabilities').open=true;void capabilities.refresh();}});
