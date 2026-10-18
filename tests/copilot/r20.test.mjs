import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { Bridge } from '../../native-extension/bridge.mjs';
import { createAutomationOverlay } from '../../native-extension/automation-overlay.mjs';
import {
  refreshOverlaySteps,
  updateWorkflowActivity,
} from '../../native-extension/overlay-logs.mjs';
import { taskTableAdapter, TableJobs } from '../../native-extension/copilot-table-job.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';

const python = (...args) => {
  const result = spawnSync('python3', ['-B', 'tests/copilot/test_r20.py', ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
function overlay() {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test/' });
  let shadow;
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    shadow = attach.call(this, options);
    return shadow;
  };
  const instance = createAutomationOverlay({
    document: dom.window.document,
    taskId: 'fixture',
    generation: 1,
    tabId: 7,
    origin: 'https://example.test',
    onStop: async () => ({ state: 'stopped' }),
    onTakeover: async () => ({ state: 'paused' }),
    onResume: async () => ({ state: 'running' }),
  });
  return {
    instance,
    shadow,
    close() {
      instance.remove();
      dom.window.close();
    },
  };
}
test('R20b first inference with zero suggestions survives notification handling and state readback', async () => {
  const messages = python('--inference-fixture'),
    pending = [],
    errors = [],
    sent = [],
    broadcasts = [];
  let receive;
  const api = {
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}) },
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.test/' }],
      sendMessage: async (_id, message) => broadcasts.push(message),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      executeScript: async () => [],
    },
    runtime: { sendMessage: async (message) => broadcasts.push(message) },
  };
  const copilot = new CopilotBackground(api, async () => ({}));
  const bridge = new Bridge(
    {
      onMessage: { addListener: (fn) => (receive = fn) },
      postMessage: (message) => sent.push(message),
      disconnect: () => assert.fail('notification closed native port'),
    },
    {},
    () => {},
    {
      onCopilot: (event) =>
        pending.push(copilot.notification(event).catch((error) => errors.push(error.name))),
    },
  );
  try {
    for (const message of messages) {
      assert.ok(new TextEncoder().encode(JSON.stringify(message)).length <= 512 * 1024);
      if (message.method) receive(message);
      else {
        const request = bridge.request('extension.copilot.state');
        receive({ ...message, id: sent.at(-1).id });
        assert.equal((await request).enabled, true);
      }
    }
    await Promise.all(pending);
    assert.deepEqual(errors, []);
    assert.equal(copilot.enabled, true);
    assert.equal(copilot.rows.size, 0);
    assert.equal(bridge.closed, false);
    assert.ok(
      broadcasts.some(
        (message) =>
          message.type === 'copilot.changed' &&
          message.event.type === 'inference' &&
          message.event.succeeded,
      ),
    );
    assert.equal(copilot.sessionRetry.attempts, 0);
  } finally {
    bridge.close();
  }
});
test('R20b notification rejection cannot explicitly disconnect the Native port or poison the next state reply', async () => {
  let receive;
  const sent = [],
    errors = [];
  const copilot = new CopilotBackground(
    {
      tabs: {
        query: async () => {
          throw new Error('synthetic API rejection');
        },
      },
      runtime: { sendMessage: async () => {} },
    },
    async () => ({}),
  );
  const bridge = new Bridge(
    {
      onMessage: { addListener: (fn) => (receive = fn) },
      postMessage: (message) => sent.push(message),
      disconnect: () => assert.fail('notification closed native port'),
    },
    {},
    () => {},
    { onCopilot: (event) => copilot.notification(event).catch((error) => errors.push(error.name)) },
  );
  try {
    receive({
      method: 'copilot.changed',
      params: { type: 'inference', running: false, succeeded: true },
    });
    receive({ method: 'copilot.changed', params: { type: 'add' } });
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(errors.sort(), ['Error', 'TypeError']);
    assert.equal(bridge.closed, false);
    const request = bridge.request('extension.copilot.state');
    receive({ id: sent.at(-1).id, result: { enabled: true, ready: true, suggestions: [] } });
    assert.equal((await request).ready, true);
  } finally {
    bridge.close();
  }
});
test('daemon browser dispatch → extension log read → actual automation overlay renders action, target and duration', async () => {
  const rows = python('--fixture'),
    h = overlay();
  try {
    assert.equal(h.shadow.querySelector('[data-role=log-empty]').textContent, '等待第一步…');
    const task = { id: 'fixture', generation: 1, overlays: new Map([[7, {}]]) };
    let scope;
    const current = {
      request: async (method, params) => {
        scope = { method, ...params };
        return rows;
      },
    };
    const executor = {
      tasks: new Map([['fixture', task]]),
      overlayCall: async (_tab, _entry, op, { steps }) => {
        assert.equal(op, 'log');
        h.instance.setRecentSteps(steps);
      },
    };
    await refreshOverlaySteps(current, executor, () => current);
    assert.equal(scope.limit, 100);
    assert.equal(h.shadow.querySelector('[data-role=log-empty]').hidden, true);
    const items = h.shadow.querySelectorAll('[data-role=recent-list]>li');
    assert.equal(items.length, 4);
    assert.match(items[0].textContent, /打开/);
    assert.match(items[1].textContent, /扫描/);
    assert.match(items[2].textContent, /点击.*Next/);
    assert.match(items[3].textContent, /扫描/);
    for (const item of items) {
      assert.equal(item.dataset.result, 'succeeded');
      assert.match(item.querySelector('[data-role=step-time]').textContent, /s$/);
    }
    assert.equal(h.shadow.querySelector('[data-role=recent]').open, true);
    assert.ok(h.shadow.querySelector('[data-role=copy-log]'));
    const prior = items.length;
    await refreshOverlaySteps(
      current,
      { ...executor, overlayCall: () => assert.fail('stale log delivered') },
      () => null,
    );
    assert.equal(h.shadow.querySelectorAll('[data-role=recent-list]>li').length, prior);
  } finally {
    h.close();
  }
});
test('real Bridge reassembles paginated Unicode pushes and responses; unknown events never close the port', async () => {
  let receive;
  const sent = [],
    events = [];
  const bridge = new Bridge(
    {
      onMessage: {
        addListener: (fn) => {
          receive = fn;
        },
      },
      postMessage: (m) => sent.push(m),
    },
    {},
    () => {},
    { onCopilot: (event) => events.push(event) },
  );
  try {
    const event = {
      method: 'copilot.changed',
      params: { type: 'logs', entries: [{ summary: '合成'.repeat(200000) }] },
    };
    const text = JSON.stringify(event),
      parts = [];
    for (let start = 0; start < text.length; start += 48000)
      parts.push(text.slice(start, start + 48000));
    for (const [index, part] of parts.entries()) {
      const frame = {
        method: 'bridge.chunk',
        params: {
          id: 'fixture',
          index,
          total: parts.length,
          bytes: new TextEncoder().encode(text).length,
          text: part,
        },
      };
      assert.ok(new TextEncoder().encode(JSON.stringify(frame)).length < 512 * 1024);
      receive(frame);
    }
    assert.deepEqual(events, [event.params]);
    for (const frame of python('--emoji-frames')) receive(frame);
    assert.equal(events[1].text, '😀'.repeat(150000));
    for (const type of [
      'settings',
      'ready',
      'basket',
      'capabilities',
      'tool_context',
      'progress',
      'update',
      'usage',
      'unknown_future',
    ])
      receive({ method: 'copilot.changed', params: { type, revision: 1 } });
    const request = bridge.request('extension.copilot.state');
    receive({ id: sent[0].id, result: { ready: true } });
    assert.deepEqual(await request, { ready: true });
    assert.equal(bridge.closed, false);
    receive({
      method: 'bridge.chunk',
      params: { id: 'invalid', index: 0, total: 2, bytes: 10, text: 'x' },
    });
    bridge.close();
    assert.equal(bridge.chunk, null);
  } finally {
    bridge.close();
  }
});
test('collector and multi-page TableJobs emit steps at their real browser calls', async () => {
  const reports = [],
    tasks = new Map();
  let task,
    page = 1,
    plan = {},
    unknown = false;
  const table = () => ({
    id: 't',
    dom_id: 'table',
    dom_path: 'table',
    name: 'synthetic',
    headers: ['Name'],
    rows: [[{ text: 'row ' + page }]],
    pagination: { kind: 'url', key: 'page', offsetStep: 1, totalPages: 2, current: page },
  });
  const api = {
    tabs: {
      get: async () => ({
        id: 7,
        active: false,
        status: 'complete',
        windowId: 2,
        groupId: 3,
        url: `https://example.test/?page=${page}`,
      }),
    },
    windows: { get: async () => ({ focused: false }) },
    scripting: {
      executeScript: async ({ func, args }) => [
        {
          result:
            func.name === 'captureTables'
              ? { url: `https://example.test/?page=${page}`, tables: [table()] }
              : func.name === 'advanceTable'
                ? args?.[0]?.inspect
                  ? plan
                  : {}
                : { ready: true },
        },
      ],
    },
  };
  const current = {
    request: async (method, params) => {
      if (method === 'extension.copilot.work_create') return { id: 'fixture' };
      if (method === 'extension.task_step') {
        reports.push(params);
        return { accepted: true };
      }
      return {};
    },
  };
  const executor = {
    tasks,
    leases: new Map([[7, 'fixture']]),
    perform: async (_task, params) => {
      if (params.action === 'navigate') page = Number(new URL(params.url).searchParams.get('page'));
      if (params.action === 'semantic_snapshot')
        return { items: [{ name: 'Next', ref: 'next' }], snapshotId: 's', binding: {} };
      if (params.action === 'ref_click')
        return { outcomeUnknown: unknown, effect: unknown ? 'unverified' : 'observed' };
      return { tabId: 7 };
    },
    release: async () => ({ state: 'closed' }),
  };
  const adapter = taskTableAdapter(api, executor, () => current, {
    synchronize: async () => {
      task = {
        id: 'fixture',
        generation: 1,
        silent: true,
        policy: { modeGeneration: 2 },
        agentTabs: new Set([7]),
      };
      tasks.set('fixture', task);
    },
  });
  const jobs = new TableJobs({
    ...adapter,
    upload: async (value) => ({
      ...value,
      files: [{ id: 'fixture-file', path: '/synthetic/table.xlsx' }],
    }),
    progress: () => {},
    delay: async () => {},
    random: () => 0,
  });
  const result = await jobs.run(
    'job',
    { url: 'https://example.test/?page=1', incognito: false },
    table(),
    { max_pages: 2 },
    true,
    2,
  );
  assert.equal(result.pages, 2);
  assert.ok(reports.some((row) => row.action === 'new_tab'));
  assert.ok(reports.some((row) => row.action === 'table.read'));
  assert.ok(reports.some((row) => row.action === 'navigate'));
  for (const row of reports.filter((row) => row.phase === 'start')) {
    const end = reports.find((item) => item.stepId === row.stepId && item.phase === 'succeeded');
    assert.ok(end);
    assert.ok(end.durationMs >= 0);
    assert.equal(Object.hasOwn(row, 'url'), false);
  }
  const workspace = await adapter.open('https://example.test/?page=2');
  plan = { control: 'button', root: 'body', name: 'Next' };
  await adapter.advance(workspace, { kind: 'button' });
  plan = { control: 'scroll', root: 'body' };
  await adapter.advance(workspace, { kind: 'scroll' });
  plan = { control: 'button', root: 'body', name: 'Next' };
  unknown = true;
  await adapter.advance(workspace, { kind: 'button' });
  assert.ok(reports.some((row) => row.action === 'semantic_snapshot'));
  assert.ok(reports.some((row) => row.action === 'scroll'));
  assert.ok(reports.some((row) => row.action === 'ref_click' && row.phase === 'unknown'));
  const fixture = spawnSync('python3', ['-B', 'tests/copilot/test_r20.py', '--collector-fixture'], {
    input: JSON.stringify(reports),
    encoding: 'utf8',
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  const rows = JSON.parse(fixture.stdout),
    h = overlay();
  try {
    h.instance.setRecentSteps(rows);
    assert.ok(rows.filter((row) => row.action === 'table.read').length >= 2);
    assert.match(h.shadow.querySelector('[data-role=recent-list]').textContent, /执行结果尚未确认/);
  } finally {
    h.close();
  }
});
test('workflow overlay uses the same current step and completed count as its running card', async () => {
  const h = overlay(),
    row = {
      id: 'workflow',
      action: 'workflow.run',
      step: '第 2 步 · 读取表格',
      workflow_completed: 1,
      workflow_total: 4,
    };
  const task = { copilotRowId: row.id, overlays: new Map([[7, {}]]) };
  try {
    await updateWorkflowActivity(
      {
        tasks: new Map([['fixture', task]]),
        overlayCall: async (_tab, _entry, op, { activity }) => {
          assert.equal(op, 'activity');
          h.instance.setActivity(activity);
        },
      },
      row,
    );
    assert.equal(h.shadow.querySelector('[data-role=detail]').textContent, row.step);
    assert.equal(h.shadow.querySelector('progress').value, row.workflow_completed);
    assert.equal(h.shadow.querySelector('progress').max, row.workflow_total);
    h.instance.setRecentSteps([
      { action: 'table.read', result: 'succeeded', time: new Date().toISOString() },
    ]);
    assert.equal(h.shadow.querySelector('[data-role=detail]').textContent, row.step);
  } finally {
    h.close();
  }
});
test('workflow producer reaches overlay; execution subprocess progress reaches background', async () => {
  const workflow = python('--workflow-fixture').filter((message) =>
      ['add', 'update', 'progress'].includes(message.params.type),
    ),
    execution = python('--execution-fixture'),
    h = overlay();
  const events = [...workflow, ...execution],
    pending = [],
    steps = [];
  let receive;
  const api = { tabs: { query: async () => [] }, runtime: { sendMessage: async () => {} } };
  const copilot = new CopilotBackground(api, async () => ({}));
  const task = { copilotRowId: null, overlays: new Map([[7, {}]]) };
  const executor = {
    tasks: new Map([['fixture', task]]),
    overlayCall: async (_tab, _entry, _op, { activity }) => {
      steps.push(activity);
      h.instance.setActivity(activity);
    },
  };
  copilot.onActivity = (row) => updateWorkflowActivity(executor, row);
  const bridge = new Bridge(
    { onMessage: { addListener: (fn) => (receive = fn) }, postMessage() {} },
    {},
    () => {},
    { onCopilot: (event) => pending.push(copilot.notification(event)) },
  );
  try {
    const row = workflow.find((value) => value.params.suggestion?.action === 'workflow.run').params
      .suggestion;
    task.copilotRowId = row.id;
    for (const event of events) receive(event);
    await Promise.all(pending);
    assert.ok(steps.length > 1);
    assert.ok(steps.some((value) => value.total > 0 && value.completed > 0));
    assert.ok(
      execution.some(
        (event) => event.params.type === 'progress' && event.params.progress.type === 'tool_use',
      ),
    );
    const latest = steps.at(-1);
    assert.equal(
      h.shadow.querySelector('[data-role=detail]').textContent,
      latest.summary || latest.step,
    );
    assert.equal(h.shadow.querySelector('progress').value, latest.completed);
  } finally {
    bridge.close();
    h.close();
  }
});
test('reconnect intent is consumed once and cannot re-enable an explicitly disabled session later', async () => {
  const saved = { copilotBridgeEnabled: true },
    calls = [];
  const api = {
    storage: {
      session: {
        get: async () => ({ ...saved }),
        set: async (value) => Object.assign(saved, value),
        remove: async (key) => delete saved[key],
      },
      local: { get: async () => ({}) },
    },
    tabs: { query: async () => [] },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    runtime: { sendMessage: async () => {} },
  };
  const state = { enabled: false, suggestions: [], ready: false };
  const copilot = new CopilotBackground(api, async (method, params) => {
    calls.push({ method, params });
    if (method === 'settings') return { ...state, enabled: params.enabled };
    return state;
  });
  await copilot.synchronize();
  assert.equal(copilot.enabled, true);
  assert.equal(saved.copilotBridgeEnabled, false);
  await copilot.synchronize();
  assert.equal(copilot.enabled, false);
  assert.equal(calls.filter((row) => row.method === 'settings').length, 1);
});
