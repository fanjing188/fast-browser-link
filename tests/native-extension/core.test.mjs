import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { Interactions } from '../../browser-interactions/index.mjs';
const load = () => import(process.env.CORE_UNDER_TEST || '../../native-extension/core.mjs');
import { trustedTask as task, workspaceFixture } from './workspace-fixture.mjs';
const newTabCommand = (taskId = 'a', requestId = 'new-work-tab') => ({
  taskId,
  generation: 1,
  requestId,
  action: 'new_tab',
  url: 'https://example.com/',
  allowedOrigins: ['https://example.com'],
});
const safeTree = (tabId) => ({
  frameTree: {
    frame: { id: `main-${tabId}`, loaderId: `document-${tabId}`, url: 'https://example.com/' },
  },
});
const fixtureResult = (value) => ({ result: { value } });
function highlightReadyFixture(api, { hideConfirmed = true } = {}) {
  const listeners = new Set();
  api.debugger.onEvent = {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
  };
  const sendCommand = api.debugger.sendCommand.bind(api.debugger);
  api.debugger.sendCommand = async (target, method, params = {}) => {
    // The overlay installs this binding before its actions; emulate the API response
    // instead of treating an unmodelled setup command as a deliberately gated call.
    // 中文注释：预遮罩注册不是截图派发，不能进入截图的阻塞桩。
    if (
      ['Runtime.addBinding', 'Page.enable', 'Page.removeScriptToEvaluateOnNewDocument'].includes(
        method,
      )
    )
      return {};
    if (method === 'Page.addScriptToEvaluateOnNewDocument')
      return { identifier: 'fixture-preveil' };
    if (method === 'DOM.getDocument') return { root: { nodeName: 'HTML', children: [] } };
    if (['DOM.enable', 'Target.setAutoAttach'].includes(method)) return {};
    if (method === 'Runtime.callFunctionOn') {
      const declaration = params.functionDeclaration || '',
        op = params.arguments?.[0]?.value;
      if (declaration.includes('const createAutomationOverlay=')) return fixtureResult(true);
      if (declaration.startsWith('function(op,scope){const state=')) {
        if (op === 'hide') return fixtureResult(hideConfirmed);
        if (
          [
            'restore',
            'remove',
            'scope',
            'scope-running',
            'update',
            'reblock',
            'revoke',
            'reply',
          ].includes(op)
        )
          return fixtureResult(true);
      }
      if (declaration.startsWith('function interactionHighlightCommand(')) {
        if (
          [
            'prepare-selector',
            'prepare-drag-selectors',
            'verify-selector',
            'verify-drag-selectors',
            'painted',
            'complete',
            'clear',
          ].includes(op)
        )
          return fixtureResult({ ok: true });
      }
    }
    return sendCommand(target, method, params);
  };
  return api;
}

// Test-only trusted extension UI confirmation of this exact request; not task-wide authority.
function executeUserApproved(executor, command) {
  return executor.execute(command);
}

test('受信分页快照在读取前拒绝旧文档绑定，当前绑定仍可读取', async () => {
  const { Executor } = await load();
  const { api } = workspaceFixture();
  api.debugger.attach = async () => {};
  const executor = new Executor(api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  executor.ensurePageEvents = async () => {};
  executor.checkedFrameTree = async () => safeTree(1).frameTree;
  executor.ensureOverlay = async () => null;
  let reads = 0;
  executor.callSemanticWorld = async (_target, _frame, _action, payload) => {
    reads++;
    return { version: 2, binding: payload.binding, items: [], nextCursor: null };
  };
  const binding = executor.semanticBinding(current, 1, 'document-1');
  const params = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'semantic_snapshot',
    options: { mode: 'content', cursor: 'native-cursor' },
    binding: { ...binding, documentId: 'previous-document' },
  };
  await assert.rejects(executor.perform(current, params), /BINDING_MISMATCH/);
  assert.equal(reads, 0);
  params.binding = { ...binding };
  const result = await executor.perform(current, params);
  assert.deepEqual(result.binding, binding);
  assert.equal(reads, 1);
});

test('bound helper read forwards the original document epoch into semantic world', async () => {
  const { Executor } = await load();
  const { api } = workspaceFixture();
  api.debugger.attach = async () => {};
  const executor = new Executor(api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  executor.ensurePageEvents = async () => {};
  executor.checkedFrameTree = async () => safeTree(1).frameTree;
  executor.ensureOverlay = async () => null;
  const binding = executor.semanticBinding(current, 1, 'document-1');
  const seen = [];
  executor.callSemanticWorld = async (_target, _frame, _action, payload) => {
    seen.push(payload);
    return {
      kind: 'full',
      binding,
      documentEpoch: 'epoch-1',
      items: [],
      coverage: { complete: true },
    };
  };
  await executor.perform(current, {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'semantic_snapshot',
    binding,
    documentEpoch: 'epoch-1',
    options: { mode: 'interactive' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].documentEpoch, 'epoch-1');
  assert.equal(seen[0].requireDocumentEpoch, true);
});

test('ref_fill dialog leaves delivery unknown so the script lane must reconcile', async () => {
  const { Executor } = await load();
  const executor = Object.create(Executor.prototype);
  const current = { id: 'task', generation: 1, interactionOperations: new Set() };
  executor.observers = { pending: () => false };
  executor.checkedFrameTree = async () => ({ frame: { loaderId: 'loader' } });
  executor.overlayCall = async () => true;
  executor.timed = async (_p, _stage, work) => work();
  executor.raceDialog = async () => ({ dialogOpened: { type: 'alert' } });
  executor.interactionCleanupCall = async () => ({ ok: true });
  const result = await executor.withInteractionHighlight({
    t: current,
    p: { tabId: 7, action: 'ref_fill' },
    entry: { documentId: 'loader' },
    guard: () => {},
    prepare: async () => ({ ok: false }),
    verify: async () => ({ ok: true }),
    dispatch: async () => ({ kind: 'dom-synthetic' }),
    visualOnly: true,
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.delivery, 'unconfirmed');
});

test('semantic pointer refuses a root change during the final hit verification', async () => {
  const scope = { taskId: 'task', generation: 1 };
  let root = 'A',
    hits = 0,
    pressed = 0,
    dispatched = 0;
  const state = {
    visual: { scale: 1, x: 0, y: 0 },
    viewport: { width: 800, height: 600 },
    visibility: 'visible',
    documentId: 'same-loader',
    token: 'same-token',
    url: 'https://example.test/',
    dpr: 1,
    scroll: { x: 0, y: 0 },
  };
  const adapter = {
    evaluate: async (op) => {
      assert.equal(op, 'state');
      return state;
    },
    verifyHit: async () => {
      if (++hits === 2) root = 'B';
    },
    send: async (_method, params) => {
      if (params.type === 'mousePressed') pressed++;
    },
  };
  const interactions = new Interactions(adapter, scope);
  await assert.rejects(
    interactions.clickBoundTarget(scope, {
      readTarget: async () => {
        if (root !== 'A') throw Error('DOCUMENT_REPLACED');
        return { x: 40, y: 40 };
      },
      strictFinalRead: true,
      onDispatch: () => {
        dispatched++;
      },
    }),
    /DOCUMENT_REPLACED/,
  );
  assert.equal(hits, 2);
  assert.equal(pressed, 0);
  assert.equal(dispatched, 0);
});

test('受信分页快照在等待遮罩期间换文档或引用租约时不读取正文', async () => {
  const { Executor } = await load();
  for (const change of ['document', 'binding']) {
    const { api } = workspaceFixture();
    api.debugger.attach = async () => {};
    const executor = new Executor(api);
    await executor.approve(task());
    const current = executor.tasks.get('a');
    executor.ensurePageEvents = async () => {};
    executor.checkedFrameTree = async () => safeTree(1).frameTree;
    const binding = executor.semanticBinding(current, 1, 'document-1');
    let reads = 0;
    executor.callSemanticWorld = async () => {
      reads++;
      return { items: [] };
    };
    executor.ensureOverlay = async () => {
      if (change === 'document') executor.docs.set(1, 1);
      else current.semanticBindings.clear();
      return null;
    };
    await assert.rejects(
      executor.perform(current, {
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'semantic_snapshot',
        binding: { ...binding },
        options: { mode: 'content', cursor: 'native-cursor' },
      }),
      /BINDING_MISMATCH|DOCUMENT_CHANGED/,
    );
    assert.equal(reads, 0, change);
  }
});

test('产品局部快照零匹配不扩大根预算或派生恢复截图', async () => {
  const { Executor } = await load();
  const executor = new Executor(workspaceFixture().api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  current.executionLane = 'product_work';
  const options = { root: '#scope', query: 'absent', composed: false, budget: 512 };
  const command = { taskId: 'a', generation: 1, tabId: 1, action: 'semantic_snapshot', options };
  const snapshot = { version: 2, items: [], coverage: { complete: true }, nextCursor: null };
  const calls = [];
  executor.performSettled = async (_task, params) => {
    calls.push(structuredClone(params));
    assert.deepEqual(params, command);
    return snapshot;
  };
  executor.checkedFrameTree = async () => {
    throw Error('unexpected wider recovery scan');
  };
  assert.equal(await executor.performRecovering(current, command), snapshot);
  assert.deepEqual(calls, [command]);
  executor.performSettled = async () => {
    throw Error('INVALID_ROOT');
  };
  await assert.rejects(executor.performRecovering(current, command), /INVALID_ROOT/);
});

test('helper 查询空结果只读取一次，不在内部重扫到另一文档', async () => {
  const { Executor } = await load();
  const executor = new Executor(workspaceFixture().api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  const command = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'semantic_snapshot',
    options: { mode: 'interactive', query: 'missing' },
    noQueryRecovery: true,
  };
  let reads = 0,
    scans = 0;
  executor.performSettled = async () => {
    reads++;
    return { kind: 'full', items: [], binding: { taskId: 'a' }, coverage: { complete: true } };
  };
  executor.checkedFrameTree = async () => {
    scans++;
    throw Error('unexpected internal scan');
  };
  const result = await executor.performRecovering(current, command);
  assert.equal(result.items.length, 0);
  assert.equal(reads, 1);
  assert.equal(scans, 0);
});

test('普通快照按名称或角色无匹配时返回空集，不触发引用恢复', async () => {
  const { Executor } = await load();
  const executor = new Executor(workspaceFixture().api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  let reads = 0;
  executor.performSettled = async () => {
    reads++;
    return { kind: 'full', items: [], coverage: { matched: 0, complete: true } };
  };
  executor.checkedFrameTree = async () => {
    throw Error('unexpected reference recovery');
  };
  for (const options of [{ query: '网站' }, { roles: ['button'] }]) {
    const result = await executor.performRecovering(current, {
      taskId: 'a',
      generation: 1,
      tabId: 1,
      action: 'semantic_snapshot',
      options,
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.coverage.matched, 0);
    assert.equal(result.recovery, undefined);
  }
  assert.equal(reads, 2);
});

test('自然等待后的引用动作被遮挡时只执行一次，不进入自动恢复或关闭遮挡层', async () => {
  const { Executor } = await load();
  const executor = new Executor(workspaceFixture().api);
  await executor.approve(task());
  const current = executor.tasks.get('a');
  let calls = 0,
    scans = 0;
  executor.performSettled = async () => {
    calls++;
    throw Object.assign(Error('TARGET_OCCLUDED'), { preDispatch: true });
  };
  executor.checkedFrameTree = async () => {
    scans++;
    throw Error('unexpected recovery scan');
  };
  for (const action of ['ref_click', 'ref_fill']) {
    calls = 0;
    scans = 0;
    const command = {
      taskId: 'a',
      generation: 1,
      tabId: 1,
      action,
      binding: { taskId: 'a', documentId: 'doc', leaseId: 'lease' },
      snapshotId: 'snap',
      ref: 'target',
      noAutoRecovery: true,
      ...(action === 'ref_fill' ? { text: 'local value' } : {}),
    };
    await assert.rejects(executor.performRecovering(current, command), /TARGET_OCCLUDED/);
    assert.equal(calls, 1, action);
    assert.equal(scans, 0, action);
  }
  calls = 0;
  executor.performSettled = async () => {
    calls++;
    return { outcomeUnknown: true, delivery: 'partial' };
  };
  const unknown = await executor.performRecovering(current, {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'ref_click',
    noAutoRecovery: true,
  });
  assert.equal(unknown.outcomeUnknown, true);
  assert.equal(calls, 1);
  assert.equal(scans, 0);
});

test('文档扫描在取得句柄后撤销时仍释放句柄，不再读取 DOM', async () => {
  const { Executor } = await load();
  const calls = [];
  let cancelled = false;
  const e = new Executor({
    debugger: {
      sendCommand: async (_target, method, params) => {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          cancelled = true;
          return { result: { objectId: 'fixture-document' } };
        }
        return {};
      },
    },
  });
  await assert.rejects(
    e.exposeClosedShadowRoots(
      { tabId: 1 },
      'frame',
      () => {
        if (cancelled) throw Error('cancelled');
      },
      7,
    ),
    /cancelled/,
  );
  assert.deepEqual(
    calls.map((row) => row.method),
    ['Runtime.evaluate', 'Runtime.releaseObject'],
  );
  assert.equal(calls[1].params.objectId, 'fixture-document');
});

test('任务动作默认允许，仍拒绝未知动作和缺失标签身份', async () => {
  const { Executor } = await load();
  const e = new Executor({ tabs: { get: async (id) => ({ id, url: 'https://example.com/' }) } });
  await e.approve(task());
  const t = e.tasks.get('a');
  for (const action of [
    'navigate',
    'click',
    'fill',
    'press',
    'ref_click',
    'ref_fill',
    'js.evaluate',
    'cdp.send',
  ]) {
    await e.authorize(
      t,
      { taskId: 'a', generation: 1, modeGeneration: 1, tabId: 1, action },
      () => {},
    );
  }
  for (const action of ['evaluate', 'cdp', 'Runtime.evaluate'])
    await assert.rejects(
      e.execute({ taskId: 'a', generation: 1, tabId: 1, action }),
      /V1 unsupported action/,
    );
  await assert.rejects(
    e.execute({ taskId: 'a', generation: 1, action: 'snapshot' }),
    /explicit tabId required/,
  );
  await assert.rejects(
    e.execute({ taskId: 'a', generation: 1, tabId: 9, action: 'snapshot' }),
    /tab lease denied/,
  );
});

test('product work inputs recheck frozen host after asynchronous preparation', async () => {
  const { Executor } = await load();
  for (const [action, changeAt] of [
    ['press', 'overlay'],
    ['press', 'press_check'],
    ['scroll', 'scroll-world'],
    ['press', 'none'],
    ['scroll', 'none'],
  ]) {
    let url = 'https://example.com/',
      inputCount = 0,
      focusCount = 0;
    const api = {
      tabs: { get: async (id) => ({ id, url, windowId: 7, groupId: 2, active: false }) },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        onEvent: { addListener() {}, removeListener() {} },
        sendCommand: async (_target, method, params) => {
          if (method === 'Page.getFrameTree') return safeTree(1);
          if (method === 'Page.getLayoutMetrics') {
            return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
          }
          if (method === 'Page.createIsolatedWorld') {
            if (changeAt === 'scroll-world') url = 'https://foreign.test/';
            return { executionContextId: 7 };
          }
          if (
            method === 'Runtime.callFunctionOn' &&
            params.functionDeclaration.startsWith('function productPageScroll(')
          ) {
            inputCount++;
            return { result: { value: { scrolled: true, scrollTop: 480 } } };
          }
          if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
          if (method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent')
            inputCount++;
          return {};
        },
      },
    };
    const e = new Executor(api);
    await e.approve(task());
    const t = e.tasks.get('a');
    t.executionLane = 'product_work';
    // 中文注释：仅替代遮罩与框架准备；实际performAuthorized输入分支保持真实。
    e.assertSilentTarget = async (current) => {
      await e.resourceGuard(current, url);
    };
    e.resourceGuard = async (_task, candidate) => {
      if (candidate !== 'https://example.com/') throw Error('ASSIST_RESOURCE_DENIED');
    };
    e.ensurePageEvents = async () => {};
    e.checkedFrameTree = async () => safeTree(1).frameTree;
    e.ensureOverlay = async () => {
      if (changeAt === 'overlay') url = 'https://foreign.test/';
      return null;
    };
    e.authorize = async () => {};
    e.callWorld = async (_target, _frame, _task, op) => {
      if (op === 'press') focusCount++;
      if (changeAt === 'press_check' && op === 'press_check') url = 'https://foreign.test/';
      return { ok: true };
    };
    e.observers.pending = () => false;
    const run = () =>
      e.perform(t, {
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action,
        selector: '#query',
        key: 'Enter',
        direction: 'down',
      });
    if (changeAt === 'none') {
      await run();
      assert.equal(
        inputCount,
        action === 'press' ? 2 : 1,
        'same-host positive must reach actual input branch',
      );
    } else {
      await assert.rejects(run, /ASSIST_RESOURCE/, `${action} ${changeAt}`);
      assert.equal(inputCount, 0, `${action} dispatched to foreign page`);
      if (changeAt === 'overlay')
        assert.equal(focusCount, 0, 'focus preceded final resource guard');
    }
  }
});

test('product input fence rejects document, lease and URL changes during Native check', async () => {
  const { Executor } = await load();
  for (const change of ['none', 'url', 'document', 'lease', 'pending', 'missing-guard']) {
    let url = 'https://example.com/',
      pendingUrl;
    const e = new Executor({ tabs: { get: async (id) => ({ id, url, pendingUrl }) } });
    await e.approve(task());
    const t = e.tasks.get('a');
    t.executionLane = 'product_work';
    e.assertSilentTarget = async () => {};
    e.resourceGuard =
      change === 'missing-guard'
        ? undefined
        : async () => {
            if (change === 'url') url = 'https://foreign.test/';
            if (change === 'document') e.docs.set(1, 1);
            if (change === 'lease') e.leases.delete(1);
            if (change === 'pending') pendingUrl = 'https://foreign.test/';
          };
    const guard = () => {
      if (e.leases.get(1) !== t.id) throw Error('tab lease denied');
    };
    const run = () => e.assertProductWorkInput(t, { tabId: 1 }, guard);
    if (change === 'none') await run();
    else await assert.rejects(run, /ASSIST_RESOURCE|tab lease denied/, change);
  }
});

test('product press world creation cannot move focus after a foreign navigation', async () => {
  const { Executor } = await load();
  for (const navigate of ['none', 'foreign', 'same-url']) {
    let url = 'https://example.com/',
      focusCalls = 0;
    const e = new Executor({
      tabs: { get: async (id) => ({ id, url }) },
      debugger: {
        sendCommand: async (_target, method) => {
          if (method === 'Page.createIsolatedWorld') {
            if (navigate === 'foreign') url = 'https://foreign.test/';
            if (navigate === 'same-url') e.docs.set(1, (e.docs.get(1) || 0) + 1);
            return { executionContextId: 7 };
          }
          if (method === 'Runtime.callFunctionOn') {
            focusCalls++;
            return { result: { value: { ok: true } } };
          }
          throw Error(method);
        },
      },
    });
    await e.approve(task());
    const t = e.tasks.get('a');
    t.executionLane = 'product_work';
    e.assertSilentTarget = async () => {};
    e.resourceGuard = async (_task, candidate) => {
      if (candidate !== 'https://example.com/') throw Error('ASSIST_RESOURCE_DENIED');
    };
    const run = () =>
      e.callWorld({ tabId: 1 }, 'main-1', t, 'press', '#query', null, 'Enter', () => {});
    if (navigate !== 'none') await assert.rejects(run, /ASSIST_RESOURCE_DENIED|document changed/);
    else assert.deepEqual(await run(), { ok: true });
    assert.equal(focusCalls, navigate === 'none' ? 1 : 0);
  }
});

test('product scroll uses its serialized fixed primitive without native wheel or focus changes', async () => {
  const { Executor } = await load();
  for (const change of ['none', 'world-navigation', 'world-document', 'world-cancel']) {
    let url = 'https://example.com/',
      cancelled = false;
    const commands = [],
      positions = [];
    const scroller = {
      scrollTop: 0,
      scrollHeight: 1800,
      clientHeight: 600,
      scrollTo({ top, behavior }) {
        assert.equal(behavior, 'instant');
        this.scrollTop = Math.min(1200, Math.max(0, top));
        positions.push(this.scrollTop);
      },
    };
    const api = {
      tabs: { get: async (id) => ({ id, url, active: false }) },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        onEvent: { addListener() {}, removeListener() {} },
        sendCommand: async (_target, method, params) => {
          commands.push(method);
          if (method === 'Page.getLayoutMetrics')
            return { cssLayoutViewport: { clientHeight: 600, clientWidth: 800 } };
          if (method === 'Page.getFrameTree') return safeTree(1);
          if (method === 'Page.createIsolatedWorld') {
            if (change === 'world-navigation') url = 'https://foreign.test/';
            if (change === 'world-document') executor.docs.set(1, (executor.docs.get(1) || 0) + 1);
            if (change === 'world-cancel') cancelled = true;
            return { executionContextId: 7 };
          }
          if (method === 'Runtime.callFunctionOn') {
            assert.equal(params.executionContextId, 7);
            const value = runInNewContext(`(${params.functionDeclaration})(...args)`, {
              args: params.arguments.map((row) => row.value),
              location: { href: url, origin: new URL(url).origin },
              document: { scrollingElement: scroller, documentElement: { clientHeight: 600 } },
            });
            return fixtureResult(value);
          }
          throw Error(`unexpected method ${method}`);
        },
      },
    };
    const executor = new Executor(api);
    await executor.approve(task());
    const current = executor.tasks.get('a');
    current.executionLane = 'product_work';
    executor.ensurePageEvents = async () => {};
    executor.assertSilentTarget = async () => {
      if (cancelled) throw Error('cancelled');
    };
    executor.resourceGuard = async (_task, value) => {
      if (value !== 'https://example.com/') throw Error('ASSIST_RESOURCE_DENIED');
    };
    executor.authorize = async () => {};
    const run = (direction) =>
      executor.perform(current, {
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'scroll',
        direction,
      });
    if (change === 'none') {
      assert.equal((await run('down')).scrollTop, 480);
      assert.equal((await run('up')).scrollTop, 0);
      assert.deepEqual(positions, [480, 0]);
    } else {
      await assert.rejects(run('down'), /ASSIST_RESOURCE|cancelled/);
      assert.deepEqual(positions, []);
    }
    assert.equal(
      commands.some((method) => method.startsWith('Input.') || method.startsWith('Emulation.')),
      false,
    );
  }
});

test('product press retains its original document across final tab and Native awaits', async () => {
  const { Executor } = await load();
  for (const changeAt of ['tab-read', 'native-check', 'none']) {
    let checked = false,
      changed = false;
    const inputs = [];
    const changeDocument = () => {
      changed = true;
      executor.docs.set(1, (executor.docs.get(1) || 0) + 1);
    };
    const executor = new Executor({
      tabs: {
        get: async (id) => {
          if (checked && !changed && changeAt === 'tab-read') changeDocument();
          return { id, url: 'https://example.com/', active: false };
        },
      },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        onEvent: { addListener() {}, removeListener() {} },
        sendCommand: async (_target, method, params) => {
          if (method === 'Page.getFrameTree') return safeTree(1);
          if (method === 'Runtime.callFunctionOn') return fixtureResult(true);
          if (method === 'Input.dispatchKeyEvent')
            inputs.push({ type: params.type, doc: executor.docs.get(1) || 0 });
          return {};
        },
      },
    });
    await executor.approve(task());
    const current = executor.tasks.get('a');
    current.executionLane = 'product_work';
    executor.assertSilentTarget = async () => {};
    executor.resourceGuard = async () => {
      if (checked && !changed && changeAt === 'native-check') changeDocument();
    };
    executor.ensurePageEvents = async () => {};
    executor.checkedFrameTree = async () => safeTree(1).frameTree;
    executor.ensureOverlay = async () => null;
    executor.authorize = async () => {};
    executor.callWorld = async (_target, _frame, _task, op) => {
      if (op === 'press_check') checked = true;
      return { ok: true };
    };
    const run = () =>
      executor.perform(current, {
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'press',
        selector: '#query',
        key: 'Enter',
      });
    if (changeAt === 'none') {
      await run();
      assert.deepEqual(
        inputs.map((row) => row.type),
        ['keyDown', 'keyUp'],
      );
    } else {
      await assert.rejects(run, /document changed|ASSIST_RESOURCE/, changeAt);
      assert.deepEqual(inputs, [], `input dispatched after ${changeAt} replaced original document`);
    }
  }
});

test('document navigation fences product press before old overlay cleanup completes', async () => {
  const { Executor } = await load();
  let checked = false,
    navigation,
    loader = 'document-1',
    releaseCleanup,
    cleanupStarted;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupReady = new Promise((resolve) => {
    cleanupStarted = resolve;
  });
  const inputs = [];
  const executor = new Executor({
    tabs: {
      get: async (id) => {
        if (checked && !navigation) {
          loader = 'document-2';
          navigation = executor.tabEvent(1, 'navigated', 'https://example.com/', {
            urlChanged: false,
          });
          await cleanupReady;
        }
        return { id, url: 'https://example.com/', active: false };
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onEvent: { addListener() {}, removeListener() {} },
      sendCommand: async (_target, method, params) => {
        if (method === 'Page.getFrameTree')
          return {
            frameTree: { frame: { id: 'main-1', loaderId: loader, url: 'https://example.com/' } },
          };
        if (method === 'Runtime.callFunctionOn') {
          if (params.arguments?.[0]?.value === 'remove') {
            cleanupStarted();
            await cleanupGate;
          }
          return fixtureResult(true);
        }
        if (method === 'Input.dispatchKeyEvent') inputs.push({ type: params.type, loader });
        return {};
      },
    },
  });
  await executor.approve(task());
  const current = executor.tasks.get('a');
  current.executionLane = 'product_work';
  executor.assertSilentTarget = async () => {};
  executor.resourceGuard = async () => {};
  executor.ensurePageEvents = async () => {};
  executor.ensureOverlay = async () => null;
  executor.authorize = async () => {};
  executor.callWorld = async (_target, _frame, _task, op) => {
    if (op === 'press_check') {
      checked = true;
      current.overlays.set(1, {
        documentId: 'document-1',
        contextId: 7,
        nonce: 'old',
        listener() {},
      });
    }
    return { ok: true };
  };
  try {
    await assert.rejects(
      executor.perform(current, {
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'press',
        selector: '#query',
        key: 'Enter',
      }),
      /document changed|ASSIST_RESOURCE/,
    );
    assert.deepEqual(inputs, [], 'old overlay cleanup must not postpone document invalidation');
    assert.ok((executor.docs.get(1) || 0) > 0);
  } finally {
    releaseCleanup();
    await navigation;
  }
});

test('接管等待当前动作结束并使旧页面引用失效', async () => {
  const { Executor } = await load();
  const { api } = workspaceFixture();
  const e = new Executor(api);
  await e.approve(task());
  const current = e.tasks.get('a');
  current.semanticBindings.set(1, { leaseId: 'old' });
  current.frameRefs.set(1, new Map());
  let finish;
  const running = new Promise((resolve) => {
    finish = resolve;
  }); // 中文注释：并行执行器使用任务屏障和同页锁。
  const inflight = e.taskBarrier('a', false, () => e.lock(1, () => running));
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  const pause = e.pause('a', 1).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(current.pauseRequested, true);
  finish();
  await pause;
  await inflight;
  assert.equal(current.paused, true);
  assert.equal(current.semanticBindings.size, 0);
  assert.equal(current.frameRefs.size, 0);
  assert.equal(e.leases.get(1), 'a');
  await e.resume('a', 1);
  assert.equal(current.paused, false);
  assert.equal(current.pauseRequested, false);
  assert.equal(e.leases.get(1), 'a');
});

test('同一任务连续导航无需逐项确认', async () => {
  const { Executor } = await load();
  let updates = 0,
    url = 'https://example.com/';
  const e = new Executor({
    tabs: {
      get: async (id) => ({ id, url, status: 'complete' }),
      update: async (_id, p) => {
        updates++;
        url = p.url;
        return { url, status: 'complete' };
      },
    },
  });
  await e.approve(task());
  const command = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'navigate',
    url: 'https://other.test/',
  };
  await e.execute(command);
  await e.execute({ ...command, url: 'https://third.test/' });
  assert.equal(updates, 2);
  assert.equal(e.leases.get(1), 'a');
});

test('fixed CDP actions enforce origins, cancel races and preserve user tabs', async () => {
  const { Executor } = await load();
  const { api, tabs, removed } = workspaceFixture(),
    commands = [];
  let resolveCreate, created;
  const createGate = new Promise((r) => (resolveCreate = r)),
    createStarted = new Promise((r) => (created = r));
  const create = api.tabs.create;
  api.tabs.create = async (p) => {
    const tab = await create(p);
    created();
    await createGate;
    return tab;
  };
  api.debugger = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_, m, p) => {
      commands.push([m, p]);
      if (m === 'Page.getFrameTree') return safeTree(1);
      if (m === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      return { result: { value: { ok: true, targetAssessment: 'ordinary' } } };
    },
  };
  const e = new Executor(highlightReadyFixture(api));
  await e.approve(task());
  e.allowed(e.tasks.get('a'), 'https://evil.test/');
  assert.ok(e.tasks.get('a').allowedOrigins.includes('https://evil.test'));
  await assert.rejects(
    e.execute({
      taskId: 'a',
      generation: 1,
      tabId: 1,
      action: 'evaluate',
      allowedOrigins: ['https://example.com'],
    }),
    /unsupported/,
  );
  await executeUserApproved(e, {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'fill',
    selector: '#x',
    text: 'hello',
    allowedOrigins: ['https://example.com'],
  });
  assert.equal(
    commands.findLast(([m]) => m === 'Runtime.callFunctionOn')[0],
    'Runtime.callFunctionOn',
  );
  const pending = executeUserApproved(e, newTabCommand());
  // Either fence may win: the executor's generation check or the workspace's
  // cancellation. Both are non-read failures reported as outcome-unknown.
  const rejected = assert.rejects(pending, /CANCELLED|stale generation/);
  await createStarted;
  const stopping = e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  // Cleanup is queued behind the in-flight create; let its response arrive after fencing.
  await Promise.resolve();
  resolveCreate();
  await rejected;
  await stopping;
  assert.deepEqual(removed, [3]);
  assert.ok(tabs.has(1));
  assert.equal(tabs.get(1).groupId, -1);
  assert.equal(e.leases.has(1), false);
  assert.equal(e.actionGrants.size, 0);
  await e.approve(task('b', [9]));
  assert.equal(e.leases.get(9), 'b');
});

test('release waits for in-flight CDP before another task can claim tab', async () => {
  const { Executor } = await load();
  let finish, started;
  const shooting = new Promise((resolve) => {
    started = resolve;
  });
  let detach = 0;
  const api = highlightReadyFixture({
    tabs: { get: async () => ({ url: 'https://example.com/' }) },
    debugger: {
      attach: async () => {},
      detach: async () => {
        detach++;
      },
      sendCommand: async (_, method) => {
        if (method === 'Page.getFrameTree') return safeTree(1);
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.callFunctionOn')
          return { result: { value: { hasSensitiveValue: false } } };
        return new Promise((r) => {
          finish = r;
          started();
        });
      },
    },
  });
  const e = new Executor(api);
  await e.approve(task());
  const running = e.execute({
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'screenshot',
    allowedOrigins: ['https://example.com'],
  });
  await shooting;
  const stop = e.release({ taskId: 'a', generation: 1, closeAgentTabs: false });
  await assert.rejects(e.approve(task('b')), /claimed/);
  finish({ data: 'png' });
  await assert.rejects(running, /stale/);
  await stop;
  await e.approve(task('b'));
  assert.equal(detach, 1);
});

test('closing cancelled task cannot close agent tab adopted by another task', async () => {
  const { Executor } = await load();
  const { api, tabs, removed } = workspaceFixture();
  const e = new Executor(api);
  await e.approve(task());
  const work = await executeUserApproved(e, newTabCommand());
  // User moved this work page out of the owned group before cancellation.
  tabs.get(work.tabId).groupId = -1;
  await e.release({ taskId: 'a', generation: 1, closeAgentTabs: false });
  assert.ok(tabs.has(work.tabId));
  assert.equal(e.leases.has(work.tabId), false);
  await e.approve(task('b', [work.tabId]));
  await e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  assert.deepEqual(removed, []);
  assert.equal(e.leases.get(work.tabId), 'b');
  assert.ok(tabs.has(1));
});

test('resume is denied until old-generation detach completes', async () => {
  const { Executor } = await load();
  let finish;
  const e = new Executor({
    tabs: { get: async () => ({ url: 'https://example.com/' }) },
    debugger: { detach: () => new Promise((r) => (finish = r)) },
  });
  await e.approve(task());
  e.attached.add(1);
  const stop = e.release({ taskId: 'a', generation: 1, closeAgentTabs: false });
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(e.approve({ ...task(), generation: 2 }), /active|releasing/);
  finish();
  await stop;
  await e.approve({ ...task(), generation: 2 });
  assert.equal(e.leases.get(1), 'a');
});

test('different task/tab queues progress independently', async () => {
  const { Executor } = await load();
  let finish;
  const api = highlightReadyFixture({
    tabs: { get: async () => ({ url: 'https://example.com/' }) },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async ({ tabId }, method) => {
        if (method === 'Page.getFrameTree') return safeTree(tabId);
        if (method === 'Page.createIsolatedWorld') return { executionContextId: tabId };
        if (method === 'Runtime.callFunctionOn')
          return { result: { value: { hasSensitiveValue: false } } };
        return tabId === 1 ? new Promise((r) => (finish = r)) : { data: 'peer' };
      },
    },
  });
  const e = new Executor(api);
  await e.approve(task());
  await e.approve(task('b', [2]));
  const p = e.execute({
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'screenshot',
    allowedOrigins: ['https://example.com'],
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    (
      await e.execute({
        taskId: 'b',
        generation: 1,
        tabId: 2,
        action: 'screenshot',
        allowedOrigins: ['https://example.com'],
      })
    ).data,
    'peer',
  );
  finish({ data: 'a' });
  await p;
});

test('approval creates exclusive task/tab leases and explicit tab required', async () => {
  const { Executor } = await load();
  const e = new Executor({ tabs: { get: async (id) => ({ id, url: 'https://example.com/' }) } });
  await e.approve(task());
  await assert.rejects(e.approve(task('b')), /claimed/);
  await assert.rejects(
    e.execute({
      taskId: 'a',
      generation: 1,
      action: 'snapshot',
      allowedOrigins: ['https://example.com'],
    }),
    /explicit/,
  );
  await assert.rejects(
    e.execute({
      taskId: 'a',
      generation: 1,
      tabId: 2,
      action: 'snapshot',
      allowedOrigins: ['https://example.com'],
    }),
    /lease/,
  );
  assert.deepEqual(
    await e.execute({
      taskId: 'a',
      generation: 1,
      action: 'tabs',
      allowedOrigins: ['https://example.com'],
    }),
    [{ id: 1, url: 'https://example.com/' }],
  );
});

test('approval rechecks selected tab origins and serializes competing leases', async () => {
  const { Executor } = await load();
  let first = true;
  let unblock;
  const e = new Executor({
    tabs: {
      get: async () => {
        if (first) {
          first = false;
          await new Promise((r) => (unblock = r));
        }
        return { id: 1, url: 'https://example.com/' };
      },
    },
  });
  const a = e.approve(task());
  const b = e.approve(task('b'));
  await new Promise((r) => setTimeout(r, 0));
  unblock();
  await a;
  await assert.rejects(b, /claimed/);
  const changed = new Executor({
    tabs: { get: async () => ({ id: 1, url: 'https://evil.test/' }) },
  });
  await changed.approve(task());
  assert.equal(changed.leases.get(1), 'a');
});

test('跨源 frame 可读，截图不因未知 frame 几何拒绝', async () => {
  const { Executor } = await load();
  const commands = [],
    inspected = [];
  let childUrl = 'https://evil.test/',
    sensitiveFrame = null,
    restoreConfirmed = true;
  const api = {
    tabs: { get: async () => ({ id: 1, url: 'https://example.com/', status: 'complete' }) },
    debugger: {
      onEvent: { addListener() {}, removeListener() {} },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_, method, params = {}) => {
        commands.push(method);
        if (method === 'Page.getFrameTree')
          return {
            frameTree: {
              frame: { id: 'main', loaderId: 'main-document', url: 'https://example.com/' },
              childFrames: [{ frame: { id: 'child', loaderId: 'child-document', url: childUrl } }],
            },
          };
        // 中文注释：DOM 与 frame tree 必须一致；无可信几何的跨源 iframe 不能被截图掩码证明安全。
        if (method === 'DOM.getDocument')
          return {
            root: {
              nodeName: 'HTML',
              children: [
                {
                  nodeName: 'IFRAME',
                  frameId: 'child',
                  contentDocument: { nodeName: 'HTML', children: [] },
                },
              ],
            },
          };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId };
        if (method === 'Runtime.callFunctionOn') {
          const declaration = params.functionDeclaration || '',
            op = params.arguments?.[0]?.value;
          if (declaration.includes('const createAutomationOverlay=')) return fixtureResult(true);
          if (declaration.startsWith('function(op,scope){const state='))
            return fixtureResult(op === 'restore' ? restoreConfirmed : true);
          if (declaration.includes('function inspectPage(')) {
            inspected.push(params.executionContextId);
            return fixtureResult({
              hasSensitiveValue: params.executionContextId === sensitiveFrame,
            });
          }
          throw Error('unexpected capture fixture function');
        }
        if (method === 'Page.captureScreenshot') return { data: 'png' };
        return {};
      },
    },
  };
  const e = new Executor(api);
  await e.approve(task());
  const request = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'screenshot',
    allowedOrigins: ['https://example.com'],
  };
  const catalog = await e.execute({ ...request, action: 'frame_catalog' });
  assert.equal(catalog.frames[0].access, 'ready');
  assert.ok(catalog.frames[0].frameToken);
  const image = await e.execute(request);
  assert.equal(image.data, 'png');
  assert.ok(commands.includes('Page.captureScreenshot'));
  childUrl = 'https://example.com/frame';
  sensitiveFrame = 'child';
  assert.equal((await e.execute(request)).data, 'png');
  // 中文注释：页面归属与恢复遮罩失败仍保留真实错误。
  const current = e.tasks.get('a'),
    entry = current.overlays.get(1);
  assert.ok(entry);
  restoreConfirmed = false;
  await assert.rejects(
    e.captureWithoutDecorations(
      current,
      1,
      entry,
      () => {},
      async () => ({ data: 'png' }),
    ),
    /overlay restore failed/,
  );
});

test('读取期间跨站导航不产生来源拒绝', async () => {
  const { Executor } = await load();
  let frameReads = 0;
  const e = new Executor({
    tabs: { get: async () => ({ id: 1, url: 'https://example.com/' }) },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_, method) => {
        if (method === 'Page.getFrameTree')
          return {
            frameTree: {
              frame: {
                id: 'main',
                url: ++frameReads === 1 ? 'https://example.com/' : 'https://evil.test/',
              },
            },
          };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
      },
    },
  });
  await e.approve(task());
  assert.equal(
    (
      await e.execute({
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'snapshot',
        allowedOrigins: ['https://example.com'],
      })
    ).ok,
    true,
  );
});

test('任务页跨站后快照返回外站内容，仍拒绝其他标签和旧代次', async () => {
  const { Executor } = await load();
  let url = 'https://example.com/';
  let snapshots = 0;
  const snapshot = () => ({ url, title: '外站夹具', elements: [{ text: '跨站正文' }] });
  const e = new Executor({
    tabs: { get: async () => ({ id: 1, url, status: 'complete' }) },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_, method, params) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === 'snapshot') {
          snapshots++;
          return { result: { value: snapshot() } };
        }
        return {};
      },
    },
  });
  await e.approve(task());
  const command = {
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'snapshot',
    allowedOrigins: ['https://example.com'],
  };
  // 中文注释：1.11.0 起任务页可跨站；在快照派发前确认新来源不在初始列表内。
  url = 'https://outside.test/page';
  assert.ok(!e.tasks.get('a').allowedOrigins.includes(new URL(url).origin));
  assert.deepEqual(await e.execute(command), snapshot());
  assert.equal(snapshots, 1);
  await assert.rejects(e.execute({ ...command, tabId: 9 }), /tab lease denied/);
  await assert.rejects(e.execute({ ...command, generation: 2 }), /stale generation/);
  assert.equal(snapshots, 1);
});

test('closing an agent tab retains its lease until removal completes', async () => {
  const { Executor } = await load();
  const { api, removed } = workspaceFixture();
  let finishRemove, removing;
  // 中文注释：本用例只检查关闭期间的租约，合成新页直接报告加载完成。
  const get = api.tabs.get;
  api.tabs.get = async (id) => ({ ...(await get(id)), status: 'complete' });
  const removeStarted = new Promise((r) => (removing = r)),
    removeGate = new Promise((r) => (finishRemove = r)),
    remove = api.tabs.remove;
  api.tabs.remove = async (id) => {
    removing();
    await removeGate;
    await remove(id);
  };
  const e = new Executor(api);
  await e.approve(task('a', []));
  const work = await executeUserApproved(e, newTabCommand());
  const closing = e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  await removeStarted;
  await assert.rejects(e.approve(task('b', [work.tabId])), /claimed/);
  assert.equal(e.leases.get(work.tabId), 'a');
  finishRemove();
  await closing;
  assert.deepEqual(removed, [work.tabId]);
  assert.equal(e.leases.has(work.tabId), false);
});

test('label and descriptive metadata cannot disguise sensitive fill or press targets', async () => {
  const { pageAction, inspectPage } = await load();
  class Input {
    set value(v) {
      this._value = v;
    }
    get value() {
      return this._value || '';
    }
  }
  const field = new Input();
  Object.assign(field, {
    tagName: 'INPUT',
    type: 'text',
    name: '',
    id: 'x',
    autocomplete: '',
    placeholder: '',
    className: 'field',
    attributes: [],
    labels: [{ textContent: 'Account password' }],
    disabled: false,
    getAttribute: () => '',
    closest: () => null,
    focus() {
      globalThis.document.activeElement = this;
    },
  });
  const saved = {
    location: globalThis.location,
    document: globalThis.document,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    Event: globalThis.Event,
    getComputedStyle: globalThis.getComputedStyle,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
  };
  try {
    globalThis.location = { origin: 'https://example.com', href: 'https://example.com/' };
    globalThis.document = {
      activeElement: null,
      title: '',
      querySelector: () => field,
      querySelectorAll: () => [field],
      getElementById: () => null,
    };
    globalThis.HTMLInputElement = Input;
    globalThis.HTMLTextAreaElement = class {};
    globalThis.Event = class {};
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
    globalThis.innerWidth = 800;
    globalThis.innerHeight = 600;
    field.parentElement = null;
    field.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    });
    assert.equal(
      pageAction('assess_fill', '#x', null, null, ['https://example.com']).targetAssessment,
      'sensitive',
    );
    assert.throws(
      () => pageAction('fill', '#x', 'secret', null, ['https://example.com']),
      /sensitive/,
    );
    assert.throws(
      () => pageAction('press', '#x', null, 'Enter', ['https://example.com']),
      /sensitive/,
    );
    field._value = 'already-present';
    assert.equal(inspectPage(['https://example.com']).hasSensitiveValue, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('old child lineage cannot claim a grandchild during a later ambiguous scope', async () => {
  const { Executor } = await load(),
    f = workspaceFixture(),
    e = new Executor(f.api);
  await e.approve(task());
  e.setMode({ ...task(), modeGeneration: 2, activeMode: 'full' });
  let resume, entered;
  const start = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (resume = r));
  f.api.debugger = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_, method) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: 'https://example.com/' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.callFunctionOn') {
        entered();
        await gate;
        return { result: { value: { ok: true } } };
      }
    },
  };
  const first = e.withSpawnScope(e.tasks.get('a'), 1, async () => {
    entered();
    await gate;
  });
  await start;
  f.tabs.set(11, {
    id: 11,
    url: 'https://example.com/child',
    openerTabId: 1,
    windowId: 7,
    groupId: -1,
  });
  await e.tabCreated({ ...f.tabs.get(11) });
  resume();
  await first;
  let resumeSecond, enteredSecond;
  const secondStart = new Promise((r) => (enteredSecond = r)),
    secondGate = new Promise((r) => (resumeSecond = r));
  f.api.debugger.sendCommand = async (_, method) => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'main', url: 'https://example.com/' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.callFunctionOn') {
      enteredSecond();
      await secondGate;
      return { result: { value: { ok: true } } };
    }
  };
  const second = e.withSpawnScope(e.tasks.get('a'), 1, async () => {
    enteredSecond();
    await secondGate;
  });
  await secondStart;
  f.tabs.set(12, {
    id: 12,
    url: 'https://example.com/personal',
    openerTabId: 11,
    windowId: 7,
    groupId: -1,
  });
  assert.equal(await e.tabCreated({ ...f.tabs.get(12) }), null);
  resumeSecond();
  await second;
  await e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  assert.ok(f.tabs.has(12));
});

test('navigate waits for completed redirect event and reports final URL/readiness without replay', async () => {
  const { Executor } = await load();
  const f = workspaceFixture(),
    listeners = new Set();
  f.api.tabs.onUpdated = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  f.api.tabs.update = async (id, { url }) => {
    f.tabs.get(id).url = url;
    f.tabs.get(id).status = 'loading';
    return { ...f.tabs.get(id) };
  };
  const e = new Executor(f.api);
  await e.approve(task());
  e.setMode({ ...task(), modeGeneration: 2, activeMode: 'full' });
  const result = e.execute({
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'navigate',
    url: 'https://example.com/start',
    allowedOrigins: ['https://example.com'],
    modeGeneration: 2,
  });
  await new Promise((r) => setImmediate(r));
  f.tabs.get(1).url = 'https://example.com/final';
  f.tabs.get(1).status = 'complete';
  for (const listener of listeners) listener(1, { status: 'complete' }, { ...f.tabs.get(1) });
  assert.deepEqual(await result, { tabId: 1, url: 'https://example.com/final', ready: 'complete' });
  assert.equal(listeners.size, 0);
});

test('new_tab returns a leased not-ready tab when only its pending URL is visible after grouping', async () => {
  const { Executor } = await load();
  const f = workspaceFixture();
  let reads = 0;
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) => {
    const tab = await get(id);
    if (id !== 1 && id !== 9 && ++reads >= 4) {
      tab.url = '';
      tab.pendingUrl = 'https://example.com/';
      tab.status = 'loading';
    } else if (id !== 1 && id !== 9) tab.status = 'loading';
    return tab;
  };
  // The completion event may race a tabs.get that still shows pendingUrl only.
  f.api.tabs.onUpdated = {
    addListener: (fn) => queueMicrotask(() => fn(3, { status: 'complete' })),
    removeListener: () => {},
  };
  const e = new Executor(f.api);
  await e.approve(task('a', []));
  e.setMode({ ...task('a', []), modeGeneration: 2, activeMode: 'full' });
  const result = await e.execute({ ...newTabCommand(), modeGeneration: 2 });
  assert.deepEqual(result, {
    tabId: 3,
    url: 'https://example.com/',
    ready: 'loading',
    groupId: 20,
    windowId: 7,
    closedTabs: [],
  });
  assert.equal(f.creates.length, 1);
  assert.equal(e.leases.get(3), 'a');
});

test('pending URL does not authorize a read while the current URL is unavailable', async () => {
  const { Executor } = await load();
  const f = workspaceFixture();
  let debuggerCalls = 0;
  const get = f.api.tabs.get;
  f.api.tabs.get = async (id) =>
    id === 1
      ? get(id)
      : { ...(await get(id)), url: '', pendingUrl: 'https://example.com/', status: 'loading' };
  f.api.debugger = {
    attach: async () => {
      debuggerCalls++;
    },
    sendCommand: async () => {
      debuggerCalls++;
    },
  };
  const e = new Executor(f.api);
  await e.approve(task('a', []));
  e.setMode({ ...task('a', []), modeGeneration: 2, activeMode: 'full' });
  const result = await e.execute({ ...newTabCommand(), modeGeneration: 2 });
  assert.equal(result.ready, 'loading');
  assert.equal(e.leases.get(result.tabId), 'a');
  await assert.rejects(
    e.execute({
      taskId: 'a',
      generation: 1,
      tabId: result.tabId,
      action: 'snapshot',
      allowedOrigins: ['https://example.com'],
      modeGeneration: 2,
    }),
    (error) => {
      assert.equal(error.message, 'PAGE_NOT_READY');
      assert.equal(error.preDispatch, true);
      assert.equal(error instanceof TypeError, false);
      assert.equal(error.currentOrigin, undefined);
      return true;
    },
  );
  assert.equal(debuggerCalls, 0);
});

test('read readiness refuses missing, malformed and redirected committed URLs before reads, including polling', async () => {
  const { Executor } = await load();
  const invalidUrls = [undefined, '', 'not-a-url'];
  for (const status of ['loading', 'complete'])
    for (const url of invalidUrls) {
      let calls = 0;
      const e = new Executor({
        tabs: { get: async () => ({ url, status, pendingUrl: 'https://example.com/' }) },
        debugger: {
          attach: async () => {
            calls++;
          },
          sendCommand: async () => {
            calls++;
          },
        },
      });
      await assert.rejects(
        e.domReadyTab(task(), { tabId: 1 }, () => {}),
        (error) => {
          assert.equal(error.message, 'PAGE_NOT_READY');
          assert.equal(error.preDispatch, true);
          assert.equal(
            error.currentOrigin,
            url?.startsWith('https:') ? 'https://evil.test' : undefined,
          );
          return true;
        },
      );
      assert.equal(calls, 0, 'invalid committed URL cannot attach or read through pendingUrl');
    }
  for (const url of invalidUrls) {
    let gets = 0,
      commands = 0;
    const e = new Executor({
      tabs: {
        get: async () => ({
          url: ++gets === 1 ? 'https://example.com/' : url,
          status: 'loading',
          pendingUrl: 'https://example.com/',
        }),
      },
      debugger: {
        attach: async () => {},
        sendCommand: async (_, method) => {
          commands++;
          if (method === 'Page.getFrameTree') return safeTree(1);
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
          assert.equal(method, 'Runtime.callFunctionOn');
          return fixtureResult('loading');
        },
      },
    });
    await assert.rejects(
      e.domReadyTab(task(), { tabId: 1 }, () => {}),
      (error) => {
        assert.equal(error.message, 'PAGE_NOT_READY');
        assert.equal(error.preDispatch, true);
        assert.equal(
          error.currentOrigin,
          url?.startsWith('https:') ? 'https://evil.test' : undefined,
        );
        return true;
      },
    );
    assert.equal(gets, 2);
    assert.equal(commands, 3, 'scope loss must stop before another readyState probe');
  }
});

test('pending allowed URL cannot override a wrong current origin or claim its lease', async () => {
  const { Executor } = await load();
  const f = workspaceFixture(),
    get = f.api.tabs.get;
  f.api.tabs.get = async (id) =>
    id === 1
      ? get(id)
      : {
          ...(await get(id)),
          url: 'https://evil.test/',
          pendingUrl: 'https://example.com/',
          status: 'loading',
        };
  const e = new Executor(f.api);
  await e.approve(task('a', []));
  e.setMode({ ...task('a', []), modeGeneration: 2, activeMode: 'full' });
  const opened = await e.execute({ ...newTabCommand(), modeGeneration: 2 });
  assert.equal(opened.url, 'https://evil.test/');
  assert.equal(f.creates.length, 1);
  assert.equal(e.leases.get(3), 'a');
});

test('a complete tab with no committed URL cannot claim readiness from pendingUrl', async () => {
  const { Executor } = await load();
  const f = workspaceFixture(),
    get = f.api.tabs.get;
  f.api.tabs.get = async (id) =>
    id === 1
      ? get(id)
      : { ...(await get(id)), url: '', pendingUrl: 'https://example.com/', status: 'complete' };
  const e = new Executor(f.api);
  await e.approve(task('a', []));
  e.setMode({ ...task('a', []), modeGeneration: 2, activeMode: 'full' });
  await assert.rejects(e.execute({ ...newTabCommand(), modeGeneration: 2 }), (error) => {
    assert.equal(error.message, 'PAGE_NOT_READY');
    assert.equal(error.preDispatch, false);
    assert.equal(error instanceof TypeError, false);
    return true;
  });
  assert.equal(f.creates.length, 1);
  assert.deepEqual(e.tasks.get('a').allowedOrigins, ['https://example.com']);
  // 中文注释：建页日志已完成但就绪未知；重复请求命中原页租约，不能再创建一次。
  await assert.rejects(e.execute({ ...newTabCommand(), modeGeneration: 2 }), {
    message: 'TASK_BUSY',
    code: 'TASK_BUSY',
    preDispatch: false,
  });
  assert.equal(f.creates.length, 1);
  assert.equal(e.leases.get(3), 'a');
  await assert.rejects(
    e.execute({
      taskId: 'a',
      generation: 1,
      tabId: 3,
      action: 'snapshot',
      allowedOrigins: ['https://example.com'],
      modeGeneration: 2,
    }),
    { message: 'PAGE_NOT_READY', preDispatch: true },
  );
});

test('structured release reports preserved, moved, and uncertain children without leasing denied origins', async () => {
  const { Executor } = await load(),
    f = workspaceFixture(),
    e = new Executor(f.api);
  await e.approve(task());
  e.setMode({ ...task(), modeGeneration: 2, activeMode: 'full' });
  const command = newTabCommand();
  const owned = await e.execute({ ...command, modeGeneration: 2 });
  f.tabs.set(14, { id: 14, url: 'https://evil.test/', openerTabId: 1, windowId: 7, groupId: -1 });
  let resume, entered;
  const gate = new Promise((r) => (resume = r)),
    start = new Promise((r) => (entered = r));
  const world = f.api.debugger;
  f.api.debugger = {
    ...world,
    attach: async () => {},
    sendCommand: async (_, method) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: 'https://example.com/' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.callFunctionOn') {
        entered();
        await gate;
        return { result: { value: { ok: true } } };
      }
    },
  };
  const click = e.withSpawnScope(e.tasks.get('a'), 1, async () => {
    entered();
    await gate;
  });
  await start;
  await e.tabCreated({ ...f.tabs.get(14) });
  resume();
  await click;
  assert.equal(e.leases.has(14), false);
  assert.equal(e.tasks.get('a').allowedOrigins.includes('https://evil.test'), false);
  f.tabs.get(owned.tabId).groupId = -1;
  const result = await e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  assert.deepEqual(result.remainingTabIds, []);
  assert.ok(result.preservedTabIds.includes(owned.tabId));
  assert.ok(!f.removed.includes(14));
  assert.ok(f.tabs.has(14), 'concurrent personal child must survive');
  assert.equal(f.tabs.get(14).groupId, -1);
  assert.equal(result.cleanupState, 'unknown');
  assert.ok(result.unknownTabIds.includes(14));
  assert.ok(f.tabs.has(owned.tabId));
});

test('cleanup inspection is read-only, scoped, and never upgrades unknown ownership', async () => {
  const { Executor } = await load(),
    f = workspaceFixture(),
    e = new Executor(f.api);
  await e.approve(task());
  const empty = await e.cleanupStatus({ taskId: 'a', generation: 1 });
  assert.equal(empty.cleanupState, 'succeeded');
  assert.equal(empty.cleanupReason, 'verified_complete');
  assert.deepEqual(empty.remainingTabIds, []);
  assert.deepEqual(empty.preservedTabIds, []);
  assert.deepEqual(empty.unknownTabIds, []);
  for (const request of [
    { taskId: 'absent', generation: 1 },
    { taskId: 'a', generation: 2 },
  ]) {
    const unknown = await e.cleanupStatus(request);
    assert.equal(unknown.cleanupState, 'unknown');
    assert.equal(unknown.cleanupReason, 'no_journal');
  }
  // 中文注释：成功仅来自可信空日志；歧义创建仍须未知，检查不能授予删除权或改写日志。
  const work = await executeUserApproved(e, newTabCommand());
  await e.workspaces.spawned(e.tasks.get('a').workspaceCapability, {
    id: 14,
    openerTabId: 1,
    windowId: 7,
  });
  const before = structuredClone(f.data),
    groups = structuredClone(f.groups);
  const unknown = await e.cleanupStatus({ taskId: 'a', generation: 1 });
  assert.equal(unknown.cleanupState, 'unknown');
  assert.equal(unknown.cleanupReason, 'ownership_unknown');
  assert.deepEqual(unknown.unknownTabIds, [14]);
  assert.deepEqual(unknown.remainingTabIds, [work.tabId]);
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.groups, groups);
  assert.deepEqual(f.removed, []);
  assert.equal(e.leases.has(14), false);
});

test('cleanup retry rejects changed inventory instead of ignoring daemon proof tabIds', async () => {
  const { Executor } = await load(),
    e = new Executor({});
  let removals = 0;
  e.tasks.set('a', { id: 'a', generation: 1, revoked: true, workspaceCapability: {} });
  e.workspaces = {
    ready: Promise.resolve(),
    cleanupStatus: async () => ({
      cleanupState: 'pending',
      remainingTabIds: [7, 8],
      preservedTabIds: [],
      unknownTabIds: [],
    }),
    cleanup: async () => {
      removals++;
      return {};
    },
  };
  await assert.rejects(
    e.cleanupRetry({ taskId: 'a', generation: 1, tabIds: [7] }),
    /inventory changed/,
  );
  assert.equal(removals, 0);
  await e.cleanupRetry({ taskId: 'a', generation: 1, tabIds: [7, 8] });
  assert.equal(removals, 1);
});

test('new-tab lease conflict never closes a tab already owned by another task', async () => {
  const { Executor } = await load();
  const { api, tabs, removed, groups } = workspaceFixture();
  const e = new Executor(api);
  await e.approve(task('a', []));
  await e.approve(task('b', [1]));
  let creates = 0;
  api.tabs.create = async () => {
    creates++;
    return { ...tabs.get(1) };
  };
  // 中文注释：明确租约冲突为 TASK_BUSY；重放同一未知创建请求仍被日志阻止，不能再建或误删别人的页。
  await assert.rejects(executeUserApproved(e, newTabCommand()), {
    message: 'TASK_BUSY',
    code: 'TASK_BUSY',
    preDispatch: false,
  });
  await assert.rejects(executeUserApproved(e, newTabCommand()), { code: 'workspace_unknown' });
  assert.equal(creates, 1);
  assert.equal(groups.length, 0);
  assert.deepEqual(removed, []);
  assert.equal(tabs.get(1).groupId, -1);
  assert.equal(e.leases.get(1), 'b');
  await e.release({ taskId: 'a', generation: 1, closeAgentTabs: true });
  assert.deepEqual(removed, []);
  assert.equal(e.leases.get(1), 'b');
});
