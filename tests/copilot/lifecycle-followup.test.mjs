import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import { TableJobs } from '../../native-extension/copilot-table-job.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));
const table = {
  id: '0',
  name: 'Report',
  headers: ['Name', 'Count'],
  rows: [[{ text: 'one' }, { text: '1' }]],
  pagination: { kind: 'none' },
};
function background() {
  const tab = {
      id: 5,
      url: 'https://example.test/report',
      windowId: 1,
      active: true,
      status: 'complete',
    },
    messages = [];
  const api = {
    runtime: {
      id: 'extension',
      getURL: (file) => 'chrome-extension://extension/' + file,
      sendMessage: async (message) => messages.push(message),
    },
    tabs: { query: async () => [tab], get: async () => tab, sendMessage: async () => {} },
    windows: { get: async () => ({ focused: true }) },
    storage: { local: { get: async () => ({}) }, session: { set: async () => {} } },
    scripting: { executeScript: async () => [{ result: { cancelled: true } }] },
  };
  const bg = new CopilotBackground(api, async () => ({}));
  bg.enabled = true;
  bg.notification = async () => {};
  bg.tableTab = tab.id;
  bg.tableCaptures.set(tab.id, { url: tab.url, tables: [structuredClone(table)] });
  return { bg, api, tab, messages };
}

test('same-URL reload immediately withdraws the old table and its confirmation before waiting for the host', async () => {
  const { bg, tab } = background(),
    pending = deferred();
  bg.request = () => pending.promise;
  bg.tableConfirmation = { token: 'old', tab: 5, epoch: 0 };
  bg.tabEvent(5, '导航到新页面', { ...tab, status: 'loading' });
  assert.equal(bg.tableCaptures.has(5), false);
  assert.equal(bg.tableConfirmation, null);
  assert.equal((await bg.localCommand('table_state', {})).capture, null);
  assert.equal(bg.tableLoading.has(5), true);
  pending.resolve({});
  await bg.queue;
  await assert.rejects(bg.resolveTableConfirmation('confirm', 'old'), /失效/);
});

test('switching to an empty tab and closing it never selects a cached table from another tab', async () => {
  const { bg, tab } = background();
  bg.tabEvent(6, '切换标签页', { ...tab, id: 6, url: 'https://example.test/empty' });
  assert.equal((await bg.localCommand('table_state', {})).capture, null);
  await bg.queue;
  bg.tabEvent(6, '关闭标签页');
  assert.equal(bg.tableTab, null);
  assert.equal(bg.tableCaptures.has(5), true);
});

test('a capture already in flight cannot repopulate a reloaded document, and the new document can publish empty data', async () => {
  const { bg, tab } = background(),
    gate = deferred();
  bg.refreshOwnership = () => gate.promise;
  const sender = { id: 'extension', frameId: 0, url: tab.url, documentId: 'old-document', tab };
  const request = new Promise((resolve) =>
    bg.handle(
      { type: 'copilot.tables', capture: { url: tab.url, tables: [table] } },
      sender,
      resolve,
    ),
  );
  bg.tabEvent(5, '导航到新页面', { ...tab, status: 'loading' });
  bg.tabEvent(5, '页面加载完成', tab);
  gate.resolve();
  assert.ok((await request).error);
  assert.equal(bg.tableCaptures.has(5), false);
  await bg.queue;
  const response = await new Promise((resolve) =>
    bg.handle(
      { type: 'copilot.tables', capture: { url: tab.url, tables: [] } },
      { ...sender, documentId: 'new-document' },
      resolve,
    ),
  );
  assert.deepEqual(response, { result: {} });
  assert.deepEqual(bg.tableCaptures.get(5).tables, []);
  assert.equal(bg.tableCaptures.get(5).documentId, 'new-document');
});

test('upload failure always leaves the running map and preserves a failed terminal state', async () => {
  for (const upload of [
    async () => {
      throw Error('PRIVATE_NATIVE_ERROR');
    },
    async () => ({ error: 'export_directory_unavailable', files: [] }),
    async () => ({ files: [] }),
    async () => undefined,
  ]) {
    let closed = 0;
    const updates = [],
      snapshot = { url: 'https://example.test/report', tables: [table] };
    const jobs = new TableJobs({
      open: async () => ({}),
      read: async () => snapshot,
      close: async () => closed++,
      upload,
      progress: (value) => updates.push(value),
    });
    await assert.rejects(jobs.run('failed', snapshot, table));
    assert.equal(closed, 1);
    assert.equal(jobs.jobs.size, 0);
    assert.equal(updates.at(-1).status, 'failed');
    assert.doesNotMatch(updates.at(-1).reason, /PRIVATE/);
    assert.equal(
      updates.some((row) => row.status === 'completed'),
      false,
    );
    jobs.upload = async () => ({ files: [{ id: 'file', path: '/synthetic/table.xlsx' }] });
    await jobs.run('failed', snapshot, table);
    assert.equal(jobs.jobs.size, 0);
    assert.equal(updates.at(-1).status, 'completed');
  }
});

test('a progress callback failure still clears the job without opening a work tab', async () => {
  let opened = 0;
  const jobs = new TableJobs({
    open: async () => opened++,
    progress: () => {
      throw Error('observer failed');
    },
  });
  await assert.rejects(jobs.run('progress', { url: 'https://example.test/report' }, table));
  assert.equal(jobs.jobs.size, 0);
  assert.equal(opened, 0);
});
test('distinct virtual row positions preserve identical records and repeated windows remain deduplicated', async () => {
  const duplicate = [{ text: 'same' }, { text: '1' }],
    initial = {
      ...table,
      rows: [duplicate, duplicate],
      row_keys: ['aria-rowindex:2', 'aria-rowindex:3'],
      pagination: { kind: 'scroll', totalRows: 3 },
    };
  let reads = 0;
  const snapshot = { url: 'https://example.test/grid', tables: [initial] },
    jobs = new TableJobs({
      open: async () => ({}),
      read: async () => ({
        url: snapshot.url,
        tables: [
          reads++ ? { ...initial, row_keys: ['aria-rowindex:3', 'aria-rowindex:4'] } : initial,
        ],
      }),
      advance: async () => ({ advanced: true }),
      close: async () => {},
      delay: async () => {},
      progress: () => {},
      upload: async (data) => ({ ...data, files: [{ id: 'file', path: '/synthetic/table.xlsx' }] }),
    });
  const result = await jobs.run('virtual', snapshot, initial);
  assert.equal(result.rows.length, 3);
  assert.equal(result.deduplication, 'row_index');
  assert.equal(jobs.jobs.size, 0);
});
test('content fallback preserves duplicate occurrences within a page and discloses its policy', async () => {
  const duplicate = [{ text: 'same' }, { text: '1' }],
    initial = { ...table, rows: [duplicate, duplicate] },
    snapshot = { url: 'https://example.test/table', tables: [initial] },
    jobs = new TableJobs({
      open: async () => ({}),
      read: async () => snapshot,
      close: async () => {},
      progress: () => {},
      upload: async (data) => ({ ...data, files: [{ id: 'file', path: '/synthetic/table.xlsx' }] }),
    });
  const result = await jobs.run('fallback', snapshot, initial);
  assert.equal(result.rows.length, 2);
  assert.equal(result.deduplication, 'content_occurrence');
});

test('installed update reports each local blocker and permits idle only after every blocker clears', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: vm } = await import('node:vm');
  const source = await readFile(
    new URL('../../native-extension/background.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function localUpdateWaitReason()');
  const end = source.indexOf('async function checkInstalledUpdate()', start);
  const context = vm.createContext({
    connecting: false,
    accessWindow: null,
    copilot: { tableConfirmation: null, tableJobs: { jobs: new Map() }, rows: new Map() },
    executor: { tasks: new Map() },
  });
  vm.runInContext(source.slice(start, end), context);
  const reason = () => vm.runInContext('localUpdateWaitReason()', context);
  assert.equal(reason(), null);
  context.connecting = true;
  assert.equal(reason(), 'connecting');
  context.connecting = false;
  context.accessWindow = {};
  assert.equal(reason(), 'access_confirmation');
  context.accessWindow = null;
  context.copilot.tableConfirmation = {};
  assert.equal(reason(), 'table_confirmation');
  context.copilot.tableConfirmation = null;
  context.copilot.tableJobs.jobs.set('job', {});
  assert.equal(reason(), 'table_job');
  context.copilot.tableJobs.jobs.clear();
  for (const status of ['queued', 'executing', 'stopping']) {
    context.copilot.rows.set('row', { status });
    assert.equal(reason(), 'suggestion');
  }
  context.copilot.rows.clear();
  context.executor.tasks.set('task', { revoked: false });
  assert.equal(reason(), 'browser_task');
  context.executor.tasks.get('task').revoked = true;
  assert.equal(reason(), null);
  assert.equal(vm.runInContext('locallyIdle()', context), true);
});

test('completed native handshake releases connecting while post-connect synchronization is pending', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: vm } = await import('node:vm');
  const source = await readFile(
    new URL('../../native-extension/background.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('let connectionRevision = 0;');
  const end = source.indexOf("chrome.alarms.create('reconnect'", start);
  const sync = deferred();
  const noop = async () => {};
  const context = vm.createContext({
    bridge: null,
    connecting: false,
    connected: false,
    lastError: '',
    connectedInstanceId: null,
    connectedGeneration: null,
    notifier: null,
    approvalInstance: null,
    accessWindow: null,
    consentLoaded: Promise.resolve(),
    disconnectBarrier: Promise.resolve(),
    reloadForInstalledBuild: async () => false,
    fetch() {},
    BUILD_ID: 'fixture',
    crypto: { randomUUID: () => 'browser' },
    navigator: { userAgent: 'Edg' },
    cloud: { connect: noop },
    copilot: { synchronize: () => sync.promise },
    consent: { synchronize: noop },
    executor: {
      workspaces: { manager: { reconcile: noop } },
      leases: new Map(),
      diagnostics: { recordSafely() {} },
      cleanupOrphanOverlays: noop,
    },
    chrome: {
      storage: {
        local: { get: async () => ({ browserInstanceId: 'browser' }), set: noop },
        session: { get: async () => ({}), set: noop },
      },
      runtime: {
        connectNative: () => ({ onDisconnect: { addListener() {} } }),
        getManifest: () => ({ version: '2.2.0' }),
        sendMessage: noop,
      },
    },
    Bridge: class {
      async request(method) {
        return method === 'extension.hello' ? { connectionGeneration: 'generation' } : [];
      }
    },
    refreshApprovals: noop,
    changed: noop,
    openAccessManagementRequest: noop,
  });
  vm.runInContext(source.slice(start, end), context);
  const pending = vm.runInContext('connect()', context);
  await tick();
  assert.equal(context.lastError, '');
  assert.equal(context.connected, true);
  assert.equal(context.connecting, false);
  const nextHello = deferred();
  context.bridge = null;
  context.connected = false;
  context.copilot.synchronize = noop;
  context.Bridge.prototype.request = async (method) =>
    method === 'extension.hello' ? nextHello.promise : [];
  const reconnect = vm.runInContext('connect()', context);
  await tick();
  assert.equal(context.connecting, true);
  sync.resolve();
  await pending;
  assert.equal(context.connecting, true);
  nextHello.resolve({ connectionGeneration: 'next' });
  await reconnect;
  assert.equal(context.connecting, false);
});
