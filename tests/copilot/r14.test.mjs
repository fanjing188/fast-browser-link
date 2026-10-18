import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { captureTables } from '../../native-extension/copilot-tables.mjs';
import { pageIdentity } from '../../native-extension/copilot-observation.mjs';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
import { renderResult } from '../../native-extension/copilot-result-view.mjs';
import { tableConfirmation } from '../../native-extension/copilot-table-confirm.mjs';
const panel = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
function fixture(html) {
  const dom = new JSDOM(html, { url: 'https://seo.example.test/report', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.hidden ? [] : [{ width: 300, height: 20 }];
  };
  return dom;
}
const rows = Array.from(
  { length: 3 },
  (_, i) =>
    `<tr class="el-table__row"><td>synthetic${i}<input value="INPUT_PRIVATE"><span hidden>HIDDEN_PRIVATE</span></td><td>${i}</td></tr>`,
).join('');
const table = `<table><tr><th>Keyword</th><th>KD</th></tr>${rows}</table>`;
test('SEO tables with separate header/body wrappers preserve visible keyword rows', () => {
  const dom = fixture(
    `<div class="el-table"><div class="el-table__header-wrapper"><table><thead><tr><th>Keyword</th><th>KD</th></tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody>${rows}</tbody></table></div></div>`,
  );
  try {
    const value = captureTables(dom.window.document);
    assert.equal(value.tables.length, 1);
    assert.equal(value.tables[0].rows.length, 3);
    assert.deepEqual(value.tables[0].headers, ['Keyword', 'KD']);
    assert.doesNotMatch(JSON.stringify(value), /INPUT_PRIVATE|HIDDEN_PRIVATE/);
  } finally {
    dom.window.close();
  }
});
test('profile selectors and header aliases recognize opaque div grids with one virtual row', () => {
  const dom = fixture(
    '<div class="results"><div class="a"><span>Search Term</span><span>Difficulty</span></div><div class="b"><span>synthetic</span><span>4</span></div></div>',
  );
  try {
    const value = captureTables(dom.window.document, {
      minimumRows: 1,
      headers: ['Search Term', 'Difficulty'],
      selectors: ['.results'],
    });
    assert.equal(value.tables.length, 1);
    assert.equal(value.tables[0].rows[0][0].text, 'synthetic');
  } finally {
    dom.window.close();
  }
});
test('open shadow roots and same-origin iframes are read; inaccessible frames are skipped', () => {
  const dom = fixture(
    '<div id="shadow"></div><iframe id="frame"></iframe><iframe id="blocked"></iframe>',
  );
  try {
    const doc = dom.window.document;
    const hidden = doc.createElement('div');
    hidden.style.opacity = '0';
    doc.body.append(hidden);
    hidden.attachShadow({ mode: 'open' }).innerHTML = table.replaceAll(
      'synthetic',
      'HIDDEN_PRIVATE',
    );
    doc.getElementById('shadow').attachShadow({ mode: 'open' }).innerHTML = table;
    const frame = doc.getElementById('frame');
    frame.contentDocument.body.innerHTML = table;
    frame.contentWindow.HTMLElement.prototype.getClientRects = () => [{ width: 300, height: 20 }];
    Object.defineProperty(doc.getElementById('blocked'), 'contentDocument', {
      get() {
        throw new Error('cross origin');
      },
    });
    const value = captureTables(doc);
    assert.equal(value.tables.length, 2);
    assert.doesNotMatch(JSON.stringify(value), /HIDDEN_PRIVATE/);
    assert.ok(value.tables.some((row) => row.dom_path.includes(' >>> ')));
    assert.ok(value.tables.some((row) => row.dom_path.includes(' ::frame:: ')));
    const confirm = tableConfirmation(
      { token: 'synthetic-token', tables: value.tables, url: doc.location.href },
      doc,
    );
    assert.equal(confirm.rows, 3);
    tableConfirmation({ action: 'cancel', token: 'synthetic-token' }, doc);
  } finally {
    dom.window.close();
  }
});
test('snapshot identity ignores size jitter, ordering and duplicate semantic nodes', () => {
  const first = {
    url: 'https://example.test/',
    title: 'same',
    width: 100,
    items: [
      { role: 'text', name: 'same' },
      { role: 'link', name: 'link' },
    ],
  };
  const repeated = {
    ...first,
    width: 101,
    height: 200,
    items: [...first.items].reverse().concat(first.items[0]),
  };
  assert.equal(pageIdentity(first), pageIdentity(repeated));
  assert.notEqual(pageIdentity(first), pageIdentity({ ...first, title: 'changed' }));
});
test('hovered or expanded cards survive withdrawal, then fade after release', async () => {
  const dom = fixture(panel);
  try {
    const doc = dom.window.document,
      state = {
        enabled: true,
        ready: true,
        suggestions: [
          {
            id: 'sample',
            status: 'pending',
            title: 'stable',
            why: 'synthetic',
            action: 'general.task',
            params: { task: 'sample' },
          },
        ],
      };
    renderDashboard(doc, state, { command: async () => {} });
    const card = doc.querySelector('article[data-id=sample]');
    card.dispatchEvent(new dom.window.Event('pointerenter'));
    const detail = doc.createElement('details');
    detail.open = true;
    card.append(detail);
    state.suggestions = [];
    renderDashboard(doc, state, { command: async () => {} });
    assert.ok(card.isConnected);
    assert.equal(card.classList.contains('leaving'), false);
    card.dispatchEvent(new dom.window.Event('pointerleave'));
    renderDashboard(doc, state, { command: async () => {} });
    assert.equal(card.classList.contains('leaving'), false);
    detail.open = false;
    renderDashboard(doc, state, { command: async () => {} });
    assert.equal(card.classList.contains('leaving'), true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(card.isConnected, false);
  } finally {
    dom.window.close();
  }
});
test('failed acquired-data results and partial workflow outcomes are readable', () => {
  const dom = fixture(panel);
  try {
    const result = {
      verdict: '保留已取数据',
      level: 'info',
      metrics: [],
      missing: [{ field: 'judgment', reason: '判断 profile 含工具' }],
      process: [],
      next: [],
      bullets: ['synthetic 量100'],
      links: [],
      artifacts: [],
    };
    const row = {
      id: 'failed',
      title: 'failed',
      action: 'seo.keyword_check',
      status: 'failed',
      render_as: 'general.task',
      reason: '判断 profile 含工具',
      result,
    };
    renderDashboard(
      dom.window.document,
      { enabled: true, ready: true, suggestions: [row] },
      { command: async () => {} },
    );
    const doc = dom.window.document,
      detail = doc.createElement('section');
    doc.body.append(detail);
    assert.match(doc.querySelector('#results').textContent, /判断 配置 含工具/);
    assert.ok(doc.querySelector('#results [data-action=open_result]'));
    renderResult(doc, detail, row, { command: async () => {}, full: true });
    assert.match(detail.textContent, /判断 配置 含工具/);
    assert.match(detail.textContent, /synthetic 量100/);
    row.completion_status = 'partial';
    renderDashboard(
      dom.window.document,
      { enabled: true, ready: true, suggestions: [row] },
      { command: async () => {} },
    );
    assert.match(dom.window.document.querySelector('#results').textContent, /部分完成（缺 1 项）/);
    assert.match(dom.window.document.querySelector('.meta .st').textContent, /部分完成（缺 1 项）/);
  } finally {
    dom.window.close();
  }
});
