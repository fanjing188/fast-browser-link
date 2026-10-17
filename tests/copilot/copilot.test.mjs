import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {ordinaryPage,pageSnapshot,describeEvent,appendStep,safeURL} from '../../native-extension/copilot-observation.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
function fixture(){
 const dom=new JSDOM('<!doctype html><title>Keywords</title><h1>Visible heading</h1><label>Search<input value="INPUT_PRIVATE_SENTINEL"></label><textarea>TEXTAREA_PRIVATE_SENTINEL</textarea><input type="password" value="PASSWORD_PRIVATE_SENTINEL"><div contenteditable>EDITABLE_PRIVATE_SENTINEL</div><table><tr><td>sample keyword</td><td>42</td><td><button aria-label="Check keyword">Inspect</button></td></tr></table><p>selectable words</p>',{url:'https://example.test/'});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({x:1,y:1,left:1,top:1,right:201,bottom:31,width:200,height:30});
 dom.window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
 return dom;
}
test('bounded semantic collection excludes control values and special pages',()=>{
 const dom=fixture();try{
 const page=pageSnapshot(dom.window.document,dom.window.location.href);const raw=JSON.stringify(page);
 assert.match(raw,/Visible heading/);assert.doesNotMatch(raw,/PRIVATE_SENTINEL/);assert.ok(Buffer.byteLength(raw)<=6144);
 for(let i=0;i<100;i++){const p=dom.window.document.createElement('p');p.textContent='有界快照 '.repeat(100);dom.window.document.body.append(p);}
 assert.ok(Buffer.byteLength(JSON.stringify(pageSnapshot(dom.window.document,dom.window.location.href,2000)))<=2000);
 for(const url of ['chrome://settings','edge://settings','chrome-extension://id/page','https://example.test/a.PDF'])assert.equal(ordinaryPage(url),false);
 assert.equal(ordinaryPage('https://example.test/','application/pdf'),false);
 assert.equal(pageSnapshot(dom.window.document,'chrome://settings'),null);
 assert.equal(safeURL('https://example.test/?token=private#secret'),'https://example.test/');
 }finally{dom.window.close();}
});
test('trajectory records row context and selection, never typed values',()=>{
 const dom=fixture();try{const doc=dom.window.document;
 assert.match(describeEvent({type:'click',target:doc.querySelector('button')},doc),/sample keyword 42 Inspect/);
 assert.equal(describeEvent({type:'click',target:doc.querySelector('input')},doc),null);
 const selection=doc.getSelection(),range=doc.createRange();range.selectNodeContents(doc.querySelector('p'));selection.addRange(range);
 assert.equal(describeEvent({type:'selectionchange',target:doc},doc),'选中 selectable words');
 range.selectNodeContents(doc.querySelector('[contenteditable]'));selection.removeAllRanges();selection.addRange(range);
 assert.equal(describeEvent({type:'copy',target:doc},doc),null);
 let trace=[];for(let i=0;i<40;i++)trace=appendStep(trace,'step '+i,i,{url:'https://example.test/',title:'Fixture'},i);
 assert.equal(trace.length,30);assert.equal(trace[0].at,10);assert.equal(trace.at(-1).at,39);
 }finally{dom.window.close();}
});
function background(){const registered=[],messages=[],native=[];
 const api={runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,sendMessage:async m=>messages.push(m)},sidePanel:{open:async()=>{}},
 scripting:{getRegisteredContentScripts:async()=>registered,registerContentScripts:async rows=>registered.push(...rows),unregisterContentScripts:async()=>registered.splice(0),executeScript:async()=>{}},
 tabs:{query:async()=>[{id:1,url:'https://example.test/'}],sendMessage:async(id,m)=>messages.push(m)},storage:{session:{set:async()=>{},get:async()=>({}),remove:async()=>{}}}};
 const service=new CopilotBackground(api,async(method,params)=>{native.push({method,params});return {enabled:true,show_ball:true,suggestions:[]};});return {service,registered,messages,native,api};
}
test('content and panel protocols are separate; dynamic registration and native events',async()=>{
 const f=background();await f.service.settings({enabled:true});assert.equal(f.registered.length,1);
 const content={id:'fixture',url:'https://example.test/',frameId:0,tab:{id:1,windowId:7}};
 assert.equal(f.service.handle({type:'copilot.command',command:'execute',params:{id:'x'}},content,()=>{}),false);
 assert.equal(f.service.handle({type:'copilot.command',command:'settings'}, {id:'other'},()=>{}),false);
 await f.service.observation(content,{url:content.url,title:'Fixture',items:[]},'点击 Example');
 assert.equal(f.native.at(-1).method,'observe');assert.equal(f.native.at(-1).params.trace.length,1);
 await assert.rejects(()=>f.service.observation(content,{url:'https://other.test/'},'click'));
 await f.service.notification({type:'add',revision:1,suggestion:{id:'a',title:'Fixture',status:'pending'}});
 assert.equal(f.service.unread.size,1);assert.ok(f.messages.some(m=>m.type==='copilot.badge'&&m.count===1));
 await f.service.settings({enabled:false});assert.equal(f.registered.length,0);assert.equal(f.service.trace.length,0);assert.ok(f.messages.some(m=>m.type==='copilot.teardown'));
});
test('ball open invokes API synchronously before async work, and returns fallback on refusal',async()=>{
 const f=background();f.service.enabled=true;let called=false;
 f.api.sidePanel.open=()=>{called=true;return Promise.reject(Error('gesture unavailable'));};
 const response=new Promise(resolve=>{assert.equal(f.service.handle({type:'copilot.open'},{id:'fixture',url:'https://example.test/',frameId:0,tab:{id:1,windowId:7}},resolve),true);});
 assert.equal(called,true);assert.deepEqual(await response,{result:{opened:false}});
});
