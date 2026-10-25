import { renderStatus } from '../../native-extension/ui-design.mjs';
import { renderChains } from '../../native-extension/copilot-readiness.mjs';
import {
  mountControls,
  boardName,
  renderConnection,
} from '../../native-extension/copilot-controls.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { createOverlayView } from '../../native-extension/overlay-view.mjs';
import { createAutomationOverlay } from '../../native-extension/automation-overlay.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
const root = new URL('../../native-extension/', import.meta.url),
  [html, popup, css] = await Promise.all(
    ['popup.html', 'popup.mjs', 'popup.css'].map((name) => readFile(new URL(name, root), 'utf8')),
  );
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((done) => setImmediate(done));
};
function capture(dom) {
  const handlers = new WeakMap(),
    add = dom.window.EventTarget.prototype.addEventListener;
  dom.window.EventTarget.prototype.addEventListener = function (type, handler, ...rest) {
    if (!handlers.has(this)) handlers.set(this, {});
    (handlers.get(this)[type] ||= []).push(handler);
    return add.call(this, type, handler, ...rest);
  };
  return async (el, type = 'click', extra = {}) => {
    for (const handler of handlers.get(el)?.[type] || [])
      await handler({ isTrusted: true, currentTarget: el, target: el, ...extra });
    await flush();
  };
}
async function mount(status, { language = 'zh-CN', send } = {}) {
  const dom = new JSDOM(html, {
      url: 'chrome-extension://fixture/popup.html',
      runScripts: 'outside-only',
    }),
    fire = capture(dom),
    calls = [],
    timers = [];
  let closed = 0,
    changed;
  const dispose = dom.window.close.bind(dom.window);
  dom.window.setInterval = () => 1;
  dom.window.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  dom.window.clearTimeout = () => {};
  dom.window.close = () => {
    closed++;
  };
  dom.window.chrome = {
    i18n: { getUILanguage: () => language },
    windows: { getCurrent: async () => ({ id: 7 }) },
    runtime: {
      getManifest: () => ({ version: '2.2.0' }),
      onMessage: {
        addListener: (fn) => {
          changed = fn;
        },
      },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'popup_status') {
          if (status instanceof Error) throw status;
          return { result: status };
        }
        return send ? send(message) : { result: { opened: true } };
      },
    },
  };
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async () => {} },
  });
  Object.assign(dom.window, {
    renderStatus,
    renderChains,
    mountControls,
    boardName,
    renderConnection,
  });
  dom.window.eval(popup.replace(/^import\s[^;]*;\n/gm, ''));
  await flush();
  return {
    dom,
    doc: dom.window.document,
    fire,
    calls,
    timers,
    get closed() {
      return closed;
    },
    async update(value) {
      status = value;
      changed({ type: 'changed' });
      await flush();
    },
    close() {
      dispose();
    },
  };
}
test('popup maps local states without granting access from old consent, and keeps one primary action', async () => {
  for (const [status, state, empty] of [
    [{ connected: true, tasks: [] }, 'connected', null],
    [{ connected: false, browserFullConsentStatus: 'disabled' }, 'disconnected', '尚未授权连接'],
    [{ connected: false, browserFullConsentStatus: 'enabled' }, 'disconnected', '本地服务未运行'],
    [new Error('unavailable'), 'error', '本地服务未运行'],
  ]) {
    const h = await mount(status);
    assert.equal(h.doc.querySelector('#connection-label').dataset.state, state);
    assert.equal(h.doc.querySelector('#connection-card'), null);
    if (empty) assert.equal(h.doc.querySelector('#local-connect').textContent, '重试');
    assert.equal(
      [...h.doc.querySelectorAll('.primary')].filter((el) => !el.hidden).length,
      status.browserFullConsentStatus === 'disabled' ? 1 : 0,
    );
    if (state !== 'connected') {
      assert.doesNotMatch(h.doc.querySelector('#access-detail').textContent, /已连接|已授权|可由/);
      assert.equal(h.doc.querySelector('#page-task').hidden, true);
    }
    h.close();
  }
});
test('request buttons enter loading immediately, reject double clicks and preserve dismissible errors', async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = await mount(
    { connected: false, browserFullConsentStatus: 'disabled' },
    { send: () => pending },
  );
  const button = h.doc.querySelector('#local-connect');
  button.click();
  button.click();
  assert.equal(button.dataset.feedback, 'loading');
  assert.equal(button.disabled, true);
  assert.equal(h.calls.filter((row) => row.type === 'connect').length, 1);
  resolve({ error: 'no host' });
  await flush();
  assert.equal(h.doc.querySelector('#error-bar').hidden, false);
  await h.update({ connected: false });
  assert.equal(h.doc.querySelector('#error-bar').hidden, false);
  h.doc.querySelector('#error-close').click();
  assert.equal(h.doc.querySelector('#error-bar').hidden, true);
  h.close();
});
test('opening side panel closes only after confirmed success; toggle uses its dedicated popup scope', async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = await mount(
    { connected: true, copilot: { enabled: true, running: 2, unread: 3 } },
    {
      send: (message) =>
        message.type === 'copilot.open' ? pending : { result: { enabled: false } },
    },
  );
  assert.equal(h.doc.querySelector('#copilot-summary'), null);
  h.doc.querySelector('#open-copilot').click();
  assert.equal(h.closed, 0);
  resolve({ result: { opened: true } });
  await flush();
  assert.equal(h.closed, 1);
  assert.equal(h.calls.find((row) => row.type === 'copilot.open').windowId, 7);
  h.doc.querySelector('#copilot-toggle').click();
  await flush();
  assert.equal(h.calls.find((row) => row.type === 'copilot.popup_settings').enabled, false);
  h.close();
  const failed = await mount(
    { connected: true },
    { send: async () => ({ result: { opened: false } }) },
  );
  failed.doc.querySelector('#open-copilot').click();
  await flush();
  assert.equal(failed.closed, 0);
  assert.equal(failed.doc.querySelector('#error-bar').hidden, false);
  failed.close();
});
test('obsolete cloud state never restores controls, and Esc closes immediately', async () => {
  const h = await mount({
    connected: true,
    cloud: { state: 'active', paired: true, online: true },
  });
  try {
    assert.equal(h.doc.querySelector('[id^="cloud-"],.cloud-row'), null);
    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(h.closed, 1);
    assert.equal(
      h.calls.some((row) => row.type.startsWith('cloud_')),
      false,
    );
  } finally {
    h.close();
  }
});
test('English popup and motion contracts preserve concise labels and keyboard-accessible safety text', async () => {
  const h = await mount(
    {
      connected: true,
      cloud: { state: 'unpaired' },
      copilot: { enabled: true, running: 0, unread: 0 },
    },
    { language: 'en-US' },
  );
  assert.equal(h.doc.documentElement.lang, 'en');
  assert.equal(h.doc.querySelector('#open-copilot').textContent, 'Assist');
  assert.equal(h.doc.querySelector('#copilot-toggle').getAttribute('aria-checked'), 'true');
  assert.match(
    h.doc.querySelector('#connection-detail').textContent,
    /password values are never echoed/,
  );
  assert.equal(h.doc.querySelector('[id^=cloud-]'), null);
  assert.equal(h.doc.querySelector('dialog'), null);
  assert.ok(h.doc.querySelector('.info-button[aria-describedby]'));
  assert.match(css, /min-height:44px/);
  assert.match(await readFile(new URL('brand.css', root), 'utf8'), /prefers-reduced-motion:reduce/);
  h.close();
});
test('popup settings are refused for content and unrelated extension pages', async () => {
  const api = {
      runtime: { id: 'fixture', getURL: (path) => 'chrome-extension://fixture/' + path },
    },
    calls = [],
    service = new CopilotBackground(api, async (method, params) => {
      calls.push({ method, params });
      return method === 'agent_catalog'
        ? {
            default_agent: 'hermes',
            onboarding_required: false,
            agents: [{ id: 'hermes', installed: true, configured: true }],
          }
        : { enabled: params.enabled };
    });
  service.settings = async (state) => {
    service.enabled = state.enabled;
  };
  for (const sender of [
    { id: 'fixture', url: 'https://example.test/' },
    { id: 'fixture', url: 'chrome-extension://fixture/other.html' },
    { id: 'foreign', url: 'chrome-extension://fixture/popup.html' },
  ])
    assert.equal(
      service.handle({ type: 'copilot.popup_settings', enabled: true }, sender, () =>
        assert.fail('foreign sender'),
      ),
      false,
    );
  const result = await new Promise((done) =>
    service.handle(
      { type: 'copilot.popup_settings', enabled: true },
      { id: 'fixture', url: 'chrome-extension://fixture/popup.html' },
      done,
    ),
  );
  assert.equal(result.result.enabled, true);
  assert.deepEqual(calls, [
    { method: 'agent_catalog', params: {} },
    { method: 'settings', params: { enabled: true } },
  ]);
});
function viewFixture(options = {}) {
  const dom = new JSDOM('<html></html>', { url: 'https://example.test/' }),
    fire = capture(dom),
    preferences = [],
    view = createOverlayView(dom.window.document, {
      title: 'Synthetic task',
      ...options,
      onPreference: (value) => preferences.push(value),
    });
  dom.window.document.body.append(view.style, view.bar);
  return {
    dom,
    view,
    fire,
    preferences,
    close() {
      view.dispose();
      dom.window.close();
    },
  };
}
test('overlay keeps compact dimensions, inline metrics and no empty information blocks', () => {
  const h = viewFixture();
  const computed = (selector) => h.dom.window.getComputedStyle(h.view.bar.querySelector(selector));
  try {
    assert.match(h.view.bar.style.width, /^min\(288px,/);
    assert.equal(computed('.overlay-top').paddingTop, '8px');
    assert.equal(computed('[data-role=detail]').fontSize, '13px');
    assert.equal(computed('[data-role=recent-list]').maxHeight, '144px');
    assert.equal(computed('.stats').display, 'none');
    assert.equal(computed('[data-role=explanation]').display, 'none');
    h.view.activity(8, 12, { 页: 8, 行: 120 });
    assert.equal(computed('.stats').display, 'flex');
    assert.equal(computed('.stats>div').display, 'flex');
    // 中文注释：JSDOM 不解析带 var() 的 font 简写；真实字号另在 Edge 验收。
    assert.match(h.view.style.textContent, /\.stats b\{font:13px var\(--mono\)/);
    h.view.outcome({ state: 'failed', resumeFrom: 9 });
    assert.notEqual(computed('[data-role=explanation]').display, 'none');
    h.view.outcome({ state: 'running', total: 0 });
    assert.equal(computed('.stats').display, 'none');
    assert.equal(computed('[data-role=explanation]').display, 'none');
    assert.equal(h.view.recent.open, true);
  } finally {
    h.close();
  }
});
test('compact overlay restores its width and allows scrolling in short viewports', async () => {
  const h = viewFixture();
  try {
    const style = h.dom.window.getComputedStyle(h.view.bar);
    assert.equal(style.maxHeight, `${h.dom.window.innerHeight - 32}px`);
    assert.equal(style.overflow, 'auto');
    assert.equal(style.overscrollBehavior, 'contain');
    await h.fire(h.view.bar.querySelector('[data-role=minimize]'));
    assert.equal(h.view.bar.style.width, 'auto');
    await h.fire(h.view.bar.querySelector('[data-role=minimize]'));
    assert.match(h.view.bar.style.width, /^min\(288px,/);
    assert.equal(h.view.minimized, false);
  } finally {
    h.close();
  }
});
test('overlay initialization and status icons work when HTML string sinks are forbidden', () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test/' });
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(dom.window.Element.prototype, 'innerHTML', {
    set() {
      throw TypeError('TrustedHTML required');
    },
    configurable: true,
  });
  let overlay;
  try {
    overlay = createAutomationOverlay({
      document: dom.window.document,
      taskId: 'trusted-types',
      generation: 1,
      tabId: 7,
      origin: 'https://example.test',
      onStop: async () => ({ state: 'stopped' }),
      onTakeover: async () => ({ state: 'paused' }),
      onResume: async () => ({ state: 'running' }),
    });
    assert.equal(overlay.host.isConnected, true);
    for (const key of ['connected', 'running', 'failed']) {
      const node = dom.window.document.createElement('span');
      renderStatus(node, key);
      assert.ok(node.querySelector('svg path,svg circle'));
    }
  } finally {
    overlay?.remove();
    Object.defineProperty(dom.window.Element.prototype, 'innerHTML', descriptor);
    dom.window.close();
  }
});
test('overlay view maps every status, recent four, all rows, independent failure reasons and caller-neutral brand', async () => {
  const h = viewFixture();
  try {
    for (const [state, label] of Object.entries({
      running: '执行中',
      paused: '需要你操作',
      completed: '已完成',
      failed: '失败',
      stopped: '已停止',
    })) {
      h.view.state(state, '扫描页面');
      assert.equal(h.view.label.textContent, label);
      assert.equal(h.view.label.dataset.state, state);
    }
    h.view.setRows(
      Array.from({ length: 12 }, (_, i) => ({
        description: '扫描页面 ' + i,
        result: i === 11 ? 'failed' : 'succeeded',
        reason: i === 11 ? '目标未出现' : '',
        time: '2026-10-17T10:00:00Z',
        durationMs: 4200,
      })),
    );
    assert.equal(h.view.recentList.children.length, 4);
    assert.equal(h.view.recent.open, true);
    assert.match(
      h.view.recentList.lastElementChild.querySelector('.step-reason').textContent,
      /目标未出现/,
    );
    await h.fire(h.view.bar.querySelector('[data-role=all-steps]'));
    assert.equal(h.view.recentList.children.length, 12);
    assert.match(h.view.bar.textContent, /Fast-browser-link/);
    assert.doesNotMatch(h.view.bar.textContent, /HERMES|Hermes/);
  } finally {
    h.close();
  }
});
test('manual upward scrolling pauses following; latest resumes and copy uses only sanitized fields', async () => {
  const h = viewFixture();
  try {
    const list = h.view.recentList;
    Object.defineProperties(list, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    const scrolls = [];
    list.scrollTo = (value) => {
      scrolls.push(value);
      list.scrollTop = value.top;
    };
    h.view.setRows([
      { description: 'Scan page', result: 'pending', time: new Date().toISOString() },
    ]);
    list.scrollTop = 400;
    list.dispatchEvent(new h.dom.window.Event('scroll'));
    list.scrollTop = 80;
    list.dispatchEvent(new h.dom.window.Event('scroll'));
    assert.equal(h.view.bar.querySelector('[data-role=latest]').hidden, false);
    const count = scrolls.length;
    h.view.setRows([{ description: 'Scan page again', result: 'succeeded' }]);
    assert.equal(scrolls.length, count);
    await h.fire(h.view.bar.querySelector('[data-role=latest]'));
    assert.ok(scrolls.length > count);
    let copied;
    Object.defineProperty(h.dom.window.navigator, 'clipboard', {
      value: {
        writeText: async (value) => {
          copied = value;
        },
      },
    });
    await h.fire(h.view.bar.querySelector('[data-role=copy-log]'));
    assert.match(copied, /Scan page again/);
    assert.match(h.view.bar.querySelector('[data-role=copy-log]').textContent, /已复制/);
  } finally {
    h.close();
  }
});
test('minimization persists per-task presentation and closed shadow remains blocking during screenshots', async () => {
  const h = viewFixture({
    startedAt: Date.now() - 5500,
    preferences: { minimized: true, collapsed: true },
  });
  try {
    assert.equal(h.view.bar.querySelector('[data-role=elapsed]').textContent, '0:05');
    assert.equal(h.view.bar.dataset.minimized, 'true');
    assert.equal(h.view.recent.open, true);
    await h.fire(h.view.bar.querySelector('[data-role=minimize]'));
    assert.equal(h.view.bar.dataset.minimized, 'false');
    assert.deepEqual(h.preferences.at(-1), { minimized: false, collapsed: false });
    assert.match(h.view.style.textContent, /prefers-reduced-motion:reduce/);
  } finally {
    h.close();
  }
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test/' }),
    overlay = createAutomationOverlay({
      document: dom.window.document,
      taskId: 'fixture',
      generation: 1,
      tabId: 7,
      origin: 'https://example.test',
      preferences: { minimized: true },
      onStop: async () => ({ state: 'stopped' }),
      onTakeover: async () => ({ state: 'paused' }),
      onResume: async () => ({ state: 'running' }),
    });
  try {
    assert.equal(overlay.host.shadowRoot, null);
    assert.equal(overlay.host.style.pointerEvents, 'auto');
    await overlay.withHidden(async () => {
      assert.equal(overlay.host.style.opacity, '0');
      assert.equal(overlay.host.style.pointerEvents, 'auto');
    });
    assert.equal(overlay.isVisible(), true);
  } finally {
    overlay.remove();
    dom.window.close();
  }
});
test('stop requires a second trusted click within three seconds and disables duplicate requests', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const dom = new JSDOM('<html></html>', { url: 'https://example.test/' }),
    fire = capture(dom);
  let shadow,
    resolve,
    calls = 0;
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    shadow = attach.call(this, options);
    return shadow;
  };
  const overlay = createAutomationOverlay({
    document: dom.window.document,
    taskId: 'fixture',
    generation: 1,
    tabId: 7,
    origin: 'https://example.test',
    onStop: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    onTakeover: async () => ({ state: 'paused' }),
    onResume: async () => ({ state: 'running' }),
  });
  try {
    const stop = shadow.querySelector('[data-action=stop]');
    await fire(stop);
    assert.equal(calls, 0);
    assert.match(stop.textContent, /确认停止/);
    context.mock.timers.tick(3001);
    assert.equal(stop.textContent, '停止');
    await fire(stop);
    assert.equal(calls, 0);
    const request = fire(stop);
    await flush();
    assert.equal(calls, 1);
    assert.equal(stop.disabled, true);
    assert.equal(stop.dataset.busy, 'true');
    await fire(stop);
    assert.equal(calls, 1);
    resolve({ state: 'stopped' });
    await request;
    assert.equal(overlay.host.isConnected, false);
  } finally {
    overlay.remove();
    dom.window.close();
  }
});
test('brand PNG sizes, toolbar assets and all runtime surfaces consume the shared tokens', async () => {
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(new URL(`icon-${size}.png`, root));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.ok(manifest.web_accessible_resources[0].resources.includes('brand.mjs'));
  for (const file of ['popup.html', 'copilot-panel.html', 'copilot-result.html'])
    assert.match(await readFile(new URL(file, root), 'utf8'), /brand.css/);
  for (const file of ['copilot-collector.mjs', 'overlay-view.mjs'])
    assert.match(await readFile(new URL(file, root), 'utf8'), /BRAND_CSS/);
});

// 中文注释：实际源SVG必须能重建已提交图标；夹具只写自建临时目录，不增加安装依赖。
test('standard-library SVG generation reproduces every checked-in icon and shadow brand module', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fbl-brand-'));
  try {
    await promisify(execFile)('python3', [
      new URL('../../scripts/generate-brand.py', import.meta.url).pathname,
      '--output',
      directory,
    ]);
    for (const file of [
      'icon-16.png',
      'icon-32.png',
      'icon-48.png',
      'icon-128.png',
      'brand.mjs',
      'brand-mark.svg',
    ])
      assert.deepEqual(
        await readFile(path.join(directory, file)),
        await readFile(new URL(file, root)),
        file,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('collaboration row keeps a stable label and only exposes its board when enabled', async () => {
  const h = await mount({
    connected: true,
    copilot: { enabled: false, board_name: 'My Agent', hermes_health: { state: 'disconnected' } },
  });
  try {
    assert.equal(h.doc.querySelector('#popup-board-name').textContent, '协作');
    assert.equal(h.doc.querySelector('#open-copilot').hidden, true);
    assert.equal(h.doc.querySelector('#copilot-toggle').getAttribute('aria-checked'), 'false');
    for (const state of ['connecting', 'connected', 'error', 'disconnected']) {
      await h.update({
        connected: true,
        copilot: {
          enabled: true,
          board_name: 'My Agent',
          hermes_health: { state, reason: 'synthetic' },
        },
      });
      assert.equal(h.doc.querySelector('#popup-hermes-status,#hermes-row,#hermes-refresh'), null);
      assert.equal(h.doc.querySelector('#open-copilot').hidden, false);
    }
    assert.equal(
      h.calls.some((row) => ['models', 'configure', 'retry_inference'].includes(row.command)),
      false,
    );
  } finally {
    h.close();
  }
});

test('enabling from popup opens the side panel in the click gesture without a second action', async () => {
  const h = await mount(
    { connected: true, copilot: { enabled: false } },
    {
      send: async (message) => ({
        result: message.type === 'copilot.open' ? { opened: true } : { enabled: true },
      }),
    },
  );
  try {
    h.doc.getElementById('copilot-toggle').click();
    await flush();
    const commands = h.calls.filter((row) =>
      ['copilot.open', 'copilot.popup_settings'].includes(row.type),
    );
    assert.deepEqual(
      commands.map((row) => row.type),
      ['copilot.open', 'copilot.popup_settings'],
    );
    assert.equal(commands[1].enabled, true);
  } finally {
    h.close();
  }
});
test('popup stop confirmation survives polling and cannot transfer to a different task', async () => {
  const task = { id: 'one', generation: 1, state: 'running' },
    status = { connected: true, page: { taskId: 'one', tabId: 7 }, tasks: [task] };
  const h = await mount(status, { send: async () => ({ result: { verified: true } }) });
  try {
    const button = h.doc.getElementById('stop-task');
    button.click();
    await flush();
    assert.equal(
      h.calls.some((row) => row.type === 'popup_action'),
      false,
    );
    await h.update(status);
    assert.equal(button.textContent, '确认停止');
    await h.update({
      ...status,
      page: { taskId: 'two', tabId: 7 },
      tasks: [{ ...task, id: 'two' }],
    });
    button.click();
    await flush();
    assert.equal(
      h.calls.some((row) => row.type === 'popup_action'),
      false,
    );
    assert.equal(button.textContent, '确认停止');
    button.click();
    await flush();
    assert.equal(h.calls.filter((row) => row.type === 'popup_action').length, 1);
    assert.equal(h.calls.find((row) => row.type === 'popup_action').taskId, 'two');
  } finally {
    h.close();
  }
});
