// 中文注释：只重试能够证明尚未派发的动作；读取可以重新采集，未知写入只回读。
export const RECOVERY_ACTIONS=new Set(['click','fill','press','ref_click','ref_fill','ref_press','ref_set_checked','ref_select_option']);
const REASONS=new Set(['target not found','target unavailable','TARGET_NOT_UNIQUE','TARGET_NOT_ACTIONABLE','STALE_REF','STALE_SNAPSHOT','REF_TARGET_MISSING','REF_TARGET_AMBIGUOUS','TARGET_OCCLUDED','TARGET_UNSTABLE','TARGET_CHANGED','NODE_MOVED','TARGET_OUT_OF_VIEWPORT','TARGET_HIDDEN','TARGET_ZERO_SIZE','BINDING_MISMATCH','DOCUMENT_REPLACED','DOCUMENT_CHANGED','document changed','FRAME_TOKEN_STALE','SYNTHETIC_CLICK_UNAVAILABLE']);
export const recoveryReason=error=>String(error?.message||'').split(/\r?\n/,1)[0].replace(/^Error: /,'').split('|',1)[0];
export function rankTargets(items,hint={}){
 const name=String(hint.name||'').trim().toLocaleLowerCase();
 return items.map(item=>{
  const text=String(item.name||'').trim().toLocaleLowerCase();
  let method,score=0;
  if(hint.ref&&item.ref===hint.ref){method='ref';score=1000;}
  else if(name&&text===name&&item.role===hint.role){method='role+name';score=800;}
  else if(name&&text.includes(name)){method='text';score=600;}
  else if(!name&&hint.role&&item.role===hint.role){method='role';score=500;}
  else if(item.selectorMatch){method='selector';score=400;}
  else if(hint.rect&&item.rect&&hint.role===item.role){
   const distance=Math.hypot(hint.rect.x-item.rect.x,hint.rect.y-item.rect.y);
   if(distance<80){method='geometry';score=200-distance;}
  }
  if(!method||item.disabled||item.visible===false)return null;
  score+=(item.inViewport?30:0)+(item.occluded===false?20:0);
  return {...item,method,score};
 }).filter(Boolean).sort((a,b)=>b.score-a.score);
}
export async function recoverTarget({action,run,scan,settle,readback,capture,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hint={}}){
 const recovery={triggered:false,rounds:0,locator:'original',clickMethod:null,strategies:[]};
 let chosen=null,lastScan=[],failure;
 const attempt=async()=>{
  const result=await run(chosen,recovery.rounds);
  recovery.clickMethod=result?.kind||result?.delivery||null;
  if(result?.outcomeUnknown){recovery.observation=await readback();return {...result,recovery};}
  return {...result,recovery};
 };
 try{return await attempt();}catch(error){failure=error;}
 for(const delay of [300,800,1500]){
  if(!REASONS.has(recoveryReason(failure))||RECOVERY_ACTIONS.has(action)&&failure.preDispatch!==true){
   if(RECOVERY_ACTIONS.has(action)&&failure.preDispatch!==true)recovery.observation=await readback();
   break;
  }
  recovery.triggered=true;recovery.rounds++;
  await wait(delay);
  try{await settle();lastScan=await scan();}catch(error){failure=error;continue;}
  const ranked=rankTargets(lastScan,hint);chosen=ranked[0]||null;
  recovery.strategies.push({round:recovery.rounds,scanned:lastScan.length,matched:ranked.length,locator:chosen?.method||null});
  if(!chosen)continue;
  recovery.locator=chosen.method;
  recovery.selected={role:chosen.role,name:chosen.name,ref:chosen.ref,rect:chosen.rect};
  recovery.otherCandidates=Math.max(0,ranked.length-1);
  try{return await attempt();}catch(error){failure=error;recovery.strategies.at(-1).error=recoveryReason(error).slice(0,120);}
 }
 const nearest=rankTargets(lastScan,hint);
 if(!nearest.length)nearest.push(...lastScan.filter(item=>!hint.role||item.role===hint.role).slice(0,5));
 failure.recovery={...recovery,candidates:nearest.slice(0,5).map(({role,name,rect,method})=>({role,name,rect,method}))};
 try{failure.recovery.screenshot=await capture();}catch(error){failure.recovery.screenshotError=recoveryReason(error);}
 throw failure;
}
