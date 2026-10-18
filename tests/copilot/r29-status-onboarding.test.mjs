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
async function mountMain(initial = state, available = catalog(false)) {
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
        if (message.type === 'copilot.local') return { result: { capture: null, jobs: [] } };
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
    assert.equal(f.doc.getElementById('agent-setup-dialog').open, true);
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
  const [popupHtml, popupSource, cloudSource] = await Promise.all(
      ['popup.html', 'popup.mjs', 'cloud-popup.mjs'].map((name) =>
        readFile(new URL(name, root), 'utf8'),
      ),
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
    dom.window.eval(cloudSource.replace(/^import\s[^;]*;\n/gm, ''));
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
