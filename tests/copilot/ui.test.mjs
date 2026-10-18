import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {statePresentation,renderDashboard} from '../../native-extension/copilot-view.mjs';
import {stableSnapshots} from '../../native-extension/copilot-observation.mjs';
import {CopilotBackground} from '../../native-extension/copilot-background.mjs';
const html=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
test('all dashboard states have Chinese labels and actionable errors',()=>{
 const cases=[{enabled:false},{enabled:true},{enabled:true,ready:true},{enabled:true,ready:true,running:true},{enabled:true,ready:true,idle_paused:true},{diagnostic:'acp_start_blocked'}];
 assert.deepEqual(cases.map(state=>statePresentation(state).label),['未开启','启动中','跟随中','推理中','空闲已暂停','出错']);
 assert.match(statePresentation({diagnostic:'execution_acp_restart_exhausted'}).message,/重新连接/);
 assert.match(statePresentation(cases.at(-1)).message,/重试/);assert.doesNotMatch(statePresentation(cases.at(-1)).message,/acp_start/);
});
test('result table, clipboard, report/save/followup requests and keyed updates',async()=>{
 const dom=new JSDOM(html),doc=dom.window.document,calls=[],copied=[];
 const state={enabled:true,ready:true,daily_usage:{input:50,cache_read:400,output:10},usage:{input:30,cache_read:100,output:3},suggestions:[{id:'a',scene:'seo',title:'关键词结果',action:'seo.keyword_check',params:{keyword:'sample'},status:'completed',tokens:500,report:'/synthetic/report.md',result:{summary:'有继续分析的价值',keywords:[{keyword:'sample one',vol:100,kd:12,group:'用途'},{keyword:'sample two',group:'问题'}]}}]};
 const context={command:async(...args)=>calls.push(args),clipboard:{writeText:async value=>copied.push(value)}};
 renderDashboard(doc,state,context);const article=doc.querySelector('article');assert.match(article.textContent,/用途/);assert.equal(article.querySelectorAll('tbody tr').length,2);
 await article.querySelector('[data-action=copy]').onclick();assert.deepEqual(copied,['sample one\nsample two']);
 await article.querySelector('[data-action=open_report]').onclick();assert.deepEqual(calls[0],['open_report',{id:'a'}]);
 await article.querySelector('[data-action=save_result]').onclick();assert.equal(calls[1][0],'save_result');
 await article.querySelector('[data-action=followup]').onclick();assert.equal(calls[2][1].action,'seo.longtail');
 state.suggestions[0].title='更新结论';renderDashboard(doc,state,context);assert.equal(doc.querySelector('article'),article);assert.match(article.textContent,/更新结论/);
 dom.window.close();
});
test('stable snapshot waits for quiet, but continuous mutation is bounded at five seconds',()=>{
 let now=0,id=0;const timers=new Map(),captured=[];
 const schedule=(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},cancel=key=>timers.delete(key);
 const advance=to=>{while(true){const next=[...timers].filter(([,v])=>v.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=to;};
 const stable=stableSnapshots(reason=>captured.push([now,reason]),{schedule,cancel});
 stable.change('导航到新页面');advance(799);assert.equal(captured.length,0);advance(800);assert.deepEqual(captured,[[800,'导航到新页面']]);
 stable.change('页面显著变化');for(let t=900;t<5800;t+=100){advance(t);stable.change();}advance(5800);assert.equal(captured.length,2);assert.equal(captured[1][0],5800);stable.stop();assert.equal(timers.size,0);
});
test('work tabs are excluded using ownership and duplicate navigation/snapshots are merged',async()=>{
 const sent=[],injected=[];
 const api={runtime:{id:'x',getURL:path=>'chrome-extension://x/'+path,sendMessage:async()=>{}},scripting:{getRegisteredContentScripts:async()=>[],registerContentScripts:async()=>{},executeScript:async p=>injected.push(p.target.tabId)},storage:{local:{get:async()=>({'fast.backgroundWorkspaces.v1':{tasks:[['owned',{requests:[['request',{tabId:8}]]}]]}}),set:async()=>{}},session:{set:async()=>{},remove:async()=>{}}},tabs:{query:async()=>[{id:1,url:'https://user.test/'},{id:7,url:'https://work.test/'},{id:8,url:'https://recovered.test/'}],sendMessage:async()=>{}}};
 const service=new CopilotBackground(api,async(method,params)=>{sent.push({method,params});return {};},id=>id===7);
 await service.settings({enabled:true});assert.deepEqual(injected,[1]);
 const page={url:'https://user.test/',title:'表格',items:[]},sender={id:'x',frameId:0,url:page.url,tab:{id:1}};
 await service.observation(sender,page,'导航到新页面');await service.observation(sender,page,'导航到新页面');await service.observation(sender,page,'页面显著变化');assert.equal(sent.filter(row=>row.method==='observe').length,1);
 const filled={...page,items:[{role:'row',name:'关键词 量 KD'},{role:'row',name:'example 100 12'}]};await service.observation(sender,filled,'页面显著变化');await service.observation(sender,filled,'页面显著变化');assert.equal(sent.filter(row=>row.method==='observe').length,2);
 for(const id of [7,8])await assert.rejects(()=>service.observation({...sender,tab:{id}},page,'点击 内容'));
});

test('immediate settings preserve manual values; first enable uses balanced defaults',async()=>{
 const {SettingsForm,presetValues,readSettings}=await import('../../native-extension/copilot-settings.mjs');
 const dom=new JSDOM(html),doc=dom.window.document,calls=[];
 const rows=[{id:'openai-codex:gpt-5.6-luna',label:'openai-codex · gpt-5.6-luna',default:true},{id:'openai-codex:gpt-6.1-sol',label:'openai-codex · gpt-6.1-sol'}];
 const models={inference:{available:rows,current:rows[0].id},execution:{available:rows,current:rows[0].id}};
 assert.equal(presetValues('saving',models).exec_model,rows[0].id);assert.equal(presetValues('quality',models).turn_multiplier,2);assert.equal(presetValues('quality',{}).inference_model,'');
 let state={enabled:false,settings_saved:false,config:{...presetValues('balanced',{}),exec_transport:'acp'}};
 const form=new SettingsForm(doc,async(name,params)=>{calls.push([name,params]);if(name==='models')return models;if(name==='configure')return state={...state,config:{...state.config,...params},settings_saved:true};if(name==='settings')return state={...state,...params};});
 form.update(state);await form.load();assert.equal(readSettings(doc).inference_model,'');assert.equal(readSettings(doc).exec_model,'');
 doc.getElementById('setting-exec_model').value='manual';doc.getElementById('exec_model-manual').value='custom:local:my-model';doc.getElementById('exec_model-manual').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 await form.load(true);assert.equal(readSettings(doc).exec_model,'custom:local:my-model');
 await form.saveField('exec_model');assert.equal(state.config.exec_model,'custom:local:my-model');await form.enable();assert.equal(calls.at(-1)[0],'settings');assert.equal(doc.querySelector('#preflight'),null);
 const before=readSettings(doc);form.update(state);assert.deepEqual(readSettings(doc),before);
 assert.match(doc.getElementById('setting-inference_model').textContent,/默认/);
 form.dispose();dom.window.close();
});
test('model discovery failure allows manual input and invalid IDs never start collaboration',async()=>{
 const {SettingsForm,presetValues}=await import('../../native-extension/copilot-settings.mjs');
 const dom=new JSDOM(html),doc=dom.window.document,calls=[];
 const form=new SettingsForm(doc,async(name)=>{calls.push(name);throw Error('fixture unavailable');});
 form.update({enabled:false,settings_saved:true,config:{...presetValues('balanced',{}),exec_transport:'oneshot'}});await form.load();assert.match(doc.getElementById('models-message').textContent,/手动/);
 doc.getElementById('setting-inference_model').value='manual';doc.getElementById('inference_model-manual').value='--provider evil';
 await form.saveField('inference_model');assert.deepEqual(calls,['models']);assert.equal(doc.getElementById('inference_model-manual').validity.valid,false);
 doc.getElementById('inference_model-manual').value='vendor:valid-model';await form.saveField('inference_model');assert.deepEqual(calls,['models','configure']);assert.match(doc.querySelector('[data-feedback=inference_model]').textContent,/保存失败/);
 dom.window.close();
});
test('execution cards show reported model and usage is separated by model',()=>{
 const dom=new JSDOM(html),doc=dom.window.document;
 renderDashboard(doc,{enabled:true,ready:true,daily_model_usage:{'openai-codex:gpt-5.6-luna':{input:30,cache_read:80,output:5}},suggestions:[{id:'model-task',title:'判读完成',action:'seo.longtail',params:{keyword:'example'},status:'completed',model:'openai-codex:gpt-5.6-luna',model_source:'hermes',result:{summary:'fixture',keywords:[],missing_data:['keyword_metrics：未配置数据源']}}]},{command:async()=>{}});
 assert.match(doc.querySelector('.model-label').textContent,/gpt-5.6-luna/);assert.match(doc.getElementById('model-usage').textContent,/缓存读/);assert.match(doc.getElementById('results').textContent,/缺数据/);dom.window.close();
});
