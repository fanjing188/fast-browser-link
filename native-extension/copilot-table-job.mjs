import {captureTables,advanceTable} from './copilot-tables.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const signature=table=>JSON.stringify(table.headers);
export class TableJobs{
 constructor({open,read,advance,navigate,close,upload,progress,delay=sleep,random=Math.random}){Object.assign(this,{open,read,advance,navigate,close,upload,progress,delay,random});this.jobs=new Map();}
 stop(id){const job=this.jobs.get(id);if(job)job.stop=true;}
 async run(id,capture,table,settings={},confirmed=false,approvedLimit=0){
  if(this.jobs.has(id))throw Error('表格正在收集');
  const limit=settings.max_pages||50;
  if((table.pagination.totalPages||0)>limit&&!confirmed)throw Error(`超过${limit}页，需要再次确认`);
  const max=confirmed?Math.min(approvedLimit>0?approvedLimit:table.pagination.totalPages||limit,200):limit;
  const job={id,stop:false,rows:[],pages:0,status:'executing',reason:'',unit:table.pagination.kind==='scroll'?'批':'页'};this.jobs.set(id,job);
  const seen=new Set(),pages=new Set();let workspace;
  const collect=(item,url)=>{for(const row of item.rows){const key=JSON.stringify(row);if(!seen.has(key)){seen.add(key);job.rows.push(row);}}pages.add(url);job.pages=pages.size;};
  collect(table,capture.url);this.progress({...job,rows:undefined,rowCount:job.rows.length,totalPages:table.pagination.totalPages});
  try{
   const initial=new URL(capture.url),pager=table.pagination;
   if(pager.kind==='url')initial.searchParams.set(pager.key,/offset|start/i.test(pager.key)?'0':'1');
   workspace=await this.open(initial.href,{incognito:!!capture.incognito});let unchanged=0,complete=false;
   for(let scan=0;scan<max&&!job.stop;scan++){
    const snapshot=await this.read(workspace),candidates=snapshot.tables.filter(t=>signature(t)===signature(table));
    const identified=table.dom_id?candidates.filter(t=>t.dom_id===table.dom_id):candidates.filter(t=>t.name===table.name);
    const current=candidates.length===1?candidates[0]:identified.length===1?identified[0]:null;
    if(snapshot.blocked)throw Error(snapshot.blocked);
    if(!current)throw Error('表格结构变化或页面未就绪');
    if(new URL(snapshot.url).origin!==new URL(capture.url).origin)throw Error('页面跳转到登录或其他来源');
    const before=job.rows.length;collect(current,snapshot.url+((pager.kind==='scroll'||pager.kind==='button')&&scan?'#batch='+scan:''));
    unchanged=job.rows.length===before?unchanged+1:0;
    this.progress({...job,rows:undefined,rowCount:job.rows.length,totalPages:pager.totalPages});
    if(job.rows.length>=50000)throw Error('达到50000行本机导出上限');
    if(unchanged>=3)throw Error('后台页面没有新行，可能受节流或虚拟渲染影响');
    const currentPage=current.pagination.current;
    if(pager.totalPages&&pager.kind==='url'&&!/offset|start/i.test(pager.key)&&currentPage>=pager.totalPages){complete=true;break;}
    if(pager.totalRows&&job.rows.length>=pager.totalRows){complete=true;break;}
    if(pages.size>=max){job.reason='已达本次页数上限，保存已收部分；调整配置后重新收集';break;}
    const min=settings.delay_min??1.5,maxDelay=settings.delay_max??3;
    await this.delay((min+this.random()*Math.max(0,maxDelay-min))*1000);
    if(job.stop)break;
    if(pager.kind==='url'){
     if(current.pagination.totalPages===null&&!current.pagination.next&&unchanged>0){job.reason='无法确认后续页或站点重复返回相同行';break;}
     const url=new URL(snapshot.url);url.searchParams.set(pager.key,String(Number(url.searchParams.get(pager.key))+pager.offsetStep));await this.navigate(workspace,url.href);
    }else{
     const step=await this.advance(workspace,{headers:table.headers,kind:pager.kind});
     if(step.blocked)throw Error(step.blocked);if(step.done){if(pager.totalPages&&job.pages<pager.totalPages||pager.kind==='scroll'&&pager.totalRows&&job.rows.length<pager.totalRows)job.reason='分页或滚动已结束，但未达到声明总量，可能不完整';else complete=true;break;}
    }
   }
   if(!complete&&!job.reason&&!job.stop)job.reason='达到采集批次上限，保存已收部分';
   if(table.truncated&&!job.reason)job.reason='当前表格达到DOM取样保护上限，内容可能不完整';
   if(job.stop)job.reason='已停止，保存已收部分';
  }catch(error){const message=error.message||'';job.reason=/登录|验证码|额度|结构|工作页|后台|页数|上限|无法|分页|滚动/.test(message)?message.slice(0,250):'后台页面操作受阻，保存已收部分';}
  finally{if(workspace)try{await this.close(workspace);}catch{job.reason+='；工作页清理待核实';}}
  const result=await this.upload({name:table.name,site:new URL(capture.url).hostname,headers:table.headers,rows:job.rows,pages:job.pages,unit:job.unit,partial:!!(job.reason||table.truncated),reason:job.reason},'both');
  job.status='completed';job.export=result;this.progress({...job,rows:undefined,rowCount:job.rows.length});this.jobs.delete(id);return result;
 }
}

export function taskTableAdapter(api,executor,bridge,consent){
 const guard=async workspace=>{
  const task=executor.tasks.get(workspace.taskId),tab=await api.tabs.get(workspace.tabId);
  if(!task||task.revoked||!task.silent||!task.agentTabs.has(tab.id)||executor.leases.get(tab.id)!==task.id||tab.windowId!==workspace.windowId||tab.groupId!==workspace.groupId||new URL(tab.url).origin!==workspace.origin)throw Error('工作页归属或来源已变化');
  const window=await api.windows.get(tab.windowId);if(tab.active&&window.focused)throw Error('用户正在查看工作页，已暂停收集');
  return task;
 };
 const execute=async(workspace,func,args=[])=>{await guard(workspace);let timer;try{const result=await Promise.race([api.scripting.executeScript({target:{tabId:workspace.tabId},func,args}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('后台页面响应超时，保存已收部分')),10000);})]);await guard(workspace);return result[0].result;}finally{clearTimeout(timer);}};
 return {
  open:async(url,{incognito=false,resourceId=null}={})=>{
   const current=bridge();if(!current)throw Error('本机桥未连接');
   const created=await current.request('extension.copilot.work_create',{url,incognito,...(resourceId?{resourceId}:{})});
   try{await consent.synchronize(current);
   const task=executor.tasks.get(created.id);if(!task||task.revoked||!task.silent)throw Error('后台工作页授权未完成');
   const opened=await executor.perform(task,{action:'new_tab',taskId:task.id,generation:task.generation,url,requestId:crypto.randomUUID()});
   const tab=await api.tabs.get(opened.tabId);return {taskId:task.id,tabId:tab.id,windowId:tab.windowId,groupId:tab.groupId,origin:new URL(url).origin};
   }catch(error){const local=executor.tasks.get(created.id);let cleanup;try{if(local)cleanup=await executor.release({taskId:local.id,generation:local.generation,closeAgentTabs:true});await current.request('extension.stop',{taskId:created.id,generation:created.generation,...(cleanup?{cleanup}:{})});}catch{}throw error;}
  },
  read:async(workspace,{minimumRows=3}={})=>{
   let previous='',latest;
   for(let attempt=0;attempt<10;attempt++){
    await guard(workspace);const tab=await api.tabs.get(workspace.tabId);
    if(tab.status==='complete'){
     latest=await execute(workspace,captureTables,[{minimumRows}]);const check=await execute(workspace,advanceTable,[{kind:'check',headers:[]}]);
     if(check.blocked)return {...latest,blocked:check.blocked};
     const fingerprint=JSON.stringify(latest);
     if(fingerprint===previous&&latest.tables.length)return latest;previous=fingerprint;
    }
    await sleep(800);
   }
   throw Error('后台页面未稳定，可能受浏览器节流影响');
  },
  readData:async(workspace,func,args=[])=>{
   let result;for(let attempt=0;attempt<10;attempt++){await guard(workspace);const tab=await api.tabs.get(workspace.tabId);if(tab.status==='complete'){result=await execute(workspace,func,args);if(result.error||result.blocked||result.ready===true||result.results?.length||result.series?.length)return result;}await sleep(800);}return result||{error:'page_not_ready'};
  },
  advance:async(workspace,step)=>{
   const plan=await execute(workspace,advanceTable,[{...step,inspect:true}]);
   if(plan.done||plan.blocked)return plan;
   const task=await guard(workspace),base={taskId:task.id,generation:task.generation,tabId:workspace.tabId};
   if(plan.control==='scroll'){
    const expression='(()=>{const box=document.querySelector('+JSON.stringify(plan.root)+');if(!box)return {blocked:true};box.scrollBy({top:Math.max(1,box.clientHeight*.8),behavior:"instant"});return {scrolled:true};})()';
    const result=await executor.perform(task,{...base,action:'cdp.send',method:'Runtime.evaluate',params:{expression,returnByValue:true,userGesture:false,timeout:1500}});
    if(result.exceptionDetails||result.result?.value?.blocked)return {blocked:'滚动容器已变化，保存已收部分'};
    return {advanced:true};
   }
   const options={mode:'interactive',root:plan.root,query:plan.name,roles:['button','link'],budget:2000};
   const snapshot=await executor.perform(task,{...base,action:'semantic_snapshot',options});
   const candidates=(snapshot.items||[]).filter(item=>item.name.trim().toLowerCase()===plan.name.toLowerCase());
   if(candidates.length!==1)return {blocked:'无法唯一核实分页或滚动目标，已停止'};
   const result=await executor.perform(task,{...base,action:'ref_click',direction:'down',binding:snapshot.binding,snapshotId:snapshot.snapshotId,ref:candidates[0].ref});
   if(result.outcomeUnknown||['unobserved','unverified'].includes(result.effect)||result.dialogOpened)return {blocked:'分页动作结果待核实，未重复派发'};
   return {advanced:true};
  },
  navigate:async(workspace,url)=>{const task=await guard(workspace);return executor.perform(task,{action:'navigate',taskId:task.id,generation:task.generation,tabId:workspace.tabId,url});},
  close:async workspace=>{const task=executor.tasks.get(workspace.taskId);if(task){const cleanup=await executor.release({taskId:task.id,generation:task.generation,closeAgentTabs:true});await bridge().request('extension.stop',{taskId:task.id,generation:task.generation,cleanup});if(cleanup?.cleanupState!=='succeeded')throw Error('清理待核实');}}
 };
}
