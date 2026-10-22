import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderTaskContent } from '../../native-extension/copilot-result-content.mjs';
import { trendSeries } from '../../native-extension/copilot-result-view.mjs';

function fixture(value, options = {}, metadata = {}, language = 'zh-CN') {
  const dom = new JSDOM(
      '<html lang="zh-CN"><body><p id="notice"></p><article></article></body></html>',
    ),
    doc = dom.window.document,
    root = doc.querySelector('article'),
    row = { id: 'result', title: '结果', action: 'custom.task', result: value, ...metadata };
  doc.documentElement.lang = language;
  renderTaskContent(doc, root, row, options);
  return { dom, doc, root, row, close: () => dom.window.close() };
}
function expand(f, details = f.root.querySelector('details')) {
  details.open = true;
  details.dispatchEvent(new f.dom.window.Event('toggle'));
}
function click(f, label) {
  const button = [...f.root.querySelectorAll('button')].find(
    (value) => value.textContent === label,
  );
  assert.ok(button, label);
  button.click();
}

test('known contract reuses citations, artifacts and commands without mutating task data', async () => {
  const calls = [],
    value = {
      verdict: '已完成',
      sections: [
        { title: '依据', text: '原文分析', sources: [{ id: 'source-1', quote: '原文引文' }] },
      ],
      artifacts: [{ label: '文件', path: '/local/report.txt' }],
    },
    before = JSON.stringify(value),
    f = fixture(value, { command: async (...args) => calls.push(args) }, { action: 'assist.task' });
  try {
    assert.match(f.root.textContent, /原文分析/);
    assert.equal(f.root.querySelector('blockquote').textContent, '原文引文');
    await [...f.root.querySelectorAll('button')]
      .find((button) => button.textContent === '打开文件')
      .onclick();
    assert.deepEqual(calls[0], ['workbench_open_artifact', { id: 'result', index: 0 }]);
    assert.equal(JSON.stringify(value), before);
    assert.equal(f.row.action, 'assist.task');
  } finally {
    f.close();
  }
});

test('generic result contract preserves source controls, numeric zero and duplicate rows', () => {
  const f = fixture(
    {
      verdict: '记录',
      records: [
        { key: 'A', amount: 0 },
        { key: 'A', amount: 0 },
      ],
    },
    {},
    {
      action: 'workflow.run',
      result_view: {
        primary: 'key',
        columns: [
          { field: 'key', label: '键' },
          { field: 'amount', label: '值' },
        ],
      },
    },
  );
  try {
    assert.equal(f.root.querySelectorAll('tbody tr').length, 2);
    assert.deepEqual(
      [...f.root.querySelectorAll('tbody tr')].map((row) => row.cells[2].textContent),
      ['0', '0'],
    );
    assert.match(f.root.textContent, /导出 CSV/);
  } finally {
    f.close();
  }
});

test('unknown record arrays page rows and columns without changing order, zero or duplicates', () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: index,
    ...Object.fromEntries(Array.from({ length: 24 }, (_, column) => ['v' + column, index])),
  }));
  rows[1] = { ...rows[0] };
  const before = JSON.stringify(rows),
    f = fixture(rows);
  try {
    assert.equal(f.root.querySelectorAll('tbody tr').length, 100);
    assert.equal(f.root.querySelectorAll('thead th').length, 20);
    assert.equal(
      f.root.querySelector('tbody tr').textContent,
      f.root.querySelectorAll('tbody tr')[1].textContent,
    );
    assert.equal(f.root.querySelector('tbody td').textContent, '0');
    assert.match(f.root.querySelector('output').textContent, /1–100 \/ 205 行.*1–20 \/ 25 列/);
    click(f, '下一页');
    click(f, '下一页');
    assert.equal(f.root.querySelectorAll('tbody tr').length, 5);
    assert.equal(f.root.querySelector('tbody td').textContent, '200');
    click(f, '下一组列');
    assert.equal(f.root.querySelectorAll('thead th').length, 5);
    assert.match(f.root.querySelector('output').textContent, /201–205 \/ 205 行.*21–25 \/ 25 列/);
    assert.equal(JSON.stringify(rows), before);
    assert.equal(f.root.querySelectorAll('input,textarea').length, 0);
  } finally {
    f.close();
  }
});

test('Markdown renders headings, lists, code, emphasis and safe links using inert DOM', () => {
  const f = fixture(
    '# 标题\n- **重点**和*强调*\n- `code`\n```html\n<img src=x onerror=alert(1)>\n```\n[安全](https://example.test/) [危险](javascript:alert(1))\n<script>alert(1)</script>',
  );
  try {
    assert.equal(f.root.querySelector('h1').textContent, '标题');
    assert.equal(f.root.querySelectorAll('li').length, 2);
    assert.equal(f.root.querySelector('strong').textContent, '重点');
    assert.equal(f.root.querySelector('em').textContent, '强调');
    assert.match(f.root.querySelector('pre code').textContent, /<img src=x onerror=/);
    assert.equal(f.root.querySelectorAll('a').length, 1);
    assert.equal(f.root.querySelector('a').rel, 'noopener noreferrer');
    assert.equal(f.root.querySelectorAll('script,img,iframe,[onerror]').length, 0);
    assert.match(f.root.textContent, /javascript:alert/);
    assert.match(f.root.textContent, /<script>alert/);
  } finally {
    f.close();
  }
});

test('safe images display lazily and preserve original source on load failure', () => {
  for (const value of ['data:image/png;base64,aGVsbG8=', 'https://example.test/image.webp']) {
    const f = fixture(value);
    try {
      const image = f.root.querySelector('img');
      assert.ok(image);
      assert.equal(image.loading, 'lazy');
      assert.equal(image.referrerPolicy, 'no-referrer');
      image.onerror();
      assert.equal(image.hidden, true);
      assert.equal(f.root.querySelector('pre').hidden, false);
      assert.equal(f.root.querySelector('pre').textContent, value);
    } finally {
      f.close();
    }
  }
});

test('unsafe image and nested JSON remain inert and available as original data', () => {
  for (const source of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://user:secret@example.test/a.png',
  ]) {
    const f = fixture({
      type: 'image',
      image_url: source,
      payload: '<img src=x onerror=alert(1)>',
    });
    try {
      assert.equal(f.root.querySelector('img'), null);
      assert.ok(f.root.textContent.includes(source));
      expand(f);
      assert.match(f.root.textContent, /onerror=alert/);
      assert.equal(f.root.querySelectorAll('script,[onerror]').length, 0);
    } finally {
      f.close();
    }
  }
});

test('unknown JSON is lazy at every depth and exposes all entries in bounded batches', () => {
  const value = Object.fromEntries(
      Array.from({ length: 123 }, (_, index) => [
        'key' + index,
        { index, nested: ['first', 0, false, null] },
      ]),
    ),
    f = fixture(JSON.stringify(value));
  try {
    assert.equal(f.root.querySelectorAll('.task-content-json-entry').length, 0);
    expand(f);
    assert.equal(f.root.querySelectorAll('.task-content-json-entry').length, 50);
    assert.match(f.root.querySelector(':scope > details > div > output').textContent, /50 \/ 123/);
    f.root.querySelector(':scope > details > div > button').click();
    f.root.querySelector(':scope > details > div > button').click();
    assert.equal(f.root.querySelectorAll('.task-content-json-entry').length, 123);
    assert.match(f.root.querySelector(':scope > details > div > output').textContent, /123 \/ 123/);
    const nested = f.root.querySelector('.task-content-json-entry details');
    expand(f, nested);
    assert.match(nested.textContent, /index/);
    assert.match(nested.textContent, /nested/);
    assert.ok(f.root.querySelectorAll('*').length < 1300);
  } finally {
    f.close();
  }
});

test('primitive arrays retain JSON types and mixed values rather than stringifying ambiguously', () => {
  const f = fixture([0, false, null, '0', '<script>x</script>']);
  try {
    expand(f);
    assert.deepEqual(
      [...f.root.querySelectorAll('pre')].map((node) => node.textContent),
      ['0', 'false', 'null', '"0"', '"<script>x</script>"'],
    );
    assert.equal(f.root.querySelector('script'), null);
  } finally {
    f.close();
  }
});

test('empty results are explicit while plain, malformed JSON and falsy scalar values survive', () => {
  for (const value of [undefined, null, '', [], {}]) {
    const f = fixture(value);
    try {
      assert.match(f.root.textContent, /没有结果内容/);
    } finally {
      f.close();
    }
  }
  for (const value of ['plain text', '{bad json', '<img src=x onerror=alert(1)>', 0, false]) {
    const f = fixture(value);
    try {
      assert.equal(f.root.querySelector('pre').textContent, String(value));
      assert.equal(f.root.querySelector('img'), null);
    } finally {
      f.close();
    }
  }
});

test('series reuse accessible trend charts without inventing a task action', () => {
  const f = fixture({
    series: [
      {
        keyword: '词',
        region: 'CN',
        period: '2m',
        points: [
          { date: '2026-01', value: 0 },
          { date: '2026-02', value: 25 },
        ],
      },
    ],
  });
  try {
    assert.ok(f.root.querySelector('svg'));
    assert.equal(f.root.querySelectorAll('.trend-data-table tbody tr').length, 2);
    assert.equal(f.row.action, 'custom.task');
    assert.ok(f.root.querySelector('.task-content-json'));
  } finally {
    f.close();
  }
});

test('large structured contracts show summary and paged records before expanding original controls', () => {
  const f = fixture(
    {
      verdict: '完整记录',
      sections: [],
      records: Array.from({ length: 201 }, (_, index) => ({ value: index })),
    },
    {},
    { action: 'assist.task' },
  );
  try {
    assert.equal(f.root.querySelector('.verdict').textContent, '完整记录');
    assert.equal(f.root.querySelectorAll('.task-content-records tbody tr').length, 100);
    assert.equal(f.root.querySelector('.task-content-contract table'), null);
    assert.match(f.root.querySelector('summary').textContent, /201 行/);
    expand(f);
    assert.equal(f.root.querySelectorAll('.task-content-contract tbody tr').length, 201);
    assert.equal(f.row.result.records.length, 201);
  } finally {
    f.close();
  }
});

test('malformed known structures and unknown verdict objects keep full JSON instead of disappearing', () => {
  for (const [value, metadata] of [
    [{ verdict: '错误合同', metrics: {}, process: [] }, { action: 'assist.task' }],
    [
      {
        verdict: '插件自定义',
        sections: [{ title: '内容', text: '必须保留', sources: [] }],
        other: 0,
      },
      {},
    ],
  ]) {
    const f = fixture(value, {}, metadata);
    try {
      assert.ok(f.root.querySelector('.task-content-json'));
      expand(f);
      assert.match(f.root.textContent, /verdict/);
      assert.ok(f.root.textContent.includes(value.verdict));
    } finally {
      f.close();
    }
  }
});

test('English JSON, pagination, image failure and empty UI preserve unmodified source values', () => {
  const f = fixture({ 原字段: [0, false], title: '原始中文内容' }, {}, {}, 'en-US');
  try {
    assert.match(f.root.querySelector('summary').textContent, /Object.*2 items/);
    assert.equal(f.root.querySelector('button').textContent, 'Show more');
    expand(f);
    assert.match(
      f.root.querySelector(':scope > details > div > output').textContent,
      /2 \/ 2 items shown/,
    );
    assert.match(f.root.textContent, /原字段/);
    assert.match(f.root.textContent, /原始中文内容/);
    const nested = f.root.querySelector('.task-content-json-entry details');
    assert.match(nested.querySelector('summary').textContent, /Array/);
  } finally {
    f.close();
  }
  const table = fixture([{ 值: 0 }, { 值: 0 }], {}, {}, 'en');
  try {
    assert.equal(table.root.querySelector('button').textContent, 'Previous page');
    assert.match(table.root.querySelector('output').textContent, /Rows 1–2 \/ 2.*Columns 1–1 \/ 1/);
    assert.equal(
      table.root.querySelector('.table-wrap').getAttribute('aria-label'),
      'Read-only result table',
    );
    assert.equal(table.root.querySelector('th').textContent, '值');
  } finally {
    table.close();
  }
  const image = fixture('https://example.test/image.png', {}, {}, 'en');
  try {
    assert.equal(image.root.querySelector('img').alt, 'Task image');
    image.root.querySelector('img').onerror();
    assert.match(image.root.textContent, /Image could not be loaded/);
  } finally {
    image.close();
  }
  const empty = fixture(null, {}, {}, 'en');
  try {
    assert.equal(empty.root.textContent, 'No result content.');
  } finally {
    empty.close();
  }
});

test('English large contracts immediately show original verdict and 100 read-only rows', () => {
  const records = Array.from({ length: 201 }, (_, index) => ({ amount: index < 2 ? 0 : index })),
    f = fixture(
      { verdict: '原始结论', sections: [], records },
      {},
      { action: 'assist.task' },
      'en',
    );
  try {
    assert.equal(f.root.querySelector('.verdict').textContent, '原始结论');
    assert.equal(f.root.querySelectorAll('.task-content-records tbody tr').length, 100);
    assert.deepEqual(
      [...f.root.querySelectorAll('.task-content-records tbody tr')]
        .slice(0, 2)
        .map((row) => row.textContent),
      ['0', '0'],
    );
    assert.match(f.root.querySelector('.task-content-range').textContent, /Rows 1–100 \/ 201/);
    assert.match(
      f.root.querySelector('summary').textContent,
      /201 structured records.*full interactive view/,
    );
    assert.equal(f.root.querySelector('.task-content-contract').open, false);
    assert.equal(f.row.result.records, records);
    click(f, 'Next page');
    assert.match(f.root.querySelector('.task-content-range').textContent, /Rows 101–200 \/ 201/);
  } finally {
    f.close();
  }
});

test('unknown series use real signed value scale, neutral labels and original numbers', () => {
  const result = {
      series: [
        {
          points: [
            { date: 'a', value: -20 },
            { date: 'b', value: 1000 },
          ],
        },
      ],
    },
    original = JSON.stringify(result),
    f = fixture(result);
  try {
    const svg = f.root.querySelector('svg');
    assert.match(svg.getAttribute('aria-label'), /-20–1000/);
    assert.deepEqual(
      [...svg.querySelectorAll('.trend-axis-label')].slice(0, 3).map((node) => node.textContent),
      ['-20', '490', '1000'],
    );
    for (const point of svg.querySelectorAll('circle'))
      assert.ok(Number(point.getAttribute('cy')) >= 24 && Number(point.getAttribute('cy')) <= 184);
    assert.equal(f.root.querySelector('.trend-data-table th:last-child').textContent, '数值');
    assert.match(f.root.querySelector('.trend-point-reading').textContent, /日期与数值/);
    assert.doesNotMatch(f.root.querySelector('figure').textContent, /undefined|热度/);
    assert.equal(f.root.querySelector('figcaption').textContent, '数据系列');
    assert.equal(JSON.stringify(result), original);
    assert.equal(f.row.action, 'custom.task');
  } finally {
    f.close();
  }
});

test('all-zero and extreme finite series keep a finite nonzero scale and English value labels', () => {
  for (const values of [
    [0, 0],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    const f = fixture(
      { series: [{ points: values.map((value, index) => ({ date: String(index), value })) }] },
      {},
      {},
      'en',
    );
    try {
      assert.equal(f.root.querySelector('.trend-data-table th:last-child').textContent, 'Value');
      assert.equal(f.root.querySelector('figcaption').textContent, 'Series');
      for (const point of f.root.querySelectorAll('circle'))
        assert.ok(Number.isFinite(Number(point.getAttribute('cy'))));
      if (values.every((value) => value === 0)) {
        assert.match(f.root.querySelector('svg').getAttribute('aria-label'), /0–1/);
        assert.equal(f.root.querySelectorAll('circle')[0].getAttribute('cy'), '184');
      }
    } finally {
      f.close();
    }
  }
});

test('existing SEO trend helper keeps the default 0–100 interest scale and wording', () => {
  const f = fixture(null);
  try {
    f.root.replaceChildren(
      trendSeries(
        f.doc,
        {
          keyword: '词',
          region: 'CN',
          period: '2m',
          points: [
            { date: 'a', value: 0 },
            { date: 'b', value: 100 },
          ],
        },
        true,
      ),
    );
    assert.match(f.root.querySelector('svg').getAttribute('aria-label'), /0–100/);
    assert.deepEqual(
      [...f.root.querySelectorAll('.trend-axis-label')].slice(0, 3).map((node) => node.textContent),
      ['0', '50', '100'],
    );
    assert.equal(f.root.querySelector('th:last-child').textContent, '热度');
    assert.match(f.root.querySelector('.trend-point-reading').textContent, /日期与热度/);
    assert.equal(f.root.querySelectorAll('circle')[1].getAttribute('cy'), '24');
  } finally {
    f.close();
  }
});

test('series exceeding the SVG point budget retain complete lazy JSON and explain deferred charts', () => {
  for (const language of ['zh-CN', 'en']) {
    const points = Array.from({ length: 501 }, (_, index) => ({
        date: String(index),
        value: index - 20,
      })),
      result = { series: [{ points }] },
      f = fixture(result, {}, {}, language);
    try {
      assert.equal(f.root.querySelector('svg'), null);
      assert.match(
        f.root.textContent,
        language === 'en' ? /large series charts were not expanded/ : /大数据系列未展开图表/,
      );
      assert.equal(f.root.querySelectorAll('.task-content-json-entry').length, 0);
      expand(f);
      assert.match(f.root.textContent, /series/);
      assert.equal(f.row.result.series[0].points, points);
      assert.equal(f.row.result.series[0].points.at(-1).value, 480);
    } finally {
      f.close();
    }
  }
});
