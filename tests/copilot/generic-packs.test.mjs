import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { renderResult, flatten, actionName } from '../../native-extension/copilot-result-view.mjs';
import { capabilityTables } from '../../native-extension/copilot-background.mjs';

const localized = (zh, en = zh) => ({ zh, en });
const fixtureRow = {
  id: 'support',
  action: 'workflow.run',
  flow_name: '核对工单材料',
  title: 'Review',
  result_view: {
    primary: 'case_id',
    object_type: 'case_id',
    columns: [
      { field: 'case_id', label: localized('工单号', 'Case') },
      { field: 'count', label: localized('材料数', 'Materials') },
      { field: 'missing_materials', label: localized('缺失材料', 'Missing') },
    ],
  },
  result: {
    verdict: '核对材料',
    level: 'info',
    metrics: [],
    missing: [],
    process: [],
    next: [],
    records: [
      { case_id: 'CS-1001', count: 2, missing_materials: ['发票抬头'] },
      { case_id: 'CS-1002', count: 0 },
      { case_id: 'CS-1003' },
    ],
  },
};

function fixture(row = fixtureRow, language = 'zh', full = true) {
  const dom = new JSDOM(
      `<html lang="${language}"><body><output id="notice"></output><article></article></body></html>`,
    ),
    doc = dom.window.document,
    article = doc.querySelector('article'),
    calls = [],
    copies = [];
  renderResult(doc, article, structuredClone(row), {
    full,
    clipboard: { writeText: async (value) => copies.push(value) },
    command: async (method, params) => {
      calls.push([method, params]);
      return { id: 'confirmed-table' };
    },
  });
  return {
    dom,
    doc,
    article,
    calls,
    copies,
    click: (text) =>
      [...article.querySelectorAll('button')]
        .find((button) => button.textContent === text)
        .onclick(),
  };
}

test('generic result columns render missing values as unknown and preserve true zero', () => {
  const f = fixture();
  try {
    assert.deepEqual(flatten(fixtureRow.result), fixtureRow.result.records);
    assert.equal(actionName(fixtureRow), '核对工单材料');
    assert.equal(actionName({ action: 'seo.keyword_check' }), '检查关键词');
    const rows = [...f.article.querySelectorAll('tbody tr')];
    assert.match(rows[0].textContent, /CS-1001.*2.*发票抬头/);
    assert.match(rows[1].textContent, /CS-1002.*0.*未知/);
    assert.match(rows[2].textContent, /CS-1003.*未知.*未知/);
    assert.doesNotMatch(f.article.textContent, /未取得量|KD|存词池/);
    assert.equal(f.article.querySelector('table').caption.textContent, fixtureRow.flow_name);
    assert.ok(f.article.querySelector('input[type=search]').getAttribute('aria-label'));
    assert.ok([...f.article.querySelectorAll('th')].every((th) => th.scope === 'col'));
  } finally {
    f.dom.window.close();
  }
});

test('generic sorting, filtering, copy, selected export and confirmed-table basket work together', async () => {
  const f = fixture();
  try {
    await f.click('材料数');
    assert.deepEqual(
      [...f.article.querySelectorAll('tbody tr')].map((tr) => tr.cells[1].textContent),
      ['CS-1002', 'CS-1001', 'CS-1003'],
    );
    await f.click('材料数');
    assert.deepEqual(
      [...f.article.querySelectorAll('tbody tr')].map((tr) => tr.cells[1].textContent),
      ['CS-1001', 'CS-1002', 'CS-1003'],
    );
    const box = f.article.querySelector('tbody input');
    box.checked = true;
    box.onchange();
    await f.click('复制表格');
    assert.match(f.copies[0], /工单号\t材料数\t缺失材料/);
    assert.match(f.copies[0], /CS-1001/);
    assert.doesNotMatch(f.copies[0], /CS-1002/);
    await f.click('导出 CSV');
    assert.deepEqual(f.calls[0], ['export_results', { id: 'support', rows: [0] }]);
    await f.click('加入工作篮');
    assert.deepEqual(f.calls.at(-1), [
      'basket_add',
      { items: [{ type: 'table', value: 'confirmed-table' }] },
    ]);
    const search = f.article.querySelector('input[type=search]');
    search.value = 'nothing';
    search.oninput();
    assert.match(f.article.querySelector('tbody').textContent, /没有匹配的记录/);
    assert.equal(f.article.querySelector('input[type=search]'), search);
  } finally {
    f.dom.window.close();
  }
});

test('English labels, hostile text, compact view and empty schema-defined table are safe', () => {
  const row = structuredClone(fixtureRow);
  row.result.records = [{ case_id: '<img src=x onerror=alert(1)>' }];
  const f = fixture(row, 'en', false);
  try {
    assert.match(f.article.textContent, /Case.*Materials.*Missing/);
    assert.match(f.article.textContent, /Unknown/);
    assert.equal(f.article.querySelector('img'), null);
  } finally {
    f.dom.window.close();
  }
  row.result.records = [];
  const empty = fixture(row);
  try {
    assert.match(empty.article.textContent, /没有匹配的记录/);
  } finally {
    empty.dom.window.close();
  }
});

test('object-column context uses bounded redacted captured cells', () => {
  const tables = capabilityTables([{ headers: ['Case'], rows: [[{ text: 'CS-1001' }]] }]);
  assert.equal(tables[0].samples[0][0].text, 'CS-1001');
  const huge = capabilityTables(
    Array.from({ length: 3 }, () => ({
      headers: Array(40).fill('Case'),
      rows: Array.from({ length: 10 }, () => Array(40).fill({ text: 'x'.repeat(500) })),
    })),
  );
  assert.ok(new TextEncoder().encode(JSON.stringify(huge)).length <= 2400);
});

test('offline end-to-end example page matching produces a suggestion, executes, and renders its actual table', () => {
  const output = execFileSync(
    'python3',
    [
      '-B',
      '-c',
      `
import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path('native-bridge').resolve()))
from copilot import Copilot,private_write
from copilot_setup import setup
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary).resolve()
    setup(root)
    private_write(root/'config.json',json.dumps({'extension_dirs':[str(Path('docs/examples/adapter-pack').resolve())],'auto_zero':False,'table_export_dir':str(root/'exports')}))
    app=Copilot(root)
    try:
        app.active='fixture'
        state=app._state('fixture')
        state.update(enabled=True,ready=True,page_context={'url':'https://support.example.test/cases?q=CS-1001','incognito':False})
        app._refresh_tool_suggestions('fixture')
        row=next(row for row in state['suggestions'].values() if row['params'].get('flow')=='support_materials')
        row['status']='executing'
        app._execute_workflow('fixture',row,state['epoch'],app.config)
        assert row['status']=='completed',row
        print(json.dumps(row,ensure_ascii=False))
    finally:
        app.close()
`,
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  const row = JSON.parse(output),
    f = fixture(row);
  try {
    assert.equal(row.scene, 'support');
    assert.equal(row.params.object, 'CS-1001');
    assert.match(
      f.article.querySelector('tbody').textContent,
      /CS-1001.*合成客户.*发票抬头.*awaiting_materials/,
    );
    assert.doesNotMatch(f.article.querySelector('table').textContent, /keyword|KD/);
  } finally {
    f.dom.window.close();
  }
});
