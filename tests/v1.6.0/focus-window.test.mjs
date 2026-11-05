import test from 'node:test';
import assert from 'node:assert/strict';
import { focusTaskWindow } from '../../native-extension/work-window.mjs';
import { Executor } from '../../native-extension/core.mjs';
import { Bridge } from '../../native-extension/bridge.mjs';
import { BackgroundRender, BACKGROUND_RENDER_STRATEGY } from '../../native-extension/background-render.mjs';
import { PageRuntime } from '../../native-extension/page-runtime.mjs';

test('后台渲染默认关闭；探针验证前不发送 CDP 命令', async () => {
  const calls = [], listeners = new Set();
  const api = { debugger: { sendCommand: async (...args) => { calls.push(args); }, onEvent: {
    addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
  } } };
  assert.equal(BACKGROUND_RENDER_STRATEGY, null);
  const disabled = new BackgroundRender(api);
  await disabled.enable(9); await disabled.close(9);
  assert.deepEqual(calls, []);
  for (const [strategy, first, last] of [
    ['focus', 'Emulation.setFocusEmulationEnabled', 'Emulation.setFocusEmulationEnabled'],
    ['lifecycle', 'Page.setWebLifecycleState', 'Page.setWebLifecycleState'],
    ['screencast', 'Page.startScreencast', 'Page.stopScreencast'],
  ]) {
    calls.length = 0;
    const enabled = new BackgroundRender(api, strategy);
    await enabled.enable(9); await enabled.enable(9);
    if (strategy === 'screencast') {
      assert.equal(listeners.size, 1);
      [...listeners][0]({ tabId: 9 }, 'Page.screencastFrame', { sessionId: 4 });
      assert.equal(calls.at(-1)[1], 'Page.screencastFrameAck');
    }
    await enabled.close(9);
    assert.equal(calls[0][1], first);
    assert.equal(calls.at(-1)[1], last);
    assert.equal(listeners.size, 0);
  }
});

test('内部保活画面不进入 CDP 事件缓冲或网络观察', () => {
  const api = { debugger: { sendCommand: async () => ({}) } };
  const e = new Executor(api), task = { id: 't', revoked: false, policy: { activeMode: 'full' } };
  e.tasks.set('t', task); e.leases.set(9, 't');
  e.backgroundRender.sessions.set(9, { strategy: 'screencast' });
  const runtime = new PageRuntime(e);
  runtime.network.observe = () => { throw Error('保活帧不应进入网络观察'); };
  runtime.observe({ tabId: 9 }, 'Page.screencastFrame', { data: 'private frame' });
  assert.equal(task.execution, undefined);
  assert.deepEqual(runtime.pending, []);
});

function fixture() {
  let focused = 1;
  const calls = [], tab = { id: 9, windowId: 2, groupId: 3, url: 'https://example.test/' };
  const api = {
    tabs: {
      get: async () => ({ ...tab }),
      update: async (id, options) => { calls.push(['tab', id, options]); return { ...tab, active: true }; },
    },
    windows: {
      getLastFocused: async () => ({ id: focused, focused: focused !== null }),
      get: async id => ({ id, focused: focused === id }),
      update: async (id, options) => { calls.push(['window', id, options]); focused = id; return { id, focused: true }; },
    },
    debugger: { sendCommand: async () => ({ result: { value: 'visible' } }) },
  };
  return { api, calls, tab, setFocus: id => { focused = id; }, getFocus: () => focused };
}

test('临时置前并回读可见性，再恢复之前的前台窗口', async () => {
  const f = fixture();
  const value = await focusTaskWindow(f.api, 9, 2, () => {}, { holdMs: 0 });
  assert.deepEqual(value, { focused: true, visible: true, previousWindowId: 1, restored: true });
  assert.deepEqual(f.calls, [
    ['tab', 9, { active: true }], ['window', 2, { focused: true }], ['window', 1, { focused: true }],
  ]);
});

test('用户在等待时切走则不抢回焦点', async () => {
  const f = fixture();
  const pending = focusTaskWindow(f.api, 9, 2, () => {}, { holdMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 5));
  f.setFocus(7);
  assert.equal((await pending).restoreReason, 'focus_changed');
  assert.equal(f.getFocus(), 7);
});

test('置前前用户切窗时不覆盖新前台', async () => {
  const f = fixture();
  const original = f.api.tabs.update;
  f.api.tabs.update = async (...args) => { const value = await original(...args); f.setFocus(7); return value; };
  await assert.rejects(focusTaskWindow(f.api, 9, 2, () => {}, { holdMs: 0 }), /FOCUS_WINDOW_CHANGED/);
  assert.equal(f.getFocus(), 7);
  assert.equal(f.calls.filter(row => row[0] === 'window').length, 0);
});

test('无浏览器前台时照常置前并注明原因；无效参数或标签移走时拒绝', async () => {
  const f = fixture();
  for (const opts of [{ holdMs: 15001 }, { restore: 'yes' }])
    await assert.rejects(focusTaskWindow(f.api, 9, 2, () => {}, opts), e => e.preDispatch === true);
  f.setFocus(null);
  const external = await focusTaskWindow(f.api, 9, 2, () => {}, { holdMs: 0 });
  assert.equal(external.restored, false);
  assert.equal(external.restoreReason, 'previous_window_unavailable');
  f.calls.length = 0;
  f.setFocus(1); f.tab.windowId = 7;
  await assert.rejects(focusTaskWindow(f.api, 9, 2, () => {}, {}), /FOCUS_WINDOW_DENIED/);
  assert.deepEqual(f.calls, []);
});

test('恢复关闭时仍回读窗口及文档状态，不恢复前台', async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async () => ({ result: { value: 'hidden' } });
  const value = await focusTaskWindow(f.api, 9, 2, () => {}, { restore: false, holdMs: 0 });
  assert.equal(value.focused, true); assert.equal(value.visible, false);
  assert.equal(f.getFocus(), 2); assert.equal(value.restored, false);
});

test('置前后撤权仍尝试恢复；不能把已置前的失败标为未派发', async () => {
  const f = fixture();
  let revoked = false;
  const pending = focusTaskWindow(f.api, 9, 2, () => {
    if (revoked) throw Error('lease revoked');
  }, { holdMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 5));
  revoked = true;
  await assert.rejects(pending, error => error.message === 'lease revoked' && error.preDispatch !== true);
  assert.equal(f.getFocus(), 1);
});

test('仅独立窗口内任务创建且持租约的页可以置前', async () => {
  const f = fixture(), e = new Executor(f.api);
  const task = { id: 't', instanceId: 'b', agentTabs: new Set([9]),
    agentTabGroups: new Map([[9, 3]]), workspaceCapability: {}, workWindowMode: 'separate' };
  e.workspaces = { authority: { resolve: () => ({ windowId: 2 }) },
    taskWindow: () => ({ windowId: 2 }) };
  e.leases.set(9, 't');
  const guard = () => { if (e.leases.get(9) !== 't') throw Error('lease revoked'); };
  const result = await e.focusWindow(task, { tabId: 9, holdMs: 0 }, guard);
  assert.equal(result.restored, true);
  for (const modified of [{ ...task, silent: true }, { ...task, executionLane: 'product_fill' },
    { ...task, executionLane: 'product_work' }, { ...task, attachment: {} },
    { ...task, workWindowMode: 'current' }, { ...task, agentTabs: new Set() }])
    await assert.rejects(e.focusWindow(modified, { tabId: 9 }, guard), /FOCUS_WINDOW_DENIED/);
  f.tab.groupId = 99;
  await assert.rejects(e.focusWindow(task, { tabId: 9 }, guard), /FOCUS_WINDOW_DENIED/);
});

test('拒绝码经桥接保留已知未派发', () => {
  const e = new Executor({}), b = new Bridge({ postMessage() {}, onMessage: { addListener() {} } }, e);
  for (const reason of ['FOCUS_WINDOW_DENIED', 'FOCUS_RESTORE_UNAVAILABLE', 'FOCUS_WINDOW_BUSY']) {
    const error = b.executionError(Object.assign(Error(reason), { preDispatch: true }),
      { method: 'browser.execute', params: { action: 'focus_window' } });
    assert.equal(error.code, reason.toLowerCase()); assert.equal(error.data.outcomeUnknown, false);
    assert.equal(error.data.retryable, reason === 'FOCUS_WINDOW_BUSY');
  }
});

test('完整执行器路径无需动作审批，并拒绝静默及产品任务', async () => {
  const f = fixture(), e = new Executor(f.api);
  const t = { id: 't', instanceId: 'b', generation: 1, revoked: false,
    policy: { modeGeneration: 1 }, allowedOrigins: ['https://example.test'],
    agentTabs: new Set([9]), agentTabGroups: new Map([[9, 3]]),
    workspaceCapability: {}, workWindowMode: 'separate' };
  e.tasks.set('t', t); e.leases.set(9, 't'); e.attached.add(9);
  e.ensurePageEvents = async () => {};
  e.workspaces = { authority: { resolve: () => ({ windowId: 2 }) },
    taskWindow: () => ({ windowId: 2 }) };
  const result = await e.perform(t, { action: 'focus_window', taskId: 't', tabId: 9, generation: 1, holdMs: 0 });
  assert.equal(result.visible, true);
  for (const mode of [{ silent: true }, { executionLane: 'product_fill' }, { executionLane: 'product_work' }]) {
    Object.assign(t, { silent: false, executionLane: 'default' }, mode);
    await assert.rejects(e.execute({ action: 'focus_window', taskId: 't', tabId: 9, generation: 1 }), error => error.message === 'FOCUS_WINDOW_DENIED' && error.preDispatch);
  }
});

test('并发置前立即拒绝，不会在等待动作完成后迟到执行', async () => {
  const f = fixture(), e = new Executor(f.api);
  const task = { id: 't', instanceId: 'b', agentTabs: new Set([9]),
    agentTabGroups: new Map([[9, 3]]), workspaceCapability: {}, workWindowMode: 'separate' };
  e.workspaces = { authority: { resolve: () => ({ windowId: 2 }) },
    taskWindow: () => ({ windowId: 2 }) };
  const pending = e.focusWindow(task, { tabId: 9, holdMs: 30 }, () => {});
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(e.focusWindow(task, { tabId: 9, holdMs: 0 }, () => {}),
    error => error.message === 'FOCUS_WINDOW_BUSY' && error.preDispatch === true);
  await pending;
  assert.equal(f.calls.filter(row => row[0] === 'window' && row[1] === 2).length, 1);
});

test('延迟租约进入失败时恢复浏览器前台窗口', async () => {
  const f = fixture();
  f.api.debugger.sendCommand = async () => { throw Error('read failed'); };
  await assert.rejects(focusTaskWindow(f.api, 9, 2, () => {}, { restore: false, restoreOnFailure: true, holdMs: 0 }), /read failed/);
  assert.equal(f.getFocus(), 1);
});
