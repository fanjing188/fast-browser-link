import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import {
  boardName,
  mountControls,
  renderConnection,
} from '../../native-extension/copilot-controls.mjs';
import { captureTables } from '../../native-extension/copilot-tables.mjs';
import { tableConfirmation } from '../../native-extension/copilot-table-confirm.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
const wait = () => new Promise((done) => setTimeout(done, 35));
function page() {
  const dom = new JSDOM(
    '<h2>First</h2><table><tr><th>Name</th><th>Value</th></tr>' +
      [1, 2, 3].map((i) => `<tr><td>row${i}</td><td>${i}</td></tr>`).join('') +
      '</table><h2>Second</h2><table><tr><th>Key</th><th>Count</th></tr>' +
      [1, 2, 3].map((i) => `<tr><td>key${i}</td><td>${i}</td></tr>`).join('') +
      '</table>',
    { url: 'https://example.test/?page=1', pretendToBeVisual: true },
  );
  const doc = dom.window.document;
  let top = 30;
  dom.window.Element.prototype.getClientRects = () => [{}];
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    left: 20,
    top,
    bottom: top + 100,
    width: 320,
    height: 100,
  });
  let shadow;
  const attach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init) {
    shadow = attach.call(this, init);
    return shadow;
  };
  return {
    dom,
    doc,
    get shadow() {
      return shadow;
    },
    scroll() {
      top = -50;
    },
    close() {
      dom.window.__fastTableConfirmation?.control('cancel');
      dom.window.close();
    },
  };
}
test('custom dropdown search, keyboard, segmented mode and stepper share backing values without native UI', async () => {
  const dom = new JSDOM(
      '<html lang="en"><select aria-label="Model">' +
        Array.from({ length: 10 }, (_, i) => `<option value="${i}">model ${i}</option>`).join('') +
        '</select><div class="mode-options"><label><input type="radio" name="mode" value="a" checked>A</label><label><input type="radio" name="mode" value="b">B</label></div><input type="number" min="1" max="3" value="1"><input type="checkbox">',
      { pretendToBeVisual: true },
    ),
    d = dom.window.document,
    c = mountControls(d);
  try {
    assert.ok(d.querySelector('select').hidden);
    const trigger = d.querySelector('[role=combobox]');
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(d.activeElement.type, 'search');
    d.activeElement.value = 'model 9';
    d.activeElement.dispatchEvent(new dom.window.Event('input'));
    assert.equal(d.querySelectorAll('[role=option]').length, 1);
    d.querySelector('[role=option]').click();
    assert.equal(d.querySelector('select').value, '9');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    const radios = d.querySelectorAll('button[role=radio]');
    radios[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    assert.equal(radios[1].getAttribute('aria-checked'), 'true');
    d.querySelector('.shared-stepper button:last-child').click();
    assert.equal(d.querySelector('input[type=number]').value, '2');
    assert.equal(d.querySelector('input[type=checkbox]').getAttribute('role'), 'switch');
  } finally {
    c.dispose();
    dom.window.close();
  }
});
test('board name defaults, custom names and connection states are shared and neutral', () => {
  assert.equal(boardName('', 'zh'), '协作');
  assert.equal(boardName('', 'en'), 'Assist');
  for (const old of [
    'Hermes协作看板',
    'Hermes 协作看板',
    'Hermes Copilot',
    'Agent协作看板',
    'Agent Board',
  ]) {
    assert.equal(boardName(` ${old} `, 'zh-CN'), '协作');
    assert.equal(boardName(old, 'en-US'), 'Assist');
  }
  for (const name of ['My agent', 'Hermes research', 'Assist', '协作']) {
    assert.equal(boardName(` ${name} `, 'zh'), name);
    assert.equal(boardName(name, 'en'), name);
  }
  assert.equal(boardName(undefined, 'en'), 'Assist');
  assert.equal(boardName('  ', 'zh'), '协作');
  const d = new JSDOM('<span></span>').window.document;
  for (const state of ['connected', 'connecting', 'disconnected', 'error']) {
    renderConnection(d.querySelector('span'), { state, reason: 'synthetic reason' }, 'en');
    assert.equal(d.querySelector('span').dataset.state, state);
    assert.equal(d.querySelector('span').title, 'synthetic reason');
  }
});
test('confirmation stays in closed shadow, follows geometry, switches targets, Esc cancels without modifying target', async () => {
  const f = page(),
    messages = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        if (message.kind === 'cancel')
          tableConfirmation({ action: 'cancel', token: 'fixture' }, f.doc);
        return { result: {} };
      },
    },
  };
  try {
    const before = f.doc.querySelector('table').outerHTML,
      capture = captureTables(f.doc);
    tableConfirmation(
      { token: 'fixture', tables: capture.tables, index: 0, url: capture.url },
      f.doc,
    );
    assert.equal(f.doc.querySelector('[data-fast-automation-overlay]').shadowRoot, null);
    assert.equal(f.shadow.mode, 'closed');
    assert.match(f.shadow.querySelector('.card').textContent, /2 列/);
    const top = f.shadow.querySelector('.frame').style.top;
    f.scroll();
    await wait();
    assert.notEqual(f.shadow.querySelector('.frame').style.top, top);
    assert.equal(f.doc.querySelector('table').outerHTML, before);
    assert.equal(f.doc.querySelector('[data-fast-automation-overlay]').style.pointerEvents, 'none');
    assert.equal(tableConfirmation({ action: 'switch', token: 'fixture' }, f.doc).name, 'Second');
    assert.equal(tableConfirmation({ action: 'state', token: 'fixture' }, f.doc).name, 'Second');
    f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await wait();
    assert.equal(f.doc.querySelector('[data-fast-automation-overlay]'), null);
    assert.equal(messages[0].kind, 'cancel');
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('table overlay locks all confirmation actions until the bridge receipt returns', async () => {
  const f = page(),
    calls = [];
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  globalThis.chrome = {
    runtime: {
      sendMessage: (message) => {
        calls.push(message);
        return pending;
      },
    },
  };
  try {
    const capture = captureTables(f.doc);
    tableConfirmation({ token: 'fixture', tables: capture.tables, url: capture.url }, f.doc);
    const buttons = [...f.shadow.querySelectorAll('button')];
    buttons.find((button) => button.textContent === '保存').click();
    buttons.find((button) => button.textContent === '换一张').onclick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'confirm');
    assert.ok(buttons.every((button) => button.disabled));
    assert.equal(f.shadow.querySelector('.card').getAttribute('aria-busy'), 'true');
    resolve({ result: {} });
    await wait();
    assert.ok(buttons.every((button) => !button.disabled));
  } finally {
    resolve({ result: {} });
    f.close();
    delete globalThis.chrome;
  }
});
test('removed target automatically cancels and never exports', async () => {
  const f = page(),
    events = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        events.push(message);
        return { result: {} };
      },
    },
  };
  try {
    const capture = captureTables(f.doc);
    tableConfirmation({ token: 'fixture', tables: capture.tables, url: capture.url }, f.doc);
    f.doc.querySelector('table').remove();
    await wait();
    assert.equal(events[0].kind, 'removed');
    assert.equal(f.doc.querySelector('[data-fast-automation-overlay]'), null);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
function service(f) {
  const calls = [],
    messages = [],
    tab = { id: 5, url: f.doc.location.href, windowId: 1 },
    api = {
      runtime: { sendMessage: async (m) => messages.push(m) },
      tabs: { query: async () => [tab], get: async () => tab },
      storage: { local: { get: async () => ({}) } },
      scripting: {
        executeScript: async ({ func, args = [] }) => [
          {
            result:
              func === captureTables ? captureTables(f.doc, args[0] || 3) : func(args[0], f.doc),
          },
        ],
      },
    };
  const bg = new CopilotBackground(api, async (method) => {
    calls.push(method);
    return method === 'table_begin'
      ? { id: 'export' }
      : method === 'state'
        ? { table_config: { max_pages: 50 } }
        : { files: [] };
  });
  bg.tableCaptures.set(5, captureTables(f.doc));
  bg.tableTab = 5;
  return { bg, calls, messages, tab };
}
test('background gates save, copy and multipage work on one-use confirmation and rejects ownership changes', async () => {
  const f = page();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
  const h = service(f),
    runs = [];
  h.bg.tableJobs = { run: async (...args) => runs.push(args) };
  try {
    for (const command of ['save_table', 'copy_table', 'collect_table']) {
      await h.bg.localCommand(command, { id: '0', format: 'csv' });
      assert.equal(
        h.calls.filter((name) => name === 'table_begin').length,
        command === 'save_table' ? 0 : 1,
      );
      assert.equal(runs.length, 0);
      const token = h.bg.tableConfirmation.token,
        result = await h.bg.resolveTableConfirmation('confirm', token);
      if (command === 'copy_table') assert.match(result.clipboard, /Name\tValue/);
      await assert.rejects(h.bg.resolveTableConfirmation('confirm', token), /失效/);
    }
    assert.equal(runs.length, 1);
    assert.equal(runs[0][4], true);
    await h.bg.localCommand('save_table', { id: '0' });
    const token = h.bg.tableConfirmation.token;
    h.bg.liveWorkTab = () => true;
    await assert.rejects(h.bg.resolveTableConfirmation('confirm', token), /归属/);
    assert.equal(h.bg.tableConfirmation, null);
    assert.equal(h.calls.filter((name) => name === 'table_begin').length, 1);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('changed rows refuse stale export; cancellation sends no data and creates no work tab', async () => {
  const f = page();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
  const h = service(f);
  try {
    await h.bg.localCommand('save_table', { id: '0' });
    f.doc.querySelector('td').textContent = 'changed';
    await assert.rejects(
      h.bg.resolveTableConfirmation('confirm', h.bg.tableConfirmation.token),
      /变化/,
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.bg.tableConfirmation, null);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('Excel and CSV confirmation accept the collector headers with nested text, hidden labels and aria names', async () => {
  for (const format of ['xlsx', 'csv']) {
    const f = page();
    globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
    try {
      const headers = f.doc.querySelectorAll('th');
      headers[0].innerHTML = '<span>Search</span><span>term</span><span hidden>Sort</span>';
      headers[1].textContent = '';
      headers[1].setAttribute('aria-label', 'Interest');
      const h = service(f);
      assert.deepEqual(h.bg.tableCaptures.get(5).tables[0].headers, ['Search term', 'Interest']);
      const started = await h.bg.localCommand('save_table', { id: '0', format });
      assert.deepEqual(started.confirmation.headers, ['Search term', 'Interest']);
      assert.equal(h.calls.length, 0);
      await h.bg.resolveTableConfirmation('confirm', started.confirmation.token);
      assert.deepEqual(h.calls, ['table_begin', 'table_append', 'table_finish']);
    } finally {
      f.close();
      delete globalThis.chrome;
    }
  }
});
test('header changes after confirmation still reject export before sending any table data', async () => {
  const f = page();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
  try {
    const h = service(f);
    await h.bg.localCommand('save_table', { id: '0' });
    f.doc.querySelector('th').textContent = 'Changed';
    await assert.rejects(
      h.bg.resolveTableConfirmation('confirm', h.bg.tableConfirmation.token),
      /变化|changed/,
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.bg.tableConfirmation, null);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('table upload measures UTF-8 chunks once per row and retains stage-specific failures', async () => {
  const rows = Array.from({ length: 40 }, () => [{ text: '中'.repeat(1800) }, { text: 'value' }]),
    calls = [];
  const bg = new CopilotBackground({}, async (method, params) => {
    calls.push([method, params]);
    return method === 'table_begin' ? { id: 'chunked' } : { files: [] };
  });
  await bg.exportTable({ name: 'UTF-8', site: 'example.test', headers: ['a', 'b'], rows }, 'csv');
  const chunks = calls
    .filter(([method]) => method === 'table_append')
    .map(([, params]) => params.rows);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), rows);
  assert.ok(
    chunks.every((chunk) => new TextEncoder().encode(JSON.stringify(chunk)).length <= 200000),
  );
  for (const stage of ['table_begin', 'table_append', 'table_finish']) {
    bg.request = async (method) => {
      if (method === stage) throw Error('PRIVATE_NATIVE_ERROR');
      return { id: 'failed' };
    };
    await assert.rejects(
      bg.exportTable({ headers: ['a', 'b'], rows: [[{ text: 'a' }, { text: 'b' }]] }, 'xlsx'),
      (error) => error.stage === stage && error.tableError && !error.message.includes('PRIVATE'),
    );
  }
});
test('confirmation reuses the selected custom table hints and refreshes stale rows for retry', async () => {
  const f = page();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
  try {
    f.doc.body.innerHTML =
      '<div id="custom"><div><span>Custom A</span><span>Custom B</span></div>' +
      [1, 2, 3].map((i) => `<div><span>item${i}</span><span>${i}</span></div>`).join('') +
      '</div>';
    assert.equal(captureTables(f.doc).tables.length, 0);
    const h = service(f),
      capture = captureTables(f.doc, { headers: ['Custom A', 'Custom B'], selectors: ['#custom'] });
    h.bg.tableCaptures.set(5, capture);
    await h.bg.localCommand('save_table', { id: '0', format: 'csv' });
    await h.bg.resolveTableConfirmation('confirm', h.bg.tableConfirmation.token);
    assert.equal(h.calls.filter((method) => method === 'table_finish').length, 1);
    await h.bg.localCommand('save_table', { id: '0' });
    f.doc.querySelector('#custom > div:nth-child(2) > span').textContent = 'updated';
    await assert.rejects(
      h.bg.resolveTableConfirmation('confirm', h.bg.tableConfirmation.token),
      /内容已变化/,
    );
    assert.equal(h.bg.tableCaptures.get(5).tables[0].rows[0][0].text, 'updated');
    assert.equal(h.calls.filter((method) => method === 'table_finish').length, 1);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('extension-message property order does not make unchanged cells fail confirmation', async () => {
  const f = page();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ result: {} }) } };
  try {
    const h = service(f),
      capture = h.bg.tableCaptures.get(5);
    for (const table of capture.tables)
      table.rows = table.rows.map((row) =>
        row.map((cell) => ({ links: cell.links, text: cell.text })),
      );
    await h.bg.localCommand('save_table', { id: '0', format: 'csv' });
    await h.bg.resolveTableConfirmation('confirm', h.bg.tableConfirmation.token);
    assert.equal(h.calls.filter((method) => method === 'table_finish').length, 1);
  } finally {
    f.close();
    delete globalThis.chrome;
  }
});
test('main sidebar owns contextual table work; settings keep grouped controls', async () => {
  const d = new JSDOM(
    await readFile(new URL('../../native-extension/copilot-panel.html', import.meta.url), 'utf8'),
  ).window.document;
  for (const id of ['board-name', 'pending', 'running', 'results', 'usage-details'])
    assert.ok(d.querySelector('#work-view #' + id), id);
  for (const id of ['table-confirmation-live', 'table-tools'])
    assert.ok(d.querySelector('#table-export-dialog #' + id), id);
  assert.equal(d.querySelector('#work-view #table-tools'), null);
  assert.equal(d.querySelector('#settings-view #table-tools'), null);
  assert.equal(d.getElementById('table-tools').hidden, true);
  for (const text of ['界面', '执行模式', '高级', '表格与导出', '本机能力', '关于'])
    assert.match(d.querySelector('#settings-view').textContent, new RegExp(text));
});
