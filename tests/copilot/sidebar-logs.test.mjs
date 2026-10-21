import { icon } from '../../native-extension/ui-design.mjs';
import { BasketPanel } from '../../native-extension/copilot-basket.mjs';
import {
  mountControls,
  boardName,
  renderConnection,
} from '../../native-extension/copilot-controls.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  SettingsForm,
  presetValues,
  readSettings,
} from '../../native-extension/copilot-settings.mjs';
import { PanelViews, renderDashboard } from '../../native-extension/copilot-view.mjs';
import { LogPanel } from '../../native-extension/copilot-logs.mjs';
import { PacksPanel } from '../../native-extension/copilot-packs-panel.mjs';
import { TaskLogPanel } from '../../native-extension/copilot-task-logs.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import { localize } from '../../native-extension/copilot-i18n.mjs';
const html = await readFile(
    new URL('../../native-extension/copilot-panel.html', import.meta.url),
    'utf8',
  ),
  flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  };
function fixture() {
  const dom = new JSDOM(html, {
    url: 'chrome-extension://fixture/copilot-panel.html',
    runScripts: 'outside-only',
  });
  return {
    dom,
    doc: dom.window.document,
    close() {
      dom.window.close();
    },
  };
}
const directoryDefaults = { export_dir: '/synthetic/export', logs_dir: '/synthetic/copilot/logs' };
const initial = {
  agent: { id: 'hermes', name: 'Hermes', state: 'connected' },
  locale: 'zh',
  enabled: false,
  settings_saved: false,
  config: { ...presetValues('balanced'), exec_transport: 'acp' },
  suggestions: [],
};
const row = (id, type = 'capture', error = false) => ({
  id,
  time: 1792224000 + id,
  type,
  event: 'capture',
  error,
  summary: '合成日志 ' + id,
  summary_en: 'Synthetic event ' + id,
  details: { snapshot_bytes: id, tokens: id },
});
test('main work surface contains only work, compact usage and navigation; settings are inert and advanced is collapsed', () => {
  const f = fixture();
  try {
    const work = f.doc.getElementById('work-view');
    assert.equal(
      work.querySelector(
        'form:not(#work-form),input[type=number],select[id^=setting-],#local-capabilities',
      ),
      null,
    );
    assert.equal(
      f.doc.querySelector(
        '#preflight,#refresh,#start-copilot,#save-copilot-settings,#budget,#setting-daily_token_budget',
      ),
      null,
    );
    assert.equal(work.querySelector('h1'), null);
    assert.ok(work.querySelector('#open-logs'));
    assert.ok(work.querySelector('#open-settings'));
    assert.equal(f.doc.getElementById('advanced-settings').open, false);
    assert.equal(f.doc.getElementById('settings-view').getAttribute('aria-hidden'), 'true');
    assert.ok(f.doc.getElementById('settings-view').hasAttribute('inert'));
    assert.deepEqual(
      [...f.doc.querySelectorAll('#copilot-settings-form>fieldset>legend')].map((el) =>
        el.textContent.trim(),
      ),
      ['执行模式', '界面', '协作 Agent', '表格与导出', '记忆', '关于'],
    );
    assert.match(f.doc.getElementById('codex-inference-cost').textContent, /10\.6K/);
    assert.equal(work.contains(f.doc.getElementById('codex-inference-cost')), false);
  } finally {
    f.close();
  }
});
test('views open, return and Escape restore keyboard focus without leaving the sidebar', () => {
  const f = fixture(),
    shown = [];
  try {
    const views = new PanelViews(f.doc, (name) => shown.push(name));
    views.show('settings');
    assert.equal(f.doc.getElementById('work-view').hidden, true);
    assert.equal(f.doc.getElementById('settings-view').getAttribute('aria-hidden'), 'false');
    assert.equal(f.doc.getElementById('settings-view').hasAttribute('inert'), false);
    f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(views.current, 'work');
    assert.equal(f.doc.activeElement.id, 'open-settings');
    views.show('logs');
    views.show('work');
    assert.equal(views.current, 'work');
    assert.equal(f.doc.getElementById('logs-view').hidden, false);
    assert.deepEqual(shown, ['settings', 'work', 'logs', 'logs', 'work']);
  } finally {
    f.close();
  }
});
test('changes auto-save per field and acknowledge; ordinary enabling never overwrites saved configuration', async () => {
  const f = fixture(),
    calls = [];
  let state = { ...structuredClone(initial), settings_saved: true };
  const settings = new SettingsForm(f.doc, async (name, params) => {
    calls.push({ name, params });
    if (name === 'preferences') state = { ...state, ...params };
    if (name === 'configure') state = { ...state, config: { ...state.config, ...params } };
    if (name === 'settings') state = { ...state, ...params };
    return state;
  });
  try {
    settings.update(state);
    const field = f.doc.getElementById('setting-max_parallel');
    field.value = '1';
    field.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    await settings.queue;
    assert.equal(calls[0].name, 'configure');
    assert.equal(calls[0].params.max_parallel, 1);
    assert.equal(calls[0].params.mode, 'custom');
    assert.equal(f.doc.querySelector('[data-feedback=max_parallel]').textContent, '✓');
    calls.length = 0;
    await settings.enable();
    assert.deepEqual(
      calls.map((call) => call.name),
      ['settings'],
    );
    assert.equal(f.doc.getElementById('balanced-notice').hidden, true);
  } finally {
    settings.dispose();
    f.close();
  }
});
test('first enable saves balanced defaults and shows a dismissible notice without a preflight step', async () => {
  const f = fixture(),
    calls = [];
  let state = structuredClone(initial);
  const settings = new SettingsForm(f.doc, async (name, params) => {
    calls.push({ name, params });
    if (name === 'directory_defaults') return directoryDefaults;
    if (name === 'models') return {};
    if (name === 'preferences') state = { ...state, ...params };
    if (name === 'configure')
      state = { ...state, config: { ...state.config, ...params }, settings_saved: true };
    if (name === 'settings') state = { ...state, ...params };
    return state;
  });
  try {
    settings.update(state);
    await settings.enable();
    assert.deepEqual(
      calls.map((call) => call.name),
      ['directory_defaults', 'models', 'configure', 'settings'],
    );
    assert.equal(calls[2].params.mode, 'balanced');
    assert.equal(f.doc.getElementById('balanced-notice').hidden, false);
    assert.equal('daily_token_budget' in calls[2].params, false);
    assert.equal(f.doc.querySelector('#copilot-settings-form button[type=submit]'), null);
  } finally {
    settings.dispose();
    f.close();
  }
});
test('config arriving during a save cannot overwrite a newer edit; catalog refresh preserves current manual input', async () => {
  const f = fixture();
  let resolve, catalog;
  const held = new Promise((done) => {
      resolve = done;
    }),
    models = new Promise((done) => {
      catalog = done;
    });
  let state = { ...structuredClone(initial), settings_saved: true };
  const settings = new SettingsForm(f.doc, async (name, params) => {
    if (name === 'directory_defaults') return directoryDefaults;
    if (name === 'models') return models;
    await held;
    return { ...state, config: { ...state.config, ...params } };
  });
  try {
    settings.update(state);
    const field = f.doc.getElementById('setting-exec_model'),
      manual = f.doc.getElementById('exec_model-manual');
    field.value = 'manual';
    manual.value = 'vendor:first';
    manual.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const saving = settings.saveField('exec_model');
    manual.value = 'vendor:second';
    manual.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    resolve();
    await saving;
    assert.equal(readSettings(f.doc).exec_model, 'vendor:second');
    const loading = settings.load();
    manual.value = 'vendor:third';
    catalog({});
    await loading;
    assert.equal(readSettings(f.doc).exec_model, 'vendor:third');
  } finally {
    settings.dispose();
    f.close();
  }
});
test('usage is informational even for huge totals and models remain separated', () => {
  const f = fixture();
  try {
    renderDashboard(
      f.doc,
      {
        ...initial,
        enabled: true,
        ready: true,
        daily_usage: { input: 10 ** 9, cache_read: 10 ** 9, output: 10 ** 9 },
        usage: { input: 3400 },
        daily_model_usage: { 'example:model': { input: 7, cache_read: 8, output: 9 } },
      },
      { command: async () => {} },
    );
    assert.equal(f.doc.getElementById('status'), null);
    assert.equal(f.doc.getElementById('work-status').textContent, 'Hermes · 协作中');
    assert.match(f.doc.getElementById('usage-label').textContent, /300,000 万 tokens/);
    assert.match(f.doc.getElementById('session-usage').textContent, /3,400/);
    assert.match(f.doc.getElementById('model-usage').textContent, /example:model/);
    assert.equal(f.doc.getElementById('error').hidden, true);
  } finally {
    f.close();
  }
});
function logFixture(options = {}) {
  const f = fixture(),
    calls = [];
  const logs = new LogPanel(
    f.doc,
    async (name) => {
      calls.push(name);
      if (name === 'logs_clear') return { entries: [], revision: 9999 };
      return { jsonl: '{"fixture":true}\n', count: 1, entries: [], revision: 0 };
    },
    {
      clipboard: { writeText: async (value) => calls.push(value) },
      download: async (value) => calls.push(value),
      ...options,
    },
  );
  logs.active = true;
  return {
    ...f,
    logs,
    calls,
    close() {
      logs.dispose();
      f.close();
    },
  };
}
test('log virtualization caps 2000 records and renders only viewport rows; type, error and search filters compose', () => {
  const f = logFixture();
  try {
    f.logs.set({
      entries: Array.from({ length: 2500 }, (_, i) =>
        row(i, i % 2 ? 'system' : 'capture', i % 3 === 0),
      ),
      revision: 2500,
    });
    assert.equal(f.logs.entries.length, 2000);
    assert.ok(f.doc.querySelectorAll('.log-line').length <= 16);
    f.doc.getElementById('log-filter').value = 'errors';
    f.doc.getElementById('log-filter').onchange();
    assert.ok(f.logs.filtered().every((item) => item.error));
    f.doc.getElementById('log-filter').value = 'capture';
    f.doc.getElementById('log-search').value = '合成日志 2200';
    f.doc.getElementById('log-search').oninput();
    assert.equal(f.logs.filtered().length, 1);
    assert.equal(f.doc.querySelector('.log-line').dataset.id, '2200');
  } finally {
    f.close();
  }
});
test('manual scrolling pauses following, latest resumes, details are lazy and clear removes stale JSON', async () => {
  const f = logFixture();
  try {
    Object.defineProperties(f.logs.viewport, {
      clientHeight: { value: 96 },
      scrollHeight: { value: 480 },
    });
    f.logs.set({ entries: Array.from({ length: 10 }, (_, i) => row(i)), revision: 10 });
    f.logs.latest();
    f.logs.viewport.scrollTop = 100;
    f.logs.viewport.dispatchEvent(new f.dom.window.Event('scroll'));
    assert.equal(f.logs.follow, false);
    f.logs.append({ entries: [row(11)], revision: 11 });
    assert.equal(f.logs.viewport.scrollTop, 100);
    assert.equal(f.doc.getElementById('log-latest').hidden, false);
    f.doc.querySelector('.log-line').click();
    assert.equal(f.doc.getElementById('log-detail').open, true);
    assert.equal(
      f.doc.getElementById('log-detail').querySelector('pre').closest('details').open,
      false,
    );
    f.doc.getElementById('log-latest').click();
    assert.equal(f.logs.follow, true);
    await f.doc.getElementById('log-clear').onclick();
    assert.equal(f.logs.entries.length, 0);
    assert.equal(f.doc.getElementById('log-detail').hidden, true);
    assert.equal(f.doc.querySelector('#log-detail pre').textContent, '');
  } finally {
    f.close();
  }
});
test('copy/export request real JSONL receipts; stale batches after clear never restore removed rows', async () => {
  const f = logFixture();
  try {
    await f.doc.getElementById('log-copy').onclick();
    await f.doc.getElementById('log-export').onclick();
    assert.deepEqual(f.calls, [
      'logs_export',
      '{"fixture":true}\n',
      'logs_export',
      '{"fixture":true}\n',
    ]);
    f.logs.set({ entries: [], revision: 100 });
    f.logs.append({ entries: [row(90)], revision: 99 });
    assert.equal(f.logs.entries.length, 0);
    f.logs.append({ entries: [row(101)], revision: 101 });
    assert.equal(f.logs.entries.length, 1);
    f.logs.active = false;
    const before = f.doc.querySelectorAll('.log-line').length;
    f.logs.append({ entries: [row(102)], revision: 102 });
    assert.equal(f.doc.querySelectorAll('.log-line').length, before);
  } finally {
    f.close();
  }
});
test('log notifications bypass dashboard and tab broadcasts; untrusted pages cannot read or clear logs', async () => {
  const messages = [];
  let queried = 0;
  const api = {
    runtime: {
      id: 'fixture',
      getURL: (path) => 'chrome-extension://fixture/' + path,
      sendMessage: async (message) => messages.push(message),
    },
    tabs: {
      query: async () => {
        queried++;
        return [];
      },
    },
  };
  const service = new CopilotBackground(api, async () => ({ entries: [], revision: 1 }));
  await service.notification({ type: 'logs', revision: 4, entries: [row(1)] });
  assert.equal(messages[0].type, 'copilot.logs');
  assert.equal(queried, 0);
  for (const command of ['logs_read', 'logs_clear', 'logs_export'])
    assert.equal(
      service.handle(
        { type: 'copilot.command', command },
        { id: 'fixture', url: 'https://example.test/', frameId: 0, tab: { id: 1 } },
        () => assert.fail('untrusted log request'),
      ),
      false,
    );
});
test('new settings and log labels localize without translating structured log content', () => {
  const f = fixture();
  try {
    localize(f.doc, 'en-US');
    assert.equal(f.doc.getElementById('open-settings').textContent, 'Settings');
    assert.equal(f.doc.getElementById('log-pause').textContent, 'Pause scroll');
    const logs = new LogPanel(f.doc, async () => ({}), { language: 'en-US' });
    logs.active = true;
    logs.set({ entries: [row(1)], revision: 1 });
    assert.match(f.doc.querySelector('.log-summary').textContent, /Synthetic/);
    logs.dispose();
  } finally {
    f.close();
  }
});

test('actual sidebar entrypoint starts balanced only on explicit enable and consumes log batches without state fetches', async () => {
  const f = fixture(),
    listeners = [],
    calls = [];
  let state = {
      ...structuredClone(initial),
      suggestions: [
        ...(initial.suggestions || []),
        {
          id: 'saved-trend',
          title: '已有趋势',
          status: 'completed',
          action: 'seo.trends',
          params: {},
          result: {
            verdict: '合成趋势',
            series: [
              {
                keyword: 'sample',
                region: 'US',
                period: '12m',
                points: [
                  { date: '2026-01', value: 25 },
                  { date: '2026-02', value: 35 },
                ],
              },
            ],
          },
        },
      ],
    },
    entries = [row(1)],
    logRevision = 100;
  Object.defineProperty(f.dom.window.navigator, 'clipboard', {
    value: { writeText: async () => {} },
  });
  f.dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      connect: () => ({}),
      onMessage: { addListener: (handler) => listeners.push(handler) },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'copilot.local') return { result: { capture: null, jobs: [] } };
        if (message.type === 'copilot.reconnect') return { result: state };
        const name = message.command,
          params = message.params || {};
        if (name === 'agent_catalog')
          return {
            result: {
              default_agent: 'hermes',
              onboarding_required: false,
              agents: [
                {
                  id: 'hermes',
                  name: 'Hermes',
                  installed: true,
                  configured: true,
                  status: 'configured',
                },
              ],
            },
          };
        if (name === 'directory_defaults') return { result: directoryDefaults };
        if (name === 'models')
          return { result: { inference: { available: [] }, execution: { available: [] } } };
        if (name === 'preferences') state = { ...state, ...params };
        if (name === 'configure')
          state = { ...state, settings_saved: true, config: { ...state.config, ...params } };
        if (name === 'settings') state = { ...state, ...params, ready: true };
        if (name === 'logs_read') return { result: { entries, revision: logRevision } };
        if (name === 'log_client') return { result: { accepted: true } };
        if (name === 'capability_state')
          return { result: { capabilities: {}, tools: [], candidates: [] } };
        return { result: state };
      },
    },
    downloads: { download: async () => 1 },
  };
  f.dom.window.setInterval = () => 1;
  const entrypoint = new URL('../../native-extension/copilot-panel.mjs', import.meta.url),
    originalSource = await readFile(entrypoint, 'utf8'),
    source = originalSource.replace(/^import\s[^;]*;\n/gm, '');
  const { renderReadiness, renderChains } = await import(
    '../../native-extension/copilot-readiness.mjs'
  );
  const { CapabilitiesPanel } = await import(
      '../../native-extension/copilot-capabilities-panel.mjs'
    ),
    { TablePanel } = await import('../../native-extension/copilot-table-panel.mjs');
  const modules = await Promise.all(
    [...originalSource.matchAll(/^import .*? from ['"]([^'"]+)['"];?$/gm)].map(
      ([, path]) => import(new URL(path, entrypoint)),
    ),
  );
  Object.assign(f.dom.window, ...modules, {
    icon,
    BasketPanel,
    renderReadiness,
    renderChains,
    mountControls,
    boardName,
    renderConnection,
    CapabilitiesPanel,
    PacksPanel,
    TablePanel,
    SettingsForm,
    renderDashboard,
    PanelViews,
    LogPanel,
    TaskLogPanel,
    localize,
  });
  try {
    f.dom.window.eval(source);
    await flush();
    assert.equal(
      calls.some((message) => message.command === 'configure'),
      false,
    );
    assert.equal(
      calls.some((message) => message.command === 'models'),
      false,
    );
    assert.match(
      f.doc.querySelector('#results [data-id="saved-trend"]').textContent,
      /已有趋势/,
      'saved trend card renders while inactive settings stay unmounted',
    );
    const name = f.doc.getElementById('board-name-input');
    name.value = 'My Agent';
    name.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    assert.notEqual(f.doc.title, 'My Agent', 'draft does not save on input');
    await f.doc.getElementById('settings-save').onclick();
    await flush();
    assert.equal(f.doc.title, 'My Agent');
    assert.equal(f.doc.getElementById('board-name').textContent, 'My Agent');
    const toggle = f.doc.getElementById('enabled');
    toggle.checked = true;
    await toggle.onchange({ target: toggle });
    await flush();
    assert.deepEqual(
      calls
        .filter((message) => ['configure', 'settings'].includes(message.command))
        .map((message) => message.command),
      ['configure', 'settings'],
    );
    assert.equal(f.doc.getElementById('balanced-notice').hidden, false);
    f.doc.getElementById('dismiss-balanced').click();
    assert.equal(f.doc.getElementById('balanced-notice').hidden, true);
    f.doc.getElementById('open-logs').click();
    await flush();
    assert.equal(f.doc.querySelectorAll('.log-line').length, 1);
    const before = calls.filter((message) => message.command === 'state').length;
    entries = [...entries, row(2)];
    logRevision = 101;
    for (const handler of listeners)
      handler({
        type: 'copilot.logs',
        event: { type: 'logs', revision: 2, log_revision: 101, entries: [row(2)] },
      });
    await flush();
    assert.equal(f.doc.querySelectorAll('.log-line').length, 2);
    assert.equal(calls.filter((message) => message.command === 'state').length, before);
    for (const handler of listeners) handler({ type: 'copilot.connection', connected: false });
    await flush();
    assert.equal(f.doc.getElementById('status'), null);
    assert.equal(f.doc.getElementById('work-context').dataset.activity, 'error');
    assert.equal(toggle.disabled, true);
    for (const handler of listeners) handler({ type: 'copilot.connection', connected: true });
    await flush();
    assert.ok(
      calls.some(
        (message) => message.command === 'log_client' && message.params.event === 'disconnected',
      ),
    );
    assert.ok(
      calls.some(
        (message) => message.command === 'log_client' && message.params.event === 'reconnected',
      ),
    );
    f.doc.querySelector('[data-tab=pending]').click();
    assert.equal(f.doc.getElementById('work-view').hidden, false);
  } finally {
    f.dom.window.dispatchEvent(new f.dom.window.Event('unload'));
    f.close();
  }
});
test('only an extension panel can request transport reconnect; connection authorization guard is unchanged', async () => {
  let reconnects = 0;
  const api = {
      runtime: { id: 'fixture', getURL: (path) => 'chrome-extension://fixture/' + path },
    },
    service = new CopilotBackground(
      api,
      async () => ({ enabled: false }),
      () => false,
      async () => {
        reconnects++;
      },
    );
  for (const sender of [
    { id: 'fixture', url: 'https://example.test/', tab: { id: 1 }, frameId: 0 },
    { id: 'foreign', url: 'chrome-extension://fixture/copilot-panel.html' },
  ])
    assert.equal(
      service.handle({ type: 'copilot.reconnect' }, sender, () =>
        assert.fail('untrusted reconnect'),
      ),
      false,
    );
  const response = await new Promise((done) =>
    service.handle(
      { type: 'copilot.reconnect' },
      { id: 'fixture', url: 'chrome-extension://fixture/copilot-panel.html' },
      done,
    ),
  );
  assert.equal(response.result.enabled, false);
  assert.equal(reconnects, 1);
});

test('failed immediate save exposes an explicit keyboard-accessible retry without an automatic replay', async () => {
  const f = fixture();
  let calls = 0,
    state = { ...structuredClone(initial), settings_saved: true };
  const settings = new SettingsForm(f.doc, async (name, params) => {
    calls++;
    if (calls === 1) throw Error('synthetic write failure');
    return (state = { ...state, config: { ...state.config, ...params } });
  });
  try {
    settings.update(state);
    f.doc.getElementById('setting-max_parallel').value = '1';
    await settings.saveField('max_parallel');
    assert.equal(calls, 1);
    const retry = f.doc.querySelector('[data-feedback=max_parallel]');
    assert.equal(retry.getAttribute('role'), 'button');
    assert.equal(retry.tabIndex, 0);
    await retry.onclick();
    assert.equal(calls, 2);
    assert.equal(retry.textContent, '✓');
    assert.equal(retry.getAttribute('role'), null);
  } finally {
    settings.dispose();
    f.close();
  }
});

test('interface save failure retries the requested value even after an old state refresh', async () => {
  const f = fixture();
  let calls = 0;
  const sent = [];
  const settings = new SettingsForm(f.doc, async (name, params) => {
    sent.push(params);
    if (++calls === 1) throw Error('synthetic failure');
    return { ...initial, ...params };
  });
  try {
    settings.update(initial);
    await settings.saveInterface('show_ball', false);
    settings.update({ ...initial, show_ball: true });
    const retry = f.doc.querySelector('[data-feedback=show_ball]');
    assert.equal(retry.getAttribute('role'), 'button');
    await retry.onclick();
    assert.deepEqual(sent, [{ show_ball: false }, { show_ball: false }]);
    assert.equal(f.doc.getElementById('ball').checked, false);
    assert.equal(f.doc.getElementById('ball').disabled, false);
  } finally {
    settings.dispose();
    f.close();
  }
});
