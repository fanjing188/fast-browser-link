// 中文注释：只操作本次临时 Chrome/Edge 与本地表单，验收原页接管，不读取个人登录态。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openRealSession, helperCall, root } from './real-session.mjs';
import { CdpClient, fetchJson, waitFor } from './cdp-client.mjs';

let loads = 0;
const server = createServer((req, res) => {
  if (req.url === '/draft') loads++;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Existing page fixture</title>
  <style>body{font:16px/1.6 system-ui;padding:24px}input,button{display:block;margin:16px 0;min-height:44px}</style>
  <h1>Existing page</h1><label>Draft<input id="draft" aria-label="Draft"></label>
  <label>Password<input id="password" type="password" aria-label="Password"></label>
  <button id="count">Count</button><output id="result">0</output>
  <script>window.documentMarker=crypto.randomUUID();window.count=0;
  document.querySelector('#count').onclick=e=>{if(e.isTrusted)document.querySelector('#result').textContent=String(++window.count)};</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/draft`;
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `existing-tab-${browser}`);
await mkdir(output, { recursive: true });
let session, page;
const checks = [];
const verify = (result) => {
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result;
};
try {
  session = await openRealSession({ browser, label: 'attach', compactScratch: true, headed: true });
  await session.enableFullAccess();
  const user = await session.ui.evaluate(
    `chrome.windows.create({url:${JSON.stringify(url)},focused:true}).then(w=>({tabId:w.tabs[0].id,windowId:w.id}))`,
  );
  const target = await waitFor(async () =>
    (await fetchJson(`${session.base}/json/list`)).find((t) => t.url === url),
  );
  page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await waitFor(() =>
    page.evaluate(`Boolean(document.querySelector('#draft')&&window.documentMarker)`),
  );
  await page.evaluate(`document.querySelector('#draft').focus()`);
  await page.call('Input.insertText', { text: 'unsaved draft' });
  const groupId = await session.ui.evaluate(
    `chrome.tabs.group({tabIds:[${user.tabId}],createProperties:{windowId:${user.windowId}}}).then(async id=>{await chrome.tabGroups.update(id,{title:'User group'});return id})`,
  );
  const before = await page.evaluate(
    `({marker:window.documentMarker,draft:document.querySelector('#draft').value})`,
  );
  const beforeLoads = loads;
  const beforeTabs = await session.ui.evaluate('chrome.tabs.query({}).then(t=>t.length)');
  await session.ui.evaluate(
    `chrome.windows.update(${user.windowId},{focused:true}).then(()=>chrome.tabs.update(${user.tabId},{active:true})).then(()=>true)`,
  );
  await waitFor(() =>
    session.ui.evaluate(
      `chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t.length===1&&t[0].id===${user.tabId})`,
    ),
  );
  const owner = 'existing-tab-fixture';
  const attached = verify(await session.rpc(owner, 'open', { existing_tab: true }));
  assert.equal(attached.tab_id, user.tabId);
  assert.equal(attached.attached, true);
  assert.equal(attached.sessionBinding, 'ready');
  assert.ok(attached.summary?.snapshotId, JSON.stringify(attached));
  assert.deepEqual(
    await page.evaluate(
      `({marker:window.documentMarker,draft:document.querySelector('#draft').value})`,
    ),
    before,
  );
  assert.equal(loads, beforeLoads);
  assert.equal(await session.ui.evaluate('chrome.tabs.query({}).then(t=>t.length)'), beforeTabs);
  checks.push('current page attached without navigation, reload, new tab or draft loss');

  const repeated = verify(
    await session.rpc(owner, 'open', { existing_tab: true, url, summary: false }),
  );
  assert.equal(repeated.task_id, attached.task_id);
  const foreign = await session.rpc('other-session', 'open', {
    existing_tab: true,
    url,
    summary: false,
  });
  assert.equal(foreign.code, 'lease_conflict', JSON.stringify(foreign));
  checks.push('same-session reuse and cross-session lease exclusion');

  const script = await helperCall(
    'script',
    session.work,
    owner,
    attached.task_id,
    `use_tab(${user.tabId})\nclick_element('Count', role='button')\nprint(read_page(mode='interactive'))`,
  );
  assert.equal(script.exit_code, 0, JSON.stringify(script));
  assert.equal(await page.evaluate('window.count'), 1);
  checks.push('real script lane trusted click and page read on the attached page');

  for (const width of [1440, 375]) {
    await page.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width === 375,
    });
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `attached-${width}.png`), Buffer.from(shot.data, 'base64'));
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  }

  const closed = verify(await session.rpc(owner, 'close', { task_id: attached.task_id }));
  assert.equal(closed.state, 'closed');
  const retained = await session.ui.evaluate(
    `chrome.tabs.get(${user.tabId}).then(t=>({windowId:t.windowId,groupId:t.groupId,url:t.url}))`,
  );
  assert.deepEqual(retained, { windowId: user.windowId, groupId, url });
  assert.deepEqual(
    await page.evaluate(
      `({marker:window.documentMarker,draft:document.querySelector('#draft').value})`,
    ),
    before,
  );
  await waitFor(() => page.evaluate(`!document.querySelector('[data-fast-automation-overlay]')`));
  await page.evaluate(`document.querySelector('#draft').focus()`);
  await page.call('Input.insertText', { text: ' retained' });
  assert.match(await page.evaluate(`document.querySelector('#draft').value`), /retained/);
  checks.push(
    'close releases control, preserves original tab/window/group/draft and restores typing',
  );

  const duplicate = await session.ui.evaluate(
    `chrome.tabs.create({url:${JSON.stringify(url)},active:false}).then(t=>t.id)`,
  );
  const ambiguous = await session.rpc(owner, 'open', { existing_tab: true, url, summary: false });
  assert.equal(ambiguous.code, 'attachment_ambiguous', JSON.stringify(ambiguous));
  await session.ui.evaluate(`chrome.tabs.remove(${duplicate}).then(()=>true)`);
  checks.push('duplicate URL selection refuses without creating or navigating a page');
  // 中文注释：独立 CLI 使用自己的私有 session 文件，真实验证非 Hermes 入口同样能接管执行。
  const cliEnv = {
    ...process.env,
    FAST_BROWSER_LINK_HOME: session.staged.hermesHome,
    HERMES_HOME: session.staged.hermesHome,
  };
  delete cliEnv.FAST_BROWSER_BRIDGE_HOME;
  const cli = async (operation, params) => {
    const { stdout } = await promisify(execFile)(
      process.env.HERMES_PYTHON,
      [
        path.join(root, 'agent-link/fast_browser_link.py'),
        '--session',
        path.join(session.work, 'attach.session'),
        operation,
        JSON.stringify(params),
      ],
      { cwd: root, env: cliEnv, timeout: 60000 },
    );
    return verify(JSON.parse(stdout));
  };
  const instance = await session.instance();
  const independent = await cli('create', {
    title: 'Independent attachment',
    instanceId: instance.instanceId,
    existingTab: { url },
  });
  const independentReady = await waitFor(async () => {
    const value = await cli('get', { taskId: independent.id });
    return value.state === 'ready' && value.activeMode === 'full' ? value : null;
  });
  assert.deepEqual(independentReady.attachedTabIds, [user.tabId]);
  const independentScript = await cli('script', {
    taskId: independent.id,
    tabId: user.tabId,
    code: "click_element('Count', role='button')\nprint(read_page())",
    timeout: 60,
  });
  assert.equal(independentScript.exit_code, 0, JSON.stringify(independentScript));
  assert.equal(independentScript.execution_complete, true, JSON.stringify(independentScript));
  assert.equal(await page.evaluate('window.count'), 2);
  assert.equal((await cli('close', { taskId: independent.id })).state, 'closed');
  assert.equal(
    await session.ui.evaluate(`chrome.tabs.get(${user.tabId}).then(t=>t.groupId)`),
    groupId,
  );
  checks.push(
    'independent CLI create/get/script/close performs trusted execution and preserves the user page',
  );
  console.log(JSON.stringify({ browser, passed: true, checks, output }, null, 2));
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ browser, passed: true, checks }, null, 2),
  );
} finally {
  page?.close();
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
