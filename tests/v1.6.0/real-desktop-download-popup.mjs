// 中文注释：打包候选的弹窗策略验收；默认无头，--headed 另测真实 macOS 前台应用。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';
const exec = promisify(execFile),
  browser = process.argv.includes('--edge') ? 'edge' : 'chrome',
  headed = process.argv.includes('--headed');
const desktop = async () =>
  headed
    ? JSON.parse(
        (
          await exec('/usr/bin/osascript', [
            '-l',
            'JavaScript',
            '-e',
            'ObjC.import("AppKit");var a=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(a.processIdentifier),bundle:ObjC.unwrap(a.bundleIdentifier)})',
          ])
        ).stdout,
      )
    : null;
const original = await desktop(),
  events = [],
  checks = [];
let session,
  timer,
  pending = Promise.resolve(),
  busy = false,
  failure,
  serial = 0,
  posts = 0,
  children = 0;
const html = `<!doctype html><meta charset="utf-8"><h1 id="message">Ready</h1>
<button onclick="window.attempts++;window.open('/child','_blank','noopener,width=450,height=350');document.querySelector('#message').textContent='Opened'">Safe</button>
<button onclick="window.attempts++;window.open('/child','native','width=450,height=350');document.querySelector('#message').textContent='Attempted'">Popup</button>
<button onclick="window.attempts++;window.open('/autonomous','_blank','noopener')">Autonomous child</button>
<button onclick="window.advance++;document.querySelector('#message').textContent='Advanced'">Advance</button>
<button onclick="const a=document.createElement('a');a.href='/file.csv';a.download='file.csv';a.click()">Download</button>
<form target="_blank" action="/posted" method="post"><button type="submit">Submit</button></form>
<button onclick="document.querySelector('form').submit()">Direct submit</button>
<a href="/child" target="_blank">Target link</a>
<a href="/autonomous" target="_blank">Autonomous link</a>
<button onclick="window.login=window.open('/auth','login','width=450,height=350')">Login</button>
<script>window.initialGuard=window.open.__fblPopupGuard===true;window.attempts=0;window.advance=0;window.authenticated=false;addEventListener('message',e=>{if(e.origin===location.origin&&e.data==='login-done'){window.authenticated=true;document.querySelector('#message').textContent='Logged in';}});</script>`;
const server = createServer((req, res) => {
  if (req.method === 'POST') posts++;
  if (req.url === '/file.csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="file.csv"');
    res.end('id\n1\n');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/auth')
      res.end(
        `<script>window.hadOpener=!!window.opener;setTimeout(()=>window.opener?.postMessage('login-done',location.origin),150);</script><h1>Auth</h1>`,
      );
    else if (req.url === '/autonomous')
      res.end(
        "<script>window.startAttempts=1;window.open('/child','_blank','noopener')</script><h1>Autonomous</h1>",
      );
    else if (req.url === '/child') {
      children++;
      res.end('<h1>Child</h1>');
    } else res.end(html);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = path.join(process.env.TMPDIR, `popup-policy-${browser}${headed ? '-desktop' : ''}`);
await mkdir(output, { recursive: true });
try {
  session = await openRealSession({
    browser,
    headed,
    allowPopups: true,
    packageMode: true,
    label: 'pp',
    compactScratch: true,
  });
  await session.enableFullAccess();
  // 准备时连接界面使用的焦点模拟必须关闭，避免 Edge 将夹具界面带到前台。
  await session.ui.call('Emulation.setFocusEmulationEnabled', { enabled: false });
  const task = (route = '') =>
    openTask(session, {
      owner: 'popup-' + ++serial,
      origins: [origin],
      url: origin + route,
      title: '弹窗后台策略验收',
      activate: false,
    });
  const script = async (t, code) => {
    const r = await helperCall(
      'script',
      session.work,
      t.owner,
      t.task.id,
      'import json\nuse_tab(' + t.tabId + ')\n' + code,
    );
    assert.equal(r.exit_code, 0, JSON.stringify(r));
    assert.ok(r.stdout.trim(), JSON.stringify(r));
    return JSON.parse(r.stdout.trim());
  };
  const mode = async (t, value) => {
    const r = await session.ui.evaluate(
      `chrome.runtime.sendMessage({type:'popup_action',kind:'popup_policy',taskId:${JSON.stringify(t.task.id)},generation:${t.task.generation},tabId:${t.tabId},mode:${JSON.stringify(value)}})`,
    );
    assert.equal(r.result?.verified, true, JSON.stringify(r));
  };
  const click = (t, name, extra = '') =>
    script(
      t,
      "print(json.dumps(run_steps([{'action':'click','name':" +
        JSON.stringify(name) +
        extra +
        '}])))',
    );
  // 用户可在其他应用间切换；浏览器不能成为前台，工作窗口也不能获得焦点。
  const browserInFront = (state) => state.pid === session.browserPid;
  const quiet = async () => {
    if (!headed) return;
    assert.equal(browserInFront(await desktop()), false, 'Browser took OS focus');
    assert.equal(
      await session.ui.evaluate('chrome.windows.getAll().then(ws=>ws.every(w=>!w.focused))'),
      true,
      'Work window became focused',
    );
  };
  const resetDesktop = async () => {
    if (!headed) return;
    await exec('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import("AppKit");$.NSRunningApplication.runningApplicationWithProcessIdentifier(${original.pid}).activateWithOptions(2)`,
    ]);
    for (let i = 0; i < 40; i++) {
      if (
        (await desktop()).pid === original.pid &&
        (await session.ui.evaluate('chrome.windows.getAll().then(ws=>ws.every(w=>!w.focused))'))
      )
        return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error('Desktop baseline not ready');
  };
  await resetDesktop();
  if (headed)
    timer = setInterval(() => {
      if (!busy) {
        busy = true;
        pending = desktop()
          .then((x) => events.push(x))
          .finally(() => (busy = false));
      }
    }, 100);
  const check = async (name, fn) => {
    const value = await fn();
    await quiet();
    checks.push({ name, ok: true, evidence: value });
  };
  await check('首次站点脚本运行前已保护，同源 noopener 后台建页并接入双端租约', async () => {
    const t = await task();
    assert.equal(await t.read('window.initialGuard'), true);
    const r = await click(t, 'Safe', ",'after':{'conditions':[{'kind':'popup'}]}");
    assert.equal(r.completed, true, JSON.stringify(r));
    const catalog = await script(t, 'print(json.dumps(popup_catalog()))');
    assert.equal(catalog.backgroundTabs.length, 1, JSON.stringify(catalog));
    const id = catalog.backgroundTabs[0].tabId;
    const current = await session.rpc(t.owner, 'get', { task_id: t.task.id });
    assert.ok(current.tabIds.includes(id));
    assert.equal(await session.readPage(id, 'window.opener===null'), true);
    const tab = await session.ui.evaluate(`chrome.tabs.get(${id})`);
    assert.equal(tab.active, false);
    assert.equal(await t.read('window.attempts'), 1);
    return { managedTabId: id, windowType: catalog.backgroundTabs[0].windowType, attempts: 1 };
  });
  await check('引用型独立弹窗先拦截、停止后续步骤，清策略不重放', async () => {
    const t = await task(),
      before = children;
    const r = await script(
      t,
      "print(json.dumps(run_steps([{'action':'click','name':'Popup'},{'action':'click','name':'Advance'}])))",
    );
    assert.equal(r.completed, false, JSON.stringify(r));
    assert.equal(r.reason, 'popup_policy_paused');
    assert.equal(r.steps[0].dispatched, true);
    assert.equal(await t.read('window.advance'), 0);
    assert.equal(await t.read('window.attempts'), 1);
    assert.equal(children, before);
    const status = await script(t, 'print(json.dumps(popup_status()))');
    assert.equal(status.paused, true, JSON.stringify(status));
    const snapshot = async () =>
      JSON.parse(
        await readFile(
          path.join(session.staged.hermesHome, 'plugin-data/fast-browser-link-native/tasks.json'),
          'utf8',
        ),
      ).tasks.find((x) => x.id === t.task.id);
    assert.ok((await snapshot()).popupPolicyPause);
    assert.equal((await snapshot()).idlePendingHuman, true);
    const rejected = await click(t, 'Advance');
    assert.equal(rejected.reason, 'popup_policy_paused');
    assert.equal(rejected.steps.length, 0, JSON.stringify(rejected));
    assert.equal(await t.read('window.advance'), 0);
    await mode(t, 'background');
    assert.equal((await snapshot()).popupPolicyPause, undefined);
    assert.equal(await t.read('window.attempts'), 1);
    assert.equal(children, before);
    return { reason: status.reason, attempts: 1, advance: 0 };
  });
  await check('严格模式不创建已知安全弹窗；重新选择模式不重放队列', async () => {
    const t = await task();
    await mode(t, 'strict');
    const before = children;
    const r = await click(t, 'Safe');
    assert.equal(r.reason, 'popup_policy_paused', JSON.stringify(r));
    assert.equal(children, before);
    await mode(t, 'background');
    assert.equal(children, before);
    assert.equal(await t.read('window.attempts'), 1);
    return { blocked: true, replayed: false };
  });
  await check('target 链接、表单与原生 submit 都在打开窗口前阻止', async () => {
    const before = posts,
      childBefore = children;
    for (const name of ['Submit', 'Direct submit', 'Target link']) {
      const t = await task();
      const r = await click(t, name);
      assert.equal(r.reason, 'popup_policy_paused', JSON.stringify(r));
    }
    assert.equal(posts, before);
    assert.equal(children, childBefore);
    return { posts: 0, childRequests: 0 };
  });
  await check('下载保持后台，领取与内容校验正常', async () => {
    const t = await task();
    const r = await click(t, 'Download', ",'after':{'conditions':[{'kind':'download'}]}");
    assert.equal(r.completed, true, JSON.stringify(r));
    const receipt = await script(
      t,
      "d=downloads()['downloads'][-1]\nprint(json.dumps(verify_download(d['id'],expected={'format':'csv','min_rows':1})))",
    );
    assert.equal(receipt.valid, true, JSON.stringify(receipt));
    return { valid: true, rows: receipt.rows };
  });
  await check('跨站弹窗暂停，不向另一个来源发送请求', async () => {
    const t = await task(),
      before = children;
    const r = await script(
      t,
      `print(json.dumps(evaluate("() => {window.open('http://localhost:${server.address().port}/child','_blank','noopener');return 1;}")))`,
    ).catch((e) => ({ blocked: true }));
    const state = await script(t, 'print(json.dumps(popup_status()))');
    assert.equal(state.paused, true, JSON.stringify(state));
    assert.equal(state.reason, 'cross_origin_requires_confirmation', JSON.stringify(state));
    assert.equal(children, before);
    return { paused: true, result: r };
  });
  await check('启动阶段与后台子页的早到暂停随租约回执落盘，不重放', async () => {
    const before = children;
    const first = await task('/autonomous');
    const snapshot = async (t) =>
      JSON.parse(
        await readFile(
          path.join(session.staged.hermesHome, 'plugin-data/fast-browser-link-native/tasks.json'),
          'utf8',
        ),
      ).tasks.find((row) => row.id === t.task.id);
    assert.equal((await snapshot(first)).popupPolicyPause, 'outside_action');
    assert.equal((await snapshot(first)).idlePendingHuman, true);
    assert.equal(await first.read('window.startAttempts'), 1);
    await mode(first, 'background');
    assert.equal((await snapshot(first)).popupPolicyPause, undefined);
    assert.equal(await first.read('window.startAttempts'), 1);
    const parent = await task();
    const result = await click(parent, 'Autonomous child');
    assert.equal(result.reason, 'popup_policy_paused', JSON.stringify(result));
    assert.equal(result.steps[0].dispatched, true);
    assert.equal((await snapshot(parent)).popupPolicyPause, 'outside_action');
    assert.equal((await snapshot(parent)).idlePendingHuman, true);
    const catalog = await script(parent, 'print(json.dumps(popup_catalog()))');
    assert.equal(catalog.backgroundTabs.length, 1);
    assert.equal(
      await session.readPage(catalog.backgroundTabs[0].tabId, 'window.startAttempts'),
      1,
    );
    await mode(parent, 'background');
    assert.equal((await snapshot(parent)).popupPolicyPause, undefined);
    const link = await task();
    const linked = await link.run('click', {
      selector: 'a[href="/autonomous"]',
      clickMode: 'open_link_in_task_tab',
    });
    assert.equal(linked.openedVia, 'safe_link_navigation');
    assert.equal((await snapshot(link)).popupPolicyPause, 'outside_action');
    assert.equal((await snapshot(link)).idlePendingHuman, true);
    assert.equal((await script(link, 'print(json.dumps(popup_status()))')).paused, true);
    assert.notEqual(linked.tabId, link.tabId);
    assert.equal(await session.readPage(linked.tabId, 'window.startAttempts'), 1);
    await mode(link, 'background');
    assert.equal((await snapshot(link)).popupPolicyPause, undefined);
    assert.equal(children, before);
    return {
      startupPersisted: true,
      childPersisted: true,
      safeLinkPersisted: true,
      replayed: false,
    };
  });
  if (timer) {
    clearInterval(timer);
    timer = null;
    await pending;
    assert.ok(
      events.every((x) => !browserInFront(x)),
      'Transient OS focus switch',
    );
  }
  // 兼容模式显式允许前台弹窗，这一组不计入静默采样。
  const t = await task();
  await mode(t, 'compatible');
  const login = await click(t, 'Login');
  assert.equal(login.completed, true, JSON.stringify(login));
  for (let i = 0; i < 50 && !(await t.read('window.authenticated')); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(await t.read('window.authenticated'), true);
  assert.equal(await t.read('!!window.login && window.login.closed===false'), true);
  await t.read('window.login.close()');
  await mode(t, 'background');
  checks.push({
    name: '用户显式兼容模式保留真实 WindowProxy、opener、消息回传与关闭',
    ok: true,
    evidence: { authenticated: true, proxyPreserved: true },
  });
  // 真正渲染扩展弹窗的新模式控件，并检查两个视口。
  await session.ui.evaluate(
    `chrome.tabs.update(${t.tabId},{active:true}).then(()=>chrome.tabs.get(${t.tabId}).then(tab=>chrome.windows.update(tab.windowId,{focused:true})))`,
  );
  await session.ui.evaluate("document.querySelector('#popup-policy')!==null");
  await new Promise((r) => setTimeout(r, 1200));
  for (const width of [1440, 375]) {
    await session.ui.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const dimensions = await session.ui.evaluate(
      '({width:innerWidth,scroll:document.documentElement.scrollWidth,visible:!document.querySelector("#popup-policy-row").hidden})',
    );
    assert.equal(dimensions.visible, true, JSON.stringify(dimensions));
    assert.ok(dimensions.scroll <= dimensions.width, JSON.stringify(dimensions));
    const png = await session.ui.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `popup-${width}.png`), Buffer.from(png.data, 'base64'));
  }
  checks.push({
    name: '扩展弹窗 1440/375 实际渲染与模式开关',
    ok: true,
    evidence: { widths: [1440, 375] },
  });
} catch (e) {
  failure = String(e.stack || e);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await pending;
  await session?.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        browser,
        headed,
        original,
        browserPid: session?.browserPid,
        after: await desktop(),
        checks,
        samples: events,
        failure: failure || null,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({ browser, headed, passed: checks.length, failure: failure || null, output }),
);
