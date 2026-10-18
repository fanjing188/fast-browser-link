const INSTALL_DOCS='https://hermes-agent.nousresearch.com/docs/getting-started/installation';
export class AgentPanel {
 constructor(doc,request,{onChange=()=>{},language='zh',onEnable=async()=>{}}={}) {
  this.doc=doc;this.request=request;this.onChange=onChange;this.onEnable=onEnable;this.en=!language.startsWith('zh');this.dialog=doc.getElementById('agent-setup-dialog');this.cancelled=new Set();
  doc.getElementById('agent-settings-open').onclick=()=>this.open();
  doc.getElementById('agent-default-select').onchange=event=>this.select(event.target.value);
  doc.getElementById('agent-setup-select').onchange=event=>{if(this.busy||this.catalog?.busy){this.render();return;}this.selected=event.target.value;this.notice='';this.render();};
  doc.getElementById('agent-refresh').onclick=()=>this.job?.status==='pending'?this.resume():this.refresh({autoOpen:false});
  doc.getElementById('agent-setup-start').onclick=()=>this.start();
  doc.getElementById('agent-enable').onclick=()=>this.enable();
  doc.getElementById('agent-later').onclick=()=>this.close();
  this.dialog.addEventListener('close',()=>this.trigger?.isConnected&&this.trigger.focus());
 }
 t(zh,en){return this.en?en:zh;}
 agent(id=this.selected){return this.catalog?.agents?.find(agent=>agent.id===id);}
 ready(id=this.catalog?.default_agent){const agent=this.agent(id),job=this.job?.agent_id===id?this.job:null;return !!(!this.catalogError&&agent?.installed&&agent.configured&&(id!==this.catalog.default_agent||!this.catalog.onboarding_required)&&(!job||job.status==='completed'&&this.connectionChecked(job)));}
 connectionChecked(job){return job.connection?.inference==='connected'&&job.connection?.execution==='connected'&&job.connection?.check==='acp_initialize';}
 show(){if(this.disposed||this.dialog.open)return;this.trigger=this.doc.activeElement;this.dialog.showModal();const dropdown=this.doc.getElementById('agent-setup-select').nextElementSibling;const focus=dropdown?.matches('.shared-dropdown')?dropdown.querySelector('button'):this.doc.getElementById('agent-later');focus.focus();}
 close(){if(this.dialog.open)this.dialog.close();}
 async open(){this.show();return this.refresh({autoOpen:false});}
 apply(catalog){if(!catalog||!Array.isArray(catalog.agents))throw Error(this.t('Agent 检测回执不完整','Agent detection receipt is incomplete'));this.catalog=catalog;if(!this.agent())this.selected=catalog.default_agent||catalog.agents[0]?.id||'';if(catalog.job)this.job=catalog.job;this.onChange(catalog);}
 async refresh({autoOpen=true}={}) {
  if(this.disposed)return null;if(this.loading)return this.loading;
  const first=!this.detected;this.loading=(async()=>{try{const catalog=await this.request('agent_catalog',{});if(this.disposed)return null;this.apply(catalog);this.detected=true;this.catalogError='';this.notice=this.job?.status==='failed'?this.jobError(this.job):'';this.error=this.job?.status==='failed';this.render();if(autoOpen&&first&&catalog.onboarding_required)this.show();if(this.job?.status==='pending')void this.resume();return catalog;}catch(error){if(this.disposed)return null;this.catalogError=`${this.t('无法检测本地 Agent，请检查本地服务后重试。','Cannot detect local agents. Check the local service and retry.')} ${error.message}`;this.render();if(autoOpen&&first)this.show();return null;}finally{this.loading=null;}})();return this.loading;
 }
 async ensureReady(){await this.refresh({autoOpen:false});if(this.ready())return true;this.show();return false;}
 async select(id){
  if(this.disposed||this.busy||this.catalog?.busy)return;this.busy=true;this.notice='';this.render();
  try{const catalog=await this.request('agent_select',{agent_id:id});if(this.disposed)return;this.apply(catalog);this.selected=catalog.default_agent;this.error=false;this.defaultError='';this.notice=this.t('默认 Agent 已更新。','Default agent updated.');}
  catch(error){if(this.disposed)return;this.error=true;this.notice=`${this.t('未能切换默认 Agent，请关闭协作后重试。','Could not switch the default agent. Turn off collaboration and retry.')} ${error.message}`;this.defaultError=this.notice;}
  finally{if(!this.disposed){this.busy=false;this.render();}}
 }
 async start(){
  const agent=this.agent();if(this.disposed||this.busy||!agent?.can_setup)return;this.busy=true;this.notice='';this.error=false;this.render();
  try{const job=await this.request('agent_setup_start',{agent_id:agent.id});if(this.disposed){if(job.status==='pending')this.cancel(job.id);return;}this.job=job;this.render();await this.poll();}
  catch(error){if(!this.disposed){this.error=true;this.notice=`${this.t('配置未完成，请重试。','Setup did not complete. Retry.')} ${error.message}`;}}
  finally{if(!this.disposed){this.busy=false;this.render();}}
 }
 async resume(){if(this.disposed||this.busy)return;this.busy=true;this.notice='';this.error=false;this.render();try{await this.poll();}catch(error){if(!this.disposed){this.error=true;this.notice=`${this.t('读取进度失败，请重试检查。','Could not read setup progress. Retry the check.')} ${error.message}`;}}finally{if(!this.disposed){this.busy=false;this.render();}}}
 async poll(){
  while(!this.disposed&&this.job?.status==='pending') {
   await new Promise(resolve=>{this.wake=resolve;this.timer=this.doc.defaultView.setTimeout(()=>{this.timer=null;this.wake=null;resolve();},500);});
   if(this.disposed)return;const job=await this.request('agent_setup_status',{id:this.job.id});if(this.disposed)return;this.job=job;this.render();
  }
  if(this.disposed)return;
  if(this.job?.status==='completed'){
   if(!this.connectionChecked(this.job)){this.error=true;this.notice=this.t('配置回执缺少连接检查，请重新配置。','The receipt has no verified connection check. Run setup again.');return;}
   const catalog=await this.refresh({autoOpen:false});if(this.disposed||!catalog)return;this.notice=this.t('配置与连接检查已完成，可以开启协作。','Configuration and connection checks passed. You can start collaboration.');this.error=false;
  }else if(this.job?.status==='failed'){this.error=true;this.notice=this.jobError(this.job);}
  else if(this.job?.status==='cancelled'){this.notice=this.t('配置已取消，可以稍后重试。','Setup was cancelled. You can retry later.');}
 }
 jobError(job){const messages={engine_existing_configuration_requires_manual:this.t('已有安装或用户配置，请按官方指南修复，保留原配置。','An installation or user configuration already exists. Follow the official repair guide and preserve your existing configuration.'),auth_required:this.t('请先在本机终端运行 hermes model，完成模型配置后重试。','Run hermes model in your local terminal, configure the model, then retry.'),engine_install_failed:this.t('Hermes 安装未完成，请检查本机网络后重试。','Hermes installation failed. Check local connectivity and retry.'),engine_directory_exists:this.t('检测到现有安装目录，请核对本机 Hermes 后重试。','An installation directory already exists. Check the local Hermes installation and retry.'),profile_unmanaged:this.t('现有配置需要人工核对，请保留原配置并检查。','Existing configuration needs review. Preserve it and check locally.'),adapter_unavailable:this.t('浏览器适配器暂不可用，请检查本地安装后重试。','The browser adapter is unavailable. Check the local installation and retry.'),connection_failed:this.t('连接检查未通过，请检查本机模型配置后重试。','Connection checks failed. Check the local model configuration and retry.')};return messages[job.error]||this.t('配置未完成，请检查本地服务后重试。','Setup did not complete. Check the local service and retry.');}
 async enable(){
  if(this.disposed||this.busy)return;this.busy=true;this.render();
  try{if(this.selected!==this.catalog.default_agent){const catalog=await this.request('agent_select',{agent_id:this.selected});if(this.disposed)return;this.apply(catalog);}if(!this.ready()){this.error=true;this.notice=this.t('请先完成 Agent 配置与连接检查。','Complete agent setup and connection checks first.');return;}const started=await this.onEnable();if(this.disposed)return;if(started!==false)this.close();else{this.error=true;this.notice=this.t('协作尚未开启，请检查本地连接后重试。','Collaboration has not started. Check the local connection and retry.');}}
  catch(error){if(!this.disposed){this.error=true;this.notice=`${this.t('未能开启协作，请检查本地连接后重试。','Could not start collaboration. Check the local connection and retry.')} ${error.message}`;}}
  finally{if(!this.disposed){this.busy=false;this.render();}}
 }
 render(){
  if(this.disposed)return;const doc=this.doc,agent=this.agent(),pending=this.job?.status==='pending',ready=this.ready(this.selected),catalogError=!!this.catalogError;
  for(const id of ['agent-default-select','agent-setup-select']){
   const select=doc.getElementById(id),value=id==='agent-default-select'?this.catalog?.default_agent:this.selected;select.replaceChildren();
   for(const item of this.catalog?.agents||[]){const option=doc.createElement('option');option.value=item.id;option.textContent=item.name;select.append(option);}if(!select.options.length){const option=doc.createElement('option');option.textContent=this.t('尚未检测到 Agent','No agent detected');option.value='';select.append(option);}select.value=value||'';select.disabled=this.busy||pending||this.catalog?.busy||!this.catalog?.agents.length;
  }
  const busyMessage=this.catalog?.busy?this.t('关闭协作并等待任务完成后可切换或配置。','Turn off collaboration and wait for tasks to finish before switching or configuring.'):'';
  const status=doc.getElementById('agent-default-status'),current=this.agent(this.catalog?.default_agent);status.textContent=this.catalogError||this.defaultError||(current?this.t(current.configured?'已配置':'需要配置',current.configured?'Configured':'Setup required'):this.t('等待检测','Waiting for detection'));if(busyMessage)status.textContent+=` · ${busyMessage}`;status.dataset.state=catalogError||this.defaultError?'error':this.ready()?'ready':'idle';
  doc.getElementById('agent-detection').textContent=this.catalogError||(agent?this.t(agent.installed?'已检测到 ':'尚未安装 ',agent.installed?'Detected: ':'Not installed: ')+agent.name:this.t('请先检测本机 Agent。','Detect a local agent first.'));
  const notice=doc.getElementById('agent-setup-notice');notice.textContent=this.notice||this.catalogError||busyMessage;notice.dataset.error=String(!!this.error||catalogError);
  const help=doc.getElementById('agent-installation-help');help.hidden=this.job?.error!=='engine_existing_configuration_requires_manual';const guide=help.querySelector('a');guide.href=INSTALL_DOCS;guide.textContent=this.t('查看官方安装与修复指南 ↗','Official installation and repair guide ↗');doc.getElementById('agent-later').textContent=pending?this.t('后台继续','Continue in background'):this.t('稍后','Later');
  const start=doc.getElementById('agent-setup-start');start.hidden=ready;start.disabled=this.busy||pending||!agent?.can_setup||catalogError;start.textContent=agent?.setup_action==='install_engine'?this.t(`安装 ${agent.name} 并配置协作`,`Install ${agent.name} and configure collaboration`):this.t('配置并连接','Configure and connect');
  const enable=doc.getElementById('agent-enable');enable.hidden=!ready;enable.disabled=this.busy;enable.textContent=this.selected===this.catalog?.default_agent?this.t('开始协作','Start collaboration'):this.t('设为默认并开始','Set default and start');
  const refresh=doc.getElementById('agent-refresh');refresh.disabled=!!this.busy;refresh.textContent=pending?this.t('重试检查','Retry check'):this.t('重新检测','Detect again');for(const button of [start,enable,refresh])button.setAttribute('aria-busy',String(!!this.busy));
  const phase=this.job?.phase,failed=this.job?.status==='failed',configure=['install_engine','integration','profiles'].includes(phase),check=phase==='connection',completed=this.job?.status==='completed'&&this.connectionChecked(this.job);
  const states={detect:catalogError||failed&&phase==='detect'?'error':this.detected?'done':'active',configure:failed&&!check?'error':completed||check?'done':configure?'active':ready?'done':'idle',check:failed&&check?'error':completed||ready?'done':check?'active':'idle',ready:ready?'done':'idle'};
  const labels=new Map([['done',this.t('已完成','Complete')],['active',this.t('进行中','In progress')],['idle',this.t('等待开始','Waiting')],['error',this.t('需要处理','Needs attention')]]);
  for(const row of doc.querySelectorAll('#agent-setup-steps [data-step]')){const state=states[row.dataset.step];row.dataset.state=state;row.querySelector('.agent-step-status').textContent=labels.get(state);}
 }
 cancel(id){if(!id||this.cancelled.has(id))return;this.cancelled.add(id);void this.request('agent_setup_cancel',{id}).catch(()=>{});}
 dispose(){this.disposed=true;if(this.timer)this.doc.defaultView.clearTimeout(this.timer);this.wake?.();this.wake=null;if(this.job?.status==='pending')this.cancel(this.job.id);}
}
