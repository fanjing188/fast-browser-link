// 中文注释：手动 opt-in，真实双扩展/Native/Port；只用临时 profile、本地合成资料与普通顶层控件。
// 运行：TMPDIR=<private-scratch> HERMES_SOURCE=<repo>/.ci/hermes \
// HERMES_PYTHON=<repo>/.ci/hermes/.venv/bin/python3.14 BK_PROTECT_REAL=1 \
// BK_TEST_TMPDIR="$TMPDIR" FBL_BACKLINK_SOURCE=<backlink-checkout> \
// node tests/native-v2/real-product-fill.mjs [--edge] [--package]
// --help / --preflight 不启动浏览器；运行结果写入 $TMPDIR/product-fill-{chrome,edge}-*/。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { openRealSession, helperCall, root } from './real-session.mjs';
import { CdpClient, fetchJson, waitFor } from './cdp-client.mjs';

const exec = promisify(execFile);
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const packageMode = process.argv.includes('--package');
const here = import.meta.dirname;
const fillSelector = 'footer button[data-command="page:fill"]';
const aiSelector = '.form-toolbar button[aria-label="AI 智能填充"]';
const help = `Real product-fill acceptance (headless Chrome; --edge selects Edge).
Required: explicit private TMPDIR, real HOME, HERMES_SOURCE, HERMES_PYTHON,
FBL_BACKLINK_SOURCE, BK_PROTECT_REAL=1, BK_TEST_TMPDIR=$TMPDIR.
Node >=22.12, pinned test Python, Backlink's existing Playwright dependency and ffmpeg.
--preflight: validate prerequisites and source contracts without servers or a browser.
--package: exercise the real FBL package rather than the default real source build.
Evidence: $TMPDIR/product-fill-${browser}-*/result.json, stages.json, source.json,
page-*.json, *.png, browser.log and backend.log. No personal installation or credentials.
Backlink buttons: ${fillSelector}; ${aiSelector} (not nonexistent #fillAll/#aiUser).
A failed or unknown receipt is never retried automatically. No success simulation.`;
if (process.argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}
for (const arg of process.argv.slice(2))
  assert.ok(['--edge', '--package', '--preflight'].includes(arg), `Unknown option: ${arg}`);

async function prerequisites() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 12), 'Node 22.12+ required');
  for (const key of ['TMPDIR', 'HOME', 'HERMES_SOURCE', 'HERMES_PYTHON', 'FBL_BACKLINK_SOURCE'])
    assert.ok(
      process.env[key] && path.isAbsolute(process.env[key]),
      `${key}: explicit absolute path required`,
    );
  const scratch = await realpath(process.env.TMPDIR);
  assert.ok(
    !['/tmp', '/private/tmp'].includes(scratch),
    'Use an explicit private scratch, not system tmp',
  );
  assert.equal(
    await realpath(process.env.HOME),
    await realpath(userInfo().homedir),
    'Keep the real HOME',
  );
  assert.equal(process.env.BK_PROTECT_REAL, '1', 'BK_PROTECT_REAL=1 required');
  assert.equal(
    await realpath(process.env.BK_TEST_TMPDIR || ''),
    scratch,
    'BK_TEST_TMPDIR must equal TMPDIR',
  );
  const info = await stat(scratch);
  assert.equal(info.uid, process.getuid(), 'Scratch must belong to the current user');
  assert.equal(info.mode & 0o077, 0, 'Scratch must be private (0700)');
  const backlink = await realpath(process.env.FBL_BACKLINK_SOURCE);
  const python = await realpath(process.env.HERMES_PYTHON);
  const hermes = await realpath(process.env.HERMES_SOURCE);
  const pythonEnvironment = await realpath(path.dirname(path.dirname(process.env.HERMES_PYTHON)));
  assert.ok(
    pythonEnvironment.startsWith(hermes + path.sep),
    'Use the pinned .ci/hermes Python, not a personal environment',
  );
  // 中文注释：Backlink helper 直接 spawn python3，先核 PATH 实际解析到同一固定解释器。
  process.env.PATH = `${path.dirname(process.env.HERMES_PYTHON)}${path.delimiter}${process.env.PATH}`;
  const { stdout } = await exec(
    'python3',
    [
      '-c',
      'import os,sys; print(os.path.realpath(sys.executable)); assert sys.version_info >= (3,11)',
    ],
    { cwd: root },
  );
  assert.equal(stdout.trim(), python, 'Backlink helper python3 must resolve to HERMES_PYTHON');
  await exec('ffmpeg', ['-version'], { cwd: root });
  for (const file of [
    'product-connections.html',
    'product-connections.mjs',
    'product-fill.mjs',
    'product-fill-content.mjs',
  ])
    await stat(path.join(root, 'native-extension', file));
  await stat(path.join(root, 'native-bridge/product_adapter.py'));
  const panel = await readFile(path.join(backlink, 'extension/panel.js'), 'utf8');
  const html = await readFile(path.join(backlink, 'extension/panel.html'), 'utf8');
  const fill = await readFile(path.join(backlink, 'extension/lib/fbl-fill.js'), 'utf8');
  assert.ok(
    html.includes('data-command="page:fill"') &&
      panel.includes('AI 智能填充') &&
      panel.includes('onclick: requestAi'),
    'Backlink real panel button contract missing',
  );
  assert.ok(
    fill.includes('boundEpoch') && fill.includes('untracked-page'),
    'Integrate the real epoch/null-item fix before running',
  );
  return { scratch, backlink, python, hermes };
}

const config = await prerequisites();
if (process.argv.includes('--preflight')) {
  console.log(
    JSON.stringify(
      { preflight: true, browserStarted: false, ...config, buttons: { fillSelector, aiSelector } },
      null,
      2,
    ),
  );
  process.exit(0);
}

const output = await mkdtemp(path.join(config.scratch, `product-fill-${browser}-`));
const checks = [],
  stages = [],
  pages = [],
  clients = [];
let session, environment, fixtureServer, modelServer, panel, pair;
let loads = 0,
  phase = 'setup',
  gate = null;
const modelRequests = [];
const result = { browser, headed: false, packageMode, passed: false, checks, output };
const until = (label, read, ready = Boolean, timeout = 20000) =>
  waitFor(read, timeout, { label, ready });
const save = (name, data) =>
  writeFile(
    path.join(output, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  );
const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
const closeServer = (server) =>
  server
    ? new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
    : Promise.resolve();

async function sourceReceipt(directory, files) {
  const { stdout: commit } = await exec('git', ['-C', directory, 'rev-parse', 'HEAD'], {
    cwd: root,
  });
  const { stdout: status } = await exec('git', ['-C', directory, 'status', '--short'], {
    cwd: root,
  });
  const hashes = {};
  for (const file of files)
    hashes[file] = createHash('sha256')
      .update(await readFile(path.join(directory, file)))
      .digest('hex');
  return { commit: commit.trim(), status, hashes };
}

async function connectTarget(targetId) {
  const target = await until(`CDP target ${targetId}`, async () =>
    (await fetchJson(`${session.base}/json/list`)).find(
      (row) => row.id === targetId && row.webSocketDebuggerUrl,
    ),
  );
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  clients.push(client);
  return { client, targetId };
}

async function extensionPage(extensionId, filename, windowId) {
  const url = `chrome-extension://${extensionId}/${filename}`;
  const tab = await session.ui.evaluate(
    `chrome.tabs.create(${JSON.stringify({ url, active: false, ...(windowId ? { windowId } : {}) })}).then(t=>({id:t.id}))`,
  );
  const target = await until(`extension page ${filename}`, async () =>
    (await fetchJson(`${session.base}/json/list`)).find((row) => row.url === url),
  );
  const handle = await connectTarget(target.id);
  await until(`extension DOM ${filename}`, () =>
    handle.client.evaluate(
      `location.href===${JSON.stringify(url)}&&document.readyState==='complete'&&chrome.runtime.id===${JSON.stringify(extensionId)}`,
    ),
  );
  return { ...handle, tabId: tab.id };
}

const fblState = async () => {
  const receipt = await session.ui.evaluate(`chrome.runtime.sendMessage({type:'status'})`);
  assert.equal(receipt.error, undefined, JSON.stringify(receipt));
  return receipt.result;
};
const bkState = (page) =>
  panel.client.evaluate(
    `chrome.runtime.sendMessage({type:'panel:state',tabId:${page.tabId}}).then(r=>{if(r.error)throw Error(r.error);return r.value})`,
  );
const values = (page) =>
  page.client.evaluate(
    `Object.fromEntries([...document.querySelectorAll('input,textarea')].map(e=>[e.id,e.value]))`,
  );
const pageState = (page) =>
  page.client.evaluate(
    `({marker:window.fixtureMarker,url:location.href,values:Object.fromEntries([...document.querySelectorAll('input,textarea')].map(e=>[e.id,e.value])),events:window.fixtureEvents,visibility:document.visibilityState})`,
  );

async function taskFor(page) {
  return until(
    `real product task for ${page.tabId}`,
    async () =>
      (await fblState()).tasks.find(
        (task) => task.executionLane === 'product_fill' && task.tabIds.includes(page.tabId),
      ),
    (task) => task?.state === 'ready' && task.activeMode === 'full',
  );
}

async function checkpoint(name, page, extra = {}) {
  const bk = await bkState(page);
  stages.push({
    name,
    ...extra,
    page: await pageState(page),
    backlink: { site: bk.site, fbl: bk.fbl, fblOutcome: bk.fblOutcome },
    tasks: (await fblState()).tasks.map(
      ({ id, state, executionLane, tabIds, attachedTabIds, agentTabIds }) => ({
        id,
        state,
        executionLane,
        tabIds,
        attachedTabIds,
        agentTabIds,
      }),
    ),
  });
  await save('stages.json', stages);
}

async function focusPage(page) {
  await session.ui.evaluate(`chrome.tabs.update(${page.tabId},{active:true}).then(()=>true)`);
}

async function chooseProject(page, site) {
  await focusPage(page);
  await until(
    'panel selects the exact local tab',
    () => panel.client.evaluate(`state.tab?.id`),
    (id) => id === page.tabId,
  );
  // 中文注释：只在真实 select 上触发其原有 change 监听器；不替代业务处理器、Port 或 FBL 授权。
  await panel.client.evaluate(
    `(()=>{const e=document.querySelector('#site');if(![...e.options].some(o=>o.value===${JSON.stringify(site)}))throw Error('missing project');e.value=${JSON.stringify(site)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
  await until(
    `project ${site} binding settled`,
    async () => {
      const stored = await panel.client.evaluate(
        `chrome.storage.session.get('tab:${page.tabId}').then(r=>r['tab:${page.tabId}'])`,
      );
      const ui = await panel.client.evaluate(
        `({site:document.querySelector('#site').value,busy:document.querySelector('#site').disabled})`,
      );
      return { storedSite: stored?.context?.site, storedUrl: stored?.context?.submit_url, ui };
    },
    (state) =>
      state.storedSite === site &&
      state.storedUrl === page.url &&
      state.ui.site === site &&
      !state.ui.busy,
  );
}

async function panelAction(page, selector) {
  phase = `panel-focus:${page.mode}:${selector}`;
  await focusPage(page);
  await until('real panel target and enabled button', () =>
    panel.client.evaluate(
      `state.tab?.id===${page.tabId}&&Boolean(document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled)`,
    ),
  );
  // 中文注释：只读 MutationObserver 捕获真实 UI 回执，既不清 toast 也不包装 sendMessage。
  // 中文注释：项目保存toast可能盖住底部按钮，等待原生消失，不用DOM点击绕过真实命中。
  await until('panel action is actually pointer reachable', () =>
    panel.client.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,
    ),
  );
  phase = `panel-click:${page.mode}:${selector}`;
  const toast = panel.client
    .evaluate(
      `new Promise((resolve,reject)=>{const box=document.querySelector('#toasts');const observer=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1&&n.classList.contains('toast')&&!n.textContent.startsWith('已保存默认项目：')){observer.disconnect();clearTimeout(timer);resolve({text:n.textContent,className:n.className});return}});const timer=setTimeout(()=>{observer.disconnect();reject(Error('real panel action produced no receipt'))},15000);observer.observe(box,{childList:true})})`,
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await session.trustedClick(panel.client, panel.targetId, selector);
  await save(
    'panel-click-hit.json',
    await panel.client.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},hit:hit?.outerHTML.slice(0,800),target:e.outerHTML}})()`,
    ),
  );
  phase = `panel-receipt:${page.mode}:${selector}`;
  const observed = await toast;
  if (observed.error) throw observed.error;
  return observed.value;
}

async function initialFill(page) {
  const receipt = await panelAction(page, fillSelector);
  // 中文注释：冷 attach 可能仅登记待就绪任务；明确 NOT_READY 才允许测试再点击新按钮，未知绝不重发。
  if (!receipt.text.includes('FBL 正等待授权')) return receipt;
  page.task = await taskFor(page);
  stages.push({ name: 'cold-attach-not-ready', tabId: page.tabId, toast: receipt });
  return panelAction(page, fillSelector);
}

async function overlay(page, action) {
  await focusPage(page);
  const tree = await page.client.call('DOM.getDocument', { depth: -1, pierce: true });
  function find(node) {
    const attrs = node.attributes || [];
    if (attrs.some((name, index) => name === 'data-action' && attrs[index + 1] === action))
      return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const found = find(child);
      if (found) return found;
    }
  }
  const node = find(tree.root);
  assert.ok(node, `Real FBL overlay ${action} button missing`);
  const { model } = await page.client.call('DOM.getBoxModel', { nodeId: node.nodeId });
  await mouse(page.client, {
    x: (model.content[0] + model.content[4]) / 2,
    y: (model.content[1] + model.content[5]) / 2,
  });
  await until(
    `FBL ${action} barrier`,
    async () => {
      const task = (await fblState()).tasks.find((row) => row.id === page.task.id);
      return task?.state;
    },
    (state) => state === (action === 'takeover' ? 'paused' : 'ready'),
  );
}
async function mouse(client, point) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await client.call('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1,
    });
}
async function clickPage(page, selector) {
  const point = await page.client.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await mouse(page.client, point);
}
async function humanText(page, selector, text, clear = false) {
  await page.client.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.setSelectionRange(${clear ? '0,e.value.length' : 'e.value.length,e.value.length'});return true})()`,
  );
  if (clear) {
    await page.client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await page.client.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }
  if (text) await page.client.call('Input.insertText', { text });
}

async function newFixture(mode = 'ordinary', windowId) {
  const url = `${fixtureOrigin}/form?mode=${mode}`;
  const created = await session.ui.evaluate(
    windowId
      ? `chrome.tabs.create({url:${JSON.stringify(url)},windowId:${windowId},active:true}).then(t=>({tabId:t.id,windowId:t.windowId}))`
      : `chrome.windows.create({url:${JSON.stringify(url)},focused:false}).then(w=>({tabId:w.tabs[0].id,windowId:w.id}))`,
  );
  const target = await until(`fixture ${mode}`, async () =>
    (await fetchJson(`${session.base}/json/list`)).find((row) => row.url === url),
  );
  const page = { ...created, ...(await connectTarget(target.id)), url, mode };
  pages.push(page);
  await until('real Backlink content script ready', () =>
    panel
      ? panel.client.evaluate(
          `chrome.tabs.sendMessage(${page.tabId},{type:'page:state'},{frameId:0}).then(r=>Boolean(r?.value?.count)).catch(()=>false)`,
        )
      : page.client.evaluate(
          'Boolean(window.fixtureMarker&&document.documentElement.dataset.bkStatus)',
        ),
  );
  assert.ok(await page.client.evaluate('window.fixtureMarker'));
  return page;
}
let fixtureOrigin;

try {
  await save('source.json', {
    fbl: await sourceReceipt(root, [
      'native-extension/product-fill.mjs',
      'native-extension/product-fill-content.mjs',
      'native-extension/product-connections.mjs',
      'native-bridge/product_adapter.py',
    ]),
    backlink: await sourceReceipt(config.backlink, [
      'extension/lib/fbl-fill.js',
      'extension/lib/fbl-client.js',
      'extension/panel.js',
      'extension/manifest.json',
    ]),
  });
  // 中文注释：先独占探测三个空闲端口；不关闭或接管任何未知已有服务。
  const reservations = [];
  try {
    for (const key of ['BK_E2E_API_PORT', 'BK_E2E_PORT_A', 'BK_E2E_PORT_B']) {
      const server = createServer();
      await listen(server);
      reservations.push(server);
      process.env[key] = String(server.address().port);
    }
  } finally {
    await Promise.all(reservations.map(closeServer));
  }
  const support = await import(
    pathToFileURL(path.join(config.backlink, 'extension/e2e/support.mjs')).href
  );
  const second = structuredClone(support.KIT);
  second.site = 'secondfixture';
  second.fields.name = { value: 'Second Fixture' };
  second.fields.url = { value: 'https://second-fixture.test/' };
  second.fields.domain = { value: 'second-fixture.test' };
  second.fields.github_url = { value: 'https://github.com/example/synthetic-fixture' };
  environment = await support.startEnvironment({ additionalKits: [second] });
  await writeFile(
    path.join(environment.root, 'kits/_profile.json'),
    JSON.stringify({
      schema_version: 2,
      fields: {
        maker_name: 'Synthetic Maker',
        first_name: 'Synthetic',
        last_name: 'Maker',
        email: 'maker@fixture.test',
      },
      qa: {},
      qa_overrides: {},
    }),
  );
  const kitPath = path.join(environment.root, 'kits/probekits/kit.json');
  const kit = JSON.parse(await readFile(kitPath, 'utf8'));
  kit.fields.github_url = { value: 'https://github.com/example/synthetic-fixture' };
  await writeFile(kitPath, JSON.stringify(kit));

  modelServer = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const prompt = body.messages?.find((message) => message.role === 'user')?.content || '';
      const match = prompt.match(/Unfilled fields[^\n]*:\s*(\[[\s\S]*?\])\s*Rules:/);
      assert.ok(match, 'Synthetic model must receive the real Backlink field catalog');
      const fields = JSON.parse(match[1]);
      modelRequests.push({ fields, model: body.model });
      const activeGate = gate;
      if (activeGate) {
        activeGate.entered = true;
        await activeGate.wait;
      }
      const suggestions = fields.map((field) => ({
        i: field.i,
        key: /cobalt/i.test(field.label)
          ? 'url'
          : /description/i.test(field.label)
            ? 'description'
            : /product name/i.test(field.label)
              ? 'name'
              : null,
        conf: 0.99,
        why: 'synthetic catalog mapping only',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }),
      );
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  await listen(modelServer);
  const aiConfig = {
    enabled: true,
    base_url: `http://127.0.0.1:${modelServer.address().port}/v1`,
    model: 'synthetic-product-fill',
    api_key: '',
    timeout_ms: 12000,
  };
  const configured = await fetch(`${environment.base}api/ai_config`, {
    method: 'POST',
    headers: { 'X-Fast-Backlink': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(aiConfig),
  });
  assert.equal(configured.status, 200, await configured.text());
  const aiStatus = await fetch(`${environment.base}api/ai`, {
    headers: { 'X-Fast-Backlink': '1' },
  }).then((response) => response.json());
  assert.equal(aiStatus.configured, true);
  assert.equal(aiStatus.enabled, true);

  const fixture = await readFile(path.join(here, 'product-fill-fixture.html'));
  fixtureServer = createServer((req, res) => {
    // 中文注释：只计受保护原页的导航，独立换文档负例不能污染这条保留断言。
    if (req.url === '/form?mode=ordinary') loads++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
  });
  await listen(fixtureServer);
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  phase = 'launch';
  session = await openRealSession({
    browser,
    compactScratch: true,
    headed: false,
    label: 'pf',
    packageMode,
  });
  await session.enableFullAccess();
  result.runtime = {
    fblId: session.extensionId,
    version: session.version.Browser,
    daemon: await helperCall('inspect', session.work),
  };
  const { id: backlinkId } = await session.cdp.call('Extensions.loadUnpacked', {
    path: path.join(config.backlink, 'extension'),
  });
  assert.match(backlinkId, /^[a-p]{32}$/);
  result.runtime.backlinkId = backlinkId;
  await until('popup live connection settles without stale connection error', () =>
    session.ui.evaluate(
      `document.querySelector('#connection-label').dataset.state==='connected'&&document.querySelector('#error-bar').hidden`,
    ),
  );
  for (const width of [320, 375]) {
    await session.ui.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await until('current popup product entry rendered', () =>
      session.ui.evaluate(
        `Boolean(document.querySelector('#open-products')&&!document.querySelector('#open-products').hidden)`,
      ),
    );
    const entry = await session.ui.evaluate(
      `(()=>{const e=document.querySelector('#open-products'),r=e.getBoundingClientRect();return {text:e.textContent,width:innerWidth,x:r.x,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth}})()`,
    );
    assert.equal(entry.width, width);
    assert.equal(entry.overflow, false);
    assert.ok(entry.x >= 0 && entry.right <= width);
    const shot = await session.ui.call('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    assert.equal(png.readUInt32BE(16), width, 'PNG actual width must match the popup viewport');
    await writeFile(path.join(output, `popup-products-${width}.png`), png);
    await save(`popup-products-${width}.json`, entry);
  }
  await session.clickPopup('#open-products');
  const productsTarget = await until(
    'real popup entry opens own product connections page',
    async () =>
      (await fetchJson(`${session.base}/json/list`)).find(
        (row) => row.url === `chrome-extension://${session.extensionId}/product-connections.html`,
      ),
  );
  pair = await connectTarget(productsTarget.id);
  await until('real pairing form loaded', () =>
    pair.client.evaluate(
      `Boolean(document.querySelector('#extension-id')&&document.querySelector('#pair-button'))`,
    ),
  );
  const first = await newFixture();
  panel = await extensionPage(backlinkId, 'panel.html', first.windowId);
  await panel.client.evaluate(
    `chrome.storage.local.set({base:${JSON.stringify(environment.base)},settings:{auto_next:false,auto_next_sites:{},restore_after_reload:false,restore_after_submit_error:false,fill_low_confidence:true,ai_fallback:false,floating_window:false,log_level:'debug'}}).then(()=>true)`,
  );
  const settingsReadback = await panel.client.evaluate(
    `chrome.storage.local.get(['base','settings'])`,
  );
  assert.equal(settingsReadback.base, environment.base);
  assert.equal(settingsReadback.settings.auto_next, false);
  // 中文注释：导航仅刷新测试扩展UI，不导航或重载原表单。
  await panel.client.call('Page.reload');
  await until('Backlink real projects loaded', () =>
    panel.client.evaluate(`Boolean(document.querySelector('#site option[value="probekits"]'))`),
  );
  await pair.client.evaluate(`document.querySelector('#extension-id').focus()`);
  await pair.client.call('Input.insertText', { text: backlinkId });
  await session.trustedClick(pair.client, pair.targetId, '#pair-button');
  await until(
    'registry contains exact real extension ID',
    () =>
      pair.client.evaluate(
        `chrome.runtime.sendMessage({type:'product_connections'}).then(r=>r.result)`,
      ),
    (rows) =>
      rows?.length === 1 && rows[0].extensionId === backlinkId && rows[0].connected === true,
  );
  await session.trustedClick(pair.client, pair.targetId, '#refresh-button');
  await until(
    'pair UI reads back connected Port',
    () =>
      pair.client.evaluate(
        `document.querySelector('[data-extension-id="${backlinkId}"] .product-state')?.dataset.connected`,
      ),
    (state) => state === 'true',
  );
  checks.push('exact-ID real pair UI, persisted registry and real external Port handshake');
  const groupId = await session.ui.evaluate(
    `chrome.tabs.group({tabIds:[${first.tabId}],createProperties:{windowId:${first.windowId}}}).then(async id=>{await chrome.tabGroups.update(id,{title:'Synthetic user group',color:'blue'});return id})`,
  );
  const initial = await pageState(first),
    initialLoads = loads;
  const initialGroup = await session.ui.evaluate(`chrome.tabGroups.get(${groupId})`);

  phase = 'ordinary';
  // 中文注释：独立浏览器层负例核真实documentId，不用URL相同或Node替身证明文档未更换。
  const replaced = await newFixture('document', first.windowId);
  const selectedDocument = await pair.client.evaluate(`(async()=>{
    const {Executor}=await import('./core.mjs');
    const executor=new Executor(chrome);
    const attachment=await executor.selectExistingTab({url:${JSON.stringify(replaced.url)},incognito:false,productFill:true});
    const task={id:'document-identity-probe',generation:1,executionLane:'product_fill',attachment,tabIds:new Set([attachment.tabId]),policy:{activeMode:'full',modeGeneration:1}};
    executor.tasks.set(task.id,task);executor.leases.set(attachment.tabId,task.id);
    globalThis.documentIdentityProbe={executor,task};
    return attachment.documentId;
  })()`);
  const oldDocumentMarker = (await pageState(replaced)).marker;
  await replaced.client.call('Page.reload');
  await until(
    'same URL has a new real document',
    () => replaced.client.evaluate('window.fixtureMarker'),
    (marker) => marker && marker !== oldDocumentMarker,
  );
  const rejected = await pair.client.evaluate(`(async()=>{
    const {executor,task}=globalThis.documentIdentityProbe;
    try {await executor.execute({taskId:task.id,generation:1,modeGeneration:1,tabId:task.attachment.tabId,action:'product.fill',requestId:'document-probe',command:{operation:'bind'}});return {refused:false};}
    catch {return {refused:true,documentId:task.attachment.documentId};}
    finally {delete globalThis.documentIdentityProbe;}
  })()`);
  assert.equal(rejected.refused, true);
  assert.equal(rejected.documentId, selectedDocument);
  assert.equal((await values(replaced)).name, '');
  checks.push(
    'real browser document-ID probe: same-URL reload before first bind rejects old intent without touching replacement fields',
  );
  await chooseProject(first, 'probekits');
  assert.deepEqual(
    await values(first),
    initial.values,
    'Selecting a project must not fill automatically',
  );
  assert.equal((await pageState(first)).marker, initial.marker);
  const once = await initialFill(first);
  first.task = await taskFor(first);
  const ordinary = await values(first);
  assert.equal(ordinary.name, support.EXPECTED.name, JSON.stringify({ once, ordinary }));
  assert.equal(ordinary.url, support.EXPECTED.url);
  assert.equal(ordinary.description, support.EXPECTED.description500);
  assert.equal(ordinary.draft, initial.values.draft);
  for (const id of ['api-key', 'password', 'card', 'otp', 'hint']) assert.equal(ordinary[id], '');
  const firstOutcome = (await bkState(first)).fblOutcome;
  assert.equal(firstOutcome?.status, 'confirmed', JSON.stringify({ once, firstOutcome }));
  assert.deepEqual(first.task.attachedTabIds, [first.tabId]);
  assert.ok(
    !first.task.workTabs.includes(first.tabId),
    'Attached page must not become a created/closeable page',
  );
  assert.equal(loads, initialLoads, 'Fill must not reload or navigate original page');
  assert.equal((await pageState(first)).marker, initial.marker);
  await checkpoint('ordinary-once', first, { toast: once });
  checks.push(
    'one actual ordinary button: real Native + dual leases + top-level input/textarea, sensitive/manual values preserved',
  );

  const denial = await exec(
    config.python,
    [
      path.join(here, 'product-fill-denial.py'),
      session.staged.plugin,
      session.staged.hermesHome,
      first.task.id,
      String(first.tabId),
      session.work,
    ],
    { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  await save('denial.json', JSON.parse(denial.stdout));
  assert.deepEqual(await values(first), ordinary);
  checks.push(
    'live daemon rejects public JS, raw CDP and CDP gateway even with the actual fixture owner',
  );

  for (let i = 0; i < 2; i++) {
    const toast = await panelAction(first, fillSelector);
    assert.deepEqual(await values(first), ordinary);
    assert.equal(
      (await bkState(first)).fblOutcome?.requestId,
      firstOutcome.requestId,
      'No new commit without safe empty candidates',
    );
    await checkpoint(`explicit-repeat-${i + 1}`, first, { toast });
  }
  checks.push('two new explicit ordinary button actions do not overwrite or wash prior values');

  phase = 'ai';
  const aiBefore = modelRequests.length;
  const aiToast = await panelAction(first, aiSelector);
  assert.equal(
    modelRequests.length,
    aiBefore + 1,
    'One actual AI button must issue one real model request',
  );
  assert.equal((await values(first)).hint, support.EXPECTED.url, JSON.stringify(aiToast));
  assert.equal((await bkState(first)).fblOutcome?.status, 'confirmed');
  await checkpoint('ai-once', first, { toast: aiToast });
  checks.push(
    'one real AI panel button uses synthetic model catalog then the real guarded FBL setter',
  );

  phase = 'pause-human';
  await overlay(first, 'takeover');
  await humanText(first, '#name', '', true);
  await humanText(first, '#draft', ' continued by human');
  await clickPage(first, '#add-field');
  assert.equal((await values(first)).name, '');
  assert.match((await values(first)).draft, /continued by human/);
  const pausedValues = await values(first);
  await checkpoint('pause-human-input', first);
  await overlay(first, 'resume');
  const afterResume = await panelAction(first, fillSelector);
  assert.deepEqual(
    await values(first),
    pausedValues,
    'A new bind must not wash the per-document human-edit lock',
  );
  await checkpoint('resume-human-lock', first, { toast: afterResume });
  checks.push(
    'real FBL overlay pause enables trusted human typing; resume/new button preserves human-cleared empty field and draft',
  );

  phase = 'project-switch-barrier';
  gate = { entered: false };
  gate.wait = new Promise((resolve) => {
    gate.release = resolve;
  });
  const pendingAi = panelAction(first, aiSelector).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await until('real AI request held by synthetic model', () => gate.entered);
  await chooseProject(first, 'secondfixture');
  gate.release();
  gate = null;
  const staleReceipt = await pendingAi;
  if (staleReceipt.error) throw staleReceipt.error;
  const staleToast = staleReceipt.value;
  assert.deepEqual(
    await values(first),
    pausedValues,
    'Old project AI response must never write after switch',
  );
  await checkpoint('project-switch-stale-ai', first, { toast: staleToast });
  const newProjectToast = await panelAction(first, aiSelector);
  const switched = await values(first);
  assert.equal(switched.extra, second.fields.url.value, JSON.stringify(newProjectToast));
  assert.equal(switched.name, '');
  assert.equal(
    switched.hint,
    support.EXPECTED.url,
    'Existing values are retained across project switch',
  );
  assert.equal(switched.draft, pausedValues.draft);
  await checkpoint('new-project-explicit-ai', first, { toast: newProjectToast });
  checks.push(
    'real project-switch revoke barrier rejects a delayed old-model response; new explicit AI uses the new project without washing human locks',
  );

  phase = 'submission-lock';
  const submitted = await newFixture('submission', first.windowId);
  await chooseProject(submitted, 'probekits');
  await initialFill(submitted);
  submitted.task = await taskFor(submitted);
  assert.equal((await values(submitted)).name, support.EXPECTED.name);
  await overlay(submitted, 'takeover');
  await clickPage(submitted, '#submit');
  assert.equal((await values(submitted))['after-submit'], '');
  await overlay(submitted, 'resume');
  for (let i = 0; i < 2; i++) {
    const toast = await panelAction(submitted, fillSelector);
    assert.equal(
      (await values(submitted))['after-submit'],
      '',
      'Submission lock must survive a new explicit fill',
    );
    assert.ok(!toast.text.includes('FBL 已确认填写'), JSON.stringify(toast));
    await checkpoint(`submission-locked-repeat-${i + 1}`, submitted, { toast });
  }
  checks.push(
    'real form submit fences the document; two explicit new fill buttons cannot wash the submission lock',
  );

  phase = 'unknown-no-replay';
  const unknown = await newFixture('unknown', first.windowId);
  await chooseProject(unknown, 'probekits');
  const unknownToast = await initialFill(unknown);
  unknown.task = await taskFor(unknown);
  const unknownState = await bkState(unknown);
  assert.equal(unknownState.fblOutcome?.status, 'unknown', JSON.stringify(unknownToast));
  assert.equal(
    (await values(unknown)).name,
    support.EXPECTED.name,
    'The real setter ran before the synthetic site changed field eligibility',
  );
  const inputCount = () =>
    unknown.client.evaluate(
      `window.fixtureEvents.filter(e=>e.type==='input'&&e.id==='name'&&!e.trusted).length`,
    );
  assert.equal(await inputCount(), 1);
  const unknownId = unknownState.fblOutcome.requestId;
  for (let i = 0; i < 2; i++) {
    const toast = await panelAction(unknown, fillSelector);
    assert.equal((await bkState(unknown)).fblOutcome?.requestId, unknownId);
    assert.equal(await inputCount(), 1, 'Unknown outcome must not re-dispatch the setter');
    assert.ok(/未知/.test(toast.text), JSON.stringify(toast));
  }
  await checkpoint('unknown-no-replay', unknown, { toast: unknownToast });
  checks.push(
    'real setter + synchronous site field change yields unknown; two explicit button clicks retain the same unknown request and never replay input',
  );

  phase = 'unpair-preservation';
  const beforeUnpair = await Promise.all(
    pages.map(async (page) => ({
      page: await pageState(page),
      tab: await session.ui.evaluate(
        `chrome.tabs.get(${page.tabId}).then(t=>({url:t.url,windowId:t.windowId,groupId:t.groupId}))`,
      ),
    })),
  );
  const groupBeforeUnpair = await session.ui.evaluate(`chrome.tabGroups.get(${groupId})`);
  assert.equal(groupBeforeUnpair.title, initialGroup.title);
  assert.equal(groupBeforeUnpair.windowId, initialGroup.windowId);
  await session.trustedClick(
    pair.client,
    pair.targetId,
    `[data-extension-id="${backlinkId}"] [data-action="unpair"]`,
  );
  await until(
    'exact registry is empty after actual unpair',
    () =>
      pair.client.evaluate(
        `chrome.runtime.sendMessage({type:'product_connections'}).then(r=>r.result)`,
      ),
    (rows) => Array.isArray(rows) && rows.length === 0,
  );
  await until(
    'Backlink observes actual Port disconnect',
    () => bkState(first),
    (state) => state.fbl?.connected === false,
  );
  await until(
    'all real product tasks released',
    () => fblState(),
    (state) =>
      !state.tasks.some(
        (task) =>
          task.executionLane === 'product_fill' && !['closed', 'cancelled'].includes(task.state),
      ),
  );
  for (let i = 0; i < pages.length; i++) {
    const { visibility: beforeVisibility, ...beforeDocument } = beforeUnpair[i].page;
    const { visibility: afterVisibility, ...afterDocument } = await pageState(pages[i]);
    assert.ok(
      beforeVisibility && afterVisibility,
      'Record actual visibility without inferring background state',
    );
    assert.deepEqual(
      afterDocument,
      beforeDocument,
      'Unpair must keep document, values, events and URL',
    );
    const tab = await session.ui.evaluate(
      `chrome.tabs.get(${pages[i].tabId}).then(t=>({url:t.url,windowId:t.windowId,groupId:t.groupId}))`,
    );
    assert.deepEqual(tab, beforeUnpair[i].tab);
  }
  assert.deepEqual(
    await session.ui.evaluate(`chrome.tabGroups.get(${groupId})`),
    groupBeforeUnpair,
  );
  await focusPage(first);
  await humanText(first, '#draft', ' after unpair');
  assert.match((await values(first)).draft, /after unpair/);
  const unpairedValues = await values(first);
  const unpairedToast = await panelAction(first, fillSelector);
  assert.deepEqual(await values(first), unpairedValues);
  assert.ok(!unpairedToast.text.includes('FBL 已确认填写'), JSON.stringify(unpairedToast));
  await checkpoint('unpaired-original-retained', first, { toast: unpairedToast });
  checks.push(
    'actual unpair releases tasks/Port while preserving original pages/windows/user group/drafts; trusted typing works and subsequent fill is blocked',
  );

  phase = 'evidence';
  for (const page of pages) {
    await save(`page-${page.mode}.json`, await pageState(page));
    const shot = await page.client.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `page-${page.mode}.png`), Buffer.from(shot.data, 'base64'));
  }
  await save('model-requests.json', modelRequests);
  result.passed = true;
} catch (error) {
  result.error = { phase, message: error.message, stack: error.stack };
  if (panel)
    await save(
      'failed-panel.json',
      await panel.client
        .evaluate(
          `({tab:state.tab,site:state.site,fbl:state.fbl,fblOutcome:state.fblOutcome,toasts:document.querySelector('#toasts')?.textContent})`,
        )
        .catch((e) => ({ error: e.message })),
    );
  if (session)
    await save('failed-fbl-status.json', await fblState().catch((e) => ({ error: e.message })));
  if (pair) {
    await save(
      'failed-pairing-module.json',
      await pair.client
        .evaluate(
          `import('./product-connections.mjs').then(async({ProductConnections})=>({status:await new ProductConnections(chrome,()=>null,async()=>false).status()})).catch(e=>({error:e.message,stack:e.stack}))`,
        )
        .catch((failure) => ({ error: failure.message })),
    );
    await save(
      'failed-pairing.json',
      await pair.client
        .evaluate(
          `(async()=>({url:location.href,id:chrome.runtime.id,input:document.querySelector('#extension-id')?.value,feedback:document.querySelector('#action-status')?.textContent,status:document.querySelector('#registry-status')?.textContent,receipt:await chrome.runtime.sendMessage({type:'product_connections'})}))()`,
        )
        .catch((failure) => ({ error: failure.message })),
    );
  }
  for (const page of pages) {
    await save(
      `failed-page-${page.mode}.json`,
      await pageState(page).catch((failure) => ({ error: failure.message })),
    );
    const shot = await page.client
      .call('Page.captureScreenshot', { format: 'png' })
      .catch(() => null);
    if (shot)
      await writeFile(
        path.join(output, `failed-page-${page.mode}.png`),
        Buffer.from(shot.data, 'base64'),
      );
  }
  await save('model-requests.json', modelRequests);
  process.exitCode = 1;
} finally {
  gate?.release();
  if (session) {
    await save('browser.log', session.logs);
    await save(
      'targets.json',
      await fetchJson(`${session.base}/json/list`)
        .then((rows) => rows.map(({ id, type, url }) => ({ id, type, url })))
        .catch((error) => ({ error: error.message })),
    );
  }
  if (environment) await save('backend.log', environment.log());
  for (const client of clients) client.close();
  const cleanupErrors = [];
  try {
    await session?.close();
  } catch (error) {
    cleanupErrors.push(`session: ${error.message}`);
  }
  try {
    if (environment) {
      await environment.stop();
      if (environment.service.exitCode === null && environment.service.signalCode === null)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('fixture backend did not stop')), 10000);
          environment.service.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      await environment.cleanup();
    }
  } catch (error) {
    cleanupErrors.push(`backend: ${error.message}`);
  }
  await closeServer(fixtureServer);
  await closeServer(modelServer);
  if (cleanupErrors.length) {
    result.passed = false;
    result.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
  }
  result.phase = phase;
  result.note =
    'Synthetic model and local pages only; real browser/Native/leases/Port/guarded setter. Screenshots not visually reviewed by this runner.';
  await save('result.json', result);
  console.log(JSON.stringify(result, null, 2));
}
