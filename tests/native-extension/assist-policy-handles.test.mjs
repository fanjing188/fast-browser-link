import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistController } from '../../native-extension/assist-controller.mjs';
test('resource policy issues work-bound report/query handles and resolves frozen declarations', async () => {
  const calls = [];
  const bridge = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method.endsWith('resource_bind')) return { resourceHandle: 'r' };
      if (method.endsWith('.open') || method.endsWith('.get'))
        return { workHandle: 'w', state: 'ready' };
      return { ok: true, value: { ready: true } };
    },
  };
  const c = new AssistController({}, () => bridge, { synchronize: async () => {} });
  const session = Object.freeze({ productId: 'a'.repeat(32), session: 'p' });
  await c.dispatch(session, 'work.resource_bind', {
    resourceId: 'source',
    epoch: 1,
    lane: 'lane',
    hosts: ['fixture.test'],
    policy: {
      ready_selectors: ['table'],
      stop_text: { quota: ['exhausted'] },
      query: { root: 'main', names: ['Search'] },
    },
  });
  const opened = await c.dispatch(session, 'work.open', {
    url: 'https://fixture.test/',
    incognito: false,
    resourceHandle: 'r',
  });
  assert.ok(opened.policyHandles?.report);
  assert.ok(opened.queryHandle);
  await c.dispatch(session, 'work.report_inspect', {
    workHandle: 'w',
    policyHandle: opened.policyHandles.report,
  });
  assert.deepEqual(calls.at(-1).params.arguments, {
    ready_selectors: ['table'],
    stop_text: { quota: ['exhausted'] },
  });
  await c.dispatch(session, 'work.report_inspect', {
    workHandle: 'w',
    policyHandle: opened.policyHandles.report,
    phase: 'query',
  });
  assert.deepEqual(calls.at(-1).params.arguments, {
    ready_selectors: ['main'],
    stop_text: { quota: ['exhausted'] },
  });
  await c.dispatch(session, 'work.query_submit', {
    workHandle: 'w',
    queryHandle: opened.queryHandle,
    requestId: 'once',
  });
  assert.deepEqual(calls.at(-1).params.arguments, { root: 'main', names: ['Search'] });
  await assert.rejects(
    c.dispatch({ ...session, session: 'other' }, 'work.query_submit', {
      workHandle: 'w',
      queryHandle: opened.queryHandle,
      requestId: 'bad',
    }),
  );
});
