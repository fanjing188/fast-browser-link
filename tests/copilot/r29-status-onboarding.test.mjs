import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderDashboard, renderWorkContext } from '../../native-extension/copilot-view.mjs';
import { AgentPanel } from '../../native-extension/copilot-agent-panel.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import { renderStatus } from '../../native-extension/ui-design.mjs';
const root = new URL('../../native-extension/', import.meta.url),
  html = await readFile(new URL('copilot-panel.html', root), 'utf8');
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};
const catalog = (configured = false, name = 'Hermes') => ({
  default_agent: 'hermes',
  onboarding_required: !configured,
  agents: [
    {
      id: 'hermes',
      name,
      installed: true,
      configured,
      status: configured ? 'configured' : 'needs_setup',
      can_setup: true,
      setup_action: 'configure',
    },
  ],
});
const state = {
  locale: 'zh',
  enabled: false,
  ready: false,
  settings_saved: true,
  revision: 1,
  agent: { id: 'hermes', name: 'Synthetic', state: 'connected' },
  hermes_health: { state: 'connected' },
  config: {
    mode: 'balanced',
    max_parallel: 3,
    context_limit: 6000,
    turn_multiplier: 1,
    exec_transport: 'acp',
    inference_model: '',
    exec_model: '',
  },
  suggestions: [],
  result_history: [],
  basket: { revision: 1, items: [] },
};
function fixture() {
  const dom = new JSDOM(html, {
      url: 'chrome-extension://fixture/copilot-panel.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    }),
    doc = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  return {
    dom,
    doc,
    close() {
      dom.window.close();
    },
  };
}

test('侧栏不展示或轮询已退役的云端连接', async () => {
  const f = await mountMain();
  try {
    assert.equal(f.doc.getElementById('sidebar-cloud'), null);
    assert.equal(
      f.calls.some((message) => message.type === 'copilot.connections'),
      false,
    );
  } finally {
    f.close();
  }
});

async function mountMain(
  initial = state,
  available = catalog(false),
  local = () => ({ capture: null, jobs: [] }),
) {
  const f = fixture(),
    calls = [],
    listeners = [];
  let current = structuredClone(initial);
  f.dom.window.setInterval = () => 1;
  f.dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      connect: () => ({}),
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'copilot.local') return { result: local(message) };
        if (message.command === 'basket_state') return { result: current.basket };
        if (message.type === 'copilot.connections') return { result: { cloud: null } };
        if (message.command === 'agent_catalog') return { result: available };
        if (message.command === 'directory_defaults')
          return { result: { export_dir: '/synthetic/exports', logs_dir: '/synthetic/logs' } };
        if (message.command === 'logs_read') return { result: { entries: [], revision: 0 } };
        if (message.command === 'log_client') return { result: { accepted: true } };
        if (message.command === 'capability_state')
          return { result: { capabilities: {}, tools: [], candidates: [] } };
        return { result: current };
      },
    },
    downloads: { download: async () => 1 },
  };
  const entrypoint = new URL('copilot-panel.mjs', root),
    source = await readFile(entrypoint, 'utf8'),
    modules = await Promise.all(
      [...source.matchAll(/^import .*? from ['"]([^'"]+)['"];?$/gm)].map(
        ([, path]) => import(new URL(path, entrypoint)),
      ),
    );
  Object.assign(f.dom.window, ...modules);
  f.dom.window.eval(source.replace(/^import\s[^;]*;\n/gm, ''));
  await flush();
  return {
    ...f,
    calls,
    listeners,
    async update(next) {
      current = next;
      for (const listener of listeners)
        listener({ type: 'copilot.changed', event: { revision: next.revision, type: 'update' } });
      await flush();
    },
    close() {
      f.dom.window.dispatchEvent(new f.dom.window.Event('unload'));
      f.close();
    },
  };
}

test('toolbar uses a text settings action and contains no duplicate status badge', () => {
  const f = fixture();
  try {
    assert.equal(f.doc.getElementById('status'), null);
    assert.equal(f.doc.getElementById('open-settings').textContent.trim(), '设置');
    assert.equal(f.doc.getElementById('open-settings').querySelector('svg'), null);
    assert.doesNotThrow(() => renderDashboard(f.doc, state, { command: async () => ({}) }));
  } finally {
    f.close();
  }
});

test('work status uses the current Agent name and requires enabled, ready and connected receipts', () => {
  const f = fixture();
  try {
    for (const locale of ['zh', 'en']) {
      const base = {
        ...state,
        locale,
        enabled: true,
        ready: true,
        agent: { id: 'hermes', name: 'Other', state: 'connected' },
        hermes_health: { state: 'disconnected' },
      };
      renderWorkContext(f.doc, base, { command: async () => ({}) });
      assert.equal(
        f.doc.getElementById('work-status').textContent,
        locale === 'zh' ? 'Other · 协作中' : 'Other · Assist on',
      );
      assert.equal(f.doc.getElementById('work-context').dataset.activity, 'following');
      for (const change of [
        { enabled: false },
        { ready: false },
        { agent: { ...base.agent, state: 'connecting' } },
        { agent: { ...base.agent, state: 'disconnected' } },
      ]) {
        renderWorkContext(f.doc, { ...base, ...change }, { command: async () => ({}) });
        assert.doesNotMatch(f.doc.getElementById('work-status').textContent, /协作中|Assist on/);
      }
      renderWorkContext(
        f.doc,
        { ...base, ready: false, agent: { ...base.agent, state: 'connecting' } },
        { command: async () => ({}) },
      );
      assert.equal(
        f.doc.getElementById('work-status').textContent,
        locale === 'zh' ? '正在连接 Other Agent' : 'Connecting to Other Agent',
      );
    }
  } finally {
    f.close();
  }
});

test('first sidebar detection is read-only and enabling an unconfigured Agent opens setup without starting collaboration', async () => {
  const f = await mountMain();
  try {
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, false);
    assert.ok(f.calls.some((message) => message.command === 'agent_catalog'));
    assert.equal(
      f.calls.some((message) =>
        [
          'configure',
          'settings',
          'agent_setup_start',
          'agent_select',
          'execute',
          'models',
        ].includes(message.command),
      ),
      false,
    );
    const toggle = f.doc.getElementById('enabled');
    toggle.checked = true;
    await toggle.onchange({ target: toggle });
    await flush();
    assert.equal(toggle.checked, false);
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, true);
    f.doc.getElementById('agent-later').click();
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, false);
    for (const listener of f.listeners) listener({ type: 'copilot.agent_onboarding' });
    await flush();
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, true);
    assert.equal(
      f.calls.some((message) =>
        ['configure', 'settings', 'agent_setup_start', 'execute'].includes(message.command),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test('sidebar connection labels follow state.agent.name without treating connection metadata as active collaboration', async () => {
  const f = await mountMain(state, catalog(true, 'Synthetic'));
  try {
    f.doc.getElementById('settings-tab-about').click();
    const label = f.doc.getElementById('hermes-status').parentElement.textContent;
    assert.match(label, /Synthetic/);
    assert.doesNotMatch(label, /本机 Hermes/);
    assert.doesNotMatch(f.doc.getElementById('work-status').textContent, /协作中|Assist on/);
    await f.update({ ...state, enabled: true, ready: false, revision: 2 });
    assert.doesNotMatch(f.doc.getElementById('work-status').textContent, /协作中|Assist on/);
    assert.equal(
      f.calls.some((message) => message.command === 'settings'),
      false,
    );
  } finally {
    f.close();
  }
});

test('a completed ACP initialization receipt enables an explicit start action without starting a model session', async () => {
  const f = fixture(),
    calls = [];
  let enabled = 0;
  const completed = {
      id: 'setup-1',
      agent_id: 'hermes',
      status: 'completed',
      phase: 'complete',
      connection: {
        inference: 'connected',
        execution: 'connected',
        check: 'acp_initialize',
        model_call: false,
      },
    },
    panel = new AgentPanel(
      f.doc,
      async (name, params) => {
        calls.push([name, params]);
        return name === 'agent_catalog' ? catalog(true) : completed;
      },
      {
        onEnable: async () => {
          enabled++;
          return true;
        },
      },
    );
  try {
    await panel.refresh();
    assert.equal(enabled, 0);
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, false);
    panel.job = completed;
    panel.render();
    assert.equal(f.doc.getElementById('agent-enable').hidden, false);
    assert.equal(enabled, 0);
    assert.equal(
      calls.some(([name]) => ['settings', 'execute', 'models', 'agent_setup_start'].includes(name)),
      false,
    );
    panel.job = {
      ...completed,
      connection: { inference: 'connected', execution: 'connected', check: 'unverified' },
    };
    panel.render();
    assert.equal(f.doc.getElementById('agent-enable').hidden, true);
    assert.equal(panel.ready(), false);
  } finally {
    panel.dispose();
    f.close();
  }
});

function service(configured = false, settingsEnabled = false) {
  const calls = [],
    messages = [],
    api = {
      runtime: {
        id: 'fixture',
        getURL: (path) => `chrome-extension://fixture/${path}`,
        sendMessage: async (message) => messages.push(message),
      },
    },
    background = new CopilotBackground(api, async (name, params) => {
      calls.push([name, params]);
      return name === 'agent_catalog'
        ? catalog(configured)
        : name === 'settings'
          ? { enabled: settingsEnabled }
          : {};
    });
  background.settings = async () => {};
  return { background, calls, messages };
}
const sender = (page) => ({ id: 'fixture', url: `chrome-extension://fixture/${page}` });
async function send(background, message, from) {
  return new Promise((resolve) => {
    if (!background.handle(message, from, resolve)) resolve(null);
  });
}

test('popup first-use routing requests onboarding without changing settings or trusting a requested enabled value', async () => {
  const f = service(false);
  const reply = await send(
    f.background,
    { type: 'copilot.popup_settings', enabled: true },
    sender('popup.html'),
  );
  assert.equal(reply.result.enabled, false);
  assert.equal(reply.result.onboarding_required, true);
  assert.equal(
    f.calls.some(([name]) => name === 'settings'),
    false,
  );
  assert.ok(f.messages.some((message) => message.type === 'copilot.agent_onboarding'));
  const ready = service(true, false),
    confirmed = await send(
      ready.background,
      { type: 'copilot.popup_settings', enabled: true },
      sender('popup.html'),
    );
  assert.equal(confirmed.result.enabled, false, 'use the actual settings receipt');
  assert.deepEqual(
    ready.calls.filter(([name]) => name === 'settings'),
    [['settings', { enabled: true }]],
  );
  const paused = service(false, false),
    off = await send(
      paused.background,
      { type: 'copilot.popup_settings', enabled: false },
      sender('popup.html'),
    );
  assert.equal(off.result.enabled, false);
  assert.deepEqual(paused.calls, [['settings', { enabled: false }]]);
  assert.equal(
    paused.messages.some((message) => message.type === 'copilot.agent_onboarding'),
    false,
  );
});

test('only the extension panel can call setup, selection and catalog commands', async () => {
  const commands = [
    'agent_catalog',
    'agent_setup_start',
    'agent_setup_status',
    'agent_setup_cancel',
    'agent_select',
  ];
  for (const command of commands) {
    const f = service(),
      message = { type: 'copilot.command', command, params: { agent_id: 'hermes', id: 'job-1' } };
    for (const from of [
      sender('popup.html'),
      {
        id: 'fixture',
        url: 'https://example.test/',
        frameId: 0,
        tab: { id: 1, url: 'https://example.test/', windowId: 1 },
      },
      { id: 'foreign', url: 'chrome-extension://fixture/copilot-panel.html' },
    ]) {
      assert.equal(await send(f.background, message, from), null, command);
      assert.equal(f.calls.length, 0);
    }
    const reply = await send(f.background, message, sender('copilot-panel.html'));
    assert.ok(reply?.result, command);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], command);
  }
});

test('popup keeps its direct open gesture but an onboarding receipt never turns collaboration on', async () => {
  const [popupHtml, popupSource] = await Promise.all(
      ['popup.html', 'popup.mjs'].map((name) => readFile(new URL(name, root), 'utf8')),
    ),
    dom = new JSDOM(popupHtml, {
      url: 'chrome-extension://fixture/popup.html',
      runScripts: 'outside-only',
    }),
    calls = [],
    dispose = dom.window.close.bind(dom.window);
  let closed = 0;
  dom.window.close = () => {
    closed++;
  };
  dom.window.setInterval = () => 1;
  dom.window.renderStatus = renderStatus;
  dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      getManifest: () => ({ version: '2.2.0' }),
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => {
        calls.push(message);
        return {
          result:
            message.type === 'popup_status'
              ? { connected: true, copilot: { enabled: false } }
              : message.type === 'copilot.open'
                ? { opened: true }
                : { enabled: false, onboarding_required: true },
        };
      },
    },
  };
  try {
    dom.window.eval(popupSource.replace(/^import\s[^;]*;\n/gm, ''));
    await flush();
    dom.window.document.getElementById('copilot-toggle').click();
    assert.equal(
      calls.filter((message) => message.type.startsWith('copilot.'))[0].type,
      'copilot.open',
    );
    await flush();
    assert.equal(
      dom.window.document.getElementById('copilot-toggle').getAttribute('aria-checked'),
      'false',
    );
    assert.equal(dom.window.document.getElementById('open-copilot').hidden, true);
    assert.equal(closed, 1, 'the popup yields to the opened onboarding sidebar');
    assert.equal(
      calls.some((message) =>
        ['agent_setup_start', 'agent_select', 'settings', 'execute'].includes(message.command),
      ),
      false,
    );
  } finally {
    dispose();
  }
});

const nativeCards = ['tables', 'collect', 'annotate', 'basket'].map((tool) => ({
  id: `native-${tool}`,
  status: 'pending',
  action: 'native.tool',
  task_type: `native.${tool}`,
  title: tool,
  risk: 'zero',
  local_task: true,
  params: { tool },
}));
test('unconfigured sidebar puts local tools in suggestions and keeps Agent configuration in settings', async () => {
  const f = await mountMain({
    ...state,
    suggestions: [
      ...nativeCards,
      {
        id: 'proactive',
        status: 'pending',
        action: 'workflow.run',
        title: 'PROACTIVE_SENTINEL',
        params: { flow: 'example' },
      },
    ],
  });
  try {
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, false);
    assert.equal(f.doc.getElementById('local-tools'), null);
    assert.equal(f.doc.getElementById('local-agent'), null);
    assert.equal(
      f.doc.getElementById('agent-settings-open'),
      null,
      'inactive settings controls are unmounted',
    );
    f.doc.getElementById('settings-tab-execution').click();
    assert.ok(f.doc.getElementById('agent-settings-open'));
    assert.doesNotMatch(f.doc.getElementById('pending').textContent, /PROACTIVE_SENTINEL|耗额度/);
    for (const [tool, label] of [
      ['tables', '识别表格'],
      ['collect', '配置采集'],
      ['annotate', '开启或停止标注'],
      ['basket', '打开工作篮'],
    ]) {
      const button = f.doc.querySelector(
        `article[data-id="native-${tool}"] [data-action="execute"]`,
      );
      assert.equal(button.textContent, label);
      assert.equal(button.disabled, false);
      await button.onclick();
    }
    assert.equal(f.doc.getElementById('work-basket').open, true);
    assert.equal(
      f.calls.filter((call) => call.type === 'copilot.local' && call.command === 'recognize_tables')
        .length,
      2,
    );
    assert.ok(
      f.calls.some((call) => call.type === 'copilot.local' && call.command === 'annotate_page'),
    );
    assert.equal(
      f.calls.some((call) =>
        [
          'agent_setup_start',
          'execute',
          'settings',
          'configure',
          'models',
          'workbench_plan',
        ].includes(call.command),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test('table and collection suggestions open confirmation without exporting or collecting pages', async () => {
  const capture = {
    url: 'https://example.test/report',
    tables: [
      {
        id: '0',
        name: 'Report table',
        headers: ['Keyword', 'Volume'],
        rows: [['sample', 10]],
        pagination: { totalPages: 3 },
        incomplete: true,
      },
    ],
  };
  const f = await mountMain({ ...state, suggestions: nativeCards }, catalog(false), (message) => ({
    capture: message.command === 'recognize_tables' ? capture : null,
    jobs: [],
  }));
  try {
    for (const tool of ['tables', 'collect']) {
      await f.doc
        .querySelector(`article[data-id="native-${tool}"] [data-action="execute"]`)
        .onclick();
      assert.equal(f.doc.getElementById('table-export-dialog').open, true);
      assert.match(f.doc.getElementById('table-tools').textContent, /Report table/);
      f.doc.getElementById('table-export-dialog').close();
    }
    const calls = f.calls.filter((call) => call.type === 'copilot.local');
    assert.equal(calls.filter((call) => call.command === 'recognize_tables').length, 2);
    assert.equal(
      calls.some((call) => !['recognize_tables', 'table_state'].includes(call.command)),
      false,
    );
  } finally {
    f.close();
  }
});

test('invalid native card mapping is rejected before any page or model action', async () => {
  const f = await mountMain({
    ...state,
    suggestions: [{ ...nativeCards[0], task_type: 'native.annotate' }],
  });
  try {
    const count = f.calls.length;
    await f.doc.querySelector('article[data-id="native-tables"] [data-action="execute"]').onclick();
    assert.match(f.doc.getElementById('notice').textContent, /已变化/);
    assert.equal(f.calls.length, count);
  } finally {
    f.close();
  }
});

test('manual annotations stay page-scoped and never enable Assist or accept proactive actions', async () => {
  const tab = { id: 17, windowId: 1, url: 'https://example.test/table' },
    calls = [],
    injected = [],
    api = {
      runtime: {
        id: 'fixture',
        getURL: (path) => `chrome-extension://fixture/${path}`,
        sendMessage: async () => ({}),
      },
      tabs: { query: async () => [tab], sendMessage: async () => ({}) },
      storage: { local: { get: async () => ({}) } },
      scripting: { executeScript: async (value) => injected.push(value) },
    },
    background = new CopilotBackground(api, async (name) => {
      calls.push(name);
      return {};
    });
  const panelSender = sender('copilot-panel.html'),
    contentSender = { id: 'fixture', url: tab.url, frameId: 0, tab };
  assert.equal(
    (await send(background, { type: 'copilot.local', command: 'annotate_page' }, panelSender))
      .result.active,
    true,
  );
  assert.equal(injected.length, 1);
  assert.equal(background.enabled, false);
  assert.equal(
    (
      await send(
        background,
        { type: 'copilot.annotation_lookup', params: { objects: [] } },
        contentSender,
      )
    ).result != null,
    true,
  );
  assert.equal(
    await send(
      background,
      { type: 'copilot.observe', page: {}, description: 'open' },
      contentSender,
    ),
    null,
  );
  assert.equal(
    await send(
      background,
      { type: 'copilot.selection', command: 'quick_task', params: {} },
      contentSender,
    ),
    null,
  );
  assert.equal(
    await send(
      background,
      { type: 'copilot.annotation_lookup', params: {} },
      { ...contentSender, url: 'https://example.test/other' },
    ),
    null,
  );
  background.tabEvent(tab.id, '导航到新页面', tab);
  assert.equal(background.localAnnotations.size, 0);
  assert.equal(
    await send(background, { type: 'copilot.annotation_lookup', params: {} }, contentSender),
    null,
  );
  assert.deepEqual(calls, ['annotation_lookup']);
});

function pageContextService() {
  let tab = { id: 17, windowId: 1, url: 'https://example.test/report?q=one', incognito: false },
    focused = true;
  const calls = [],
    pageActions = [],
    api = {
      runtime: {
        id: 'fixture',
        getURL: (path) => `chrome-extension://fixture/${path}`,
        sendMessage: async (message) => pageActions.push(message),
      },
      tabs: {
        query: async () => [tab],
        sendMessage: async (...args) => pageActions.push(args),
      },
      windows: { get: async () => ({ focused }) },
      storage: { local: { get: async () => ({}) } },
    },
    background = new CopilotBackground(
      api,
      async (name, params) => {
        calls.push([name, params]);
        return name === 'state' ? { enabled: false, suggestions: [] } : { accepted: true };
      },
      (id) => id === 99,
    );
  return {
    background,
    calls,
    pageActions,
    setTab(next) {
      tab = next;
    },
    setFocused(next) {
      focused = next;
    },
    read() {
      return send(
        background,
        { type: 'copilot.command', command: 'state' },
        sender('copilot-panel.html'),
      );
    },
  };
}

test('sidebar state synchronizes only focused URL metadata before listing tools while Assist is off', async () => {
  const f = pageContextService();
  assert.equal(f.background.enabled, false);
  assert.ok((await f.read()).result);
  assert.deepEqual(f.calls, [
    ['page_context', { url: 'https://example.test/report?q=one', incognito: false, tab_id: 17 }],
    ['state', {}],
  ]);
  assert.deepEqual(f.pageActions, [], 'no capture, content injection, observe or model action');
});

test('sidebar state clears previous page metadata on restricted or owned work pages', async () => {
  const f = pageContextService();
  await f.read();
  for (const tab of [
    { id: 17, windowId: 1, url: 'edge://extensions' },
    { id: 99, windowId: 1, url: 'https://example.test/private-work' },
    { id: 17, windowId: 1, url: 'file:///tmp/report.html' },
  ]) {
    f.setTab(tab);
    f.calls.length = 0;
    assert.ok((await f.read()).result);
    assert.deepEqual(f.calls, [
      ['page_context', { url: '', incognito: false }],
      ['state', {}],
    ]);
  }
  assert.deepEqual(f.pageActions, []);
});

test('open sidebar refreshes metadata on active navigation without letting background or unfocused events clear it', async () => {
  const f = pageContextService();
  f.background.panelPorts.add({});
  f.setTab({ id: 17, windowId: 1, url: 'edge://extensions' });
  f.background.tabEvent(17, '切换标签页', { url: 'edge://extensions' });
  await f.background.queue;
  assert.deepEqual(f.calls, [['page_context', { url: '', incognito: false }]]);
  f.calls.length = 0;
  f.background.tabEvent(88, '导航到新页面', { url: 'edge://extensions' });
  await f.background.queue;
  assert.deepEqual(f.calls, []);
  f.setFocused(false);
  f.background.tabEvent(17, '页面加载完成', { url: 'edge://extensions' });
  await f.background.queue;
  assert.deepEqual(f.calls, []);
  await f.read();
  assert.deepEqual(
    f.calls,
    [['state', {}]],
    'reading from an unfocused browser preserves the last real page',
  );
  assert.equal(
    f.calls.some(([name]) => ['observe', 'settings', 'execute'].includes(name)),
    false,
  );
});
