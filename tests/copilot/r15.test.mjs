import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {renderReadiness,renderChains} from '../../native-extension/copilot-readiness.mjs';
import {CapabilitiesPanel} from '../../native-extension/copilot-capabilities-panel.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
import {Bridge} from '../../native-extension/bridge.mjs';

test('first readiness is short, actionable, bilingual and disappears when ready',async()=>{
 for(const language of ['zh','en']){
  const dom=new JSDOM('<main></main>');try{const doc=dom.window.document;let fixes=0,discoveries=0;
   renderReadiness(doc,{ready:false,items:[{id:'setup',ok:false,command:'fbl setup'},{id:'browser',ok:false},{id:'discovery',ok:false}]},{language,repair:async()=>{fixes++;},discover:async()=>{discoveries++;}});
   const buttons=doc.querySelectorAll('button');assert.equal(buttons.length,3);await buttons[1].onclick();await buttons[2].onclick();assert.equal(fixes,1);assert.equal(discoveries,1);await buttons[0].onclick();assert.equal(doc.querySelector('code').textContent,'fbl setup');
   renderReadiness(doc,{ready:true});assert.equal(doc.getElementById('fbl-readiness'),null);
  }finally{dom.window.close();}
 }
});
test('all five local chains expose text and status independent of color',()=>{
 const dom=new JSDOM('<div></div>');try{const doc=dom.window.document;renderChains(doc,doc.querySelector('div'),{extension:true,host:true,daemon:true,inference:null,execution:false},'en');assert.deepEqual([...doc.querySelectorAll('span')].map(span=>span.dataset.state),['connected','connected','connected','connecting','error']);assert.match(doc.body.textContent,/Inference/);assert.match(doc.body.textContent,/Execution/);}finally{dom.window.close();}
});
test('discovery screen preserves explicit URLs/tab consent and confirms only selected candidates',async()=>{
 const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8'),dom=new JSDOM(html);const calls=[];
 try{const doc=dom.window.document;const rows=[{id:'free',capability:'keyword.expand',source:'manifest',confidence:1,cost:'zero',validation:'available',basis:'explicit',binding:{id:'free',batch_limit:10},selected:true},{id:'paid',capability:'keyword.metrics',source:'mcp',confidence:.96,cost:'unknown',validation:'available',basis:'schema',binding:{id:'paid'},selected:false}];
  const panel=new CapabilitiesPanel(doc,async(name,params)=>{calls.push([name,params]);if(name==='fbl_discover')return {candidates:rows,errors:[]};return {capabilities:{},candidates:[]};},{language:'en'});await panel.refresh();
  const urls=doc.querySelector('textarea[placeholder]');urls.value='https://example.test/report';urls.oninput();const tabs=doc.querySelector('.capability-body input[type=checkbox]');tabs.checked=true;tabs.onchange();
  await [...doc.querySelectorAll('.capability-body button')].find(button=>button.textContent==='Discover local tools').onclick();
  assert.deepEqual(calls.find(([name])=>name==='fbl_discover')[1],{urls:['https://example.test/report'],scan_tabs:true});
  const candidateChecks=doc.querySelectorAll('.capability-body section input[type=checkbox]');assert.equal(candidateChecks[0].checked,true);assert.equal(candidateChecks[1].checked,false);
  await [...doc.querySelectorAll('button')].find(button=>button.textContent==='Confirm selected bindings').onclick();assert.deepEqual(calls.find(([name])=>name==='fbl_confirm')[1].ids,['free']);
 }finally{dom.window.close();}
});
test('popup repair is extension-popup only and cannot be sent from a page',async()=>{
 const calls=[],api={runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path}},service=new CopilotBackground(api,async(name,params)=>{calls.push([name,params]);return {ready:false};});
 assert.equal(service.handle({type:'copilot.fbl_fix'},{id:'fixture',url:'https://example.test',tab:{id:1},frameId:0},()=>assert.fail()),false);
 const result=await new Promise(resolve=>service.handle({type:'copilot.fbl_fix'},{id:'fixture',url:'chrome-extension://fixture/popup.html'},resolve));assert.equal(result.result.ready,false);assert.deepEqual(calls,[['fbl_fix',{}]]);
});
test('native tab inventory omits incognito/non-web tabs and returns URL/title only',async()=>{
 const sent=[],bridge=Object.create(Bridge.prototype);bridge.closed=false;bridge.send=value=>sent.push(value);bridge.executor={api:{tabs:{query:async()=>[{id:1,url:'https://example.test/',title:'Report',cookie:'never'},{id:2,url:'https://private.test/',title:'Private',incognito:true},{id:3,url:'chrome://settings/',title:'Settings'}]}}};
 bridge.receive({id:'read',method:'fbl.tabs',params:{}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(sent[0].result,[{url:'https://example.test/',title:'Report'}]);
});
