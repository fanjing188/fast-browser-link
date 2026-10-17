import {localize} from './copilot-i18n.mjs';
import {renderResult} from './copilot-result-view.mjs';
const id=new URL(location.href).searchParams.get('id');
async function command(command,params={}){
 const response=await chrome.runtime.sendMessage({type:'copilot.command',command,params});
 if(response?.error||!response?.result)throw Error('本地结果不可用');
 if(response.result.files){const notice=document.getElementById('notice');notice.textContent=response.result.error?'导出失败，请核对目录；数据仍保留本机。':'已导出：'+response.result.files.map(file=>file.path).join('；');for(const file of response.result.files){for(const [label,folder] of [['打开文件',false],['打开所在文件夹',true]]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>command('table_open',{id:file.id,folder});notice.append(button);}}}
 return response.result;
}
try{const row=await command('result',{id}),article=document.createElement('article');document.getElementById('result').append(article);renderResult(document,article,row,{command,full:true});}
catch{document.getElementById('notice').textContent='结果已清除或连接不可用，请从侧栏重新打开。';}

localize(document,chrome.i18n?.getUILanguage?.()||navigator.language);
const localeObserver=new MutationObserver(()=>localize(document,chrome.i18n?.getUILanguage?.()||navigator.language));localeObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
