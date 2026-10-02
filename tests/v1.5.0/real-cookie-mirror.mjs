// 中文注释：手动运行；只启动临时 Chrome/Edge profiles，不读取个人 Cookie。
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {openRealSession} from '../native-v2/real-session.mjs';
import {waitFor} from '../native-v2/cdp-client.mjs';
import {createCookieFixture} from './fixture-site.mjs';
const server=createCookieFixture();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let source,target;
const open=async(session,url)=>{
 await session.ui.evaluate(`chrome.tabs.create({url:${JSON.stringify(url)}}).then(()=>true)`);
 return waitFor(()=>session.readUrl(url,`document.readyState==='complete'`));
};
try{
 source=await openRealSession({browser:'chrome',label:'cookie150s',headed:process.argv.includes('--headed')});
 target=await openRealSession({browser:process.argv.includes('--same-browser')?'chrome':'edge',label:'cookie150t',headed:process.argv.includes('--headed'),sharedWith:source});
 await source.enableFullAccess();
 await open(target,`${origin}/protected`);
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 await open(source,`${origin}/login`);
 const site='127.0.0.1',sourceId=(await source.instance()).instanceId,targetId=(await target.instance()).instanceId;
 assert.notEqual(sourceId,targetId);
 const rows=await source.rpc('cookie150','cookie_mirror',{action:'list_sites',source:sourceId});
 assert.equal(rows.sites.find(r=>r.site===site)?.count,3,'夹具必须包含普通、httpOnly 会话和分区 Cookie；检查浏览器回环 Secure 支持');
 // 中文注释：先覆盖 Hermes 请求与拒绝；全访问不能直接派发 Cookie。
 await source.background();
 const denied=await source.rpc('cookie150','cookie_mirror',{action:'request_mirror',source:sourceId,target:targetId,sites:[site]});
 await source.approvePanel('reject','将复制登录态到目标浏览器');
 await waitFor(async()=> (await source.rpc('cookie150','cookie_mirror',{action:'status',transfer_id:denied.transferId})).status==='denied');
 assert.equal(await target.readUrl('/protected',`document.querySelector('#auth').dataset.authenticated`),'false');
 // 中文注释：批准路径同样走 Hermes 工具，弹窗只用于打开原待确认请求。
 await source.background();
 const requested=await source.rpc('cookie150','cookie_mirror',{action:'request_mirror',source:sourceId,target:targetId,sites:[site]});
 assert.ok(['preparing','approval_required'].includes(requested.status));
 await waitFor(async()=> (await source.rpc('cookie150','cookie_mirror',{action:'status',transfer_id:requested.transferId})).status==='approval_required');
 // 中文注释：主动关闭临时源扩展面板，再用保留的真实弹窗按钮补救，不重新发起复制。
 // 中文注释：面板窗口异步创建，等它出现后再关闭，避免与创建过程竞争。
 const closed=await waitFor(()=>source.ui.evaluate(`chrome.tabs.query({}).then(async tabs=>{const panel=tabs.find(tab=>tab.url===chrome.runtime.getURL('approval-panel.html'));if(!panel)return false;await chrome.windows.remove(panel.windowId);return true;})`),15000).catch(()=>false);
 assert.equal(closed,true,'源扩展未建立确认面板');
 await waitFor(()=>source.ui.evaluate(`document.querySelector('#cookie-pending').disabled===false`));
 assert.equal(await source.ui.evaluate(`document.querySelector('#cookie-copy,#cookie-load,#cookie-target')===null`),true);
 await source.clickPopup('#cookie-pending');
 await source.approvePanel('approve','Cookie 镜像');
 let completed;
 await waitFor(async()=>{completed=await source.rpc('cookie150','cookie_mirror',{action:'status',transfer_id:requested.transferId});return completed.status==='completed';},30000);
 assert.deepEqual([completed.success,completed.failed,completed.matched,completed.missing],[3,0,3,0]);
 assert.deepEqual([completed.sites[0].success,completed.sites[0].failed,completed.sites[0].matched,completed.sites[0].missing],[3,0,3,0]);
 // 中文注释：只读取夹具布尔状态，不查询或打印目标 Cookie 值。
 const verified=await target.readUrl('/protected',`fetch('/protected').then(r=>r.text()).then(html=>{const d=new DOMParser().parseFromString(html,'text/html');return {authenticated:d.querySelector('#auth').dataset.authenticated==='true',partitioned:d.querySelector('#auth').dataset.partitioned==='true'};})`);
 assert.deepEqual(verified,{authenticated:true,partitioned:true});
 // 中文注释：泄漏扫描——临时环境里除浏览器 profile 自身的 Cookie 库外，任何文件和会话日志都不得出现夹具 Cookie 值。
 const secrets=server.fixtureSecrets;assert.equal(secrets.length,3);
 const leaks=[],scanned=[];
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);
  if(entry.isDirectory()){if(entry.name==='profile'&&dir.split(path.sep).length)continue;await walk(full);continue;}
  if(!entry.isFile())continue;scanned.push(full);let text;try{text=(await readFile(full)).toString('latin1');}catch{continue;}
  if(secrets.some(secret=>text.includes(secret)))leaks.push(path.relative(dir,full)||entry.name);}};
 // 中文注释：自检模式往守护进程目录写入一个夹具值，必须被扫描抓到（验证扫描本身有效）。
 if(process.env.COOKIE_LEAK_SELFTEST==='1'){const daemonDir=(await readdir(source.work,{recursive:true})).find(p=>p.endsWith('browser-link-native'));assert.ok(daemonDir,'未找到守护进程目录');await writeFile(path.join(source.work,daemonDir,'selftest-leak.txt'),secrets[0]);}
 for(const session of new Set([source,target]))await walk(session.work);
 for(const session of new Set([source,target]))if(secrets.some(secret=>String(session.logs||'').includes(secret)))leaks.push('session.logs');
 // 中文注释：反向对照——守护进程数据目录必须在扫描范围内，否则"干净"没有意义。
 assert.ok(scanned.some(file=>file.includes('browser-link-native')),'泄漏扫描未覆盖守护进程数据目录');
 assert.deepEqual(leaks,[],'Cookie 值出现在临时环境文件或日志中（仅列文件名，不打印值）');
 console.log(JSON.stringify({ok:true,panelFallback:true,entry:'hermes-tool',leakScan:'clean',scannedFiles:scanned.length,daemonFiles:scanned.filter(file=>file.includes('browser-link-native')).map(file=>path.basename(file)).slice(0,12),source:'chrome',target:target.browser,site,count:3,success:3,failed:0,matched:3,missing:0,authenticated:true,partitioned:true}));
}finally{
 await target?.close();await source?.close();await new Promise(resolve=>server.close(resolve));
}
