import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { AnnotationLayer, recognizeObjects } from '../../native-extension/copilot-annotations.mjs';
import { renderDashboard, showTaskConfirmation } from '../../native-extension/copilot-view.mjs';
import { BasketPanel } from '../../native-extension/copilot-basket.mjs';
import { renderReadiness } from '../../native-extension/copilot-readiness.mjs';
import { renderStatus } from '../../native-extension/ui-design.mjs';
import { mountControls, renderConnection } from '../../native-extension/copilot-controls.mjs';
import { localize } from '../../native-extension/copilot-i18n.mjs';

const extension = fileURLToPath(new URL('../../native-extension/', import.meta.url));
const read = (name) => readFile(path.join(extension, name), 'utf8');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const state = { locale: 'zh', enabled: true, ready: true, suggestions: [] };
function page(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/report', pretendToBeVisual: true });
  dom.window.Element.prototype.getClientRects = function () {
    return this.hidden ? [] : [this.getBoundingClientRect()];
  };
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { left: 10, right: 210, top: 40, bottom: 65, width: 200, height: 25 };
  };
  return dom;
}
const table =
  '<main><table><tr><th>Keyword</th></tr><tr id="row"><td><a href="/search?q=sample">sample</a></td></tr><tr><td>known</td></tr></table></main>';
async function layerFixture() {
  const dom = page(table),
    calls = [];
  const layer = new AnnotationLayer(dom.window.document, {
    request: async (name, params) => {
      calls.push({ name, params });
      return name === 'lookup'
        ? {
            items: params.objects.map((item) => ({
              ...item,
              info: item.value === 'known' ? { pool: true } : {},
            })),
          }
        : {};
    },
  });
  await layer.refresh();
  return {
    dom,
    doc: dom.window.document,
    layer,
    calls,
    close() {
      layer.destroy();
      dom.window.close();
    },
  };
}

test('state notice clears after bridge recovery and retains the current inference failure', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document,
      notice = doc.getElementById('notice');
    renderDashboard(doc, { ...state, bridge_lost: true, diagnostic: 'bridge_disconnected' });
    assert.match(notice.textContent, /正在重连/);
    renderDashboard(doc, state);
    assert.equal(notice.textContent, '');
    assert.equal(notice.dataset.source, undefined);
    const failure = { message: '推理模型暂时不可用' };
    renderDashboard(doc, { ...state, inference_failure: failure });
    assert.equal(notice.textContent, failure.message);
    renderDashboard(doc, { ...state, bridge_lost: true, inference_failure: failure });
    assert.match(notice.textContent, /正在重连/);
    renderDashboard(doc, { ...state, inference_failure: failure });
    assert.equal(notice.textContent, failure.message);
    renderDashboard(doc, { ...state, inference_failure: failure });
    assert.equal(notice.textContent, failure.message);
  } finally {
    dom.window.close();
  }
});

test('bridge disconnect renders one repair notice without duplicate error or status banners', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document;
    renderDashboard(doc, { ...state, bridge_lost: true, diagnostic: 'bridge_disconnected' });
    assert.equal(doc.getElementById('connection-notice').hidden, false);
    assert.equal(doc.getElementById('error').hidden, true);
    assert.equal(doc.getElementById('notice').hidden, true);
    assert.match(doc.getElementById('connection-message').textContent, /断开|中断/);
    assert.equal(doc.getElementById('repair-connection').textContent, '重新连接');
  } finally {
    dom.window.close();
  }
});
test('retry confirmation survives state polling and inference errors, forwards its token, and can cancel', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document,
      calls = [],
      command = async (name, params) => {
        calls.push({ name, params });
        return { started: true };
      };
    renderDashboard(
      doc,
      { ...state, bridge_lost: true, diagnostic: 'bridge_disconnected' },
      { command },
    );
    renderDashboard(doc, state, { command });
    const root = showTaskConfirmation(
        doc,
        {
          id: 'fixture-task',
          command: 'retry',
          token: 'fixture-token',
          message: '回执未知，确认后继续',
        },
        command,
      ),
      confirm = root.querySelector('button');
    assert.equal(root.id, 'task-confirmation');
    assert.equal(doc.getElementById('notice').contains(root), false);
    assert.equal(root.hidden, false);
    assert.equal(doc.activeElement, confirm);
    renderDashboard(doc, state, { command });
    renderDashboard(
      doc,
      { ...state, inference_failure: { message: '模型返回格式不对' } },
      { command },
    );
    assert.equal(doc.getElementById('task-confirmation'), root);
    assert.equal(root.querySelector('button'), confirm);
    assert.match(root.textContent, /回执未知/);
    assert.equal(confirm.isConnected, true);
    confirm.click();
    await flush();
    assert.deepEqual(calls, [
      { name: 'retry', params: { id: 'fixture-task', confirmation: 'fixture-token' } },
    ]);
    assert.equal(doc.getElementById('task-confirmation'), null);
    const cancelled = showTaskConfirmation(
      doc,
      { id: 'cancelled-task', command: 'retry', token: 'other-token' },
      command,
    );
    cancelled.querySelectorAll('button')[1].click();
    await flush();
    assert.equal(doc.getElementById('task-confirmation'), null);
    assert.equal(calls.length, 1);
    const english = showTaskConfirmation(
      doc,
      {
        id: 'english-task',
        command: 'retry',
        token: 'english-token',
        message: '从头重跑，可能重复第 1 步；工具回执或额度未知，确认后再执行。',
      },
      command,
    );
    localize(doc, 'en');
    assert.match(english.textContent, /Restart from the beginning; step 1 may repeat/);
    assert.equal(english.querySelector('button').textContent, 'Confirm run');
  } finally {
    dom.window.close();
  }
});
test('collapsed basket exposes batch action in summary, opens and plans selected keywords, and hides when empty', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document,
      calls = [],
      panel = new BasketPanel(doc, async (name, params) => {
        calls.push({ name, params });
        return {
          count: 2,
          task_count: 1,
          call_upper_bound: 2,
          model_calls: 1,
          estimated_tokens: 20,
          timeout_upper_seconds: 30,
          tools: [],
          token: 'fixture-plan',
        };
      });
    panel.update({
      revision: 1,
      items: [
        { id: 'one', type: 'keyword', value: 'sample one' },
        { id: 'two', type: 'keyword', value: 'sample two' },
        { id: 'domain', type: 'domain', value: 'example.test' },
      ],
    });
    const root = panel.root,
      batch = root.querySelector('.basket-run');
    assert.equal(root.hidden, false);
    assert.equal(root.open, false);
    assert.equal(batch.closest('summary'), root.querySelector('summary'));
    assert.equal(batch.hidden, false);
    batch.click();
    await flush();
    assert.equal(root.open, true);
    assert.deepEqual(calls, [
      { name: 'basket_plan', params: { ids: ['one', 'two'], operation: 'check' } },
    ]);
    assert.match(root.querySelector('.batch-preview').textContent, /执行前确认/);
    assert.equal(root.querySelectorAll('input:checked').length, 2);
    panel.update({ revision: 2, items: [] });
    assert.equal(root.hidden, true);
  } finally {
    dom.window.close();
  }
});

test('pending cards align title and quota metadata without a type icon and expose one primary execution action', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document,
      calls = [],
      suggestions = ['one', 'two'].map((id) => ({
        id,
        title: `检查 sample ${id}`,
        why: `核对 ${id} 的指标`,
        params: { keyword: `sample ${id}` },
        action: 'seo.keyword_check',
        status: 'pending',
      }));
    renderDashboard(
      doc,
      { ...state, suggestions },
      {
        command: async (name, params) => {
          calls.push({ name, params });
        },
      },
    );
    const cards = [...doc.querySelectorAll('#pending article')];
    assert.equal(cards.length, 2);
    assert.equal(doc.querySelectorAll('#pending .primary').length, 1);
    for (const [index, card] of cards.entries()) {
      const heading = card.querySelector(':scope > .task-heading'),
        context = card.querySelector(':scope > .task-context');
      assert.ok(heading);
      assert.ok(context);
      assert.equal(heading.children.length, 2);
      assert.equal(heading.querySelector('svg'), null);
      assert.equal(heading.children[0].tagName, 'H3');
      assert.equal(heading.children[0].textContent, suggestions[index].title);
      assert.ok(heading.children[1].classList.contains('meta'));
      assert.equal(heading.querySelector('.cost').textContent, '耗额度');
      assert.equal(context.querySelector('.object').textContent, suggestions[index].params.keyword);
      assert.equal(context.querySelector('.reason').textContent, suggestions[index].why);
      assert.equal(card.querySelectorAll('[data-action=execute]').length, 1);
      card.querySelector('[data-action=execute]').click();
    }
    await flush();
    assert.deepEqual(calls, [
      { name: 'execute', params: { id: 'one' } },
      { name: 'execute', params: { id: 'two' } },
    ]);
  } finally {
    dom.window.close();
  }
});

async function importGraph(root, manifest, { source = false } = {}) {
  const resources = new Set(manifest.web_accessible_resources.flatMap((row) => row.resources));
  const canonical = path.resolve(extension, '..', 'page-semantics');
  const mapped = { 'index.js': 'page-semantics.mjs', 'parser.mjs': 'page-parser.mjs' };
  const queue = [path.join(root, 'copilot-collector.mjs')],
    visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let relative = path.relative(root, file).split(path.sep).join('/');
    if (source && file.startsWith(canonical + path.sep))
      relative = `vendor/${mapped[path.basename(file)] || path.basename(file)}`;
    assert.ok(resources.has(relative), `not web accessible: ${relative}`);
    const code = await readFile(file, 'utf8');
    for (const pattern of [
      /\b(?:from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\1/g,
      /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
    ]) {
      for (const match of code.matchAll(pattern))
        queue.push(path.resolve(path.dirname(file), match[2].split(/[?#]/)[0]));
    }
  }
  return visited;
}
test('collector static and dynamic import graph is web accessible in source and real build', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const source = await importGraph(extension, manifest, { source: true });
  assert.ok(source.size > 5);
  assert.ok([...source].some((file) => file.endsWith('copilot-annotations.mjs')));
  assert.ok([...source].some((file) => file.endsWith('ui-design.mjs')));
  const directory = await mkdtemp(path.join(tmpdir(), 'fbl-r24-build-'));
  try {
    await promisify(execFile)(process.execPath, [path.join(extension, 'build.mjs'), directory]);
    const built = await importGraph(
      directory,
      JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
    );
    assert.equal(built.size, source.size);
    assert.ok([...built].every((file) => file.startsWith(directory + path.sep)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('each repeated content entry injection requests a fresh module URL', async () => {
  const source = await read('copilot-entry.js'),
    urls = [];
  assert.match(source, /import\(chrome\.runtime\.getURL\('copilot-collector\.mjs'\)\s*\+\s*'\?i='/);
  const context = {
    chrome: { runtime: { getURL: (name) => `chrome-extension://fixture/${name}` } },
    crypto: { randomUUID },
    load: async (url) => {
      urls.push(url);
      return { start() {} };
    },
  };
  // 中文注释：只替换加载器，重复执行真实入口里的 URL 生成表达式。
  const script = new vm.Script(source.replace('import(', 'load('));
  script.runInNewContext(context);
  script.runInNewContext(context);
  await flush();
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(url.pathname, '/copilot-collector.mjs');
    assert.ok(url.searchParams.get('i'));
  }
});

test('one keyword cell and its query link produce one empty badge, shown only on row hover', async () => {
  const h = await layerFixture();
  try {
    const objects = recognizeObjects(h.doc);
    assert.equal(objects.filter((row) => row.value === 'sample').length, 1);
    assert.equal(h.layer.entries.size, 2);
    assert.equal(h.layer.host.shadowRoot, null);
    const empty = [...h.layer.entries.values()].find((mark) => mark.title === 'sample'),
      known = [...h.layer.entries.values()].find((mark) => mark.title === 'known');
    assert.ok(empty.classList.contains('empty'));
    assert.ok(!empty.classList.contains('hovered'));
    assert.ok(!known.classList.contains('empty'));
    // 中文注释：JSDOM 不参与 shadow CSS 计算，使用同一生产样式和当前徽标类名做样式回归。
    const style = h.doc.createElement('style');
    style.textContent = h.layer.root.querySelector('style').textContent;
    h.doc.head.append(style);
    const preview = empty.cloneNode(true);
    h.doc.body.append(preview);
    assert.equal(h.dom.window.getComputedStyle(preview).opacity, '0');
    assert.equal(h.dom.window.getComputedStyle(preview).pointerEvents, 'none');
    h.doc
      .getElementById('row')
      .dispatchEvent(new h.dom.window.MouseEvent('pointerover', { bubbles: true }));
    assert.ok(empty.classList.contains('hovered'));
    preview.className = empty.className;
    assert.equal(h.dom.window.getComputedStyle(preview).opacity, '1');
    assert.equal(h.dom.window.getComputedStyle(preview).pointerEvents, 'auto');
    h.doc
      .getElementById('row')
      .dispatchEvent(
        new h.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: h.layer.host }),
      );
    assert.ok(empty.classList.contains('hovered'));
    empty.dispatchEvent(
      new h.dom.window.MouseEvent('pointerover', { bubbles: true, composed: true }),
    );
    assert.ok(empty.classList.contains('hovered'));
    assert.equal(h.layer.hovered, h.doc.getElementById('row'));
    h.doc
      .getElementById('row')
      .dispatchEvent(
        new h.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: h.doc.body }),
      );
    assert.ok(!empty.classList.contains('hovered'));
  } finally {
    h.close();
  }
});

test('annotation task menu closes after 400 ms outside, stays inside, and closes on outside pointer, scroll and Esc', async (context) => {
  const h = await layerFixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const object = h.layer.objects.find((row) => row.value === 'sample'),
      badge = [...h.layer.entries.values()].find((mark) => mark.title === 'sample');
    const open = () => {
      h.layer.openMenu(object, badge);
      assert.ok(h.layer.menu?.isConnected);
    };
    open();
    badge.dispatchEvent(new h.dom.window.MouseEvent('mouseleave'));
    context.mock.timers.tick(399);
    assert.ok(h.layer.menu);
    context.mock.timers.tick(1);
    assert.equal(h.layer.menu, null);
    open();
    badge.dispatchEvent(new h.dom.window.MouseEvent('mouseleave'));
    h.layer.menu.dispatchEvent(new h.dom.window.MouseEvent('mouseenter'));
    context.mock.timers.tick(401);
    assert.ok(h.layer.menu);
    h.layer.menu
      .querySelector('button')
      .dispatchEvent(new h.dom.window.Event('pointerdown', { bubbles: true, composed: true }));
    assert.ok(h.layer.menu);
    h.layer.menu.dispatchEvent(new h.dom.window.MouseEvent('mouseleave'));
    context.mock.timers.tick(400);
    assert.equal(h.layer.menu, null);
    for (const close of [
      () =>
        h.doc.body.dispatchEvent(
          new h.dom.window.Event('pointerdown', { bubbles: true, composed: true }),
        ),
      () => h.dom.window.dispatchEvent(new h.dom.window.Event('scroll')),
      () => h.doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' })),
    ]) {
      open();
      close();
      assert.equal(h.layer.menu, null);
    }
  } finally {
    h.close();
    context.mock.timers.reset();
  }
});

test('annotation actions require trusted clicks and ignore editable/password regions', async () => {
  const h = await layerFixture();
  try {
    const object = h.layer.objects[0],
      badge = [...h.layer.entries.values()][0];
    badge.click();
    await flush();
    assert.equal(
      h.calls.some((row) => row.name === 'basket_add'),
      false,
    );
    h.layer.openMenu(object, badge);
    for (const button of h.layer.menu.querySelectorAll('button')) button.click();
    await flush();
    assert.equal(
      h.calls.some((row) => row.name !== 'lookup'),
      false,
    );
    await badge.onclick({ isTrusted: true });
    await flush();
    assert.equal(h.calls.filter((row) => row.name === 'basket_add').length, 1);
  } finally {
    h.close();
  }
  const dom = page(
    '<main><form><input type="password"><a href="/?q=password-region">password-region</a></form><div contenteditable="true"><a href="/?q=editable-region">editable-region</a></div><input value="input-region"><a href="/?q=public">public</a></main>',
  );
  try {
    assert.deepEqual(
      recognizeObjects(dom.window.document).map((row) => row.value),
      ['public'],
    );
  } finally {
    dom.window.close();
  }
});

async function popupStatus(current) {
  const code = await read('background.mjs'),
    start = /if\s*\(m\.type\s*===\s*'popup_status'\)\s*\{/.exec(code)?.index ?? -1,
    end = /if\s*\(m\.type\s*===\s*'popup_action'\)\s*\{/.exec(code)?.index ?? -1;
  assert.ok(start > 0 && end > start);
  const requests = [],
    copilot = {
      boardName: 'fixture',
      hermesHealth: { state: 'connected' },
      enabled: true,
      rows: new Map(),
      localJobs: new Map(),
      unread: new Set(),
      request: async (method, params) => {
        requests.push([method, params]);
        return current;
      },
    };
  const get = vm.runInNewContext(`(async function(){${code.slice(start, end)}})`, {
    m: { type: 'popup_status' },
    buildStatus: {
      loadedBuildId: 'a'.repeat(64),
      installedBuildId: 'a'.repeat(64),
      pending: false,
    },
    connected: true,
    connectedInstanceId: 'fixture',
    consent: { readStatus: async () => 'enabled' },
    navigator: { userAgent: 'Edg' },
    cloud: { view: () => ({ state: 'unpaired' }) },
    copilot,
    bridge: { request: async () => [] },
    chrome: {
      runtime: { getManifest: () => ({ version: '2.2.0' }) },
      tabs: { query: async () => [] },
    },
    executor: { leases: new Map(), tasks: new Map() },
  });
  return { result: await get(), requests };
}
async function mountPopup(status) {
  const dom = new JSDOM(await read('popup.html'), {
    url: 'chrome-extension://fixture/popup.html',
    runScripts: 'outside-only',
  });
  dom.window.setInterval = () => 1;
  dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: {
      getManifest: () => ({ version: '2.2.0' }),
      onMessage: { addListener() {} },
      sendMessage: async () => ({ result: status }),
    },
  };
  Object.assign(dom.window, { renderStatus, mountControls, renderConnection });
  dom.window.eval((await read('cloud-popup.mjs')).replace(/^import\s[^;]*;\n/gm, ''));
  dom.window.eval((await read('popup.mjs')).replace(/^import\s[^;]*;\n/gm, ''));
  await flush();
  return dom;
}
test('popup reads the same ready/execution data as sidebar and unpaired cloud is an ordinary state', async () => {
  const current = {
    ready: true,
    execution_health: { state: 'connected' },
    hermes_health: { state: 'connected' },
    board_name: 'fixture',
  };
  const { result, requests } = await popupStatus(current);
  assert.deepEqual(structuredClone(requests), [['state', {}]]);
  assert.equal(result.copilot.ready, true);
  assert.deepEqual(result.copilot.execution_health, current.execution_health);
  const dom = await mountPopup(result);
  try {
    const doc = dom.window.document;
    assert.equal(doc.getElementById('access-status').dataset.status, 'connected');
    assert.equal(doc.getElementById('hermes-row'), null);
    assert.equal(doc.getElementById('cloud-status').textContent, '未配对');
    assert.notEqual(doc.getElementById('cloud-status').dataset.state, 'error');
    assert.equal(doc.getElementById('error-bar').hidden, true);
  } finally {
    dom.window.close();
  }
});

test('readiness renders integrity separately from a healthy browser and removes the all-ready checklist', async () => {
  const dom = new JSDOM(await read('copilot-panel.html'));
  try {
    const doc = dom.window.document;
    renderReadiness(doc, {
      ready: false,
      items: [
        { id: 'browser', ok: true },
        { id: 'integrity', ok: false, command: 'fbl update' },
      ],
    });
    const rows = [...doc.querySelectorAll('.readiness-row')];
    assert.match(rows[0].textContent, /✓ 浏览器连接/);
    assert.equal(rows[0].querySelector('button'), null);
    assert.match(rows[1].textContent, /安装文件与发布包不一致 · 运行 fbl update/);
    rows[1].querySelector('button').click();
    assert.equal(rows[1].querySelector('code').textContent, 'fbl update');
    renderReadiness(doc, { ready: true, items: [] });
    assert.equal(doc.getElementById('fbl-readiness'), null);
  } finally {
    dom.window.close();
  }
});

test('popup preserves the connection failure reason instead of claiming the healthy service stopped', async () => {
  const dom = await mountPopup({
    connected: false,
    browserFullConsentStatus: 'enabled',
    observedAt: Date.now(),
    lastError: 'Native host has exited.',
    tasks: [],
    copilot: { enabled: false },
    cloud: { state: 'unpaired' },
  });
  try {
    dom.window.document.getElementById('local-connect').click();
    await flush();
    assert.equal(
      dom.window.document.getElementById('error').textContent,
      'Native host has exited.',
    );
  } finally {
    dom.window.close();
  }
});
