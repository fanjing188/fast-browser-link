// 中文注释：只读可见的搜索链接和曲线表/可访问标签；不访问页面私有接口、Cookie或隐藏字段。
export function readSearch(doc=globalThis.document){
 const blocked=[...doc.querySelectorAll('h1,h2,[role="alert"],iframe[title]')].map(el=>el.textContent+' '+(el.title||'')).join(' ');
 if(/captcha|verify you are human|unusual traffic|验证码|额度|sign in to continue|登录后/i.test(blocked)||doc.querySelector('input[type=password]'))return {error:'blocked'};
 const visible=el=>{for(let node=el;node;node=node.parentElement){const style=doc.defaultView.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0'||node.hidden||node.getAttribute('aria-hidden')==='true')return false;}return true;};
 const results=[],seen=new Set();
 for(const heading of doc.querySelectorAll('h3')){
  const link=heading.closest('a[href]');if(!link)continue;
  if(!visible(heading))continue;
  try{let url=new URL(link.href,doc.location.href);if(url.hostname.endsWith('google.com')&&url.pathname==='/url')url=new URL(url.searchParams.get('q')||url.searchParams.get('url'));if(!['http:','https:'].includes(url.protocol)||url.hostname.endsWith('google.com')||seen.has(url.href))continue;seen.add(url.href);results.push({url:url.href,title:heading.textContent.trim().slice(0,500)});if(results.length===10)break;}catch{}
 }
 return {results,source:'Google Search · visible result links'};
}
export function readTrends(keywords,region,period,doc=globalThis.document){
 const nodes=[...doc.querySelectorAll('h1,h2,[role="alert"],iframe[title]')],alert=nodes.map(node=>node.textContent+' '+(node.title||'')).join(' ');
 if(/captcha|verify you are human|unusual traffic|验证码|额度|sign in to continue|登录后/i.test(alert)||doc.querySelector('input[type=password]'))return {error:'blocked'};
 const visible=el=>{for(let node=el;node;node=node.parentElement){const style=doc.defaultView.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0'||node.hidden||node.getAttribute('aria-hidden')==='true')return false;}return !el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');};
 const cellText=cell=>{const walker=doc.createTreeWalker(cell,4);let text='',node;while((node=walker.nextNode()))if(node.parentElement&&visible(node.parentElement))text+=' '+node.textContent;return text.trim();};
 const series=keywords.map(keyword=>({keyword,region,period,points:[]}));
 // 中文注释：只接受有明确日期、词表头和0–100实测值的表格；无法读取时留空，不从SVG像素反推曲线。
 for(const table of doc.querySelectorAll('table,[role=table],[role=grid]')){
  if(!visible(table))continue;
  const rows=[...table.querySelectorAll('tr,[role=row]')].map(row=>[...row.querySelectorAll('th,td,[role=columnheader],[role=cell],[role=gridcell]')].map(cell=>visible(cell)?cellText(cell):''));
  if(rows.length<2)continue;const headers=rows[0];
  for(const item of series){const col=headers.findIndex(text=>text.toLowerCase().includes(item.keyword.toLowerCase()));if(col<1)continue;
   for(const row of rows.slice(1,401)){if(!/^\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?$/.test(row[0]||''))continue;const value=Number(row[col]);if(row[col]?.trim()&&Number.isFinite(value)&&value>=0&&value<=100)item.points.push({date:row[0],value});}
  }
 }
 return {series:series.filter(item=>item.points.length),source:'Google Trends · visible chart data table; independently normalized per comparison'};
}
export async function collectBrowserData(adapter,event,permitted,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random){
 const {kind,params}=event,context={incognito:!!event.incognito};
 const visit=async(url,read,keep=false)=>{if(!await permitted())throw Error('stopped');const work=await adapter.open(url,context);let result,kept=false;try{if(!await permitted())throw Error('stopped');result=keep?{opened:true}:await adapter.readData(work,read.func,read.args);if(result.error)throw Error('blocked');kept=keep;return result;}finally{if(!kept)await adapter.close(work);}};
 if(kind==='open')return visit(params.url,null,true);
 if(kind==='serp_top10'){
  const words=params.keywords||[];
  if(words.length>50)throw Error('public search batch limit is 50; use a configured bulk adapter');
  if(words.length>1){const queries=[];let partial=false;for(const keyword of words){if(queries.length)await delay((1.5+random()*1.5)*1000);try{const data=await visit('https://www.google.com/search?q='+encodeURIComponent(keyword),{func:readSearch,args:[]});queries.push({keyword,results:data.results});}catch{partial=true;break;}}return {queries,source:'Google Search · visible result links'+(partial?' · partial; background blocked or stopped':'')};}
  const url=params.url||'https://www.google.com/search?q='+encodeURIComponent(params.keyword||words[0]||'');
  if(new URL(url).hostname!=='www.google.com')throw Error('search source unavailable');
  return visit(url,{func:readSearch,args:[]});
 }
 if(kind!=='google_trends')throw Error('unsupported browser data');
 const words=params.keywords||[params.keyword];if(!words.length||words.length>50)throw Error('trend batch limit');
 const series=[];let count=0,reason='';
 try{for(let start=0;start<words.length;start+=5)for(const region of ['US','WORLD'])for(const period of ['12m','5y']){
  if(count++)await delay((1.5+random()*1.5)*1000);
  const group=words.slice(start,start+5),url=new URL('https://trends.google.com/trends/explore');url.searchParams.set('q',group.join(','));url.searchParams.set('date',period==='12m'?'today 12-m':'today 5-y');if(region==='US')url.searchParams.set('geo','US');
  const data=await visit(url.href,{func:readTrends,args:[group,region,period]});series.push(...data.series);
 }
 }catch{reason='后台曲线读取遇阻或停止，保留已取得部分';}
 return {series,source:'Google Trends · visible curve tables · US/world · 12m/5y'+(reason?' · '+reason:'')};
}
