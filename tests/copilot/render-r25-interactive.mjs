// 中文注释：交互预览仅注入内存合成回执，所有界面直接复用生产模块。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source = new URL('../../native-extension/', import.meta.url),
  output = new URL('../../docs/growth/design-r21-claude/', import.meta.url),
  frames = new URL('interactive-preview/', output);
await mkdir(frames, { recursive: true });
for (const [name, file] of [
  ['panel', 'copilot-panel.html'],
  ['popup', 'popup.html'],
  ['result', 'copilot-result.html'],
]) {
  const dom = new JSDOM(await readFile(new URL(file, source), 'utf8')),
    doc = dom.window.document,
    base = doc.createElement('base'),
    bootstrap = doc.createElement('script');
  base.href = '../../../../native-extension/';
  doc.head.prepend(base);
  bootstrap.type = 'module';
  // 中文注释：保留生产界面结构；入口统一在 mock 注入后加载，避免浏览器模块求值顺序产生竞态。
  doc.querySelectorAll('script[type=module][src]').forEach((script) => script.remove());
  bootstrap.src = '/docs/growth/design-r21-claude/interactive-preview/mock-runtime.mjs';
  doc.head.append(bootstrap);
  await writeFile(
    new URL(name + '.html', frames),
    '<!doctype html>' + doc.documentElement.outerHTML,
  );
  dom.window.close();
}
await writeFile(
  new URL('mock-runtime.mjs', frames),
  String.raw`
import {selectDashboardTab} from '/native-extension/copilot-view.mjs';
const origin=location.origin,role=location.pathname.split('/').at(-1).replace('.html',''),listeners=new Set(),now=Date.now()/1000;
const common={verdict:'已整理公开数据，建议先验证最相关的一组',level:'test',metrics:[{label:'记录',value:'24'},{label:'分组',value:'3'}],missing:[],process:['合成交互样例，仅用于界面验收。','示例数据不会发送到本地服务、网站或模型。'],next:[]};
const keywordResult={...common,metrics:[{label:'记录',value:'13'},{label:'分组',value:'2'}],groups:[{name:'室内布局',intent:'用户需要快速核对房间面积、家具尺寸与动线。',recommended:true,keywords:Array.from({length:12},(_,i)=>({keyword:['small living room layout','small apartment furniture planner','narrow bedroom layout','studio apartment layout'][i%4]+' '+(i+1),vol:120+i*40,kd:12+i,source:'合成样例',opportunity:i<4}))},{name:'材料估算',intent:'用户准备采购，需要先估算材料数量。',recommended:false,keywords:[{keyword:'floor tile calculator',vol:840,kd:22,source:'合成样例'}]}]};
const trendResult={...common,metrics:[{label:'月份',value:'12'},{label:'峰值月份',value:'2'}],verdict:'全年需求平稳，春季出现一轮小高峰',level:'info',pattern:'seasonal',series:[{keyword:'room layout planner',region:'US',period:'最近 12 个月（示例）',points:[26,31,42,67,82,70,51,45,43,39,36,33].map((value,index)=>({date:'2026-'+String(index+1).padStart(2,'0'),value}))}],peak_months:['4 月','5 月']};
const checkResult={...common,metrics:[{label:'关键词',value:'1'},{label:'SERP结果',value:'3'}],verdict:'搜索结果以可操作工具为主，可先验证单个用途',keyword:'room layout planner',tier:'测一页',intent:'用户希望直接规划房间布局，而非仅阅读装修文章。',vol:1200,kd:28,source:'合成样例',serp:[{rank:1,domain:'planner.example.test',page_type:'在线工具',small_site:false},{rank:2,domain:'layout.example.test',page_type:'房间规划工具',small_site:true},{rank:3,domain:'guide.example.test',page_type:'操作指南',small_site:false}],reasons:['前三项中有两项直接提供布局工具。','建议先验证一个明确的房间类型，避免入口过宽。']};
const notesResult={...common,metrics:[{label:'待核对事项',value:'3'}],verdict:'3 个需要优先验证的页面问题已整理',level:'info',bullets:['首屏展示了多个入口，建议把“开始规划”作为唯一的主按钮。','移动端结果表需要固定表头，并允许横向滚动查看尺寸。','导出前显示当前筛选范围，避免用户误以为包含全部历史数据。'],links:[{label:'示例来源链接',url:'https://example.test/reference'}],artifacts:[]};
const titles=['查找与当前房间规划主题最相关的关键词','拆分小户型家具摆放的长尾问题','核对房间面积计算器的搜索意图','整理公开页面里的可用布局案例','比较室内规划工具的结果呈现方式','提取移动端家具尺寸相关问题','寻找卧室动线规划的常见限制','检查材料估算页面的关键词分组','整理小客厅布局的可执行验证清单','核对开放式厨房布局的公开数据','收集阳台收纳规划的搜索问题','研究露台户外家具的季节性需求'];
const state={agent:{id:'hermes',name:'Hermes',state:'connected'},work:{goal:'比较房间规划工具的免费功能与导出限制',evidence:['当前打开的是工具功能和价格页面。','已读取公开的关键词和搜索结果。'],constraints:['优先核对免费用户可以完成的操作。'],open_questions:['部分工具的导出权限仍需页面核对。'],next_step:'整理功能差异，再核对最相关的工具。'},user_direction:'',work_feedback:[{id:'preview-feedback',kind:'later',object:'材料采购估算',action:'general.task'}],table_export_dir:'/tmp/fbl-preview/Downloads/fast-browser-link',table_config:{max_pages:50,delay_min:1.5,delay_max:3},locale:'zh',board_name:'',revision:1,context_revision:1,enabled:true,ready:true,settings_saved:true,show_ball:true,selection_popup:true,hermes_health:{state:'connected'},config:{mode:'balanced',max_parallel:3,context_limit:6000,turn_multiplier:1,exec_transport:'acp',inference_model:'',exec_model:''},daily_usage:{input:8400,cache_read:3000,output:1080},usage:{input:2100,cache_read:900,output:460},tool_context:{current:{object:'room layout planner'}},result_history:[],basket:{revision:1,items:[]},suggestions:[...titles.map((title,i)=>({id:'suggest-'+i,title,action:i%3===0?'seo.keyword_check':i%3===1?'seo.longtail':'general.task',scene:'general',params:{keyword:i===0?'room layout planner':i===1?'room layout planner small room':i===2?'room layout calculator':['small bedroom layout','furniture arrangement','room size calculator','kitchen layout planner'][i%4]},why:['先核对与你当前查看内容最接近的词，再判断是否需要进一步取数。','从公开页面提炼具体用途，减少无关建议干扰。','按相似度排序，展示最多 10 条，长说明限制行数。'][i%3],status:'pending',risk:'zero'})),{id:'live-task',title:'整理当前主题的公开页面与关键词',action:'workflow.run',params:{keyword:'room layout planner'},status:'executing',started_at:now-42,step:'browser_read',workflow_completed:2,workflow_total:6},{id:'done-check',title:'房间规划关键词的搜索意图核对',action:'seo.keyword_check',params:{keyword:'room layout planner'},status:'completed',completion_status:'completed',finished_at:now-15,result:checkResult},{id:'done-keywords',title:'小户型布局关键词分组',action:'seo.longtail',params:{keyword:'small room layout'},status:'completed',completion_status:'completed',finished_at:now-30,result:keywordResult},{id:'done-trends',title:'房间规划主题的季节趋势',action:'seo.trends',params:{keyword:'room layout planner'},status:'completed',completion_status:'completed',finished_at:now-60,result:trendResult},{id:'done-notes',title:'规划工具页面的体验核对清单',action:'general.task',params:{task:'整理公开页面的主要体验问题'},status:'completed',completion_status:'completed',finished_at:now-90,result:notesResult}]};
const previewTable={id:'0',dom_path:'table#planner-comparison',name:'房间规划工具对比表',headers:['工具','免费导出','说明'],rows:[[{text:'Planner A'},{text:'支持 CSV'},{text:'合成样例'}],[{text:'Planner B'},{text:'需核对'},{text:'合成样例'}],[{text:'Planner C'},{text:'支持图片'},{text:'合成样例'}]],pagination:{kind:'url',key:'page',current:1,totalPages:3,totalRows:9,offsetStep:1,next:true},incomplete:true};
const tableState={capture:{url:'https://example.test/planners?page=1',tables:[previewTable]},jobs:[],saved:null,confirmation:null};let tableFormat='xlsx',tableAction='save_table';
async function localTableCommand(name,params){
 if(name==='table_state')return structuredClone(tableState);
 if(['save_table','copy_table','collect_table'].includes(name)){
  if(params.id!==previewTable.id)throw Error('示例表格已变化');tableFormat=params.format||'xlsx';tableAction=name;tableState.confirmation={token:'preview-table-confirm',id:previewTable.id,name:previewTable.name,headers:previewTable.headers,rows:3,pages:3,format:name==='copy_table'?'clipboard':tableFormat,all:name==='collect_table',candidate_count:1,url:tableState.capture.url};return {confirmation:tableState.confirmation};
 }
 if(name==='confirm_table'){
  if(params.token!==tableState.confirmation?.token)throw Error('示例确认已失效');
  if(params.kind==='cancel'){tableState.confirmation=null;return {cancelled:true};}
  if(params.kind!=='confirm')throw Error('示例确认类型无效');tableState.confirmation=null;
  if(tableAction==='copy_table')return {clipboard:'工具\t免费导出\nPlanner A\t支持 CSV'};
  const result={id:'preview-table-export',rows:tableAction==='collect_table'?9:3,pages:tableAction==='collect_table'?3:1,files:[{id:'preview-table-file',path:'/tmp/fbl-preview/planner-comparison.'+tableFormat}],partial:false};tableState.saved={key:tableState.capture.url+'|'+previewTable.id,result};
  state.suggestions=state.suggestions.filter(row=>row.id!=='table-'+result.id);state.suggestions.push({id:'table-'+result.id,action:'table.export',status:'completed',completion_status:'completed',title:'表格已保存',params:{},finished_at:Date.now()/1000,result:{verdict:'表格已保存',export:result}});changed();send({action:'notice',text:'已模拟保存表格，未创建本机文件或访问示例网站。'});return result;
 }
 if(name==='stop_table')return {};
 throw Error('预览未实现此表格操作：'+name);
}
let agentCatalog={default_agent:'hermes',onboarding_required:false,busy:true,agents:[{id:'hermes',name:'Hermes',installed:true,configured:true,status:'configured',can_setup:false,setup_action:'configure'}]},agentJob=null,agentPhase=0,connectionVersion=0;
const publishAgent=()=>send({action:'agent-fixture',catalog:agentCatalog,enabled:state.enabled,ready:state.ready,agent:state.agent});
function agentEnabled(enabled){const version=++connectionVersion;state.enabled=enabled;state.ready=false;state.agent={id:'hermes',name:'Hermes',state:enabled?'connecting':'disconnected'};state.hermes_health={state:state.agent.state};agentCatalog.busy=enabled;agentCatalog.agents[0].can_setup=!enabled;changed();publishAgent();if(enabled)window.setTimeout(()=>{if(version!==connectionVersion||!state.enabled)return;state.ready=true;state.agent.state='connected';state.hermes_health={state:'connected'};changed();publishAgent();},1400);}
function onboardingExample(){connectionVersion++;agentJob=null;agentPhase=0;agentCatalog={default_agent:'hermes',onboarding_required:true,busy:false,agents:[{id:'hermes',name:'Hermes',installed:false,configured:false,status:'not_installed',can_setup:true,setup_action:'install_engine'}]};state.enabled=false;state.ready=false;state.settings_saved=false;state.agent={id:'hermes',name:'Hermes',state:'disconnected'};state.hermes_health={state:'disconnected'};state.work={};state.suggestions=[];tableState.capture=null;tableState.saved=null;changed();emit({type:'copilot.tables_changed'});publishAgent();emit({type:'copilot.agent_onboarding'});}
let directoryJob=null,directorySequence=0;
let logRevision=1,logId=3,tick=0,entries=[{id:1,time:now-42,type:'execution',event:'execute_start',summary:'开始整理公开页面',details:{task_id:'live-task',capability:'browser_read'}},{id:2,time:now-30,type:'execution',event:'execute_step',summary:'已读取第一批页面',details:{task_id:'live-task',step_index:1,step_name:'browser_read',count:4}},{id:3,time:now-25,type:'execution',event:'execute_complete',summary:'关键词分组完成',details:{task_id:'done-keywords',count:24,duration_ms:18200}}];
// 中文注释：仅共享当前合成任务及日志，避免详情页重新初始化后丢失预览执行结果。
const snapshotKey=id=>'fbl-r25-fixture-'+id;
if(role==='result'){
 const id=new URL(location.href).searchParams.get('id');
 if(typeof id==='string'&&/^(?:done-(?:keywords|trends|notes|check)|suggest-\d+|live-task)$/.test(id)){
  try{const snapshot=JSON.parse(window.sessionStorage.getItem(snapshotKey(id))||'null');if(snapshot?.row?.id===id&&snapshot.row.result){const index=state.suggestions.findIndex(row=>row.id===id);if(index>=0)state.suggestions[index]=snapshot.row;else state.suggestions.push(snapshot.row);if(Array.isArray(snapshot.entries))entries=snapshot.entries.filter(row=>row?.type==='execution').slice(-2000);logRevision=Math.max(logRevision,Number(snapshot.revision)||1);logId=Math.max(logId,...entries.map(row=>Number(row.id)||0));}}catch{}
 }
}
const send=value=>window.parent.postMessage({preview:true,...value},origin),emit=message=>{for(const listener of listeners)listener(message);};
const changed=()=>{state.revision++;emit({type:'copilot.changed',event:{revision:state.revision,type:'state'}});};
function log(row,event='execute_step'){const entry={id:++logId,time:Date.now()/1000,type:'execution',event,summary:event==='execute_step'?'执行步骤已更新':'任务状态已更新',details:{task_id:row.id,step_index:row.workflow_completed||1,step_name:row.step||'browser_read',count:4,duration_ms:1200}};entries.push(entry);entries=entries.slice(-2000);emit({type:'copilot.logs',event:{log_revision:++logRevision,entries:[entry]}});}
function result(id){const row=state.suggestions.find(row=>row.id===id);if(!row)throw Error('合成结果不存在');return structuredClone(row);}
async function command(name,params){
 if(name==='state'||name==='locale'||name==='log_client'||name==='suggestion_hold')return state;
 if(name==='agent_catalog')return structuredClone({...agentCatalog,...(agentJob?{job:agentJob}:{})});
 if(name==='agent_select'){if(params.agent_id!=='hermes'||agentCatalog.busy)throw Error('请关闭协作后切换默认 Agent');agentCatalog.default_agent=params.agent_id;publishAgent();return structuredClone(agentCatalog);}
 if(name==='agent_setup_start'){if(params.agent_id!=='hermes'||agentCatalog.busy)throw Error('示例配置当前不可用');agentJob={id:'preview-agent-setup',agent_id:'hermes',status:'pending',phase:'detect'};agentPhase=0;agentCatalog.busy=true;agentCatalog.agents[0].can_setup=false;publishAgent();return structuredClone(agentJob);}
 if(name==='agent_setup_status'){if(params.id!==agentJob?.id)throw Error('示例配置已失效');if(agentJob.status==='pending'){agentJob.phase=['detect','install_engine','profiles','integration','connection','complete'][Math.min(++agentPhase,5)];if(agentJob.phase==='complete'){agentJob.status='completed';agentJob.connection={inference:'connected',execution:'connected',check:'acp_initialize',model_call:false};Object.assign(agentCatalog,{onboarding_required:false,busy:false});Object.assign(agentCatalog.agents[0],{installed:true,configured:true,status:'configured',setup_action:'configure',can_setup:true});publishAgent();}}return structuredClone(agentJob);}
 if(name==='agent_setup_cancel'){if(params.id===agentJob?.id){agentJob.status='cancelled';agentCatalog.busy=false;agentCatalog.agents[0].can_setup=true;publishAgent();}return structuredClone(agentJob);}
 if(name==='work_update'){if(params.reset){state.work={};state.user_direction='';state.work_feedback=[];}else state.user_direction=params.direction;changed();return state;}
 if(name==='feedback'){const row=state.suggestions.find(row=>row.id===params.id);if(row){state.work_feedback.push({id:row.id,kind:params.kind,action:row.action,object:row.params?.keyword||row.title});state.suggestions=state.suggestions.filter(item=>item.id!==params.id);changed();}return state;}
 if(name==='result')return result(params.id);
 if(name==='open_result'){const row=result(params.id);window.sessionStorage.setItem(snapshotKey(params.id),JSON.stringify({row,entries,revision:logRevision}));send({action:'result',id:params.id});return {};}
 if(name==='logs_read')return {revision:logRevision,entries};
 if(name==='logs_export')return {jsonl:entries.map(row=>JSON.stringify(row)).join('\n')};
 if(name==='logs_clear'){entries=[];emit({type:'copilot.logs',event:{log_revision:++logRevision,reset:true,entries:[]}});return {revision:logRevision,entries:[]};}
 if(name==='directory_defaults')return {export_dir:'/tmp/fbl-preview/Downloads/fast-browser-link',logs_dir:'/tmp/fbl-preview/copilot/logs'};
 if(name==='directory_choose_start'){directoryJob={id:'preview-directory-'+(++directorySequence),status:'pending'};send({action:'directory',id:directoryJob.id});return {...directoryJob};}
 if(name==='directory_choose_status'){if(params.id!==directoryJob?.id)throw Error('示例选择已失效');return {...directoryJob};}
 if(name==='directory_choose_cancel'){if(params.id===directoryJob?.id)directoryJob.status='cancelled';return {...directoryJob};}
 if(name==='directory_open_logs'){send({action:'notice',text:'已模拟打开日志目录 /tmp/fbl-preview/copilot/logs；未打开系统目录。'});return {opened:true};}
 if(name==='fbl_pack_state')return {plugins:[],available:[],busy:state.enabled};
 if(name==='models')return {inference:{available:[]},execution:{available:[]}};
 if(name==='configure'){Object.assign(state.config,params);state.settings_saved=true;return state;}
 if(name==='settings'||name==='preferences'){if(Object.hasOwn(params,'enabled')){if(params.enabled&&agentCatalog.onboarding_required)throw Error('请先配置 Agent');agentEnabled(params.enabled);}Object.assign(state,params);for(const key of ['max_pages','delay_min','delay_max'])if(Object.hasOwn(params,'table_'+key))state.table_config[key]=params['table_'+key];changed();return state;}
 if(name==='basket_state')return state.basket;
 if(name==='basket_add'){for(const item of params.items||[])state.basket.items.push({...item,id:'basket-'+state.basket.items.length});state.basket.revision++;return {...state,basket:state.basket};}
 if(name==='basket_remove'||name==='basket_clear'){state.basket.items=name==='basket_clear'?[]:state.basket.items.filter(row=>!params.ids?.includes(row.id));return state;}
 if(name==='execute'||name==='retry'){const row=state.suggestions.find(row=>row.id===params.id);if(row){Object.assign(row,{status:'executing',started_at:Date.now()/1000,workflow_completed:0,workflow_total:6,step:'browser_read'});log(row,'execute_start');changed();}return state;}
 if(name==='stop'){const row=state.suggestions.find(row=>row.id===params.id);if(row){Object.assign(row,{status:'stopped',finished_at:Date.now()/1000,result:{...notesResult,verdict:'任务已停止，已整理的示例内容保留'}});log(row,'execute_stop');changed();}return state;}
 if(name==='ignore'){state.suggestions=state.suggestions.filter(row=>row.id!==params.id);changed();return state;}
 if(name==='clear_read')return state;
 if(['save_result','batch','next_action','followup','replenish','table_open','export_results','open_report','table_column_action','quick_task'].includes(name)){send({action:'notice',text:'预览操作已响应；未导出文件、访问来源或执行真实任务。'});return {};}
 if(name==='fbl_readiness'||name==='fbl_fix')return {ready:true,items:[{id:'browser',ok:true},{id:'integrity',ok:true}]};
 if(['capability_state','capability_reload','capability_health'].includes(name))return {capabilities:[],bindings:[],candidates:[]};
 throw Error('预览未实现此合成命令：'+name);
}
const chrome={i18n:{getUILanguage:()=> 'zh-CN'},windows:{getCurrent:async()=>({id:1})},downloads:{download:async()=>{send({action:'notice',text:'仅预览下载反馈，没有创建文件。'});return 1;}},runtime:{getManifest:()=>({version:'2.2.0'}),getURL:path=>'/native-extension/'+path,connect:()=>({onDisconnect:{addListener(){}}}),onMessage:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)},sendMessage:async message=>{
 try{
  if(message.type==='copilot.command')return {result:await command(message.command,message.params||{})};
  if(message.type==='copilot.local')return {result:await localTableCommand(message.command,message.params||{})};

  if(message.type==='copilot.reconnect')return {result:state};
  if(message.type==='popup_status')return {result:{connected:true,copilot:{enabled:state.enabled,ready:state.ready,agent:state.agent,hermes_health:state.hermes_health},tasks:[]}};
  if(message.type==='copilot.popup_settings'){if(message.enabled&&agentCatalog.onboarding_required){send({action:'agent-onboarding'});return {result:{enabled:false,onboarding_required:true}};}if(role==='popup'){state.enabled=message.enabled;send({action:'fixture-toggle',enabled:message.enabled});}else agentEnabled(message.enabled);return {result:{enabled:message.enabled}};}
  if(message.type==='copilot.open'){send({action:'board'});return {result:{opened:true}};}

  if(message.type==='connect')return {result:{connected:true}};
  throw Error('预览禁止未声明的运行时消息');
 }catch(error){return {error:error.message};}
}}};
globalThis.chrome=chrome;
window.close=()=>send({action:'close'});
globalThis.fetch=async()=>{throw Error('交互预览禁止网络调用');};
window.open=()=>{send({action:'notice',text:'示例来源不会在预览中打开。'});return null;};
document.addEventListener('click',event=>{if(event.target.closest('a')){event.preventDefault();send({action:'notice',text:'这是合成来源链接，预览不会访问外站。'});}},true);
window.addEventListener('message',event=>{if(event.origin!==origin||event.source!==window.parent||!event.data?.preview)return;const message=event.data;if(message.action==='onboarding-demo'&&role==='panel')onboardingExample();if(message.action==='agent-onboarding'&&role==='panel')emit({type:'copilot.agent_onboarding'});if(message.action==='fixture-toggle'&&role==='panel')agentEnabled(message.enabled);if(message.action==='agent-fixture'){agentCatalog=message.catalog;state.enabled=message.enabled;state.ready=message.ready;state.agent=message.agent;state.hermes_health={state:message.agent.state};emit({type:'changed'});}if(message.action==='directory-choice'&&directoryJob?.id===message.id)directoryJob=message.selected?{...directoryJob,status:'selected',path:'/tmp/fbl-preview/selected-exports'}:{...directoryJob,status:'cancelled'};if(message.action==='settings'&&role==='panel')document.getElementById('open-settings').click();if(message.action==='theme')document.documentElement.dataset.theme=message.theme;if(message.action==='select'&&role==='panel'){if(document.getElementById('settings-view').dataset.active==='true')document.querySelector('#settings-view [data-back]').click();selectDashboardTab(document,message.tab);}});
setInterval(()=>{tick++;const steps=['browser_read','search_web','browser_page','terminal_script','model','result'];for(const row of state.suggestions.filter(row=>row.status==='executing')){row.workflow_completed=(row.workflow_completed+1)%7;row.step=steps[Math.min(row.workflow_completed,5)];if(row.id!=='live-task'&&row.workflow_completed===6){Object.assign(row,{status:'completed',completion_status:'completed',finished_at:Date.now()/1000,result:notesResult});log(row,'execute_complete');}else log(row);}changed();},3000);

const entrypoints=role==='panel'?['copilot-panel.mjs']:role==='popup'?['popup.mjs']:['copilot-result.mjs'];
for(const entry of entrypoints)await import('/native-extension/'+entry);
`,
);
await writeFile(
  new URL('shell.mjs', frames),
  String.raw`
for(const key of Object.keys(window.sessionStorage))if(key.startsWith('fbl-r25-fixture-'))window.sessionStorage.removeItem(key);
const panel=document.getElementById('panel'),popup=document.getElementById('popup'),detail=document.getElementById('detail'),dialog=document.getElementById('result-dialog'),notice=document.getElementById('preview-notice');let theme='light';
function post(frame,value){frame.contentWindow.postMessage({preview:true,...value},location.origin);}
function notify(text){notice.textContent=text;}
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>post(panel,{action:'select',tab:button.dataset.tab});
document.getElementById('theme').onclick=()=>{theme=theme==='light'?'dark':'light';document.documentElement.dataset.theme=theme;for(const frame of [panel,popup,detail])post(frame,{action:'theme',theme});};
document.getElementById('onboarding-preview').onclick=()=>post(panel,{action:'onboarding-demo'});
document.getElementById('settings-preview').onclick=()=>post(panel,{action:'settings'});
const directoryDialog=document.getElementById('directory-dialog');let directoryId;
for(const button of directoryDialog.querySelectorAll('[data-directory-choice]'))button.onclick=()=>{post(panel,{action:'directory-choice',id:directoryId,selected:button.dataset.directoryChoice==='select'});directoryDialog.close();};
directoryDialog.addEventListener('cancel',()=>post(panel,{action:'directory-choice',id:directoryId,selected:false}));
document.getElementById('reset').onclick=()=>location.reload();
function close(){dialog.close();detail.src='about:blank';}
document.getElementById('close-detail').onclick=close;dialog.addEventListener('click',event=>{if(event.target===dialog)close();});dialog.addEventListener('cancel',()=>{detail.src='about:blank';});
for(const frame of [panel,popup,detail])frame.addEventListener('load',()=>{if(frame.src!=='about:blank')post(frame,{action:'theme',theme});});
window.addEventListener('message',event=>{if(event.origin!==location.origin||!event.data?.preview)return;const isPanel=event.source===panel.contentWindow,isPopup=event.source===popup.contentWindow,isDetail=event.source===detail.contentWindow;if(!isPanel&&!isPopup&&!isDetail)return;const value=event.data;if(value.action==='agent-fixture'&&isPanel)post(popup,value);if(value.action==='agent-onboarding'&&isPopup)post(panel,{action:'agent-onboarding'});if(value.action==='fixture-toggle'&&isPopup)post(panel,{action:'fixture-toggle',enabled:value.enabled});if(value.action==='directory'&&isPanel){directoryId=value.id;directoryDialog.showModal();}if(value.action==='result'&&isPanel&&typeof value.id==='string'&&/^(?:done-(?:keywords|trends|notes|check)|suggest-\d+|live-task)$/.test(value.id)){detail.src='interactive-preview/result.html?id='+encodeURIComponent(value.id);dialog.showModal();}if(value.action==='close'&&isDetail)close();if(value.action==='board'&&isPopup){panel.scrollIntoView({block:'start',behavior:'smooth'});notify('已定位协作看板。');}if(value.action==='notice')notify(String(value.text||'').slice(0,300));});
`,
);
await writeFile(
  new URL('interactive.html', output),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fast-browser-link · 交互微调预览</title><link rel="stylesheet" href="../../../native-extension/brand.css"><style>body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.6 var(--ui)}.preview-header{padding:20px 28px;border-bottom:1px solid var(--line);background:var(--paper)}h1{font-size:20px;margin:0 0 4px}.preview-header p{margin:0;color:var(--ink-2)}.preview-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.preview-layout{display:flex;gap:28px;padding:24px 28px;align-items:start;flex-wrap:wrap}.preview-column h2{font-size:13px;margin:0 0 10px;color:var(--ink-2)}iframe{box-sizing:content-box;display:block;border:1px solid var(--line);border-radius:12px;background:var(--paper)}#panel{width:360px;height:740px}#popup{width:320px;height:440px}.preview-help{max-width:340px;color:var(--ink-2)}.preview-help h2{color:var(--ink);font-size:14px}.preview-help li{margin:8px 0}#preview-notice{min-height:24px;color:var(--brand)}dialog{padding:0;border:1px solid var(--line);border-radius:14px;width:min(1060px,94vw);height:min(820px,90vh);max-width:none;background:var(--paper)}dialog::backdrop{background:rgb(20 27 40 / .4);backdrop-filter:blur(3px)}.dialog-heading{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink-2)}#detail{width:100%;height:calc(100% - 48px);border:0;border-radius:0}button{cursor:pointer}@media(max-width:500px){.preview-header{padding:16px}.preview-layout{padding:16px;gap:18px}#panel,#popup{max-width:calc(100% - 2px)}.preview-column{max-width:100%;min-width:0}dialog{width:96vw}}@media(max-width:380px){.preview-layout{padding:8px 5px}.preview-header{padding:16px 10px}}</style></head><body><header class="preview-header"><h1>Fast-browser-link · 交互微调预览</h1><p>生产界面 + 合成数据。安装与连接均为模拟演示；不会安装软件、连接本机桥、调用模型或写入真实数据。</p><nav class="preview-tools" aria-label="预览操作"><button data-tab="pending">建议 · 最多 10 条</button><button data-tab="running">进行中</button><button data-tab="results">结果</button><button data-tab="logs">日志</button><button id="settings-preview">设置</button><button id="onboarding-preview">新用户引导</button><button id="theme">切换浅深色</button><button id="reset">重置示例</button></nav><p id="preview-notice" role="status" aria-live="polite"></p></header><main class="preview-layout"><section class="preview-column"><h2>360 px 协作侧栏 · 可操作</h2><iframe id="panel" title="真实协作侧栏交互预览" src="interactive-preview/panel.html"></iframe></section><section class="preview-column"><h2>扩展弹窗 · 仅三项功能</h2><iframe id="popup" title="真实扩展弹窗交互预览" src="interactive-preview/popup.html"></iframe></section><aside class="preview-help"><h2>可以在这里微调细节</h2><ol><li>建议包含页面表格与 12 条合成输入，合计最多显示 10 条。表格卡片点击后才打开导出选项，确认前不会保存。</li><li>进行中每 3 秒更新步骤与日志，耗时按秒刷新。点击右侧日志进入任务日志页，返回后保留原标签。</li><li>结果提供关键词意图、分组表格、趋势图与文字清单。点击右侧详情在弹窗中查看生产结果界面。</li><li>扩展弹窗只有本地连接、云端连接、协作模式。关闭协作模式后看板按钮隐藏。</li></ol><p>这是本地交互样例，不代表真实 Agent、云端或数据源已连接。</p></aside></main><dialog id="directory-dialog" style="height:auto;max-width:380px;padding:20px"><h2 style="margin:0;font-size:16px">目录选择 · 合成预览</h2><p>正式插件将打开本机目录选择器。这里仅模拟选择或取消，不访问本机目录。</p><p><code>/tmp/fbl-preview/selected-exports</code></p><div class="preview-tools"><button data-directory-choice="select">使用示例目录</button><button data-directory-choice="cancel">取消</button></div></dialog><dialog id="result-dialog"><header class="dialog-heading"><span>结果详情 · 合成预览</span><button id="close-detail" type="button">关闭预览</button></header><iframe id="detail" title="任务结果详情" src="about:blank"></iframe></dialog><script type="module" src="interactive-preview/shell.mjs"></script></body></html>',
);
console.log('Generated interactive.html and 5 local preview assets; no real runtime calls.');
