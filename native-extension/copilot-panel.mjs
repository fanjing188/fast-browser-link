const $=id=>document.getElementById(id);
let state=null,revision=0;
const progress=new Map();
async function command(command,params={}){
 const response=await chrome.runtime.sendMessage({type:'copilot.command',command,params});
 if(response?.error||!response?.result)throw Error(response?.error||'本地桥没有返回看板状态');
 state=response.result;revision=state.revision;render();return state;
}
function text(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
function button(label,action,id){const node=text('button',label);node.onclick=async()=>{node.disabled=true;try{await command(action,{id});}catch(error){showError(error);}finally{node.disabled=false;}};return node;}
function showError(error){$('error').hidden=false;$('error').textContent=error.message;}
function render(){
 $('usage').textContent=`本次 Token：${state.tokens??0} · 今日 ${state.daily_tokens??0} / ${state.daily_budget??'—'} · ${state.estimated_tokens?`其中估算 ${state.estimated_tokens}`:'Hermes usage'}`;
 $('enabled').checked=state.enabled;$('ball').checked=state.show_ball;
 $('status').textContent=state.idle_paused?'空闲暂停，继续浏览后恢复':state.running?'正在分析当前页面…':`${state.enabled?'协作已开启':'采集已暂停'}${state.last_refresh?' · 更新于 '+new Date(state.last_refresh*1000).toLocaleTimeString():''}`;
 $('error').hidden=!state.diagnostic;if(state.diagnostic)$('error').textContent=state.diagnostic==='daily_token_budget_exhausted'?'今日 Token 预算已用尽，推理已暂停。':'协作受阻：'+state.diagnostic+'。请检查 Hermes 配置后重试。';
 const groups={pending:[],running:[],results:[]};
 for(const row of state.suggestions)groups[row.status==='pending'?'pending':['queued','executing','stopping'].includes(row.status)?'running':'results'].push(row);
 $('suggestions-count').textContent=String(groups.pending.length);
 for(const [name,rows] of Object.entries(groups)){
  const parent=$(name);parent.replaceChildren();
  if(!rows.length)parent.append(text('p',name==='pending'?(state.enabled?'继续浏览，建议会随页面更新。':'开启协作后开始读取页面并生成建议。'):name==='running'?'执行中的任务会显示在这里。':'任务完成后，结论与报告路径会显示在这里。','empty'));
  for(const row of rows){
   const article=document.createElement('article');article.append(text('h3',row.title));
   if(row.tokens!==undefined)article.append(text('p',`任务 Token：${row.tokens}${row.cache_hit?' · 缓存命中':''}`,'why'));
   const actions=document.createElement('div');actions.className='actions';
   if(name==='pending'){article.append(text('p',row.why,'why'));const execute=button('执行','execute',row.id);execute.className='execute';actions.append(execute,button('忽略','ignore',row.id));}
   if(name==='running'){article.append(text('p',row.status==='queued'?'排队等待执行':progress.get(row.id)||'Hermes 正在执行…','why'));const stop=button(row.status==='stopping'?'停止中…':'停止','stop',row.id);stop.disabled=row.status==='stopping';actions.append(stop);}
   if(name==='results'){
    article.append(text('p',row.status==='completed'?row.result?.summary:row.status==='stopped'?'已停止；已发生的操作不会撤销。':'执行或落盘失败，请核对报告及词池状态。',row.status==='failed'?'failure':''));
    if(row.result?.keywords?.length){const table=document.createElement('table');const tr=document.createElement('tr');for(const title of ['关键词','量','KD'])tr.append(text('th',title));table.append(tr);for(const word of row.result.keywords){const line=document.createElement('tr');for(const value of [word.keyword,word.vol??'—',word.kd??'—'])line.append(text('td',String(value)));table.append(line);}article.append(table);}
    if(row.result?.details){const details=document.createElement('details');details.append(text('summary','查看分析与来源'),text('pre',row.result.details));article.append(details);}
    if(row.report)article.append(text('p','报告：'+row.report,'why'));
   }
   article.append(actions);parent.append(article);
  }
 }
}
$('enabled').onchange=()=>command('settings',{enabled:$('enabled').checked}).catch(showError);
$('ball').onchange=()=>command('settings',{show_ball:$('ball').checked}).catch(showError);
$('refresh').onclick=()=>command('state').catch(showError);
chrome.runtime.onMessage.addListener(message=>{
 if(message?.type!=='copilot.changed'||!state)return;
 const event=message.event;if(event.revision<=revision)return;
 if(event.type==='progress')progress.set(event.id,event.progress.name?`正在调用 ${event.progress.name}`:'正在生成结果…');
 void command('state').catch(showError);
});
void command('state').catch(showError);
