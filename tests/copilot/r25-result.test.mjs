import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderResult } from '../../native-extension/copilot-result-view.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
const common = {
  verdict: '已完成任务',
  level: 'info',
  metrics: [],
  missing: [],
  process: ['来自本地任务记录'],
  next: [],
};
function fixture() {
  const dom = new JSDOM('<article></article><p id="notice"></p>');
  return { dom, doc: dom.window.document, article: dom.window.document.querySelector('article') };
}
function dialogFixture(doc) {
  const dialog = doc.getElementById('result-dialog');
  dialog.showModal = () => {
    dialog.setAttribute('open', '');
    dialog.querySelector('[autofocus]')?.focus();
  };
  dialog.close = () => dialog.removeAttribute('open');
  doc.defaultView.matchMedia = () => ({ matches: true });
  return dialog;
}
test('full result uses titled cards and preserves complete keyword filtering, selection and export', async () => {
  const { dom, doc, article } = fixture(),
    calls = [];
  try {
    renderResult(
      doc,
      article,
      {
        id: 'words',
        action: 'seo.competitor_keywords',
        result: {
          ...common,
          keywords: Array.from({ length: 14 }, (_, i) => ({
            keyword: 'sample ' + i,
            vol: i,
            kd: 14 - i,
          })),
          top_pages: [],
        },
      },
      {
        full: true,
        command: async (name, params) => calls.push([name, params]),
        clipboard: { writeText: async () => {} },
      },
    );
    assert.equal(article.querySelectorAll('.result-card').length, 4);
    assert.equal(article.querySelectorAll('tbody tr').length, 14);
    assert.equal(article.querySelector('.result-details').tagName, 'SECTION');
    assert.doesNotMatch(article.textContent, /展开结果|过程与来源|打开全表|无档位/);
    const box = article.querySelector('tbody input');
    box.checked = true;
    box.onchange();
    await [...article.querySelectorAll('button')]
      .find((button) => button.textContent === '批量查词')
      .onclick();
    assert.deepEqual(calls[0], [
      'batch',
      { id: 'words', operation: 'check', keywords: ['sample 0'] },
    ]);
    const filter = article.querySelector('input[type=search]');
    filter.value = 'sample 13';
    filter.oninput();
    assert.equal(article.querySelectorAll('tbody tr').length, 1);
    await [...article.querySelectorAll('button')]
      .find((button) => button.textContent === '导出 CSV')
      .onclick();
    assert.deepEqual(calls.at(-1), ['export_results', { id: 'words', keywords: ['sample 13'] }]);
  } finally {
    dom.window.close();
  }
});
test('full workflow retains step context and selectable non-keyword records', async () => {
  const { dom, doc, article } = fixture(),
    calls = [];
  try {
    renderResult(
      doc,
      article,
      {
        id: 'flow',
        action: 'workflow.run',
        result: {
          ...common,
          steps: [{ label: '读取页面', status: 'completed', count: 12, source: 'fixture' }],
          records: [
            { domain: 'example.test', source: 'fixture' },
            { keyword: 'word', vol: 2 },
          ],
          artifacts: [],
        },
      },
      { full: true, command: async (name, params) => calls.push([name, params]) },
    );
    assert.match(article.textContent, /读取页面/);
    assert.match(article.textContent, /example.test/);
    const box = article.querySelector('tbody input');
    box.checked = true;
    box.onchange();
    await [...article.querySelectorAll('button')]
      .find((button) => button.textContent === '加入工作篮')
      .onclick();
    assert.deepEqual(calls[0][1].items, [{ type: 'domain', value: 'example.test', source: '' }]);
  } finally {
    dom.window.close();
  }
});
test('full typed results render trends, SERP, exports and generic records without HTML execution', () => {
  const cases = [
    [
      'seo.trends',
      {
        pattern: 'rising',
        series: [
          {
            keyword: 'word',
            region: 'US',
            period: '12m',
            points: [
              { date: '2026-01', value: 10 },
              { date: '2026-02', value: 80 },
            ],
          },
        ],
      },
    ],
    [
      'seo.serp_breakdown',
      { results: [{ rank: 1, domain: 'example.test', page_type: 'tool' }], gaps: ['待补信息'] },
    ],
    [
      'table.export',
      { export: { pages: 2, rows: 24, files: [{ id: 'file', path: '/local/export.csv' }] } },
    ],
    [
      'general.task',
      {
        bullets: ['<img src=x onerror=alert(1)>'],
        text: '<script>alert(1)</script>',
        records: [{ name: '样例', value: 3 }],
        links: [
          { label: 'unsafe', url: 'javascript:alert(1)' },
          { label: 'safe', url: 'https://example.test' },
        ],
      },
    ],
  ];
  for (const [action, result] of cases) {
    const { dom, doc, article } = fixture();
    try {
      renderResult(
        doc,
        article,
        { id: 'test', action, result: { ...common, ...result } },
        { full: true, command: async () => {} },
      );
      assert.ok(article.querySelector('.result-details h2'));
      assert.equal(article.querySelector('img,script,iframe'), null);
      assert.equal(article.querySelector('a[href^="javascript:"]'), null);
      if (action === 'seo.trends') assert.equal(article.querySelectorAll('svg polyline').length, 1);
      if (action === 'general.task') {
        assert.match(article.textContent, /<script>/);
        assert.equal(article.querySelectorAll('tbody tr').length, 1);
      }
    } finally {
      dom.window.close();
    }
  }
});
test('full keyword analysis keeps SERP and reasons alongside the sortable table', () => {
  const { dom, doc, article } = fixture();
  try {
    renderResult(
      doc,
      article,
      {
        id: 'check',
        action: 'seo.keyword_check',
        result: {
          ...common,
          keyword: 'test',
          intent: '工具',
          tier: '测一页',
          serp: [{ rank: 1, domain: 'small.test', page_type: 'tool' }],
          reasons: ['已核对页面'],
        },
      },
      { full: true, command: async () => {} },
    );
    assert.match(article.textContent, /small.test/);
    assert.match(article.textContent, /已核对页面/);
  } finally {
    dom.window.close();
  }
});
test('result opening validates the saved result before opening an active modal tab and keeps the default background tab', async () => {
  const calls = [],
    api = {
      runtime: { getURL: (path) => 'chrome-extension://fixture/' + path },
      tabs: { create: async (value) => calls.push(['tab', value]) },
      windows: { create: async (value) => calls.push(['window', value]) },
    },
    instance = {
      api,
      request: async (name, params) => {
        calls.push(['request', name, params]);
        return { id: params.id };
      },
    };
  await CopilotBackground.prototype.localCommand.call(instance, 'open_result', {
    id: 'a&b',
    popup: true,
    url: 'https://evil.test',
  });
  assert.deepEqual(calls, [
    ['request', 'result', { id: 'a&b' }],
    [
      'tab',
      {
        url: 'chrome-extension://fixture/copilot-result.html?id=a%26b',
        active: true,
      },
    ],
  ]);
  calls.length = 0;
  await CopilotBackground.prototype.localCommand.call(instance, 'open_result', { id: 'a' });
  assert.deepEqual(calls.at(-1), [
    'tab',
    { url: 'chrome-extension://fixture/copilot-result.html?id=a', active: false },
  ]);
  instance.request = async () => {
    throw Error('missing');
  };
  calls.length = 0;
  await assert.rejects(
    () =>
      CopilotBackground.prototype.localCommand.call(instance, 'open_result', {
        id: 'gone',
        popup: true,
      }),
    /missing/,
  );
  assert.equal(calls.length, 0);
});
test('result window provides result and task-log tabs and shares the extension CSP', async () => {
  const html = await readFile(
      new URL('../../native-extension/copilot-result.html', import.meta.url),
      'utf8',
    ),
    source = await readFile(
      new URL('../../native-extension/copilot-result.mjs', import.meta.url),
      'utf8',
    );
  assert.match(html, /id="result-task-log"/);
  assert.match(html, /id="result-data-tab"/);
  assert.doesNotMatch(html, /id="result-all-logs"/);
  assert.equal(new JSDOM(html).window.document.querySelectorAll('[role=tab]').length, 2);
  assert.match(html, /copilot-result.css/);
  assert.match(source, /command\('result',\s*\{\s*id\s*\}\)/);
  assert.match(source, /logs\.open\(row\)/);
  assert.doesNotMatch(source, /logs\.open\(null\)/);
  assert.match(source, /copilot\.logs/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});
test('mounted result popup loads saved instance, streams task logs, restores focus and handles stale IDs', async () => {
  const html = await readFile(
      new URL('../../native-extension/copilot-result.html', import.meta.url),
      'utf8',
    ),
    { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  for (const stale of [false, true]) {
    const dom = new JSDOM(html, { url: 'chrome-extension://fixture/copilot-result.html?id=one' }),
      doc = dom.window.document,
      listeners = new Set(),
      calls = [],
      api = {
        i18n: { getUILanguage: () => 'zh-CN' },
        runtime: {
          onMessage: {
            addListener: (fn) => listeners.add(fn),
            removeListener: (fn) => listeners.delete(fn),
          },
          sendMessage: async (value) => {
            calls.push(value);
            if (value.command === 'result')
              return stale
                ? { error: 'missing' }
                : {
                    result: {
                      id: 'one',
                      title: '选中结果',
                      status: 'completed',
                      action: 'general.task',
                      params: {},
                      result: { ...common, bullets: ['本地结果'], links: [], artifacts: [] },
                    },
                  };
            if (value.command === 'logs_read')
              return {
                result: {
                  revision: 1,
                  entries: [
                    {
                      id: 1,
                      time: 1,
                      type: 'execution',
                      event: 'execute_start',
                      details: { task_id: 'one' },
                    },
                  ],
                },
              };
            throw Error('unexpected command');
          },
        },
      };
    let mounted;
    try {
      dialogFixture(doc);
      mounted = await mountResultDocument(doc, api);
      assert.deepEqual(calls[0].params, { id: 'one' });
      assert.equal(doc.getElementById('result').getAttribute('aria-busy'), 'false');
      if (stale) {
        assert.match(doc.getElementById('notice').textContent, /结果已清除/);
        assert.equal(doc.getElementById('result-task-log').disabled, true);
      } else {
        assert.equal(doc.getElementById('result-title').textContent, '选中结果');
        const button = doc.getElementById('result-task-log');
        button.focus();
        await button.onclick();
        assert.equal(!!doc.getElementById('work-view').inert, false);
        assert.equal(doc.getElementById('result-data-pane').hidden, true);
        assert.equal(doc.getElementById('result-log-pane').hidden, false);
        assert.equal(doc.querySelectorAll('.task-log-card').length, 1);
        for (const listener of listeners)
          listener({
            type: 'copilot.logs',
            event: {
              log_revision: 2,
              entries: [
                {
                  id: 2,
                  time: 2,
                  type: 'execution',
                  event: 'execute_complete',
                  details: { task_id: 'one' },
                },
              ],
            },
          });
        assert.equal(doc.querySelectorAll('.task-log-card').length, 2);
        await mounted.selectTab(0);
        assert.equal(doc.getElementById('result-data-pane').hidden, false);
        assert.equal(doc.getElementById('result-log-pane').hidden, true);
        assert.equal(calls.filter((call) => call.command === 'logs_read').length, 1);
        await mounted.selectTab(1);
        assert.equal(calls.filter((call) => call.command === 'logs_read').length, 1);
      }
    } finally {
      mounted?.dispose();
      assert.equal(listeners.size, 0);
      dom.window.close();
    }
  }
});
test('full trends show real axes, dates and keyboard readable points with an accessible data table and no disclosure', () => {
  const { dom, doc, article } = fixture(),
    points = [
      { date: '2026-01', value: 12 },
      { date: '2026-06', value: 0 },
      { date: '2026-12', value: 93 },
    ];
  try {
    renderResult(
      doc,
      article,
      {
        id: 'chart',
        action: 'seo.trends',
        result: {
          ...common,
          pattern: 'seasonal',
          series: [{ keyword: '<img src=x>', region: 'US', period: '2026', points }],
          peak_months: [],
        },
      },
      { full: true, command: async () => {} },
    );
    const svg = article.querySelector('svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 640 240');
    assert.deepEqual(
      [...svg.querySelectorAll('text')].map((node) => node.textContent),
      ['0', '50', '100', '2026-01', '2026-06', '2026-12'],
    );
    assert.equal(svg.querySelectorAll('.trend-grid').length, 3);
    assert.equal(article.querySelector('details'), null);
    assert.doesNotMatch(article.textContent, /曲线数据|展开结果|过程与来源/);
    assert.equal(article.querySelector('img'), null);
    const dots = [...svg.querySelectorAll('circle')];
    assert.equal(dots.length, points.length);
    assert.deepEqual(
      dots.map((dot) => dot.querySelector('title').textContent),
      points.map((point) => `${point.date} · ${point.value}`),
    );
    assert.ok(dots.every((dot) => dot.getAttribute('tabindex') === '0'));
    dots[1].dispatchEvent(new dom.window.Event('focus'));
    assert.equal(article.querySelector('output').textContent, '2026-06 · 0');
    assert.deepEqual(
      [...article.querySelectorAll('.trend-data-table tbody tr')].map((row) =>
        [...row.cells].map((cell) => cell.textContent),
      ),
      points.map((point) => [point.date, String(point.value)]),
    );
    assert.equal(dots[1].getAttribute('cy'), '184');
  } finally {
    dom.window.close();
  }
});
test('English result windows set language before creating trend controls and raw-data headings', async () => {
  const html = await readFile(
      new URL('../../native-extension/copilot-result.html', import.meta.url),
      'utf8',
    ),
    { mountResultDocument } = await import('../../native-extension/copilot-result.mjs'),
    dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document;
  const row = {
    id: 'one',
    title: 'Trend evidence',
    status: 'completed',
    action: 'seo.trends',
    params: {},
    result: {
      ...common,
      pattern: 'stable',
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
  };
  const api = {
    i18n: { getUILanguage: () => 'en-US' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({ result: row }),
    },
  };
  let mounted;
  try {
    dialogFixture(doc);
    mounted = await mountResultDocument(doc, api);
    assert.equal(doc.documentElement.lang, 'en');
    assert.match(doc.querySelector('.trend-point-reading').textContent, /Focus or hover a point/);
    assert.equal(doc.querySelector('.trend-data-table th').textContent, 'Date');
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('detail tabs retain metadata, keyboard focus and per-pane position while loading only task logs on demand', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document,
    calls = [];
  const api = {
    i18n: { getUILanguage: () => 'en-US' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message) => {
        calls.push(message);
        return {
          result:
            message.command === 'result'
              ? {
                  id: 'one',
                  title: 'Completed analysis',
                  status: 'completed',
                  started_at: 10,
                  finished_at: 12.5,
                  result: '# Summary\n\n**Source** checked.',
                }
              : { entries: [], revision: 1 },
        };
      },
    },
  };
  let mounted;
  try {
    dialogFixture(doc);
    mounted = await mountResultDocument(doc, api);
    assert.equal(doc.querySelectorAll('[role=tab]').length, 2);
    assert.equal(doc.getElementById('result-data-tab').getAttribute('aria-selected'), 'true');
    assert.match(doc.getElementById('result-elapsed').textContent, /2\.5s/);
    assert.match(doc.getElementById('result-status').textContent, /Completed/);
    assert.equal(doc.querySelector('#result h1').textContent, 'Summary');
    assert.equal(calls.filter((call) => call.command === 'logs_read').length, 0);
    doc.getElementById('result-data-pane').scrollTop = 150;
    const resultTab = doc.getElementById('result-data-tab');
    resultTab.focus();
    resultTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.activeElement.id, 'result-task-log');
    assert.equal(doc.getElementById('result-task-log').getAttribute('aria-selected'), 'true');
    assert.equal(calls.filter((call) => call.command === 'logs_read').length, 1);
    assert.match(doc.getElementById('result-log-pane').textContent, /No execution logs/);
    doc
      .getElementById('result-task-log')
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(doc.activeElement, resultTab);
    assert.equal(doc.getElementById('result-data-pane').scrollTop, 150);
    assert.equal(doc.getElementById('result-title').textContent, 'Completed analysis');
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('result loading and failure states permit an explicit retry and preserve falsy returned data', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document;
  let resolve, reject;
  const api = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: () =>
        new Promise((done, error) => {
          resolve = () =>
            done({ result: { id: 'one', status: 'completed', title: '零值结果', result: 0 } });
          reject = () => error(Error('PRIVATE_FAILURE'));
        }),
    },
  };
  let mounted;
  try {
    dialogFixture(doc);
    const mounting = mountResultDocument(doc, api);
    assert.equal(doc.getElementById('result').getAttribute('aria-busy'), 'true');
    assert.match(doc.getElementById('result').textContent, /正在读取/);
    reject();
    mounted = await mounting;
    assert.equal(doc.getElementById('result').getAttribute('aria-busy'), 'false');
    assert.doesNotMatch(doc.body.textContent, /PRIVATE/);
    const retry = doc.querySelector('#result button').onclick();
    resolve();
    await retry;
    assert.equal(doc.getElementById('result').textContent, '0');
    assert.equal(doc.getElementById('result-task-log').disabled, false);
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('large native result modal closes by button, Escape or backdrop and never treats content dragging as a backdrop click', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  for (const mode of ['button', 'escape', 'backdrop']) {
    const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
      doc = dom.window.document,
      removed = [];
    const dialog = dialogFixture(doc);
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 1000, bottom: 800 });
    const api = {
      i18n: { getUILanguage: () => 'zh-CN' },
      tabs: { getCurrent: async () => ({ id: 77 }), remove: async (id) => removed.push(id) },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async () => ({
          result: { id: 'one', status: 'completed', title: '详情', result: '内容' },
        }),
      },
    };
    let mounted;
    try {
      mounted = await mountResultDocument(doc, api);
      assert.equal(dialog.open, true);
      assert.equal(dialog.getAttribute('aria-labelledby'), 'result-title');
      assert.equal(doc.activeElement.id, 'result-close');
      if (mode === 'button') await doc.getElementById('result-close').onclick();
      else if (mode === 'escape') {
        const cancel = new dom.window.Event('cancel', { cancelable: true });
        dialog.dispatchEvent(cancel);
        assert.equal(cancel.defaultPrevented, true);
      } else {
        dialog.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', { clientX: 200, clientY: 200 }),
        );
        dialog.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 20, clientY: 20 }));
        assert.deepEqual(removed, []);
        dialog.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', { clientX: 20, clientY: 20 }),
        );
        dialog.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 20, clientY: 20 }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(removed, [77]);
      assert.equal(dialog.open, false);
    } finally {
      mounted?.dispose();
      dom.window.close();
    }
  }
});

test('failed result-tab close keeps the modal readable and supports explicit retry', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document,
    dialog = dialogFixture(doc);
  let fail = true;
  const api = {
    i18n: { getUILanguage: () => 'en-US' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({
        result: { id: 'one', title: 'Details', status: 'completed', result: 'Preserved result' },
      }),
    },
  };
  let mounted;
  try {
    mounted = await mountResultDocument(doc, api, {
      closePage: async () => {
        if (fail) throw Error('PRIVATE_ERROR');
      },
    });
    await mounted.close();
    assert.equal(dialog.open, true);
    assert.equal(dialog.dataset.closing, undefined);
    assert.match(doc.getElementById('notice').textContent, /Could not close/);
    assert.equal(doc.getElementById('result').textContent, 'Preserved result');
    assert.doesNotMatch(doc.body.textContent, /PRIVATE/);
    fail = false;
    await mounted.close();
    assert.equal(dialog.open, false);
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('modal Tab and Shift+Tab cycle visible enabled controls without reaching the underlying page', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document,
    dialog = dialogFixture(doc);
  const api = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({
        result: { id: 'one', title: '详情', status: 'completed', result: '数据' },
      }),
    },
  };
  let mounted;
  try {
    mounted = await mountResultDocument(doc, api);
    const first = doc.getElementById('result-close'),
      last = doc.getElementById('result-data-pane');
    for (const node of [
      first,
      doc.getElementById('result-data-tab'),
      doc.getElementById('result-task-log'),
      last,
    ])
      node.getClientRects = () => [{}];
    last.focus();
    const forward = new dom.window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    last.dispatchEvent(forward);
    assert.equal(forward.defaultPrevented, true);
    assert.equal(doc.activeElement, first);
    const backward = new dom.window.KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(backward);
    assert.equal(backward.defaultPrevented, true);
    assert.equal(doc.activeElement, last);
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('document preview builds safe chapter navigation without changing results or source verification', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document;
  dialogFixture(doc);
  const row = {
    id: 'one',
    title: '阅读来源',
    status: 'completed',
    action: 'assist.task',
    standard_task: true,
    params: { task: '详细任务上下文' },
    result: {
      ...common,
      sections: [
        {
          title: '主题与结论',
          text: '原始结果第一段',
          sources: [{ id: 'source', quote: '逐字引用' }],
        },
        { title: '<img onerror=alert(1)>', text: '原始结果第二段', sources: [] },
      ],
    },
  };
  const original = structuredClone(row),
    calls = [];
  const api = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message) => {
        calls.push(message);
        return { result: row };
      },
    },
  };
  let mounted;
  try {
    mounted = await mountResultDocument(doc, api);
    await new Promise((resolve) => setImmediate(resolve));
    const buttons = [...doc.querySelectorAll('#result-outline-items button')];
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ['结果概览', '主题与结论', '<img onerror=alert(1)>'],
    );
    assert.equal(doc.getElementById('result-outline').hidden, false);
    assert.equal(doc.getElementById('result-layout').dataset.mode, 'document');
    assert.equal(doc.querySelector('#result-outline img'), null);
    buttons[1].click();
    assert.equal(buttons[1].getAttribute('aria-current'), 'location');
    assert.equal(doc.activeElement.textContent, '主题与结论');
    assert.match(doc.querySelector('.result-verification').textContent, /尚无来源核对记录/);
    assert.match(doc.querySelector('.source-quote').textContent, /逐字引用/);
    assert.equal(doc.querySelector('.result-window-header #result-context'), null);
    assert.equal(
      doc.querySelector('.result-context-details #result-context').textContent,
      '详细任务上下文',
    );
    const information = doc.querySelector('.result-context-details');
    information.open = true;
    doc
      .getElementById('result')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(information.open, false);
    information.open = true;
    await mounted.selectTab(0);
    assert.equal(information.open, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(row, original);
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('data results keep the wide layout and chapter navigation updates only for current content', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document;
  dialogFixture(doc);
  let result = {
    ...common,
    sections: [
      { title: 'First', text: 'Source', sources: [] },
      { title: 'Second', text: 'Source', sources: [] },
    ],
  };
  const api = {
    i18n: { getUILanguage: () => 'en-US' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({
        result: {
          id: 'one',
          title: 'Results',
          status: 'completed',
          action: 'assist.task',
          standard_task: true,
          params: {},
          result,
        },
      }),
    },
  };
  let mounted;
  try {
    mounted = await mountResultDocument(doc, api);
    assert.equal(doc.getElementById('result-outline-label').textContent, 'On this page');
    assert.equal(doc.querySelector('#result-outline-items button').textContent, 'Overview');
    result = [{ value: 0 }, { value: 0 }];
    await mounted.reload();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.getElementById('result-layout').dataset.mode, 'data');
    assert.equal(doc.getElementById('result-outline').hidden, true);
    assert.equal(doc.getElementById('result-outline-items').childElementCount, 0);
    assert.equal(doc.getElementById('result-format').textContent, 'Table preview');
    assert.equal(doc.querySelectorAll('#result tbody tr').length, 2);
    assert.deepEqual(
      [...doc.querySelectorAll('#result tbody td')].map((node) => node.textContent),
      ['0', '0'],
    );
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('responsive outline keeps DOM and focus order consistent with mobile and desktop layouts', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
    doc = dom.window.document;
  dialogFixture(doc);
  let change,
    removed = false;
  const media = {
    matches: false,
    addEventListener: (name, handler) => {
      change = handler;
    },
    removeEventListener: () => {
      removed = true;
    },
  };
  dom.window.matchMedia = (query) => (query.includes('min-width') ? media : { matches: true });
  const api = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async () => ({
        result: { id: 'one', status: 'completed', result: '## 第一节\n文字\n## 第二节\n文字' },
      }),
    },
  };
  let mounted;
  try {
    mounted = await mountResultDocument(doc, api);
    assert.equal(doc.getElementById('result-layout').firstElementChild.id, 'result-outline');
    assert.equal(doc.getElementById('result-outline').open, false);
    media.matches = true;
    change();
    assert.equal(doc.getElementById('result-layout').firstElementChild.id, 'result');
    assert.equal(doc.getElementById('result-outline').open, true);
    mounted.dispose();
    assert.equal(removed, true);
  } finally {
    mounted?.dispose();
    dom.window.close();
  }
});

test('result task usage shows actual channel counts, distinguishes estimates and never invents missing usage', async () => {
  const html = await readFile(
    new URL('../../native-extension/copilot-result.html', import.meta.url),
    'utf8',
  );
  const { mountResultDocument } = await import('../../native-extension/copilot-result.mjs');
  for (const sample of [
    {
      tokens: 2599,
      usage: { input: 2281, cache_read: 0, output: 318 },
      model: 'openai-codex:gpt-6-luna',
    },
    { tokens: 3000, estimated_tokens: 400 },
    {},
  ]) {
    const dom = new JSDOM(html, { url: 'https://example.test/result?id=one' }),
      doc = dom.window.document;
    dialogFixture(doc);
    const api = {
      i18n: { getUILanguage: () => 'zh-CN' },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async () => ({
          result: { id: 'one', title: '任务', status: 'completed', result: '数据', ...sample },
        }),
      },
    };
    let mounted;
    try {
      mounted = await mountResultDocument(doc, api);
      const field = doc.getElementById('result-tokens');
      if (!('tokens' in sample)) {
        assert.equal(field.hidden, true);
        continue;
      }
      assert.equal(field.hidden, false);
      if (sample.estimated_tokens) {
        assert.match(field.textContent, /含估算/);
        assert.match(field.title, /包含估算/);
      } else {
        assert.equal(field.textContent, '2,599 tokens');
        assert.match(field.title, /输入 2,281/);
        assert.match(field.title, /缓存读取 0/);
        assert.match(field.title, /输出 318/);
        assert.match(field.title, /实际用量/);
      }
    } finally {
      mounted?.dispose();
      dom.window.close();
    }
  }
});
