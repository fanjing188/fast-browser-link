import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import {
  WorkbenchPanel,
  suitableTask,
  optionsFromForm,
} from '../../native-extension/copilot-workbench.mjs';
import { captureMaterial } from '../../native-extension/copilot-observation.mjs';
import { renderDashboard, rankedSuggestions } from '../../native-extension/copilot-view.mjs';
import { renderResult } from '../../native-extension/copilot-result-view.mjs';
import { CopilotBackground } from '../../native-extension/copilot-background.mjs';
import { renderGenericTable } from '../../native-extension/copilot-generic-result.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const tasks = [
  {
    id: 'table.clean',
    name: { zh: '整理表格', en: 'Clean table' },
    subject: 'table',
    model: false,
  },
  {
    id: 'table.filter',
    name: { zh: '筛选排序', en: 'Filter table' },
    subject: 'table',
    model: false,
  },
  {
    id: 'table.compare',
    name: { zh: '比较表格差异', en: 'Compare tables' },
    subject: 'tables',
    model: false,
  },
  {
    id: 'page.question',
    name: { zh: '围绕问题阅读', en: 'Ask source' },
    subject: 'text',
    model: true,
  },
  {
    id: 'image.table',
    name: { zh: '图片转表格', en: 'Image table' },
    subject: 'image',
    model: false,
  },
];
const material = (id = 'm1') => ({
  id,
  kind: 'table',
  title: 'Synthetic table',
  revision: 1,
  partial: true,
  columns: ['Name', 'Count'],
  rows: 2,
});
const snapshot = () => ({ materials: [material()], tasks, model_ready: false });
function workbench() {
  const dom = new JSDOM(html),
    calls = [],
    state = snapshot();
  const panel = new WorkbenchPanel(
    dom.window.document,
    async (name, params) => {
      calls.push([name, params]);
      if (name === 'workbench_plan')
        return { card: { id: 'planned', recommendation_state: 'ready' }, state: {} };
      if (name === 'execute') return { suggestions: [{ id: 'planned', status: 'queued' }] };
      if (name === 'workbench_interpret')
        return {
          options: {
            filters: [
              { field: 'Count', op: 'gte', value: 2 },
              { field: 'Name', op: 'contains', value: 'A' },
            ],
            sort: 'Count',
            descending: true,
          },
          explanation: '保留 Count ≥ 2 且 Name 包含 A 的记录，再按 Count 降序。',
          preview_only: true,
        };
      if (name === 'workbench_study_read')
        return {
          question: 'What does <img> mean?',
          answer: 'My answer',
          reference_answer: 'Reference answer',
          source_quote: 'Original excerpt',
          self_rating: 'review',
        };
      if (name === 'workbench_add')
        state.materials.push({ ...material('m2'), title: params.title });
      return state;
    },
    { capture: async () => state },
  );
  panel.root.showModal = () => panel.root.setAttribute('open', '');
  panel.root.close = () => panel.root.removeAttribute('open');
  return { dom, panel, calls, state };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test('task applicability keeps materials typed and bounded', () => {
  assert.equal(suitableTask(tasks[0], [material()]), true);
  assert.equal(suitableTask(tasks[2], [material()]), false);
  assert.equal(suitableTask(tasks[2], [material(), material('m2')]), true);
  assert.equal(suitableTask(tasks[0], [{ kind: 'image' }]), false);
  assert.equal(suitableTask(tasks[3], Array(11).fill({ kind: 'page' })), false);
});
test('pairwise table tasks reject a third material before enabling the form', () => {
  for (const id of ['table.compare', 'table.join']) {
    const task = { id, subject: 'tables', model: false };
    assert.equal(suitableTask(task, [material(), material('m2')]), true);
    assert.equal(suitableTask(task, [material(), material('m2'), material('m3')]), false);
  }
  assert.equal(
    suitableTask({ id: 'page.compare', subject: 'texts' }, Array(3).fill({ kind: 'page' })),
    true,
  );
});
test('pairwise task readiness explains the exact two-table requirement', async () => {
  const { dom, panel, state } = workbench();
  state.materials = [material(), material('m2'), material('m3')];
  await panel.open({ params: { task: 'table.compare', materials: ['m1', 'm2', 'm3'] } });
  assert.equal(panel.execute.disabled, true);
  assert.match(panel.readiness.textContent, /恰好2|exactly two/);
  dom.window.close();
});
test('closing the workbench restores a reachable control when its original card disappeared', async () => {
  const { dom, panel } = workbench();
  const trigger = dom.window.document.createElement('button');
  dom.window.document.body.append(trigger);
  trigger.focus();
  await panel.open();
  trigger.remove();
  panel.root.dispatchEvent(new dom.window.Event('close'));
  assert.equal(
    dom.window.document.activeElement,
    dom.window.document.getElementById('open-settings'),
  );
});
test('every model task form produces options accepted by the actual host catalog', async () => {
  const python = (script, input) => {
    const result = spawnSync(
      'python3',
      ['-B', '-c', "import sys,json; sys.path.insert(0,'native-bridge'); " + script],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        input: JSON.stringify(input),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const tasks = python(
    "from copilot_task_catalog import CATALOG; print(json.dumps([v for v in CATALOG.values() if v['model']]))",
  );
  const { dom, panel, state } = workbench();
  state.tasks = tasks;
  state.model_ready = true;
  const vectors = [];
  for (const task of tasks) {
    state.materials =
      task.subject === 'table'
        ? [material()]
        : [
            { id: 'p1', kind: 'page', title: 'Source one', revision: 1 },
            { id: 'p2', kind: 'page', title: 'Source two', revision: 1 },
          ];
    await panel.open({
      params: { task: task.id, materials: state.materials.map((row) => row.id) },
    });
    for (const [name, value] of Object.entries({
      goal: 'Focus on limits',
      instructions: 'Focus on limits',
      question: 'What are the limits?',
      answers: 'A synthetic answer',
      language: 'en',
      target_language: 'en',
      fields: 'Name, Count',
      dimensions: 'Price, Terms',
    })) {
      const field = panel.form.elements.namedItem(name);
      if (field) field.value = value;
    }
    vectors.push({ task: task.id, options: optionsFromForm(task.id, panel.form) });
  }
  const accepted = python(
    "from copilot_task_catalog import validate_options,required_parameters; rows=json.load(sys.stdin); [validate_options(row['task'],row['options']) for row in rows]; assert all(not required_parameters(row['task'],row['options']) for row in rows); print(json.dumps(rows))",
    vectors,
  );
  assert.deepEqual(accepted, vectors);
  dom.window.close();
});
test('workbench runs a local task while Agent is off and produces typed options', async () => {
  const { dom, panel, calls } = workbench();
  await panel.open({ params: { task: 'table.clean', materials: ['m1'] } });
  assert.equal(panel.execute.disabled, false);
  assert.deepEqual(optionsFromForm('table.clean', panel.form), {
    trim: true,
    dedupe: true,
    numeric_fields: [],
    date_fields: [],
    date_format: '%Y-%m-%d',
  });
  panel.form.requestSubmit();
  await tick();
  assert.deepEqual(calls.find(([name]) => name === 'workbench_plan')[1], {
    task: 'table.clean',
    materials: ['m1'],
    options: {
      trim: true,
      dedupe: true,
      numeric_fields: [],
      date_fields: [],
      date_format: '%Y-%m-%d',
    },
  });
  assert.ok(calls.some(([name, params]) => name === 'execute' && params.id === 'planned'));
  assert.match(panel.notice.textContent, /已开始任务/);
  dom.window.close();
});
test('material add selects only new material and model task stays blocked without Agent', async () => {
  const { dom, panel, calls, state } = workbench();
  await panel.open();
  panel.pasteTitle.value = 'New table';
  panel.pasteText.value = 'Name,Count\nA,2';
  await [...panel.root.querySelectorAll('button')]
    .find((button) => button.textContent === '加入表格材料')
    .onclick();
  await tick();
  assert.deepEqual([...panel.selected], ['m2']);
  assert.ok(
    calls.some(
      ([name, params]) =>
        name === 'workbench_add' && params.kind === 'table' && params.text.includes('A,2'),
    ),
  );
  state.materials = [{ id: 'text1', kind: 'page', title: 'Page', revision: 1, partial: true }];
  panel.selected = new Set(['text1']);
  panel.render();
  panel.task.value = 'page.question';
  panel.renderFields();
  assert.equal(panel.execute.disabled, true);
  assert.match(panel.readiness.textContent, /需要配置并开启 Agent/);
  dom.window.close();
});
test('table compare form requires a key and filter form never exposes raw JSON', async () => {
  const { dom, panel, state } = workbench();
  state.materials.push(material('m2'));
  await panel.open({ params: { task: 'table.compare', materials: ['m1', 'm2'] } });
  assert.equal(panel.form.elements.namedItem('keys').required, true);
  panel.form.elements.namedItem('keys').options[0].selected = true;
  assert.deepEqual(optionsFromForm('table.compare', panel.form), {
    keys: ['Name'],
    include_unchanged: false,
  });
  panel.selected = new Set(['m1']);
  panel.render();
  panel.task.value = 'table.filter';
  panel.renderFields();
  panel.form.elements.namedItem('filter_field').value = 'Count';
  panel.form.elements.namedItem('operator').value = 'gte';
  panel.form.elements.namedItem('filter_value').value = '2';
  assert.deepEqual(optionsFromForm('table.filter', panel.form), {
    filters: [{ field: 'Count', op: 'gte', value: '2' }],
  });
  assert.doesNotMatch(panel.root.textContent, /JSON参数|options\s*:/);
  dom.window.close();
});
test('natural language rules are previewed and never execute until the user runs the task', async () => {
  const { dom, panel, state, calls } = workbench();
  state.model_ready = true;
  await panel.open({ params: { task: 'table.filter', materials: ['m1'] } });
  panel.instruction.value = '保留计数至少2且名字含A的记录，按计数降序';
  await panel.interpretButton.onclick();
  assert.equal(calls.filter(([name]) => name === 'execute').length, 0);
  assert.equal(panel.useRules.checked, true);
  assert.match(panel.rulePreview.textContent, /Count ≥ 2/);
  assert.equal(panel.form.elements.namedItem('filter_field').disabled, true);
  panel.form.requestSubmit();
  await tick();
  const options = calls.find(([name]) => name === 'workbench_plan')[1].options;
  assert.equal(options.filters.length, 2);
  assert.equal(options.descending, true);
  assert.ok(calls.some(([name]) => name === 'execute'));
  panel.useRules.checked = false;
  panel.useRules.onchange();
  assert.equal(panel.form.elements.namedItem('filter_field').disabled, false);
  dom.window.close();
});
test('explicit page and selection capture excludes controls, hidden ancestors and private content', () => {
  const dom = new JSDOM(
    '<title>Article</title><main><h1>Visible</h1><p>Safe text<span style="display:none"><em>INNER_SECRET</em></span><span style="opacity:0"><em>OPACITY_SECRET</em></span></p><p><input value="INPUT_SECRET"><textarea>TEXT_SECRET</textarea></p><p style="display:none">HIDDEN_SECRET</p><div style="display:none"><p>NESTED_SECRET</p></div><p contenteditable>EDIT_SECRET</p></main>',
    { url: 'https://example.test/?token=secret' },
  );
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const doc = dom.window.document;
  const material = captureMaterial(doc, dom.window.location.href);
  assert.match(material.text, /Safe text/);
  assert.doesNotMatch(material.text, /SECRET/);
  assert.equal(material.source, 'https://example.test/');
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelectorAll('p')[0]);
  doc.getSelection().addRange(range);
  assert.equal(captureMaterial(doc, dom.window.location.href, 'selection').text, 'Safe text');
  range.selectNodeContents(doc.querySelector('[contenteditable]'));
  doc.getSelection().removeAllRanges();
  doc.getSelection().addRange(range);
  assert.throws(() => captureMaterial(doc, dom.window.location.href, 'selection'), /非输入区域/);
  dom.window.close();
});
test('page capture marks a clipped paragraph as partial when its trailing restriction is omitted', () => {
  const dom = new JSDOM(`<main><p>${'A'.repeat(6500)}末尾限制：禁止商用</p></main>`, {
    url: 'https://example.test/terms',
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const material = captureMaterial(dom.window.document, dom.window.location.href, 'page');
  assert.equal(material.text.length, 6000);
  assert.equal(material.text.includes('禁止商用'), false);
  assert.equal(material.partial, true);
  dom.window.close();
});
test('page capture propagates text-node scan exhaustion without marking a short complete paragraph partial', () => {
  for (const count of [3, 501]) {
    const dom = new JSDOM(`<main><p>${'<span>A</span>'.repeat(count)}</p></main>`, {
      url: 'https://example.test/',
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
    const material = captureMaterial(dom.window.document, dom.window.location.href, 'page');
    assert.equal(material.partial, count > 500);
    dom.window.close();
  }
});
test('unified recommendations honor server rank and render cards without a separate more group', () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  const suggestions = Array.from({ length: 7 }, (_, i) => ({
    id: 'r' + i,
    title: 'Task ' + i,
    why: 'Relevant',
    status: 'pending',
    action: 'assist.task',
    standard_task: true,
    local_task: true,
    recommendation_rank: 7 - i,
    recommendation_state: 'ready',
    params: { task: 'table.clean' },
  }));
  suggestions.push({
    id: 'blocked1',
    title: 'Prepare Agent',
    standard_task: true,
    status: 'pending',
    recommendation_state: 'blocked',
    recommendation_rank: 20,
    params: { task: 'page.question' },
  });
  suggestions.push({
    id: 'blocked2',
    title: 'Prepare again',
    standard_task: true,
    status: 'pending',
    recommendation_state: 'blocked',
    recommendation_rank: 21,
    params: { task: 'page.summary' },
  });
  renderDashboard(doc, { enabled: false, locale: 'zh', suggestions }, { command: async () => {} });
  assert.deepEqual(
    [...doc.querySelectorAll('#pending > article')].map((row) => row.dataset.id),
    ['r6', 'r5', 'r4', 'r3', 'r2', 'r1', 'r0', 'blocked1'],
  );
  assert.equal(doc.querySelector('#more-suggestions'), null);
  assert.equal(doc.querySelector('#local-workbench'), null);
  assert.equal(doc.querySelectorAll('#pending [data-action=configure_task]').length, 8);
  assert.equal(rankedSuggestions(suggestions, {})[0].id, 'r6');
  assert.equal(doc.querySelector('[data-id=blocked2]'), null);
  renderDashboard(doc, { enabled: false, locale: 'zh', suggestions }, { command: async () => {} });
  assert.equal(doc.querySelectorAll('#pending > article').length, 8);
  dom.window.close();
});
test('blocked hints never displace ready cards or jump ahead of them during frontend diversity selection', () => {
  const ready = Array.from({ length: 12 }, (_, i) => ({
    id: 'ready-' + i,
    action: 'assist.task',
    task_type: 'table.clean',
    status: 'pending',
    recommendation_rank: i,
  }));
  const blocked = Array.from({ length: 3 }, (_, i) => ({
    id: 'blocked-' + i,
    action: 'assist.task',
    task_type: 'page.model' + i,
    status: 'pending',
    recommendation_state: 'blocked',
    recommendation_rank: 20 + i,
  }));
  assert.deepEqual(
    rankedSuggestions([...ready, ...blocked], {}).map((row) => row.id),
    ready.slice(0, 10).map((row) => row.id),
  );
  assert.deepEqual(
    rankedSuggestions([...ready.slice(0, 2), ...blocked], {}).map((row) => row.id),
    ['ready-0', 'ready-1', 'blocked-0'],
  );
});
test('source sections and quiz answers survive generic result rendering without HTML interpretation', async () => {
  const dom = new JSDOM(
      '<html lang="zh"><body><p id="notice"></p><article></article></body></html>',
    ),
    doc = dom.window.document,
    calls = [];
  const row = {
    id: 'r',
    title: 'Study',
    action: 'assist.task',
    standard_task: true,
    local_task: false,
    status: 'completed',
    verification: { kind: 'source_checked' },
    result: {
      verdict: 'Done',
      sections: [
        {
          title: 'Evidence',
          text: 'Explanation',
          sources: [{ id: 'm1', quote: '<img src=x onerror=alert(1)> original' }],
        },
      ],
      questions: [
        {
          id: 'q1',
          question: 'What?',
          answer: 'Reference answer',
          source_id: 'm1',
          source_quote: 'Original quote',
        },
      ],
    },
  };
  renderResult(doc, doc.querySelector('article'), row, {
    full: true,
    command: async (name, params) => {
      calls.push([name, params]);
      return { feedback: { explanation: '已记录作答' } };
    },
  });
  assert.equal(doc.querySelector('article img'), null);
  assert.match(doc.querySelector('.source-quote').textContent, /<img/);
  const reference = doc.querySelector('.study-question details');
  assert.equal(reference.open, false);
  doc.querySelector('.study-question textarea').value = 'My answer';
  await doc.querySelector('.study-question button').onclick();
  assert.equal(reference.open, true);
  assert.equal(calls[0][0], 'workbench_answer');
  assert.equal(calls[0][1].answer, 'My answer');
  assert.equal(calls[0][1].save, false);
  await doc.querySelector('[data-action=workbench_from_result]').onclick();
  assert.equal(calls.at(-1)[0], 'workbench_from_result');
  dom.window.close();
});
test('workbench verbs are panel-only and navigation races never persist page material', async () => {
  const native = [];
  let captured = 0;
  const api = {
    runtime: { id: 'ext', getURL: (path) => 'chrome-extension://ext/' + path },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: 'https://example.test/' }],
      get: async () => ({ id: 1, url: 'https://changed.test/' }),
    },
    windows: { get: async () => ({ focused: true }) },
    scripting: {
      executeScript: async () => {
        captured++;
        return [
          {
            documentId: 'doc1',
            result: { kind: 'page', text: 'Safe', source: 'https://example.test/' },
          },
        ];
      },
    },
  };
  const service = new CopilotBackground(api, async (...args) => native.push(args));
  service.refreshOwnership = async () => {};
  assert.equal(
    service.handle(
      {
        type: 'copilot.command',
        command: 'workbench_add',
        params: { kind: 'text', text: 'injected' },
      },
      { id: 'ext', frameId: 0, url: 'https://example.test/', tab: { id: 1 } },
      () => {},
    ),
    false,
  );
  await assert.rejects(
    () => service.localCommand('workbench_capture', { mode: 'page' }),
    /目标页面已变化/,
  );
  assert.equal(captured, 1);
  assert.equal(native.length, 0);
});
test('large result preview labels its range and exports only the explicitly shown records', async () => {
  const dom = new JSDOM('<html lang="zh"><body><main></main></body></html>'),
    doc = dom.window.document,
    calls = [];
  const row = {
    id: 'large',
    title: 'Large result',
    preview_truncated: true,
    result_total_records: 5000,
    result_view: { columns: [{ field: 'Name', label: 'Name' }], primary: 'Name' },
    result: { records: [{ Name: 'A' }, { Name: 'B' }] },
  };
  renderGenericTable(doc, doc.querySelector('main'), row, {
    command: async (name, params) => {
      calls.push([name, params]);
      return {};
    },
    clipboard: { writeText: async () => {} },
  });
  assert.match(doc.querySelector('output').textContent, /预览 2 \/ 总 5000 条；完整文件见产物/);
  const exportButton = [...doc.querySelectorAll('button')].find(
    (button) => button.textContent === '导出预览 CSV',
  );
  assert.ok(exportButton);
  await exportButton.onclick();
  assert.deepEqual(calls[0], ['export_results', { id: 'large', rows: [0, 1] }]);
  dom.window.close();
});
test('saved learning records load only on demand and can become explicit review material', async () => {
  const { dom, panel, state, calls } = workbench();
  state.study_records = [
    { id: 'study1', title: 'Saved lesson', self_rating: 'understood', stage: 'answered' },
  ];
  await panel.open();
  assert.equal(
    calls.some(([name]) => name === 'workbench_study_read'),
    false,
  );
  const record = panel.history.querySelector('[data-study-id=study1]');
  assert.match(record.querySelector('summary').textContent, /已理解（自评）/);
  await record.querySelector('button').onclick();
  assert.equal(calls.at(-1)[0], 'workbench_study_read');
  assert.match(record.textContent, /Original excerpt/);
  assert.equal(record.querySelector('img'), null);
  await [...record.querySelectorAll('button')]
    .find((button) => button.textContent === '加入复习材料')
    .onclick();
  const added = calls.find(([name]) => name === 'workbench_add')[1];
  assert.equal(added.kind, 'text');
  assert.match(added.text, /Reference answer/);
  assert.equal(added.partial, true);
  dom.window.close();
});
test('image table form converts percent boundaries to normalized cuts and requires reviewable columns', async () => {
  const { dom, panel, state } = workbench();
  state.materials = [{ id: 'image1', kind: 'image', title: 'Chart', revision: 1, partial: true }];
  await panel.open({ params: { task: 'image.table', materials: ['image1'] } });
  assert.equal(panel.execute.disabled, false);
  panel.form.elements.namedItem('image_headers').value = '名称,数量';
  panel.form.elements.namedItem('image_cuts').value = '10, 50%, 90';
  panel.form.elements.namedItem('image_skip_rows').value = '1';
  assert.deepEqual(optionsFromForm('image.table', panel.form), {
    headers: ['名称', '数量'],
    cuts: [0.1, 0.5, 0.9],
    skip_rows: 1,
  });
  panel.form.elements.namedItem('image_cuts').value = '0, 90, 50';
  assert.throws(() => optionsFromForm('image.table', panel.form), /递增/);
  dom.window.close();
});
test('Canvas capture reads at most three visible isolated canvases and omits private, editor and offscreen nodes', () => {
  const dom = new JSDOM(
      '<title>Charts</title><input value="INPUT_SECRET"><canvas hidden></canvas><div data-private><canvas></canvas></div><div contenteditable><canvas></canvas></div><div data-profile><canvas></canvas></div><canvas id="offscreen"></canvas><canvas id="one"></canvas><canvas id="two"></canvas><canvas id="three"></canvas><canvas id="four"></canvas>',
      { url: 'https://example.test/?token=secret' },
    ),
    calls = [];
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this.id === 'offscreen' ? 2000 : 0;
    return { width: 100, height: 50, top, bottom: top + 50, left: 0, right: 100 };
  };
  dom.window.HTMLCanvasElement.prototype.toDataURL = function () {
    calls.push(this.id);
    return 'data:image/png;base64,iVBORw0KGgo=';
  };
  const result = captureMaterial(dom.window.document, dom.window.location.href, 'canvas');
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.equal(result.materials.length, 3);
  assert.equal(result.materials[0].kind, 'image');
  assert.equal(result.materials[0].source, 'https://example.test/');
  assert.doesNotMatch(JSON.stringify(result), /INPUT_SECRET|token=secret/);
  dom.window.close();
});
test('Canvas capture refuses tainted, oversized and invalid images without a bypass', () => {
  const dom = new JSDOM('<canvas></canvas>', { url: 'https://example.test/' }),
    doc = dom.window.document,
    canvas = doc.querySelector('canvas');
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 50,
    top: 0,
    bottom: 50,
    left: 0,
    right: 100,
  });
  canvas.toDataURL = () => {
    throw new dom.window.DOMException('Tainted', 'SecurityError');
  };
  assert.throws(() => captureMaterial(doc, dom.window.location.href, 'canvas'), /跨源保护/);
  canvas.toDataURL = () => 'data:image/png;base64,' + Buffer.alloc(150001).toString('base64');
  assert.throws(() => captureMaterial(doc, dom.window.location.href, 'canvas'), /超过150KiB/);
  canvas.width = 5000;
  assert.throws(() => captureMaterial(doc, dom.window.location.href, 'canvas'), /图尺寸过大/);
  canvas.width = 100;
  canvas.toDataURL = () => 'data:,';
  assert.throws(() => captureMaterial(doc, dom.window.location.href, 'canvas'), /有效 PNG/);
  dom.window.close();
});
test('Canvas background capture refuses a foreground switch before persisting any material', async () => {
  let calls = 0;
  const writes = [];
  const active = { id: 1, windowId: 1, url: 'https://example.test/' };
  const api = {
    runtime: { getURL: (path) => 'chrome-extension://ext/' + path },
    tabs: {
      query: async () => (++calls < 3 ? [active] : [{ ...active, id: 2 }]),
      get: async () => active,
    },
    windows: { get: async () => ({ focused: true }) },
    scripting: {
      executeScript: async ({ args }) => [
        {
          documentId: 'doc1',
          result: args ? { materials: [{ kind: 'image', image: 'iVBORw0KGgo=' }] } : active.url,
        },
      ],
    },
  };
  const service = new CopilotBackground(api, async (...args) => writes.push(args));
  service.refreshOwnership = async () => {};
  await assert.rejects(() => service.localCommand('workbench_capture', { mode: 'canvas' }), /前台/);
  assert.equal(writes.length, 0);
});
test('Canvas material persistence requires stable document identity and excludes task-owned pages', async () => {
  const active = { id: 1, windowId: 1, url: 'https://example.test/' };
  for (const scenario of ['stable', 'document_changed', 'owned', 'tainted']) {
    const writes = [];
    let captures = 0;
    const api = {
      runtime: { getURL: (path) => 'chrome-extension://ext/' + path },
      tabs: { query: async () => [active], get: async () => active },
      windows: { get: async () => ({ focused: true }) },
      scripting: {
        executeScript: async ({ args }) => {
          captures++;
          if (args)
            return [
              {
                documentId: 'doc1',
                result:
                  scenario === 'tainted'
                    ? { capture_error: 'Canvas 受跨源保护，无法读取；请导入有权使用的 PNG 图片' }
                    : {
                        materials: [
                          {
                            kind: 'image',
                            title: 'Canvas 1',
                            image: 'iVBORw0KGgo=',
                            source: active.url,
                            partial: true,
                          },
                        ],
                      },
              },
            ];
          return [
            { documentId: scenario === 'document_changed' ? 'doc2' : 'doc1', result: active.url },
          ];
        },
      },
    };
    const service = new CopilotBackground(
      api,
      async (name, params) => {
        writes.push([name, params]);
        return { materials: [{ id: 'saved' }] };
      },
      () => scenario === 'owned',
    );
    service.refreshOwnership = async () => {};
    if (scenario === 'stable') {
      const state = await service.localCommand('workbench_capture', { mode: 'canvas' });
      assert.equal(state.materials[0].id, 'saved');
      assert.equal(writes[0][0], 'workbench_add');
      assert.equal(writes[0][1].document_id, 'doc1');
    } else {
      await assert.rejects(
        () => service.localCommand('workbench_capture', { mode: 'canvas' }),
        scenario === 'owned' ? /普通网页/ : scenario === 'tainted' ? /跨源保护/ : /目标页面已变化/,
      );
      assert.equal(writes.length, 0);
      if (scenario === 'owned') assert.equal(captures, 0);
    }
  }
});
test('task artifact buttons send only task identity and index and expose a failed open receipt', async () => {
  const dom = new JSDOM(
      '<html lang="zh"><body><p id="notice"></p><article></article></body></html>',
    ),
    doc = dom.window.document,
    calls = [];
  const row = {
    id: 'artifact-task',
    title: 'Export',
    action: 'assist.task',
    standard_task: true,
    local_task: true,
    result: {
      verdict: 'Done',
      artifacts: [
        { label: 'CSV', path: '/untrusted/path/from-result.csv' },
        { label: 'Review', path: '/other/path.json' },
      ],
    },
  };
  renderResult(doc, doc.querySelector('article'), row, {
    full: true,
    command: async (name, params) => {
      calls.push([name, params]);
      return params.index === 0 ? { opened: true } : { opened: false, error: 'blocked' };
    },
  });
  const buttons = [...doc.querySelectorAll('[data-action=workbench_open_artifact]')];
  assert.equal(buttons.length, 2);
  await buttons[0].onclick();
  assert.deepEqual(calls[0], ['workbench_open_artifact', { id: 'artifact-task', index: 0 }]);
  assert.match(doc.getElementById('notice').textContent, /已请求系统打开/);
  await buttons[1].onclick();
  assert.deepEqual(calls[1], ['workbench_open_artifact', { id: 'artifact-task', index: 1 }]);
  assert.equal(buttons[1].disabled, false);
  assert.match(doc.getElementById('notice').textContent, /文件未能打开/);
  assert.equal(doc.querySelectorAll('.artifact-item').length, 2);
  dom.window.close();
});
test('panel adopts a ready task plan before dispatching execute over a stale blocked card', async () => {
  const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'https://panel.test/',
    }),
    doc = dom.window.document,
    calls = [];
  const blocked = {
    id: 'same-id',
    title: '快速看懂页面',
    why: 'Needs Agent',
    status: 'pending',
    action: 'assist.task',
    standard_task: true,
    local_task: false,
    recommendation_state: 'blocked',
    missing_capabilities: ['agent'],
    params: { task: 'page.summary', materials: ['page1'], options: {} },
    material_ids: ['page1'],
  };
  const ready = { ...blocked, recommendation_state: 'ready', missing_capabilities: [] };
  const state = {
    enabled: true,
    ready: true,
    settings_saved: true,
    revision: 1,
    agent: { name: 'Hermes', state: 'connected' },
    hermes_health: { state: 'connected' },
    config: {
      mode: 'balanced',
      max_parallel: 3,
      context_limit: 6000,
      turn_multiplier: 1,
      exec_transport: 'acp',
      inference_model: '',
      exec_model: '',
    },
    result_history: [],
    basket: { revision: 1, items: [] },
    suggestions: [blocked],
  };
  const workbenchState = {
    materials: [{ id: 'page1', kind: 'page', title: 'Page', revision: 1, partial: true }],
    tasks: [
      {
        id: 'page.summary',
        name: { zh: '快速看懂页面', en: 'Summarize page' },
        subject: 'text',
        model: true,
      },
    ],
    model_ready: true,
  };
  let workbenchReads = 0;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh' },
    runtime: {
      connect: () => ({}),
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'copilot.local' && message.command === 'table_state')
          return { result: { capture: null, jobs: [] } };
        if (message.type === 'copilot.connections') return { result: { cloud: null } };
        if (message.command === 'agent_catalog')
          return {
            result: {
              default_agent: 'hermes',
              onboarding_required: false,
              agents: [
                {
                  id: 'hermes',
                  name: 'Hermes',
                  installed: true,
                  configured: true,
                  status: 'configured',
                },
              ],
            },
          };
        if (message.command === 'logs_read') return { result: { entries: [], revision: 0 } };
        if (message.command === 'log_client') return { result: { accepted: true } };
        if (message.command === 'capability_state')
          return { result: { capabilities: {}, candidates: [] } };
        if (message.command === 'workbench_state') {
          workbenchReads++;
          return { result: structuredClone(workbenchState) };
        }
        if (message.command === 'workbench_plan')
          return {
            result: { card: ready, state: { ...state, revision: 2, suggestions: [ready] } },
          };
        if (message.command === 'execute')
          return {
            result: { ...state, revision: 3, suggestions: [{ ...ready, status: 'queued' }] },
          };
        return { result: structuredClone(state) };
      },
    },
    downloads: { download: async () => 1 },
  };
  const entrypoint = new URL('../../native-extension/copilot-panel.mjs', import.meta.url),
    source = await readFile(entrypoint, 'utf8');
  const modules = await Promise.all(
    [...source.matchAll(/^import .*? from ['"]([^'"]+)['"];?$/gm)].map(
      ([, path]) => import(new URL(path, entrypoint)),
    ),
  );
  Object.assign(dom.window, ...modules);
  try {
    dom.window.eval(source.replace(/^import\s[^;]*;\n/gm, ''));
    for (let i = 0; i < 6; i++) await tick();
    await doc.querySelector('#pending [data-id=same-id] [data-action=configure_task]').onclick();
    const checkbox = doc.querySelector('#task-workbench .workbench-material input[type=checkbox]');
    checkbox.checked = true;
    checkbox.onchange();
    doc.querySelector('#task-workbench form').requestSubmit();
    for (let i = 0; i < 6; i++) await tick();
    const executed = calls.filter((message) => message.command === 'execute');
    assert.equal(executed.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(executed[0].params)), { id: 'same-id' });
    assert.equal(
      workbenchReads,
      1,
      'ready plan must not be redirected back into stale configuration',
    );
    assert.match(doc.querySelector('#task-workbench > output').textContent, /已开始任务/);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('unload'));
    dom.window.close();
  }
});
test('workbench does not claim execution when dispatch returns no queue receipt', async () => {
  const { dom, panel, state, calls } = workbench();
  const base = panel.command;
  panel.command = async (name, params) => (name === 'execute' ? {} : base(name, params));
  await panel.open({ params: { task: 'table.clean', materials: ['m1'] } });
  panel.form.requestSubmit();
  await tick();
  assert.match(panel.notice.textContent, /尚未进入执行队列/);
  assert.doesNotMatch(panel.notice.textContent, /已开始任务/);
  assert.equal(panel.execute.disabled, false);
  dom.window.close();
});
test('live Agent readiness updates an open workbench without replacing user input or selections', async () => {
  const { dom, panel, state } = workbench();
  state.materials = [{ id: 'page1', kind: 'page', title: 'Article', revision: 1, partial: true }];
  await panel.open({ params: { task: 'page.question', materials: ['page1'] } });
  const question = panel.form.elements.namedItem('question'),
    instructions = panel.form.elements.namedItem('instructions');
  question.value = 'What is the evidence?';
  instructions.value = 'Keep the original sources';
  assert.equal(panel.execute.disabled, true);
  panel.syncReadiness({ enabled: true, ready: true });
  assert.equal(panel.execute.disabled, false);
  assert.equal(panel.form.elements.namedItem('question'), question);
  assert.equal(question.value, 'What is the evidence?');
  assert.equal(instructions.value, 'Keep the original sources');
  assert.deepEqual([...panel.selected], ['page1']);
  panel.syncReadiness({ enabled: true, ready: false });
  assert.equal(panel.execute.disabled, true);
  assert.equal(question.value, 'What is the evidence?');
  dom.window.close();
});
test('ten mixed recommendations keep task diversity and preserve explicit, running and result tasks', () => {
  const dom = new JSDOM(html),
    doc = dom.window.document;
  const recommendation = (id, type, index) => ({
    id,
    title: id,
    status: 'pending',
    action: type.startsWith('plugin') ? 'workflow.run' : 'assist.task',
    standard_task: !type.startsWith('plugin'),
    task_type: type,
    params: { task: type, flow: type },
    recommendation_state: 'needs_parameters',
    recommendation_rank: index,
  });
  const recommendations = [
    ...Array.from({ length: 6 }, (_, i) => recommendation('same-' + i, 'table.clean', i)),
    ...Array.from({ length: 8 }, (_, i) =>
      recommendation('other-' + i, i % 2 ? 'plugin.flow-' + i : 'page.task-' + i, 6 + i),
    ),
  ];
  const explicit = Array.from({ length: 3 }, (_, i) => ({
    ...recommendation('prepared-' + i, 'page.summary', 30 + i),
    explicit: true,
  }));
  const running = Array.from({ length: 12 }, (_, i) => ({
    id: 'run-' + i,
    title: 'Running ' + i,
    status: 'executing',
    action: 'general.task',
    params: {},
    started_at: 100,
  }));
  const results = Array.from({ length: 12 }, (_, i) => ({
    id: 'done-' + i,
    title: 'Done ' + i,
    status: 'completed',
    action: 'general.task',
    params: {},
    result: { verdict: 'Done' },
  }));
  renderDashboard(
    doc,
    {
      enabled: true,
      ready: true,
      locale: 'zh',
      suggestions: [...recommendations, ...explicit, ...running, ...results],
    },
    { command: async () => {} },
  );
  assert.equal(doc.querySelectorAll('#pending > article').length, 13);
  assert.equal(doc.querySelector('#suggestions-count').textContent, '10');
  assert.match(doc.querySelector('#prepared-tasks-notice').textContent, /3/);
  assert.equal(doc.querySelectorAll('#running > article').length, 12);
  assert.equal(doc.querySelectorAll('#results > article').length, 12);
  assert.equal(doc.querySelector('#more-suggestions'), null);
  assert.equal(doc.querySelector('#local-workbench'), null);
  const ranked = rankedSuggestions(recommendations, { locale: 'zh' });
  assert.deepEqual(
    ranked.map((row) => row.id),
    ['same-0', ...Array.from({ length: 8 }, (_, i) => 'other-' + i), 'same-1'],
  );
  for (const row of explicit)
    assert.match(doc.querySelector(`[data-id=${row.id}] .meta`).textContent, /已准备/);
  dom.window.close();
});
test('standard task cards route through the existing parameter panel before execution', async () => {
  const dom = new JSDOM(html),
    doc = dom.window.document,
    calls = [];
  const row = {
    id: 'ready-summary',
    title: '快速看懂页面',
    status: 'pending',
    standard_task: true,
    action: 'assist.task',
    params: { task: 'page.summary', materials: ['page1'], options: {} },
    recommendation_state: 'ready',
    local_task: false,
  };
  renderDashboard(
    doc,
    { enabled: false, ready: false, locale: 'zh', suggestions: [row] },
    { command: async (...args) => calls.push(args) },
  );
  const action = doc.querySelector('#pending [data-action=configure_task]');
  assert.ok(action);
  assert.equal(action.textContent, '执行');
  await action.onclick();
  assert.deepEqual(calls, [['configure_task', { id: 'ready-summary' }]]);
  assert.equal(doc.querySelector('#pending [data-action=execute]'), null);
  const { panel, state, dom: panelDom } = workbench();
  state.materials = [];
  await panel.open({
    title: '围绕问题阅读',
    capture_mode: 'page',
    params: { task: 'page.question', materials: [] },
  });
  assert.equal(
    panelDom.window.document.getElementById('task-workbench-title').textContent,
    '围绕问题阅读',
  );
  assert.match(panel.hint.textContent, /先读取当前页/);
  assert.equal(panel.execute.disabled, true);
  assert.ok(
    [...panel.root.querySelectorAll('button')].some(
      (button) => button.textContent === '读取当前页',
    ),
  );
  panelDom.window.close();
  dom.window.close();
});
test('opening another card clears the previous task execution or failure notice', async () => {
  const { dom, panel, state } = workbench();
  state.model_ready = true;
  state.materials = [{ id: 'page1', kind: 'page', title: 'Article', revision: 1, partial: true }];
  await panel.open({
    title: '围绕问题阅读',
    params: { task: 'page.question', materials: ['page1'] },
  });
  panel.form.elements.namedItem('question').value = 'What is the evidence?';
  panel.form.requestSubmit();
  await tick();
  assert.match(panel.notice.textContent, /已开始任务/);
  panel.root.close();
  await panel.open({
    title: '整理表格',
    capture_mode: 'table',
    params: { task: 'table.clean', materials: [] },
  });
  assert.equal(panel.notice.textContent, '');
  assert.equal(panel.task.value, 'table.clean');
  panel.notice.textContent = 'Previous task failed';
  panel.root.close();
  await panel.open({
    title: '围绕问题阅读',
    params: { task: 'page.question', materials: ['page1'] },
  });
  assert.equal(panel.notice.textContent, '');
  dom.window.close();
});
test('clean card keeps its intended task after reading page material and recovers after selecting a table', async () => {
  const { dom, panel, state } = workbench();
  state.model_ready = true;
  panel.capture = async (mode) => {
    state.materials.push(
      mode === 'page'
        ? { id: 'wrong-page', kind: 'page', title: 'Wrong page', revision: 1, partial: true }
        : { ...material('right-table'), title: 'Right table' },
    );
    return state;
  };
  await panel.open({
    title: '整理表格',
    capture_mode: 'table',
    params: { task: 'table.clean', materials: [] },
  });
  await [...panel.root.querySelectorAll('button')]
    .find((button) => button.textContent === '读取当前页')
    .onclick();
  assert.equal(panel.task.value, 'table.clean');
  assert.equal(dom.window.document.getElementById('task-workbench-title').textContent, '整理表格');
  assert.equal(panel.execute.disabled, true);
  assert.match(panel.readiness.textContent, /需要1份表格材料/);
  await [...panel.root.querySelectorAll('button')]
    .find((button) => button.textContent === '读取页面表格')
    .onclick();
  assert.equal(panel.task.value, 'table.clean');
  assert.equal(
    panel.execute.disabled,
    true,
    'mixed material selection must not be changed silently',
  );
  const wrong = [...panel.materials.querySelectorAll('.workbench-material')]
    .find((row) => row.textContent.includes('Wrong page'))
    .querySelector('input');
  wrong.checked = false;
  wrong.onchange();
  assert.equal(panel.task.value, 'table.clean');
  assert.equal(panel.execute.disabled, false);
  assert.deepEqual([...panel.selected], ['right-table']);
  dom.window.close();
});
test('task search retains the current choice but allows an explicit task change with mismatched materials', async () => {
  const { dom, panel } = workbench();
  await panel.open({ title: '整理表格', params: { task: 'table.clean', materials: [] } });
  panel.search.value = '围绕问题';
  panel.search.oninput();
  assert.equal(panel.task.value, 'table.clean');
  assert.ok([...panel.task.options].some((option) => option.value === 'page.question'));
  assert.ok(
    [...panel.task.options].every((option) =>
      ['table.clean', 'page.question'].includes(option.value),
    ),
  );
  panel.task.value = 'page.question';
  panel.task.onchange();
  assert.equal(
    dom.window.document.getElementById('task-workbench-title').textContent,
    '围绕问题阅读',
  );
  assert.equal(panel.execute.disabled, true);
  panel.search.value = 'no results';
  panel.search.oninput();
  assert.equal(panel.task.value, 'page.question');
  panel.search.value = '';
  panel.search.oninput();
  assert.equal(panel.task.options.length, panel.state.tasks.length);
  assert.equal(panel.task.value, 'page.question');
  dom.window.close();
});
