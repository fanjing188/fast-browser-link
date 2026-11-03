// 中文注释：新能力真实打包链验收；本地合成站、临时profile，不接触个人安装。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<h1 id="title">Ready</h1><button aria-label="Advance" onclick="window.count++;document.querySelector('#title').textContent='Count '+window.count">Advance</button>
<button aria-label="Next" onclick="window.records++;document.querySelector('#row').dataset.recordId=String(window.records)">Next</button><div id="row" data-record-id="0">same</div>
<button class="duplicate" onclick="window.duplicates++">Duplicate</button><button class="duplicate" onclick="window.duplicates++">Duplicate</button>
<label>Search<input id="query"></label><button aria-label="Run" onclick="window.runs++;document.querySelector('#result').textContent='ready:'+document.querySelector('input').value">Run</button><p id="result"></p>
<button aria-label="Download" onclick="const a=document.createElement('a');a.href='/rows.csv';a.download='rows.csv';a.click()">Download</button>
<script>window.count=0;window.records=0;window.duplicates=0;window.runs=0</script>`;
let downloads = 0;
const server = createServer((req, res) => {
  if (req.url === '/rows.csv') {
    downloads++;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rows.csv"');
    res.end('id,date\n1,2026-11-02\n2,2026-11-03\n');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `workflow-tools-${browser}`);
await mkdir(output, { recursive: true });
let session, failure;
let serial = 0;
const checks = [];
try {
  session = await openRealSession({
    browser,
    packageMode: true,
    label: 'wt',
    compactScratch: true,
  });
  await session.enableFullAccess();
  const task = () =>
    openTask(session, {
      owner: 'tools' + ++serial,
      origins: [origin],
      url: origin,
      title: '工作流工具验收',
      activate: false,
    });
  const script = async (t, code) => {
    const r = await helperCall('script', session.work, t.owner, t.task.id, 'import json\n' + code);
    assert.equal(r.exit_code, 0, JSON.stringify(r));
    assert.equal(r.execution_complete, true, JSON.stringify(r));
    assert.ok(r.stdout.trim(), JSON.stringify(r));
    return JSON.parse(r.stdout.trim());
  };
  const check = async (name, fn) => {
    const evidence = await fn();
    checks.push({ name, ok: true, evidence });
  };
  await check('持久检查点跨脚本恢复、跳过已确认步骤及自动报告脱敏', async () => {
    const t = await task();
    const code =
      "run_workflow('once',[{'action':'click','name':'Advance'},{'action':'fill','name':'Search','text':'PRIVATE_INPUT_489'}]";
    const first = await script(t, 'r=' + code + ')\nprint(json.dumps(r))');
    assert.equal(first.completed, true, JSON.stringify(first));
    assert.ok(first.files.json);
    const again = await script(t, 'print(json.dumps(' + code + ',resume=True)))');
    assert.equal(again.skipped_confirmed_steps, 2);
    assert.equal(await t.read('window.count'), 1);
    const report = await script(
      t,
      "from pathlib import Path\nr=workflow_report('once')\nprint(json.dumps({'report':r,'content':Path(r['files']['json']).read_text()}))",
    );
    assert.doesNotMatch(report.content, /PRIVATE_INPUT_489/);
    return {
      skipped: again.skipped_confirmed_steps,
      operations: again.operations,
      files: first.files,
    };
  });
  await check('批量逐项结算、失败项续做、不重跑成功项', async () => {
    const t = await task();
    const items =
      "[{'id':'bad','steps':[{'action':'click','name':'Duplicate'}]},{'id':'good','steps':[{'action':'click','name':'Advance'}]}]";
    const r = await script(t, "print(json.dumps(run_batch('batch'," + items + ')))');
    assert.equal(r.items[0].state, 'failed', JSON.stringify(r));
    assert.equal(r.items[1].state, 'completed');
    await t.read("document.querySelectorAll('.duplicate')[1].remove()");
    const resume = await script(
      t,
      "print(json.dumps(run_batch('batch'," + items + ',resume=True)))',
    );
    assert.equal(resume.completed, true, JSON.stringify(resume));
    assert.equal(resume.skipped_confirmed_steps, 1);
    assert.equal(await t.read('window.count'), 1);
    assert.equal(await t.read('window.duplicates'), 1);
    return { items: resume.items, skipped: resume.skipped_confirmed_steps };
  });
  await check('写入后脚本中断保持冻结，宿主只读核原后置条件后跳过', async () => {
    const t = await task();
    const items =
      "[{'id':'one','steps':[{'action':'click','name':'Advance','after':{'conditions':[{'kind':'element','selector':'#title','state':'text','text':'Count 1'}]}}]}]";
    const crash = await helperCall(
      'script',
      session.work,
      t.owner,
      t.task.id,
      'items=' +
        items +
        "\n_call=run_batch.__globals__['_call']\nr=_call('workflow_state',['begin',{'name':'crash','plan':items}])\n_call('workflow_state',['arm',{'name':'crash','token':r['token'],'index':'0:0'}])\nclick_element('Advance')\nraise RuntimeError('synthetic interruption')",
    );
    assert.equal(crash.exit_code, 1, JSON.stringify(crash));
    assert.match(crash.stderr, /synthetic interruption/, JSON.stringify(crash));
    const blocked = await script(
      t,
      "try:\n    run_batch('crash'," +
        items +
        ",resume=True)\nexcept BrowserError as e:\n    print(json.dumps({'code':e.code}))",
    );
    assert.equal(blocked.code, 'workflow_reconciliation_required');
    assert.equal(await t.read('window.count'), 1);
    const resolved = await script(
      t,
      "print(json.dumps(reconcile_workflow('crash'," + items + ')))',
    );
    assert.equal(resolved.resolved, true, JSON.stringify(resolved));
    const resumed = await script(
      t,
      "print(json.dumps(run_batch('crash'," + items + ',resume=True)))',
    );
    assert.equal(resumed.completed, true);
    assert.equal(resumed.skipped_confirmed_steps, 1);
    assert.equal(await t.read('window.count'), 1);
    return {
      frozen: blocked.code,
      resolved: resolved.resolved,
      skipped: resumed.skipped_confirmed_steps,
    };
  });
  await check('预算在派发前停止，显式调高后续做且保留耗用', async () => {
    const t = await task();
    const r = await script(
      t,
      "print(json.dumps(run_workflow('limited',[{'action':'click','name':'Advance'}],budget={'max_operations':1})))",
    );
    assert.equal(r.completed, false, JSON.stringify(r));
    assert.equal(r.reason, 'workflow_operation_budget');
    assert.equal(await t.read('window.count'), 0);
    const resumed = await script(
      t,
      "extend_workflow_budget('limited',{'max_operations':100})\nprint(json.dumps(run_workflow('limited',[{'action':'click','name':'Advance'}],resume=True,budget={'max_operations':100})))",
    );
    assert.equal(resumed.completed, true, JSON.stringify(resumed));
    assert.ok(resumed.operations > 1);
    assert.equal(await t.read('window.count'), 1);
    return { reason: r.reason, operations: resumed.operations };
  });
  await check('业务记录属性变化避免无进展误停，配置只回摘要', async () => {
    const t = await task();
    const r = await script(
      t,
      "print(json.dumps(run_workflow('progress',[{'action':'click','name':'Next'}]*4,progress=[{'selector':'#row','attribute':'data-record-id'}])))",
    );
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.equal(await t.read('window.records'), 4);
    const progress = await script(t, 'print(json.dumps(business_progress()))');
    assert.equal(progress.businessProgress.complete, true);
    assert.equal(progress.protection.stalled, false);
    return { business: progress.businessProgress };
  });
  await check('站点模板只存定位和参数键，复用前重新验证', async () => {
    const t = await task();
    const r = await script(
      t,
      "save_site_recipe('search',[{'action':'fill','name':'Search','value_key':'term'},{'action':'click','name':'Run'}])\nprint(json.dumps(run_site_recipe('search',{'term':'first'},workflow_name='recipe1')))",
    );
    assert.equal(r.completed, true, JSON.stringify(r));
    const next = await script(
      t,
      "print(json.dumps(run_site_recipe('search',{'term':'second'},workflow_name='recipe2')))",
    );
    assert.equal(next.completed, true, JSON.stringify(next));
    assert.equal(await t.read("document.querySelector('#result').textContent"), 'ready:second');
    await t.read("document.querySelector('[aria-label=Run]').setAttribute('aria-label','Changed')");
    const stale = await script(
      t,
      "try:\n    run_site_recipe('search',{'term':'third'},workflow_name='recipe3')\nexcept BrowserError as e:\n    print(json.dumps({'code':e.code}))",
    );
    assert.equal(stale.code, 'workflow_recipe_stale');
    assert.equal(await t.read('window.runs'), 2);
    return { stale: stale.code };
  });
  await check('重复下载算业务进展、文件记录数/日期/摘要验真', async () => {
    const t = await task();
    const r = await script(
      t,
      "print(json.dumps(run_workflow('download',[{'action':'click','name':'Download','after':{'conditions':[{'kind':'download'}]}}]*4)))",
    );
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.equal(downloads, 4);
    const file = await script(
      t,
      "d=downloads()['downloads'][-1]\nprint(json.dumps(verify_download(d['id'],expected={'format':'csv','min_rows':2,'max_rows':2,'required_columns':['id','date'],'date_column':'date','date_from':'2026-11-01','date_to':'2026-11-30'})))",
    );
    assert.equal(file.valid, true, JSON.stringify(file));
    assert.equal(file.rows, 2);
    assert.ok(file.path);
    const invalid = await script(
      t,
      "d=downloads()['downloads'][-1]\nprint(json.dumps(verify_download(d['id'],expected={'format':'csv','date_column':'date','date_to':'2026-11-01'})))",
    );
    assert.equal(invalid.valid, false);
    assert.equal(invalid.reason, 'date_range');
    return { requests: downloads, file };
  });
} catch (e) {
  failure = String(e.stack || e);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ browser, checks, failure: failure || null }, null, 2),
  );
  await session?.close();
  await new Promise((r) => server.close(r));
}
console.log(JSON.stringify({ browser, output, passed: checks.length, failure: failure || null }));
