import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { TablePanel } from '../../native-extension/copilot-table-panel.mjs';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const capture = {
  url: 'https://example.test/report',
  tables: [
    {
      id: '0',
      name: 'Report table',
      headers: ['Keyword', 'Volume'],
      rows: [['sample', 10]],
      pagination: { totalPages: 3, totalRows: 30 },
      incomplete: true,
    },
  ],
};
const saved = {
  key: `${capture.url}|0`,
  result: { id: 'native-saved-table', files: [{ id: 'file-1', path: '/synthetic/table.xlsx' }] },
};
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
};
function fixture(initial = { capture }, handler = async () => ({})) {
  const dom = new JSDOM(html, { pretendToBeVisual: true }),
    doc = dom.window.document,
    calls = [],
    changes = [];
  let current = initial;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  const panel = new TablePanel(
    doc,
    async (name, params) => {
      calls.push([name, params]);
      return name === 'table_state' ? current : handler(name, params);
    },
    { onChange: () => changes.push(panel.suggestions()) },
  );
  return {
    dom,
    doc,
    calls,
    changes,
    panel,
    setState(value) {
      current = value;
    },
    dialog: () => doc.getElementById('table-export-dialog'),
    close() {
      dom.window.close();
    },
  };
}
const pending = (panel) => panel.suggestions().find((row) => row.status === 'pending');
async function click(root, label) {
  const button = [...root.querySelectorAll('button')].find((item) => item.textContent === label);
  assert.ok(button, label);
  await button.onclick();
}
test('table refresh creates a stable local suggestion without opening export controls or saving', async () => {
  const f = fixture();
  try {
    await f.panel.refresh();
    const first = pending(f.panel);
    assert.ok(first);
    assert.equal(first.local_table, true);
    assert.match(first.id, /^local-table-\d+$/);
    assert.equal(f.panel.recognizes(first.id), true);
    assert.equal(f.dialog().open, false);
    assert.deepEqual(f.calls, [['table_state', undefined]]);
    assert.ok(f.changes.length > 0);
    await f.panel.refresh();
    assert.equal(pending(f.panel).id, first.id);
    assert.equal(f.dialog().open, false);
    assert.equal(
      f.calls.some(([name]) =>
        ['save_table', 'copy_table', 'collect_table', 'recognize_tables'].includes(name),
      ),
      false,
    );
    await f.panel.command('execute', { id: first.id });
    assert.equal(f.dialog().open, true);
    assert.equal(
      f.calls.some(([name]) => ['save_table', 'copy_table', 'collect_table'].includes(name)),
      false,
    );
    assert.ok(f.dialog().querySelector('#table-tools .table-strip'));
    assert.ok(f.dialog().contains(f.doc.getElementById('table-confirmation-live')));
  } finally {
    f.close();
  }
});
test('detected table replaces automatic detection card while collection and prepared cards stay available', async () => {
  const f = fixture();
  try {
    await f.panel.refresh();
    const native = (tool, extra = {}) => ({
      id: `native-${tool}`,
      action: 'native.tool',
      task_type: `native.${tool}`,
      title: tool,
      params: { tool },
      status: 'pending',
      local_task: true,
      risk: 'zero',
      ...extra,
    });
    const rows = [
      native('tables', { recommendation_rank: 0 }),
      native('collect', { recommendation_rank: 1 }),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `task-${index}`,
        action: 'assist.task',
        task_type: `task.${index}`,
        title: `Task ${index}`,
        status: 'pending',
        recommendation_rank: index + 2,
      })),
      native('tables', { id: 'prepared-table', explicit: true }),
    ];
    const merged = f.panel.mergeSuggestions(rows);
    renderDashboard(
      f.doc,
      { enabled: true, ready: true, suggestions: merged },
      { command: async () => ({}) },
    );
    const cards = [...f.doc.querySelectorAll('#pending article')];
    assert.equal(
      cards.some((card) => card.dataset.id === 'native-tables'),
      false,
    );
    assert.equal(cards.filter((card) => /^local-table-/.test(card.dataset.id)).length, 1);
    assert.ok(cards.some((card) => card.dataset.id === 'native-collect'));
    assert.ok(
      cards.some((card) => card.dataset.id === 'task-7'),
      'a duplicate detection card does not evict a server recommendation',
    );
    assert.ok(cards.some((card) => card.dataset.id === 'prepared-table'));
    assert.equal(f.doc.getElementById('suggestions-count').textContent, '10');
    assert.equal(
      cards.length,
      11,
      'explicit prepared task is retained beyond the ten automatic cards',
    );
  } finally {
    f.close();
  }
});
for (const action of ['feedback', 'ignore'])
  test(`local ${action} dismisses its suggestion without host feedback or execution`, async () => {
    const f = fixture();
    try {
      await f.panel.refresh();
      const row = pending(f.panel),
        before = f.calls.length;
      await f.panel.command('suggestion_hold', { id: row.id, held: true });
      await f.panel.command(action, { id: row.id, kind: 'later' });
      assert.equal(
        f.panel.suggestions().some((item) => item.id === row.id && item.status === 'pending'),
        false,
      );
      assert.equal(f.calls.length, before);
      assert.equal(f.dialog().open, false);
      await f.panel.refresh();
      assert.equal(
        f.panel.suggestions().some((item) => item.id === row.id && item.status === 'pending'),
        false,
      );
    } finally {
      f.close();
    }
  });
test('table identity changes retire stale suggestions and stale clicks never save or open another table', async () => {
  const f = fixture();
  try {
    await f.panel.refresh();
    const original = pending(f.panel);
    f.setState({
      capture: {
        ...capture,
        url: 'https://example.test/another-report',
        tables: [{ ...capture.tables[0], name: 'Another table', rows: [['other', 20]] }],
      },
    });
    await f.panel.refresh();
    const current = pending(f.panel);
    assert.notEqual(current.id, original.id);
    assert.equal(f.panel.recognizes(original.id), true, 'stale local ids remain locally routed');
    const before = f.calls.length;
    try {
      await f.panel.command('execute', { id: original.id });
    } catch {}
    assert.equal(f.calls.length, before);
    assert.equal(f.dialog().open, false);
    assert.equal(pending(f.panel).id, current.id);
    await f.panel.command('execute', { id: current.id });
    assert.equal(f.dialog().open, true);
    assert.match(f.dialog().textContent, /Another table/);
  } finally {
    f.close();
  }
});
test('explicit export options preserve separate save, copy and multipage confirmation requests', async () => {
  const f = fixture();
  try {
    await f.panel.refresh();
    await f.panel.command('execute', { id: pending(f.panel).id });
    const root = f.doc.getElementById('table-tools');
    for (const label of ['保存为 Excel', '保存为 CSV', '复制为表格', '保存全部'])
      await click(root, label);
    assert.deepEqual(
      f.calls.filter(([name]) => ['save_table', 'copy_table', 'collect_table'].includes(name)),
      [
        ['save_table', { id: '0', format: 'xlsx' }],
        ['save_table', { id: '0', format: 'csv' }],
        ['copy_table', { id: '0' }],
        ['collect_table', { id: '0' }],
      ],
    );
    assert.equal(
      f.calls.some(([name]) => name === 'confirm_table'),
      false,
    );
  } finally {
    f.close();
  }
});
test('confirmation dialog closes only after cancel succeeds and a failed cancel retains it for retry', async () => {
  let fail = true;
  const confirmation = {
      token: 'confirm-token',
      name: 'Report table',
      headers: ['Keyword'],
      rows: 1,
      pages: 3,
      format: 'xlsx',
      all: true,
      candidate_count: 1,
    },
    f = fixture({ capture }, async (name, params) => {
      if (name === 'confirm_table') {
        assert.deepEqual(params, { kind: 'cancel', token: 'confirm-token' });
        if (fail) throw Error('synthetic cancellation failure');
        f.setState({ capture });
        return {};
      }
      return {};
    });
  try {
    await f.panel.refresh();
    await f.panel.command('execute', { id: pending(f.panel).id });
    f.setState({ capture, confirmation });
    await f.panel.refresh();
    assert.equal(f.dialog().open, true);
    assert.ok(f.dialog().querySelector('.confirmation-card'));
    f.doc.getElementById('table-export-close').click();
    await flush();
    assert.equal(f.dialog().open, true);
    assert.equal(f.calls.filter(([name]) => name === 'confirm_table').length, 1);
    assert.equal(
      f.calls.some(([name]) => ['save_table', 'copy_table', 'collect_table'].includes(name)),
      false,
    );
    fail = false;
    f.doc.getElementById('table-export-close').click();
    await flush();
    assert.equal(f.dialog().open, false);
    assert.equal(f.calls.filter(([name]) => name === 'confirm_table').length, 2);
  } finally {
    f.close();
  }
});
test('saved receipts become local result cards with native identity and open only on explicit details', async () => {
  const f = fixture({ saved });
  try {
    await f.panel.refresh();
    const completed = f.panel.suggestions().find((row) => row.status === 'completed');
    assert.ok(completed);
    assert.equal(completed.local_table, true);
    assert.equal(completed.native_id, `table-${saved.result.id}`);
    assert.equal(f.dialog().open, false);
    await f.panel.command('open_result', { id: completed.id, popup: true });
    assert.equal(f.dialog().open, true);
    assert.match(f.dialog().textContent, /\/synthetic\/table.xlsx/);
    assert.equal(
      f.calls.some(([name]) =>
        ['save_table', 'copy_table', 'collect_table', 'table_open'].includes(name),
      ),
      false,
    );
    await click(f.doc.getElementById('table-tools'), '打开所在文件夹');
    assert.deepEqual(f.calls.at(-1), ['table_open', { id: 'file-1', folder: true }]);
  } finally {
    f.close();
  }
});
test('merged suggestions retain ten recommendations with a local table first and correct counts', async () => {
  const f = fixture();
  try {
    await f.panel.refresh();
    const modelRows = Array.from({ length: 15 }, (_, index) => ({
        id: `model-${index}`,
        status: 'pending',
        action: 'general.task',
        title: `Model suggestion ${index}`,
        params: { keyword: 'exact-current' },
        risk: 'zero',
      })),
      state = {
        enabled: true,
        ready: true,
        locale: 'en',
        tool_context: { current: { object: 'exact-current' } },
        suggestions: modelRows,
      },
      original = structuredClone(state);
    const combined = { ...state, suggestions: [...state.suggestions, ...f.panel.suggestions()] },
      calls = [];
    renderDashboard(f.doc, combined, {
      command: async (name, params) => {
        if (f.panel.recognizes(params.id)) return f.panel.command(name, params);
        calls.push([name, params]);
      },
    });
    assert.deepEqual(state, original, 'render composition leaves the model state unchanged');
    const cards = [...f.doc.querySelectorAll('#pending article:not([hidden])')];
    assert.equal(cards.length, 10);
    assert.equal(f.doc.querySelectorAll('#pending > article').length, 10);
    assert.equal(f.doc.querySelector('#more-suggestions'), null);
    assert.equal(cards[0].dataset.id, pending(f.panel).id);
    assert.equal(f.doc.getElementById('suggestions-count').textContent, '10');
    assert.equal(f.dialog().open, false);
    await cards
      .find((card) => card.dataset.id === 'model-0')
      .querySelector('[data-action=execute]')
      .onclick();
    assert.deepEqual(calls, [['execute', { id: 'model-0' }]]);
    await cards[0].querySelector('[data-action=execute]').onclick();
    assert.equal(f.dialog().open, true);
    assert.deepEqual(calls, [['execute', { id: 'model-0' }]]);
    assert.equal(
      f.calls.some(([name]) => ['save_table', 'copy_table', 'collect_table'].includes(name)),
      false,
    );
  } finally {
    f.close();
  }
});
test('failed export receipts do not become completed cards and partial file receipts retain their status and stable finish time', async () => {
  const f = fixture({
    capture,
    saved: {
      key: saved.key,
      result: {
        id: 'failed-save',
        error: 'export_directory_unavailable',
        reason: 'Choose a usable default folder',
        files: [],
      },
    },
  });
  try {
    await f.panel.refresh();
    assert.ok(pending(f.panel));
    assert.equal(
      f.panel.suggestions().some((row) => row.status === 'completed'),
      false,
    );
    await f.panel.command('execute', { id: pending(f.panel).id });
    assert.match(f.dialog().textContent, /Choose a usable default folder/);
    f.setState({
      capture,
      saved: {
        key: saved.key,
        result: { ...saved.result, partial: true, reason: 'Stopped with saved pages' },
      },
    });
    await f.panel.refresh();
    const completed = f.panel.suggestions().find((row) => row.status === 'completed');
    assert.equal(completed.completion_status, 'partial');
    assert.equal(completed.result.verdict, 'Stopped with saved pages');
    assert.ok(Number.isFinite(completed.finished_at));
    await flush();
    await f.panel.refresh();
    assert.equal(
      f.panel.suggestions().find((row) => row.status === 'completed').finished_at,
      completed.finished_at,
    );
    assert.equal(pending(f.panel), undefined);
  } finally {
    f.close();
  }
});
test('actual main entrypoint deduplicates native receipt cards while preserving model state and command routing', async () => {
  const dom = new JSDOM(html, {
      url: 'chrome-extension://fixture/copilot-panel.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    }),
    doc = dom.window.document,
    calls = [],
    listeners = [];
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  dom.window.setInterval = () => 1;
  const state = {
      locale: 'en',
      enabled: true,
      ready: true,
      settings_saved: true,
      revision: 1,
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
      result_history: [],
      basket: { revision: 1, items: [] },
      suggestions: [
        {
          id: 'model-task',
          status: 'pending',
          title: 'Model task',
          action: 'general.task',
          params: { task: 'Compare public plans' },
          risk: 'zero',
        },
        {
          id: `table-${saved.result.id}`,
          status: 'completed',
          completion_status: 'completed',
          title: 'Native copy of saved table',
          action: 'table.export',
          params: {},
          result: { verdict: 'Saved file', export: saved.result },
        },
      ],
    },
    original = structuredClone(state);
  dom.window.chrome = {
    i18n: { getUILanguage: () => 'en' },
    runtime: {
      connect: () => ({}),
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'copilot.local' && message.command === 'table_state')
          return { result: { capture, saved, jobs: [] } };
        if (message.type === 'copilot.connections') return { result: { cloud: null } };
        if (message.command === 'agent_catalog')
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
        if (message.command === 'logs_read') return { result: { entries: [], revision: 0 } };
        if (message.command === 'log_client') return { result: { accepted: true } };
        if (message.command === 'capability_state')
          return { result: { capabilities: {}, candidates: [] } };
        return { result: state };
      },
    },
    downloads: { download: async () => 1 },
  };
  const entrypoint = new URL('../../native-extension/copilot-panel.mjs', import.meta.url),
    originalSource = await readFile(entrypoint, 'utf8');
  const modules = await Promise.all(
    [...originalSource.matchAll(/^import .*? from ['"]([^'"]+)['"];?$/gm)].map(
      ([, path]) => import(new URL(path, entrypoint)),
    ),
  );
  Object.assign(dom.window, ...modules);
  const source = originalSource.replace(/^import\s[^;]*;\n/gm, '');
  try {
    dom.window.eval(source);
    await flush();
    assert.deepEqual(state, original);
    assert.equal(
      doc.querySelectorAll('#results article[data-id]:not([aria-hidden=true])').length,
      1,
    );
    assert.equal(
      doc.querySelector(
        `#results article[data-id="table-${saved.result.id}"]:not([aria-hidden=true])`,
      ),
      null,
    );
    const receipt = doc.querySelector('#results article[data-id]:not([aria-hidden=true])');
    assert.match(receipt.dataset.id, /^local-table-\d+$/);
    assert.equal(doc.getElementById('results-count').textContent, '1');
    assert.equal(doc.getElementById('table-export-dialog').open, false);
    await receipt.querySelector('[data-action=open_result]').onclick();
    assert.equal(doc.getElementById('table-export-dialog').open, true);
    assert.match(doc.getElementById('table-tools').textContent, /\/synthetic\/table.xlsx/);
    assert.equal(
      calls.some((message) => message.command === 'open_result'),
      false,
    );
    assert.equal(
      calls.some((message) =>
        ['save_table', 'copy_table', 'collect_table'].includes(message.command),
      ),
      false,
    );
    await doc.querySelector('#pending article[data-id=model-task] [data-action=execute]').onclick();
    assert.deepEqual(structuredClone(calls.filter((message) => message.command === 'execute')), [
      { type: 'copilot.command', command: 'execute', params: { id: 'model-task' } },
    ]);
    assert.deepEqual(state, original);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('unload'));
    dom.window.close();
  }
});
test('two export-format clicks share one in-flight request instead of creating competing confirmations', async () => {
  let finish;
  const response = new Promise((resolve) => {
      finish = resolve;
    }),
    f = fixture({ capture }, (name) => {
      assert.equal(name, 'save_table');
      return response;
    });
  try {
    await f.panel.refresh();
    await f.panel.command('execute', { id: pending(f.panel).id });
    const buttons = [...f.doc.querySelectorAll('#table-tools button')],
      xlsx = buttons.find((button) => button.textContent === '保存为 Excel'),
      csv = buttons.find((button) => button.textContent === '保存为 CSV');
    const first = xlsx.onclick(),
      second = csv.onclick();
    await flush();
    assert.deepEqual(
      f.calls.filter(([name]) => name === 'save_table'),
      [['save_table', { id: '0', format: 'xlsx' }]],
    );
    finish({});
    await Promise.all([first, second]);
    assert.equal(f.calls.filter(([name]) => name === 'save_table').length, 1);
    assert.equal(f.dialog().open, true);
  } finally {
    finish({});
    f.close();
  }
});
test('close waits for a late export start and cancels its confirmation even if the subsequent state read fails', async () => {
  let finish,
    failRead = false;
  const response = new Promise((resolve) => {
      finish = resolve;
    }),
    confirmation = {
      token: 'late-token',
      url: capture.url,
      id: '0',
      name: 'Report table',
      headers: ['Keyword', 'Volume'],
      rows: 1,
      pages: 3,
      format: 'xlsx',
      candidate_count: 1,
    },
    f = fixture({ capture }, async (name, params) => {
      if (name === 'save_table') return response;
      if (name === 'confirm_table') {
        assert.deepEqual(params, { kind: 'cancel', token: 'late-token' });
        return {};
      }
      throw Error(name);
    });
  const original = f.panel.request;
  f.panel.request = async (name, params) => {
    if (name === 'table_state' && failRead) {
      f.calls.push([name, params]);
      throw Error('synthetic state read failure');
    }
    return original(name, params);
  };
  try {
    await f.panel.refresh();
    await f.panel.command('execute', { id: pending(f.panel).id });
    const button = [...f.doc.querySelectorAll('#table-tools button')].find(
        (button) => button.textContent === '保存为 Excel',
      ),
      exporting = button.onclick();
    await flush();
    const closing = f.panel.close();
    await flush();
    assert.equal(f.dialog().open, true);
    assert.equal(
      f.calls.some(([name]) => name === 'confirm_table'),
      false,
    );
    failRead = true;
    finish({ confirmation });
    await Promise.all([exporting, closing]);
    await flush();
    assert.deepEqual(
      f.calls.filter(([name]) => name === 'confirm_table'),
      [['confirm_table', { kind: 'cancel', token: 'late-token' }]],
    );
    assert.equal(f.dialog().open, false);
    assert.equal(f.calls.filter(([name]) => name === 'save_table').length, 1);
  } finally {
    finish({ confirmation });
    f.close();
  }
});
test('an in-flight close cancellation blocks confirmation clicks until cancellation fails and explicit retry is possible', async () => {
  let rejectCancel;
  const cancelled = new Promise((_, reject) => {
      rejectCancel = reject;
    }),
    confirmation = {
      token: 'closing-token',
      url: capture.url,
      id: '0',
      name: 'Report table',
      headers: ['Keyword'],
      rows: 1,
      pages: 1,
      format: 'xlsx',
      candidate_count: 1,
    },
    f = fixture({ capture }, async (name, params) => {
      if (name === 'confirm_table' && params.kind === 'cancel') return cancelled;
      if (name === 'confirm_table' && params.kind === 'confirm') return {};
      throw Error(name);
    });
  try {
    await f.panel.refresh();
    await f.panel.command('execute', { id: pending(f.panel).id });
    f.setState({ capture, confirmation });
    await f.panel.refresh();
    const confirm = [...f.doc.querySelectorAll('#table-confirmation-live button')].find(
        (button) => button.textContent === '确认保存',
      ),
      closing = f.panel.close();
    await flush();
    await confirm.onclick();
    assert.deepEqual(
      f.calls.filter(([name]) => name === 'confirm_table'),
      [['confirm_table', { kind: 'cancel', token: 'closing-token' }]],
    );
    rejectCancel(Error('synthetic cancel failure'));
    await closing;
    assert.equal(f.dialog().open, true);
    await click(f.doc.getElementById('table-confirmation-live'), '确认保存');
    assert.deepEqual(
      f.calls.filter(([name]) => name === 'confirm_table'),
      [
        ['confirm_table', { kind: 'cancel', token: 'closing-token' }],
        ['confirm_table', { kind: 'confirm', token: 'closing-token' }],
      ],
    );
  } finally {
    rejectCancel(Error('test cleanup'));
    f.close();
  }
});
