import {boardName} from './copilot-controls.mjs';
export const modeNames={saving:'省钱',balanced:'均衡',quality:'高质量',custom:'自定义'};
const keys=['inference_model','exec_model','max_parallel','context_limit','mode','turn_multiplier','exec_transport'];
const validModel=value=>!value||/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/.test(value);
function pick(catalog,tier){
 const patterns=tier==='fast'?[/luna/i,/haiku|mini|flash/i]:[/gpt-6\.1-sol/i,/gpt-6-sol|opus|pro(?!vider)/i];
 for(const pattern of patterns){const row=(catalog?.available||[]).find(row=>pattern.test(row.id.split(':').at(-1)));if(row)return row.id;}return '';
}
export function presetValues(mode,models={}){
 if(mode==='custom')return {mode};const high=mode==='quality';
 return {mode,inference_model:pick(models.inference,high?'high':'fast'),exec_model:mode==='balanced'?'':pick(models.execution,high?'high':'fast'),max_parallel:mode==='saving'?1:3,context_limit:6000,turn_multiplier:high?2:1};
}
export function readSettings(doc){
 const values={mode:doc.querySelector('input[name=mode]:checked').value};
 for(const key of keys.filter(key=>key!=='mode')){const field=doc.getElementById('setting-'+key);values[key]=key.endsWith('_model')?(field.value==='manual'?doc.getElementById(key+'-manual').value.trim():field.value):key==='exec_transport'?field.value:Number(field.value);}return values;
}
export class SettingsForm{
 constructor(doc,request){
  this.doc=doc;this.request=request;this.models={};this.state=null;this.dirty=false;this.version=0;this.queue=Promise.resolve();this.timers=new Map();this.feedbackTimers=new Map();
  const form=doc.getElementById('copilot-settings-form');form.onsubmit=event=>event.preventDefault();
  form.oninput=event=>{
   const key=event.target.id?.replace(/^setting-/,'').replace(/-manual$/,'');if(!keys.includes(key))return;
   this.dirty=true;this.version++;if(key!=='mode')doc.querySelector('[name=mode][value=custom]').checked=true;this.manualFields();
   if(event.target.matches('input[type=number],input[id$="-manual"]')){clearTimeout(this.timers.get(key));this.timers.set(key,setTimeout(()=>void this.saveField(key),450));}
  };
  form.onchange=event=>{
   if(event.target.name==='mode'){const mode=event.target.value;this.version++;this.dirty=true;const values={...readSettings(doc),...presetValues(mode,this.models)};this.fill(values);void this.save(values,'mode');return;}
   const key=event.target.id?.replace(/^setting-/,'').replace(/-manual$/,'');if(!keys.includes(key))return;clearTimeout(this.timers.get(key));doc.querySelector('[name=mode][value=custom]').checked=true;this.dirty=true;this.version++;void this.saveField(key);
  };
  for(const [id,key] of [['ball','show_ball'],['selection-popup','selection_popup']])doc.getElementById(id).onchange=()=>void this.saveInterface(key,doc.getElementById(id).checked);
  for(const [id,key] of [['board-name-input','board_name'],['table-export-dir','table_export_dir'],['table-max-pages','table_max_pages'],['table-delay-min','table_delay_min'],['table-delay-max','table_delay_max']]){
   const field=doc.getElementById(id);if(field)field.onchange=async()=>{const feedback=doc.querySelector(`[data-feedback="${key}"]`)||doc.getElementById('preferences-feedback');feedback.textContent=this.t('保存中','Saving');const before=this.state,oldValue=key==='board_name'?before?.board_name||'':key==='table_export_dir'?before?.table_export_dir||'':before?.table_config?.[key.replace('table_','')];field.disabled=true;try{const value=field.type==='number'?Number(field.value):field.value;this.update(await request('preferences',{[key]:value}));feedback.classList.remove('failure');feedback.textContent=this.t('已保存','Saved');}catch{this.update(before);field.value=oldValue??'';feedback.classList.add('failure');feedback.textContent=this.t('保存失败，请重试','Save failed. Retry.');}finally{field.disabled=false;}};
  }
  for(const [id,key] of [['page-annotations','page_annotations'],['auto-zero','auto_zero'],['annotation-density','annotation_density']]){const field=doc.getElementById(id);if(field)field.onchange=async()=>{field.disabled=true;try{this.update(await request('preferences',{[key]:field.type==='checkbox'?field.checked:field.value}));this.feedback(key,'✓');}catch{this.update(this.state);this.feedback(key,this.t('保存失败，请重试','Save failed. Retry.'),true,field.onchange);}finally{field.disabled=false;}};}
  doc.getElementById('refresh-models').onclick=()=>this.load(true);
 }
 t(zh,en){return this.state?.locale==='en'?en:zh;}
 feedback(key,message,error=false,retryWork=null){
  const el=this.doc.querySelector(`[data-feedback="${key}"]`);if(!el)return;clearTimeout(this.feedbackTimers.get(key));el.textContent=message;el.setAttribute('aria-label',message==='✓'?this.t('已保存','Saved'):message);el.classList.toggle('failure',error);el.tabIndex=error?0:-1;el.toggleAttribute('data-retry',error);
  if(error){el.setAttribute('role','button');el.onclick=retryWork||(()=>['show_ball','selection_popup'].includes(key)?this.saveInterface(key,this.doc.getElementById(key==='show_ball'?'ball':'selection-popup').checked):key==='mode'?this.save(readSettings(this.doc),key):this.saveField(key));el.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();el.click();}};}
  else{el.removeAttribute('role');el.onclick=null;el.onkeydown=null;}
  if(message==='✓')this.feedbackTimers.set(key,setTimeout(()=>{el.textContent='';el.removeAttribute('aria-label');},1200));
 }

 manualFields(){for(const key of ['inference_model','exec_model'])this.doc.getElementById(key+'-manual').hidden=this.doc.getElementById('setting-'+key).value!=='manual';}
 fill(values){
  const doc=this.doc;
  for(const key of ['inference_model','exec_model']){
   const select=doc.getElementById('setting-'+key),catalog=this.models[key==='inference_model'?'inference':'execution']||{},value=values[key]||'';
   select.replaceChildren();const option=(text,id)=>{const node=doc.createElement('option');node.textContent=text;node.value=id;select.append(node);};
   option(this.t('使用 profile 默认','Use profile default')+(catalog.current?' · '+catalog.current:''),'');
   for(const row of catalog.available||[])option(row.label+(row.default?this.t('（默认）',' (default)'):''),row.id);
   option(this.t('手动输入模型 ID…','Enter model ID…'),'manual');select.value=[...select.options].some(row=>row.value===value)?value:'manual';doc.getElementById(key+'-manual').value=value;
  }
  for(const key of keys.filter(key=>!key.endsWith('_model')&&key!=='mode'))doc.getElementById('setting-'+key).value=values[key]??(key==='turn_multiplier'?1:'');
  doc.querySelector(`[name=mode][value="${Object.hasOwn(modeNames,values.mode)?values.mode:'balanced'}"]`).checked=true;this.manualFields();
 }
 update(state){this.state=state;for(const [id,key] of [['page-annotations','page_annotations'],['auto-zero','auto_zero'],['annotation-density','annotation_density']]){const field=this.doc.getElementById(id);if(field){if(field.type==='checkbox')field.checked=state[key]!==false;else field.value=state[key]||'compact';}}const name=this.doc.getElementById('board-name-input');if(name)name.placeholder=boardName('',state.locale||'zh');for(const [id,value] of [['board-name-input',state.board_name||''],['table-export-dir',state.table_export_dir||''],['table-max-pages',state.table_config?.max_pages||50],['table-delay-min',state.table_config?.delay_min||1.5],['table-delay-max',state.table_config?.delay_max||3]]){const input=this.doc.getElementById(id);if(input&&this.doc.activeElement!==input)input.value=value;}if(state.config&&!this.dirty&&JSON.stringify(state.config)!==this.lastConfig){this.fill(state.config);this.lastConfig=JSON.stringify(state.config);}this.doc.getElementById('ball').checked=state.show_ball!==false;this.doc.getElementById('selection-popup').checked=state.selection_popup!==false;}
 valid(values){
  for(const key of ['inference_model','exec_model'])this.doc.getElementById(key+'-manual').setCustomValidity(validModel(values[key])?'':this.t('模型 ID 格式无效','Invalid model ID'));
  return this.doc.getElementById('copilot-settings-form').reportValidity();
 }
 async saveField(key){
  const values=readSettings(this.doc);if(key.endsWith('_model')&&this.doc.getElementById('setting-'+key).value==='manual'&&!values[key])return;
  return this.save({[key]:values[key],mode:values.mode},key);
 }
 save(values,key){
  const all={...readSettings(this.doc),...values};if(!this.valid(all))return Promise.resolve(false);
  const version=this.version;this.feedback(key,this.t('保存中','Saving'));
  const job=this.queue.then(async()=>{try{const state=await this.request('configure',values);this.state=state;if(version===this.version){this.dirty=false;this.lastConfig=null;this.update(state);}this.feedback(key,'✓');return true;}catch{this.feedback(key,this.t('保存失败 · 重试','Save failed · retry'),true);return false;}});this.queue=job.then(()=>{});return job;
 }
 async saveInterface(key,value){const input=this.doc.getElementById(key==='show_ball'?'ball':'selection-popup');if(input.disabled)return;input.dataset.busy='true';input.disabled=true;this.feedback(key,this.t('保存中','Saving'));try{this.update(await this.request('settings',{[key]:value}));this.feedback(key,'✓');}catch{input.checked=this.state?.[key]!==false;this.feedback(key,this.t('保存失败 · 重试','Save failed · retry'),true,()=>this.saveInterface(key,value));}finally{delete input.dataset.busy;input.disabled=false;}}
 async load(refresh=false){
  if(this.loading)return this.loading;const button=this.doc.getElementById('refresh-models'),message=this.doc.getElementById('models-message');button.disabled=true;message.textContent=this.t('读取模型中…','Loading models…');
  this.loading=(async()=>{try{this.models=await this.request('models',{refresh});if(this.state)this.fill(readSettings(this.doc));message.textContent=Object.values(this.models).some(row=>row.error)?this.t('清单不完整，可手动填写模型 ID','Catalog incomplete; enter a model ID'):'';}catch{message.textContent=this.t('清单不可用，可手动填写模型 ID','Catalog unavailable; enter a model ID');}finally{button.disabled=false;this.loading=null;}})();return this.loading;
 }
 async enable(){
  await this.queue;const initial=!this.state?.settings_saved;
  try{
   if(initial){if(!Object.keys(this.models).length)await this.load();const values={...presetValues('balanced',this.models),exec_transport:this.state?.config?.exec_transport||'acp'};this.state=await this.request('configure',values);this.dirty=false;this.update(this.state);}
   this.update(await this.request('settings',{enabled:true}));if(initial)this.doc.getElementById('balanced-notice').hidden=false;return true;
  }catch{this.doc.getElementById('notice').textContent=this.t('未能开启，请检查本地连接后重试','Could not start. Check the local connection and retry.');return false;}
 }
 dispose(){for(const timer of [...this.timers.values(),...this.feedbackTimers.values()])clearTimeout(timer);}
}
