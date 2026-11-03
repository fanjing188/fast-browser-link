// 中文注释：真实临时浏览器/本地合成服务验收，禁止使用个人 profile。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';
let flaky = 0,
  requests = 0;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let body =
    '<h1>Ready</h1><button onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Pulse</button><button>Duplicate</button><button>Duplicate</button>';
  if (req.url === '/flaky' && ++flaky === 1) body = '<h1>Service unavailable</h1>';
  if (req.url === '/draft')
    body = '<h1>Service unavailable</h1><form><input value="synthetic-draft"></form>';
  if (req.url === '/challenge') body = '<h1>Verify you are human</h1><button>Pulse</button>';
  if (req.url === '/rate')
    body +=
      "<button onclick=\"fetch('/limited').then(()=>this.dataset.done='yes')\">Throttle</button>";
  if (req.url === '/limited') {
    requests++;
    res.statusCode = 429;
    res.setHeader('Retry-After', '30');
    body = 'limited';
  }
  res.end(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      body,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `resilience-${browser}`);
await mkdir(output, { recursive: true });
let session, failure;
const checks = [];
try {
  session = await openRealSession({
    browser,
    packageMode: true,
    label: 'rs',
    compactScratch: true,
  });
  await session.enableFullAccess();
  let serial = 0;
  const task = (route) =>
    openTask(session, {
      owner: 'resilience' + ++serial,
      origins: [origin],
      url: origin + route,
      title: '执行保护验收',
    });
  const script = async (t, code) => {
    const r = await helperCall('script', session.work, t.owner, t.task.id, 'import json\n' + code);
    assert.equal(r.exit_code, 0, JSON.stringify(r));
    assert.equal(r.execution_complete, true, JSON.stringify(r));
    return JSON.parse(r.stdout.trim());
  };
  const check = async (name, fn) => {
    const evidence = await fn();
    checks.push({ name, ok: true, evidence });
  };
  await check('只刷新当前任务新建且无写入的错误页一次', async () => {
    const t = await task('/flaky');
    const r = await script(t, 'print(json.dumps(read_resilient()))');
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.equal(r.recovery.reloaded, true, JSON.stringify(r));
    assert.equal(flaky, 2);
    return { requests: flaky, reloaded: r.recovery.reloaded };
  });
  await check('表单草稿保护现场', async () => {
    const t = await task('/draft');
    const r = await script(t, 'print(json.dumps(recover_page()))');
    assert.equal(r.ready, false, JSON.stringify(r));
    assert.equal(r.status.reloadBlocked, 'page_state_protected');
    assert.equal(r.recovered, false);
    assert.equal(await t.read('document.querySelector("input").value'), 'synthetic-draft');
    return { reason: r.reason, protected: r.status.reloadBlocked };
  });
  await check('验证码停止且不刷新', async () => {
    const t = await task('/challenge');
    const r = await script(t, "print(json.dumps(run_steps([{'action':'click','name':'Pulse'}])))");
    assert.equal(r.completed, false, JSON.stringify(r));
    assert.equal(r.reason, 'execution_handoff');
    assert.equal(r.steps.length, 0);
    return { reason: r.reason };
  });
  await check('同一目标三次无进展后停止第四次', async () => {
    const t = await task('/loop');
    const r = await script(
      t,
      "print(json.dumps(run_steps([{'action':'click','name':'Pulse'}]*4)))",
    );
    assert.equal(r.completed, false, JSON.stringify(r));
    assert.equal(r.reason, 'execution_no_progress', JSON.stringify(r));
    assert.equal(r.steps.length, 3);
    assert.equal(await t.read('document.querySelector("button").dataset.count'), '3');
    return { reason: r.reason, dispatched: r.steps.length };
  });
  await check('三个脚本定位失败共用熔断状态', async () => {
    const t = await task('/failure');
    for (let i = 0; i < 3; i++) {
      const r = await script(
        t,
        "print(json.dumps(run_steps([{'action':'click','name':'Duplicate'}])))",
      );
      assert.equal(r.reason, 'ambiguous_target', JSON.stringify(r));
      assert.equal(r.outcome_unknown, false);
    }
    const r = await script(t, "print(json.dumps(run_steps([{'action':'click','name':'Pulse'}])))");
    assert.equal(r.reason, 'execution_circuit_open', JSON.stringify(r));
    assert.equal(r.steps.length, 0);
    return { reason: r.reason };
  });
  await check('执行保护中文状态和1440/375显示', async () => {
    const t = await task('/screen');
    await script(t, 'print(json.dumps(execution_status()))');
    const command = (method, params) =>
      session.ui.evaluate(
        `chrome.debugger.sendCommand({tabId:${t.tabId}},${JSON.stringify(method)},${JSON.stringify(params)})`,
      );
    for (const width of [1440, 375]) {
      await command('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width === 375,
      });
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        path.join(output, `protection-${width}.png`),
        Buffer.from(shot.data, 'base64'),
      );
      assert.equal(await t.read('document.documentElement.scrollWidth<=innerWidth'), true);
    }
    return { widths: [1440, 375] };
  });
  await check('429同站跨任务共用冷却且不重复请求', async () => {
    const a = await task('/rate'),
      b = await task('/ready');
    await script(a, 'print(json.dumps(execution_status()))');
    await script(b, 'print(json.dumps(execution_status()))');
    await script(a, "click_element('Throttle')\nprint(json.dumps({'clicked':True}))");
    const state = await script(b, 'print(json.dumps(execution_status()))');
    assert.ok(state.access.retryAfterMs > 20000, JSON.stringify(state));
    assert.equal(state.access.concurrency, 1);
    const r = await script(b, "print(json.dumps(run_steps([{'action':'click','name':'Pulse'}])))");
    assert.equal(r.reason, 'access_cooldown', JSON.stringify(r));
    assert.equal(r.steps.length, 0);
    assert.equal(requests, 1);
    return { retryAfterMs: state.access.retryAfterMs, requests, reason: r.reason };
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
