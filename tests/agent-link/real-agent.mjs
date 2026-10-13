// 中文注释：只使用临时浏览器配置与本地夹具，验证框架无关 CLI 的真实读写及会话隔离。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {openRealSession} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
const exec=promisify(execFile);
const browser=process.argv.find(arg=>arg.startsWith('--browser='))?.split('=')[1]||'chrome';
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Fast CLI fixture</title><input id="draft" aria-label="Draft"><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#draft\').value">Save</button><p id="result">empty</p>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let session;
try{
 session=await openRealSession({browser,label:'fa',compactScratch:true});
 const url=`http://127.0.0.1:${server.address().port}`;
 const cli=path.resolve(import.meta.dirname,'../../agent-link/fast_browser_link.py');
 const invoke=async(operation,params={},identity='first')=>{
  const {stdout}=await exec('python3',[cli,'--session',path.join(session.work,`${identity}.session`),operation,JSON.stringify(params)],{
   env:{...process.env,FAST_BROWSER_LINK_HOME:session.staged.hermesHome},timeout:65000});
  return JSON.parse(stdout);
 };
 const instances=await invoke('browsers');assert.equal(instances.length,1);
 const task=await invoke('create',{title:'Fast CLI acceptance',instanceId:instances[0].instanceId,allowedOrigins:[url]});
 await waitFor(async()=> (await invoke('get',{taskId:task.id})).state==='ready',30000);
 const page=await invoke('run',{taskId:task.id,action:'new_tab',url});
 assert.ok(Number.isInteger(page.tabId));
 const run=(action,extra={})=>invoke('run',{taskId:task.id,tabId:page.tabId,action,...extra});
 const read=await run('semantic_snapshot');assert.ok(JSON.stringify(read).includes('Draft'));
 await run('fill',{selector:'#draft',text:'Fast CLI verified'});
 await run('click',{selector:'#save'});
 assert.ok(JSON.stringify(await run('semantic_snapshot',{options:{root:'#result',mode:'content'}})).includes('Fast CLI verified'));
 await assert.rejects(invoke('get',{taskId:task.id},'other'),error=>JSON.parse(error.stdout).error==='forbidden');
 await invoke('close',{taskId:task.id});
 assert.equal((await invoke('get',{taskId:task.id})).state,'closed');
 console.log(JSON.stringify({browser,passed:['connect','create','read','fill','click','readback','foreign-session-denied','close']}));
}finally{
 if(session)await session.close();
 await new Promise(resolve=>server.close(resolve));
}
