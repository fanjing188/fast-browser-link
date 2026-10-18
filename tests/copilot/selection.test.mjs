import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  classifySelection,
  selectedText,
  selectionTasks,
  SelectionPopup,
} from '../../native-extension/copilot-selection.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import {
  readTrends,
  readSearch,
  collectBrowserData,
} from '../../native-extension/copilot-browser-data.mjs';
import { uiText, localize } from '../../native-extension/copilot-i18n.mjs';
import { renderResult } from '../../native-extension/copilot-result-view.mjs';
const fixture = () =>
  new JSDOM(
    '<p>image background remover</p><input value="SECRET"><div contenteditable>PRIVATE</div><p id="long">' +
      'a '.repeat(180) +
      '</p>',
    { url: 'https://site.test/?sort=volume&filter=tool' },
  );
function select(doc, element) {
  const selection = doc.getSelection(),
    range = doc.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  range.getBoundingClientRect = () => ({ left: 30, right: 90, top: 40, bottom: 60 });
  return selection;
}
test('selection classification covers Chinese/English, domains, lists and paragraphs', () => {
  for (const word of [
    'image background remover',
    '免费图片背景移除工具',
    'how to remove background',
  ])
    assert.equal(classifySelection(word), 'keyword');
  for (const word of [
    'example.com',
    'https://example.test/path?x=1',
    'https://example.test/path?q=one,two',
  ])
    assert.equal(classifySelection(word), 'domain');
  for (const word of ['alpha\nbeta', 'alpha,beta', '图片，背景'])
    assert.equal(classifySelection(word), 'multiple');
  assert.equal(classifySelection('This is a sentence. It has context.'), 'text');
  assert.equal(classifySelection(''), 'none');
});
test('popup excludes controls/editors, uses closed root, defers 300ms, closes on scroll/Esc/disable', async () => {
  const dom = fixture(),
    doc = dom.window.document,
    calls = [];
  const popup = new SelectionPopup(doc, {
    request: async (command, params) => {
      calls.push([command, params]);
      return { cached: { id: 'old', tier: 'test', at: 1700000000 } };
    },
  });
  try {
    select(doc, doc.querySelector('input'));
    assert.equal(selectedText(doc), null);
    select(doc, doc.querySelector('[contenteditable]'));
    assert.equal(selectedText(doc), null);
    select(doc, doc.querySelector('p'));
    popup.schedule();
    assert.equal(popup.host, undefined);
    await new Promise((resolve) => setTimeout(resolve, 330));
    assert.ok(popup.host);
    assert.equal(popup.host.shadowRoot, null);
    assert.match(popup.root.textContent, /查过 · test/);
    assert.equal(popup.root.querySelectorAll('button').length, 9);
    popup.keydown({ isTrusted: true, key: 'Escape', preventDefault() {} });
    assert.equal(popup.host, null);
    await popup.show();
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(popup.host, null);
    await popup.show();
    popup.setEnabled(false);
    assert.equal(popup.host, null);
    popup.setEnabled(true);
    select(doc, doc.getElementById('long'));
    await popup.show();
    assert.equal(popup.host, null);
    assert.equal(calls.at(-1)[0], 'selection_context');
    assert.ok(calls.at(-1)[1].text.length > 300);
  } finally {
    popup.destroy();
    dom.window.close();
  }
});
test('recommendations use local defaults then relevant inference suggestions without duplicate tasks', () => {
  const local = selectionTasks('sample', { info: { cached: {}, has_trends: false } });
  assert.equal(local.tasks[0].action, 'seo.trends');
  const updated = selectionTasks('sample', {
    suggestions: [
      { status: 'pending', action: 'seo.longtail', params: { keyword: 'sample', market: 'US' } },
    ],
  });
  assert.equal(updated.tasks[0].action, 'seo.longtail');
  assert.equal(updated.tasks[0].params.market, 'US');
  assert.equal(updated.tasks.filter((row) => row.id === 'expand').length, 1);
  assert.equal(
    selectionTasks('sample', { url: 'https://www.google.com/search?q=sample' }).tasks[0].id,
    'serp',
  );
  assert.ok(
    !selectionTasks('example.test').tasks.some((row) => row.action === 'seo.domain_rating'),
  );
  assert.ok(
    selectionTasks('example.test', { info: { capabilities: { domain_rating: true } } }).tasks.some(
      (row) => row.action === 'seo.domain_rating',
    ),
  );
  const english = selectionTasks('alpha\nbeta', { language: 'en' });
  assert.equal(english.tasks[0].label, 'Check keywords');
  assert.deepEqual(english.tasks[0].params.keywords, ['alpha', 'beta']);
});
test('keyboard executes once and closes immediately; updates insert recommendations while open', async () => {
  const dom = fixture(),
    doc = dom.window.document,
    calls = [],
    popup = new SelectionPopup(doc, {
      request: async (...args) => {
        calls.push(args);
        return {};
      },
    });
  try {
    select(doc, doc.querySelector('p'));
    await popup.show();
    popup.setSuggestions([
      {
        status: 'pending',
        action: 'seo.longtail',
        params: { keyword: 'image background remover' },
      },
    ]);
    assert.equal(popup.tasks[0].action, 'seo.longtail');
    let prevented = 0;
    popup.keydown({
      isTrusted: true,
      key: 'Enter',
      preventDefault() {
        prevented++;
      },
      stopPropagation() {},
    });
    assert.equal(popup.host, null);
    assert.equal(prevented, 1);
    assert.equal(calls.at(-1)[0], 'quick_task');
    assert.equal(calls.at(-1)[1].action, 'seo.longtail');
    popup.keydown({ isTrusted: true, key: '1' });
    assert.equal(calls.filter(([command]) => command === 'quick_task').length, 1);
  } finally {
    popup.destroy();
    dom.window.close();
  }
});
test('background fences work pages and de-duplicates selection inference for ten minutes while preserving URL filters', async () => {
  const requests = [];
  const api = {
    runtime: {
      id: 'x',
      getURL: (path) => 'chrome-extension://x/' + path,
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({}) }, session: { set: async () => {} } },
    windows: { get: async () => ({ focused: true }) },
    tabs: {
      sendMessage: async () => {},
      query: async () => [
        { id: 1, windowId: 7, url: 'https://site.test/?sort=volume&filter=tool' },
      ],
    },
  };
  const background = new CopilotBackground(
    api,
    async (method, params) => {
      requests.push([method, params]);
      return {};
    },
    (id) => id === 9,
  );
  background.enabled = true;
  const sender = {
      id: 'x',
      frameId: 0,
      url: 'https://site.test/?sort=volume&filter=tool',
      tab: { id: 1, url: 'https://site.test/?sort=volume&filter=tool' },
    },
    page = { url: 'https://site.test/', title: 'Fixture', items: [] };
  await background.observation(sender, page, '选中 sample');
  await background.observation(sender, page, '选中 sample');
  assert.equal(requests.filter(([method]) => method === 'observe').length, 1);
  assert.equal(requests.find(([method]) => method === 'page_context')[1].url, sender.tab.url);
  assert.equal(
    background.handle(
      { type: 'copilot.selection', command: 'quick_task', params: {} },
      { ...sender, tab: { id: 9 } },
      () => {},
    ),
    false,
  );
});
test('visible trend/search parser refuses hidden/input data; curves carry observed dates and values only', () => {
  const dom = new JSDOM(
    '<h1>Interest over time</h1><table><tr><th>Date</th><th>sample</th></tr><tr><td>2026-01</td><td>38<span hidden>999</span><textarea>PRIVATE_INPUT</textarea></td></tr><tr><td>2026-02</td><td>80</td></tr></table><table hidden><tr><th>Date</th><th>private</th></tr><tr><td>2026-01</td><td>99</td></tr></table><a href="https://rank.test/tool"><h3>Useful tool</h3></a>',
    { url: 'https://www.google.com/search?q=sample' },
  );
  try {
    const data = readTrends(['sample', 'private'], 'US', '12m', dom.window.document);
    assert.equal(data.series.length, 1);
    assert.deepEqual(data.series[0].points, [
      { date: '2026-01', value: 38 },
      { date: '2026-02', value: 80 },
    ]);
    assert.equal(readSearch(dom.window.document).results[0].url, 'https://rank.test/tool');
    dom.window.document.querySelector('h1').textContent = 'Verify you are human';
    assert.equal(readTrends(['sample'], 'US', '12m', dom.window.document).error, 'blocked');
  } finally {
    dom.window.close();
  }
});
test('trend batch uses four contexts per group of five, random pacing, cleanup and no user tab actions', async () => {
  const urls = [],
    reads = [],
    closed = [],
    delays = [];
  const adapter = {
    open: async (url, context) => {
      urls.push([url, context]);
      return { id: urls.length };
    },
    readData: async (work, func, args) => {
      reads.push(args);
      return {
        series: args[0].map((keyword) => ({
          keyword,
          region: args[1],
          period: args[2],
          points: [{ date: '2026-01', value: 30 }],
        })),
      };
    },
    close: async (work) => closed.push(work.id),
  };
  const result = await collectBrowserData(
    adapter,
    {
      kind: 'google_trends',
      params: { keywords: ['a', 'b', 'c', 'd', 'e', 'f'] },
      incognito: true,
    },
    async () => true,
    async (ms) => delays.push(ms),
    () => 0.5,
  );
  assert.equal(urls.length, 8);
  assert.equal(result.series.length, 24);
  assert.equal(closed.length, 8);
  assert.ok(
    urls.every(
      ([url, context]) => new URL(url).hostname === 'trends.google.com' && context.incognito,
    ),
  );
  assert.ok(reads.every((args) => args[0].length <= 5));
  assert.ok(delays.every((ms) => ms === 2250));
  const partial = await collectBrowserData(
    { ...adapter, readData: async () => ({ error: 'blocked' }) },
    { kind: 'google_trends', params: { keyword: 'a' } },
    () => true,
    async () => {},
  );
  assert.equal(partial.series.length, 0);
  assert.match(partial.source, /遇阻/);
});
test('trend result has a labeled chart, raw data expansion and explicit missing-data state', () => {
  const dom = new JSDOM('<article></article>'),
    doc = dom.window.document,
    row = {
      id: 'trend',
      action: 'seo.trends',
      status: 'completed',
      result: {
        verdict: '呈季节性变化',
        level: 'info',
        metrics: [],
        missing: [],
        process: [],
        next: [],
        series: [
          {
            keyword: 'sample',
            region: 'US',
            period: '12m',
            points: [
              { date: '2026-01', value: 20 },
              { date: '2026-02', value: 80 },
            ],
          },
        ],
        pattern: 'seasonal',
        peak_months: ['February'],
      },
    };
  try {
    renderResult(doc, doc.querySelector('article'), row, { command: async () => {} });
    assert.equal(doc.querySelectorAll('svg polyline').length, 1);
    assert.match(doc.querySelector('svg').getAttribute('aria-label'), /0–100/);
  } finally {
    dom.window.close();
  }
});
test('fixed UI supports English without changing user content', () => {
  const dom = new JSDOM(
    '<html lang="zh-CN"><button>查热度趋势</button><p>历史结果 3</p><p data-user-content>查热度趋势</p></html>',
  );
  try {
    localize(dom.window.document, 'en-US');
    assert.equal(dom.window.document.querySelector('button').textContent, 'Check trends');
    assert.equal(dom.window.document.querySelector('p').textContent, 'History 3');
    assert.equal(
      dom.window.document.querySelector('[data-user-content]').textContent,
      '查热度趋势',
    );
    assert.equal(uiText('存词池', 'zh-CN'), '存词池');
  } finally {
    dom.window.close();
  }
});

test('public batch SERP keeps per-keyword results in one acquisition job', async () => {
  const urls = [],
    closed = [];
  const adapter = {
    open: async (url) => {
      urls.push(url);
      return { url };
    },
    readData: async (work) => ({
      results: [{ url: 'https://rank.test/' + new URL(work.url).searchParams.get('q') }],
      source: 'fixture',
    }),
    close: async (work) => closed.push(work.url),
  };
  const data = await collectBrowserData(
    adapter,
    { kind: 'serp_top10', params: { keywords: ['alpha', 'beta', 'gamma'] } },
    () => true,
    async () => {},
  );
  assert.equal(data.queries.length, 3);
  assert.deepEqual(
    data.queries.map((row) => row.keyword),
    ['alpha', 'beta', 'gamma'],
  );
  assert.equal(closed.length, 3);
  assert.equal(urls.length, 3);
});

test('selecting table keywords is not blocked by unrelated checkbox cells', () => {
  const dom = new JSDOM(
    '<table><tr><td><input type="checkbox" value="PRIVATE_CHECKBOX"></td><td>alpha</td></tr><tr><td><input type="checkbox"></td><td>beta</td></tr></table>',
  );
  try {
    select(dom.window.document, dom.window.document.querySelector('table'));
    const value = selectedText(dom.window.document);
    assert.ok(value);
    assert.doesNotMatch(value.text, /PRIVATE/);
  } finally {
    dom.window.close();
  }
});
