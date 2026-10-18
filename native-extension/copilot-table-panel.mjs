export class TablePanel{
 constructor(doc,request){doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.state?.confirmation)void request('confirm_table',{kind:'cancel',token:this.state.confirmation.token}).then(()=>this.refresh());});this.doc=doc;this.request=request;this.saved=new Map();this.columns=new Map();}
 async refresh(){try{this.state=await this.request('table_state');if(this.state.saved){const {key,result}=this.state.saved;this.saved.set(key,result);}this.render();}catch{this.doc.getElementById('table-tools').textContent='表格连接未就绪，请刷新侧栏。';}}
 render(){
  const doc=this.doc,root=doc.getElementById('table-tools');root.replaceChildren();for(const job of doc.querySelectorAll('.table-job,.local-table-error'))job.remove();
  const node=(tag,text)=>{const el=doc.createElement(tag);el.textContent=text;return el;};
  const button=(label,work)=>{const el=node('button',label);el.type='button';el.onclick=async()=>{el.disabled=true;try{await work();}catch{doc.getElementById('notice').textContent='表格操作未完成，请检查本机桥、导出目录和工作页状态。';}finally{el.disabled=false;}};return el;};
  root.append(button('识别当前表格',async()=>{this.state=await this.request('recognize_tables');this.render();}));
  const live=doc.getElementById('table-confirmation-live')||root;if(live!==root)live.replaceChildren();
  const confirmation=this.state?.confirmation;
  if(confirmation){const card=doc.createElement('section');card.className='confirmation-card';card.append(node('strong',confirmation.name),node('p',`${confirmation.headers.length} 列（${confirmation.headers.slice(0,4).join(' / ')}） · ${confirmation.rows} 行 · ${confirmation.pages||'?'} 页 · ${confirmation.format}`));if(confirmation.all)card.append(node('p',`将在后台打开同一页面收集 ${confirmation.pages||'?'} 页（最多200页）`));for(const [label,kind] of [['确认保存','confirm'],['取消','cancel'],['换一个表格','switch']])if(kind!=='switch'||confirmation.candidate_count>1)card.append(button(label,async()=>{const value=await this.request('confirm_table',{kind,token:confirmation.token});if(value.clipboard)await doc.defaultView.navigator.clipboard.writeText(value.clipboard);if(value.files){this.saved.set(confirmation.url+'|'+confirmation.id,value);doc.getElementById('notice').textContent='已保存：'+value.files.map(file=>file.path).join('；');}await this.refresh();}));live.append(card);}
  const capture=this.state?.capture;
  for(const table of capture?.tables||[]){
   const section=doc.createElement('section');section.className='table-strip';section.append(node('strong',table.name),node('p',`${table.headers.length} 列 · 已识别 ${table.rows.length} 行${table.incomplete?' · 可能不完整':''}`));
   const pager=table.pagination;section.append(node('p',`${pager.totalPages?'共 '+pager.totalPages+' 页':'页数未知'}${pager.totalRows?' · 约 '+pager.totalRows+' 行':''}`));
   const key=capture.url+'|'+table.id;
   const save=async format=>{await this.request('save_table',{id:table.id,format});await this.refresh();};
   section.append(button('保存为 Excel',()=>save('xlsx')),button('保存为 CSV',()=>save('csv')),button('复制为表格',async()=>{await this.request('copy_table',{id:table.id});await this.refresh();}));
   if(table.incomplete){const suggest=node('p',`保存全部${pager.totalPages?' '+pager.totalPages+' 页':''}为 Excel · ${pager.totalPages?'预计至少 '+Math.ceil(pager.totalPages*1.5)+' 秒':'耗时取决于页数和加载速度'}`);section.append(suggest,node('p','后台页面与当前页面筛选可能不同；仅保留地址中的筛选参数。'));
    section.append(button('保存全部',async()=>{await this.request('collect_table',{id:table.id});await this.refresh();}),button('只存当前页',()=>save('xlsx')));
   }
   const saved=this.saved.get(key);
   if(saved){for(const file of saved.files){section.append(node('p',file.path),button('打开文件',()=>this.request('table_open',{id:file.id})),button('打开所在文件夹',()=>this.request('table_open',{id:file.id,folder:true})));}
    section.append(node('p','选择关键词列 · 单次最多1000词，超出请先缩小范围'));const column=doc.createElement('select');column.setAttribute('aria-label','选择关键词所在列');table.headers.forEach((name,index)=>{const option=node('option',name||'未命名列 '+(index+1));option.value=String(index);column.append(option);});column.value=this.columns.get(key)||String(Math.max(0,table.headers.findIndex(name=>/keyword|关键词|^词$/i.test(name))));column.onchange=()=>this.columns.set(key,column.value);section.append(column);
    section.append(button('整表加入工作篮',()=>this.request('basket_add',{items:[{type:'table',value:saved.id}]})),button('所选列加入工作篮',()=>this.request('basket_add',{items:[{type:'table',value:saved.id,columns:[Number(column.value)]}]})));
    for(const [label,operation] of [['批量查词','check'],['存词池','save']])section.append(button(label,()=>this.request('table_column_action',{id:saved.id,column:Number(column.value),operation})));
   }
   root.append(section);
  }
  const active=(this.state?.jobs||[]).filter(job=>job.status==='executing');
  for(const job of active){const progress=doc.createElement('section');progress.className='table-job';progress.setAttribute('role','status');progress.setAttribute('aria-live','polite');progress.append(node('p',job.status==='executing'?`第 ${job.pages||1}/${job.totalPages||'?'} ${job.unit||'页'} · 已收 ${job.rowCount||0} 行`:job.reason||'表格已保存'));
   if(job.status==='executing')progress.append(button('停止并保存部分',()=>this.request('stop_table',{id:job.id})));progress.dataset.active='true';(doc.getElementById('running')||root).append(progress);
  }
  for(const job of (this.state?.jobs||[]).filter(item=>item.status==='failed')){const error=node('p',job.reason||'后台采集未完成，请重新识别后重试');error.className='local-table-error failure';root.append(error);}
  const count=doc.getElementById('running-count');if(count)count.textContent=String(Number(count.dataset.native||0)+active.length);if(active.length)doc.getElementById('running')?.querySelector('.empty')?.remove();
 }
}
