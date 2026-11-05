import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../../native-extension/bridge.mjs';
import { Executor } from '../../native-extension/core.mjs';
import { DiagnosticEventBuffer } from '../../browser-diagnostics/js/diagnostics.mjs';

async function request(description, semantic = true, action = 'ref_click') {
  const api = {
    debugger: { sendCommand: async () => ({ exceptionDetails: { exception: { description } } }) },
  };
  const executor = new Executor(api);
  // 中文注释：本测试只验证动作异常，不把库安装错误混入测试。
  executor.semanticWorlds.add(JSON.stringify([1, undefined, 1]));
  executor.execute = () =>
    semantic
      ? executor.callSemanticWorld({ tabId: 1 }, 'frame', 'ref_click', {}, () => {}, 1)
      : executor.callWorld(
          { tabId: 1 },
          'frame',
          { allowedOrigins: ['https://example.test'] },
          'click',
          '#target',
          null,
          null,
          () => {},
          1,
        );
  const sent = [];
  const bridge = new Bridge(
    { postMessage: (m) => sent.push(m), onMessage: { addListener() {} } },
    executor,
  );
  bridge.receive({ id: 'probe', method: 'browser.execute', params: { action } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  return sent[0].error;
}

function legacyData(error) {
  assert.ok(['usage', 'site', 'plugin'].includes(error.data.category));
  assert.equal(typeof error.data.hint, 'string');
  const { category, hint, ...data } = error.data;
  return data;
}

for (const semantic of [true, false])
  for (const [reason, code] of [
    ['TARGET_OCCLUDED', 'target_occluded'],
    ['STALE_REF', 'stale_reference'],
    ['BINDING_MISMATCH', 'stale_reference'],
    ['DOM_CHANGED', 'document_changed'],
    ['origin denied', 'permission_denied'],
  ])
    test(`CDP ${semantic ? 'semantic' : 'selector'} error retains ${reason}`, async () => {
      const error = await request(
        `Error: ${reason}\n    at privatePage (https://example.test/private?secret=hidden:1:2)`,
        semantic,
      );
      assert.equal(error.code, code);
      assert.deepEqual(legacyData(error), {
        outcomeUnknown: !['TARGET_OCCLUDED', 'STALE_REF', 'BINDING_MISMATCH'].includes(reason),
        retryable: ['STALE_REF', 'BINDING_MISMATCH'].includes(reason),
        ...(code === 'document_changed'
          ? { stage: 'document', reasonCode: 'document_changed' }
          : {}),
        ...(code === 'permission_denied'
          ? { stage: 'authority', reasonCode: 'origin_denied' }
          : {}),
      });
      assert.equal(JSON.stringify(error).includes('private'), false);
    });

for (const reason of [
  'origin scheme denied',
  'origin authority mismatch',
  'tab lease denied',
  'confirmation required',
  'stale generation',
])
  test(`read refusal retains fixed cause without changing authority: ${reason}`, async () => {
    const error = await request(
      `Error: ${reason}\n    at privatePage (https://example.test/private?secret=hidden:1:2)`,
      true,
      'semantic_snapshot',
    );
    assert.equal(error.code, 'permission_denied');
    assert.deepEqual(legacyData(error), {
      outcomeUnknown: false,
      retryable: false,
      stage: 'authority',
      reasonCode: reason.replaceAll(' ', '_'),
    });
    assert.equal(JSON.stringify(error).includes('private'), false);
  });
test('wrapped stale read permits refresh, not write replay', async () => {
  const error = await request(
    'Error: STALE_REF\n    at snapshot (<anonymous>:1:2)',
    true,
    'semantic_snapshot',
  );
  assert.equal(error.code, 'stale_reference');
  assert.deepEqual(legacyData(error), { outcomeUnknown: false, retryable: true });
});
test('classification must not search arbitrary payloads or stack frames', async () => {
  for (const text of [
    'private TARGET_OCCLUDED payload',
    'Error: private\n    at STALE_REF',
    'Error: STALE_REF extra-private-data',
    'Error: CONTENT_SHIELD_PRIVATE_CANARY',
  ]) {
    const error = await request(text);
    assert.equal(error.code, 'execution_denied');
    assert.equal(JSON.stringify(error).includes('private'), false);
  }
});
test('page-load CDP protocol errors become retryable page_not_ready for reads, never generic denial', async () => {
  const run = async (action, message) => {
    const executor = new Executor({ debugger: {} });
    executor.execute = async () => {
      throw Error(message);
    };
    const sent = [];
    const bridge = new Bridge(
      { postMessage: (m) => sent.push(m), onMessage: { addListener() {} } },
      executor,
    );
    bridge.receive({ id: 'probe', method: 'browser.execute', params: { action } });
    await new Promise((resolve) => setImmediate(resolve));
    return sent[0].error;
  };
  let error = await run(
    'semantic_snapshot',
    '{"code":-32000,"message":"Cannot find context with specified id"}',
  );
  assert.equal(error.code, 'page_not_ready');
  assert.deepEqual(legacyData(error), { outcomeUnknown: false, retryable: true });
  error = await run('ref_click', '{"code":-32000,"message":"Execution context was destroyed."}');
  assert.equal(error.code, 'page_not_ready');
  assert.equal(error.data.retryable, false);
  assert.equal(error.data.outcomeUnknown, true);
  for (const detail of [
    '{"message": "Cannot find context with specified id", "code": -32000}',
    '{"code": -32000, "message": "Execution context was destroyed."}',
  ]) {
    error = await run('official.ready_state', detail);
    assert.equal(error.code, 'page_not_ready');
    assert.deepEqual(legacyData(error), { outcomeUnknown: false, retryable: true });
  }
  error = await run('semantic_snapshot', 'private Cannot find context with specified id');
  assert.equal(error.code, 'execution_denied');
});
test('page parser budget failure has a fixed code', async () => {
  const error = await request('Error: BUDGET_TOO_SMALL', true, 'page.parse');
  assert.equal(error.code, 'parse_budget_too_small');
  assert.equal(error.data.outcomeUnknown, false);
});

test('后台过渡遮挡仅在明确派发前拒绝时报告确定结果', async () => {
  const executor = new Executor({ debugger: {} });
  for (const before of [true, false]) {
    executor.execute = async () => { throw Object.assign(Error('HIDDEN_STALLED'), { preDispatch: before }); };
    const sent = [], bridge = new Bridge({ postMessage: m => sent.push(m), onMessage: { addListener() {} } }, executor);
    bridge.receive({ id: 'hidden', method: 'browser.execute', params: { action: 'ref_click' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[0].error.code, 'document_hidden_stalled');
    assert.equal(sent[0].error.data.outcomeUnknown, !before);
    assert.equal(sent[0].error.data.retryable, false);
    assert.equal(sent[0].error.data.category, 'site');
    if (before) assert.match(sent[0].error.data.hint, /focused_window/);
    if (before) assert.match(sent[0].error.data.hint, /未派发/);
  }
});

test('目标标签在派发前已关闭时保留固定原因和安全重试状态', async () => {
  const executor = new Executor({ debugger: {} });
  executor.execute = () => executor.performAuthorized({}, { action: 'click', tabId: 42 }, () => {}, async () => {
    throw Error('No tab with id: 42.');
  }, 1);
  const sent = [], bridge = new Bridge({ postMessage: m => sent.push(m), onMessage: { addListener() {} } }, executor);
  bridge.receive({ id: 'closed', method: 'browser.execute', params: { action: 'click' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].error.code, 'execution_denied');
  assert.equal(sent[0].error.data.reasonCode, 'tab_closed');
  assert.equal(sent[0].error.data.stage, 'preparation');
  assert.equal(sent[0].error.data.outcomeUnknown, false);
  assert.equal(sent[0].error.data.retryable, true);
});

test('调试连接在写动作派发前失败时只保留固定原因，不泄露异常', async () => {
  for (const action of ['click', 'navigate']) {
    const executor = new Executor({ debugger: { attach: async () => { throw Error('PRIVATE_SECRET'); } } });
    if (action === 'navigate') executor.downloads = {};
    executor.execute = () => executor.performAuthorized({}, { action, tabId: 42 }, () => {}, async () => ({ id: 42 }), 1);
    const sent = [], bridge = new Bridge({ postMessage: m => sent.push(m), onMessage: { addListener() {} } }, executor);
    bridge.receive({ id: 'attach-failed', method: 'browser.execute', params: { action } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[0].error.code, 'execution_denied');
    assert.equal(sent[0].error.data.stage, 'preparation');
    assert.equal(sent[0].error.data.reasonCode, 'debugger_attach_failed');
    assert.equal(sent[0].error.data.outcomeUnknown, false);
    assert.equal(sent[0].error.data.retryable, true);
    assert.doesNotMatch(JSON.stringify(sent[0]), /PRIVATE_SECRET/);
  }
});

test('兜底失败的诊断事件使用受支持类型和固定原因', async () => {
  const executor = new Executor({ debugger: {} });
  executor.diagnostics = new DiagnosticEventBuffer();
  executor.execute = async () => { throw Error('PRIVATE_SECRET'); };
  const sent = [], bridge = new Bridge({ postMessage: m => sent.push(m), onMessage: { addListener() {} } }, executor);
  bridge.receive({ id: 'internal', method: 'browser.execute', params: { action: 'click' } });
  await new Promise(resolve => setImmediate(resolve));
  const event = executor.diagnostics.snapshot().find(row => row.status === 'failed');
  assert.equal(event.event_type, 'action_state');
  assert.equal(event.error_code, 'execution_denied');
  assert.equal(event.reason_code, 'internal_exception');
  assert.equal(event.stage, 'execution');
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_SECRET/);
});

test('展开下拉已派发后的遮挡拒绝保留未知结果，不能按前置错误重试', async () => {
  const executor = new Executor({ debugger: {} });
  executor.execute = async () => {
    throw Object.assign(Error('TARGET_OCCLUDED'), { preDispatch: false });
  };
  const sent = [],
    bridge = new Bridge(
      { postMessage: (m) => sent.push(m), onMessage: { addListener() {} } },
      executor,
    );
  bridge.receive({
    id: 'post-dispatch',
    method: 'browser.execute',
    params: { action: 'ref_select_option' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].error.code, 'target_occluded');
  assert.equal(sent[0].error.data.outcomeUnknown, true);
  assert.equal(sent[0].error.data.retryable, false);
});

for (const [reason, code] of [
  ['sensitive target blocked', 'sensitive_target'],
  ['target unavailable', 'target_unavailable'],
  ['target not found', 'target_unavailable'],
])
  test(`具体页面拒绝 ${reason} 有固定码且不泄露页面内容`, async () => {
    // 中文注释：定位失败发生在派发前，保留固定码且不泄露页面异常文本。
    const error = await request(
      `Error: ${reason}\n    at privatePage (https://example.test/private?secret=hidden:1:2)`,
      false,
      'fill',
    );
    assert.equal(error.code, code);
    assert.equal(error.data.outcomeUnknown, reason === 'sensitive target blocked');
    assert.equal(JSON.stringify(error).includes('private'), false);
  });

// 中文注释：这些浏览器边界错误只归类，不据此推断写动作未派发。
for (const [detail, expected] of [
  ['Debugger is not attached to the tab with id: 42.', 'debugger_detached'],
  ['No tab with id: 42.', 'tab_closed'],
  ['Debugger command timed out', 'cdp_timeout'],
  ['Frame not found', 'frame_destroyed'],
  ['Execution context was destroyed', 'execution_context_lost'],
  ['Extension context invalidated.', 'service_worker_disconnected'],
  ['CHROME_API_ERROR', 'chrome_api_error'],
  ['arbitrary page secret', 'internal_exception'],
]) test(`兜底固定分类 ${expected}`, async () => {
  const executor = new Executor({debugger:{}}), sent=[];
  executor.execute = async () => { throw Error(detail); };
  const bridge = new Bridge({postMessage:m=>sent.push(m),onMessage:{addListener(){}}},executor);
  bridge.receive({id:'reason',method:'browser.execute',params:{action:'click'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent[0].error.data.reasonCode, expected);
  assert.equal(sent[0].error.data.outcomeUnknown, true);
  assert.equal(sent[0].error.data.retryable, false);
});

test('标签查询 chrome API 失败发生在派发前并保留固定原因', async () => {
  const executor = new Executor({ debugger: {} }), sent = [];
  executor.execute = () => executor.performAuthorized({}, { action: 'js.evaluate', tabId: 42 }, () => {}, async () => { throw Error('private chrome API detail'); }, 1);
  const bridge = new Bridge({ postMessage: m => sent.push(m), onMessage: { addListener() {} } }, executor);
  bridge.receive({ id: 'api', method: 'browser.execute', params: { action: 'js.evaluate' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0].error.data.stage, 'preparation');
  assert.equal(sent[0].error.data.reasonCode, 'chrome_api_error');
  assert.equal(sent[0].error.data.outcomeUnknown, false);
  assert.equal(sent[0].error.data.retryable, true);
  assert.doesNotMatch(JSON.stringify(sent[0]), /private/);
});
