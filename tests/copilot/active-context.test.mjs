import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
import {renderDashboard} from '../../native-extension/copilot-view.mjs';
const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
function fixture(){
 const calls=[],messages=[];let active={id:1,windowId:7,url:'https://example.test/a'},focused=true;
 const api={runtime:{id:'x',getURL:path=>'chrome-extension://x/'+path,sendMessage:async()=>{}},windows:{get:async()=>({focused})},tabs:{query:async()=>[active],sendMessage:async(id,message)=>messages.push([id,message])},storage:{local:{get:async()=>({})},session:{set:async()=>{}}}};
 const service=new CopilotBackground(api,async(method,params)=>{calls.push([method,params]);return {};},id=>id===9);service.enabled=true;
 return {service,calls,messages,setActive:tab=>active=tab,setFocused:value=>focused=value,sender:()=>({id:'x',frameId:0,url:active.url,tab:active})};
}
test('only the focused ordinary tab is observed; hidden and Link-owned tabs produce no capture',async()=>{
 const f=fixture(),sender=f.sender(),page={url:sender.url,title:'A',items:[]};
 await f.service.observation(sender,page,'打开页面');assert.equal(f.calls.filter(([method])=>method==='observe').length,1);
 f.calls.length=0;f.setActive({id:2,windowId:7,url:'https://example.test/b'});
 assert.equal((await f.service.observation(sender,page,'点击 内容')).accepted,false);
 f.setActive(sender.tab);f.setFocused(false);assert.equal((await f.service.observation(sender,page,'点击 内容')).accepted,false);
 f.setFocused(true);f.setActive({id:9,windowId:7,url:'https://example.test/work'});
 await assert.rejects(()=>f.service.observation(f.sender(),{...page,url:f.sender().url},'打开页面'));
 assert.equal(f.calls.length,0);
});
test('activation requests a fresh snapshot and updates context instead of sending the cached A page',async()=>{
 const f=fixture();f.service.pages.set(2,{url:'https://example.test/old',title:'stale',items:[]});
 f.setActive({id:2,windowId:8,url:'https://example.test/b?q=new'});f.service.tabEvent(2,'切换标签页',f.sender().tab);await f.service.queue;
 assert.deepEqual(f.calls,[['page_context',{url:'https://example.test/b?q=new',incognito:false,tab_id:2}]]);
 assert.deepEqual(f.messages,[[2,{type:'copilot.activated'}]]);
});
test('a tab switch during capability lookup discards the old capture',async()=>{
 const f=fixture(),sender=f.sender();const request=f.service.request;
 f.service.request=async(method,params)=>{const result=await request(method,params);if(method==='capability_context')f.setActive({id:2,windowId:7,url:'https://example.test/b'});return result;};
 assert.equal((await f.service.observation(sender,{url:sender.url,title:'A',items:[]},'打开页面')).accepted,false);
 assert.equal(f.calls.some(([method])=>method==='observe'),false);
});
const row={id:'a',title:'执行 A',action:'general.task',params:{task:'A'},why:'fixture',status:'pending'};
test('timer refresh preserves the execute button and its in-flight lock; errors remain visible',async()=>{
 const dom=new JSDOM(html),doc=dom.window.document;let reject,calls=0;
 const state={enabled:true,ready:true,suggestions:[row]},context={command:()=>{calls++;return new Promise((_,fail)=>reject=fail);}};
 try{
  renderDashboard(doc,state,context);const run=doc.querySelector('[data-action=execute]');const pending=run.onclick();
  const observer=new dom.window.MutationObserver(()=>{});observer.observe(doc.getElementById('pending'),{childList:true});
  renderDashboard(doc,state,context);assert.equal(observer.takeRecords().length,0);observer.disconnect();assert.equal(doc.querySelector('[data-action=execute]'),run);assert.equal(run.disabled,true);await run.onclick();assert.equal(calls,1);
  doc.getElementById('notice').hidden=true;reject(Error('协作会话尚未就绪'));await pending;
  renderDashboard(doc,state,context);assert.equal(doc.getElementById('notice').hidden,false);assert.match(doc.getElementById('notice').textContent,/尚未就绪/);assert.equal(run.disabled,false);
 }finally{dom.window.close();}
});
test('changing context withdraws a hovered old card while keeping queued tasks',async()=>{
 const dom=new JSDOM(html),doc=dom.window.document;
 try{
  const running={...row,id:'running',status:'queued'};renderDashboard(doc,{context_revision:1,suggestions:[row,running]},{command:async()=>{}});
  const old=doc.querySelector('[data-id=a]');old.dispatchEvent(new dom.window.Event('pointerenter'));old.querySelector('button').focus();
  renderDashboard(doc,{context_revision:2,suggestions:[running]},{command:async()=>{}});assert.equal(old.getAttribute('aria-hidden'),'true');
  await new Promise(resolve=>setTimeout(resolve,210));assert.equal(doc.querySelector('[data-id=a]'),null);assert.ok(doc.querySelector('[data-id=running]'));
 }finally{dom.window.close();}
});
