// 中文注释：独立临时浏览器 profile；用第二个前台标签页使夹具文档真实进入 hidden。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { semanticWorldDeclaration } from '../../native-extension/core.mjs';
import { CdpClient, fetchJson, waitFor } from '../native-v2/cdp-client.mjs';

const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const binary =
  browser === 'edge'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work = await mkdtemp(path.join(process.env.TMPDIR || '/private/tmp', 'fast-hidden-doc-'));
const profile = path.join(work, 'profile');
const temp = path.join(work, 'tmp');
await mkdir(temp);
await mkdir(path.join(work, 'home'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>后台语义夹具</title>
    <style>.app-main { transition: opacity .3s; } .app-main.fade-transform-enter-from { opacity: 0; }</style></head>
    <body><main class="app-main fade-transform-enter-from"><section><button id="create">创建</button><button id="save">保存</button></section></main>
    <script>document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') document.querySelector('.app-main').classList.remove('fade-transform-enter-from');
    });</script></body></html>`);
});
let proc, cdp, browserCdp;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  proc = spawn(
    binary,
    [
      '--headless=new',
      '--no-proxy-server',
      '--use-mock-keychain',
      '--password-store=basic',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ],
    {
      env: {
        HOME: process.env.HOME,
        HERMES_HOME: path.join(work, 'home', '.hermes'),
        TMPDIR: temp,
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
      stdio: 'ignore',
    },
  );
  let launchError;
  proc.once('error', (error) => {
    launchError = error;
  });
  const port = await waitFor(
    async () => {
      if (launchError) throw launchError;
      return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    },
    10000,
    { label: '浏览器调试端口' },
  );
  const origin = `http://127.0.0.1:${port}`;
  const target = await waitFor(
    async () => (await fetchJson(`${origin}/json/list`)).find((row) => row.url === url),
    10000,
    { label: '夹具标签页' },
  );
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  browserCdp = new CdpClient((await fetchJson(`${origin}/json/version`)).webSocketDebuggerUrl);
  await browserCdp.connect();
  await waitFor(
    () => cdp.evaluate("document.readyState==='complete'&&!!document.querySelector('#create')"),
    10000,
    { label: '夹具加载' },
  );
  const foreground = await browserCdp.call('Target.createTarget', { url: 'about:blank' });
  await browserCdp.call('Target.activateTarget', { targetId: foreground.targetId });
  await waitFor(() => cdp.evaluate('document.visibilityState'), 10000, {
    label: '后台夹具 visibilityState',
    ready: (value) => value === 'hidden',
  });
  const diagnostics = await cdp.evaluate(`(() => {
    const e = document.querySelector('#create'), r = e.getBoundingClientRect();
    return { visibilityState: document.visibilityState, ancestorOpacity: getComputedStyle(e.closest('.app-main')).opacity,
      checkVisibility: e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),
      clientRects: e.getClientRects().length, rect: { width:r.width, height:r.height }, hit: !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2) };
  })()`);
  assert.equal(diagnostics.visibilityState, 'hidden');
  assert.equal(diagnostics.ancestorOpacity, '0', '夹具祖先应保持 Vue enter-from 透明状态');
  assert.ok(diagnostics.rect.width > 0 && diagnostics.rect.height > 0, '夹具必须有布局矩形');
  const binding = { taskId: 'hidden-doc', documentId: 'fixture', leaseId: 'fixture' };
  const snapshot = (options) =>
    cdp.evaluate(
      `(${semanticWorldDeclaration})('semantic_snapshot',${JSON.stringify({ binding, options })})`,
    );
  const all = await snapshot({ mode: 'interactive', roles: ['button'], limit: 50 });
  for (const name of ['创建', '保存']) {
    const item = all.items.find((entry) => entry.name === name);
    assert.ok(item, `后台快照缺少 ${name}`);
    assert.notEqual(item.blocked, 'occluded', `${name} 被误判遮挡`);
  }
  assert.equal(all.coverage.documentHidden, true);
  assert.ok(all.coverage.pausedTransitions > 0, '应记录跳过的后台透明祖先判断');
  const query = await snapshot({
    mode: 'interactive',
    roles: ['button'],
    query: '创建',
    limit: 50,
  });
  assert.equal(query.items.length, 1);
  assert.equal(query.items[0].name, '创建');
  assert.notEqual(query.items[0].blocked, 'occluded');
  assert.equal(query.coverage.documentHidden, true);
  console.log(
    JSON.stringify({
      browser,
      passed: true,
      diagnostics,
      names: all.items.map((item) => item.name),
    }),
  );
} finally {
  browserCdp?.close();
  cdp?.close();
  proc?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
