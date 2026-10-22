import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SettingsTabs } from '../../native-extension/copilot-settings-tabs.mjs';
import {
  SettingsForm,
  presetValues,
  readSettings,
} from '../../native-extension/copilot-settings.mjs';
import { renderDashboard, PanelViews } from '../../native-extension/copilot-view.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
function fixture(handler) {
  const dom = new JSDOM(html, { url: 'https://synthetic.test' }),
    real = dom.window.document,
    tabs = new SettingsTabs(real),
    doc = tabs.document,
    calls = [];
  dom.window.confirm = () => true;
  let state = {
    locale: 'zh',
    settings_saved: true,
    board_name: '合成看板',
    show_ball: true,
    selection_popup: true,
    page_annotations: true,
    memory: { enabled: true, history: [], habits: [] },
    config: { ...presetValues('balanced'), exec_transport: 'acp' },
    table_config: { max_pages: 50, delay_min: 1.5, delay_max: 3 },
  };
  const request = async (name, params) => {
    calls.push([name, params]);
    if (handler) {
      const result = await handler(name, params);
      if (result) return result;
    }
    if (name === 'configure') state = { ...state, config: { ...state.config, ...params } };
    if (name === 'preferences') {
      state = { ...state, ...params };
      for (const key of ['max_pages', 'delay_min', 'delay_max'])
        if (params['table_' + key] !== undefined)
          state.table_config = { ...state.table_config, [key]: params['table_' + key] };
    }
    if (name === 'settings') state = { ...state, ...params };
    if (name === 'memory') {
      state.memory = { ...state.memory, ...params };
      return state.memory;
    }
    if (name === 'directory_defaults')
      return { export_dir: '/synthetic/default', logs_dir: '/synthetic/logs' };
    if (name === 'models') return {};
    return state;
  };
  const form = new SettingsForm(doc, request, {
    explicitSave: true,
    revealField: (field) => tabs.reveal(field),
  });
  form.update(state);
  const edit = (id, value, type = 'input') => {
    const field = doc.getElementById(id);
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
    field.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    return field;
  };
  return {
    dom,
    real,
    doc,
    tabs,
    calls,
    form,
    edit,
    get state() {
      return state;
    },
    close() {
      form.dispose();
      dom.window.close();
    },
  };
}

test('settings mount only the current category while inactive controls keep their identity and bindings', () => {
  const f = fixture();
  try {
    assert.equal(f.real.getElementById('setting-exec_model'), null);
    const original = f.doc.getElementById('setting-exec_model');
    assert.equal(original.isConnected, false);
    assert.equal(f.real.querySelectorAll('#settings-tabs [role=tab]').length, 6);
    f.tabs.select('execution');
    assert.equal(f.real.getElementById('setting-exec_model'), original);
    assert.equal(f.real.getElementById('board-name-input'), null);
    f.tabs.select('general');
    assert.equal(f.doc.getElementById('setting-exec_model'), original);
    assert.ok(
      [...f.tabs.sections.values()]
        .flat()
        .every((el) => el.parentElement === f.tabs.panel || el.parentElement === f.tabs.parked),
    );
  } finally {
    f.close();
  }
});

test('keyboard tabs use roving focus, wrap with arrows and support Home/End; each category remembers scroll', () => {
  const f = fixture();
  try {
    const nav = f.real.getElementById('settings-tabs');
    f.tabs.panel.scrollTop = 74;
    nav.firstChild.dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    assert.equal(f.tabs.current, 'about');
    assert.equal(f.real.activeElement, nav.lastChild);
    assert.equal(nav.querySelectorAll('[tabindex="0"]').length, 1);
    nav.lastChild.dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    assert.equal(f.tabs.current, 'general');
    assert.equal(f.tabs.panel.scrollTop, 74);
    nav.firstChild.dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    assert.equal(f.tabs.current, 'about');
    assert.equal(f.tabs.panel.getAttribute('aria-labelledby'), nav.lastChild.id);
  } finally {
    f.close();
  }
});

test('drafts survive category changes and external dashboard/model refresh without any write', async () => {
  const f = fixture();
  try {
    f.edit('board-name-input', '未保存的名称');
    f.edit('ball', false, 'change');
    f.tabs.select('execution');
    f.edit('setting-exec_model', 'manual', 'change');
    f.edit('exec_model-manual', 'vendor:draft');
    f.tabs.select('advanced');
    f.edit('setting-max_parallel', '2', 'change');
    renderDashboard(f.doc, { ...f.state, suggestions: [], templates: {}, tokens: 0 });
    f.form.update({
      ...f.state,
      board_name: '外部刷新',
      show_ball: true,
      config: { ...f.state.config, max_parallel: 1 },
    });
    await f.form.load();
    assert.equal(readSettings(f.doc).exec_model, 'vendor:draft');
    assert.equal(readSettings(f.doc).max_parallel, 2);
    assert.equal(f.doc.getElementById('board-name-input').value, '未保存的名称');
    assert.equal(f.doc.getElementById('ball').checked, false);
    assert.deepEqual(f.calls.map(([name]) => name).sort(), ['directory_defaults', 'models']);
    assert.equal(f.real.getElementById('settings-save').disabled, false);
  } finally {
    f.close();
  }
});

test('saving persists all edited groups through existing commands and clears only acknowledged drafts', async () => {
  const f = fixture();
  try {
    f.edit('board-name-input', '新名称');
    f.edit('ball', false, 'change');
    f.tabs.select('advanced');
    f.edit('setting-max_parallel', '2', 'change');
    f.tabs.select('privacy');
    f.edit('memory-enabled', false, 'change');
    assert.equal(await f.form.saveDrafts(), true);
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['configure', 'preferences', 'settings', 'memory'],
    );
    assert.equal(f.state.config.max_parallel, 2);
    assert.equal(f.state.board_name, '新名称');
    assert.equal(f.state.show_ball, false);
    assert.equal(f.state.memory.enabled, false);
    assert.equal(f.form.drafts.size, 0);
    assert.equal(f.real.getElementById('settings-save').disabled, true);
  } finally {
    f.close();
  }
});

test('failed multi-command save retains unsaved fields and retry does not repeat successful groups', async () => {
  let failing = true;
  const f = fixture((name) => {
    if (name === 'settings' && failing) throw Error('synthetic failure');
  });
  try {
    f.edit('board-name-input', '已经保存的名称');
    f.edit('ball', false, 'change');
    assert.equal(await f.form.saveDrafts(), false);
    assert.equal(f.form.drafts.has('board-name-input'), false);
    assert.equal(f.form.drafts.get('ball'), false);
    assert.match(f.real.getElementById('settings-draft-status').textContent, /重试/);
    failing = false;
    assert.equal(await f.form.saveDrafts(), true);
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['preferences', 'settings', 'settings'],
    );
  } finally {
    f.close();
  }
});

test('edits made during a slow save remain a draft and a stale response never replaces them', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(async (name) => {
    if (name === 'preferences') await held;
  });
  try {
    f.edit('board-name-input', '第一次');
    const saving = f.form.saveDrafts();
    f.edit('board-name-input', '第二次');
    release();
    assert.equal(await saving, true);
    assert.equal(f.doc.getElementById('board-name-input').value, '第二次');
    assert.equal(f.form.drafts.get('board-name-input'), '第二次');
    assert.equal(f.real.getElementById('settings-save').disabled, false);
  } finally {
    f.close();
  }
});

test('invalid inactive settings reveal their category and never submit hidden invalid values', async () => {
  const f = fixture();
  try {
    f.tabs.select('advanced');
    f.edit('setting-max_parallel', '8', 'change');
    f.tabs.select('general');
    assert.equal(await f.form.saveDrafts(), false);
    assert.equal(f.tabs.current, 'advanced');
    assert.equal(f.calls.length, 0);
    assert.equal(f.form.drafts.get('setting-max_parallel'), '8');
  } finally {
    f.close();
  }
});

test('invalid export limits reveal the parked category before showing validation', async () => {
  const f = fixture();
  try {
    f.tabs.select('export');
    f.edit('table-max-pages', '0', 'change');
    f.tabs.select('general');
    assert.equal(await f.form.saveDrafts(), false);
    assert.equal(f.tabs.current, 'export');
    assert.equal(f.calls.length, 0);
    assert.equal(f.form.drafts.get('table-max-pages'), '0');
    assert.equal(f.doc.getElementById('table-max-pages').isConnected, true);
  } finally {
    f.close();
  }
});

test('leave confirmation preserves drafts; reset asks once and restores saved values across inactive groups', () => {
  const f = fixture();
  try {
    const views = new PanelViews(f.doc);
    views.beforeShow = (name) =>
      views.current !== 'settings' || name === 'settings' || f.form.confirmLeave();
    views.show('settings');
    f.edit('board-name-input', '草稿');
    f.dom.window.confirm = () => false;
    views.show('work');
    assert.equal(views.current, 'settings');
    f.form.resetDrafts();
    assert.equal(f.form.drafts.size, 1);
    f.dom.window.confirm = () => true;
    views.show('work');
    assert.equal(views.current, 'work');
    assert.equal(f.form.drafts.size, 1);
    f.tabs.select('about');
    f.form.resetDrafts();
    assert.equal(f.doc.getElementById('board-name-input').value, '合成看板');
    assert.equal(f.form.drafts.size, 0);
  } finally {
    f.close();
  }
});

test('choosing the default export folder stages it until Save and reports that distinction', async () => {
  const f = fixture();
  try {
    f.tabs.select('export');
    await f.form.resetExportDirectory();
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/default');
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['directory_defaults'],
    );
    assert.match(f.doc.getElementById('export-directory-status').textContent, /保存更改/);
    assert.equal(await f.form.saveDrafts(), true);
    assert.equal(f.state.table_export_dir, '/synthetic/default');
  } finally {
    f.close();
  }
});

test('default Agent selection stays a draft through Agent refresh and saves only on explicit Save', async () => {
  const { AgentPanel } = await import('../../native-extension/copilot-agent-panel.mjs');
  const catalog = {
    default_agent: 'one',
    agents: [
      { id: 'one', name: 'One', installed: true, configured: true },
      { id: 'two', name: 'Two', installed: true, configured: true },
    ],
  };
  const f = fixture((name, params) =>
    name === 'agent_select' ? { ...catalog, default_agent: params.agent_id } : undefined,
  );
  const agent = new AgentPanel(f.doc, f.form.request);
  try {
    agent.apply(catalog);
    agent.render();
    f.form.bindAgent(agent);
    f.tabs.select('execution');
    f.edit('agent-default-select', 'two', 'change');
    assert.equal(f.calls.length, 0);
    agent.render();
    f.form.update(f.state);
    assert.equal(f.doc.getElementById('agent-default-select').value, 'two');
    assert.equal(agent.catalog.default_agent, 'one');
    f.tabs.select('general');
    assert.equal(await f.form.saveDrafts(), true);
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ['agent_select'],
    );
    assert.equal(agent.catalog.default_agent, 'two');
    assert.equal(f.form.drafts.size, 0);
  } finally {
    agent.dispose();
    f.close();
  }
});

test('manual model choice requires a model ID and reversed export delays reveal the export group', async () => {
  const f = fixture();
  try {
    f.tabs.select('execution');
    f.edit('setting-exec_model', 'manual', 'change');
    f.edit('exec_model-manual', '');
    f.tabs.select('general');
    assert.equal(await f.form.saveDrafts(), false);
    assert.equal(f.tabs.current, 'execution');
    assert.equal(f.calls.length, 0);
    f.edit('exec_model-manual', 'vendor:valid');
    f.tabs.select('export');
    f.edit('table-delay-min', '5');
    f.edit('table-delay-max', '2');
    f.tabs.select('general');
    assert.equal(await f.form.saveDrafts(), false);
    assert.equal(f.tabs.current, 'export');
    assert.match(f.real.getElementById('settings-draft-status').textContent, /最大页间间隔/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('the scoped document also renders existing SVG trends and rich result text without touching detached settings', async () => {
  const { renderResult } = await import('../../native-extension/copilot-result-view.mjs');
  const { renderTaskContent } = await import('../../native-extension/copilot-result-content.mjs');
  const f = fixture();
  try {
    const article = f.doc.createElement('article');
    renderResult(
      f.doc,
      article,
      {
        id: 'trend',
        action: 'seo.trends',
        result: {
          verdict: '合成趋势',
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
      },
      { full: true },
    );
    assert.equal(article.querySelectorAll('svg polyline').length, 1);
    assert.equal(f.doc.getElementById('setting-exec_model').isConnected, false);
    assert.equal(typeof f.doc.createTextNode, 'function');
    const rich = f.doc.createElement('article');
    renderTaskContent(f.doc, rich, {
      id: 'markdown',
      action: 'custom.task',
      result: '# 说明\n\n附加**原始文本**',
    });
    assert.equal(rich.querySelector('strong').textContent, '原始文本');
  } finally {
    f.close();
  }
});

test('parked settings keep one control registration through real observer cycles and tab switches', async () => {
  const { mountControls } = await import('../../native-extension/copilot-controls.mjs');
  const f = fixture(),
    controls = mountControls(f.doc);
  const settle = async () => {
    await new Promise((done) => setTimeout(done, 0));
    controls.sync();
    await new Promise((done) => setTimeout(done, 0));
  };
  try {
    await settle();
    const count = () =>
      f.doc.querySelectorAll('.shared-stepper,.shared-dropdown,.mode-options button').length;
    const initialCount = count();
    const field = f.doc.getElementById('table-max-pages');
    const wrapper = field.parentElement;
    assert.equal(wrapper.className, 'shared-stepper');
    assert.equal(wrapper.querySelectorAll('button').length, 2);
    for (let index = 0; index < 24; index++) {
      f.tabs.select(['execution', 'advanced', 'export', 'general'][index % 4]);
      await settle();
      assert.equal(count(), initialCount, `no enhanced control growth on cycle ${index}`);
      for (const input of f.doc.querySelectorAll('input[type=number]')) {
        assert.equal(input.parentElement.className, 'shared-stepper');
        assert.equal(input.parentElement.querySelectorAll('button').length, 2);
        assert.equal(input.parentElement.querySelectorAll('.shared-stepper').length, 0);
      }
      for (const select of f.doc.querySelectorAll('select')) {
        assert.equal(
          select.parentElement.querySelectorAll(
            `:scope > .shared-dropdown > [aria-controls="options-${select.id}"]`,
          ).length,
          1,
        );
      }
      assert.equal(f.doc.querySelector('.mode-options').querySelectorAll('button').length, 3);
    }
    f.tabs.select('export');
    await settle();
    const before = Number(field.value);
    wrapper.querySelector('button:last-child').click();
    await settle();
    assert.equal(Number(field.value), before + 1, 'one click applies one step');
    assert.equal(field.parentElement, wrapper, 'the original enhanced control remains registered');
    wrapper.remove();
    controls.sync();
    assert.equal(f.doc.contains(field), false, 'real removals still leave the document scope');
  } finally {
    controls.dispose();
    f.close();
  }
});

test('expanding the settings menu reveals category choices without mounting inactive content or changing drafts and scroll', () => {
  const f = fixture();
  try {
    const toggle = f.real.getElementById('settings-menu-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), 'settings-tabs');
    assert.equal(toggle.textContent, '展开所有菜单');
    assert.equal(
      toggle.closest('[role=tablist]'),
      null,
      'toggle is separate from the roving tab controls',
    );
    f.edit('board-name-input', '未保存菜单草稿');
    f.tabs.panel.scrollTop = 47;
    const nodes = [...f.tabs.panel.children];
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, '收起菜单');
    assert.equal(f.tabs.nav.parentElement.dataset.expanded, 'true');
    assert.equal(f.tabs.nav.querySelectorAll('[role=tab]').length, 6);
    assert.deepEqual([...f.tabs.panel.children], nodes);
    assert.equal(f.real.getElementById('setting-exec_model'), null);
    assert.equal(f.tabs.panel.scrollTop, 47);
    assert.equal(f.form.drafts.get('board-name-input'), '未保存菜单草稿');
    const current = f.tabs.nav.querySelector('[aria-selected=true]');
    current.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(f.tabs.current, 'about');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(f.tabs.current, 'about');
    assert.equal(f.tabs.nav.querySelectorAll('[tabindex="0"]').length, 1);
    f.tabs.select('general');
    assert.equal(f.tabs.panel.scrollTop, 47);
    assert.equal(f.doc.getElementById('board-name-input').value, '未保存菜单草稿');
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('settings menu toggle localizes both states without changing selected categories', () => {
  const f = fixture();
  try {
    const toggle = f.real.getElementById('settings-menu-toggle');
    f.real.documentElement.lang = 'en-US';
    f.tabs.localize();
    assert.equal(toggle.textContent, 'Expand all menus');
    toggle.click();
    assert.equal(toggle.textContent, 'Collapse menu');
    assert.equal(f.tabs.current, 'general');
    f.real.documentElement.lang = 'zh-CN';
    f.tabs.localize();
    assert.equal(toggle.textContent, '收起菜单');
  } finally {
    f.close();
  }
});
