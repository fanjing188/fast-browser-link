import {actionNames,renderResult} from './copilot-result-view.mjs';
// 中文注释：看板文案集中映射；原始诊断只放在用户主动展开的详情里。
export {actionNames};
export const objectName=row=>row.params?.keyword||row.params?.url||row.params?.object||row.params?.value||row.title;
export function statePresentation(state){
 if(state.diagnostic==='bridge_disconnected')return {label:'出错',tone:'danger',message:'本地连接已断开，请重新连接。',action:'重新连接'};
 if(state.recovering)return {label:'正在重连',tone:'busy',message:state.inference_failure?.message||'Hermes 推理进程已退出，正在重连'};
 if(state.startup_error)return {label:'出错 · 重试',tone:'danger',message:state.locale==='en'?state.startup_error.reason_en:state.startup_error.reason,action:'重试'};
 if(state.diagnostic&&state.inference_failure)return {label:'出错',tone:'danger',message:state.inference_failure.message,action:'重试'};
 if(state.diagnostic?.startsWith('execution_acp'))return {label:'出错',tone:'danger',message:'执行会话连接失败，自动重连机会已用完。请检查执行 profile 后重新连接。',action:'重新连接'};
 if(state.diagnostic)return {label:'出错',tone:'danger',message:state.diagnostic.startsWith('acp_start')?'推理会话启动失败。请确认精简 profile 可用，然后重试。':state.diagnostic.startsWith('acp_transport')?'推理连接已断开，请重新开启协作。':'本次推理未完成，已保留原建议。继续浏览可重试。',action:'重试'};
 if(!state.enabled)return {label:'未开启',tone:'muted',message:'开启后只读跟随你的浏览操作。'};
 if(!state.ready)return {label:'启动中',tone:'busy',message:'正在连接推理会话…'};
 if(state.idle_paused)return {label:'空闲已暂停',tone:'muted',message:'继续浏览，协作会自动恢复。'};
 if(state.running)return {label:'推理中',tone:'busy',message:'正在根据当前操作更新建议…'};
 return {label:'跟随中',tone:'success',message:'继续浏览，协作会根据你的操作给出建议。'};
}
const num=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:1});
function node(doc,tag,text,className){const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
export function renderDashboard(doc,state,{command,clipboard=globalThis.navigator?.clipboard}={},now=Date.now()){
 const $=id=>doc.getElementById(id),status=statePresentation(state),active=doc.activeElement;
 const focused=active?.dataset?.action,focusedCard=active?.closest('article')?.dataset.id;
 $('enabled').checked=!!state.enabled;$('enabled').disabled=$('enabled').dataset.busy==='true'||state.diagnostic==='bridge_disconnected';$('ball').checked=state.show_ball!==false;
 $('status').textContent=status.label;$('status').dataset.tone=status.tone;$('status').title=status.message;
 $('retry-session').textContent=status.action||'重试';
 const notice=$('notice');if(state.inference_failure&&!state.diagnostic){notice.textContent=state.inference_failure.message;notice.dataset.source='inference';}else if(notice.dataset.source==='inference'){notice.textContent='';delete notice.dataset.source;}
 $('error').hidden=!state.diagnostic;$('error-copy').textContent=status.message;$('error-code').textContent=state.diagnostic||'';
 const total=usage=>Object.values(usage||{}).reduce((sum,value)=>sum+Number(value||0),0),en=state.locale==='en';
 const short=value=>!en&&value>=10000?(value/10000).toLocaleString('zh-CN',{maximumFractionDigits:1})+' 万':num(value);
 $('usage-label').textContent=`${en?'Today':'今日'} ${state.daily_estimated_tokens?'≈':''}${short(total(state.daily_usage)||state.daily_tokens||0)} tokens`;
 $('session-usage').textContent=`${en?'Session':'本次'} ${state.estimated_tokens?'≈':''}${num(total(state.usage)||state.tokens||0)}`;
 for(const key of ['input','cache_read','output'])$('usage-'+key).textContent=num(state.daily_usage?.[key]);
 const byModel=$('model-usage');byModel.replaceChildren();
 for(const [caption,usage] of [['今日按模型',state.daily_model_usage],['本次按模型',state.model_usage]]){
  if(!usage||!Object.keys(usage).length)continue;
  const table=node(doc,'table');table.append(node(doc,'caption',caption));const head=node(doc,'tr');
  for(const title of ['模型','输入','缓存读','输出'])head.append(node(doc,'th',title));const thead=node(doc,'thead');thead.append(head);table.append(thead);
  const body=node(doc,'tbody');for(const [model,counts] of Object.entries(usage)){const tr=node(doc,'tr');for(const value of [model==='unknown'?'未归属 / 历史用量':model,num(counts.input),num(counts.cache_read),num(counts.output)])tr.append(node(doc,'td',value));body.append(tr);}table.append(body);byModel.append(table);
 }
 const groups={pending:[],running:[],results:[]};
 for(const row of state.suggestions||[])groups[row.status==='pending'?'pending':['queued','executing','stopping'].includes(row.status)?'running':'results'].push(row);
 $('suggestions-count').textContent=String(groups.pending.length);$('running-count').dataset.native=String(groups.running.length);$('running-count').textContent=String(groups.running.length+doc.querySelectorAll('#running .table-job[data-active=true]').length);$('results-count').textContent=String(groups.results.length);
 groups.results.sort((a,b)=>(b.finished_at||0)-(a.finished_at||0));
 const resultMap=new Map(groups.results.map(row=>[row.id,row])),tree=[],visited=new Set();
 const add=row=>{if(visited.has(row.id))return;visited.add(row.id);tree.push(row);for(const child of groups.results.filter(item=>item.parent_id===row.id))add(child);};
 for(const row of groups.results.filter(item=>!resultMap.has(item.parent_id)))add(row);for(const row of groups.results)add(row);groups.results=tree;
 const wanted=$('result-filter')?.value||'',visibleResults=new Set();
 for(const row of groups.results){if(wanted&&row.action!==wanted)continue;const seen=new Set();for(let item=row;item&&!seen.has(item.id);item=resultMap.get(item.parent_id)){seen.add(item.id);visibleResults.add(item.id);}}
 const older=$('older-results');if(older){older.hidden=groups.results.length<=20;if(older._filter!==wanted){older.open=!!wanted;older._filter=wanted;}}
 const button=(label,action,row,extra={})=>{const b=node(doc,'button',label);b.type='button';b.dataset.action=action;b.setAttribute('aria-label',`${label}：${objectName(row)}`);b.onclick=async()=>{b.disabled=true;try{await command(action,{id:row.id,...extra});}catch{doc.getElementById('notice').textContent='操作未完成，请核对本地连接后重试。';}finally{b.disabled=false;}};return b;};
 const alive=new Set((state.suggestions||[]).map(row=>row.id));
 for(const article of doc.querySelectorAll('article[data-id]'))if(!alive.has(article.dataset.id)&&!article._removeTimer&&!article._held&&!article.contains(doc.activeElement)&&!article.querySelector('details[open]')){article.classList.add('leaving');article.setAttribute('aria-hidden','true');article._removeTimer=setTimeout(()=>article.remove(),180);}
 for(const [group,rows] of Object.entries(groups)){
  const container=$(group),empty=container.querySelector('.empty');empty?.remove();
  if(!rows.length&&(group!=='running'||!doc.querySelector('#running .table-job[data-active=true]')))container.append(node(doc,'p',group==='pending'?'暂无建议':group==='running'?'暂无进行中的任务':'暂无结果','empty'));
  let queueIndex=0,resultIndex=0;
  for(const row of rows){
   let article=[...doc.querySelectorAll('article[data-id]')].find(el=>el.dataset.id===row.id);
   if(!article){article=node(doc,'article',undefined,'task new');article.dataset.id=row.id;const hold=()=>{void Promise.resolve(command?.('suggestion_hold',{id:row.id,held:!!article._held||!!article.querySelector('details[open]')})).catch(()=>{});};article.addEventListener('toggle',hold,true);article.addEventListener('pointerenter',()=>{article._held=true;clearTimeout(article._removeTimer);article._removeTimer=null;article.classList.remove('leaving');hold();});article.addEventListener('pointerleave',()=>{article._held=false;hold();});}
   if(group==='results'){
    article.hidden=!!wanted&&!visibleResults.has(row.id);article.classList.toggle('filter-context',!!wanted&&row.action!==wanted&&visibleResults.has(row.id));
    const parent=row.parent_id&&[...doc.querySelectorAll('article[data-id]')].find(item=>item.dataset.id===row.parent_id&&item!==article);
    if(parent){let children=parent.querySelector(':scope > .child-results');if(!children){children=node(doc,'div',undefined,'child-results');parent.append(children);}children.append(article);}
    else{const older=$('older-results');if(older&&resultIndex++>=20){older.hidden=false;older.querySelector('div').append(article);}else container.append(article);}
   }
   clearTimeout(article._removeTimer);article._removeTimer=null;article.classList.remove('leaving');article.removeAttribute('aria-hidden');if(group!=='results')container.append(article);
   const attachedChildren=article.querySelector(':scope > .child-results');
   const openDetails=[...article.querySelectorAll('details')].map(detail=>detail.open);
   if(group==='results'&&article._signature===JSON.stringify(row))continue;
   if(group==='results')article._signature=JSON.stringify(row);
   article.classList.toggle('child-result',!!row.parent_id);
   const outcome=row.completion_status==='partial'?(en?`Partial (${row.result?.missing?.length||0} gaps)`:`部分完成（缺 ${row.result?.missing?.length||0} 项）`):row.status==='failed'?(en?'Failed':'失败'):row.completion_status==='completed'?(en?'Completed':'完成'):'';
   const title=node(doc,'h3',row.title),meta=node(doc,'div',undefined,'meta');
   const symbol=node(doc,'span',({'seo.keyword_check':'⌕','seo.longtail':'⋈','seo.competitor_keywords':'↔','seo.serp_breakdown':'≡','seo.save_pool':'✓','table.export':'▦'})[row.action]||'○');symbol.setAttribute('aria-hidden','true');meta.append(symbol);if(row.automatic)meta.append(node(doc,'span',en?'Automatic':'自动','tag'));
   meta.append(node(doc,'span',row.scene==='general'?'通用':'SEO','tag'),node(doc,'span',actionNames[row.action]||'通用任务'));
   article.replaceChildren(meta,title,node(doc,'p',objectName(row),'object'));
   const actions=node(doc,'div',undefined,'actions');
   if(group==='pending'){article.append(node(doc,'p',row.why,'reason'));const run=button('执行','execute',row);run.className='primary';if(row.missing_capabilities?.length){run.disabled=true;actions.append(button('绑定能力','open_capabilities',row));}actions.append(run,button('忽略','ignore',row));}
   if(group==='running'){
    const seconds=Math.max(0,Math.floor((now-(row.started_at||row.queued_at||now/1000)*1000)/1000));
    const step=row.status==='queued'?`排队中（第 ${++queueIndex} 个）`:row.status==='stopping'?'停止中，正在回收执行进程…':row.action==='workflow.run'?(row.step||'正在准备工作流…'):stepName(row.step);
    if(typeof row.candidate_count==='number')article.append(node(doc,'p',`已取到 ${row.candidate_count} 个候选，正在${row.action==='seo.longtail'?'分组':'判读'}…`,'candidate-progress'));
    article.append(node(doc,'p',step,'step'),node(doc,'p',`已用 ${seconds} 秒 · ${num(row.tokens)} tokens`,'small'));
    if(row.workflow_total){const progress=doc.createElement('progress');progress.max=row.workflow_total;progress.value=row.workflow_completed||0;progress.setAttribute('aria-label',en?'Task progress':'任务进度');article.append(progress);}
    const stop=button(row.status==='stopping'?'停止中…':'停止','stop',row);stop.disabled=row.status==='stopping';actions.append(stop);
   }
   if(group==='results'){
    article.classList.toggle('failed',row.status==='failed');
    if(outcome)article.append(node(doc,'p',outcome,'completion-status'));
    if(row.result)renderResult(doc,article,row,{command,clipboard});
    else{article.append(node(doc,'p',row.status==='stopped'?'已停止，已发生的操作不会撤销。':row.reason||'执行未完成，请检查本地连接或数据源后重试。','failure'));actions.append(button('重试','retry',row));}
   }
   if(row.usage){const details=node(doc,'details',undefined,'task-usage');details.append(node(doc,'summary','任务用量明细'),node(doc,'p',`输入 ${num(row.usage.input)} · 缓存读 ${num(row.usage.cache_read)} · 输出 ${num(row.usage.output)}`));article.append(details);}
   if(group!=='pending'){
    const label=row.model_source==='local'?'模型：本地处理，无模型调用':row.model?`模型：${row.model}${row.model_source==='acp'?' · ACP 会话':row.model_source==='hermes'?' · Hermes 启动回报':row.model_source==='cache'?' · 缓存来源':' · 已选择，待回报'}`:'模型：尚未回报';
    article.append(node(doc,'p',label,'model-label'));
   }
   article.append(actions);if(group==='results'){const preview=node(doc,'details',undefined,'result-preview'),summary=node(doc,'summary',row.title+(outcome?' · '+outcome:'')+(row.status==='failed'&&row.reason?'：'+row.reason.slice(0,80):''));summary.title=row.reason||row.title;preview.append(summary,...article.childNodes);article.append(preview);}if(attachedChildren)article.append(attachedChildren);
   [...article.querySelectorAll('details')].forEach((detail,index)=>{detail.open=!!openDetails[index];});
  }
 }
 if(focused&&focusedCard){const article=[...doc.querySelectorAll('article[data-id]')].find(el=>el.dataset.id===focusedCard);[...article?.querySelectorAll('button')||[]].find(b=>b.dataset.action===focused)?.focus();}
}
export function stepName(value){
 if(!value)return '正在准备任务…';
 if(/google_suggest|keyword_metrics|serp_top10|competitor_keywords/.test(value))return '正在由本地脚本取数…';
 if(value==='model')return '正在判读已采集的数据…';
 if(/web|search/i.test(value))return '正在查询网页与搜索数据…';
 if(/terminal|script|code/i.test(value))return '正在运行查询脚本…';
 if(/browser|page|snapshot/i.test(value))return '正在读取任务工作页…';
 if(/result/i.test(value))return '正在整理结果与报告…';
 return '正在处理任务…';
}

export class PanelViews{
 constructor(doc,onShow=()=>{}){this.doc=doc;this.onShow=onShow;this.current='work';for(const el of doc.querySelectorAll('[data-back]'))el.onclick=()=>this.show('work');doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.current!=='work'){event.preventDefault();this.show('work');}});}
 show(name){if(!['work','settings','logs'].includes(name))return;const old=this.current;this.current=name;this.doc.getElementById('work-view').hidden=name!=='work';for(const page of ['settings','logs']){const el=this.doc.getElementById(page+'-view');el.dataset.active=String(name===page);el.inert=name!==page;el.toggleAttribute('inert',name!==page);el.setAttribute('aria-hidden',String(name!==page));}if(name==='work')this.doc.getElementById('open-'+old)?.focus();else this.doc.querySelector('#'+name+'-view [data-back]')?.focus();this.onShow(name);}
}
