// 中文注释：只使用 daemon 的脱敏日志，并在异步回执后复核连接与任务身份。
export async function refreshOverlaySteps(current,executor,connection,selectedTask=null){
 for(const task of selectedTask?[selectedTask]:executor.tasks.values()){
  if(task.revoked||!task.overlays?.size)continue;
  try{
   const steps=await current.request('extension.task_log',{taskId:task.id,generation:task.generation,limit:100});
   if(current!==connection()||task.revoked||executor.tasks.get(task.id)!==task)continue;
   task.recentSteps=steps;
   await Promise.all([...task.overlays].map(([tabId,entry])=>executor.overlayCall(tabId,entry,'log',{steps})));
  }catch{/* 中文注释：日志回读失败不能改变浏览器动作的执行结果。 */}
 }
}

export async function updateWorkflowActivity(executor,row){
 for(const task of executor.tasks.values()){
  if(task.revoked||task.copilotRowId!==row.id)continue;
  for(const [tabId,entry] of task.overlays||[])await executor.overlayCall(tabId,entry,'activity',{activity:{step:row.step||'',completed:row.workflow_completed||0,total:row.workflow_total||0}}).catch(()=>{});
 }
}
