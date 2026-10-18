import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { pageSnapshot } from '../../native-extension/copilot-observation.mjs';
import { MemoryPanel } from '../../native-extension/copilot-memory-panel.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';

function fixture(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 20,
    top: 0,
    bottom: 20,
    left: 0,
    right: 100,
  });
  dom.window.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  return dom;
}

test('form labels include label, aria-label and placeholder, never values or sensitive labels', () => {
  const dom = fixture(`<h1>Review cases</h1><h2>Materials</h2><h3>Next step</h3>
    <label for="case">Case reference</label><input id="case" value="PRIVATE_INPUT_VALUE" aria-label="Ticket" placeholder="Choose case">
    <textarea aria-label="Notes">PRIVATE_TEXTAREA_VALUE</textarea><select aria-label="Priority"><option selected>PRIVATE_SELECTED_VALUE</option></select>
    <label>Password secret label<input type="password" value="PRIVATE_PASSWORD"></label>
    <input autocomplete="one-time-code" aria-label="PRIVATE_OTP_LABEL" value="1234">
    <input autocomplete="cc-number" placeholder="PRIVATE_PAYMENT_LABEL" value="PRIVATE_CARD">
    <input hidden aria-label="PRIVATE_HIDDEN_LABEL"><label hidden>Hidden label<input aria-label="PRIVATE_HIDDEN_PARENT_LABEL"></label>`);
  for (const field of dom.window.document.querySelectorAll('input,textarea,select'))
    Object.defineProperty(field, 'value', {
      get() {
        throw Error('field value must not be read');
      },
    });
  const page = pageSnapshot(dom.window.document, dom.window.location.href),
    serialized = JSON.stringify(page);
  assert.ok(serialized.includes('Case reference · Ticket · Choose case'));
  assert.ok(page.items.some((item) => item.role === 'form-label' && item.name === 'Notes'));
  assert.ok(page.items.some((item) => item.role === 'sensitive-fields'));
  for (const secret of ['PRIVATE_', 'Password secret label', '1234'])
    assert.ok(!serialized.includes(secret), secret);
  assert.deepEqual(
    page.items.filter((item) => item.role === 'heading').map((item) => item.level),
    [1, 2, 3],
  );
  dom.window.close();
});

test('3KB budget prioritizes summaries, headings and selection before form labels; headings capped per level', () => {
  const dom = fixture(
    `<p id="selected">CS-1001</p>${[1, 2, 3].map((level) => Array.from({ length: 8 }, (_, i) => `<h${level}>Heading ${level}.${i}</h${level}>`).join('')).join('')}${Array.from({ length: 100 }, (_, i) => `<input placeholder="Label ${i} ${'字段'.repeat(150)}" value="PRIVATE_VALUE">`).join('')}`,
  );
  const doc = dom.window.document,
    range = doc.createRange();
  range.selectNodeContents(doc.getElementById('selected'));
  doc.getSelection().addRange(range);
  const page = pageSnapshot(doc, dom.window.location.href, 3072, true, [
    { role: 'table', name: 'Case / Status · 100 rows' },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 3072);
  assert.equal(page.items[0].role, 'table');
  assert.ok(page.items.some((item) => item.role === 'selection' && item.name === 'CS-1001'));
  for (const level of [1, 2, 3])
    assert.equal(
      page.items.filter((item) => item.role === 'heading' && item.level === level).length,
      5,
    );
  assert.ok(page.truncated);
  assert.ok(!JSON.stringify(page).includes('PRIVATE_VALUE'));
  dom.window.close();
});

const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const memory = {
  enabled: true,
  current: {
    work: {
      goal: '<img src=x onerror=alert(1)>',
      evidence: ['Observed'],
      constraints: [],
      open_questions: ['Unknown'],
      next_step: 'Review',
    },
    user_direction: 'Prioritize',
  },
  history: [],
  habits: [
    {
      id: 'habit',
      tool: 'desk',
      page: 'case',
      flow: 'materials',
      object_type: 'case_id',
      after: 'inspect',
      accepted: 3,
      ignored: 1,
    },
  ],
};

test('memory settings show understanding and structural habits literally; delete, clear and off are scoped commands', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document,
    calls = [];
  const panel = new MemoryPanel(doc, async (command, params) => {
    calls.push([command, params]);
    return { ...memory, current: null };
  });
  panel.update(memory, 'en');
  assert.ok(doc.getElementById('memory-records').textContent.includes('<img src=x'));
  assert.equal(doc.getElementById('memory-records').querySelector('img'), null);
  assert.ok(doc.getElementById('memory-records').textContent.includes('inspect → materials'));
  await panel.change({ delete: 'current' });
  await panel.change({ delete: 'habit' });
  await panel.change({ clear: true });
  await panel.change({ enabled: false });
  assert.deepEqual(calls, [
    ['memory', { delete: 'current' }],
    ['memory', { delete: 'habit' }],
    ['memory', { clear: true }],
    ['memory', { enabled: false }],
  ]);
  panel.update({ enabled: false, current: null, history: [], habits: [] }, 'zh');
  assert.match(doc.getElementById('memory-empty').textContent, /已关闭/);
  dom.window.close();
});

test('memory failed save restores toggle, announces retry, and suppresses concurrent actions', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  let reject,
    calls = 0;
  const panel = new MemoryPanel(doc, () => {
    calls++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  });
  panel.update(memory);
  doc.getElementById('memory-enabled').checked = false;
  const pending = panel.change({ enabled: false });
  await panel.change({ clear: true });
  assert.equal(calls, 1);
  assert.ok(doc.getElementById('memory-clear').disabled);
  reject(Error('offline'));
  await pending;
  assert.ok(doc.getElementById('memory-enabled').checked);
  assert.match(doc.getElementById('memory-status').textContent, /重试/);
  assert.ok(!doc.getElementById('memory-clear').disabled);
  dom.window.close();
});

test('only extension panel may manage saved memory', async () => {
  const calls = [],
    api = {
      runtime: { id: 'fixture', getURL: (path) => 'chrome-extension://fixture/' + path },
      storage: { session: { get: async () => ({}), set: async () => {} } },
    };
  const bg = new CopilotBackground(api, async (method, params) => {
    calls.push([method, params]);
    return { enabled: false };
  });
  const sender = { id: 'fixture', url: api.runtime.getURL('copilot-panel.html') };
  let response;
  assert.equal(
    bg.handle(
      { type: 'copilot.command', command: 'memory', params: { clear: true } },
      { tab: { id: 2 }, url: 'https://example.test/' },
      () => {},
    ),
    false,
  );
  const done = new Promise((resolve) => {
    response = resolve;
  });
  assert.equal(
    bg.handle(
      { type: 'copilot.command', command: 'memory', params: { clear: true } },
      sender,
      response,
    ),
    true,
  );
  await done;
  assert.deepEqual(calls, [['memory', { clear: true }]]);
});
