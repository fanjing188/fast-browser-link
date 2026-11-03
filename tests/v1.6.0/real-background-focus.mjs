// 中文注释：临时profile；有头准备阶段显式设置前台基线，测量阶段绝不恢复焦点掩盖抢前台。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const headed = process.argv.includes('--headed');
const desktopFocus = async () =>
  JSON.parse(
    (
      await exec('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit"); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(a.processIdentifier),bundle:ObjC.unwrap(a.bundleIdentifier)})',
      ])
    ).stdout,
  );
const originalDesktop = headed ? await desktopFocus() : null;
const restoreTestBaseline = async () => {
  if (!headed) return;
  await exec('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${originalDesktop.pid}); if(!a.activateWithOptions(2)) throw Error('baseline app unavailable');`,
  ]);
  let stable = 0;
  for (let i = 0; i < 50; i++) {
    const current = await desktopFocus();
    const focused = await session.ui.evaluate(
      'chrome.windows.getAll().then(ws=>ws.some(w=>w.focused))',
    );
    stable = current.pid === originalDesktop.pid && !focused ? stable + 1 : 0;
    if (stable >= 3) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('desktop baseline did not settle');
};
const guardDesktop = async (before, work) => {
  if (!headed) return work();
  const events = [];
  let pending = Promise.resolve(),
    busy = false;
  const timer = setInterval(() => {
    if (!busy) {
      busy = true;
      pending = desktopFocus()
        .then((x) => events.push(x))
        .finally(() => {
          busy = false;
        });
    }
  }, 100);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await pending;
    assert.ok(
      events.every((x) => x.pid === before.desktop.pid),
      'Desktop focus changed during execution: ' + JSON.stringify(events),
    );
  }
};
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
const output = path.join(
  process.env.TMPDIR,
  `background-focus-${browser}${headed ? '-desktop' : ''}`,
);
await mkdir(output, { recursive: true });
let session, failure;
const checks = [];
try {
  session = await openRealSession({
    browser,
    headed,
    packageMode: true,
    label: 'bg',
    compactScratch: true,
  });
  await session.enableFullAccess();
  const user = await session.ui.evaluate(
    `chrome.windows.create({url:'about:blank',focused:true,type:'normal'}).then(w=>({windowId:w.id,tabId:w.tabs[0].id}))`,
  );
  const focus = async () => {
    const result = await session.ui.evaluate(
      `chrome.windows.getAll({populate:true}).then(ws=>({focused:ws.find(w=>w.focused)?.id??null,windows:ws.map(w=>({id:w.id,state:w.state,active:w.tabs.find(t=>t.active)?.id??null})).sort((a,b)=>a.id-b.id)}))`,
    );
    if (headed) result.desktop = await desktopFocus();
    return result;
  };
  await restoreTestBaseline();
  const baseline = await focus();
  let a, b;
  await guardDesktop(baseline, async () => {
    a = await openTask(session, {
      owner: 'bg-a',
      origins: [origin],
      url: origin + '/a',
      title: '后台输入验收',
      activate: false,
    });
    b = await openTask(session, {
      owner: 'bg-b',
      origins: [origin],
      url: origin + '/b',
      title: '后台输入验收',
      activate: false,
    });
  });
  const workWindow = await session.ui.evaluate(`chrome.tabs.get(${a.tabId}).then(t=>t.windowId)`);
  assert.equal((await focus()).focused, baseline.focused);
  if (headed) assert.deepEqual(await desktopFocus(), originalDesktop);
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
      await restoreTestBaseline();
    }
    if (headed) await new Promise((r) => setTimeout(r, 400));
    const before = await focus();
    await guardDesktop(before, async () => {
      await interact(a);
      await interact(b);
    });
    const after = await focus();
    assert.deepEqual(after, before, state + ' changed focus/window/active tab');
    checks.push({ name: state + ' 点击填写编辑器按键均送达且焦点不变', ok: true, before, after });
  }
  const before = await focus();
  await guardDesktop(before, async () => {
    await script(a, "print(json.dumps(cdp('Page.bringToFront')))");
    const target = await session.ui.evaluate(
      `chrome.debugger.getTargets().then(rows=>rows.find(t=>t.tabId===${a.tabId}).id)`,
    );
    await script(
      a,
      `print(json.dumps(cdp('Target.activateTarget',targetId=${JSON.stringify(target)})))`,
    );
  });
  assert.deepEqual(await focus(), before);
  checks.push({ name: '原始CDP激活请求不提升窗口或切标签', ok: true });
  const counts = await a.read('({hits:window.hits,enters:window.enters})');
  assert.deepEqual(counts, { hits: 3, enters: 3 });
  checks.push({ name: '实际点击和提交各三次，没有补发', ok: true, counts });
} catch (e) {
  failure = String(e.stack || e);
  process.exitCode = 1;
} finally {
  await session?.close();
  await new Promise((r) => server.close(r));
  if (headed && (await desktopFocus()).pid !== originalDesktop.pid) {
    failure = failure || 'Desktop foreground changed during cleanup';
    process.exitCode = 1;
  }
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        browser,
        headless: !headed,
        originalDesktop,
        desktopAfterCleanup: headed ? await desktopFocus() : null,
        checks,
        failure: failure || null,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ browser, output, passed: checks.length, failure: failure || null }));
