import {renderStatus} from './ui-design.mjs';
// 中文注释：只有真实扩展界面点击才能生成、替换、断开或跳转；状态未知时不借用旧配对信息。
const cloudElement=id=>document.getElementById(id);
const cloudChinese=(chrome.i18n?.getUILanguage?.()||navigator.language||'zh').startsWith('zh');
const cloudT=(zh,en)=>cloudChinese?zh:en;
let cloudState=null,cloudLocalConnected=null,cloudBusy=false,cloudCopiedCode=null,cloudCopyTimer;
const cloudDialog=cloudElement('cloud-dialog');
if(!cloudChinese){cloudElement('cloud-expand').setAttribute('aria-label','Cloud Agent connection');cloudElement('cloud-dialog-close').setAttribute('aria-label','Collapse pairing panel');cloudElement('cloud-error-close').setAttribute('aria-label','Dismiss cloud error');cloudDialog.querySelector('section').setAttribute('aria-label','Cloud pairing');}
if(!cloudChinese)cloudElement('cloud-access-detail').textContent='Confirming pairing lets cloud agents read, click and fill cloud-created task pages without per-site or per-action approval. Existing personal tabs are not authorized.';
function expandCloud(open){cloudDialog.dataset.open=String(open);cloudDialog.inert=!open;cloudElement('cloud-expand').setAttribute('aria-expanded',String(open));if(!open)cloudElement('cloud-expand').focus();}
function cloudError(message){cloudElement('cloud-error').textContent=message;cloudElement('cloud-error-bar').hidden=false;}
cloudElement('cloud-error-close').addEventListener('click',()=>{cloudElement('cloud-error-bar').hidden=true;});
async function cloudCall(message){const response=await chrome.runtime.sendMessage(message);if(!response||response.error||!response.result)throw Error(cloudT('云端操作未确认，请检查连接状态。','Cloud action unconfirmed. Check connection.'));return response.result;}
function cloudRender(){
 const state=cloudState||{},paired=state.paired===true,online=state.state==='active'&&paired&&state.online===true&&!state.error&&cloudLocalConnected!==false;
 const reconnecting=state.state==='connecting'||paired&&(state.state==='offline'||cloudLocalConnected===false);
 const failed=!!state.error||['expired','revoked'].includes(state.state);
 if(state.error&&cloudElement('cloud-error-bar').hidden)cloudError(cloudT('云端连接失败，请重试','Cloud connection failed. Try again.'));
 const label=cloudT(online?'已配对':reconnecting?(paired?'正在重连':'连接中'):failed?'出错':paired?'已配对':state.state==='pending_pairing'?'等待配对':state.state==='unavailable'?'未连接':state.state==='unpaired'?'未配对':'检查中',online?'Paired':reconnecting?(paired?'Reconnecting':'Connecting'):failed?'Error':paired?'Paired':state.state==='pending_pairing'?'Pairing':state.state==='unavailable'?'Disconnected':state.state==='unpaired'?'Not paired':'Checking');
 renderStatus(cloudElement('cloud-status'),online?'connected':reconnecting?'running':failed?'failed':'idle',{language:cloudChinese?'zh':'en',label,bare:true});cloudElement('cloud-status').dataset.state=online?'active':reconnecting?'connecting':failed?'error':'disconnected';cloudElement('cloud-status').dataset.online=String(online);
 cloudElement('cloud-detail').textContent=cloudT(online?'已配对且在线 · 云端任务页可直接读取和操作。':paired?'已配对但未在线 · 恢复连接后才能访问云端任务页。':state.state==='unavailable'?'连接状态待确认，不能证明配对或授权。':'未配对 · 在网页端确认配对后才可访问云端任务页。',online?'Paired and online. Cloud task pages can be read and operated directly.':paired?'Paired but offline. Reconnect before accessing cloud task pages.':state.state==='unavailable'?'Status unknown; pairing and access are not confirmed.':'Not paired. Confirm pairing on the web before accessing cloud task pages.');
 cloudElement('cloud-connect').textContent=cloudT(failed?'重试':paired?'管理':'配对',failed?'Retry':paired?'Manage':'Pair');cloudElement('cloud-connect').disabled=cloudBusy||cloudLocalConnected!==true;cloudElement('cloud-expand').disabled=cloudLocalConnected!==true;cloudElement('cloud-connect').hidden=online;
 cloudElement('cloud-dialog-state').textContent=paired?cloudElement('cloud-detail').textContent:cloudElement('cloud-access-detail').textContent;
 cloudElement('cloud-code-panel').hidden=paired;cloudElement('cloud-code').textContent=state.code||'—';
 const seconds=Math.max(0,Math.ceil(((state.expiresAt||0)-Date.now())/1000));
 cloudElement('cloud-code-expiry').textContent=paired?'':state.code?seconds>0?cloudT(`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} 后过期`,`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} remaining`):cloudT('已过期','Expired'):cloudT('未生成','No code');
 cloudElement('cloud-copy-code').disabled=cloudBusy||!state.code||seconds===0;
 cloudElement('cloud-copy-code').textContent=state.code&&cloudCopiedCode===state.code?cloudT('已复制','Copied'):cloudT('复制','Copy code');
 cloudElement('cloud-open-web').disabled=cloudBusy||!state.site;cloudElement('cloud-regenerate').disabled=cloudBusy;
 cloudElement('cloud-regenerate').textContent=cloudT(paired?'重新配对':'重新生成',paired?'Pair again':'Regenerate');cloudElement('cloud-disconnect').textContent=cloudT('断开','Disconnect');cloudElement('cloud-disconnect').hidden=!paired;cloudElement('cloud-disconnect').disabled=cloudBusy;
}
async function cloudAct(button,action){
 if(cloudBusy)return;cloudBusy=true;button.dataset.feedback='loading';button.setAttribute('aria-busy','true');cloudRender();
 try{await action();button.dataset.feedback='success';setTimeout(()=>{if(button.dataset.feedback==='success')delete button.dataset.feedback;},900);}
 catch(error){delete button.dataset.feedback;cloudError(error.message||cloudT('操作失败，请重试','Action failed. Try again.'));}
 finally{cloudBusy=false;button.removeAttribute('aria-busy');cloudRender();}
}
cloudElement('cloud-expand').addEventListener('click',event=>{if(event.isTrusted)expandCloud(cloudDialog.dataset.open!=='true');});
cloudElement('cloud-connect').addEventListener('click',event=>{if(!event.isTrusted)return;expandCloud(true);if(!cloudState?.paired||cloudState.error)void cloudAct(event.currentTarget,async()=>{cloudState=await cloudCall({type:'cloud_connect'});});});
cloudElement('cloud-dialog-close').addEventListener('click',()=>expandCloud(false));window.addEventListener('fast-collapse-cloud',()=>expandCloud(false));
cloudElement('cloud-open-web').addEventListener('click',event=>{if(event.isTrusted)void cloudAct(event.currentTarget,async()=>{const result=await cloudCall({type:'cloud_open_web'});if(result.opened!==true)throw Error(cloudT('配对网页未打开，请重试','Pairing page did not open. Try again.'));window.close();});});
cloudElement('cloud-copy-code').addEventListener('click',async event=>{
 if(!event.isTrusted||cloudBusy||!cloudState?.code)return;
 const button=cloudElement('cloud-copy-code'),code=cloudState.code;
 await cloudAct(button,async()=>{try{await navigator.clipboard.writeText(code);}catch{throw Error(cloudT('无法复制，请选中连接码复制。','Cannot copy. Select and copy the code.'));}if(cloudState?.code===code){cloudCopiedCode=code;clearTimeout(cloudCopyTimer);cloudCopyTimer=setTimeout(()=>{cloudCopiedCode=null;cloudRender();},1500);}});
});
cloudElement('cloud-regenerate').addEventListener('click',event=>{if(event.isTrusted)void cloudAct(event.currentTarget,async()=>{cloudState=await cloudCall({type:'cloud_connect',replace:cloudState?.paired===true});});});
cloudElement('cloud-disconnect').addEventListener('click',event=>{if(event.isTrusted)void cloudAct(event.currentTarget,async()=>{cloudState=await cloudCall({type:'cloud_disconnect'});});});
window.addEventListener('fast-browser-link-status',event=>{if(!event.detail)cloudLocalConnected=false;else if(Object.hasOwn(event.detail,'localConnected'))cloudLocalConnected=event.detail.localConnected===true;cloudState=event.detail||{state:'unavailable',online:false,paired:false};cloudRender();});
cloudRender();setInterval(cloudRender,1000);
