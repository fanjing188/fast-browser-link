import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {renderWorkContext} from '../../native-extension/copilot-view.mjs';
import {localize} from '../../native-extension/copilot-i18n.mjs';
const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
const css=await readFile(new URL('../../native-extension/copilot-panel.css',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(done=>setImmediate(done));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(command=async()=>({})) {
 const dom=new JSDOM(html,{pretendToBeVisual:true}),doc=dom.window.document,calls=[];
 dom.window.HTMLDialogElement.prototype.showModal=function(){if(this.open)return;this._returnFocus=doc.activeElement;this.setAttribute('open','');(this.querySelector('[autofocus]')||this.querySelector('button,textarea,input'))?.focus();};
 dom.window.HTMLDialogElement.prototype.close=function(){if(!this.open)return;this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));this._returnFocus?.focus();};
 const context={command:async(name,params)=>{calls.push([name,params]);return command(name,params);}};
 const state={locale:'en',enabled:true,ready:true,agent:{id:'hermes',name:'Hermes',state:'connected'},user_direction:'Compare free plans',work:{goal:'Find a usable export plan',next_step:'Check the export limit',evidence:['Public pricing page'],constraints:['Use public information only'],open_questions:['Export quota is unknown']},work_feedback:[{id:'earlier-task',kind:'later',action:'seo.keyword_check',object:'sample keyword'}],suggestions:[]};
 const render=next=>renderWorkContext(doc,next||state,context);render();
 return {dom,doc,calls,state,render,close(){dom.window.close();}};
}
test('current goal exposes separate direction and public-log dialogs without inline details',()=>{
 const f=fixture();try{
  localize(f.doc,'en');const root=f.doc.getElementById('work-context'),direction=f.doc.getElementById('work-direction-dialog'),thinking=f.doc.getElementById('work-thinking-dialog');
  assert.equal(root.querySelector('details'),null);assert.match(root.textContent,/Current goal/);assert.equal(f.doc.getElementById('work-goal').textContent,f.state.user_direction);assert.equal(direction.tagName,'DIALOG');assert.equal(thinking.tagName,'DIALOG');assert.equal(direction.open,false);assert.equal(thinking.open,false);assert.equal(direction.querySelector('#work-form'),f.doc.getElementById('work-form'));assert.ok(thinking.contains(f.doc.getElementById('work-facts')));
  const adjust=f.doc.getElementById('work-adjust');adjust.focus();adjust.click();assert.equal(direction.open,true);assert.equal(f.doc.activeElement,f.doc.getElementById('work-direction'));f.doc.getElementById('work-direction-cancel').click();assert.equal(direction.open,false);assert.equal(f.doc.activeElement,adjust);assert.deepEqual(f.calls,[]);
  const log=f.doc.getElementById('work-thinking');log.focus();log.click();assert.equal(thinking.open,true);f.doc.getElementById('work-thinking-close').click();assert.equal(thinking.open,false);assert.equal(f.doc.activeElement,log);assert.deepEqual(f.calls,[]);
 }finally{f.close();}
});
test('direction submit is explicit, deduplicated and protected from polling until success closes its draft',async()=>{
 const pending=deferred();const f=fixture(async()=>{await pending.promise;const next={...f.state,user_direction:'Confirmed direction',work:{...f.state.work,goal:'Updated confirmed goal'}};f.render(next);return next;});try{
  f.doc.getElementById('work-adjust').click();const form=f.doc.getElementById('work-form'),input=f.doc.getElementById('work-direction'),dialog=f.doc.getElementById('work-direction-dialog');input.value='Only compare export limits';input.dispatchEvent(new f.dom.window.Event('input'));
  f.render({...f.state,user_direction:'Stale polling direction'});assert.equal(input.value,'Only compare export limits');assert.deepEqual(f.calls,[]);
  form.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));form.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));assert.deepEqual(f.calls,[['work_update',{direction:'Only compare export limits'}]]);assert.equal(form.getAttribute('aria-busy'),'true');assert.equal(dialog.open,true);
  f.render({...f.state,user_direction:'Another old snapshot'});assert.equal(input.value,'Only compare export limits');pending.resolve();await flush();assert.equal(dialog.open,false);assert.equal(form.hasAttribute('aria-busy'),false);
  f.doc.getElementById('work-adjust').click();assert.equal(input.value,'Confirmed direction','reopening uses the successful command state even before the next poll');f.doc.getElementById('work-direction-cancel').click();
  const newest={...f.state,user_direction:'Newest saved direction'};f.render(newest);f.doc.getElementById('work-adjust').click();assert.equal(dialog.open,true);assert.equal(input.value,'Newest saved direction');
 }finally{pending.resolve();f.close();}
});
test('failed direction submit keeps its dialog and text for an explicit retry',async()=>{
 let fail=true;const f=fixture(async()=>{if(fail)throw Error('synthetic write failure');return f.state;});try{
  f.doc.getElementById('work-adjust').click();const input=f.doc.getElementById('work-direction'),form=f.doc.getElementById('work-form'),dialog=f.doc.getElementById('work-direction-dialog');input.value='Keep this precise correction';input.dispatchEvent(new f.dom.window.Event('input'));form.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await flush();
  assert.equal(dialog.open,true);assert.equal(input.value,'Keep this precise correction');assert.match(f.doc.getElementById('work-notice').textContent,/Keep your text|保留输入/i);assert.equal(form.hasAttribute('aria-busy'),false);assert.equal(form.querySelector('button[type=submit]').disabled,false);f.render({...f.state,user_direction:'Old direction'});assert.equal(input.value,'Keep this precise correction');assert.equal(f.calls.length,1);
  fail=false;form.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await flush();assert.equal(dialog.open,false);assert.deepEqual(f.calls,[['work_update',{direction:'Keep this precise correction'}],['work_update',{direction:'Keep this precise correction'}]]);
 }finally{f.close();}
});
test('new work uses the scoped reset command and cannot bypass an in-flight correction',async()=>{
 const pending=deferred(),f=fixture(()=>pending.promise);try{
  f.doc.getElementById('work-adjust').click();const form=f.doc.getElementById('work-form');form.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await f.doc.getElementById('work-new').onclick();assert.equal(f.calls.length,1);pending.resolve({});await flush();
  await f.doc.getElementById('work-new').onclick();assert.deepEqual(f.calls.at(-1),['work_update',{reset:true}]);
 }finally{pending.resolve({});f.close();}
});
test('public thinking log renders evidence, constraints, questions, direction and public feedback without private reasoning',()=>{
 const f=fixture();try{
  const state={...f.state,work:{...f.state.work,evidence:['<img src=x onerror=alert(1)> Public evidence'],reasoning:'PRIVATE_WORK_REASONING',chain_of_thought:'PRIVATE_CHAIN'},reasoning:'PRIVATE_MODEL_REASONING',private_reasoning:'PRIVATE_DETAIL'};f.render(state);f.doc.getElementById('work-thinking').click();const dialog=f.doc.getElementById('work-thinking-dialog');
  for(const value of ['Public evidence','Use public information only','Export quota is unknown','Compare free plans','sample keyword'])assert.ok(dialog.textContent.includes(value),value);
  assert.equal(dialog.querySelector('img,script'),null);assert.doesNotMatch(dialog.textContent,/PRIVATE_WORK_REASONING|PRIVATE_CHAIN|PRIVATE_MODEL_REASONING|PRIVATE_DETAIL/);assert.deepEqual(f.calls,[]);
  f.render({...state,work:{...state.work,evidence:['New public evidence'],open_questions:['New unanswered question']}});assert.match(dialog.textContent,/New public evidence|New unanswered question/);assert.doesNotMatch(dialog.textContent,/<img src=x/);assert.equal(dialog.open,true);
 }finally{f.close();}
});
test('goal activity follows actual execution, following, pause, connection and error state in both languages',()=>{
 const f=fixture();try{
  for(const locale of ['zh','en'])for(const [change,activity] of [
   [{running:true},'advancing'],
   [{suggestions:[{id:'active',status:'executing'}]},'advancing'],
   [{suggestions:[{id:'queued',status:'queued'}]},'following'],
   [{suggestions:[{id:'cleanup',status:'stopping'}]},'following'],
   [{},'following'],
   [{idle_paused:true},'paused'],
   [{enabled:false},'paused'],
   [{enabled:false,running:true},'paused'],
   [{ready:false},'connecting'],
   [{recovering:true},'connecting'],
   [{diagnostic:'bridge_disconnected'},'error'],
   [{startup_error:{reason:'Unable to connect',reason_en:'Unable to connect'}},'error'],
   [{agent:{id:'hermes',name:'Hermes',state:'disconnected'}},'error']
  ]){
   f.render({...f.state,locale,...change});assert.equal(f.doc.getElementById('work-context').dataset.activity,activity,JSON.stringify({locale,change}));const label=f.doc.getElementById('work-status').textContent;assert.ok(label.trim());if(locale==='en')assert.doesNotMatch(label,/[\u3400-\u9fff]/);
  }
 }finally{f.close();}
});
test('goal motion covers active work and connecting while reduced-motion removes animation and displacement',()=>{
 const f=fixture();try{
  const style=f.doc.createElement('style');style.textContent=css;f.doc.head.append(style);const root=f.doc.getElementById('work-context'),rail=root.querySelector('.work-rail span'),signal=root.querySelector('.work-signal i');assert.ok(rail);assert.ok(signal);
  for(const [change,active] of [[{running:true},true],[{},true],[{enabled:false},false],[{idle_paused:true},false],[{ready:false},true],[{diagnostic:'bridge_disconnected'},false]]){
   f.render({...f.state,...change});for(const [element,name] of [[rail,'work-forward'],[signal,'work-signal']]){const animation=f.dom.window.getComputedStyle(element).animation;assert.equal(animation.includes(name),active,`${root.dataset.activity}: ${animation}`);}
  }
  const reduced=[...style.sheet.cssRules].find(rule=>rule.media?.mediaText.includes('prefers-reduced-motion'));assert.ok(reduced,'the local work motion has a reduced-motion override');
  const overrides=[...reduced.cssRules].filter(rule=>rule.style?.getPropertyValue('animation')==='none');assert.ok(overrides.some(rule=>rule.selectorText.includes('.work-rail span')));assert.ok(overrides.some(rule=>rule.selectorText.includes('.work-signal i')));
  for(const rule of overrides){assert.equal(rule.style.getPropertyPriority('animation'),'important');assert.equal(rule.style.getPropertyValue('transform'),'none');}
 }finally{f.close();}
});
