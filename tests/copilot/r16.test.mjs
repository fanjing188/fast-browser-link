import {renderResult} from '../../native-extension/copilot-result-view.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {AnnotationLayer,recognizeObjects,annotationLabel} from '../../native-extension/copilot-annotations.mjs';
import {BasketPanel} from '../../native-extension/copilot-basket.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
import {selectionTasks} from '../../native-extension/copilot-selection.mjs';
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(html,url='https://example.test/report'){
 const dom=new JSDOM(html,{url,pretendToBeVisual:true});
 dom.window.Element.prototype.getClientRects=function(){return this.hidden?[]:[this.getBoundingClientRect()];};
 dom.window.Element.prototype.getBoundingClientRect=function(){const top=Number(this.dataset.top||40);return {left:10,right:210,top,bottom:top+25,width:200,height:25};};
 return dom;
}
test('generic search objects use query/results/related/PAA only and never read sensitive input values',()=>{
 const dom=fixture('<form role="search"><input value="PRIVATE_SENTINEL"></form><main><h1>Search</h1><a href="https://small.example.test/"><h3>Result</h3></a><a href="/search?q=related+word">Related</a><div role="button" aria-expanded="false">How does this work?</div><div hidden><a href="/search?q=HIDDEN">Hidden</a></div></main>','https://www.google.com/search?q=sample');
 try{const objects=recognizeObjects(dom.window.document);assert.deepEqual(objects.map(item=>[item.type,item.value]),[['keyword','sample'],['domain','small.example.test'],['keyword','related word'],['keyword','How does this work?']]);assert.ok(!JSON.stringify(objects.map(item=>item.value)).includes('PRIVATE_SENTINEL'));}finally{dom.window.close();}
});
test('tool profile aliases recognize custom columns without domain-specific rules',()=>{
 const dom=fixture('<div class="report"><div role="row"><span role="columnheader">Term name</span><span role="columnheader">Host name</span></div><div role="row"><span role="cell">sample</span><span role="cell">example.org</span></div></div>');
 try{const profiles=[{hosts:['example.test'],pages:[{table_selectors:['.report'],columns:{keyword:['Term name'],domain:['Host name']}}]}];assert.equal(recognizeObjects(dom.window.document).length,0);assert.deepEqual(recognizeObjects(dom.window.document,{profiles}).map(item=>[item.type,item.value]),[['keyword','sample'],['domain','example.org']]);}finally{dom.window.close();}
});
test('closed overlay preserves page markup/layout, updates virtual reused rows and drops late responses',async()=>{
 const dom=fixture('<table><tr><th>Keyword</th><th>Volume</th></tr><tr id="virtual"><td>first</td><td>2</td></tr></table>'),doc=dom.window.document,body=doc.body.innerHTML,calls=[];let resolveFirst;
 const layer=new AnnotationLayer(doc,{density:'full',request:async(name,params)=>{calls.push([name,params]);if(name==='lookup'&&params.objects[0]?.value==='first')return new Promise(resolve=>{resolveFirst=resolve;});return {items:params.objects.map(item=>({...item,info:{tier:'test',vol:0,kd:2,checked_at:1700000000}}))};}});
 try{const first=layer.refresh();await flush();assert.equal(layer.host.shadowRoot,null);assert.equal(doc.body.innerHTML,body);assert.equal(layer.root.querySelectorAll('.mark').length,1);
  doc.querySelector('#virtual td').textContent='second';await layer.refresh();resolveFirst({items:[{type:'keyword',value:'first',info:{tier:'skip',vol:9000}}]});await first;await flush();
  const badges=[...layer.root.querySelectorAll('.mark')];assert.equal(badges.length,1);assert.match(badges[0].title,/second/);assert.match(badges[0].textContent,/测一页/);assert.doesNotMatch(badges[0].textContent,/9000|不做/);assert.equal(doc.querySelector('#virtual').children.length,2);
  doc.querySelector('#virtual').remove();await layer.refresh();assert.equal(layer.root.querySelectorAll('.mark').length,0);
 }finally{layer.destroy();dom.window.close();}
});
test('object cap uses viewport above 300, ignores controls and owned pages, and settings can re-enable',async()=>{
 const rows=Array.from({length:600},(_,i)=>`<tr><td data-top="${i<400?-100:40}">word ${i}</td><td>1</td></tr>`).join('');const dom=fixture('<table><tr><th>Keyword</th><th>Vol</th></tr>'+rows+'</table>');
 try{const objects=recognizeObjects(dom.window.document);assert.equal(objects.length,200);assert.ok(objects.every(item=>Number(item.node.dataset.top)>0));
  const owned=new AnnotationLayer(dom.window.document,{owned:true,request:()=>assert.fail('owned page read')});assert.equal(owned.host,undefined);owned.destroy();
  const layer=new AnnotationLayer(dom.window.document,{enabled:false,request:async()=>({items:[]})});await layer.refresh();assert.equal(layer.entries.size,0);layer.configure({enabled:true});await layer.refresh();assert.equal(layer.entries.size,200);layer.configure({enabled:false});assert.equal(layer.entries.size,0);layer.destroy();
 }finally{dom.window.close();}
});
test('compact/full labels preserve observed zeroes and never derive small-site flags from numeric thresholds',()=>{
 const data={tier:'test',pool:true,vol:0,kd:0,authority:1,checked_at:1700000000};assert.equal(annotationLabel(data),'测一页 · 已在词池');assert.match(annotationLabel(data,'full'),/量 0 · KD 0 · 权重 1/);assert.doesNotMatch(annotationLabel(data,'full'),/小站/);assert.equal(annotationLabel({}),'＋');assert.match(annotationLabel({weak:true,analyzed:true}),/小站/);
});
test('content routes cannot run a basket batch or read annotations on owned work pages',async()=>{
 const calls=[],api={runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path},tabs:{query:async()=>[],sendMessage:async()=>{}}};const service=new CopilotBackground(api,async(name,params)=>{calls.push([name,params]);return {};});service.enabled=true;service.refreshOwnership=async()=>{};service.owned=()=>true;
 const sender={id:'fixture',tab:{id:1,url:'https://example.test/report'},url:'https://example.test/report',frameId:0};
 assert.equal(service.handle({type:'copilot.command',command:'basket_execute',params:{token:'fake'}},sender,()=>assert.fail('untrusted panel')),false);
 assert.equal(service.handle({type:'copilot.annotation_lookup',params:{objects:[]}},sender,()=>assert.fail()),false);service.owned=()=>false;service.refreshOwnership=async()=>{service.owned=()=>true;};
 const reply=await new Promise(resolve=>service.handle({type:'copilot.annotation_lookup',params:{objects:[]}},sender,resolve));assert.ok(reply.error);assert.equal(calls.length,0);
});
test('selection and basket panel require preview, primary confirm and external second confirm',async()=>{
 assert.ok(selectionTasks('sample').tasks.some(task=>task.action==='basket_add'));const dom=new JSDOM('<details id="work-basket"></details>');const calls=[];Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async()=>{}}});
 const panel=new BasketPanel(dom.window.document,async(name,params)=>{calls.push([name,params]);if(name==='basket_plan')return {token:'estimate',operation:'save',risk:'external',count:1,task_count:1,call_upper_bound:1,model_calls:0,estimated_tokens:0,estimated_seconds:null,timeout_upper_seconds:120,tools:[{capability:'pool.save',provider:'local',calls:1,risk:'external'}]};if(name==='basket_execute'&&!params.confirmation)return {secondary_required:true,confirmation:'second'};return {started:'job'};});
 try{panel.update({revision:1,items:[{id:'one',type:'keyword',value:'sample'}]});const check=dom.window.document.querySelector('input');check.checked=true;check.onchange();const find=text=>[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent===text);
  await find('全部存词池').onclick();assert.equal(calls.length,1);assert.match(dom.window.document.body.textContent,/预计 token/);await find('确认执行').onclick();assert.equal(calls.length,2);assert.match(dom.window.document.body.textContent,/再次确认才会执行/);await find('再次确认执行').onclick();assert.equal(calls[2][1].confirmation,'second');
 }finally{dom.window.close();}
});

test('merged result cards collect checked domains and URLs as typed basket objects',async()=>{
 const dom=new JSDOM('<article></article><p id="notice"></p>'),calls=[];
 try{renderResult(dom.window.document,dom.window.document.querySelector('article'),{id:'batch',action:'workflow.run',params:{flow:'synthetic'},result:{verdict:'Synthetic',level:'info',metrics:[],missing:[],process:[],next:[],records:[{domain:'example.test'},{url:'https://other.example.test/a'}],steps:[],artifacts:[]}},{command:async(name,params)=>{calls.push([name,params]);return {};},clipboard:{writeText:async()=>{}}});
  for(const input of dom.window.document.querySelectorAll('tbody input')){input.checked=true;input.onchange();}
  await [...dom.window.document.querySelectorAll('button')].find(button=>button.textContent==='加入工作篮').onclick();
  assert.deepEqual(calls[0][1].items.map(item=>[item.type,item.value]),[['domain','example.test'],['url','https://other.example.test/a']]);
 }finally{dom.window.close();}
});

test('search query anchors to visible search form when heading is hidden, and semantic questions need no question mark',()=>{
 const dom=fixture('<form role="search"><input value="PRIVATE_SENTINEL"></form><main><h1 hidden>Results</h1><div role="button" aria-expanded="false">How this works</div><div role="button" aria-expanded="false">如何使用这个工具</div></main>','https://www.google.com/search?q=sample');
 try{const objects=recognizeObjects(dom.window.document);assert.equal(objects[0].node,dom.window.document.querySelector('form'));assert.deepEqual(objects.map(item=>item.value),['sample','How this works','如何使用这个工具']);}finally{dom.window.close();}
});
