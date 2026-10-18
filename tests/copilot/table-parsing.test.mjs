import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {captureTables} from '../../native-extension/copilot-tables.mjs';
import {tableConfirmation} from '../../native-extension/copilot-table-confirm.mjs';
import {TablePanel} from '../../native-extension/copilot-table-panel.mjs';
import {readFile} from 'node:fs/promises';

function fixture(html,url='https://example.test/'){
 const dom=new JSDOM(html,{url,pretendToBeVisual:true});
 dom.window.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[this.getBoundingClientRect()];};
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,right:420,top:30,bottom:230,width:400,height:200});
 return {dom,doc:dom.window.document,close(){dom.window.__fastTableConfirmation?.control('cancel');dom.window.close();}};
}
const table='<table><thead><tr><th>x</th><th>y1</th></tr></thead><tbody>'+[1,2,3].map(i=>`<tr><td>2026-10-0${i}</td><td>${i*10}</td></tr>`).join('')+'</tbody></table>';
const chart=`<widget><div class="widget-title">热度随时间变化的趋势</div><div aria-label="A chart."><svg></svg><div aria-label="A tabular representation of the data in the chart.">${table}</div></div></widget>`;

test('Trends chart tables use query labels, a visible chart target and their own pagination scope',()=>{
 const f=fixture(`<html lang="zh"><body>${chart}<widget><div class="pagination">当前显示的是第1-5个主题（共6个）</div><button>Next</button></widget></body></html>`,'https://trends.google.com/trends/explore?q=plant%20spacing&geo=US-WY');
 try{const capture=captureTables(f.doc),t=capture.tables[0];assert.equal(capture.tables.length,1);assert.deepEqual(t.headers,['日期','plant spacing']);assert.equal(t.name,'热度随时间变化的趋势');assert.equal(t.pagination.kind,'none');assert.equal(t.pagination.totalRows,null);assert.equal(t.incomplete,false);assert.equal(f.doc.querySelector(t.visual_path).getAttribute('aria-label'),'A chart.');}finally{f.close();}
});

test('separate table sections never share pagination controls or declared totals',()=>{
 const f=fixture(`<section>${table}<div class="pagination">共 3 页 · 共 9 行</div><button>Next</button></section><section>${table}</section>`);
 try{const [a,b]=captureTables(f.doc).tables;assert.equal(a.pagination.kind,'button');assert.equal(a.pagination.totalRows,9);assert.equal(b.pagination.kind,'none');assert.equal(b.pagination.totalRows,null);assert.equal(b.incomplete,false);}finally{f.close();}
});

test('wrapped ARIA cells retain columns while private content and nested tables stay excluded',()=>{
 const f=fixture('<div role="grid"><div role="row"><div><span role="columnheader">词</span><span role="columnheader">量</span></div></div>'+[1,2,3].map(i=>`<div role="row"><div><span role="gridcell">word${i}<span data-private>PRIVATE</span></span><span role="gridcell">${i}<table><tr><td>NESTED</td></tr></table></span></div></div>`).join('')+'</div>');
 try{const t=captureTables(f.doc).tables[0];assert.equal(t.rows.length,3);assert.deepEqual(t.rows[0].map(c=>c.text),['word1','1']);assert.doesNotMatch(JSON.stringify(t),/PRIVATE|NESTED/);}finally{f.close();}
});
test('grouped headers and row spans form a rectangular export without dropping records',()=>{
 const f=fixture('<table><thead><tr><th rowspan="2">地区</th><th colspan="2">指标</th></tr><tr><th>数量</th><th>变化</th></tr></thead><tbody><tr><th scope="row" rowspan="2">US</th><td>10</td><td>1</td></tr><tr><td>20</td><td>2</td></tr><tr><th scope="row">UK</th><td colspan="2">暂无数据</td></tr></tbody></table>');
 try{const t=captureTables(f.doc).tables[0];assert.deepEqual(t.headers,['地区','指标 / 数量','指标 / 变化']);assert.deepEqual(t.rows.map(row=>row.map(cell=>cell.text)),[['US','10','1'],['US','20','2'],['UK','暂无数据','暂无数据']]);}finally{f.close();}
});

test('chart confirmation scans the visible chart instead of the offscreen accessibility table',()=>{
 const f=fixture(chart,'https://trends.google.com/trends/explore?q=plant%20spacing');let shadow,scrolled=0;
 const attach=f.dom.window.Element.prototype.attachShadow;f.dom.window.Element.prototype.attachShadow=function(options){shadow=attach.call(this,options);return shadow;};
 const visual=f.doc.querySelector('[aria-label="A chart."]');visual.getBoundingClientRect=()=>({left:40,right:640,top:100,bottom:400,width:600,height:300});
 f.doc.querySelector('table').getBoundingClientRect=()=>({left:-10000,right:-9900,top:0,bottom:1000,width:100,height:1000});visual.scrollIntoView=()=>scrolled++;
 try{const captured=captureTables(f.doc);tableConfirmation({token:'chart',tables:captured.tables,url:captured.url},f.doc);assert.equal(shadow.querySelector('.frame').style.left,'40px');assert.equal(shadow.querySelector('.frame').style.width,'600px');assert.ok(shadow.querySelector('.beam'));assert.equal(shadow.querySelectorAll('.cell').length,0);assert.equal(scrolled,0);assert.equal(tableConfirmation({action:'confirm',token:'chart'},f.doc).rows,3);}finally{f.close();}
});

test('offscreen chart is brought into view and its removal cancels confirmation',()=>{
 const f=fixture(chart,'https://trends.google.com/trends/explore?q=plant%20spacing');const visual=f.doc.querySelector('[aria-label="A chart."]');let scrolled=0;
 visual.getBoundingClientRect=()=>({left:40,right:640,top:-500,bottom:-200,width:600,height:300});visual.scrollIntoView=()=>scrolled++;
 try{const captured=captureTables(f.doc);tableConfirmation({token:'offscreen',tables:captured.tables,url:captured.url},f.doc);assert.equal(scrolled,1);visual.remove();assert.throws(()=>tableConfirmation({action:'confirm',token:'offscreen'},f.doc),/removed/);}finally{f.close();}
});

test('table panel displays a safe stage error without exposing unexpected exception text',async()=>{
 const markup=await readFile(new URL('../../native-extension/copilot-panel.html',import.meta.url),'utf8');
 for(const safe of [false,true]){const f=fixture(markup);try{
  f.dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  const state={capture:{url:'https://example.test/',tables:[{id:'0',name:'Table',headers:['a','b'],rows:[],pagination:{}}]}};
  const panel=new TablePanel(f.doc,async name=>{if(name==='table_state')return state;throw Object.assign(Error(safe?'本机导出失败，请检查导出目录。':'PRIVATE_NATIVE_ERROR'),{code:safe?'table_operation_failed':undefined});});
  await panel.refresh();await panel.command('execute',{id:panel.suggestions()[0].id});await [...f.doc.querySelectorAll('#table-tools button')].find(b=>b.textContent==='保存为 Excel').onclick();
  assert.doesNotMatch(f.doc.getElementById('table-tools').textContent,/PRIVATE_NATIVE_ERROR/);assert.match(f.doc.getElementById('table-tools').textContent,safe?/本机导出失败/:/表格操作未完成/);
 }finally{f.close();}}
});
