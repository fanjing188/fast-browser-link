import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const css = await readFile(
  new URL('../../native-extension/copilot-panel.css', import.meta.url),
  'utf8',
);
const task = (id, extra = {}) => ({
  id,
  title: `Inspect ${id}`,
  why: 'Check the current page',
  action: 'seo.keyword_check',
  params: { keyword: id },
  status: 'pending',
  risk: 'zero',
  ...extra,
});
for (const locale of ['zh', 'en'])
  test(`pending ${locale} cards omit action icons and free labels while preserving quota and automatic metadata`, async () => {
    const dom = new JSDOM(html),
      doc = dom.window.document,
      calls = [];
    try {
      const suggestions = [
        task('zero'),
        task('quota', { risk: 'quota' }),
        task('automatic', {
          status: 'completed',
          automatic: true,
          result: { verdict: 'Saved result', metrics: [], missing: [] },
        }),
        task('blocked', { missing_capabilities: ['metrics'] }),
      ];
      renderDashboard(
        doc,
        { enabled: true, ready: true, locale, suggestions },
        { command: async (...args) => calls.push(args) },
      );
      assert.equal(doc.querySelector('#pending .task-heading svg'), null);
      assert.equal(doc.querySelector('#pending .free'), null);
      const card = (id) => doc.querySelector(`#pending article[data-id="${id}"]`),
        zero = card('zero'),
        quota = card('quota'),
        automatic = card('automatic'),
        blocked = card('blocked');
      assert.equal(zero.querySelector('.task-heading').children.length, 1);
      assert.equal(zero.querySelector('.task-heading').firstElementChild.tagName, 'H3');
      assert.doesNotMatch(zero.textContent, /免费|\bFree\b/);
      assert.equal(
        quota.querySelector('.cost').textContent,
        locale === 'en' ? 'Uses quota' : '耗额度',
      );
      assert.equal(
        automatic.querySelector('.tag').textContent,
        locale === 'en' ? 'Automatic' : '自动',
      );
      assert.equal(automatic.querySelector('.free,.cost'), null);
      assert.equal(automatic.querySelector('[data-action=execute]'), null);
      assert.equal(blocked.querySelector('[data-action=execute]').disabled, true);
      assert.ok(blocked.querySelector('[data-action=open_capabilities]'));
      assert.equal(zero.querySelector('[data-action=execute]').classList.contains('primary'), true);
      assert.equal(doc.querySelectorAll('#pending .primary').length, 1);
      for (const action of ['open_result', 'task_logs'])
        await automatic.querySelector(`[data-action=${action}]`).onclick();
      await zero.querySelector('[data-action=execute]').onclick();
      await quota.querySelector('[data-action=feedback-later]').onclick();
      await blocked.querySelector('[data-action=execute]').onclick();
      await blocked.querySelector('[data-action=open_capabilities]').onclick();
      assert.deepEqual(calls, [
        ['open_result', { id: 'automatic', popup: true }],
        ['task_logs', { id: 'automatic' }],
        ['execute', { id: 'zero' }],
        ['feedback', { id: 'quota', kind: 'later' }],
        ['open_capabilities', { id: 'blocked' }],
      ]);
    } finally {
      dom.window.close();
    }
  });
test('pending polish preserves similarity ordering, ten suggestion limit and running/result type icons', () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  try {
    const suggestions = [
      ...Array.from({ length: 14 }, (_, index) => task(`other-${index}`)),
      task('current'),
      task('live', { status: 'executing', started_at: 100, step: 'browser_read' }),
      task('done', {
        status: 'completed',
        completion_status: 'completed',
        result: { verdict: 'Saved', metrics: [], missing: [] },
      }),
    ];
    renderDashboard(
      doc,
      {
        enabled: true,
        ready: true,
        locale: 'en',
        tool_context: { current: { object: 'current' } },
        suggestions,
      },
      { command: async () => {} },
    );
    const pending = [...doc.querySelectorAll('#pending article:not([hidden])')];
    assert.equal(pending.length, 10);
    assert.equal(pending[0].dataset.id, 'current');
    assert.equal(doc.getElementById('suggestions-count').textContent, '10');
    assert.ok(pending.every((card) => !card.querySelector('.task-heading svg')));
    for (const group of ['running', 'results']) {
      const symbol = doc.querySelector(`#${group} .task-heading>svg`);
      assert.ok(symbol, group);
      assert.equal(symbol.getAttribute('aria-hidden'), 'true');
    }
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.append(style);
    const heading = pending[0].querySelector('.task-heading'),
      computed = dom.window.getComputedStyle(heading);
    assert.equal(computed.display, 'grid');
    assert.equal(computed.gridTemplateColumns, 'minmax(0,1fr) auto');
    assert.equal(dom.window.getComputedStyle(heading.querySelector('h3')).gridColumn, '1/-1');
    assert.equal(heading.querySelector('.meta'), null);
  } finally {
    dom.window.close();
  }
});
