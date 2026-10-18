import {localize} from './copilot-i18n.mjs';
import {renderResult,actionNames} from './copilot-result-view.mjs';
import {TaskLogPanel} from './copilot-task-logs.mjs';

export async function mountResultDocument(doc,api,{url=doc.location.href,language=api.i18n?.getUILanguage?.()||doc.defaultView.navigator.language}={}){
 doc.documentElement.lang=language.startsWith('zh')?'zh-CN':'en';
 const id=new URL(url).searchParams.get('id'),notice=doc.getElementById('notice'),root=doc.getElementById('result');let row=null;
 async function command(command,params={}){
  const response=await api.runtime.sendMessage({type:'copilot.command',command,params});
  if(response?.error||!response?.result)throw Error('本地结果不可用');
  const value=response.result;
  if(value.files){notice.replaceChildren();notice.append(doc.createTextNode(value.error?'导出失败，请核对目录；数据仍保留本机。':'已导出：'+value.files.map(file=>file.path).join('；')));for(const file of value.files){for(const [label,folder] of [['打开文件',false],['打开所在文件夹',true]]){const button=doc.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>command('table_open',{id:file.id,folder}).catch(()=>{notice.textContent='文件暂不可用，请检查本地连接。';});notice.append(button);}}}
  if(Array.isArray(value.suggestions))logs.update(value);
  return value;
 }
 const logs=new TaskLogPanel(doc,command,{language});
 doc.getElementById('result-task-log').onclick=()=>logs.open(row);
 doc.getElementById('result-all-logs').onclick=()=>logs.open(null);
 doc.getElementById('result-close').onclick=()=>doc.defaultView.close();
 const listener=message=>{if(message?.type==='copilot.logs')logs.append({...message.event,revision:message.event.log_revision});};api.runtime.onMessage.addListener(listener);
 try{
  if(!id)throw Error('缺少结果标识');row=await command('result',{id});
  doc.getElementById('result-title').textContent=row.title||actionNames[row.action]||'任务结果';
  doc.getElementById('result-context').textContent=row.params?.keyword||row.params?.url||row.params?.task||'';
  const article=doc.createElement('article');article.dataset.id=row.id;root.replaceChildren(article);renderResult(doc,article,row,{command,full:true});doc.getElementById('result-task-log').disabled=false;
 }catch{root.replaceChildren();notice.textContent='结果已清除或连接不可用，请从侧栏重新打开。';}finally{root.setAttribute('aria-busy','false');}
 localize(doc,language);
 const observer=new doc.defaultView.MutationObserver(()=>localize(doc,language));observer.observe(doc.body,{subtree:true,childList:true,characterData:true});
 const dispose=()=>{observer.disconnect();logs.dispose();api.runtime.onMessage.removeListener?.(listener);};doc.defaultView.addEventListener('unload',dispose,{once:true});return {logs,dispose};
}
if(globalThis.document&&globalThis.chrome)void mountResultDocument(document,chrome);
