// 中文注释：语义文本仅规范空白；密码输入值由控件读取层排除。
export function createPageTextRedactor(){
 return text=>String(text).replace(/\s+/g,' ').trim();
}

const sensitiveParameter=key=>/(?:^|[_.-])(?:token|key|apikey|session(?:id)?|auth(?:orization)?|secret|password|credential|signature|code)(?:$|[_.-])/i.test(key.replace(/([a-z])([A-Z])/g,'$1_$2'));

// 中文注释：协作推理仅收脱敏文本；原始表格导出仍走独立的本机通路。
export function redactPageText(text){
 let value=String(text).replace(/https?:\/\/[^\s<>"']+/gi,raw=>{
  try{
   const url=new URL(raw);url.username='';url.password='';url.hash='';url.pathname=redactPageText(decodeURIComponent(url.pathname));
   for(const key of [...url.searchParams.keys()])url.searchParams.set(key,sensitiveParameter(key)?'[redacted]':redactPageText(url.searchParams.get(key)));
   return url.href;
  }catch{return '[url]';}
 });
 value=value.replace(/([?&])([\w.-]+)=([^\s&#<>"']*)/g,(raw,prefix,key)=>sensitiveParameter(key)?`${prefix}${key}=[redacted]`:raw);
 value=value.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]');
 value=value.replace(/(?:\+?\d[\d ().-]{7,}\d)/g,match=>match.replace(/\D/g,'').length>=9?'[number]':match);
 return value.replace(/\s+/g,' ').trim();
}

export function privateAccountNode(node){
 for(let element=node;element?.nodeType===1;element=element.parentElement){
  if(!element.matches('button,a,img,[role=button],[role=menu],[role=dialog],[aria-haspopup=menu],[data-account],[data-profile]'))continue;
  const label=[element.getAttribute('aria-label'),element.getAttribute('alt'),element.getAttribute('title'),element.getAttribute('data-testid'),element.textContent?.slice(0,300)].filter(Boolean).join(' ');
  if(/(?:google\s*)?account|profile|avatar|个人资料|账号|账户|头像/i.test(label)||/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(label))return true;
 }
 return false;
}
