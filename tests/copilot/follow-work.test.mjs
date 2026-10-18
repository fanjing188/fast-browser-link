import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  stableSnapshots,
  readingContext,
  safeURL,
  pageSnapshot,
} from '../../native-extension/copilot-observation.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
import { localize } from '../../native-extension/copilot-i18n.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const tick = () => new Promise((done) => setImmediate(done));

test('one settled snapshot retains ordered actions; teardown drops an unsent batch', () => {
  let next = 0;
  const timers = new Map(),
    captured = [];
  const gate = stableSnapshots((last, all) => captured.push({ last, all }), {
    schedule: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    cancel: (id) => timers.delete(id),
  });
  for (const reason of ['点击 链接 A', '选中 free export', '复制 free export']) gate.change(reason);
  [...timers.values()][0]();
  assert.deepEqual(captured, [
    { last: '复制 free export', all: ['点击 链接 A', '选中 free export', '复制 free export'] },
  ]);
  gate.change('点击 链接 B');
  gate.stop();
  assert.equal(timers.size, 0);
  assert.equal(captured.length, 1);
});

function background() {
  let tab = { id: 1, windowId: 7, url: 'https://example.test/a' };
  const calls = [];
  const api = {
    runtime: { id: 'x', getURL: (path) => 'chrome-extension://x/' + path },
    windows: { get: async () => ({ focused: true }) },
    tabs: { query: async () => [tab], sendMessage: async () => {} },
    storage: { local: { get: async () => ({}) }, session: { set: async () => {} } },
  };
  const service = new CopilotBackground(api, async (method, params) => {
    calls.push([method, params]);
    return {};
  });
  service.enabled = true;
  return {
    service,
    calls,
    setTab: (value) => (tab = value),
    sender: () => ({ id: 'x', frameId: 0, url: tab.url, tab }),
    page: () => ({ url: safeURL(tab.url), title: 'Plans', items: [] }),
  };
}

test('background sends the whole batch once and permits the same selection on another page', async () => {
  const f = background();
  await f.service.observation(f.sender(), f.page(), '复制 free', [
    '点击 链接 A',
    '选中 free',
    '复制 free',
  ]);
  let payload = f.calls.filter(([method]) => method === 'observe').at(-1)[1];
  assert.deepEqual(
    payload.trace.map((row) => row.description),
    ['点击 链接 A', '选中 free', '复制 free'],
  );
  await f.service.observation(f.sender(), f.page(), '复制 free', [
    '点击 链接 A',
    '选中 free',
    '复制 free',
  ]);
  assert.equal(f.calls.filter(([method]) => method === 'observe').length, 1);
  f.setTab({ id: 2, windowId: 7, url: 'https://example.test/b' });
  await f.service.observation(f.sender(), f.page(), '选中 free');
  payload = f.calls.filter(([method]) => method === 'observe').at(-1)[1];
  assert.equal(payload.trace.at(-1).tabId, 2);
  await assert.rejects(() =>
    f.service.observation(f.sender(), f.page(), 'copy', Array(31).fill('复制 a')),
  );
});

test('only the extension panel can correct work or send feedback', async () => {
  const f = background();
  const message = {
    type: 'copilot.command',
    command: 'work_update',
    params: { direction: 'free users' },
  };
  assert.equal(
    f.service.handle(message, f.sender(), () => {}),
    false,
  );
  const response = await new Promise((resolve) =>
    assert.equal(
      f.service.handle(
        message,
        { id: 'x', url: 'chrome-extension://x/copilot-panel.html' },
        resolve,
      ),
      true,
    ),
  );
  assert.deepEqual(response, { result: {} });
  assert.equal(f.calls.at(-1)[0], 'work_update');
});

test('reading context names a visible section and excludes account content', () => {
  const dom = new JSDOM(
    '<main><h2>Offscreen</h2><h2 id="private"><button aria-label="Google account PRIVATE_NAME">PRIVATE_NAME</button></h2><h2 id="public">Export limits user@example.test</h2><input value="PRIVATE_INPUT"></main>',
  );
  try {
    for (const node of dom.window.document.querySelectorAll('h2'))
      node.getBoundingClientRect = () => ({ top: node.id ? 20 : -100, bottom: node.id ? 40 : -80 });
    assert.equal(readingContext(dom.window.document), 'Export limits [email]');
  } finally {
    dom.window.close();
  }
});

test('work correction survives polling, prevents double submit, and retains text on failure', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document,
    calls = [];
  let reject;
  const state = {
    locale: 'zh',
    work: { goal: '比较套餐', evidence: ['公开价格页'], open_questions: ['导出未知'] },
    user_direction: '',
    suggestions: [],
  };
  const context = {
    command: (method, params) => {
      calls.push([method, params]);
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
  };
  try {
    renderDashboard(doc, state, context);
    const input = doc.getElementById('work-direction'),
      form = doc.getElementById('work-form');
    input.value = '只看免费用户';
    input.dispatchEvent(new dom.window.Event('input'));
    renderDashboard(doc, state, context);
    assert.equal(input.value, '只看免费用户');
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    assert.deepEqual(calls, [['work_update', { direction: '只看免费用户' }]]);
    assert.equal(form.getAttribute('aria-busy'), 'true');
    reject(Error('offline'));
    await tick();
    assert.equal(input.value, '只看免费用户');
    assert.match(doc.getElementById('work-notice').textContent, /保留输入/);
    assert.equal(form.hasAttribute('aria-busy'), false);
    assert.equal(doc.getElementById('work-goal').textContent, '比较套餐');
    assert.match(doc.getElementById('work-facts').textContent, /导出未知/);
  } finally {
    dom.window.close();
  }
});

test('correction and new-work controls send scoped commands and model text stays literal', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document,
    calls = [];
  const state = {
    locale: 'en',
    user_direction: 'Free only',
    work: { goal: '<img src=x onerror=alert(1)>', next_step: 'Compare' },
    suggestions: [
      {
        id: 'a',
        title: 'Compare',
        why: 'fixture',
        action: 'general.task',
        params: { task: 'compare' },
        status: 'pending',
      },
    ],
  };
  try {
    renderDashboard(doc, state, {
      command: async (...args) => {
        calls.push(args);
        return state;
      },
    });
    localize(doc, 'en');
    assert.equal(doc.querySelector('#work-goal img'), null);
    assert.match(doc.getElementById('work-user-direction').textContent, /Your direction/);
    await doc.querySelector('[data-action=feedback-later]').onclick();
    await doc.querySelector('[data-action=feedback-wrong]').onclick();
    await doc.getElementById('work-new').onclick();
    assert.deepEqual(calls, [
      ['feedback', { id: 'a', kind: 'later' }],
      ['feedback', { id: 'a', kind: 'wrong' }],
      ['work_update', { reset: true }],
    ]);
    assert.match(doc.getElementById('work-context').textContent, /Current goal/);
  } finally {
    dom.window.close();
  }
});

test('table summaries keep surrounding page context without uploading table rows', () => {
  const dom = new JSDOM(
    '<main><h1>Compare free plans</h1><p>Export availability differs.</p><table><tr><td>RAW_TABLE_ROW</td></tr></table><input value="PRIVATE_INPUT"></main>',
    { url: 'https://example.test/' },
  );
  try {
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    });
    dom.window.HTMLElement.prototype.getClientRects = function () {
      return [this.getBoundingClientRect()];
    };
    const snapshot = pageSnapshot(dom.window.document, dom.window.location.href, 2200, true),
      text = JSON.stringify(snapshot);
    assert.match(text, /Compare free plans/);
    assert.match(text, /Export availability/);
    assert.doesNotMatch(text, /RAW_TABLE_ROW|PRIVATE_INPUT/);
  } finally {
    dom.window.close();
  }
});

test('explicit feedback withdraws its card even while hovered and keyboard focused', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  const state = {
    suggestions: [
      {
        id: 'dismiss',
        title: 'Compare',
        why: 'fixture',
        action: 'general.task',
        params: { task: 'compare' },
        status: 'pending',
      },
    ],
  };
  const context = {
    command: async (name) => {
      if (name === 'feedback') {
        state.suggestions = [];
        renderDashboard(doc, state, context);
      }
      return state;
    },
  };
  try {
    renderDashboard(doc, state, context);
    const article = doc.querySelector('[data-id=dismiss]');
    article.dispatchEvent(new dom.window.Event('pointerenter'));
    const button = article.querySelector('[data-action=feedback-wrong]');
    button.focus();
    await button.onclick();
    assert.equal(article.getAttribute('aria-hidden'), 'true');
    await new Promise((done) => setTimeout(done, 220));
    assert.equal(doc.querySelector('[data-id=dismiss]'), null);
  } finally {
    dom.window.close();
  }
});
