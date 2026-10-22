import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fillThroughInput } from './editable-fixture.mjs';
import { Executor, semanticWorldDeclaration } from '../../native-extension/core.mjs';
import { workspaceFixture, trustedTask } from '../native-extension/workspace-fixture.mjs';
import { withSyntheticOverlay } from '../native-extension/overlay-fixture.mjs';
const html = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
function setup() {
  const dom = new JSDOM(html, {
    url: 'https://fixture.example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom,
    document = window.document;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 20,
    top: 20,
    right: 120,
    bottom: 50,
    width: 100,
    height: 30,
  });
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  window.HTMLElement.prototype.scrollIntoView = function () {};
  let hit = null;
  document.elementFromPoint = () => hit;
  const call = window.eval(`(${semanticWorldDeclaration})`),
    binding = { taskId: 'task', documentId: 'loader', leaseId: 'lease' };
  const find = (name, roles) => {
    const page = call('semantic_snapshot', {
      binding,
      options: { mode: 'interactive', query: name, roles, budget: 5000 },
    });
    const item = page.items.find((row) => row.name === name);
    assert.ok(item, name);
    hit =
      document.querySelector(
        `#${{ 地区: 'combo', 受控输入: 'controlled', 正文: 'editor', 保存: 'save' }[name]}`,
      ) || null;
    return { binding, snapshotId: page.snapshotId, ref: item.ref };
  };
  return {
    dom,
    window,
    document,
    call,
    binding,
    find,
    setHit: (node) => {
      hit = node;
    },
    close() {
      dom.window.close();
    },
  };
}

// 中文注释：执行实际安装声明及热调用声明，不把页面库替换成计数桩；只有 CDP 传输在离线 DOM 中模拟。
function installedCaller(f) {
  const commands = [];
  const executor = new Executor({
    tabs: {},
    debugger: {
      sendCommand: async (_target, method, params) => {
        assert.equal(method, 'Runtime.callFunctionOn');
        commands.push(params);
        try {
          return {
            result: {
              value: await f.window.eval(`(${params.functionDeclaration})`)(
                ...(params.arguments || []).map((argument) => argument.value),
              ),
            },
          };
        } catch (error) {
          return { exceptionDetails: { exception: { description: error.toString() } } };
        }
      },
    },
  });
  return {
    commands,
    call: (op, payload) =>
      executor.callSemanticWorld({ tabId: 7 }, 'main', op, payload, () => {}, 17),
  };
}

test('结构解析器按需装入隔离库，普通读取不承担解析器传输，续读复用同一解析实例', async () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<main><p>结构化正文</p></main>';
    const api = installedCaller(f);
    await api.call('semantic_snapshot', { binding: f.binding, options: { mode: 'content' } });
    assert.ok(Buffer.byteLength(api.commands[0].functionDeclaration) < 65000);
    const parsed = await api.call('page.parse', {
      binding: f.binding,
      options: { sections: ['blocks'] },
    });
    assert.equal(parsed.blocks[0].text, '结构化正文');
    const count = api.commands.length;
    await api.call('page.parse', { binding: f.binding, options: { sections: ['blocks'] } });
    assert.equal(api.commands.length, count + 1);
    assert.ok(Buffer.byteLength(api.commands.at(-1).functionDeclaration) < 1000);
  } finally {
    f.close();
  }
});

// 中文注释：只模拟浏览器传输和指针派发，计划、等待、选项检查及回读均通过真实 Executor 执行。
async function selectionExecutor(f, { hidden = false } = {}) {
  f.dom.reconfigure({ url: 'https://example.com/' });
  if (hidden)
    Object.defineProperty(f.document, 'visibilityState', { value: 'hidden', configurable: true });
  f.window.__fastAutomationOverlay = {
    highlight: { prepare: () => ({ ok: true }), verify: () => ({ ok: true }) },
  };
  const browser = workspaceFixture();
  browser.api.debugger = withSyntheticOverlay({
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target, method, params) => {
      if (method === 'Page.getFrameTree')
        return {
          frameTree: { frame: { id: 'main', url: 'https://example.com/', loaderId: 'loader' } },
        };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 };
      if (method === 'Network.enable') return {};
      assert.equal(method, 'Runtime.callFunctionOn');
      try {
        return {
          result: {
            value: await f.window.eval(`(${params.functionDeclaration})`)(
              ...(params.arguments || []).map((argument) => argument.value),
            ),
          },
        };
      } catch (error) {
        return { exceptionDetails: { exception: { description: error.toString() } } };
      }
    },
  });
  const executor = new Executor(browser.api),
    task = trustedTask();
  await executor.approve(task);
  executor.setMode({ ...task, activeMode: 'full', modeGeneration: 2 });
  executor.interactionsFor = () => ({
    clickBoundTarget: async (_scope, { readTarget, onDispatch }) => {
      const point = await readTarget();
      onDispatch();
      f.document.elementFromPoint(point.x, point.y).click();
    },
  });
  const binding = executor.semanticBinding(executor.tasks.get('a'), 1, 'loader');
  const page = f.call('semantic_snapshot', {
    binding,
    options: { mode: 'interactive', query: '地区', roles: ['combobox', 'listbox'], budget: 1600 },
  });
  const request = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    modeGeneration: 2,
    action: 'ref_select_option',
    binding,
    snapshotId: page.snapshotId,
    ref: page.items[0].ref,
    by: 'value',
    values: ['b'],
  };
  return () => executor.execute(request);
}

function delayedSelect(
  f,
  {
    association = 'aria-controls',
    options = '<div role="option" data-value="b">Beta</div>',
    delay = 100,
    lazyList = false,
  } = {},
) {
  f.document.body.innerHTML = `<button id="combo" role="combobox" aria-label="地区" ${association}="options" aria-expanded="false">地区</button><div id="options" role="listbox" hidden></div><div role="listbox"><div id="outside" role="option" data-value="b">Beta</div></div>`;
  const combo = f.document.querySelector('#combo'),
    counts = { open: 0, option: 0, outside: 0 };
  let list = f.document.querySelector('#options');
  if (lazyList) list.remove();
  f.setHit(combo);
  f.document.elementFromPoint = (x) => (x < 150 ? combo : list.querySelector('[role="option"]'));
  f.document.querySelector('#outside').onclick = () => counts.outside++;
  combo.onclick = () => {
    counts.open++;
    combo.setAttribute('aria-expanded', 'true');
    if (!lazyList) list.hidden = false;
    if (options !== null)
      f.window.setTimeout(() => {
        if (lazyList) {
          list = f.document.createElement('div');
          list.id = 'options';
          list.setAttribute('role', 'listbox');
          f.document.body.append(list);
        }
        list.innerHTML = options;
        for (const option of list.querySelectorAll('[role="option"]')) {
          option.getBoundingClientRect = () => ({
            left: 200,
            top: 20,
            right: 300,
            bottom: 50,
            width: 100,
            height: 30,
          });
          option.onclick = () => {
            counts.option++;
            option.setAttribute('aria-selected', 'true');
            combo.dataset.selected = 'b';
            list.hidden = true;
          };
        }
      }, delay);
  };
  return counts;
}

test('完整选择入口等待展开后 100ms 的 data-value 选项，前后台与两种关联均只点击一次', async () => {
  for (const hidden of [false, true])
    for (const association of ['aria-controls', 'aria-owns']) {
      const f = setup();
      try {
        const counts = delayedSelect(f, { association }),
          run = await selectionExecutor(f, { hidden });
        const result = await run();
        assert.equal(result.verified, true);
        assert.equal(result.selectedCount, 1);
        assert.equal(f.document.querySelector('#combo').dataset.selected, 'b');
        assert.deepEqual(counts, { open: 1, option: 1, outside: 0 });
      } finally {
        f.close();
      }
    }
});

test('完整选择支持点击后才挂载的 portal 列表，前后台均只展开和选择一次', async () => {
  for (const hidden of [false, true]) {
    const f = setup();
    try {
      const counts = delayedSelect(f, { lazyList: true }),
        run = await selectionExecutor(f, { hidden });
      const result = await run();
      assert.equal(result.verified, true);
      assert.deepEqual(counts, { open: 1, option: 1, outside: 0 });
    } finally {
      f.close();
    }
  }
});

test('延迟列表在展开时换绑关联必须拒绝，其他列表选项不点击也不重放', async () => {
  for (const hidden of [false, true])
    for (const association of ['aria-controls', 'aria-owns']) {
      const f = setup();
      try {
        const counts = delayedSelect(f, { lazyList: true, association });
        const combo = f.document.querySelector('#combo'),
          foreign = f.document.querySelector('#outside');
        foreign.parentElement.id = 'other';
        foreign.getBoundingClientRect = () => ({
          left: 220,
          top: 20,
          right: 320,
          bottom: 50,
          width: 100,
          height: 30,
        });
        foreign.onclick = () => {
          counts.outside++;
          foreign.setAttribute('aria-selected', 'true');
        };
        f.document.elementFromPoint = (x) => (x < 150 ? combo : foreign);
        combo.addEventListener('click', () => combo.setAttribute(association, 'other'));
        const run = await selectionExecutor(f, { hidden });
        await assert.rejects(
          run(),
          (error) => error.message.includes('STALE_REF') && error.preDispatch === false,
        );
        assert.deepEqual(counts, { open: 1, option: 0, outside: 0 });
      } finally {
        f.close();
      }
    }
});

test('展开后有界等待超时仍报缺失，关联范围外的同值项从未点击，已展开不重放', async () => {
  for (const [hidden, lazyList] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const f = setup();
    try {
      const counts = delayedSelect(f, { options: null, lazyList }),
        run = await selectionExecutor(f, { hidden }),
        start = Date.now();
      await assert.rejects(
        run(),
        (error) => error.message.includes('SELECT_OPTION_MISSING') && error.preDispatch === false,
      );
      assert.ok(Date.now() - start >= 1500);
      assert.deepEqual(counts, { open: 1, option: 0, outside: 0 });
    } finally {
      f.close();
    }
  }
});

test('异步出现的歧义和禁用项立即拒绝，展开派发后无选项点击或重放', async () => {
  for (const hidden of [false, true])
    for (const [options, code] of [
      [
        '<div role="option" data-value="b">Beta</div><div role="option" data-value="b">Other</div>',
        'SELECT_OPTION_AMBIGUOUS',
      ],
      [
        '<div role="option" data-value="b" aria-disabled="true">Beta</div>',
        'SELECT_OPTION_DISABLED',
      ],
    ]) {
      const f = setup();
      try {
        const counts = delayedSelect(f, { options }),
          run = await selectionExecutor(f, { hidden });
        await assert.rejects(
          run(),
          (error) => error.message.includes(code) && error.preDispatch === false,
        );
        assert.deepEqual(counts, { open: 1, option: 0, outside: 0 });
      } finally {
        f.close();
      }
    }
});

test('ARIA value 属性优先于 data-value，无值属性不回退名称，标签匹配保持不变', () => {
  const f = setup();
  try {
    const option = f.document.querySelector('#options [role="option"]'),
      token = { ...f.find('地区', ['combobox']), by: 'value', values: ['cn'] };
    f.document.querySelector('#combo').setAttribute('aria-expanded', 'true');
    option.setAttribute('value', 'primary');
    assert.throws(() => f.call('plan_ref_select_option', token), /SELECT_OPTION_MISSING/);
    assert.equal(f.call('plan_ref_select_option', { ...token, values: ['primary'] }).kind, 'aria');
    option.removeAttribute('value');
    option.removeAttribute('data-value');
    option.setAttribute('aria-valuetext', '中国');
    assert.throws(
      () => f.call('plan_ref_select_option', { ...token, values: ['中国'] }),
      /SELECT_OPTION_MISSING/,
    );
    assert.equal(
      f.call('plan_ref_select_option', { ...token, by: 'label', values: ['中国'] }).kind,
      'aria',
    );
  } finally {
    f.close();
  }
});

test('未关联、多个关联或已存在的非 listbox 容器均在任何展开前拒绝', async () => {
  for (const association of ['', 'aria-controls="options other"', 'aria-controls="options"']) {
    const f = setup();
    try {
      f.document.body.innerHTML = `<button id="combo" role="combobox" aria-label="地区" ${association} aria-expanded="false">地区</button><div id="options"><div role="option" data-value="b">Beta</div></div>`;
      let clicks = 0;
      f.document.querySelector('#combo').onclick = () => clicks++;
      f.setHit(f.document.querySelector('#combo'));
      const run = await selectionExecutor(f);
      await assert.rejects(
        run(),
        (error) =>
          error.message.includes('CUSTOM_SELECT_UNSUPPORTED') && error.preDispatch === true,
      );
      assert.equal(clicks, 0);
    } finally {
      f.close();
    }
  }
});

test('完整原生 select 入口保留 value、label、index、多选和 input/change 回读', async () => {
  const f = setup();
  try {
    f.document.body.innerHTML =
      '<select id="combo" multiple aria-label="地区"><option value="a"> 甲 </option><option value="b">乙</option></select>';
    const select = f.document.querySelector('select'),
      events = [];
    f.setHit(select);
    for (const type of ['input', 'change'])
      select.addEventListener(type, (event) => events.push([event.type, event.bubbles]));
    const run = await selectionExecutor(f),
      result = await run();
    assert.equal(result.kind, 'native-select');
    assert.equal(result.verified, true);
    assert.equal(select.value, 'b');
    const token = f.find('地区', ['listbox']);
    for (const [by, values] of [
      ['value', ['a', 'b']],
      ['label', ['甲']],
      ['index', [1]],
    ]) {
      const result = f.call('apply_native_ref_select_option', { ...token, by, values });
      assert.equal(result.verified, true);
      assert.equal(result.selectedCount, values.length);
    }
    assert.deepEqual(
      events,
      Array.from({ length: 4 }, () => [
        ['input', true],
        ['change', true],
      ]).flat(),
    );
    assert.throws(
      () => f.call('plan_ref_select_option', { ...token, by: 'value', values: ['missing'] }),
      /SELECT_OPTION_MISSING/,
    );
    select.options[0].disabled = true;
    assert.throws(
      () => f.call('plan_ref_select_option', { ...token, by: 'value', values: ['a'] }),
      /SELECT_OPTION_DISABLED/,
    );
    assert.equal(events.length, 8);
  } finally {
    f.close();
  }
});

test('菜单复选与单选共用勾选动作，角色 token 回退和状态回读一致', async () => {
  for (const role of ['future menuitemcheckbox', 'menuitemradio']) {
    const f = setup();
    try {
      f.document.body.innerHTML = `<div role="${role}" tabindex="0" aria-label="显示列" aria-checked="false"></div>`;
      const node = f.document.querySelector('div'),
        api = installedCaller(f);
      f.setHit(node);
      const page = await api.call('semantic_snapshot', {
          binding: f.binding,
          options: { query: '显示列' },
        }),
        item = page.items[0];
      assert.ok(item.actions.includes('set_checked'));
      const payload = {
        binding: f.binding,
        snapshotId: page.snapshotId,
        ref: item.ref,
        checked: true,
      };
      assert.equal((await api.call('plan_ref_set_checked', payload)).needsClick, true);
      node.setAttribute('aria-checked', 'true');
      assert.equal((await api.call('read_ref_set_checked', payload)).verified, true);
      if (role === 'menuitemradio')
        await assert.rejects(
          api.call('plan_ref_set_checked', { ...payload, checked: false }),
          /RADIO_CANNOT_UNCHECK/,
        );
    } finally {
      f.close();
    }
  }
});
test('原生 mixed 复选框不因 checked=false 误判为无需操作', async () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<input type="checkbox" aria-label="全部">';
    const node = f.document.querySelector('input');
    node.indeterminate = true;
    f.setHit(node);
    const api = installedCaller(f),
      page = await api.call('semantic_snapshot', {
        binding: f.binding,
        options: { query: '全部' },
      });
    const payload = {
      binding: f.binding,
      snapshotId: page.snapshotId,
      ref: page.items[0].ref,
      checked: true,
    };
    assert.equal(page.items[0].checked, 'mixed');
    await assert.rejects(
      api.call('plan_ref_set_checked', { ...payload, checked: false }),
      (error) => error.preDispatch === true && /TARGET_STATE_UNKNOWN/.test(error.message),
    );
    assert.equal(node.checked, false);
    assert.equal(node.indeterminate, true);
    assert.equal((await api.call('plan_ref_set_checked', payload)).needsClick, true);
    node.indeterminate = false;
    node.checked = true;
    assert.equal((await api.call('read_ref_set_checked', payload)).verified, true);
  } finally {
    f.close();
  }
});
test('ARIA 只读编辑区和非文本 input 在准备及实际填写前拒绝，无输入事件', async () => {
  for (const html of [
    '<div contenteditable aria-readonly="true" aria-label="字段"></div>',
    '<input type="checkbox" aria-label="字段">',
    '<input type="range" aria-label="字段">',
  ]) {
    const f = setup();
    try {
      f.document.body.innerHTML = html;
      const node = f.document.body.firstElementChild;
      f.setHit(node);
      let events = 0;
      node.addEventListener('input', () => events++);
      const api = installedCaller(f),
        page = await api.call('semantic_snapshot', {
          binding: f.binding,
          options: { query: '字段' },
        });
      const payload = {
        binding: f.binding,
        snapshotId: page.snapshotId,
        ref: page.items[0].ref,
        text: '不应填写',
      };
      for (const op of ['assess_ref_fill', 'prepare_ref_fill', 'ref_fill'])
        await assert.rejects(api.call(op, payload), /TARGET_NOT_ACTIONABLE/);
      assert.equal(events, 0);
      assert.notEqual(node.value || node.textContent, '不应填写');
    } finally {
      f.close();
    }
  }
});

test('实际 CDP 安装后填写各阶段保留资格检查和敏感拒绝，不额外派发', async () => {
  const cases = [
    ['input', '', true],
    ['textarea', '', true],
    ['div', 'contenteditable="true"', true],
    ['div', 'contenteditable', true],
    ['div', 'contenteditable="plaintext-only"', true],
    ['div', 'role="textbox"', false],
    ['input', 'readonly', false],
    ['input', 'disabled', false],
    ['input', 'type="file"', false],
    ['input', 'type="password"', 'sensitive'],
  ];
  for (const [tag, attributes, allowed] of cases) {
    const f = setup();
    try {
      f.document.body.innerHTML = `<${tag} id="field" aria-label="字段" ${attributes}></${tag}>`;
      const field = f.document.querySelector('#field'),
        api = installedCaller(f);
      f.setHit(field);
      let events = 0;
      field.addEventListener('input', () => events++);
      const page = await api.call('semantic_snapshot', {
        binding: f.binding,
        options: { query: '字段' },
      });
      const token = { binding: f.binding, snapshotId: page.snapshotId, ref: page.items[0].ref };
      if (allowed === true) {
        assert.equal((await api.call('assess_ref_fill', token)).targetAssessment, 'ordinary');
        assert.equal((await api.call('prepare_ref_fill', token)).code, 'HIGHLIGHT_UNAVAILABLE');
        const payload = { ...token, text: '测试填写' };
        const result =
          tag === 'div'
            ? (await fillThroughInput(f, payload)).result
            : await api.call('ref_fill', payload);
        assert.equal(result.verified, true);
        assert.equal(events, 1);
      } else {
        if (allowed === 'sensitive')
          assert.equal((await api.call('assess_ref_fill', token)).fieldKind, 'password');
        else await assert.rejects(api.call('assess_ref_fill', token), /TARGET_NOT_ACTIONABLE/);
        for (const op of ['prepare_ref_fill', 'ref_fill'])
          await assert.rejects(
            api.call(op, { ...token, text: '禁止填写' }),
            (error) =>
              error.preDispatch === true &&
              /TARGET_NOT_ACTIONABLE|TARGET_DISABLED|SENSITIVE_TARGET/.test(error.message),
          );
        assert.equal(events, 0);
        assert.equal(field.value || field.textContent, '');
      }
      assert.equal(
        api.commands.filter((params) =>
          params.functionDeclaration.includes('const createPageSemantics='),
        ).length,
        1,
      );
    } finally {
      f.close();
    }
  }
});

test('实际安装的 ARIA 计划与指针阶段一致拒绝缺失、歧义及禁用选项', async () => {
  for (const role of ['combobox', 'listbox'])
    for (const by of ['value', 'label']) {
      const f = setup();
      try {
        const inside = role === 'listbox';
        f.document.body.innerHTML = `<div id="combo" role="${role}" aria-label="地区" aria-controls="options" aria-expanded="true">${inside ? '<div role="option" data-value="cn">中国</div>' : ''}</div>${inside ? '' : '<div id="options" role="listbox"><div role="option" data-value="cn">中国</div></div>'}`;
        const combo = f.document.querySelector('#combo'),
          option = f.document.querySelector('[role="option"]'),
          api = installedCaller(f);
        option.getBoundingClientRect = () => ({
          left: 200,
          top: 20,
          right: 300,
          bottom: 50,
          width: 100,
          height: 30,
        });
        f.document.elementFromPoint = (x) => (x < 150 ? combo : option);
        const page = await api.call('semantic_snapshot', {
          binding: f.binding,
          options: { query: '地区' },
        });
        const token = {
          binding: f.binding,
          snapshotId: page.snapshotId,
          ref: page.items[0].ref,
          by,
          values: [by === 'value' ? 'cn' : '中国'],
        };
        assert.equal((await api.call('plan_ref_select_option', token)).needsChange, true);
        assert.deepEqual(
          JSON.parse(
            JSON.stringify(
              await api.call('pointer_target', {
                ...token,
                selectionTarget: true,
                optionTarget: true,
              }),
            ),
          ),
          { x: 212, y: 35 },
        );
        for (const [state, code] of [
          ['disabled', 'SELECT_OPTION_DISABLED'],
          ['ambiguous', 'SELECT_OPTION_AMBIGUOUS'],
          ['missing', 'SELECT_OPTION_MISSING'],
        ]) {
          option.removeAttribute('aria-disabled');
          f.document.querySelector('#duplicate')?.remove();
          if (state === 'disabled') option.setAttribute('aria-disabled', 'true');
          if (state === 'ambiguous') {
            const duplicate = option.cloneNode(true);
            duplicate.id = 'duplicate';
            option.after(duplicate);
          }
          if (state === 'missing') option.remove();
          for (const op of ['plan_ref_select_option', 'pointer_target'])
            await assert.rejects(
              api.call(op, { ...token, selectionTarget: true, optionTarget: true }),
              (error) => error.preDispatch === true && error.message.includes(code),
            );
        }
        assert.equal(
          api.commands.filter((params) =>
            params.functionDeclaration.includes('const createPageSemantics='),
          ).length,
          1,
        );
      } finally {
        f.close();
      }
    }
});

test('实际安装的同源 frame 指针保留缩放、边框换算及无效变换拒绝', async () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<iframe></iframe>';
    const frame = f.document.querySelector('iframe'),
      child = frame.contentDocument;
    frame.style.transform = 'matrix(1,0,0,1,0,0)';
    frame.getBoundingClientRect = () => ({
      left: 100,
      top: 120,
      right: 300,
      bottom: 240,
      width: 200,
      height: 120,
    });
    Object.defineProperties(frame, {
      offsetWidth: { configurable: true, value: 100 },
      offsetHeight: { value: 60 },
      clientLeft: { value: 2 },
      clientTop: { value: 3 },
    });
    child.body.innerHTML = '<button aria-label="框架按钮">框架按钮</button>';
    const button = child.querySelector('button');
    child.defaultView.HTMLElement.prototype.getClientRects = () => [{}];
    button.getBoundingClientRect = () => ({
      left: 10,
      top: 15,
      right: 50,
      bottom: 35,
      width: 40,
      height: 20,
    });
    child.elementFromPoint = () => button;
    f.setHit(frame);
    const api = installedCaller(f),
      page = await api.call('semantic_snapshot', {
        binding: f.binding,
        options: { composed: true, query: '框架按钮' },
      });
    const token = { binding: f.binding, snapshotId: page.snapshotId, ref: page.items[0].ref };
    assert.deepEqual(JSON.parse(JSON.stringify(await api.call('pointer_target', token))), {
      x: 164,
      y: 176,
    });
    frame.style.transform = 'matrix(1,1,0,1,0,0)';
    await assert.rejects(api.call('pointer_target', token), /UNSUPPORTED_FRAME_TRANSFORM/);
    frame.style.transform = 'matrix(1,0,0,1,0,0)';
    Object.defineProperty(frame, 'offsetWidth', { value: 0 });
    await assert.rejects(api.call('pointer_target', token), /TARGET_NOT_ACTIONABLE/);
  } finally {
    f.close();
  }
});

test('Shadow 普通输入及原生选择的 input 事件穿过宿主，change 保留原生边界', () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<div id="host"></div>';
    const host = f.document.querySelector('#host'),
      shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<input aria-label="影子输入"><select aria-label="影子选择"><option value="a">A</option><option value="b">B</option></select>';
    const events = [];
    f.document.addEventListener('input', (event) =>
      events.push([event.type, event.composed, event.target.id]),
    );
    f.document.addEventListener('change', () => assert.fail('原生 change 不跨 Shadow 根'));
    for (const [name, op, payload] of [
      ['影子输入', 'ref_fill', { text: '测试值' }],
      ['影子选择', 'apply_native_ref_select_option', { by: 'value', values: ['b'] }],
    ]) {
      const target = shadow.querySelector(name === '影子输入' ? 'input' : 'select');
      shadow.elementFromPoint = () => target;
      f.setHit(host);
      const page = f.call('semantic_snapshot', {
        binding: f.binding,
        options: { composed: true, query: name },
      });
      const result = f.call(op, {
        binding: f.binding,
        snapshotId: page.snapshotId,
        ref: page.items[0].ref,
        ...payload,
      });
      assert.equal(result.verified, true);
    }
    assert.deepEqual(events, [
      ['input', true, 'host'],
      ['input', true, 'host'],
    ]);
  } finally {
    f.close();
  }
});

test('display contents Shadow 宿主无盒不阻止子按钮，但恢复轮次仍拒绝网页遮挡', () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<div id="host" style="display:contents"></div><aside>遮挡</aside>';
    const host = f.document.querySelector('#host'),
      shadow = host.attachShadow({ mode: 'open' });
    host.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
    host.getClientRects = () => [];
    shadow.innerHTML = '<button>影子操作</button>';
    const button = shadow.querySelector('button');
    shadow.elementFromPoint = () => button;
    f.setHit(host);
    const page = f.call('semantic_snapshot', {
      binding: f.binding,
      options: { composed: true, query: '影子操作' },
    });
    const token = { binding: f.binding, snapshotId: page.snapshotId, ref: page.items[0].ref };
    assert.equal(f.call('confirm_ref', token).confirmed, true);
    f.setHit(f.document.querySelector('aside'));
    assert.throws(() => f.call('confirm_ref', { ...token, recoveryRound: 2 }), /TARGET_OCCLUDED/);
  } finally {
    f.close();
  }
});

test('受控输入与富文本填写派发事件并核对读回值，回执不含输入内容', async () => {
  const f = setup();
  try {
    let events = 0;
    f.document.querySelector('#controlled').addEventListener('input', () => events++);
    const input = f.find('受控输入', ['textbox']);
    const result = f.call('ref_fill', { ...input, text: '私有测试值' });
    assert.equal(result.verified, true);
    assert.equal(events, 1);
    assert.equal(f.document.querySelector('#controlled').value, '私有测试值');
    assert.doesNotMatch(JSON.stringify(result), /私有测试值/);
    const editor = f.find('正文', ['textbox']);
    f.setHit(f.document.querySelector('#editor'));
    const { result: rich } = await fillThroughInput(f, { ...editor, text: '编辑内容' });
    assert.equal(rich.verified, true);
    assert.equal(f.document.querySelector('#editor').textContent, '编辑内容');
  } finally {
    f.close();
  }
});

// 中文注释：公共执行入口必须在派发前拒绝跨 frame 的旧引用，不能填写另一文档的控件。
test('公共 ref_fill 拒绝把已移除的 iframe 输入框接替到另一同源文档', () => {
  const f = setup();
  try {
    f.document.body.innerHTML = '<iframe></iframe><iframe></iframe>';
    const frames = [...f.document.querySelectorAll('iframe')];
    for (const frame of frames) {
      frame.contentWindow.HTMLElement.prototype.getBoundingClientRect = () => ({
        left: 20,
        top: 20,
        right: 120,
        bottom: 50,
        width: 100,
        height: 30,
      });
      frame.contentWindow.HTMLElement.prototype.getClientRects = () => [{}];
      frame.contentDocument.body.innerHTML = '<input id="field" aria-label="字段">';
    }
    const page = f.call('semantic_snapshot', {
      binding: f.binding,
      options: { composed: true, query: '字段' },
    });
    frames[0].contentDocument.querySelector('input').remove();
    let dispatched = 0;
    const foreign = frames[1].contentDocument.querySelector('input');
    foreign.addEventListener('input', () => dispatched++);
    assert.throws(
      () =>
        f.call('ref_fill', {
          binding: f.binding,
          snapshotId: page.snapshotId,
          ref: page.items[0].ref,
          text: '不应派发',
        }),
      /REF_TARGET_MISSING/,
    );
    assert.equal(foreign.value, '');
    assert.equal(dispatched, 0);
  } finally {
    f.close();
  }
});

test('portal 组合框选项定位和同文档引用重定位', () => {
  const f = setup();
  try {
    const combo = f.find('地区', ['combobox']);
    f.setHit(f.document.querySelector('#combo'));
    const plan = f.call('plan_ref_select_option', { ...combo, by: 'value', values: ['cn'] });
    assert.equal(plan.kind, 'aria');
    const save = f.find('保存', ['button']);
    f.document.querySelector('#save').outerHTML = '<button id="save">保存</button>';
    f.setHit(f.document.querySelector('#save'));
    assert.equal(f.call('confirm_ref', save).confirmed, true);
    assert.equal(f.call('ref_relocation', save).relocated, true);
  } finally {
    f.close();
  }
});

test('不可见目标居中滚动，固定在视口外的浮层目标直接拒绝', () => {
  // 中文注释：滚动只发生在目标初始不可操作时，且固定浮层不能靠页面滚动修复。
  const f = setup();
  try {
    const save = f.find('保存', ['button']),
      button = f.document.querySelector('#save');
    let top = 700,
      blocks = [];
    button.getBoundingClientRect = () => ({
      left: 20,
      top,
      right: 120,
      bottom: top + 30,
      width: 100,
      height: 30,
    });
    button.scrollIntoView = (options) => {
      blocks.push(options.block);
      top = 250;
    };
    f.setHit(button);
    const revealed = f.call('reveal_ref', save);
    assert.equal(revealed.scrolled, true);
    assert.deepEqual(blocks, ['center']);
    f.call('reveal_ref', save);
    assert.deepEqual(blocks, ['center']);
    top = 700;
    button.style.position = 'fixed';
    assert.throws(() => f.call('reveal_ref', save), /TARGET_OUT_OF_VIEWPORT/);
    assert.deepEqual(blocks, ['center']);
  } finally {
    f.close();
  }
});

test('开放 Shadow DOM 与同源 iframe 中的按钮可通过目标命中确认', () => {
  const f = setup();
  try {
    const host = f.document.querySelector('#component'),
      shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button aria-label="影子操作">影子操作</button>';
    const shadowButton = shadow.querySelector('button');
    shadow.elementFromPoint = () => shadowButton;
    let page = f.call('semantic_snapshot', {
      binding: f.binding,
      options: { mode: 'interactive', composed: true, query: '影子操作', budget: 5000 },
    });
    f.setHit(host);
    assert.equal(
      f.call('confirm_ref', {
        binding: f.binding,
        snapshotId: page.snapshotId,
        ref: page.items[0].ref,
      }).confirmed,
      true,
    );
    const frame = f.document.querySelector('#inner');
    frame.contentDocument.body.innerHTML = '<button aria-label="框架操作">框架操作</button>';
    frame.contentDocument.defaultView.HTMLElement.prototype.getBoundingClientRect = () => ({
      left: 20,
      top: 20,
      right: 120,
      bottom: 50,
      width: 100,
      height: 30,
    });
    frame.contentDocument.defaultView.HTMLElement.prototype.getClientRects = () => [
      { width: 100, height: 30 },
    ];
    Object.defineProperty(frame, 'offsetWidth', { value: 100 });
    Object.defineProperty(frame, 'offsetHeight', { value: 30 });
    frame.contentDocument.elementFromPoint = () => frame.contentDocument.querySelector('button');
    page = f.call('semantic_snapshot', {
      binding: f.binding,
      options: { mode: 'interactive', composed: true, query: '框架操作', budget: 5000 },
    });
    f.setHit(frame);
    assert.equal(
      f.call('confirm_ref', {
        binding: f.binding,
        snapshotId: page.snapshotId,
        ref: page.items[0].ref,
      }).confirmed,
      true,
    );
  } finally {
    f.close();
  }
});

test('推断点击、虚拟选项、表格行和折叠入口均可解析并确认', () => {
  const f = setup();
  try {
    const cases = [
      ['推断点击', 'button', '#pointer'],
      ['项目一', 'option', '#virtual [role=option]'],
      ['更多信息', 'button', 'summary'],
    ];
    for (const [name, role, selector] of cases) {
      const page = f.call('semantic_snapshot', {
        binding: f.binding,
        options: { mode: 'interactive', query: name, roles: [role], budget: 5000 },
      });
      const item = page.items.find((row) => row.name === name);
      assert.ok(item, name);
      f.setHit(f.document.querySelector(selector));
      assert.equal(
        f.call('confirm_ref', { binding: f.binding, snapshotId: page.snapshotId, ref: item.ref })
          .confirmed,
        true,
      );
    }
    const rows = f.call('semantic_snapshot', {
      binding: f.binding,
      options: { mode: 'table', query: '示例', budget: 5000 },
    });
    const row = rows.items.find((item) => item.cells?.includes('示例'));
    assert.ok(row);
    f.setHit(f.document.querySelector('[data-ui-name="Body.Row"]'));
    assert.equal(
      f.call('confirm_ref', { binding: f.binding, snapshotId: rows.snapshotId, ref: row.ref })
        .confirmed,
      true,
    );
  } finally {
    f.close();
  }
});

test('遮挡和不可操作状态在派发前拒绝，遮挡摘要不含输入值', () => {
  const f = setup();
  try {
    const save = f.find('保存', ['button']),
      block = f.document.createElement('div');
    block.setAttribute('role', 'dialog');
    block.innerHTML = '<button aria-label="关闭">关闭</button><input value="SECRET_VALUE">';
    f.document.body.append(block);
    f.setHit(block);
    assert.throws(
      () => f.call('confirm_ref', save),
      (error) => {
        if (!error.message.startsWith('TARGET_OCCLUDED') || error.message.includes('SECRET_VALUE'))
          return false;
        const summary = JSON.parse(decodeURIComponent(error.message.split('|')[1]));
        return (
          summary.role === 'dialog' &&
          summary.closeButton?.name === '关闭' &&
          typeof summary.closeButton.ref === 'string'
        );
      },
    );
    f.setHit(f.document.querySelector('#save'));
    f.document.querySelector('#save').setAttribute('aria-disabled', 'true');
    assert.throws(() => f.call('confirm_ref', save), /TARGET_DISABLED/);
  } finally {
    f.close();
  }
});
