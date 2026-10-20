import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderDashboard, PanelViews } from '../../native-extension/copilot-view.mjs';
import { mountControls } from '../../native-extension/copilot-controls.mjs';
import { BasketPanel } from '../../native-extension/copilot-basket.mjs';
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

test('system dark theme targets the shadow host inside the host selector', async () => {
  const brand = await readFile(
    new URL('../../native-extension/brand.css', import.meta.url),
    'utf8',
  );
  // 中文注释：Edge 已实核 :host:not(...) 不匹配宿主，必须把条件放进 :host(...)。
  assert.match(brand, /:host\(:not\(\[data-theme="light"\]\)\)/);
  assert.doesNotMatch(brand, /:host:not\(/);
});

test('sidebar scrolling rules do not clip the independent result document', async () => {
  for (const file of ['copilot-panel.html', 'copilot-result.html']) {
    const dom = new JSDOM(
      await readFile(new URL(`../../native-extension/${file}`, import.meta.url), 'utf8'),
    );
    try {
      const doc = dom.window.document,
        result = file === 'copilot-result.html',
        style = doc.createElement('style');
      style.textContent =
        css +
        (result
          ? await readFile(
              new URL('../../native-extension/copilot-result.css', import.meta.url),
              'utf8',
            )
          : '');
      doc.head.append(style);
      const body = dom.window.getComputedStyle(doc.body);
      if (result) {
        assert.notEqual(body.overflow, 'hidden');
        assert.notEqual(
          dom.window.getComputedStyle(doc.getElementById('work-view')).height,
          '100dvh',
        );
      } else {
        assert.equal(body.overflow, 'hidden');
        assert.equal(
          dom.window.getComputedStyle(doc.getElementById('work-scroll')).overflow,
          'auto',
        );
      }
    } finally {
      dom.window.close();
    }
  }
});

test('quiet operations keeps long titles readable and task actions below the copy', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  try {
    const style = doc.createElement('style');
    style.textContent =
      (await readFile(new URL('../../native-extension/brand.css', import.meta.url), 'utf8')) + css;
    doc.head.append(style);
    renderDashboard(
      doc,
      {
        enabled: true,
        ready: true,
        suggestions: [task('long', { title: 'A long task title '.repeat(12) })],
      },
      { command: async () => ({}) },
    );
    const computed = (selector) => dom.window.getComputedStyle(doc.querySelector(selector));
    assert.equal(computed('.task-heading h3').whiteSpace, 'normal');
    assert.equal(computed('.task > .actions').flexDirection, 'row');
    assert.equal(computed('.task > .actions button').minHeight, '44px');
    assert.equal(computed('.task-context .object').whiteSpace, 'normal');
    assert.ok(doc.querySelector('#work-scroll #pending'));
    assert.ok(doc.querySelector('#work-scroll #local-tools'));
  } finally {
    dom.window.close();
  }
});

const basketPlan = {
  token: 'fixture-estimate',
  count: 1,
  task_count: 1,
  call_upper_bound: 2,
  model_calls: 0,
  estimated_tokens: 0,
  timeout_upper_seconds: 30,
  tools: [],
};
test('settings Escape belongs to an open modal before navigating back', () => {
  const dom = new JSDOM(html),
    doc = dom.window.document,
    views = new PanelViews(doc);
  try {
    views.show('settings');
    const modal = doc.getElementById('agent-setup-dialog');
    modal.setAttribute('open', '');
    const escape = () =>
      doc.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    escape();
    assert.equal(views.current, 'settings');
    modal.removeAttribute('open');
    escape();
    assert.equal(views.current, 'work');
  } finally {
    dom.window.close();
  }
});
test('modal Tab wraps at both edges and ignores hidden or disabled controls', () => {
  const dom = new JSDOM(
      '<dialog open><button id="first">Cancel</button><button hidden>Hidden</button><button disabled>Disabled</button><button id="last">Confirm</button></dialog>',
    ),
    doc = dom.window.document,
    controls = mountControls(doc);
  try {
    for (const button of doc.querySelectorAll('button'))
      button.getClientRects = () => (button.hidden ? [] : [{}]);
    const press = (shiftKey = false) => {
      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      doc.activeElement.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    };
    doc.getElementById('last').focus();
    press();
    assert.equal(doc.activeElement.id, 'first');
    press(true);
    assert.equal(doc.activeElement.id, 'last');
  } finally {
    controls.dispose();
    dom.window.close();
  }
});

test('basket selections remain checkboxes rather than becoming interface switches', () => {
  const dom = new JSDOM(
      '<input type="checkbox" id="setting"><details id="work-basket"><input type="checkbox" id="selection"></details>',
    ),
    doc = dom.window.document,
    controls = mountControls(doc);
  try {
    assert.equal(doc.getElementById('setting').getAttribute('role'), 'switch');
    assert.equal(doc.getElementById('selection').getAttribute('role'), null);
    assert.equal(doc.getElementById('selection').classList.contains('smooth-switch'), false);
  } finally {
    controls.dispose();
    dom.window.close();
  }
});
function basketFixture(request) {
  const dom = new JSDOM('<details id="work-basket" open></details>'),
    panel = new BasketPanel(dom.window.document, request);
  panel.update({ revision: 1, items: [{ id: 'one', type: 'keyword', value: 'sample' }] });
  const check = panel.root.querySelector('input');
  check.checked = true;
  check.onchange();
  const find = (text) =>
    [...panel.root.querySelectorAll('button')].find((button) => button.textContent === text);
  return { dom, panel, check, find };
}
test('changing basket selection invalidates an already visible estimate', async () => {
  const calls = [],
    f = basketFixture(async (name) => {
      calls.push(name);
      return basketPlan;
    });
  try {
    await f.find('批量查词').onclick();
    const staleConfirm = f.find('确认执行');
    assert.ok(staleConfirm);
    f.check.checked = false;
    f.check.onchange();
    assert.equal(f.find('确认执行'), undefined);
    await staleConfirm.onclick();
    assert.deepEqual(calls, ['basket_plan']);
  } finally {
    f.dom.window.close();
  }
});
test('basket discards a delayed estimate after selection changes and locks duplicate requests', async () => {
  let resolve;
  const pending = new Promise((done) => {
      resolve = done;
    }),
    calls = [],
    f = basketFixture(async (name) => {
      calls.push(name);
      return pending;
    });
  try {
    const first = f.find('批量查词').onclick();
    const duplicate = f.find('批量扩词').onclick();
    f.check.checked = false;
    f.check.onchange();
    resolve(basketPlan);
    await Promise.all([first, duplicate]);
    assert.deepEqual(calls, ['basket_plan']);
    assert.equal(f.find('确认执行'), undefined);
  } finally {
    resolve(basketPlan);
    f.dom.window.close();
  }
});
