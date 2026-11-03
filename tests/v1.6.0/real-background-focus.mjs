// 中文注释：真实临时 Chrome/Edge、本地合成站；不切用户个人浏览器或实际桌面焦点。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';
const html = `<!doctype html><meta charset="utf-8"><h1 id="status">Ready</h1>
<button aria-label="Count" onclick="window.hits++;document.querySelector('h1').textContent='Count '+window.hits">Count</button>
<form onsubmit="event.preventDefault();window.enters++;document.querySelector('h1').textContent='Enter '+window.enters"><input aria-label="Search"></form>
<div contenteditable="true" aria-label="Memo"></div><script>window.hits=0;window.enters=0;</script>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `background-focus-${browser}`);
await mkdir(output, { recursive: true });
let session, failure;
const checks = [];
try {
  session = await openRealSession({
    browser,
    packageMode: true,
    label: 'bg',
    compactScratch: true,
  });
  await session.enableFullAccess();
  const user = await session.ui.evaluate(
    `chrome.windows.create({url:'about:blank',focused:true,type:'normal'}).then(w=>({windowId:w.id,tabId:w.tabs[0].id}))`,
  );
  const focus = () =>
    session.ui.evaluate(
      `chrome.windows.getAll({populate:true}).then(ws=>({focused:ws.find(w=>w.focused)?.id??null,windows:ws.map(w=>({id:w.id,state:w.state,active:w.tabs.find(t=>t.active)?.id??null})).sort((a,b)=>a.id-b.id)}))`,
    );
  const baseline = await focus();
  const a = await openTask(session, {
    owner: 'bg-a',
    origins: [origin],
    url: origin + '/a',
    title: '后台输入验收',
    activate: false,
  });
  const b = await openTask(session, {
    owner: 'bg-b',
    origins: [origin],
    url: origin + '/b',
    title: '后台输入验收',
    activate: false,
  });
  const workWindow = await session.ui.evaluate(`chrome.tabs.get(${a.tabId}).then(t=>t.windowId)`);
  assert.equal((await focus()).focused, baseline.focused);
  assert.equal(
    await session.ui.evaluate(
      `chrome.tabs.query({windowId:${user.windowId},active:true}).then(t=>t[0].id)`,
    ),
    user.tabId,
  );
  checks.push({ name: '创建任务和工作页不改变用户焦点', ok: true });
  const script = async (t, code) => {
    const r = await helperCall('script', session.work, t.owner, t.task.id, 'import json\n' + code);
    assert.equal(r.exit_code, 0, JSON.stringify(r));
    assert.equal(r.execution_complete, true, JSON.stringify(r));
    return JSON.parse(r.stdout.trim());
  };
  let round = 0;
  const interact = async (t) => {
    const value = 'fixture' + ++round;
    const r = await script(
      t,
      `print(json.dumps(run_steps([{'action':'fill','name':'Search','text':'${value}'},{'action':'click','name':'Count'},{'action':'fill','name':'Memo','text':'${value}'},{'action':'press','name':'Search','key':'Enter'}])))`,
    );
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.equal(await t.read('document.querySelector("input").value'), value);
    assert.equal(await t.read('document.querySelector("[contenteditable]").textContent'), value);
    return r.steps.length;
  };
  for (const state of ['unfocused-window', 'background-tab', 'minimized-window']) {
    if (state === 'background-tab') {
      await session.ui.evaluate(
        `chrome.windows.update(${workWindow},{state:'normal',focused:true})`,
      );
      await session.ui.evaluate(
        `chrome.tabs.create({windowId:${workWindow},url:'about:blank',active:true})`,
      );
    } else {
      if (state === 'minimized-window')
        await session.ui.evaluate(`chrome.windows.update(${workWindow},{state:'minimized'})`);
      await session.ui.evaluate(`chrome.windows.update(${user.windowId},{focused:true})`);
    }
    const before = await focus();
    await interact(a);
    await interact(b);
    const after = await focus();
    assert.deepEqual(after, before, state + ' changed focus/window/active tab');
    checks.push({ name: state + ' 点击填写编辑器按键均送达且焦点不变', ok: true, before, after });
  }
  const before = await focus();
  await script(a, "print(json.dumps(cdp('Page.bringToFront')))");
  const target = await session.ui.evaluate(
    `chrome.debugger.getTargets().then(rows=>rows.find(t=>t.tabId===${a.tabId}).id)`,
  );
  await script(
    a,
    `print(json.dumps(cdp('Target.activateTarget',targetId=${JSON.stringify(target)})))`,
  );
  assert.deepEqual(await focus(), before);
  checks.push({ name: '原始CDP激活请求不提升窗口或切标签', ok: true });
  const counts = await a.read('({hits:window.hits,enters:window.enters})');
  assert.deepEqual(counts, { hits: 3, enters: 3 });
  checks.push({ name: '实际点击和提交各三次，没有补发', ok: true, counts });
} catch (e) {
  failure = String(e.stack || e);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ browser, headless: true, checks, failure: failure || null }, null, 2),
  );
  await session?.close();
  await new Promise((r) => server.close(r));
}
console.log(JSON.stringify({ browser, output, passed: checks.length, failure: failure || null }));
