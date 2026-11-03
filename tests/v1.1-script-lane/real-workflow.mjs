// 中文注释：手动真实验收，仅临时 Chrome/Edge、本地合成数据和显式私有 TMPDIR。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Workflow fixture</title></head><body>
<main><h1>通用执行验收</h1><label>Search <input id="search"></label>
<button id="query">Query</button><div id="result"></div>
<button id="download">Download</button><button id="popup">Popup</button>
<button id="navigate">Navigate</button><button disabled>Disabled</button>
<button>Duplicate</button><button>Duplicate</button></main>
<script>
window.queryCount=0;
document.querySelector('#query').onclick=async()=>{window.queryCount++; const data=await (await fetch('/api?q='+encodeURIComponent(document.querySelector('#search').value))).json();document.querySelector('#result').textContent=data.value};
document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href='/file.csv';a.download='fixture.csv';document.body.append(a);a.click();a.remove()};
document.querySelector('#popup').onclick=()=>window.open('/popup','fixture-popup','width=480,height=400');
document.querySelector('#navigate').onclick=()=>location.href='/next';
</script></body></html>`;
const server = createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        value: 'ready:' + new URL(req.url, 'http://fixture').searchParams.get('q'),
      }),
    );
  } else if (req.url === '/file.csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="fixture.csv"');
    res.end('id,value\n1,synthetic\n');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `workflow-${browser}`);
await mkdir(output, { recursive: true });
const checks = [];
let session;
let failure;
try {
  session = await openRealSession({
    browser,
    packageMode: true,
    label: 'wf',
    compactScratch: true,
    allowPopups: true,
  });
  await session.enableFullAccess();
  const task = await openTask(session, {
    owner: 'workflow',
    origins: [origin],
    url: origin,
    title: '通用执行验收',
  });
  const script = async (code) => {
    const receipt = await helperCall(
      'script',
      session.work,
      task.owner,
      task.task.id,
      'import json\n' + code,
    );
    assert.equal(receipt.exit_code, 0, JSON.stringify(receipt));
    assert.equal(receipt.execution_complete, true, JSON.stringify(receipt));
    return JSON.parse(receipt.stdout.trim());
  };
  const check = async (name, fn) => {
    await fn();
    checks.push({ name, ok: true });
  };
  await check('能力声明和诊断', async () => {
    assert.equal(
      (await script("print(json.dumps(diagnose_target('Duplicate'))) ")).reason,
      'ambiguous_target',
    );
    assert.equal(
      (await script("print(json.dumps(diagnose_target('Disabled'))) ")).reason,
      'target_disabled',
    );
    assert.equal((await script("print(json.dumps(diagnose_target('Query'))) ")).reason, 'ready');
  });
  await check('填写、响应与结果共同核验', async () => {
    const steps = [
      { action: 'fill', name: 'Search', text: 'fixture' },
      {
        action: 'click',
        name: 'Query',
        after: {
          mode: 'all',
          conditions: [
            { kind: 'response', url: origin + '/api?q=fixture', status: 200 },
            { kind: 'element', selector: '#result', state: 'text', text: 'ready:fixture' },
          ],
        },
      },
    ];
    const result = await script(`print(json.dumps(run_steps(${JSON.stringify(steps)})))`);
    assert.equal(result.completed, true, JSON.stringify(result));
    assert.equal(await task.read('window.queryCount'), 1);
  });
  await check('后置失败保留已送达回执并停止后续写入', async () => {
    const steps = [
      {
        action: 'click',
        name: 'Query',
        after: { timeout: 0.5, conditions: [{ kind: 'element', selector: '#never' }] },
      },
      { action: 'click', name: 'Query' },
    ];
    const result = await script(`print(json.dumps(run_steps(${JSON.stringify(steps)})))`);
    assert.equal(result.reason, 'postcondition_failed', JSON.stringify(result));
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].dispatched, true);
    assert.equal(await task.read('window.queryCount'), 2);
  });
  await check('下载监听先于动作且仅匹配新下载', async () => {
    const steps = [
      { action: 'click', name: 'Download', after: { conditions: [{ kind: 'download' }] } },
    ];
    const result = await script(`print(json.dumps(run_steps(${JSON.stringify(steps)})))`);
    assert.equal(result.completed, true, JSON.stringify(result));
    assert.equal(result.steps[0].after.conditions[0].evidence.state, 'complete');
  });
  await check('URL导航前监听和新文档重新读取', async () => {
    const steps = [
      {
        action: 'click',
        name: 'Navigate',
        after: { conditions: [{ kind: 'url', url: origin + '/next' }] },
      },
    ];
    const result = await script(`print(json.dumps(run_steps(${JSON.stringify(steps)})))`);
    assert.equal(result.completed, true, JSON.stringify(result));
  });
  await check('任意条件等待与超时', async () => {
    const result = await script(
      "print(json.dumps(wait_until([{'kind':'element','selector':'#never'},{'kind':'element','selector':'#query'}],mode='any'))) ",
    );
    assert.deepEqual(result.matched, [1]);
    const timeout = await script(
      "print(json.dumps(wait_until([{'kind':'element','selector':'#never'}],timeout=.3)))",
    );
    assert.equal(timeout.satisfied, false);
    assert.equal(timeout.timed_out, true);
  });
  await check('基准三轮：三次脚本调用对一次组合调用', async () => {
    const baseline = [],
      singleBatch = [],
      combined = [];
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      await script("fill_element('Search','benchmark')\nprint(json.dumps({'ok':True}))");
      await script("click_element('Query')\nprint(json.dumps({'ok':True}))");
      const old = await script(
        "print(json.dumps(wait_for('#result',state='text',text='ready:benchmark'))) ",
      );
      assert.equal(old.satisfied, true);
      baseline.push(performance.now() - started);
      started = performance.now();
      const single = await script(
        "fill_element('Search','single')\nclick_element('Query')\nprint(json.dumps(wait_for('#result',state='text',text='ready:single')))",
      );
      assert.equal(single.satisfied, true);
      singleBatch.push(performance.now() - started);
      started = performance.now();
      const result = await script(
        "print(json.dumps(run_steps([{'action':'fill','name':'Search','text':'combined'},{'action':'click','name':'Query','after':{'conditions':[{'kind':'element','selector':'#result','state':'text','text':'ready:combined'}]}}])))",
      );
      assert.equal(result.completed, true, JSON.stringify(result));
      combined.push(performance.now() - started);
    }
    checks.push({
      name: 'benchmark',
      baselineScriptCalls: 3,
      combinedScriptCalls: 1,
      baselineMs: baseline,
      singleBatchScriptCalls: 1,
      singleBatchMs: singleBatch,
      combinedMs: combined,
    });
  });
  await check('弹窗仅观察不接管', async () => {
    const result = await script(
      "print(json.dumps(run_steps([{'action':'click','name':'Popup','after':{'conditions':[{'kind':'popup'}]}}])))",
    );
    assert.equal(result.completed, true, JSON.stringify(result));
    assert.ok(result.steps[0].after.conditions[0].evidence.candidateRef);
  });
} catch (error) {
  failure = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ browser, checks, failure: failure || null }, null, 2),
  );
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  JSON.stringify({
    browser,
    output,
    passed: checks.filter((row) => row.ok).length,
    failure: failure || null,
  }),
);
