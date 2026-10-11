// 中文注释：所有来源显示邮箱；离线 DOM 不访问外部登录站。
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageSemantics} from '../../page-semantics/index.js';
import {createPageParser} from '../../page-semantics/parser.mjs';
import {pageAction,semanticWorldDeclaration,Executor} from '../../native-extension/core.mjs';

const email='synthetic-target@example.test';
for(const role of ['link','button'])test(`账号 ${role} 的非原生节点使用已核实引用进入局部保护`,()=>{
 const f=fixture('https://accounts.google.com',{},`<main><div role="${role}" tabindex="0">${email}</div></main>`);
 try{
  const call=f.dom.window.eval(`(${semanticWorldDeclaration})`),binding={taskId:'t',documentId:'d',leaseId:'l'};
  const page=call('semantic_snapshot',{binding,options:{query:email}});
  assert.equal(page.items.length,1);
  const params={binding,snapshotId:page.snapshotId,ref:page.items[0].ref,action:'ref_click'};
  assert.equal(call('shield_write_target',params),f.dom.window.document.querySelector('[role]'));
  assert.equal(call('shield_write_target',{...params,action:'ref_fill'}),null);
  assert.equal(call('shield_write_target',{...params,action:'ref_select_option'}),null);
 }finally{f.close();}
});
function fixture(origin,options={},html=`<main><p>${email}</p><button>${email}</button></main>`){
 const dom=new JSDOM(html,{url:origin+'/choose',pretendToBeVisual:true,runScripts:'outside-only'});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:120,bottom:50,width:100,height:30});
 dom.window.HTMLElement.prototype.getClientRects=()=>[{width:240,height:38}];
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;},configurable:true});
 const semantics=createPageSemantics({document:dom.window.document,taskId:'t',documentId:'d',leaseId:'l',...options});
 return {dom,semantics,parser:createPageParser(semantics.parsingContext()),close(){semantics.revoke();dom.window.close();}};
}
for(const origin of ['https://accounts.google.com','https://appleid.apple.com','https://login.microsoftonline.com','https://login.live.com','https://github.com','https://www.facebook.com','https://x.com','https://api.twitter.com'])test(`${origin} shows account emails in refs, query and parsed content`,()=>{
 const f=fixture(origin);
 try{
  const page=f.semantics.snapshot({query:email});
  assert.equal(page.items.length,1);assert.equal(page.items[0].name,email);
  assert.equal(f.semantics.resolve({...page.binding,snapshotId:page.snapshotId,ref:page.items[0].ref}).localName,'button');
  assert.ok(JSON.stringify(f.semantics.snapshot({mode:'content'})).includes(email));
  assert.ok(JSON.stringify(f.parser.parse({sections:['blocks']})).includes(email));
 }finally{f.close();}
});
for(const origin of ['https://example.test','http://accounts.google.com','https://accounts.google.com.evil.test'])test(`${origin} shows email regardless of page exemption claims`,()=>{
 const f=fixture(origin,{},`<main data-hermes-email-exempt="true"><base href="https://accounts.google.com/"><p>${email}</p><button>${email}</button></main>`);
 try{for(const page of [f.semantics.snapshot(),f.parser.parse()]){assert.ok(JSON.stringify(page).includes(email));assert.ok(!JSON.stringify(page).includes('[email]'));}}
 finally{f.close();}
});
test('provider pages preserve all other secret redaction and never read password values',()=>{
 const f=fixture('https://accounts.google.com',{},`<main><p>${email}</p><p>4111 1111 1111 1111</p><p>api-key="SECRET_KEY"</p><p>Bearer SECRET_BEARER</p><input type="password" value="SECRET_PASSWORD"></main>`);
 try{
  Object.defineProperty(f.dom.window.document.querySelector('input'),'value',{get(){throw Error('must not read password');}});
  const text=JSON.stringify([f.semantics.snapshot({mode:'content'}),f.parser.parse()]);
  assert.ok(text.includes(email));assert.ok(text.includes('4111'));assert.ok(text.includes('SECRET_KEY'));assert.ok(text.includes('SECRET_BEARER'));
  for(const value of ['SECRET_PASSWORD'])assert.ok(!text.includes(value));
 }finally{f.close();}
});
test('isolated-world reads show emails independently of provider configuration',async()=>{
 const origin='http://login.localhost:9000',providers=[{origin,paths:['/oauth-provider']}],f=fixture(origin);
 try{
  const binding={taskId:'t',documentId:'d',leaseId:'l'},api={debugger:{sendCommand:async(_target,method,params)=>{
   if(method==='Page.createIsolatedWorld')return {executionContextId:1};
   assert.equal(method,'Runtime.callFunctionOn');
   const fn=f.dom.window.eval(`(${params.functionDeclaration})`);
   return {result:{value:await fn(...(params.arguments||[]).map(row=>row.value))}};
  }}};
  const executor=new Executor(api,()=>{},{oauthProviders:providers});
  const page=await executor.callSemanticWorld({tabId:1},'main','semantic_snapshot',{binding,options:{query:email},oauthProviders:[]},()=>{});
  assert.equal(page.items[0].name,email);
  const parsed=await executor.callSemanticWorld({tabId:1},'main','page.parse',{binding,options:{sections:['blocks']}},()=>{});
  assert.ok(parsed.blocks.some(row=>row.text===email));
 }finally{f.dom.window.__hermesNativeSemanticsV2?.semantics.revoke();f.close();}
});
test('accessibility names and email query show emails on every origin',()=>{
 for(const origin of ['https://accounts.google.com','https://example.test']){
  const f=fixture(origin,{},'<main><button>Account</button></main>');
  try{
   const page=f.semantics.snapshot(),item=page.items[0];
   f.semantics.applyAccessibility({...page.binding,snapshotId:page.snapshotId},[{ref:item.ref,name:email}]);
   const result=f.semantics.snapshot({query:email});
   assert.equal(result.items[0].name,email);
  }finally{f.close();}
 }
});
test('accessible iframe also shows emails',()=>{
 const f=fixture('https://accounts.google.com',{},`<main><button>${email}</button><iframe src="https://example.test/frame"></iframe></main>`);
 try{
  const child=f.dom.window.document.querySelector('iframe').contentDocument;
  child.open();child.write(`<html><body><button aria-label="${email}">${email}</button><p>${email}</p></body></html>`);child.close();
  assert.equal(child.defaultView.location.origin,'https://example.test');
 child.defaultView.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,right:120,bottom:50,width:100,height:30});
  child.defaultView.HTMLElement.prototype.getClientRects=()=>[{width:240,height:38}];
  const page=f.semantics.snapshot({composed:true});
  const nested=page.items.find(item=>item.targetPath?.some(row=>row.kind==='frame'));
  assert.equal(nested.name,email);
  const parsed=f.parser.parse({composed:true,sections:['blocks']});
  assert.ok(parsed.blocks.some(row=>row.text===email));
 }finally{f.close();}
});
test('provider configuration is unnecessary for email display',()=>{
 const origin='http://login.localhost:9000',providers=[{origin,paths:['/oauth-provider']}];
 const f=fixture(origin,{oauthProviders:providers});
 try{assert.equal(f.semantics.snapshot({query:email}).items[0].name,email);}
 finally{f.close();}
});
test('legacy snapshot/page_text uses the same account-email and other-secret policy',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;
 try{for(const origin of ['https://accounts.google.com','https://example.test']){
  const f=fixture(origin,{},`<main><button>${email}</button><button>4111111111111111</button><button>Bearer SECRET_BEARER</button></main>`);
  try{
   globalThis.document=f.dom.window.document;globalThis.location=f.dom.window.location;
   const page=pageAction('snapshot',null,null,null,[origin]);
   assert.equal(page.elements[0].text,email);
   assert.equal(page.elements[1].text,'4111111111111111');assert.equal(page.elements[2].text,'Bearer SECRET_BEARER');
  }finally{f.close();}
 }}finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});
