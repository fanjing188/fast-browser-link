// 中文注释：轻量观察复用实际语义上下文，测试脱敏、边界、文档变更与宿主注入路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPageSemantics } from '../../page-semantics/index.js';
import { createPageParser } from '../../page-semantics/parser.mjs';
import { observePage } from '../../native-extension/page-observation.mjs';
import { Executor, semanticWorldDeclaration } from '../../native-extension/core.mjs';
import { Bridge } from '../../native-extension/bridge.mjs';
import { trustedTask } from '../native-extension/workspace-fixture.mjs';

test('wait 在扩展内轻量轮询，一次局部解析，并保留原结果契约', async () => {
  const executor = new Executor({
    tabs: { get: async (id) => ({ id, url: 'https://example.com/' }) },
  });
  await executor.approve(trustedTask());
  const calls = [];
  executor.performSettled = async (_t, p) => {
    calls.push(p.action);
    if (p.action === 'page.observe')
      return {
        count: calls.length > 1 ? 1 : 0,
        text: calls.length > 1 ? ['ready'] : [],
        complete: true,
        binding: { documentId: 'd' },
      };
    assert.equal(p.action, 'page.parse');
    assert.equal(p.options.schema.record, '#result');
    return {
      binding: { documentId: 'd' },
      records: [{ fields: { text: 'ready' } }],
      coverage: { complete: true },
    };
  };
  const result = await executor.execute({
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'page.observe',
    options: {
      selector: '#result',
      wait: {
        state: 'present',
        intervalMs: 50,
        deadlineMs: Date.now() + 1000,
      },
    },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(calls, ['page.observe', 'page.observe', 'page.parse']);
});

function fixture(html) {
  const dom = new JSDOM(`<!doctype html><head></head><body>${html}</body>`, {
    url: 'https://fixture.test/',
    pretendToBeVisual: true,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 20,
    top: 20,
    right: 120,
    bottom: 50,
    width: 100,
    height: 30,
  });
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.style.display === 'none' ? [] : [{ x: 0, y: 0, width: 100, height: 20 }];
  };
  const semantics = createPageSemantics({
    document: dom.window.document,
    taskId: 't',
    documentId: 'd',
    leaseId: 'l',
  });
  return {
    dom,
    semantics,
    close() {
      semantics.revoke();
      dom.window.close();
    },
  };
}

async function waitingFixture(perform) {
  const executor = new Executor({
    tabs: { get: async (id) => ({ id, url: 'https://example.com/' }) },
  });
  await executor.approve(trustedTask());
  executor.performSettled = perform;
  return {
    executor,
    task: executor.tasks.get('a'),
    run: (wait = {}) =>
      executor.execute({
        taskId: 'a',
        generation: 1,
        tabId: 1,
        action: 'page.observe',
        options: {
          selector: '#result',
          wait: { state: 'present', intervalMs: 50, deadlineMs: Date.now() + 1000, ...wait },
        },
      }),
  };
}
const observation = (overrides = {}) => ({
  count: 1,
  text: ['ready'],
  complete: true,
  binding: { documentId: 'd' },
  ...overrides,
});
const parsed = (overrides = {}) => ({
  binding: { documentId: 'd' },
  records: [{ fields: { text: 'ready' } }],
  coverage: { complete: true },
  ...overrides,
});

test('wait 五种条件、完整覆盖和文档终验', async () => {
  for (const wait of [
    { state: 'present' },
    { state: 'text', text: 'ready' },
    { state: 'count', count: 1 },
    { state: 'stable' },
    { state: 'absent' },
  ]) {
    let probes = 0,
      parses = 0;
    const f = await waitingFixture(async (_t, p) => {
      if (p.action === 'page.observe') {
        probes++;
        return observation(wait.state === 'absent' ? { count: 0, text: [] } : {});
      }
      parses++;
      return parsed(wait.state === 'absent' ? { records: [] } : {});
    });
    const result = await f.run(wait);
    assert.equal(result.satisfied, true, wait.state);
    assert.equal(probes, wait.state === 'stable' ? 3 : 1);
    assert.equal(parses, 1);
  }
  for (const page of [
    parsed({ binding: { documentId: 'new' } }),
    parsed({ coverage: { complete: false } }),
    parsed({ records: [] }),
  ]) {
    const f = await waitingFixture(async (_t, p) =>
      p.action === 'page.observe' ? observation() : page,
    );
    const result = await f.run();
    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'condition_changed');
  }
});

test('wait absent 不把不完整的零匹配观察当成不存在', async () => {
  const actions = [];
  const f = await waitingFixture(async (_t, p) => {
    actions.push(p.action);
    assert.equal(p.action, 'page.observe');
    return observation({ count: 0, text: [], complete: false });
  });
  const result = await f.run({ state: 'absent', deadlineMs: Date.now() + 75 });
  assert.equal(result.satisfied, false);
  assert.equal(result.timed_out, true);
  assert.ok(actions.length >= 1);
  assert.ok(actions.every((action) => action === 'page.observe'));
});

test('wait 截止不再解析；从队列迟到的工作不派发', async () => {
  let reads = 0;
  const f = await waitingFixture(async () => {
    reads++;
    return observation({ count: 0, text: [] });
  });
  const result = await f.run({ deadlineMs: Date.now() + 75 });
  assert.equal(result.timed_out, true);
  assert.ok(reads >= 1);
  await f.executor.lock(1, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  let unlock;
  const blocked = f.executor.lock(
    1,
    () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const previous = reads;
  const queued = await f.run({ deadlineMs: Date.now() + 50 });
  assert.equal(queued.timed_out, true);
  unlock();
  await blocked;
  await f.executor.lock(1, () => {});
  assert.equal(reads, previous);
});

test('wait 排队超时仍占唯一容量，释放前不累计屏障读者', async () => {
  let reads = 0,
    unlock;
  const f = await waitingFixture(async () => {
    reads++;
    return observation();
  });
  const blocked = f.executor.lock(
    1,
    () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal((await f.run({ deadlineMs: Date.now() + 50 })).timed_out, true);
    assert.equal(f.task.waitReads.size, 1);
    for (let i = 0; i < 8; i++) await assert.rejects(f.run(), /OBSERVATION_CAPACITY/);
    assert.equal(f.executor.taskBarriers.get('a').pending, 1);
    assert.equal(f.executor.taskBarriers.get('a').readers.size, 1);
    assert.equal(reads, 0);
  } finally {
    unlock();
    await blocked;
    await f.executor.lock(1, () => {});
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.task.waitReads.size, 0);
  assert.equal(reads, 0);
});

test('wait 永不返回的探测有界退锁、容量不增长，迟到结果不续读', async () => {
  for (const rejectLate of [false, true]) {
    let settle,
      reads = 0;
    const f = await waitingFixture(() => {
      reads++;
      return new Promise((resolve, reject) => {
        settle = rejectLate ? reject : resolve;
      });
    });
    const result = await f.run({ deadlineMs: Date.now() + 50 });
    assert.equal(result.timed_out, true);
    // 中文注释：等待内部 poll 也退出，不能只核外层 race 已返回。
    await f.executor.lock(1, () => {});
    assert.equal(f.task.waitReads.size, 1);
    await assert.rejects(f.run(), /OBSERVATION_CAPACITY/);
    assert.equal(reads, 1);
    assert.equal(f.task.waitReads.size, 1);
    settle(rejectLate ? Error('late failure') : observation());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.task.waitReads.size, 0);
    assert.equal(reads, 1);
  }
});

test('wait 最终解析挂起仍受同一截止约束', async () => {
  let finish,
    reads = 0;
  const f = await waitingFixture(async (_t, p) => {
    reads++;
    if (p.action === 'page.observe') return observation();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const start = performance.now();
  const result = await f.run({ deadlineMs: Date.now() + 75 });
  assert.equal(result.timed_out, true);
  assert.ok(performance.now() - start < 500);
  await f.executor.lock(1, () => {});
  assert.equal(f.task.waitReads.size, 1);
  finish(parsed());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.task.waitReads.size, 0);
  assert.equal(reads, 2);
});

test('wait 接管、撤权和取消在挂起探测期间生效且不重试', async () => {
  for (const change of [
    (t) => {
      t.paused = true;
    },
    (t) => {
      t.revoked = true;
    },
    (t) => {
      t.policy = { ...t.policy, modeGeneration: t.policy.modeGeneration + 1 };
    },
  ]) {
    let finish, started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    let reads = 0;
    const f = await waitingFixture(() => {
      reads++;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const run = f.run();
    await ready;
    change(f.task);
    await assert.rejects(run);
    await f.executor.lock(1, () => {});
    finish(observation());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(f.task.waitReads.size, 0);
  }
});

test('wait 在轮询间隔内接管也清理所有本地期限和休眠定时器', async () => {
  const f = await waitingFixture(async () => observation({ count: 0, text: [] }));
  const schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout,
    timers = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = schedule(() => {
      timers.delete(timer);
      fn(...args);
    }, ms);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer);
    cancel(timer);
  };
  try {
    const run = f.run({ intervalMs: 2000 });
    await new Promise((resolve) => setImmediate(resolve));
    f.task.paused = true;
    await assert.rejects(run, /task paused/);
    await f.executor.lock(1, () => {});
    assert.equal(timers.size, 0);
  } finally {
    for (const timer of timers) cancel(timer);
    globalThis.setTimeout = schedule;
    globalThis.clearTimeout = cancel;
  }
});

test('迟到 overlay 日志不能续派解析或准备遮罩', async () => {
  const commands = [];
  let finish,
    started,
    readyCalls = 0,
    preveil = 0;
  const logged = new Promise((resolve) => {
    started = resolve;
  });
  const executor = new Executor(
    {
      tabs: { get: async (id) => ({ id, status: 'complete', url: 'https://example.com/' }) },
      debugger: {
        attach: async () => {},
        onEvent: { addListener() {}, removeListener() {} },
        sendCommand: async (_target, method, params = {}) => {
          commands.push([method, params]);
          if (method === 'Page.getFrameTree')
            return {
              frameTree: { frame: { id: 'main', loaderId: 'd', url: 'https://example.com/' } },
            };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
          if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
          if (method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === 'log') {
            started();
            return new Promise((resolve) => {
              finish = resolve;
            });
          }
          return { result: { value: true } };
        },
      },
    },
    () => {},
    {
      onOverlayReady: () => {
        readyCalls++;
      },
    },
  );
  // 中文注释：批准后的维护回调另有测试；本例只让等待流程初始化 overlay。
  executor.restoreOverlay = async () => {};
  await executor.approve(trustedTask());
  executor.tasks.get('a').recentSteps = [];
  executor.syncPreveil = async () => {
    preveil++;
  };
  const run = executor.execute({
    taskId: 'a',
    generation: 1,
    tabId: 1,
    action: 'page.observe',
    options: {
      selector: '#result',
      wait: { state: 'present', intervalMs: 50, deadlineMs: Date.now() + 150 },
    },
  });
  await logged;
  assert.equal((await run).timed_out, true);
  const before = commands.length;
  finish({ result: { value: true } });
  await executor.lock(1, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readyCalls, 0);
  assert.equal(preveil, 0);
  assert.ok(
    commands
      .slice(before)
      .every(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === 'remove',
      ),
  );
  assert.equal(executor.tasks.get('a').waitReads.size, 0);
  assert.equal(executor.tasks.get('a').overlays.has(1), false);
});

test('过期读取不再发 frame 探测，迟到上下文拒绝也不重建世界', async () => {
  let frames = 0,
    worlds = 0,
    rejectInvoke,
    started;
  const dispatched = new Promise((resolve) => {
    started = resolve;
  });
  const executor = new Executor({
    debugger: {
      sendCommand: async (_target, method) => {
        if (method === 'Page.getFrameTree') {
          frames++;
          return {};
        }
        if (method === 'Page.createIsolatedWorld') {
          worlds++;
          return { executionContextId: 2 };
        }
        started();
        return new Promise((_, reject) => {
          rejectInvoke = reject;
        });
      },
    },
  });
  await assert.rejects(
    executor.checkedFrameTree({ tabId: 7 }, {}, () => {
      throw Error('expired');
    }),
    /expired/,
  );
  assert.equal(frames, 0);
  await assert.rejects(
    executor.callSemanticWorld(
      { tabId: 7 },
      'main',
      'page.observe',
      { binding: {}, options: {} },
      () => {
        throw Error('expired');
      },
    ),
    /expired/,
  );
  assert.equal(worlds, 0);
  executor.semanticWorlds.add(JSON.stringify([7, null, 1]));
  let current = true;
  const run = executor.callSemanticWorld(
    { tabId: 7 },
    'main',
    'page.observe',
    { binding: {}, options: {} },
    () => {
      if (!current) throw Error('expired');
    },
    1,
  );
  await dispatched;
  current = false;
  rejectInvoke(
    Error(JSON.stringify({ code: -32000, message: 'Cannot find context with specified id' })),
  );
  await assert.rejects(run, /expired/);
  assert.equal(worlds, 0);
});

test('观察与解析匹配相同可见脱敏文本，不读字段值', () => {
  const f = fixture(
    '<p class="row">token="SECRET" | ready</p><p class="row" hidden>hidden</p><input class="row" type="password" value="SECRET"><p>other</p>',
  );
  try {
    const ctx = f.semantics.parsingContext();
    const observed = observePage(ctx, { selector: '.row' });
    const full = createPageParser(ctx).parse({
      sections: [],
      schema: { record: '.row', fields: { text: { selector: ':scope', type: 'text' } } },
    });
    assert.equal(observed.count, full.records.length);
    assert.deepEqual(
      observed.text,
      full.records.map((row) => row.fields.text),
    );
    assert.equal(observed.complete, full.coverage.complete);
    assert.match(JSON.stringify(observed), /SECRET/);
    assert.doesNotMatch(JSON.stringify(observed), /hidden/);
  } finally {
    f.close();
  }
});

test('扫描与匹配数量有界，不完整范围不能证明 absent；选择器错误固定分类', () => {
  const f = fixture('<p>ready</p>');
  try {
    const ctx = f.semantics.parsingContext();
    const node = f.dom.window.document.querySelector('p');
    const tooMany = {
      ...ctx,
      scan: function* () {
        for (let i = 0; i < 21000; i++) yield node;
      },
    };
    assert.equal(observePage(tooMany, { selector: '.missing' }).complete, false);
    const matches = observePage(tooMany, { selector: 'p' });
    assert.equal(matches.count, 1000);
    assert.equal(matches.complete, false);
    assert.throws(() => observePage(ctx, { selector: '[' }), /^Error: INVALID_PARSE_OPTIONS$/);
    let changes = 0;
    assert.throws(
      () => observePage({ ...ctx, revision: () => changes++ }, { selector: 'p' }),
      /DOCUMENT_CHANGED/,
    );
  } finally {
    f.close();
  }
});

test('宿主观察调用初始化 head，不解析整页，仍逐次运行 guard', async () => {
  const f = fixture('<p id="result">ready</p>');
  const context = vm.createContext({
    document: f.dom.window.document,
    window: f.dom.window,
    crypto: globalThis.crypto,
  });
  const calls = [];
  const api = {
    debugger: {
      sendCommand: async (_target, method, p) => {
        calls.push({ method, p });
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.callFunctionOn') {
          try {
            const fn = vm.runInContext(`(${p.functionDeclaration})`, context);
            return { result: { value: fn(...(p.arguments || []).map((arg) => arg.value)) } };
          } catch (error) {
            return { exceptionDetails: { text: error.message } };
          }
        }
        throw Error(method);
      },
    },
  };
  try {
    const executor = new Executor(api);
    let checks = 0;
    const binding = { taskId: 't', documentId: 'd', leaseId: 'l' };
    for (let i = 0; i < 4; i++) {
      const result = await executor.callSemanticWorld(
        { tabId: 7 },
        'main',
        'page.observe',
        { binding, options: { selector: '#result' } },
        () => {
          checks++;
        },
      );
      assert.equal(result.count, 1);
      assert.equal(result.text[0], 'ready');
      assert.equal(result.complete, true);
    }
    assert.equal(
      calls.filter((row) =>
        row.p?.functionDeclaration?.includes('globalThis.__fastSemanticLibrary={'),
      ).length,
      1,
    );
    assert.equal(
      vm.runInContext('globalThis.__fastNativeSemanticsV2.parser===undefined', context),
      true,
    );
    assert.ok(checks >= 8);
    await assert.rejects(
      executor.callSemanticWorld(
        { tabId: 7 },
        'main',
        'page.observe',
        { binding, options: { selector: '#result' } },
        () => {
          throw Error('mode revoked');
        },
      ),
      /mode revoked/,
    );
  } finally {
    vm.runInContext('globalThis.__fastNativeSemanticsV2?.semantics.revoke()', context);
    f.close();
  }
});

// 中文注释：复用真实 NativeBridge 错误投影，既不返回网页异常原文，也不改旧结果未知判断。
async function refusal(error, action = 'semantic_snapshot') {
  const bridge = new Bridge(
    { postMessage() {}, onMessage: { addListener() {} } },
    {
      execute: async () => {
        throw error;
      },
    },
  );
  return (await bridge.executeRequest({ id: 'r', method: 'browser.execute', params: { action } }))
    .error;
}

test('overlay 细分阶段及文档原因只附固定码，拒绝行为保持不变', async () => {
  for (const reasonCode of ['initialization_exception', 'return_type_invalid']) {
    const result = await refusal(
      Object.assign(Error('overlay injection failed'), { stage: 'overlay', reasonCode }),
    );
    assert.equal(result.code, 'overlay_injection_failed');
    assert.equal(result.data.reasonCode, reasonCode);
    assert.equal(result.data.stage, 'overlay');
    assert.equal(result.data.outcomeUnknown, false);
  }
  const result = await refusal(Error('DOCUMENT_CHANGED'));
  assert.equal(result.data.reasonCode, 'document_changed');
  assert.equal(result.data.stage, 'document');
  const denied = await refusal(
    Object.assign(Error('TAB_OUT_OF_SCOPE'), {
      currentOrigin: 'https://fixture.test/private?q=SECRET',
      preDispatch: true,
    }),
  );
  assert.equal(denied.data.currentOrigin, 'https://fixture.test');
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE|SECRET|private|\?q/);
});

test('技能长度、直接 open、传值、同脚本读回和输出约定均有验收', async () => {
  // 中文注释：固定已审阅的字符预算，保持原长度约束且不依赖私有历史提交。
  const characterBudgets = { 'fast-browser-link': 11644, 'fast-browser-batch-scrape': 12002 };
  for (const name of ['fast-browser-link', 'fast-browser-batch-scrape']) {
    const file = `executor-plugin/skills/${name}/SKILL.md`;
    const after = await readFile(file, 'utf8');
    assert.ok(
      after.length <= characterBudgets[name],
      `${name}: ${after.length} exceeds ${characterBudgets[name]}`,
    );
    assert.match(after, /fast_browser_open/);
    assert.match(after, /coverage/);
    assert.match(after, /same script|同.*脚本/);
  }
  const batch = await readFile('executor-plugin/skills/fast-browser-batch-scrape/SKILL.md', 'utf8');
  for (const term of [
    'arguments',
    'isolated',
    'main',
    'satisfied',
    'nextCursor',
    'workspace',
    'elements',
  ])
    assert.ok(batch.includes(term), term);
  // 中文注释：共享语义库增加 slot、上下文及 AX 绑定；仍限制一次安装且保持后续调用的小消息。
  // 中文注释：账号字段、登录浮层和宿主 classifier 使声明由 HEAD 72883B 增至 75313B（+2430B），只随冷安装发送。
  // 中文注释：76KB 上限保留 687B 余量；安装次数与八次热调用 <6KB 由 cdp-budget.test.mjs 独立守住。
  assert.ok(Buffer.byteLength(semanticWorldDeclaration) <= 76000);
});
