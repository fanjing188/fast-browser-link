// 中文注释：生产组件加合成数据生成离线样稿；没有浏览器、Native RPC、工具查询或模型调用。
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {BasketPanel} from '../../native-extension/copilot-basket.mjs';
import {AnnotationLayer} from '../../native-extension/copilot-annotations.mjs';
import {renderDashboard} from '../../native-extension/copilot-view.mjs';
const root=new URL('../../native-extension/',import.meta.url),output=new URL('../../docs/growth/offline-r16/',import.meta.url);
await mkdir(output,{recursive:true});
const [html,brand,css]=await Promise.all(['copilot-panel.html','brand.css','copilot-panel.css'].map(file=>readFile(new URL(file,root),'utf8')));
const colors=(brand.match(/@media\(prefers-color-scheme:dark\)\{(:root,:host\{[^}]+\})\}/)?.[1]||'')+':root{color-scheme:dark}';
const items=Array.from({length:20},(_,i)=>({id:'sample-'+i,type:'keyword',value:'sample keyword '+(i+1),source:'https://example.test/report'}));
const lightRoot=brand.match(/:root(?:,:host)?\s*\{[^}]+\}/)?.[0]||'';
const files=[];
for(const theme of ['light','dark'])for(const kind of ['annotations','basket','confirmation','automatic']){
 const annotationPage='<h1>公开报表 · 合成数据</h1><table class="sample-table"><tr><th>Keyword</th><th>Volume</th><th>KD</th></tr><tr><td>sample keyword 1</td><td>120</td><td>18</td></tr><tr><td>sample keyword 2</td><td>80</td><td>9</td></tr><tr><td>unreviewed keyword</td><td>—</td><td>—</td></tr></table>';
 const dom=new JSDOM(kind==='annotations'?'<main class="sample-page">'+annotationPage+'</main>':html,{url:'https://example.test/report',pretendToBeVisual:true}),doc=dom.window.document;
 doc.defaultView.Element.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
 doc.defaultView.Element.prototype.getBoundingClientRect=function(){const index=this.closest('tr')?.rowIndex||0;return {left:30,right:360,top:125+index*44,bottom:157+index*44,width:390,height:32};};
 let layer;
 if(kind==='annotations'){
  layer=new AnnotationLayer(doc,{density:'full',request:async(name,params)=>({items:params.objects.map((item,index)=>({...item,info:index===0?{tier:'test',pool:true,vol:120,kd:18,checked_at:1700000000}:index===1?{tier:'skip',vol:80,kd:9,checked_at:1700000000}:{}}))})});
  await layer.refresh();const markup=layer.root.innerHTML.replaceAll(':host','#annotation-layer');layer.destroy();const copy=doc.createElement('div');copy.id='annotation-layer';copy.innerHTML=markup;const fixed=(theme==='dark'?colors:lightRoot).match(/\{([^}]+)\}/)?.[1]||'';copy.style.cssText=fixed+';color-scheme:'+theme;doc.body.append(copy);
 }else{
  const panel=new BasketPanel(doc,async name=>name==='basket_plan'?{token:'synthetic',model_id:'synthetic-fast',count:20,task_count:1,call_upper_bound:5,model_calls:1,estimated_tokens:3200,estimated_seconds:null,timeout_upper_seconds:480,tools:[{capability:'keyword.metrics',provider:'local-metrics-fixture',calls:2,risk:'metered'},{capability:'serp.top',provider:'search-fixture',calls:2,risk:'metered'},{capability:'keyword.judge',provider:'local-rule-fixture',calls:1,risk:'zero'}]}:{started:'synthetic'},{language:'zh'});
  panel.selected=new Set(items.map(item=>item.id));panel.update({revision:1,items,groups:{keyword:20}});doc.getElementById('work-basket').open=true;
  if(kind==='confirmation')await [...doc.getElementById('work-basket').querySelectorAll('button')].find(button=>button.textContent==='批量查词定档').onclick();
  if(kind==='automatic'){
   doc.getElementById('work-basket').open=false;
   renderDashboard(doc,{enabled:true,ready:true,locale:'zh',suggestions:[{id:'local-synthetic',action:'local.lookup',params:{value:'sample keyword 1'},automatic:true,title:'读取本机信息',scene:'general',status:'completed',model_source:'local',tokens:0,result:{verdict:'已自动查到：测一页 · 已在词池',level:'info',metrics:[{label:'本次模型','value':'0'},{label:'本次额度','value':'0'}],missing:[],process:['只读本机缓存与词池快照'],next:[],bullets:['sample keyword 1 · 量 120 · KD 18','查过日期来自已有结果；没有新查询'],links:[],artifacts:[]}}],usage:{input:0,cache_read:0,output:0}},{command:async()=>({})});
  }
  for(const input of doc.querySelectorAll('input[type=checkbox]'))input.toggleAttribute('checked',input.checked);
 }
 doc.querySelectorAll('script,link').forEach(node=>node.remove());for(const image of doc.querySelectorAll('img'))image.remove();
 const note=doc.createElement('p');note.className='offline-note';note.textContent='R16 离线样稿 · 合成数据 · 按钮不执行任务 · 非 Edge 实站验收';doc.body.prepend(note);
 if(kind==='annotations')doc.body.style.cssText='max-width:900px;margin:24px';
 const style=brand+'\n'+css+'\n'+(theme==='dark'?colors:lightRoot+':root{color-scheme:light}')+'\nbody{max-width:460px;margin:24px auto;padding:18px}.offline-note{font-size:12px;color:var(--muted);padding-bottom:12px;border-bottom:1px solid var(--line)}.sample-page{width:760px;max-width:100%}.sample-table{width:540px}.sample-page h1{font-size:20px}.sample-table th,.sample-table td{height:43px;padding:8px}.sample-table td:first-child{min-width:260px}';
 const name=kind+'-'+theme+'.html';await writeFile(new URL(name,output),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R16 '+kind+' '+theme+'</title><style>'+style+'</style>'+doc.body.outerHTML+'</html>');files.push({name,kind,theme});dom.window.close();
}
await writeFile(new URL('index.html',output),'<!doctype html><meta charset="utf-8"><title>R16 离线样稿</title><h1>R16 离线样稿</h1><p>生产组件 + 合成回执，无真实网页、模型或额度调用。</p><ul>'+files.map(file=>'<li><a href="'+file.name+'">'+file.kind+' · '+file.theme+'</a></li>').join('')+'</ul>');
console.log(JSON.stringify({samples:files.length,index:new URL('index.html',output).pathname}));
