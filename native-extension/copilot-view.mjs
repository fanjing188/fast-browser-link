import {statusNode,icon,readableCopy} from './ui-design.mjs';
import {actionNames,normalized} from './copilot-result-view.mjs';
// 中文注释：看板文案集中映射；原始诊断只放在用户主动展开的详情里。
export {actionNames};
export const objectName=row=>row.params?.keyword||row.params?.url||row.params?.object||row.params?.value||row.title;

export function renderWorkContext(doc,state,{command}={}){
 const root=doc.getElementById('work-context');if(!root)return;root._workState=state;root._workCommand=command;
 const en=state.locale==='en',work=state.work||{},form=doc.getElementById('work-form'),input=doc.getElementById('work-direction'),notice=doc.getElementById('work-notice');
 const agent=state.agent||{},health=agent.state?agent:state.hermes_health||{},name=agent.name||'Agent',fullName=/Agent$/i.test(name)?name:name+' Agent';
 const starting=state.agent_connecting||state.enabled&&(state.recovering||!state.ready||health.state==='connecting');
 const failed=state.diagnostic||state.startup_error||health.state==='error'||state.ready&&health.state!=='connected';
 const activity=!state.enabled&&!state.agent_connecting?'paused':failed?'error':starting?'connecting':state.idle_paused?'paused':state.running||(state.suggestions||[]).some(row=>row.status==='executing')?'advancing':'following';
 root.dataset.activity=activity;
 const collaborating=en?`${name} collaborating`:`${name}协作中`;
 const statuses={advancing:collaborating,following:collaborating,connecting:en?`Connecting to ${fullName}`:`正在连接 ${fullName}`,paused:!state.enabled?(en?'Collaboration is off':'协作未开启'):(en?`${name} paused`:`${name}协作已暂停`),error:en?`${name} connection unavailable`:`${name}连接未就绪`};
 const status=doc.getElementById('work-status');status.textContent=statuses[activity];status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const goal=state.user_direction||work.goal||(en?'Learning from your browsing…':'正在从你的操作了解工作…');
 doc.getElementById('work-goal').textContent=goal;doc.getElementById('work-log-goal').textContent=work.goal||goal;
 const direction=doc.getElementById('work-user-direction');direction.hidden=!state.user_direction;direction.textContent=(en?'Your direction: ':'你的方向：')+(state.user_direction||'');
 const next=doc.getElementById('work-next');next.hidden=!work.next_step;next.textContent=(en?'Next: ':'下一步：')+(work.next_step||'');
 const facts=doc.getElementById('work-facts');facts.replaceChildren();
 for(const [key,label] of [['evidence',en?'Observed':'已有依据'],['constraints',en?'Constraints':'约束'],['open_questions',en?'Unknown':'待确认']])for(const value of work[key]||[])facts.append(node(doc,'li',`${label}：${value}`));
 doc.getElementById('work-facts-empty').hidden=!!facts.childNodes.length;
 const feedback=doc.getElementById('work-feedback');feedback.replaceChildren();
 const feedbackNames=en?{wrong:'Wrong direction',later:'Later',done:'Done'}:{wrong:'方向不对',later:'稍后',done:'已完成'};
 for(const item of state.work_feedback||[])feedback.append(node(doc,'li',`${feedbackNames[item.kind]||item.kind} · ${item.object||item.action||''}`));
 doc.getElementById('work-feedback-empty').hidden=!!feedback.childNodes.length;
 if(!input._dirty&&doc.activeElement!==input&&!form._pending)input.value=state.user_direction||'';
 if(form._bound)return;form._bound=true;
 const directionDialog=doc.getElementById('work-direction-dialog'),thinkingDialog=doc.getElementById('work-thinking-dialog');
 const open=(dialog,trigger,focus)=>{if(dialog.open)return;dialog._trigger=trigger;dialog.showModal();focus?.focus();};
 const close=dialog=>dialog.close();
 for(const dialog of [directionDialog,thinkingDialog])dialog.addEventListener('close',()=>dialog._trigger?.focus());
 doc.getElementById('work-adjust').onclick=()=>{if(!input._dirty&&!form._pending)input.value=root._workState.user_direction||'';notice.textContent='';open(directionDialog,doc.getElementById('work-adjust'),input);};
 doc.getElementById('work-thinking').onclick=()=>open(thinkingDialog,doc.getElementById('work-thinking'),doc.getElementById('work-thinking-close'));
 doc.getElementById('work-direction-cancel').onclick=()=>close(directionDialog);
 doc.getElementById('work-thinking-close').onclick=()=>close(thinkingDialog);
 input.oninput=()=>{input._dirty=true;notice.textContent='';};
 const update=async params=>{
  if(form._pending)return;form._pending=true;const submitted=input.value,reset=!!params.reset,target=reset?doc.getElementById('work-reset-notice'):notice;
  const buttons=[...form.querySelectorAll('button'),doc.getElementById('work-new')];for(const button of buttons)button.disabled=true;
  form.setAttribute('aria-busy','true');target.textContent='';
  try{
   const result=await root._workCommand('work_update',params);
   if(input.value===submitted){input._dirty=false;if(reset)input.value='';}
   if(result?.work||typeof result?.user_direction==='string')renderWorkContext(doc,result,{command:root._workCommand});
   if(reset){if(thinkingDialog.open)close(thinkingDialog);}else if(directionDialog.open)close(directionDialog);
  }catch{target.textContent=root._workState.locale==='en'?'Update failed. Keep your text and retry.':'更新未完成，已保留输入，请重试。';}
  finally{form._pending=false;form.removeAttribute('aria-busy');for(const button of buttons)button.disabled=false;}
 };
 form.onsubmit=event=>{event.preventDefault();void update({direction:input.value});};
 doc.getElementById('work-new').onclick=()=>update({reset:true});
}
function rawStatePresentation(state){
 if(state.diagnostic==='bridge_disconnected')return {label:'出错',tone:'danger',message:'本地连接已断开，请重新连接。',action:'重新连接'};
 if(state.recovering)return {label:'正在重连',tone:'busy',message:state.inference_failure?.message||'Hermes 推理进程已退出，正在重连'};
 if(state.startup_error)return {label:'出错 · 重试',tone:'danger',message:state.locale==='en'?state.startup_error.reason_en:state.startup_error.reason,action:'重试'};
 if(state.diagnostic&&state.inference_failure)return {label:'出错',tone:'danger',message:state.inference_failure.message,action:'重试'};
 if(state.diagnostic?.startsWith('execution_acp'))return {label:'出错',tone:'danger',message:'执行会话连接失败，自动重连机会已用完。请检查执行配置后重新连接。',action:'重新连接'};
 if(state.diagnostic)return {label:'出错',tone:'danger',message:state.diagnostic.startsWith('acp_start')?'推理会话启动失败。请确认推理配置可用，然后重试。':state.diagnostic.startsWith('acp_transport')?'推理连接已断开，请重新开启协作。':'本次推理未完成，已保留原建议。继续浏览可重试。',action:'重试'};
 if(!state.enabled)return {label:'未开启',tone:'muted',message:'开启后只读跟随你的浏览操作。'};
 if(!state.ready)return {label:'启动中',tone:'busy',message:'正在连接推理会话…'};
 if(state.idle_paused)return {label:'空闲已暂停',tone:'muted',message:'继续浏览，协作会自动恢复。'};
 if(state.running||(state.suggestions||[]).some(row=>row.status==='executing'))return {label:'执行中',tone:'busy',message:'正在根据当前操作更新建议…'};
 return {label:'跟随中',tone:'success',message:'继续浏览，协作会根据你的操作给出建议。'};
}
export function statePresentation(state){const value=rawStatePresentation(state);return {...value,message:readableCopy(value.message,state.locale||'zh')};}
const num=value=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:1});
function node(doc,tag,text,className){const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
const textKey=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const words=value=>new Set([...new Intl.Segmenter(undefined,{granularity:'word'}).segment(textKey(value))].filter(item=>item.isWordLike).map(item=>item.segment));
export function rankedSuggestions(rows,state){
 const target=textKey(state.tool_context?.selection||state.selection_text||state.tool_context?.current?.object),targetWords=words(target);
 const relevance=row=>{const object=textKey([objectName(row),...(row.params?.keywords||[])].join(' '));if(!target||!object)return 0;if(object===target)return 1;const candidate=words(object),intersection=[...targetWords].filter(word=>candidate.has(word)).length;return intersection/Math.max(1,new Set([...targetWords,...candidate]).size);};
 return rows.map((row,index)=>({row,index,score:relevance(row)})).sort((a,b)=>Number(!!b.row.local_table)-Number(!!a.row.local_table)||b.score-a.score||Number(!!a.row.missing_capabilities?.length)-Number(!!b.row.missing_capabilities?.length)||a.index-b.index).slice(0,10).map(item=>item.row);
}
const elapsedLabel=(seconds,en)=>en?`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} elapsed`:`已用 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
function resultSummary(doc,article,row){
 const result=normalized(row),summary=node(doc,'p',readableCopy(row.reason||result.verdict||'结果已保存',doc.documentElement.lang||'zh'),'verdict compact-copy');summary.title=summary.textContent;article.append(summary);
 const metrics=node(doc,'div',undefined,'result-metrics');for(const metric of (result.metrics||[]).slice(0,3))metrics.append(node(doc,'span',`${metric.label} ${metric.value}`));if(metrics.childNodes.length)article.append(metrics);
}
export function renderDashboard(doc,state,{command}={},now=Date.now()){
 renderWorkContext(doc,state,{command});
 const $=id=>doc.getElementById(id),status=statePresentation(state),active=doc.activeElement;
 renderConnectionNotice(doc,state);
 const focused=active?.dataset?.action,focusedCard=active?.closest('article')?.dataset.id;
 $('enabled').checked=!!state.enabled;$('enabled').disabled=$('enabled').dataset.busy==='true'||state.diagnostic==='bridge_disconnected';$('ball').checked=state.show_ball!==false;

 $('retry-session').textContent=status.action||'重试';
 renderStateNotice($('notice'),state);
 $('error').hidden=true;$('error-copy').textContent=status.message;$('error-code').textContent=state.diagnostic||'';
 const total=usage=>Object.values(usage||{}).reduce((sum,value)=>sum+Number(value||0),0),en=state.locale==='en';
 const short=value=>!en&&value>=10000?(value/10000).toLocaleString('zh-CN',{maximumFractionDigits:1})+' 万':num(value);
 $('usage-label').textContent=`${en?'Today':'今日'} ${state.daily_estimated_tokens?'≈':''}${short(total(state.daily_usage)||state.daily_tokens||0)} tokens`;
 if($('about-usage'))$('about-usage').textContent=$('usage-label').textContent.replace(/^(?:今日|Today)\s*/, '');
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
 for(const row of state.suggestions||[])groups[row.status==='pending'||row.automatic&&row.status==='completed'?'pending':['queued','executing','stopping'].includes(row.status)?'running':'results'].push(row);
 groups.pending=rankedSuggestions(groups.pending,state);
 updateDashboardTabs(doc,state);
 $('suggestions-count').textContent=String(groups.pending.length);$('running-count').dataset.native=String(groups.running.length);$('running-count').textContent=String(groups.running.length+doc.querySelectorAll('#running .table-job[data-active=true]').length);$('results-count').textContent=String(groups.results.length);
 groups.results.sort((a,b)=>(b.finished_at||0)-(a.finished_at||0));
 const resultMap=new Map(groups.results.map(row=>[row.id,row])),tree=[],visited=new Set();
 const add=row=>{if(visited.has(row.id))return;visited.add(row.id);tree.push(row);for(const child of groups.results.filter(item=>item.parent_id===row.id))add(child);};
 for(const row of groups.results.filter(item=>!resultMap.has(item.parent_id)))add(row);for(const row of groups.results)add(row);groups.results=tree;
 const wanted=$('result-filter')?.value||'',visibleResults=new Set();
 for(const row of groups.results){if(wanted&&row.action!==wanted)continue;const seen=new Set();for(let item=row;item&&!seen.has(item.id);item=resultMap.get(item.parent_id)){seen.add(item.id);visibleResults.add(item.id);}}
 const history=$('result-history');if(history)history.hidden=!(state.result_history||[]).length;
 const older=$('older-results');if(older){older.hidden=groups.results.length<=20;older.querySelector('summary').textContent=(en?'Show earlier ':'显示更早 ')+Math.max(0,groups.results.length-20)+(en?' results':' 条');if(older._filter!==wanted){older.open=!!wanted;older._filter=wanted;}}
 const button=(label,action,row,extra={})=>{const b=node(doc,'button',label);b.type='button';b.dataset.action=action;b.setAttribute('aria-label',`${label}：${objectName(row)}`);b.onclick=async function(){const target=this;if(target.disabled||!target.isConnected)return;target.disabled=true;target.setAttribute('aria-busy','true');const card=target.closest('article');if(action==='feedback'&&card)card._dismissed=true;try{await command(action,{id:row.id,...extra});}catch(error){if(card)card._dismissed=false;const notice=doc.getElementById('notice');notice.hidden=false;notice.dataset.source='action';notice.setAttribute('role','alert');notice.textContent=error.message||'操作未完成，请核对本地连接后重试。';}finally{target.disabled=target._stateDisabled===true;target.removeAttribute('aria-busy');}};return b;};
 const contextChanged=doc._contextRevision!==undefined&&doc._contextRevision!==(state.context_revision||0);doc._contextRevision=state.context_revision||0;
 if(contextChanged&&$('notice').dataset.source==='action'){$('notice').textContent='';delete $('notice').dataset.source;}
 const alive=new Set(Object.values(groups).flat().map(row=>row.id)),offered=new Set((state.suggestions||[]).map(row=>row.id)),positions=new Map();let primaryAssigned=false;
 // 中文注释：顺序未变时不挪动节点，避免鼠标按下和抬起之间刷新导致点击丢失。
 const place=(parent,article)=>{const index=positions.get(parent)||0,sibling=parent.children[index];if(sibling!==article)parent.insertBefore(article,sibling||null);positions.set(parent,index+1);};
 for(const article of doc.querySelectorAll('article[data-id]'))if(!alive.has(article.dataset.id)&&offered.has(article.dataset.id)&&article.parentElement?.id==='pending')article.hidden=true;
 for(const article of doc.querySelectorAll('article[data-id]'))if(!alive.has(article.dataset.id)&&!article._removeTimer&&(contextChanged||article._dismissed||offered.has(article.dataset.id)||!article._held&&!article.contains(doc.activeElement)&&!article.querySelector('details[open]'))){article.classList.add('leaving');article.setAttribute('aria-hidden','true');article._removeTimer=setTimeout(()=>article.remove(),180);}
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
    if(parent){let children=parent.querySelector(':scope > .child-results');if(!children){children=node(doc,'div',undefined,'child-results');parent.append(children);}place(children,article);}
    else{const older=$('older-results');if(older&&resultIndex++>=20){older.hidden=false;place(older.querySelector('div'),article);}else place(container,article);}
   }
   clearTimeout(article._removeTimer);article._removeTimer=null;article.classList.remove('leaving');article.removeAttribute('aria-hidden');if(group!=='results'){article.hidden=false;place(container,article);}
   const attachedChildren=article.querySelector(':scope > .child-results');
   const openDetails=[...article.querySelectorAll('details')].map(detail=>detail.open);
   if(article._signature===JSON.stringify(row)){
    if(group==='running'){const elapsed=article.querySelector('.elapsed');if(elapsed)elapsed.textContent=elapsedLabel(Math.max(0,Math.floor((now-(row.started_at||row.queued_at||now/1000)*1000)/1000)),en);if(row.status==='queued')article.querySelector('.step').textContent=`排队中（第 ${++queueIndex} 个）`;}
    if(article.querySelector('.actions .primary'))primaryAssigned=true;
    continue;
   }
   article._signature=JSON.stringify(row);article.dataset.group=group;
   article.classList.toggle('child-result',!!row.parent_id);
   const outcome=row.completion_status==='partial'?(en?`Partial (${row.result?.missing?.length||0} gaps)`:`部分完成（缺 ${row.result?.missing?.length||0} 项）`):row.status==='failed'?(en?'Failed':'失败'):row.completion_status==='completed'?(en?'Completed':'完成'):'';
   const title=node(doc,'h3',row.title),meta=node(doc,'div',undefined,'meta');
   if(row.automatic)meta.append(node(doc,'span',en?'Automatic':'自动','tag'));
   if(group==='pending'){if(row.risk!=='zero')meta.append(node(doc,'span',en?'Uses quota':'耗额度','cost'));}else meta.append(statusNode(doc,row.status==='queued'?'queued':group==='running'?'running':row.status==='failed'?'failed':row.status==='stopped'?'stopped':row.completion_status==='partial'?'partial':'connected',{language:state.locale||'zh',label:group==='results'?outcome||undefined:undefined}));
   const heading=node(doc,'div',undefined,'task-heading'),context=node(doc,'div',undefined,'task-context'),content=doc.createDocumentFragment();
   if(group!=='pending'){const symbol=icon(doc,({'seo.keyword_check':'search','seo.longtail':'branch','seo.competitor_keywords':'globe','seo.serp_breakdown':'search','seo.save_pool':'pool','table.export':'table'})[row.action]||'play');symbol.setAttribute('aria-hidden','true');heading.append(symbol);}
   heading.append(title);if(meta.childNodes.length)heading.append(meta);context.append(node(doc,'p',objectName(row),'object'));content.append(heading,context);
   const actions=node(doc,'div',undefined,'actions');
   if(group==='pending'&&row.automatic&&row.result){resultSummary(doc,content,row);actions.append(button(en?'Details':'详情','open_result',row,{popup:true}),button(en?'Logs':'日志','task_logs',row));}
   else if(group==='pending'){const reason=node(doc,'p',row.why,'reason compact-copy');reason.title=row.why||'';context.append(reason);const run=button('执行','execute',row);if(row.missing_capabilities?.length){run.disabled=true;actions.append(button('绑定能力','open_capabilities',row));}else if(!primaryAssigned){run.className='primary';primaryAssigned=true;}actions.append(run);for(const [kind,label] of [['later',en?'Later':'稍后'],['wrong',en?'Wrong direction':'方向不对']]){const feedback=button(label,'feedback',row,{kind});feedback.dataset.action='feedback-'+kind;actions.append(feedback);}}
   if(group==='running'){
    const seconds=Math.max(0,Math.floor((now-(row.started_at||row.queued_at||now/1000)*1000)/1000));
    const step=row.status==='queued'?`排队中（第 ${++queueIndex} 个）`:row.status==='stopping'?'停止中，正在回收执行进程…':stepName(row.step);
    const copy=node(doc,'p',step,'step compact-copy');copy.title=step;content.append(copy,node(doc,'p',elapsedLabel(seconds,en),'small elapsed'));
    if(row.workflow_total){const progress=doc.createElement('progress');progress.max=row.workflow_total;progress.value=row.workflow_completed||0;progress.setAttribute('aria-label',en?'Task progress':'任务进度');content.append(progress);}
    const stop=button(row.status==='stopping'?'停止中…':'停止','stop',row);stop.disabled=row.status==='stopping';actions.append(stop,button(en?'Logs':'日志','task_logs',row));
   }
   if(group==='results'){
    article.classList.toggle('failed',row.status==='failed');
    resultSummary(doc,content,row);
    if(row.resume_from)content.append(node(doc,'p',en?`Continue from step ${row.resume_from}`:`从第 ${row.resume_from} 步继续`,'resume-from'));
    if(row.rerun_warning){const warning=node(doc,'p',row.rerun_warning,'failure compact-copy');warning.title=row.rerun_warning;content.append(warning);}
    actions.append(button(en?'Details':'详情','open_result',row,{popup:true}));if(!row.local_table)actions.append(button(en?'Logs':'日志','task_logs',row));
    if(['failed','stopped'].includes(row.status)||row.result?.missing?.length)actions.prepend(button(row.resume_from?'继续':'重试','retry',row));
   }
   // 中文注释：步骤刷新只替换文案区域；操作区按动作键复用，避免点击目标消失或丢失在途锁。
   const currentActions=article.querySelector(':scope > .actions')||actions;
   if(currentActions!==actions){
    const existing=new Map([...currentActions.children].map(button=>[button.dataset.action,button])),wanted=new Set([...actions.children].map(button=>button.dataset.action));
    for(const button of [...currentActions.children])if(!wanted.has(button.dataset.action))button.remove();
    for(const [index,next] of [...actions.children].entries()){
     const button=existing.get(next.dataset.action)||next;
     if(button!==next){if(button.textContent!==next.textContent)button.textContent=next.textContent;button.className=next.className;button.setAttribute('aria-label',next.getAttribute('aria-label'));button.onclick=next.onclick;}
     button._stateDisabled=next.disabled;button.disabled=next.disabled||button.getAttribute('aria-busy')==='true';
     if(currentActions.children[index]!==button)currentActions.insertBefore(button,currentActions.children[index]||null);
    }
   }else for(const button of currentActions.children)button._stateDisabled=button.disabled;
   for(const child of [...article.childNodes])if(child!==currentActions&&child!==attachedChildren)child.remove();
   article.insertBefore(content,currentActions.parentNode===article?currentActions:attachedChildren);
   if(currentActions.parentNode!==article)article.insertBefore(currentActions,attachedChildren);
   [...article.querySelectorAll('details')].forEach((detail,index)=>{detail.open=!!openDetails[index];});
  }
 }
 const runButtons=[...doc.querySelectorAll('#pending article:not([hidden]) [data-action=execute]')],primary=runButtons.find(button=>!button.disabled);for(const button of runButtons)button.classList.toggle('primary',button===primary);
 if(focused&&focusedCard){const article=[...doc.querySelectorAll('article[data-id]')].find(el=>el.dataset.id===focusedCard);[...article?.querySelectorAll('button')||[]].find(b=>b.dataset.action===focused)?.focus();}
}
export function stepName(value){
 if(!value)return '正在准备任务…';
 if(!/^[a-z][a-z0-9_.:-]*$/i.test(value))return readableCopy(value);
 if(/google_suggest|keyword_metrics|serp_top10|competitor_keywords/.test(value))return '正在由本地脚本取数…';
 if(value==='model')return '正在判读已采集的数据…';
 if(/web|search/i.test(value))return '正在查询网页与搜索数据…';
 if(/terminal|script|code/i.test(value))return '正在运行查询脚本…';
 if(/browser|page|snapshot/i.test(value))return '正在读取任务工作页…';
 if(/result/i.test(value))return '正在整理结果与报告…';
 return readableCopy(value);
}

export function selectDashboardTab(doc,name){
 if(!['pending','running','results','logs'].includes(name))return;
 doc.documentElement.dataset.dashboardTab=name;
 for(const tab of doc.querySelectorAll('[data-tab]')){const active=tab.dataset.tab===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
 for(const pane of doc.querySelectorAll('[data-pane]'))pane.hidden=pane.dataset.pane!==name;
 doc.dispatchEvent(new doc.defaultView.CustomEvent('dashboard-tab',{detail:name}));
}
export function defaultDashboardTab(rows,previous=[]){
 const old=new Map(previous.map(row=>[row.id,row.status]));const changed=rows.filter(row=>old.get(row.id)!==row.status);
 const latest=[...changed].sort((a,b)=>(b.finished_at||b.started_at||b.queued_at||0)-(a.finished_at||a.started_at||a.queued_at||0))[0];
 if(!latest)return null;return latest.status==='pending'||latest.automatic&&latest.status==='completed'?'pending':['queued','executing','stopping'].includes(latest.status)?'running':'results';
}
function updateDashboardTabs(doc,state){
 if(!doc._dashboardTabs){doc._dashboardTabs={rows:[]};const tabs=[...doc.querySelectorAll('[data-tab]')];tabs.forEach((tab,i)=>{tab.onclick=()=>selectDashboardTab(doc,tab.dataset.tab);tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowLeft'?tabs.length-1:1))%tabs.length;tabs[index].click();tabs[index].focus();};});}
 const rows=state.suggestions||[],next=defaultDashboardTab(rows,doc._dashboardTabs.rows);doc._dashboardTabs.rows=rows.map(({id,status})=>({id,status}));
 if(next)selectDashboardTab(doc,next);else if(!doc.documentElement.dataset.dashboardTab)selectDashboardTab(doc,'pending');
}
export class PanelViews{
 constructor(doc,onShow=()=>{}){this.doc=doc;this.onShow=onShow;this.current='work';for(const el of doc.querySelectorAll('[data-back]'))el.onclick=()=>this.show('work');doc.addEventListener('dashboard-tab',event=>this.onShow(event.detail==='logs'?'logs':'work'));doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.current!=='work'){event.preventDefault();this.show('work');}});}
 show(name){if(!['work','settings','logs'].includes(name))return;const old=this.current;this.current=name==='settings'?'settings':'work';this.doc.getElementById('work-view').hidden=name==='settings';const el=this.doc.getElementById('settings-view');el.dataset.active=String(name==='settings');el.inert=name!=='settings';el.toggleAttribute('inert',name!=='settings');el.setAttribute('aria-hidden',String(name!=='settings'));if(name==='logs')selectDashboardTab(this.doc,'logs');if(name==='work')this.doc.getElementById('open-'+old)?.focus();else if(name==='settings')el.querySelector('[data-back]')?.focus();this.onShow(name);}
}

export function renderConnectionNotice(doc,state){const root=doc.getElementById('connection-notice');if(!root)return;const health=state.agent?.state?state.agent:state.hermes_health;root.hidden=!(state.diagnostic||state.bridge_lost||state.enabled&&['error','disconnected'].includes(health?.state));doc.getElementById('connection-message').textContent=readableCopy(health?.reason,state.locale||'zh')||statePresentation(state).message;doc.getElementById('repair-connection').textContent=statePresentation(state).action||(state.locale==='en'?'Repair':'修复');}

export function renderStateNotice(notice,state){
 const en=state.locale==='en';
 const message=state.bridge_recovery_blocked?state.hermes_health?.reason||(en?'Automatic recovery stopped':'连续三次连接中断，已停止自动恢复')
  :state.bridge_lost||state.diagnostic==='bridge_disconnected'?(en?'Browser connection interrupted; reconnecting':'浏览器与本地服务连接中断，正在重连')
  :state.discovery_changed?(en?'Tool changes detected. Review bindings again.':'发现工具变化，请重新确认绑定')
  :state.inference_failure?.message||'';
 if(message){notice.textContent=message;notice.dataset.source='state';notice.hidden=!!state.diagnostic||!!state.bridge_lost||!!state.bridge_recovery_blocked;}
 else if(['state','inference','bridge','connection'].includes(notice.dataset.source)){notice.replaceChildren();delete notice.dataset.source;notice.hidden=false;}
}

export function showTaskConfirmation(doc,value,command){
 doc.getElementById('task-confirmation')?.remove();
 const root=node(doc,'section',undefined,'confirmation-card');root.id='task-confirmation';root.dataset.taskId=value.id;root.dataset.command=value.command||'execute';root.setAttribute('role','alert');
 root.append(node(doc,'p',value.message||'不可逆或对外动作：再次确认后执行。'));
 const confirm=node(doc,'button','确认执行'),cancel=node(doc,'button','取消');confirm.type=cancel.type='button';
 confirm.onclick=async()=>{confirm.disabled=true;try{const result=await command(value.command||'execute',{id:value.id,confirmation:value.token});if(!result?.secondary_required)root.remove();}catch{root.querySelector('p').textContent='确认未完成，请检查连接后重试。';}finally{confirm.disabled=false;}};
 cancel.onclick=()=>root.remove();root.append(confirm,cancel);doc.getElementById('notice').after(root);confirm.focus();return root;
}
