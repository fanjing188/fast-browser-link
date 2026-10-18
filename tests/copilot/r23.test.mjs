import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { STATES, statusNode, icon } from '../../native-extension/ui-design.mjs';
import {
  renderDashboard,
  defaultDashboardTab,
  selectDashboardTab,
} from '../../native-extension/copilot-view.mjs';
import { BasketPanel } from '../../native-extension/copilot-basket.mjs';
import { LogPanel } from '../../native-extension/copilot-logs.mjs';
import { localize } from '../../native-extension/copilot-i18n.mjs';
import { createOverlayView } from '../../native-extension/overlay-view.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const fixture = () => new JSDOM(html, { url: 'https://example.test/' });
const state = { locale: 'zh', enabled: true, ready: true, suggestions: [] };
test('ten states have unique shapes, bilingual text and semantic colors from the shared tokens', async () => {
  const dom = new JSDOM();
  try {
    assert.equal(Object.keys(STATES).length, 10);
    assert.equal(new Set(Object.values(STATES).map((row) => row.shape)).size, 10);
    const css = await readFile(
      new URL('../../native-extension/brand.css', import.meta.url),
      'utf8',
    );
    for (const [key, value] of Object.entries(STATES)) {
      const node = statusNode(dom.window.document, key);
      assert.ok(node.querySelector('svg'));
      assert.equal(node.textContent, value.zh);
      assert.equal(node.dataset.shape, value.shape);
      assert.ok(node.classList.contains(value.tone));
      assert.match(css, new RegExp('\\.st\\.' + value.tone));
      assert.equal(statusNode(dom.window.document, key, { language: 'en' }).textContent, value.en);
    }
    assert.equal(icon(dom.window.document, 'gear').getAttribute('viewBox'), '0 0 16 16');
    assert.match(css, /stroke-width:1.6/);
    assert.match(css, /data-theme="dark"/);
  } finally {
    dom.window.close();
  }
});
test('four counted tabs select new content once, retain manual selection on polling and support arrows', () => {
  const dom = fixture(),
    doc = dom.window.document;
  try {
    const row = {
      id: 'one',
      title: '合成建议',
      why: '有公开证据',
      params: { keyword: 'sample' },
      action: 'general.task',
      status: 'pending',
    };
    renderDashboard(doc, { ...state, suggestions: [row] }, { command: async () => {} });
    assert.equal(doc.querySelectorAll('[role=tab]').length, 4);
    assert.equal(doc.documentElement.dataset.dashboardTab, 'pending');
    assert.equal(doc.getElementById('suggestions-count').textContent, '1');
    doc.querySelector('[data-tab=logs]').click();
    renderDashboard(doc, { ...state, suggestions: [row] }, { command: async () => {} });
    assert.equal(doc.documentElement.dataset.dashboardTab, 'logs');
    renderDashboard(
      doc,
      { ...state, suggestions: [{ ...row, status: 'executing', started_at: 2 }] },
      { command: async () => {} },
    );
    assert.equal(doc.documentElement.dataset.dashboardTab, 'running');
    const current = doc.querySelector('[data-tab=running]');
    current.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    assert.equal(doc.documentElement.dataset.dashboardTab, 'results');
    assert.equal(doc.activeElement.dataset.tab, 'results');
    assert.equal(
      defaultDashboardTab([{ id: 'x', status: 'failed', finished_at: 10 }], []),
      'results',
    );
  } finally {
    dom.window.close();
  }
});
test('healthy connections occupy no row, failure exposes repair and basket strip appears only with items', () => {
  const dom = fixture(),
    doc = dom.window.document;
  try {
    renderDashboard(doc, state);
    assert.equal(doc.getElementById('connection-notice').hidden, true);
    renderDashboard(doc, { ...state, diagnostic: 'bridge_disconnected' });
    assert.equal(doc.getElementById('connection-notice').hidden, false);
    assert.equal(doc.getElementById('repair-connection').textContent, '重新连接');
    const basket = new BasketPanel(doc, async () => ({}));
    basket.update({ revision: 1, items: [] });
    assert.equal(basket.root.hidden, true);
    basket.update({ revision: 2, items: [{ id: 'k', type: 'keyword', value: 'sample' }] });
    assert.equal(basket.root.hidden, false);
    assert.ok(basket.root.querySelector('.basket-run'));
    assert.equal(doc.getElementById('usage-label').closest('[data-pane]').dataset.pane, 'logs');
    assert.ok(
      doc
        .getElementById('advanced-settings')
        .contains(doc.getElementById('setting-exec_transport')),
    );
    assert.equal(doc.getElementById('advanced-settings').open, false);
  } finally {
    dom.window.close();
  }
});
test('log chips filter errors and each row has time, shape, sentence and duration in order', () => {
  const dom = fixture(),
    doc = dom.window.document,
    logs = new LogPanel(doc, async () => ({}));
  try {
    logs.active = true;
    logs.set({
      revision: 1,
      entries: [
        {
          id: 1,
          time: 1,
          type: 'execution',
          summary: '完成查询',
          error: false,
          details: { duration_ms: 1200 },
        },
        {
          id: 2,
          time: 2,
          type: 'inference',
          summary: '需要登录',
          error: true,
          details: { duration_ms: 200 },
        },
      ],
    });
    doc.querySelector('[data-log-filter=errors]').click();
    const rows = doc.querySelectorAll('.log-line');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.error, 'true');
    assert.equal(rows[0].children.length, 4);
    assert.equal(rows[0].children[0].tagName, 'TIME');
    assert.equal(rows[0].children[1].dataset.shape, 'bad');
    assert.equal(rows[0].children[3].textContent, '0.2s');
  } finally {
    logs.dispose();
    dom.window.close();
  }
});
test('overlay presents failure continuation, completion metrics and takeover without raw diagnostic terms', () => {
  const dom = new JSDOM(),
    view = createOverlayView(dom.window.document, { title: '合成工作流' });
  try {
    view.activity(1, 4, { 页: 2, 行: 100, 出错: 0 });
    view.outcome({ state: 'failed', reason: '请先登录', resumeFrom: 2 });
    assert.equal(view.detail.textContent, '请先登录');
    assert.match(view.bar.textContent, /从第 2 步继续/);
    view.outcome({
      state: 'completed',
      summary: '已保存 Excel',
      completed: 4,
      total: 4,
      metrics: { 页: 12, 行: 596, 重复已去: 4 },
    });
    assert.equal(view.detail.textContent, '已保存 Excel');
    assert.equal(view.bar.querySelectorAll('.stats b').length, 3);
    view.state('paused');
    assert.match(view.detail.textContent, /你已接管/);
  } finally {
    view.dispose();
    dom.window.close();
  }
});
test('ordinary bilingual interface copy excludes internal transport terms outside Advanced', () => {
  for (const language of ['zh', 'en']) {
    const dom = fixture(),
      doc = dom.window.document;
    try {
      renderDashboard(doc, state);
      localize(doc, language);
      doc.getElementById('advanced-settings').remove();
      for (const select of doc.querySelectorAll('select')) select.remove();
      assert.doesNotMatch(doc.body.textContent, /\b(?:ACP|daemon|profile|oneshot)\b/i);
    } finally {
      dom.window.close();
    }
  }
});
