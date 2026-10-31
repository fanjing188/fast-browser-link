import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistConnections } from '../../native-extension/assist-connections.mjs';

const id = 'a'.repeat(32);
const signal = () => {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    async fire(message) {
      await Promise.all(listeners.map((fn) => fn(message)));
    },
  };
};
function fixture() {
  const saved = {},
    posts = [],
    calls = [];
  const port = {
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage(value) {
      posts.push(value);
    },
    disconnect() {},
  };
  const api = {
    runtime: {
      id: 'b'.repeat(32),
      connect(target, options) {
        calls.push({ target, options });
        return port;
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(saved[key]) };
        },
        async set(value) {
          Object.assign(saved, structuredClone(value));
        },
      },
    },
  };
  let permitted = true;
  const dispatch = async (session, operation, params) => {
    calls.push({ session, operation, params });
    return { value: operation };
  };
  const manager = new AssistConnections(api, dispatch, async () => permitted);
  return {
    manager,
    port,
    posts,
    calls,
    saved,
    deny() {
      permitted = false;
    },
  };
}

test('cleanup stays available after ordinary session request capacity without replay', async () => {
  const f = fixture();
  await f.manager.pair(id);
  await f.port.onMessage.fire({
    type: 'fbl.assist.ready',
    protocolVersion: 1,
    capabilities: ['assist.work.v1'],
  });
  const state = f.manager.connections.get(id);
  for (let i = 0; i < 1024; i++) state.seen.add('read-' + i);
  const close = {
    id: 'cleanup',
    operation: 'work.close',
    params: { workHandle: 'owned', requestId: 'close-once' },
  };
  await f.port.onMessage.fire(close);
  await f.port.onMessage.fire(close);
  await f.port.onMessage.fire({
    id: 'revoke',
    operation: 'work.resource_revoke',
    params: { resourceHandle: 'resource' },
  });
  assert.equal(f.calls.filter((row) => row.operation === 'work.close').length, 1);
  assert.equal(f.calls.filter((row) => row.operation === 'work.resource_revoke').length, 1);
  await f.port.onMessage.fire({
    id: 'new-work',
    operation: 'work.open',
    params: { url: 'https://fixture.test/', incognito: false },
  });
  assert.equal(f.posts.at(-1).error.code, 'ASSIST_CAPACITY');
});

test('Assist pairs only an exact user-registered extension and uses a separate protocol', async () => {
  const f = fixture();
  await f.manager.pair(id);
  assert.deepEqual(f.saved.assistConnections, [id]);
  assert.deepEqual(f.calls[0], { target: id, options: { name: 'fbl.assist.v1' } });
  for (const invalid of ['x'.repeat(32), ' ' + id, id.toUpperCase()])
    await assert.rejects(f.manager.pair(invalid));
});

test('unnegotiated capabilities, functions and arbitrary CDP are not dispatched', async () => {
  const f = fixture();
  await f.manager.pair(id);
  await f.port.onMessage.fire({ id: 'early', operation: 'observation.select_current', params: {} });
  assert.equal(f.calls.filter((row) => row.operation).length, 0);
  await f.port.onMessage.fire({
    type: 'fbl.assist.ready',
    protocolVersion: 1,
    capabilities: ['assist.observation.v1'],
  });
  for (const operation of [
    'work.open',
    'Runtime.evaluate',
    'script',
    'observation.capture_material',
  ]) {
    await f.port.onMessage.fire({
      id: operation,
      operation,
      params: { expression: 'evil()', func: 'evil()', tabId: 7 },
    });
  }
  assert.equal(f.calls.filter((row) => row.operation).length, 0);
  await f.port.onMessage.fire({ id: 'read', operation: 'observation.select_current', params: {} });
  assert.equal(f.calls.filter((row) => row.operation).length, 1);
});

test('unknown writes and duplicate IDs never redispatch and preserve failed revocation', async () => {
  const f = fixture();
  await f.manager.pair(id);
  await f.port.onMessage.fire({
    type: 'fbl.assist.ready',
    protocolVersion: 1,
    capabilities: ['assist.work.v1'],
  });
  const message = {
    id: 'write',
    operation: 'work.click',
    params: { workHandle: 'owned', selector: 'button', requestId: 'once' },
  };
  await f.port.onMessage.fire(message);
  await f.port.onMessage.fire(message);
  assert.equal(f.calls.filter((row) => row.operation === 'work.click').length, 1);
  f.manager.revoke = async () => {
    throw Error('unknown');
  };
  await assert.rejects(f.manager.unpair(id));
  assert.deepEqual(f.saved.assistConnections, [id]);
  await f.port.onMessage.fire({ ...message, id: 'late' });
  assert.equal(f.calls.filter((row) => row.operation === 'work.click').length, 1);
});

test('consent rejection and stale Port do not acquire execution eligibility', async () => {
  const f = fixture();
  await f.manager.pair(id);
  await f.port.onMessage.fire({
    type: 'fbl.assist.ready',
    protocolVersion: 1,
    capabilities: ['assist.observation.v1'],
  });
  f.deny();
  await f.port.onMessage.fire({ id: 'read', operation: 'observation.select_current', params: {} });
  assert.equal(f.calls.filter((row) => row.operation).length, 0);
  assert.equal(f.posts.at(-1).error.retryable, false);
});

test('malformed fixed-operation values never reach a dispatcher', async () => {
  const f = fixture();
  await f.manager.pair(id);
  await f.port.onMessage.fire({
    type: 'fbl.assist.ready',
    protocolVersion: 1,
    capabilities: ['assist.work.v1', 'assist.observation.v1'],
  });
  for (const [operation, params] of [
    ['work.open', { url: 'https://fixture.test/', incognito: 'false' }],
    [
      'work.fill',
      { workHandle: 'work', selector: 'input', text: { bad: true }, requestId: 'once' },
    ],
    ['observation.capture_material', { pageHandle: 'page', mode: 'script' }],
    ['observation.capture_tables', { pageHandle: 'page', minimumRows: 0 }],
  ])
    await f.port.onMessage.fire({ id: operation, operation, params });
  assert.equal(f.calls.filter((row) => row.operation).length, 0);
});
