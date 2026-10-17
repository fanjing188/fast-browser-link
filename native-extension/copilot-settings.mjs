export const modeNames={saving:'省钱',balanced:'均衡',quality:'高质量',custom:'自定义'};
const keys=['inference_model','exec_model','max_parallel','daily_token_budget','context_limit','mode','turn_multiplier','exec_transport'];
const validModel=value=>!value||/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/.test(value);
function pick(catalog,tier){
 const rows=catalog?.available||[],patterns=tier==='fast'?[/luna/i,/haiku|mini|flash/i]:[/gpt-6\.1-sol/i,/gpt-6-sol|opus|pro(?!vider)/i];
 for(const pattern of patterns){const match=rows.find(row=>pattern.test(row.id.split(':').at(-1)));if(match)return match.id;}
 return '';
}
export function presetValues(mode,models={}){
 if(mode==='custom')return {mode};
 const high=mode==='quality',cheap=mode==='saving';
 return {mode,inference_model:pick(models.inference,high?'high':'fast'),exec_model:mode==='balanced'?'':pick(models.execution,high?'high':'fast'),max_parallel:cheap?1:3,daily_token_budget:cheap?50000:high?300000:100000,context_limit:6000,turn_multiplier:high?2:1};
}
export function readSettings(doc){
 const values={mode:doc.querySelector('input[name=mode]:checked').value};
 for(const key of keys.filter(key=>key!=='mode')){
  const field=doc.getElementById('setting-'+key);
  values[key]=key.endsWith('_model')?(field.value==='manual'?doc.getElementById(key+'-manual').value.trim():field.value):key==='exec_transport'?field.value:Number(field.value);
 }
 return values;
}
export class SettingsForm{
 constructor(doc,request){
  this.doc=doc;this.request=request;this.models={};this.dirty=false;this.state=null;this.loading=false;this.busy=false;
  doc.getElementById('copilot-settings-form').oninput=event=>{
   this.dirty=true;
   if(event.target.name!=='mode')doc.querySelector('input[name=mode][value=custom]').checked=true;
   this.manualFields();
  };
  for(const radio of doc.querySelectorAll('input[name=mode]'))radio.onchange=()=>{if(radio.checked){this.fill({...readSettings(doc),...presetValues(radio.value,this.models)});this.dirty=true;}};
  doc.getElementById('refresh-models').onclick=()=>this.load(true);
  doc.getElementById('start-copilot').onclick=()=>this.submit(true);
  doc.getElementById('save-copilot-settings').onclick=()=>this.submit(false);
 }
 manualFields(){for(const key of ['inference_model','exec_model'])this.doc.getElementById(key+'-manual').hidden=this.doc.getElementById('setting-'+key).value!=='manual';}
 fill(values){
  const doc=this.doc;
  for(const key of ['inference_model','exec_model']){
   const select=doc.getElementById('setting-'+key),role=key==='inference_model'?'inference':'execution',catalog=this.models[role]||{},value=values[key]||'';
   select.replaceChildren();
   const option=(text,id)=>{const item=doc.createElement('option');item.textContent=text;item.value=id;select.append(item);};
   option('使用 profile 默认'+(catalog.current?' · '+catalog.current:''),'');
   for(const row of catalog.available||[])option(row.label+(row.default?'（默认）':''),row.id);
   option('手动输入模型 ID…','manual');
   select.value=[...select.options].some(item=>item.value===value)?value:'manual';
   doc.getElementById(key+'-manual').value=value;
  }
  for(const key of keys.filter(key=>!key.endsWith('_model')&&key!=='mode'))this.doc.getElementById('setting-'+key).value=values[key]??(key==='turn_multiplier'?1:'');
  const radio=doc.querySelector(`input[name=mode][value="${Object.hasOwn(modeNames,values.mode)?values.mode:'balanced'}"]`);radio.checked=true;
  this.manualFields();
 }
 update(state){
  this.state=state;
  const config=state.config;
  if(!config)return;
  const signature=JSON.stringify(config);
  if(!this.dirty&&signature!==this.lastConfig){this.fill(config);this.lastConfig=signature;}
  const section=this.doc.getElementById('preflight');
  if(this.wasEnabled!==state.enabled)section.open=!state.enabled;
  this.wasEnabled=state.enabled;
  const summary=this.doc.getElementById('settings-summary');
  summary.textContent=`${state.enabled?'执行设置':'开启前设置'} · ${modeNames[config.mode]||'均衡'}${state.enabled?' · '+(config.inference_model.split(':').at(-1)||'默认')+' / '+(config.exec_model.split(':').at(-1)||'默认'):''}`;summary.title=summary.textContent;
  this.doc.getElementById('settings-current').textContent=`推理 ${config.inference_model||'profile 默认'} · 执行 ${config.exec_model||'profile 默认'}`;
  this.buttons();
 }
 buttons(){this.doc.getElementById('start-copilot').hidden=!!this.state?.enabled;this.doc.getElementById('save-copilot-settings').hidden=!this.state?.enabled;for(const id of ['start-copilot','save-copilot-settings'])this.doc.getElementById(id).disabled=this.busy||this.loading;this.doc.getElementById('refresh-models').disabled=this.loading;}
 async load(refresh=false){
  if(this.loading)return;
  this.loading=true;this.buttons();const message=this.doc.getElementById('models-message');message.textContent='正在读取 Hermes 模型，不调用推理…';
  try{
   this.models=await this.request('models',{refresh});
   message.textContent=[...new Set(Object.values(this.models).map(catalog=>catalog.error).filter(Boolean))].join(' ')||'模型已读取。按名称匹配预设，不代表实时价格排序。';
   const values=this.state?readSettings(this.doc):null;
   if(values){
    const initial=!this.state.settings_saved&&!this.dirty;
    this.fill(initial?{...values,...presetValues(values.mode,this.models)}:values);
    if(initial)this.dirty=true;
   }
  }catch{message.textContent='模型清单暂不可用，请刷新或手动填写 provider:model。';}
  finally{this.loading=false;this.buttons();}
 }
 async submit(start){
  if(this.busy||this.loading)return;
  const doc=this.doc,values=readSettings(doc);
  for(const key of ['inference_model','exec_model']){
   const field=doc.getElementById(key+'-manual');field.setCustomValidity(validModel(values[key])?'':'模型 ID 只接受字母、数字及 . _ : / @ + ~ -，不能含空格或命令参数。');
  }
  if(!doc.getElementById('copilot-settings-form').reportValidity())return;
  this.busy=true;this.buttons();
  try{
   let state=await this.request('configure',values);this.dirty=false;this.update(state);
   if(start){state=await this.request('settings',{enabled:true});this.update(state);}
   doc.getElementById('notice').textContent=start?'配置已保存，正在开启协作。':'设置已保存，下一次推理或执行生效；当前运行任务保持原配置。';
  }catch{doc.getElementById('notice').textContent='设置未完成，请检查本地连接、模型 ID 与数值后重试。';}
  finally{this.busy=false;this.buttons();}
 }
}
