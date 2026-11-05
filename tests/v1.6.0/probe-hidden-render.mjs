// 中文注释：仅启动临时 profile，逐项测遮挡窗口；不会修改用户 profile 或页面遮罩。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpClient, fetchJson, waitFor } from '../native-v2/cdp-client.mjs';
import { browserPaths } from '../native-v2/real-session.mjs';

const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const work = await mkdtemp(join(tmpdir(), 'fbl-render-'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><style>#mask{position:fixed;inset:0;background:#222;opacity:1;transition:opacity .3s}#mask.fade{opacity:0}</style><div id="mask"></div><script>
    window.measure={frames:0,ended:false};
    document.querySelector('#mask').addEventListener('transitionend',()=>{measure.ended=true});
    window.start=()=>{const e=document.querySelector('#mask');void e.offsetWidth;e.classList.add('fade');const tick=()=>{measure.frames++;requestAnimationFrame(tick)};requestAnimationFrame(tick)};
  </script>`);
});
let proc, root, page, coverPage;
const rows = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  proc = spawn(browserPaths[browser], [`--user-data-dir=${work}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--use-mock-keychain', '--password-store=basic', 'about:blank'],
  { detached: true, stdio: 'ignore' });
  proc.on('error', error => { console.error('browser launch:', error.message); });
  const port = await waitFor(async () => {
    try { return (await readFile(join(work, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 15000, { label: '临时浏览器启动' });
  const base = `http://127.0.0.1:${port}`;
  const version = await fetchJson(`${base}/json/version`);
  root = new CdpClient(version.webSocketDebuggerUrl); await root.connect();
  const cover = await root.call('Target.createTarget', { url: 'about:blank', newWindow: true });
  const coverWindow = (await root.call('Browser.getWindowForTarget', { targetId: cover.targetId })).windowId;
  const coverTarget = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(x => x.id === cover.targetId));
  coverPage = new CdpClient(coverTarget.webSocketDebuggerUrl); await coverPage.connect();
  for (const strategy of ['baseline', 'focus', 'lifecycle', 'screencast']) {
    let targetId, listener;
    const row = { strategy };
    try {
      ({ targetId } = await root.call('Target.createTarget', { url, newWindow: true }));
      const target = await waitFor(async () => (await fetchJson(`${base}/json/list`)).find(x => x.id === targetId));
      page = new CdpClient(target.webSocketDebuggerUrl); await page.connect();
      await waitFor(() => page.evaluate('typeof window.start === "function"'));
      const windowId = (await root.call('Browser.getWindowForTarget', { targetId })).windowId;
      await root.call('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 500, height: 400 } });
      await root.call('Browser.setWindowBounds', { windowId: coverWindow, bounds: { left: 40, top: 40, width: 900, height: 800 } });
      await root.call('Target.activateTarget', { targetId: cover.targetId });
      await new Promise(resolve => setTimeout(resolve, 800));
      row.visibilityBefore = await page.evaluate('document.visibilityState');
      row.coverFocusedBefore = await coverPage.evaluate('document.hasFocus()');
      if (strategy === 'focus') await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      if (strategy === 'lifecycle') await page.call('Page.setWebLifecycleState', { state: 'active' });
      if (strategy === 'screencast') {
        listener = event => {
          const msg = JSON.parse(event.data);
          if (msg.method === 'Page.screencastFrame') void page.call('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
        };
        page.socket.addEventListener('message', listener);
        await page.call('Page.startScreencast', { everyNthFrame: 1 });
      }
      await page.evaluate('window.start(); true');
      await new Promise(resolve => setTimeout(resolve, 2500));
      Object.assign(row, await page.evaluate('({...window.measure, visibilityAfter:document.visibilityState})'));
      row.coverFocusedAfter = await coverPage.evaluate('document.hasFocus()');
      row.verdict = !row.coverFocusedBefore ? 'INCONCLUSIVE_COVER_NOT_FOCUSED'
        : !row.coverFocusedAfter ? 'FAIL_FOCUS_CHANGED'
        : row.visibilityBefore !== 'hidden' || row.visibilityAfter !== 'hidden' ? 'INCONCLUSIVE_NOT_HIDDEN'
        : row.frames >= 2 && row.ended ? 'PASS' : 'FAIL';
    } catch (error) { row.verdict = 'ERROR'; row.error = error.message; }
    finally {
      if (strategy === 'screencast' && page) await page.call('Page.stopScreencast').catch(() => {});
      if (listener && page) page.socket.removeEventListener('message', listener);
      if (strategy === 'focus' && page) await page.call('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      page?.close(); page = null;
      if (targetId) await root.call('Target.closeTarget', { targetId }).catch(() => {});
    }
    rows.push(row);
  }
  console.log(JSON.stringify({ browser, version: version.Browser, scenario: 'fully occluded window, same Space', rows }, null, 2));
} finally {
  page?.close(); coverPage?.close(); root?.close();
  if (proc?.pid) { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} }
  if (proc && proc.exitCode === null) await Promise.race([new Promise(resolve => proc.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (proc?.pid && proc.exitCode === null) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}
