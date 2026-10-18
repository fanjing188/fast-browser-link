import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { redactPageText, privateAccountNode } from '../../page-semantics/redact.mjs';
import {
  pageSnapshot,
  safeText,
  describeEvent,
  stableSnapshots,
  tableSummary,
  safeURL,
} from '../../native-extension/copilot-observation.mjs';
import { selectedText, selectionTasks } from '../../native-extension/copilot-selection.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';

function fixture(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/report?token=PRIVATE_TOKEN' });
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
  });
  dom.window.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  return dom;
}
function select(doc, node) {
  const range = doc.createRange();
  range.selectNodeContents(node);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
function timers() {
  let now = 0,
    id = 0;
  const pending = new Map();
  return {
    get now() {
      return now;
    },
    get size() {
      return pending.size;
    },
    schedule(fn, delay) {
      pending.set(++id, { fn, at: now + delay });
      return id;
    },
    cancel(key) {
      pending.delete(key);
    },
    advance(to) {
      for (;;) {
        const next = [...pending]
          .filter(([, value]) => value.at <= to)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
      }
      now = to;
    },
  };
}

test('R24 E2 shared page redactor removes email, phone, numeric IDs and credential URLs', () => {
  const privateValues = [
    'user@example.test',
    '+1 (415) 555-0108',
    '13800138000',
    '123456789012345678',
    'PRIVATE_TOKEN',
    'PRIVATE_KEY',
    'PRIVATE_SESSION',
    'PRIVATE_AUTH',
    'PRIVATE_CODE',
    'PRIVATE_FRAGMENT',
  ];
  const text =
    privateValues.slice(0, 4).join(' ') +
    ' https://login:pass@example.test/p?token=PRIVATE_TOKEN&api_key=PRIVATE_KEY&session=PRIVATE_SESSION&q=public#PRIVATE_FRAGMENT /relative?auth=PRIVATE_AUTH&code=PRIVATE_CODE https://example.test/user%40example.test?q=user%40example.test';
  const result = redactPageText(text);
  for (const value of privateValues) assert.ok(!result.includes(value), value);
  assert.doesNotMatch(result, /login:pass/);
  assert.match(result, /q=public/);
  assert.match(result, /\[email\]/);
  assert.match(result, /\[number\]/);
  assert.doesNotMatch(result, /user%40example.test/);
  assert.equal(
    redactPageText('job scheduler — volume 230 / KD 18'),
    'job scheduler — volume 230 / KD 18',
  );
});
test('R24 E2 credential parameter boundaries retain keyword objects and redact common token naming styles', () => {
  const url = new URL(
    redactPageText(
      'https://example.test/?keyword=sample&keywords=one%2Ctwo&apiKey=PRIVATE_API&api_key=PRIVATE_SNAKE&access_token=PRIVATE_ACCESS&sessionId=PRIVATE_SESSION&token=PRIVATE_TOKEN',
    ),
  );
  assert.equal(url.searchParams.get('keyword'), 'sample');
  assert.equal(url.searchParams.get('keywords'), 'one,two');
  for (const key of ['apiKey', 'api_key', 'access_token', 'sessionId', 'token'])
    assert.equal(url.searchParams.get(key), '[redacted]');
  assert.equal(
    redactPageText(
      '/overview?keyword=sample&keywords=one,two&apiKey=PRIVATE_API&sessionId=PRIVATE_SESSION',
    ),
    '/overview?keyword=sample&keywords=one,two&apiKey=[redacted]&sessionId=[redacted]',
  );
});
test('R24 E2 snapshots, click descriptions and table headings contain no private originals', () => {
  const dom = fixture(
    '<title>user@example.test 123456789012345678</title><main><h1>Keyword overview</h1><p>user@example.test +1 (415) 555-0108 https://example.test/?token=PRIVATE_TOKEN</p><button aria-label="Google 账号：PRIVATE_NAME (user@example.test)"><span>PRIVATE_NAME</span></button><button aria-label="Personal profile PRIVATE_PROFILE"></button><img alt="Account PRIVATE_AVATAR"><button id="public">Check job scheduler</button><input value="PRIVATE_INPUT"><textarea>PRIVATE_EDITOR</textarea></main>',
  );
  try {
    const doc = dom.window.document,
      page = pageSnapshot(doc, dom.window.location.href);
    assert.ok(page.items.length > 0);
    assert.match(JSON.stringify(page), /Keyword overview|Check job scheduler/);
    const summary = tableSummary({
      tables: [
        {
          headers: ['Keyword', 'user@example.test', '?token=PRIVATE_TOKEN'],
          rows: [['job scheduler']],
          incomplete: false,
        },
      ],
    });
    const data = JSON.stringify([
      page,
      summary,
      safeText(doc.querySelector('main')),
      describeEvent({ type: 'click', target: doc.querySelector('#public') }, doc),
    ]);
    for (const value of [
      'user@example.test',
      '415',
      'PRIVATE_NAME',
      'PRIVATE_PROFILE',
      'PRIVATE_AVATAR',
      'PRIVATE_INPUT',
      'PRIVATE_EDITOR',
      'PRIVATE_TOKEN',
      '123456789012345678',
    ])
      assert.ok(!data.includes(value), value);
    for (const node of doc.querySelectorAll('[aria-label],img'))
      if (!node.id) assert.ok(privateAccountNode(node));
    assert.equal(
      describeEvent({ type: 'click', target: doc.querySelector('button span') }, doc),
      null,
    );
  } finally {
    dom.window.close();
  }
});
test('R24 E2 selected text rejects account nodes and a range containing an account menu', () => {
  const dom = fixture(
    '<section><p>public keyword</p><button aria-label="Google account PRIVATE_NAME"><span>PRIVATE_NAME</span></button></section><p id="safe">user@example.test 13800138000 /p?token=PRIVATE_TOKEN</p>',
  );
  try {
    const doc = dom.window.document;
    select(doc, doc.querySelector('span'));
    assert.equal(selectedText(doc), null);
    select(doc, doc.querySelector('section'));
    assert.equal(selectedText(doc), null);
    select(doc, doc.querySelector('#safe'));
    const value = selectedText(doc);
    assert.ok(value);
    assert.doesNotMatch(value.text, /user@example.test|13800138000|PRIVATE_TOKEN/);
  } finally {
    dom.window.close();
  }
});
test('R24 E2 selection redaction preserves line breaks and batch keyword task parameters', () => {
  const dom = fixture('<p>one keyword\ntwo keyword\nuser@example.test</p>');
  try {
    const doc = dom.window.document;
    select(doc, doc.querySelector('p'));
    const selected = selectedText(doc);
    assert.equal(selected.text, 'one keyword\ntwo keyword\n[email]');
    const tasks = selectionTasks(selected.text);
    assert.equal(tasks.type, 'multiple');
    assert.deepEqual(tasks.tasks.find((task) => task.id === 'batch').params.keywords, [
      'one keyword',
      'two keyword',
      '[email]',
    ]);
    assert.doesNotMatch(JSON.stringify(tasks), /user@example.test/);
  } finally {
    dom.window.close();
  }
});
test('R24 E2 background sanitizes table context and waits for sanitized collector titles after tab activation', async () => {
  const calls = [];
  const url = 'https://example.test/report?token=PRIVATE_TOKEN';
  const api = {
    runtime: {
      id: 'x',
      getURL: (path) => 'chrome-extension://x/' + path,
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({}) }, session: { set: async () => {} } },
    windows: { get: async () => ({ focused: true }) },
    tabs: { sendMessage: async () => {}, query: async () => [{ id: 1, windowId: 7, url }] },
  };
  const background = new CopilotBackground(api, async (method, params) => {
    calls.push([method, params]);
    return {};
  });
  background.enabled = true;
  background.tableCaptures.set(1, {
    tables: [
      {
        headers: ['Keyword', 'user@example.test', '?token=PRIVATE_TOKEN'],
        rows: [['job scheduler']],
      },
    ],
  });
  await background.observation(
    { id: 'x', frameId: 0, url, tab: { id: 1, url } },
    { url: safeURL(url), title: 'report', items: [] },
    '打开页面',
  );
  const capability = calls.find(([method]) => method === 'capability_context')[1];
  assert.doesNotMatch(JSON.stringify(capability), /user@example.test|PRIVATE_TOKEN/);
  assert.equal(capability.tables[0].rows, 1);
  const before = calls.filter(([method]) => method === 'observe').length;
  background.api.tabs.query = async () => [
    { id: 2, windowId: 7, url, title: 'user@example.test 123456789012345678' },
  ];
  background.tabEvent(2, '切换标签页', { id: 2, url });
  await background.queue;
  assert.equal(calls.filter(([method]) => method === 'observe').length, before);
  const dom = fixture('<title>user@example.test 123456789012345678</title><h1>Keyword report</h1>');
  try {
    await background.observation(
      { id: 'x', frameId: 0, url, tab: { id: 2, url } },
      pageSnapshot(dom.window.document, url),
      '切换标签页',
    );
  } finally {
    dom.window.close();
  }
  const observation = calls.filter(([method]) => method === 'observe').at(-1)[1];
  assert.doesNotMatch(JSON.stringify(observation), /user@example.test|123456789012345678/);
  assert.equal(calls.filter(([method]) => method === 'observe').length, before + 1);
  assert.match(observation.page.title, /\[email\]/);
  // 中文注释：本机执行上下文仍保留导航过滤参数；宿主会在推理发送边界再次脱敏。
  assert.equal(calls.find(([method]) => method === 'page_context')[1].url, url);
});
test('R24 E3 first snapshot waits through loading and DOM mutations, then captures populated items', () => {
  const dom = fixture('<main></main>'),
    clock = timers(),
    captures = [];
  let loaded = false;
  try {
    const doc = dom.window.document;
    const stable = stableSnapshots(
      (reason) =>
        captures.push({ at: clock.now, reason, page: pageSnapshot(doc, dom.window.location.href) }),
      { schedule: clock.schedule, cancel: clock.cancel, ready: () => loaded },
    );
    stable.change('打开页面');
    clock.advance(1000);
    assert.equal(captures.length, 0);
    clock.advance(1500);
    doc.querySelector('main').innerHTML =
      '<h1>Keyword overview</h1><button>Check job scheduler</button>';
    stable.change();
    loaded = true;
    clock.advance(2499);
    assert.equal(captures.length, 0);
    clock.advance(2500);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].reason, '打开页面');
    assert.ok(captures[0].page.items.length > 0);
    assert.match(JSON.stringify(captures[0].page), /job scheduler/);
    assert.equal(clock.size, 0);
    stable.stop();
  } finally {
    dom.window.close();
  }
});
test('R24 E3 deadline never captures loading DOM and teardown cancels deferred first snapshot', () => {
  const clock = timers(),
    captures = [];
  let ready = false;
  const stable = stableSnapshots((reason) => captures.push([clock.now, reason]), {
    schedule: clock.schedule,
    cancel: clock.cancel,
    ready: () => ready,
  });
  stable.change('打开页面');
  for (let t = 500; t < 7000; t += 500) {
    clock.advance(t);
    stable.change();
  }
  assert.equal(captures.length, 0);
  ready = true;
  clock.advance(7500);
  assert.deepEqual(captures, [[7500, '打开页面']]);
  stable.change('导航到新页面');
  stable.stop();
  clock.advance(13000);
  assert.equal(captures.length, 1);
  assert.equal(clock.size, 0);
});
test('R24 E3 collector wires document readiness and all DOM changes through the stability gate', async () => {
  const source = await readFile(
    new URL('../../native-extension/copilot-collector.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source.replace(/\s+/g, ''),
    /stableSnapshots\(\(description,descriptions\)=>snapshot\(description,descriptions\),\{ready:\(\)=>document.readyState!=='loading'\},?\)/,
  );
  assert.match(source, /schedule\('打开页面'\)/);
  assert.match(source, /MutationObserver\([\s\S]*?schedule\(\)/);
});

function collectorHarness() {
  const dom = fixture('<main><h1>Keyword report</h1></main>'),
    win = dom.window,
    clock = timers(),
    listeners = new Set(),
    managed = [],
    observers = new Set(),
    ownerKey = Symbol.for('fast-browser-link.copilot.collector');
  const add = win.EventTarget.prototype.addEventListener;
  win.EventTarget.prototype.addEventListener = function (type, listener, options) {
    if ((this === win || this === win.document) && options?.signal)
      managed.push({ type, signal: options.signal });
    return add.call(this, type, listener, options);
  };
  const NativeObserver = win.MutationObserver;
  class Observer extends NativeObserver {
    constructor(callback) {
      super(callback);
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  }
  win.MutationObserver = Observer;
  let invalidRemove = false,
    removeFailures = 0,
    pendingState = null;
  const chrome = {
    i18n: { getUILanguage: () => 'en' },
    runtime: {
      sendMessage: async (message) =>
        message.type === 'copilot.collector_state'
          ? pendingState
            ? pendingState()
            : { result: { enabled: true, observing: true, show_ball: true } }
          : { result: {} },
      onMessage: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => {
          if (invalidRemove) {
            removeFailures++;
            throw Error('Extension context invalidated');
          }
          listeners.delete(listener);
        },
      },
    },
  };
  const values = {
    window: win,
    document: win.document,
    location: win.location,
    navigator: win.navigator,
    chrome,
    AbortController: win.AbortController,
    MutationObserver: Observer,
    setTimeout: clock.schedule,
    clearTimeout: clock.cancel,
    setInterval: clock.schedule,
    clearInterval: clock.cancel,
    requestAnimationFrame: (fn) => clock.schedule(fn, 16),
  };
  const saved = new Map(
    Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    dom,
    clock,
    listeners,
    ownerKey,
    get owner() {
      return globalThis[ownerKey];
    },
    get liveListeners() {
      return managed.filter((item) => !item.signal.aborted).length;
    },
    get observers() {
      return observers.size;
    },
    get removeFailures() {
      return removeFailures;
    },
    invalidate() {
      invalidRemove = true;
      listeners.clear();
    },
    restoreContext() {
      invalidRemove = false;
    },
    deferState(fn) {
      pendingState = fn;
    },
    close() {
      globalThis[ownerKey]?.stop();
      dom.window.close();
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    },
  };
}
const freshCollector = () =>
  import(
    new URL(
      '../../native-extension/copilot-collector.mjs?fixture=' + crypto.randomUUID(),
      import.meta.url,
    )
  );
test('collector reload disposes an unreachable prior owner and removes only its own orphan DOM', async () => {
  const h = collectorHarness();
  try {
    await (await freshCollector()).start();
    const previous = h.owner,
      initialListeners = h.liveListeners,
      initialObservers = h.observers,
      initialTimers = h.clock.size;
    delete globalThis[h.ownerKey];
    for (const kind of [
      'copilot',
      'copilot-annotations',
      'copilot-selection',
      'table-confirmation',
    ]) {
      const node = h.dom.window.document.createElement('div');
      node.dataset.fastAutomationOverlay = kind;
      h.dom.window.document.documentElement.append(node);
    }
    await (await freshCollector()).start();
    assert.notEqual(h.owner, previous);
    assert.equal(h.listeners.size, 1);
    assert.equal(h.liveListeners, initialListeners);
    assert.equal(h.observers, initialObservers);
    assert.equal(h.clock.size, initialTimers);
    for (const kind of ['copilot', 'copilot-annotations'])
      assert.equal(
        h.dom.window.document.querySelectorAll(`[data-fast-automation-overlay="${kind}"]`).length,
        1,
      );
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="copilot-selection"]')
        .length,
      0,
    );
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="table-confirmation"]')
        .length,
      1,
    );
  } finally {
    h.close();
  }
});
test('R24 H4 fresh module injection replaces one collector and tears down DOM, observers, timers and listeners despite invalid context', async () => {
  const h = collectorHarness();
  try {
    await (await freshCollector()).start();
    const first = h.owner,
      oldListener = [...h.listeners][0],
      initialListeners = h.liveListeners,
      initialObservers = h.observers,
      initialTimers = h.clock.size;
    assert.ok(initialListeners > 0);
    assert.equal(h.listeners.size, 1);
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="copilot"]').length,
      1,
    );
    for (const node of h.dom.window.document.querySelectorAll('[data-fast-automation-overlay]'))
      assert.equal(node.shadowRoot, null);
    await (await freshCollector()).start();
    assert.notEqual(h.owner, first);
    assert.equal(h.listeners.size, 1);
    assert.equal(h.liveListeners, initialListeners);
    assert.equal(h.observers, initialObservers);
    assert.equal(h.clock.size, initialTimers);
    const invalidatedListener = [...h.listeners][0];
    h.invalidate();
    await (await freshCollector()).start();
    assert.equal(h.removeFailures, 1);
    const current = h.owner;
    assert.equal(h.listeners.size, 1);
    assert.equal(h.liveListeners, initialListeners);
    assert.equal(h.observers, initialObservers);
    assert.equal(h.clock.size, initialTimers);
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="copilot"]').length,
      1,
    );
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="copilot-annotations"]')
        .length,
      1,
    );
    first.stop();
    oldListener({ type: 'copilot.teardown' });
    invalidatedListener({ type: 'copilot.annotation_refresh' });
    assert.equal(h.owner, current);
    assert.equal(h.clock.size, initialTimers);
    h.restoreContext();
    [...h.listeners][0]({ type: 'copilot.teardown' });
    assert.equal(h.owner, undefined);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.liveListeners, 0);
    assert.equal(h.observers, 0);
    assert.equal(h.clock.size, 0);
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay]').length,
      0,
    );
  } finally {
    h.close();
  }
});
test('R24 H4 an older pending injection cannot recreate resources after a newer collector owns the document', async () => {
  const h = collectorHarness();
  try {
    let release;
    h.deferState(() => new Promise((resolve) => (release = resolve)));
    const first = (await freshCollector()).start();
    const previous = h.owner;
    h.deferState(null);
    await (await freshCollector()).start();
    const current = h.owner;
    assert.notEqual(previous, current);
    release({ result: { enabled: true, observing: true, show_ball: true } });
    await first;
    assert.equal(h.owner, current);
    assert.equal(h.listeners.size, 1);
    assert.equal(
      h.dom.window.document.querySelectorAll('[data-fast-automation-overlay="copilot"]').length,
      1,
    );
    current.stop();
    assert.equal(h.owner, undefined);
    assert.equal(h.liveListeners, 0);
    assert.equal(h.observers, 0);
    assert.equal(h.clock.size, 0);
  } finally {
    h.close();
  }
});
