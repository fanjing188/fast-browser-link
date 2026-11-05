// 中文注释：真实桌面夹具；断言遮罩自然结束及用户前台不变，不修改网页遮罩。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { openRealSession, openTask } from '../native-v2/real-session.mjs';

const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>transition fixture</title>
    <script>window.initialVisibility=document.visibilityState</script><button id="target" onclick="window.clicked=(window.clicked||0)+1">Apply</button>
    <div id="mask"></div><style>
    #mask{position:fixed;inset:0;background:#222;opacity:1;transition:opacity .3s}
    #mask.fade{opacity:0}
    </style><script>document.querySelector('#mask').addEventListener('transitionend',
      event=>{if(event.propertyName==='opacity')event.currentTarget.remove()})</script>`);
});
// 中文注释：NSWorkspace 读取和激活运行中的应用，不调用 System Events 或辅助功能权限。
const frontApp = () => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
  "ObjC.import('AppKit'); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)",
], { encoding: 'utf8' }).trim();
const activateFinder = () => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
  "ObjC.import('AppKit'); const a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder'); if(!a.count) throw Error('Finder not running'); a.objectAtIndex(0).activateWithOptions(2)",
], { encoding: 'utf8' });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let session;
try {
  session = await openRealSession({
    browser: process.argv.includes('--edge') ? 'edge' : 'chrome', headed: true,
    label: 'hid', compactScratch: true, backgroundRenderFlag: process.argv.includes('--background-render'),
  });
  await session.enableFullAccess();
  const task = await openTask(session, { owner: 'hidden-transition', origins: [origin],
    url: origin, title: '后台过渡夹具', activate: false });
  if (process.argv.includes('--background-render')) {
    assert.equal(await task.read('window.initialVisibility'), 'visible', '新页加载期间未激活或浏览器参数无效');
    console.log('PASS 新页加载期间为 visible');
  }
  // 中文注释：锁屏时验证拒绝置前，并跳过依赖已解锁桌面的焦点与交互断言。
  if (process.argv.includes('--background-render') && frontApp() === 'com.apple.loginwindow') {
    const locked = await task.run('focus_window', { restore: true, hold_ms: 1200 });
    assert.equal(locked.code, 'screen_locked', JSON.stringify(locked));
    assert.equal(locked.outcome_unknown, false, JSON.stringify(locked));
    assert.equal(locked.retryable, false, JSON.stringify(locked));
    console.log('PASS 锁屏时返回 screen_locked');
    console.log('SKIP 桌面锁定，跳过需要解锁桌面的焦点和交互断言');
  } else {
    const windowId = await session.ui.evaluate(`chrome.tabs.get(${task.tabId}).then(t=>t.windowId)`);
    const foreground = await session.ui.evaluate(`chrome.windows.create({url:'about:blank',focused:true,type:'normal'}).then(w=>w.id)`);
    const before = { app: frontApp(), window: await session.ui.evaluate('chrome.windows.getLastFocused().then(w=>w.id)') };
    assert.equal(before.window, foreground);
    if (!process.argv.includes('--background-render'))
      assert.equal(await task.read('document.visibilityState'), 'hidden', '工作页未进入 hidden，无法证明后台行为');
    await task.read("document.querySelector('#mask').classList.add('fade'); true");
    const focused = await task.run('focus_window', { restore: true, hold_ms: 1200 });
    assert.equal(focused.focused, true, JSON.stringify(focused));
    assert.equal(focused.visible, true, JSON.stringify(focused));
    assert.equal(focused.restored, true, JSON.stringify(focused));
    assert.equal(focused.previousWindowId, foreground, JSON.stringify(focused));
    const restored = { app: frontApp(), window: await session.ui.evaluate('chrome.windows.getLastFocused().then(w=>w.id)') };
    assert.deepEqual(restored, before, '焦点未恢复到原前台');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await task.read("!!document.querySelector('#mask')"))
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await task.read("!!document.querySelector('#mask')"), false, '遮罩未通过 transitionend 自然消失');
    const receipt = await task.act('ref_click', await task.ref('Apply', ['button']));
    assert.equal(receipt.error, undefined, JSON.stringify(receipt));
    assert.equal(await task.read('window.clicked'), 1);
    const after = { app: frontApp(), window: await session.ui.evaluate('chrome.windows.getLastFocused().then(w=>w.id)') };
    assert.deepEqual(after, before, '前台应用或窗口发生变化');
    assert.notEqual(windowId, foreground);
    console.log('PASS 后台遮罩自然消失、按钮点击生效、前台保持不变');
    const lease = await task.run('focus_window', { restore: 'deferred', max_ms: 30000 });
    assert.ok(lease.focusLeaseId, JSON.stringify(lease));
    try {
      for (let i = 0; i < 3; i++) {
        await task.read(`(()=>{const m=document.createElement('div');m.id='mask';document.body.append(m);m.addEventListener('transitionend',()=>m.remove());requestAnimationFrame(()=>requestAnimationFrame(()=>m.classList.add('fade')));return true})()`);
        const until = Date.now() + 5000;
        while (Date.now() < until && await task.read("!!document.querySelector('#mask')"))
          await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(await task.read("!!document.querySelector('#mask')"), false, `第 ${i + 1} 次过渡未完成`);
      }
    } finally {
      const done = await task.run('focus_restore', { focus_lease_id: lease.focusLeaseId });
      assert.equal(done.restored, true, JSON.stringify(done));
    }
    assert.deepEqual({ app: frontApp(), window: await session.ui.evaluate('chrome.windows.getLastFocused().then(w=>w.id)') }, before);
    console.log('PASS 租约内三次过渡完成，退出后恢复原前台');
    if (process.argv.includes('--external-app')) {
      activateFinder();
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(frontApp(), 'com.apple.finder', 'Finder 未成功置前');
      const external = await task.run('focus_window', { restore: true, hold_ms: 1200 });
      assert.equal(external.focused, true, JSON.stringify(external));
      assert.equal(external.visible, true, JSON.stringify(external));
      assert.equal(external.restored, true, JSON.stringify(external));
      assert.equal(frontApp(), 'com.apple.finder', '未恢复调用前的 Finder');
      const externalLease = await task.run('focus_window', { restore: 'deferred', max_ms: 30000 });
      assert.ok(externalLease.focusLeaseId, JSON.stringify(externalLease));
      try {
        for (let i = 0; i < 3; i++) {
          await task.read(`(()=>{const m=document.createElement('div');m.id='mask';document.body.append(m);m.addEventListener('transitionend',()=>m.remove());requestAnimationFrame(()=>requestAnimationFrame(()=>m.classList.add('fade')));return true})()`);
          const until = Date.now() + 5000;
          while (Date.now() < until && await task.read("!!document.querySelector('#mask')"))
            await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await task.read("!!document.querySelector('#mask')"), false, `Finder 租约内第 ${i + 1} 次过渡未完成`);
        }
      } finally {
        const done = await task.run('focus_restore', { focus_lease_id: externalLease.focusLeaseId });
        assert.equal(done.restored, true, JSON.stringify(done));
      }
      assert.equal(frontApp(), 'com.apple.finder', '连续交互后未恢复 Finder');
      console.log('PASS Finder 前台下三次过渡完成并恢复原应用');
    }
  }
} finally {
  await session?.close();
  await new Promise(resolve => server.close(resolve));
}
