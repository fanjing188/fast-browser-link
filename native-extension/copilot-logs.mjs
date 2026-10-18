// 中文注释：固定行高窗口化列表；详情独立显示，展开JSON不会改变列表行高或滚动定位。
export class LogPanel{
 constructor(doc,request,{language='zh',clipboard=doc.defaultView.navigator?.clipboard,download}={}){
  this.doc=doc;this.request=request;this.en=!language.startsWith('zh');this.clipboard=clipboard;this.download=download;this.entries=[];this.revision=0;this.follow=true;this.pendingClients=[];this.connected=null;this.rowHeight=48;this.selected=null;this.lastScroll=0;
  this.viewport=doc.getElementById('log-viewport');this.list=doc.getElementById('log-list');this.active=false;
  doc.getElementById('log-filter').onchange=()=>{this.selected=null;this.viewport.scrollTop=0;this.render();};doc.getElementById('log-search').oninput=()=>{this.selected=null;this.viewport.scrollTop=0;this.render();};
  this.viewport.addEventListener('scroll',()=>{const near=this.viewport.scrollHeight-this.viewport.scrollTop-this.viewport.clientHeight<24;if(this.viewport.scrollTop<this.lastScroll&&!near)this.follow=false;if(near&&this.follow!==false)this.follow=true;this.lastScroll=this.viewport.scrollTop;this.render();});
  doc.getElementById('log-pause').onclick=()=>{this.follow=!this.follow;if(this.follow)this.latest();else this.render();};doc.getElementById('log-latest').onclick=()=>this.latest();
  doc.getElementById('log-clear').onclick=()=>this.action('log-clear',async()=>this.set(await request('logs_clear')));
  doc.getElementById('log-copy').onclick=()=>this.action('log-copy',async()=>{const value=await request('logs_export');await this.clipboard.writeText(value.jsonl);this.notice(this.t('已复制','Copied'));});
  doc.getElementById('log-export').onclick=()=>this.action('log-export',async()=>{const value=await request('logs_export');await this.download(value.jsonl);this.notice(this.t('已发起导出','Export started'));});
  const Observer=doc.defaultView.ResizeObserver;this.observer=Observer?new Observer(()=>{this.preview();if(this.active)this.render();}):null;this.observer?.observe(this.viewport);
 }
 t(zh,en){return this.en?en:zh;}
 notice(text){this.doc.getElementById('log-notice').textContent=text;}
 async action(id,work){const button=this.doc.getElementById(id);if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');try{await work();}catch{this.notice(this.t('日志操作未完成，请检查连接或文件权限','Log action failed. Check connection or file permissions.'));}finally{button.disabled=false;button.removeAttribute('aria-busy');}}
 async load(){try{this.set(await this.request('logs_read'));}catch{this.notice(this.t('日志暂不可用','Logs unavailable'));}}
 set(value){const incoming=value.entries||[];if(value.revision<this.revision){const merged=new Map([...incoming,...this.entries.filter(row=>typeof row.id==='number')].map(row=>[row.id,row]));this.entries=[...merged.values()].sort((a,b)=>a.id-b.id).slice(-2000);}else{this.revision=value.revision||0;this.entries=incoming.slice(-2000);}this.selected=null;this.doc.getElementById('log-detail').hidden=true;this.doc.getElementById('log-detail').querySelector('pre').textContent='';if(value.error)this.notice(this.t('日志未能持久化，请检查本机目录权限','Log persistence failed. Check local directory permissions.'));this.preview();if(this.active)this.render();}
 append(event){if(event.error){this.notice(this.t('日志未能持久化，请检查本机目录权限','Log persistence failed. Check local directory permissions.'));return;}if(event.revision<=this.revision)return;this.revision=event.revision;if(event.reset){this.entries=(event.entries||[]).slice(-2000);this.selected=null;this.doc.getElementById('log-detail').hidden=true;}else{const incoming=new Map(this.entries.map(row=>[row.id,row]));for(const row of event.entries||[])incoming.set(row.id,row);this.entries=[...incoming.values()].slice(-2000);}this.preview();if(this.active){if(this.follow)this.latest();else this.render();}}
 preview(){const root=this.doc.getElementById('recent-logs');if(!root)return;root.replaceChildren();for(const row of this.entries.slice(-3).reverse()){const button=this.doc.createElement('button');button.type='button';button.textContent=this.summary(row);button.onclick=()=>this.doc.getElementById('open-logs').click();root.append(button);}}
 filtered(){const type=this.doc.getElementById('log-filter').value,search=this.doc.getElementById('log-search').value.toLocaleLowerCase();return this.entries.filter(row=>(!type||type==='errors'&&row.error||row.type===type)&&(!search||[this.summary(row),row.type,JSON.stringify(row.details)].join(' ').toLocaleLowerCase().includes(search)));}
 summary(row){
  const detail=row.details||{},parts=[this.en?row.summary_en:row.summary];
  if(detail.provider)parts.push(detail.provider);if(detail.capability)parts.push(detail.capability);if(detail.page)parts.push(this.t(`第 ${detail.page} 页`,`page ${detail.page}`));
  if(detail.snapshot_bytes!==undefined)parts.push(`${(detail.snapshot_bytes/1024).toFixed(1)} KiB`);
  if(detail.increment_bytes!==undefined)parts.push(`${detail.increment_bytes.toLocaleString()} B`);
  if(detail.missing)parts.push(this.t(`缺项 ${detail.missing}`,`missing ${detail.missing}`));
  if(detail.added!==undefined)parts.push(this.t(`新增 ${detail.added} / 更新 ${detail.updated||0} / 撤下 ${detail.removed||0}`,`+${detail.added} / updated ${detail.updated||0} / removed ${detail.removed||0}`));
  if(detail.phase==='judgment')parts.push(this.t('模型判断','Model judgment'));if(detail.phase==='fetch')parts.push(this.t('取数器','Data fetch'));if(detail.phase==='command')parts.push(this.t('脚本调用','Script call'));if(detail.phase==='browser')parts.push(this.t('后台报表','Background report'));if(detail.phase==='hermes')parts.push(this.t('工具后备','Tool fallback'));
  return parts.filter(Boolean).join(' · ');
 }
 latest(){this.follow=true;this.viewport.scrollTop=Math.max(0,this.filtered().length*this.rowHeight-this.viewport.clientHeight);this.lastScroll=this.viewport.scrollTop;this.render();}
 render(){
  const rows=this.filtered(),height=this.viewport.clientHeight||480,start=Math.min(Math.max(0,rows.length-Math.ceil(height/this.rowHeight)),Math.max(0,Math.floor(this.viewport.scrollTop/this.rowHeight)-3)),end=Math.min(rows.length,start+Math.ceil(height/this.rowHeight)+6);
  if(this.selected===null)this.doc.getElementById('log-detail').hidden=true;
  this.doc.getElementById('log-count').textContent=`${rows.length} / ${this.entries.length}`;this.doc.getElementById('log-pause').textContent=this.t(this.follow?'暂停滚动':'继续滚动',this.follow?'Pause scroll':'Resume scroll');this.doc.getElementById('log-pause').setAttribute('aria-pressed',String(!this.follow));this.doc.getElementById('log-latest').hidden=this.follow;
  this.list.replaceChildren();this.list.style.paddingTop=`${start*this.rowHeight}px`;this.list.style.paddingBottom=`${(rows.length-end)*this.rowHeight}px`;
  if(!rows.length){const empty=this.doc.createElement('p');empty.className='empty';empty.textContent=this.t('暂无日志','No logs yet');this.list.append(empty);}
  for(const row of rows.slice(start,end)){
   const line=this.doc.createElement('button');line.type='button';line.className='log-line';line.dataset.type=row.type;line.dataset.id=row.id;line.dataset.error=String(!!row.error);line.setAttribute('aria-expanded',String(this.selected===row.id));
   const icon=this.doc.createElement('span');icon.textContent={capture:'◉',inference:'◇',execution:'▹',system:'○'}[row.type]||'○';icon.className='log-icon';icon.setAttribute('aria-label',this.t({capture:'采集',inference:'推理',execution:'执行',system:'系统'}[row.type],row.type));
   const clock=this.doc.createElement('time');clock.textContent=new Date(row.time*1000).toLocaleTimeString(this.en?'en-GB':'zh-CN',{hour12:false});clock.title=new Date(row.time*1000).toLocaleString();
   const text=this.doc.createElement('span');text.className='log-summary';text.textContent=this.summary(row);text.title=text.textContent;text.setAttribute('data-user-content','');
   const metrics=this.doc.createElement('span');metrics.className='log-metrics';const detail=row.details||{},tokens=detail.tokens??(detail.input||0)+(detail.cache_read||0)+(detail.output||0);metrics.textContent=[detail.duration_ms!==undefined?`${(detail.duration_ms/1000).toFixed(1)}s`:'',tokens?`${detail.estimated?'≈':''}${tokens.toLocaleString()} tok`:detail.estimated_tokens?`≈${detail.estimated_tokens} tok`:''].filter(Boolean).join(' · ');line.append(icon,clock,text,metrics);line.onclick=()=>this.details(row);this.list.append(line);
  }
 }
 details(row){
  this.selected=row.id;const root=this.doc.getElementById('log-detail');root.hidden=false;root.open=true;root.querySelector('summary').textContent=this.summary(row);const fields=root.querySelector('dl');fields.replaceChildren();
  for(const [key,value] of Object.entries(row.details||{})){const name=this.doc.createElement('dt'),data=this.doc.createElement('dd');name.textContent=key;data.textContent=typeof value==='object'?JSON.stringify(value):String(value);fields.append(name,data);}
  root.querySelector('pre').textContent=JSON.stringify(row,null,2);root.querySelector('pre').closest('details').open=false;this.render();
 }
 async connection(connected){
  if(this.connected===connected&&(!connected||!this.pendingClients.length))return;const prior=this.connected;this.connected=connected;
  if(!connected){this.pendingClients.push('disconnected');this.entries=[...this.entries,{id:'local-'+Date.now(),time:Date.now()/1000,type:'system',event:'disconnected',summary:'连接中断或状态未确认',summary_en:'Connection lost or unconfirmed',error:true,details:{phase:'bridge'},volatile:true}].slice(-2000);if(this.active)this.render();return;}
  if(prior===false)this.pendingClients.push('reconnected');
  const pending=this.pendingClients.splice(0);for(let index=0;index<pending.length;index++){try{await this.request('log_client',{event:pending[index]});}catch{this.pendingClients.unshift(...pending.slice(index));break;}}
  if(prior===false)await this.load();
 }
 dispose(){this.observer?.disconnect();}
}
