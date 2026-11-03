// 中文注释：合成Chrome边界与实际保护模块，不启动浏览器或读取个人安装。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionResilience,
  retryDelay,
  inspectExecutionSurface,
} from '../../native-extension/execution-resilience.mjs';
import { JSDOM } from 'jsdom';

function fixture() {
  let now = 100000,
    health = {
      reason: 'ready',
      editable: false,
      frames: false,
      epoch: 'epoch',
      progress: 'p',
      readyState: 'complete',
    };
  const commands = [],
    tasks = new Map(),
    leases = new Map([
      [1, 'a'],
      [2, 'b'],
    ]);
  const api = {
    tabs: { get: async (id) => ({ id, url: 'https://example.test/page' }) },
    debugger: {
      sendCommand: async (_target, method) => {
        commands.push(method);
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.callFunctionOn')
          return { result: { value: structuredClone(health) } };
        return {};
      },
    },
  };
  const executor = {
    api,
    tasks,
    leases,
    docs: new Map(),
    check: (t, p) => {
      if (t.revoked || t.generation !== p.generation)
        throw Object.assign(Error('revoked'), { preDispatch: true });
    },
    checkedFrameTree: async () => ({ frame: { id: 'frame', loaderId: 'loader' } }),
  };
  const engine = new ExecutionResilience(executor, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const task = (id) => {
    const t = {
      id,
      generation: 1,
      policy: { modeGeneration: 1 },
      agentTabs: new Set([id === 'a' ? 1 : 2]),
    };
    tasks.set(id, t);
    engine.state(t).created.add(id === 'a' ? 1 : 2);
    return t;
  };
  const a = task('a'),
    b = task('b');
  const params = (id = 1, operation = 'status', extra = {}) => ({
    taskId: id === 1 ? 'a' : 'b',
    generation: 1,
    tabId: id,
    action: 'execution.guard',
    options: { operation, ...extra },
  });
  const status = (t = a, id = 1) =>
    engine.execute(t, params(id), { tabId: id }, () => executor.check(t, params(id)));
  const recover = (token, t = a, id = 1) =>
    engine.execute(t, params(id, 'recover', { healthId: token }), { tabId: id }, () =>
      executor.check(t, params(id)),
    );
  const response = (statusCode = 429, headers = {}, extra = {}) =>
    engine.observe({ tabId: 1 }, 'Network.responseReceived', {
      requestId: String(commands.length) + ':' + now,
      type: 'XHR',
      response: { url: 'https://example.test/api', status: statusCode, headers },
      ...extra,
    });
  return {
    engine,
    a,
    b,
    commands,
    executor,
    status,
    recover,
    response,
    setHealth: (value) => {
      health = { ...health, ...value };
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    params,
  };
}

test('Retry-After 数字/日期/非法值及固定上限', () => {
  assert.equal(retryDelay('2', 1000), 2000);
  assert.equal(retryDelay(new Date(5000).toUTCString(), 1000), 4000);
  assert.equal(retryDelay('bad'), 0);
  assert.equal(retryDelay('-1', 10000000000000), 0);
  assert.equal(retryDelay('99999999'), 86400000);
});
test('同站任务共享冷却，长等待不派发且不保留队列名额', async () => {
  const f = fixture();
  await f.status();
  await f.status(f.b, 2);
  f.response(429, { 'Retry-After': '30' });
  await assert.rejects(
    f.engine.enter(f.b, { ...f.params(2), action: 'ref_click', ref: 'r' }),
    /ACCESS_COOLDOWN/,
  );
  assert.equal(f.engine.site('https://example.test').queued, 0);
  assert.equal((await f.status(f.b, 2)).access.retryAfterMs, 30000);
});
test('降速期单并发、间隔递增，持续成功后逐步恢复', async () => {
  const f = fixture();
  await f.status();
  await f.status(f.b, 2);
  f.response();
  const first = await f.engine.enter(f.a, { ...f.params(), action: 'click' });
  assert.equal(f.now(), 100500);
  let admitted = false;
  const second = f.engine.enter(f.b, { ...f.params(2), action: 'click' }).then((release) => {
    admitted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  first();
  (await second)();
  for (let i = 0; i < 8; i++) {
    f.advance(1000);
    f.response(200);
  }
  assert.equal((await f.status()).access.delayMs, 0);
});
test('第三方/子frame/静态资源错误不当成本业务限流', async () => {
  const f = fixture();
  await f.status();
  f.engine.observe({ tabId: 1, sessionId: 'child' }, 'Network.responseReceived', {
    type: 'XHR',
    response: { url: 'https://example.test/x', status: 429 },
  });
  f.response(429, {}, { type: 'Image' });
  f.response(429, {}, { response: { url: 'https://ads.test/x', status: 429 } });
  assert.equal((await f.status()).access.delayMs, 0);
});
test('等待中接管或模式变化，释放队列且不迟到派发', async () => {
  const f = fixture();
  await f.status();
  f.response();
  let slept = 0;
  f.engine.sleep = async (ms) => {
    f.advance(ms);
    if (++slept === 1) f.a.policy.modeGeneration++;
  };
  await assert.rejects(
    f.engine.enter(f.a, { ...f.params(), action: 'click' }),
    /GUARD_INTERRUPTED/,
  );
  assert.equal(f.engine.site('https://example.test').active, 0);
  assert.equal(f.engine.site('https://example.test').queued, 0);
});
test('三个已知未派发失败打开熔断，读取状态不解除', async () => {
  const f = fixture();
  await f.status();
  for (let i = 0; i < 3; i++)
    f.engine.finish(
      f.a,
      { ...f.params(), action: 'click' },
      Object.assign(Error('TARGET_HIDDEN'), { preDispatch: true }),
    );
  assert.equal((await f.status()).protection.circuitOpen, true);
  await assert.rejects(
    f.engine.enter(f.a, { ...f.params(), action: 'click' }),
    /EXECUTION_CIRCUIT_OPEN/,
  );
  f.advance(30000);
  const release = await f.engine.enter(f.a, { ...f.params(), action: 'click' });
  release();
});
test('三次同目标无进展停止下一次，真实进展后解除', async () => {
  const f = fixture();
  await f.status();
  for (let i = 0; i < 3; i++) {
    f.engine.finish(f.a, { ...f.params(), action: 'ref_click', ref: 'r' }, null);
    await f.status();
  }
  assert.equal((await f.status()).protection.stalled, true);
  await assert.rejects(
    f.engine.enter(f.a, { ...f.params(), action: 'ref_click', ref: 'r' }),
    /EXECUTION_NO_PROGRESS/,
  );
  f.setHealth({ progress: 'new' });
  assert.equal((await f.status()).protection.stalled, false);
});
test('不同任务/标签的进展不会相互重置', async () => {
  const f = fixture();
  await f.status();
  await f.status(f.b, 2);
  for (let i = 0; i < 3; i++) {
    f.engine.finish(f.a, { ...f.params(), action: 'ref_click', ref: 'r' }, null);
    await f.status();
    f.setHealth({ progress: 'b' + i });
    await f.status(f.b, 2);
    f.setHealth({ progress: 'p' });
  }
  assert.equal((await f.status()).protection.stalled, true);
  assert.equal((await f.status(f.b, 2)).protection.stalled, false);
});
test('安全自建错误页只能刷新一次，丢回执不补发', async () => {
  const f = fixture();
  f.setHealth({ reason: 'transient' });
  const h = await f.status();
  assert.equal(h.reloadAllowed, true);
  assert.equal((await f.recover(h.healthId)).reloaded, true);
  const next = await f.status();
  assert.equal(next.reloadAllowed, false);
  await assert.rejects(f.recover(next.healthId), /RECOVERY_BLOCKED/);
  assert.equal(f.commands.filter((x) => x === 'Page.reload').length, 1);
});
test('草稿、框架、旧自建页面和既往写入均保护现场', async () => {
  for (const kind of ['editable', 'frames', 'restored', 'dirty', 'credential']) {
    const f = fixture();
    f.setHealth({
      reason: 'transient',
      ...(kind === 'editable' ? { editable: true } : {}),
      ...(kind === 'frames' ? { frames: true } : {}),
    });
    if (kind === 'restored') f.engine.state(f.a).created.clear();
    if (kind === 'credential') f.a.credentialTabs = new Set([1]);
    if (kind === 'dirty') f.engine.note(f.a, { action: 'fill', tabId: 1 });
    const h = await f.status();
    assert.equal(h.reloadAllowed, false, kind);
    await assert.rejects(f.recover(h.healthId), /RECOVERY_BLOCKED/);
    assert.equal(f.commands.includes('Page.reload'), false);
  }
});
test('过期、伪造或换文档刷新资格拒绝，未派发', async () => {
  for (const kind of ['age', 'fake', 'document', 'progress']) {
    const f = fixture();
    f.setHealth({ reason: 'transient' });
    const h = await f.status();
    if (kind === 'age') f.advance(10001);
    if (kind === 'document') f.setHealth({ epoch: 'new' });
    if (kind === 'progress') f.setHealth({ progress: 'new' });
    await assert.rejects(f.recover(kind === 'fake' ? 'forged' : h.healthId), /RECOVERY_STALE/);
    assert.equal(f.commands.includes('Page.reload'), false);
  }
});
test('刷新已发送后异常保留unknown并消耗额度', async () => {
  const f = fixture();
  f.setHealth({ reason: 'transient' });
  const h = await f.status();
  const original = f.executor.api.debugger.sendCommand;
  f.executor.api.debugger.sendCommand = async (...args) => {
    if (args[1] === 'Page.reload') throw Error('disconnect');
    return original(...args);
  };
  await assert.rejects(
    f.recover(h.healthId),
    (e) =>
      e.message === 'RECOVERY_OUTCOME_UNKNOWN' &&
      e.preDispatch === false &&
      e.outcomeUnknown === true,
  );
  assert.equal((await f.status()).reloadAllowed, false);
});
test('验证码、权限、登录、配额要求人工，不做刷新', async () => {
  for (const reason of ['captcha', 'permission', 'login', 'quota']) {
    const f = fixture();
    f.setHealth({ reason });
    const h = await f.status();
    assert.equal(h.reason, reason);
    await assert.rejects(
      f.engine.enter(f.a, { ...f.params(), action: 'click' }),
      /EXECUTION_HANDOFF/,
    );
    await assert.rejects(f.recover(h.healthId), /RECOVERY_BLOCKED/);
  }
});
test('实际隔离探针只回状态摘要，表单值与页面正文不出结果', () => {
  const d = new JSDOM(
    '<h1>Service unavailable</h1><input value="PRIVATE_VALUE"><p>PRIVATE_BODY</p>',
    { pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  d.window.HTMLElement.prototype.getClientRects = () => [{ x: 0, y: 0, width: 10, height: 10 }];
  const h = d.window.eval('(' + inspectExecutionSurface.toString() + ')()');
  assert.equal(h.reason, 'transient');
  assert.equal(h.editable, true);
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE_VALUE|PRIVATE_BODY|Service unavailable/);
  const again = d.window.eval('(' + inspectExecutionSurface.toString() + ')()');
  assert.equal(again.epoch, h.epoch);
  d.window.close();
});

test('脚本已知失败按健康回执去重，原生失败不重复累计', async () => {
  const f = fixture();
  const report = (id) =>
    f.engine.execute(
      f.a,
      f.params(1, 'failure', { healthId: id, code: 'ambiguous_target' }),
      { tabId: 1 },
      () => {},
    );
  const h = await f.status();
  await report(h.healthId);
  await report(h.healthId);
  assert.equal((await f.status()).protection.failures, 1);
  const next = await f.status();
  f.engine.finish(
    f.a,
    { ...f.params(), action: 'ref_click' },
    Object.assign(Error('TARGET_HIDDEN'), { preDispatch: true }),
  );
  await report(next.healthId);
  assert.equal((await f.status()).protection.failures, 2);
  const final = await f.status();
  await report(final.healthId);
  assert.equal((await f.status()).protection.circuitOpen, true);
  await assert.rejects(report('forged'), /RECOVERY_STALE/);
});
test('超长服务端冷却要求人工，未到期成功不提前解锁', async () => {
  const f = fixture();
  await f.status();
  f.response(429, { 'Retry-After': '9999999' });
  f.advance(1000);
  f.response(200);
  assert.equal((await f.status()).access.requiresUser, true);
  await assert.rejects(
    f.engine.enter(f.a, { ...f.params(), action: 'click' }),
    /EXECUTION_HANDOFF/,
  );
});

test('冷却排队期间新增人工状态/熔断/无进展不得迟到派发', async () => {
  for (const kind of ['handoff', 'circuit', 'stalled', 'manual']) {
    const f = fixture();
    await f.status();
    f.response();
    f.engine.sleep = async (ms) => {
      f.advance(ms);
      const s = f.engine.state(f.a);
      if (kind === 'handoff') s.blocked = { reason: 'permission' };
      if (kind === 'circuit') s.circuitUntil = f.now() + 30000;
      if (kind === 'stalled') f.engine.loop(s, 1).stalls = 3;
      if (kind === 'manual') f.engine.site('https://example.test').manual = true;
    };
    await assert.rejects(
      f.engine.enter(f.a, { ...f.params(), action: 'click' }),
      /EXECUTION_(HANDOFF|CIRCUIT_OPEN|NO_PROGRESS)/,
    );
    assert.equal(f.engine.site('https://example.test').active, 0);
    assert.equal(f.engine.site('https://example.test').queued, 0);
  }
});

test('逻辑选页不污染刷新资格或清除失败熔断', async () => {
  const f = fixture();
  await f.status();
  for (let i = 0; i < 3; i++) {
    f.engine.finish(
      f.a,
      { ...f.params(), action: 'click' },
      Object.assign(Error('TARGET_HIDDEN'), { preDispatch: true }),
    );
    for (const method of ['Page.bringToFront', 'Target.activateTarget']) {
      const p = { ...f.params(), action: 'cdp.send', method };
      f.engine.note(f.a, p);
      f.engine.finish(f.a, p, null, {});
    }
  }
  assert.equal((await f.status()).protection.circuitOpen, true);
  assert.equal(f.engine.state(f.a).dirty.size, 0);
});

test('业务记录ID变化驱动进展，跨文档相同游标仍识别循环', async () => {
  const f = fixture();
  f.setHealth({ business: { complete: true, digest: 'same', matched: 1 } });
  const h = await f.status();
  await f.engine.execute(
    f.a,
    f.params(1, 'progress', {
      healthId: h.healthId,
      selectors: [{ selector: '[data-record-id]', attribute: 'data-record-id' }],
    }),
    { tabId: 1 },
    () => {},
  );
  for (let i = 0; i < 3; i++) {
    f.engine.finish(
      f.a,
      { ...f.params(), action: 'navigate', url: 'https://example.test/page' },
      null,
    );
    f.setHealth({ epoch: 'document' + i });
    await f.status();
  }
  assert.equal((await f.status()).protection.stalled, true);
  f.setHealth({ business: { complete: true, digest: 'new-record', matched: 1 } });
  assert.equal((await f.status()).protection.stalled, false);
});
test('业务范围不完整拒绝写入，不允许更换配置绕过已有循环', async () => {
  const f = fixture();
  f.setHealth({ business: { complete: false, digest: 'partial', matched: 300 } });
  const h = await f.status();
  await f.engine.execute(
    f.a,
    f.params(1, 'progress', { healthId: h.healthId, selectors: [{ selector: '.row' }] }),
    { tabId: 1 },
    () => {},
  );
  assert.equal((await f.status()).protection.progressIncomplete, true);
  await assert.rejects(
    f.engine.enter(f.a, { ...f.params(), action: 'click' }),
    /EXECUTION_PROGRESS_INCOMPLETE/,
  );
  const next = await f.status();
  await assert.rejects(
    f.engine.execute(
      f.a,
      f.params(1, 'progress', { healthId: next.healthId, selectors: [{ selector: '.different' }] }),
      { tabId: 1 },
      () => {},
    ),
    /RECOVERY_BLOCKED/,
  );
});
test('业务探针读取指定属性但只返回摘要，节点过量明确不完整', () => {
  const d = new JSDOM(
    '<h1>Ready</h1><div class="row" data-record-id="PRIVATE_RECORD_1">same</div>',
    { pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  d.window.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }];
  const inspect = () =>
    d.window.eval(
      '(' +
        inspectExecutionSurface.toString() +
        ') ("seed",[{selector:".row",attribute:"data-record-id"}])',
    );
  const first = inspect();
  assert.equal(first.business.complete, true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_RECORD/);
  d.window.document.querySelector('.row').setAttribute('data-record-id', 'PRIVATE_RECORD_2');
  assert.notEqual(inspect().business.digest, first.business.digest);
  for (let i = 0; i < 256; i++)
    d.window.document.body.append(d.window.document.querySelector('.row').cloneNode(true));
  assert.equal(inspect().business.complete, false);
  d.window.close();
});

test('本任务已完成下载构成真实进展，其他任务/代次不解除循环', async () => {
  const f = fixture();
  await f.status();
  for (let i = 0; i < 3; i++) {
    f.engine.finish(f.a, { ...f.params(), action: 'ref_click', ref: 'download' }, null);
    f.engine.downloadCompleted({ taskId: 'a', generation: 99, tabId: 1 });
    await f.status();
  }
  assert.equal((await f.status()).protection.stalled, true);
  f.engine.downloadCompleted({ taskId: 'b', generation: 1, tabId: 1 });
  assert.equal((await f.status()).protection.stalled, true);
  f.engine.downloadCompleted({ taskId: 'a', generation: 1, tabId: 1 });
  assert.equal((await f.status()).protection.stalled, false);
});
