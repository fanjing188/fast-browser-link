const controls='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[autocomplete*="password"],[data-fast-automation-overlay]';
export const normalized=value=>value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
export function classifySelection(text){
 text=text.trim();if(!text)return 'none';
 try{const url=new URL(text.includes('://')?text:'https://'+text);if(!/\s/u.test(text)&&/^https?:$/.test(url.protocol)&&url.hostname.includes('.')&&!url.username&&!url.password&&/^[\p{L}\p{N}.-]+$/u.test(url.hostname))return 'domain';}catch{}
 const parts=text.split(/[\n,，;；]+/u).map(word=>word.trim()).filter(Boolean);
 if(parts.length>1)return 'multiple';
 const units=[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(text)].filter(unit=>unit.isWordLike);
 return units.length>=1&&units.length<=8&&!/[。！？.!?;；\n]/u.test(text)?'keyword':'text';
}
export function selectedText(doc){
 const selection=doc.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return null;
 const range=selection.getRangeAt(0),element=node=>node?.nodeType===1?node:node?.parentElement;
 const start=element(range.startContainer),end=element(range.endContainer),common=element(range.commonAncestorContainer);
 if([start,end,common].some(node=>node?.closest('form,[role=dialog]')?.querySelector('input[type=password]')))return null;
 if(!start||!end||!common||start.closest(controls)||end.closest(controls)||common.closest(controls)||doc.activeElement?.closest?.(controls))return null;
 for(const node of common.querySelectorAll?.(controls)||[]){if(node.matches('input[type=checkbox],input[type=radio],input[type=button],input[type=submit]'))continue;if(range.intersectsNode(node))return null;}
 for(const node of [start,end]){const style=doc.defaultView.getComputedStyle(node);if(node.closest('[hidden],[aria-hidden="true"]')||style.display==='none'||style.visibility==='hidden')return null;}
 const text=selection.toString().trim();if(!text)return null;
 const rect=range.getBoundingClientRect?.();return {text,rect:rect||{left:0,right:0,top:0,bottom:0}};
}
export function selectionTasks(text,{url='',info={},suggestions=[],related=[],language='zh'}={}){
 const en=!language.startsWith('zh'),label=(zh,english)=>en?english:zh,type=classifySelection(text),words=[...new Set(text.split(/[\n,，;；]+/u).map(word=>word.trim()).filter(Boolean))];
 const make=(id,name,english,description,desc,action,params)=>({id,label:label(name,english),description:label(description,desc),action,params});
 const check=make('check','查词定档','Check keyword','SERP、量与难度','SERP, volume and difficulty','seo.keyword_check',{keyword:text});
 const trends=make('trends','查热度趋势','Check trends','美国与全球 · 12月 / 5年','US and world · 12m / 5y','seo.trends',{keyword:text});
 const save=make('save','存词池','Save to pool','本地保存，不调用模型','Local; no model','seo.save_pool',{keywords:words.map(keyword=>({keyword}))});
 const copy=make('copy','复制','Copy','复制选中文本','Copy selection','copy',{text});
 const urlValue=type==='domain'?(text.includes('://')?text:'https://'+text):'';
 let tasks=[];
 if(type==='keyword')tasks=[check,make('expand','扩词','Expand keywords','联想与问题词分组','Group suggestions and questions','seo.longtail',{keyword:text}),trends,make('serp','看 SERP','Read SERP','后台读取搜索结果','Read search results in background','seo.serp_breakdown',{url:'https://www.google.com/search?q='+encodeURIComponent(text)}),make('ranking','谁在排','Who ranks','前三站取数，合并一次判断','Fetch first 3 sites; one judgment','seo.ranking_sites',{keyword:text}),...(related.filter(word=>normalized(word)!==normalized(text)).length?[make('compare','查相关词对比','Compare trends','与当前页关键词对比，最多5词','Compare up to 5 page keywords','seo.trends',{keywords:[text,...related.filter(word=>normalized(word)!==normalized(text))].slice(0,5)})]:[]),save,copy];
 if(type==='domain')tasks=[make('competitor','竞品流量词','Competitor keywords','读取该站流量词','Fetch organic keywords','seo.competitor_keywords',{url:urlValue}),...(info.capabilities?.domain_rating?[make('rating','查域名评分','Check domain rating','使用已配置的取数器','Use configured adapter','seo.domain_rating',{url:urlValue})]:[]),make('pages','看热门页面','Top pages','读取已核实页面数据','Read measured page data','seo.top_pages',{url:urlValue}),make('open','在后台打开该站','Open site in background','独立工作页，不切换标签','Owned work page; no focus change','browser.open',{url:urlValue})];
 if(type==='multiple')tasks=[make('batch','批量查词','Check keywords','合并一次执行与判断','One execution and judgment','seo.keyword_check',{keywords:words}),make('batch-trends','批量查热度','Compare keyword trends','每5词一组 · 单批最多50词','Groups of 5 · up to 50 words','seo.trends',{keywords:words}),save,{...copy,label:label('复制为表格','Copy as table'),params:{text:words.join('\n')}}];
 if(type==='text')tasks=[make('translate','翻译','Translate','推理模型单轮回答','One inference-model response','general.task',{task:(en?'Translate the following text into English:\n':'翻译以下文字为中文：\n')+text}),make('explain','解释','Explain','推理模型单轮解释','One inference-model explanation','general.task',{task:(en?'Explain the following text:\n':'解释以下文字：\n')+text}),make('search','以选中文本搜索','Search selection','在后台打开搜索页','Open search in background','browser.open',{url:'https://www.google.com/search?q='+encodeURIComponent(text)}),copy];
 if(['keyword','multiple','domain'].includes(type)){let kind=type==='domain'?'domain':'keyword';if(type==='domain'){try{if(new URL(urlValue).pathname!=='/')kind='url';}catch{}}tasks.push(make('basket','加入工作篮','Add to basket','跨页收集，稍后批量执行','Collect across pages; run in one batch','basket_add',{items:(type==='multiple'?words:[text]).map(value=>({type:kind,value,source:url}))}));}
 const flows=suggestions.filter(row=>row.action==='workflow.run'&&(normalized(row.params?.object||'')===normalized(text)||row.contextual===true)).map(row=>({id:'flow-'+row.params.flow,label:row.title,description:row.available===false?label('需要先绑定：','Bind first: ')+(row.missing_capabilities||[]).join(', '):row.why,action:row.available===false?'bindings':row.action,params:row.params}));
 const matched=suggestions.filter(row=>row.status==='pending'&&row.params&&Object.values(row.params).some(value=>{if(typeof value!=='string')return false;if(normalized(value)===normalized(text))return true;try{return normalized(new URL(value).searchParams.get('q')||'')===normalized(text);}catch{return false;}})).map(row=>(()=>{const task=tasks.find(task=>task.action===row.action);return task?{...task,params:row.params}:null;})()).filter(Boolean).slice(0,2);
 const fallback=type==='keyword'?[url.includes('google.')&&url.includes('/search')?tasks.find(task=>task.id==='serp'):info.cached&&!info.has_trends?trends:check]:tasks.slice(0,1);
 const recommended=flows.length?flows.slice(0,2):matched.length?matched:fallback;
 return {type,tasks:[...recommended,...tasks.filter(task=>!recommended.some(item=>item.id===task.id))].slice(0,9).map((task,index)=>({...task,key:String(index+1),recommended:recommended.includes(task)}))};
}
export class SelectionPopup{
 constructor(doc,{request,language='zh',related=()=>[],signal,copy=text=>doc.defaultView.navigator.clipboard.writeText(text)}={}){
  this.doc=doc;this.request=request;this.language=language;this.related=related;this.copy=copy;this.enabled=true;this.suggestions=[];this.sequence=0;
  this.abort=new doc.defaultView.AbortController();const options={signal:this.abort.signal};signal?.addEventListener('abort',()=>this.destroy(),{once:true});
  doc.addEventListener('selectionchange',()=>this.schedule(),options);
  doc.addEventListener('pointerup',()=>this.schedule(),options);
  doc.addEventListener('pointerdown',event=>{if(event.target!==this.host)this.close();},options);
  doc.addEventListener('keydown',event=>this.keydown(event),{...options,capture:true});
  doc.defaultView.addEventListener('scroll',event=>{if(event.target!==this.host)this.close();},{...options,capture:true,passive:true});
 }
 setEnabled(value){this.enabled=!!value;if(!value)this.close();}
 setSuggestions(rows){this.suggestions=rows;if(this.current)this.render();}
 schedule(){clearTimeout(this.timer);if(!this.enabled)return;if(!selectedText(this.doc)){this.close();return;}this.timer=setTimeout(()=>this.show(),300);}
 close(){clearTimeout(this.timer);this.sequence++;this.current=null;this.host?.remove();this.host=null;}
 destroy(){this.close();this.abort.abort();}
 async show(){
  const selection=selectedText(this.doc);this.close();if(!this.enabled||!selection)return;
  if(selection.text.length>300){await this.request('selection_context',{text:selection.text.slice(0,12000)}).catch(()=>{});return;}
  this.current=selection;this.info={};this.render();const sequence=this.sequence;
  try{const info=await this.request('selection_info',{text:selection.text});if(sequence!==this.sequence||!this.current)return;this.info=info;this.suggestions=info.suggestions||this.suggestions;this.render();}catch{/* 中文注释：本机信息不可用时仍提供本地快捷任务，不显示虚构池状态。 */}
 }
 render(){
  if(!this.current)return;const doc=this.doc,en=!this.language.startsWith('zh'),t=(zh,english)=>en?english:zh;
  if(!this.host){this.host=doc.createElement('div');this.host.dataset.fastAutomationOverlay='copilot-selection';this.root=this.host.attachShadow({mode:'closed'});this.root.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});doc.documentElement.append(this.host);}
  const root=this.root,focused=root.activeElement?.dataset?.task;root.replaceChildren();const style=doc.createElement('style');style.textContent=':host{all:initial;position:fixed;z-index:2147483647;font:13px/1.4 system-ui;color-scheme:light dark;color:#19251e}section{width:min(320px,calc(100vw - 16px));box-sizing:border-box;max-height:calc(100vh - 16px);overflow:auto;border:1px solid #b8c6bd;border-radius:10px;background:#fff;padding:8px}header{padding:5px 6px 9px;border-bottom:1px solid #d8dfda;overflow-wrap:anywhere}strong{font-size:13px;font-weight:600}p{margin:2px 0;color:#4d5c53;font-size:12px}button{display:flex;align-items:center;gap:10px;width:100%;min-height:42px;border:0;border-radius:5px;background:none;color:inherit;text-align:start;font:inherit;cursor:pointer;padding:6px}button:hover{background:#edf3ef}button:focus-visible{outline:2px solid #286849;outline-offset:-2px}button:disabled{opacity:.55;cursor:wait}small{color:#4d5c53}kbd{margin-inline-start:auto;font:12px system-ui;border:1px solid #c9d3cc;padding:0 5px;border-radius:3px}.group{margin:8px 6px 3px;color:#286849;font-weight:600;font-size:12px}.icon{width:16px;text-align:center}.cached{color:#286849;border:1px solid #c9d3cc;margin:5px 0 0;min-height:32px}@media(prefers-color-scheme:dark){:host{color:#e4ebe6}section{background:#18231d;border-color:#526159}header{border-color:#435149}p,small{color:#bbc7bf}button:hover{background:#2c3c32}.group,.cached{color:#a5d5b7}}';root.append(style);
  const section=doc.createElement('section');section.setAttribute('role','dialog');section.setAttribute('aria-label',t('划词快捷任务','Selection tasks'));const header=doc.createElement('header'),text=doc.createElement('strong');text.textContent=this.current.text;header.append(text);
  if(this.info.pool){const pool=doc.createElement('p');pool.textContent=t('在词池 · ','In pool · ')+(this.info.pool.tier||t('档位未提供','tier unavailable'))+' · '+(this.info.pool.last_checked||t('日期未提供','date unavailable'));header.append(pool);}
  if(this.info.cached){const button=doc.createElement('button');button.className='cached';button.textContent=t('查过 · ','Checked · ')+this.info.cached.tier+' · '+new Date(this.info.cached.at*1000).toISOString().slice(0,10);button.onclick=event=>{if(!event.isTrusted)return;const id=this.info.cached.id;this.close();void this.request('open_cached',{id});};header.append(button);}
  section.append(header);const menu=selectionTasks(this.current.text,{url:doc.location.href,info:this.info,suggestions:this.suggestions,related:this.related(),language:this.language});this.tasks=menu.tasks;
  let lastGroup=null;for(const task of menu.tasks){if(task.recommended!==lastGroup){const title=doc.createElement('p');title.className='group';title.textContent=task.recommended?t('推荐','Recommended'):t('快捷任务','Quick tasks');section.append(title);lastGroup=task.recommended;}
   const button=doc.createElement('button'),icon=doc.createElement('span'),body=doc.createElement('span'),name=doc.createElement('span'),description=doc.createElement('p'),key=doc.createElement('kbd');icon.className='icon';icon.textContent=task.action==='copy'?'⎘':task.action==='seo.trends'?'↗':'›';name.textContent=task.label;description.textContent=task.description;key.textContent=task.key;body.append(name,description);button.append(icon,body,key);button.dataset.task=task.id;button.onclick=event=>{if(event.isTrusted)void this.run(task);};section.append(button);}
  root.append(section);this.position(section,this.current.rect);if(focused)[...root.querySelectorAll('button')].find(button=>button.dataset.task===focused)?.focus();
 }
 position(section,rect){const win=this.doc.defaultView,width=Math.min(320,win.innerWidth-16),height=Math.min(section.getBoundingClientRect().height||450,win.innerHeight-16);let x=Math.max(8,Math.min(rect.right,win.innerWidth-width-8)),y=rect.bottom+6;if(y+height>win.innerHeight-8)y=Math.max(8,rect.top-height-6);
  // 中文注释：优先选区右下；若覆盖网页主按钮，移至选区另一侧。不会修改或点击网页控件。
  for(const button of this.doc.querySelectorAll('button,[role=button],input[type=submit]')){const box=button.getBoundingClientRect();if(box.width&&box.height&&box.left<x+width&&box.right>x&&box.top<y+height&&box.bottom>y){const left=rect.left-width-6;if(left>=8)x=left;else if(rect.top-height-6>=8)y=rect.top-height-6;}}
  this.host.style.left=x+'px';this.host.style.top=y+'px';
 }
 keydown(event){if(!event.isTrusted||!this.current||event.ctrlKey||event.metaKey||event.altKey)return;if(event.key==='Enter'&&this.root?.activeElement?.matches('button'))return;if(event.key==='Escape'){event.preventDefault();this.close();return;}if(this.doc.activeElement?.closest?.(controls)&&this.doc.activeElement!==this.host)return;const task=event.key==='Enter'?this.tasks[0]:this.tasks.find(task=>task.key===event.key);if(task){event.preventDefault();event.stopPropagation();void this.run(task);}}
 async run(task){const text=this.current?.text,selection=this.current;this.close();try{
  if(task.action==='copy')await this.copy(task.params.text);
  else if(task.action==='basket_add')await this.request('basket_add',task.params);
  else if(task.action==='bindings')await this.request('open_capabilities',{});
  else{const result=await this.request('quick_task',{action:task.action,params:task.params});if(result.secondary_required){this.current=selection;this.render();const confirm=this.doc.createElement('button');confirm.textContent=this.language.startsWith('zh')?'对外动作 · 再次确认执行':'External action · confirm again';confirm.onclick=async event=>{if(!event.isTrusted)return;confirm.disabled=true;try{await this.request('confirm_task',{id:result.id,confirmation:result.token});this.close();}finally{confirm.disabled=false;}};this.root.append(confirm);}}
 }catch{await this.request('selection_error',{text:text||''}).catch(()=>{});}}
}
