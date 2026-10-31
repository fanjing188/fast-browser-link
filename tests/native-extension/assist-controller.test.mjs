import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistController } from '../../native-extension/assist-controller.mjs';

function fixture() {
  const calls = [];
  const observation = {
    select: async () => ({ pageHandle: 'page' }),
    capture: async () => ({ text: 'material' }),
    tables: async () => ({ tables: [] }),
    beginConfirmation: async () => ({ confirmationHandle: 'confirmation' }),
    controlConfirmation: async () => ({ confirmed: true }),
    revoke() {},
  };
  let ready = false;
  const bridge = {
    async request(method, params) {
      calls.push({ method, params });
      if (method.endsWith('.open'))
        return { workHandle: 'work', taskId: 'task', state: 'authorizing' };
      if (method.endsWith('.get'))
        return { workHandle: 'work', taskId: 'task', state: ready ? 'ready' : 'authorizing' };
      if (method.endsWith('.session_close')) return { closed: true };
      return { done: true };
    },
  };
  const consent = {
    async synchronize() {
      ready = true;
    },
  };
  return {
    controller: new AssistController(observation, () => bridge, consent),
    calls,
    session: Object.freeze({ productId: 'a'.repeat(32), session: 'port' }),
  };
}

test('named observation does not start native work or expose caller tab IDs', async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.dispatch(f.session, 'observation.select_current', {}), {
    pageHandle: 'page',
  });
  assert.equal(f.calls.length, 0);
});

test('work creation synchronizes actual FBL consent then reads ready state', async () => {
  const f = fixture();
  const result = await f.controller.dispatch(f.session, 'work.open', {
    url: 'https://fixture.test/',
    incognito: false,
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(
    f.calls.map((row) => row.method),
    ['extension.assist.work.open', 'extension.assist.work.get'],
  );
  assert.equal(f.calls[0].params.productId, f.session.productId);
  assert.equal(f.calls[0].params.session, 'port');
});

test('work commands retain one request ID and cannot become raw CDP calls', async () => {
  const f = fixture();
  await f.controller.dispatch(f.session, 'work.click', {
    workHandle: 'work',
    selector: 'button',
    requestId: 'once',
  });
  const request = f.calls[0];
  assert.equal(request.method, 'extension.assist.work.run');
  assert.deepEqual(request.params, {
    ...f.session,
    workHandle: 'work',
    requestId: 'once',
    operation: 'click',
    arguments: { selector: 'button' },
  });
  await assert.rejects(
    f.controller.dispatch(f.session, 'Runtime.evaluate', { expression: 'evil()' }),
  );
});

test('session shutdown revokes local observations before waiting for native cleanup', async () => {
  const f = fixture();
  let revoked = false;
  f.controller.observation.revoke = () => {
    revoked = true;
  };
  const bridge = f.controller.bridge();
  bridge.request = async (method) => {
    assert.equal(revoked, true);
    assert.equal(method, 'extension.assist.work.session_close');
    return { closed: true };
  };
  assert.deepEqual(await f.controller.revoke(f.session), { closed: true });
});
