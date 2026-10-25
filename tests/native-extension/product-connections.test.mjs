import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductConnections } from '../../native-extension/product-connections.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

test('并发配对必须保留全部登记，不能留下登记之外的活跃Port', async () => {
  const { connections, stored, calls } = fixture();
  const secondId = 'p'.repeat(32);
  connections.api.runtime.connect = (id, options) => {
    const port = {
      onMessage: signal(),
      onDisconnect: signal(),
      postMessage() {},
      disconnect() {
        this.onDisconnect.fire();
      },
    };
    calls.push({ id, options });
    return port;
  };
  await Promise.all([connections.pair(extensionId), connections.pair(secondId)]);
  assert.deepEqual(stored.productConnections, [extensionId, secondId]);
  assert.deepEqual([...connections.connections.keys()], stored.productConnections);
  assert.notEqual(
    connections.connections.get(extensionId).port,
    connections.connections.get(secondId).port,
  );
  assert.equal(calls.filter((row) => row.options).length, 2);
});

test('并发配对在最新登记上核容量，最多创建四个Port', async () => {
  const { connections, stored, calls } = fixture();
  const ids = ['a', 'b', 'c', 'd', 'e'].map((letter) => letter.repeat(32));
  const results = await Promise.allSettled(ids.map((id) => connections.pair(id)));
  assert.deepEqual(
    results.map((row) => row.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected'],
  );
  assert.equal(results[4].reason.code, 'PRODUCT_CAPACITY');
  assert.deepEqual(stored.productConnections, ids.slice(0, 4));
  assert.deepEqual([...connections.connections.keys()], stored.productConnections);
  assert.equal(calls.filter((row) => row.options).length, 4);
});

test('解除配对与另一产品配对不能用旧登记互相覆盖', async () => {
  const { connections, stored } = fixture();
  const secondId = 'p'.repeat(32);
  connections.api.runtime.connect = () => ({
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage() {},
    disconnect() {
      this.onDisconnect.fire();
    },
  });
  await connections.pair(extensionId);
  await Promise.all([connections.unpair(extensionId), connections.pair(secondId)]);
  assert.deepEqual(stored.productConnections, [secondId]);
  assert.deepEqual([...connections.connections.keys()], [secondId]);
});

test('配对未落盘时解除同一产品必须等待登记与Port创建后再完整撤销', async () => {
  const { connections, stored } = fixture();
  const original = connections.api.storage.local.set;
  let entered;
  let finish;
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });
  connections.api.storage.local.set = async (values) => {
    entered();
    await barrier;
    return original(values);
  };
  const paired = connections.pair(extensionId);
  await writing;
  const unpaired = connections.unpair(extensionId);
  finish();
  await Promise.all([paired, unpaired]);
  assert.deepEqual(stored.productConnections, []);
  assert.equal(connections.connections.size, 0);
});

test('恢复登记与解除配对共用事务，迟到恢复不能创建不可见Port', async () => {
  const { connections, stored } = fixture();
  stored.productConnections = [extensionId];
  const get = connections.api.storage.local.get;
  let entered;
  let finish;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });
  connections.api.storage.local.get = async (key) => {
    const snapshot = structuredClone(await get(key));
    entered();
    await barrier;
    return snapshot;
  };
  const restored = connections.restore();
  await reading;
  const unpaired = connections.unpair(extensionId);
  finish();
  await Promise.all([restored, unpaired]);
  assert.deepEqual(stored.productConnections, []);
  assert.equal(connections.connections.size, 0);
});

test('登记写入失败不创建Port且队列允许后续配对', async () => {
  const { connections, calls, stored } = fixture();
  const set = connections.api.storage.local.set;
  connections.api.storage.local.set = async () => {
    throw Error('storage unavailable');
  };
  await assert.rejects(connections.pair(extensionId), /storage unavailable/);
  assert.equal(calls.length, 0);
  connections.api.storage.local.set = set;
  await connections.pair(extensionId);
  assert.deepEqual(stored.productConnections, [extensionId]);
  assert.equal(connections.connections.size, 1);
});

test('解除配对未确认时不能重新连接洗掉旧页面资格', async () => {
  const { connections, port, calls, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'attach',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  connections.bridge().request = async () => {
    throw Error('lost receipt');
  };
  await assert.rejects(connections.unpair(extensionId));
  await assert.rejects(connections.pair(extensionId), /PRODUCT_REVOCATION_UNKNOWN/);
  assert.deepEqual(stored.productConnections, [extensionId]);
  assert.equal(calls.filter((row) => row.options).length, 1);
});

test('解除配对先停止Port准入再等待原页释放，未知时保留登记供核实', async () => {
  const { connections, port, posts, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'attach',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  const bridge = connections.bridge();
  let finish;
  bridge.request = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const closing = connections.unpair(extensionId);
  await Promise.resolve();
  const count = posts.length;
  await port.onMessage.fire({
    id: 'new-run',
    operation: 'run',
    params: { pageHandle: 'private-page', requestId: 'r', command: { operation: 'observe' } },
  });
  assert.equal(posts.length, count);
  assert.deepEqual(stored.productConnections, [extensionId]);
  finish({ state: 'closed', cleanupState: 'succeeded' });
  await closing;
  assert.deepEqual(stored.productConnections, []);
});
function signal() {
  const handlers = [];
  return {
    addListener(fn) {
      handlers.push(fn);
    },
    fire(value) {
      return Promise.all(handlers.map((fn) => fn(value)));
    },
  };
}
function fixture() {
  const stored = {},
    posts = [],
    calls = [];
  const port = {
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage: (message) => posts.push(message),
    disconnect() {
      this.onDisconnect.fire();
    },
  };
  const api = {
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (values) => Object.assign(stored, values),
      },
    },
    runtime: {
      connect: (id, options) => {
        calls.push({ id, options });
        return port;
      },
    },
  };
  const bridge = {
    request: async (method, params) => {
      calls.push({ method, params });
      return method === 'extension.product.attach'
        ? { pageHandle: 'private-page', taskId: 'task', state: 'ready', tabId: 17 }
        : { confirmed: true };
    },
  };
  const connections = new ProductConnections(
    api,
    () => bridge,
    async () => true,
  );
  const ready = () => port.onMessage.fire({ type: 'fbl.product.ready', protocolVersion: 1 });
  return { connections, port, posts, calls, stored, ready };
}

test('解除配对必须等在途attach结算并读回其页面释放', async () => {
  const { connections, port, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  let deliver;
  const closed = [];
  connections.bridge().request = async (method, params) => {
    if (method === 'extension.product.attach')
      return new Promise((resolve) => {
        deliver = resolve;
      });
    closed.push(params.pageHandle);
    return { state: 'closed', cleanupState: 'succeeded' };
  };
  const attached = port.onMessage.fire({
    id: 'attach',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  await Promise.resolve();
  let finished = false;
  const unpaired = connections.unpair(extensionId).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(stored.productConnections, [extensionId]);
  deliver({ pageHandle: 'late-page', taskId: 'task', state: 'ready' });
  await Promise.all([attached, unpaired]);
  assert.deepEqual(closed, ['late-page']);
  assert.deepEqual(stored.productConnections, []);
});

test('客户端close回执未知仍保留页面，不能借此绕过解除配对屏障', async () => {
  const { connections, port, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'attach',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  connections.bridge().request = async () => ({ state: 'closed', cleanupState: 'unknown' });
  await port.onMessage.fire({
    id: 'close',
    operation: 'close',
    params: { pageHandle: 'private-page' },
  });
  await assert.rejects(connections.unpair(extensionId), /PRODUCT_REVOCATION_UNKNOWN/);
  assert.deepEqual(stored.productConnections, [extensionId]);
});

test('终态但清理未知不能当作解除配对已确认', async () => {
  const { connections, port, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'attach',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  connections.bridge().request = async () => ({ state: 'closed', cleanupState: 'unknown' });
  await assert.rejects(connections.unpair(extensionId), /PRODUCT_REVOCATION_UNKNOWN/);
  assert.deepEqual(stored.productConnections, [extensionId]);
});

test('同一Native页面句柄不能被第二个配对产品借attach取得', async () => {
  const { connections, port, posts, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'first',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  const secondPosts = [];
  const second = {
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage: (message) => secondPosts.push(message),
    disconnect() {},
  };
  connections.api.runtime.connect = () => second;
  await connections.pair('p'.repeat(32));
  await second.onMessage.fire({ type: 'fbl.product.ready', protocolVersion: 1 });
  await second.onMessage.fire({
    id: 'second',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  assert.equal(posts.at(-1).result.pageHandle, 'private-page');
  assert.equal(secondPosts.at(-1).result, undefined);
  await second.onMessage.fire({
    id: 'foreign',
    operation: 'run',
    params: {
      pageHandle: 'private-page',
      requestId: 'r',
      command: { operation: 'revoke', reason: 'foreign' },
    },
  });
  assert.equal(secondPosts.at(-1).error.code, 'PRODUCT_PAGE_UNAVAILABLE');
});

test('Port创建不证明已连接，实际协议握手后才发布connected', async () => {
  const { connections, port } = fixture();
  await connections.pair(extensionId);
  assert.equal((await connections.status())[0].connected, false);
  await port.onMessage.fire({ type: 'fbl.product.ready', protocolVersion: 1 });
  assert.equal((await connections.status())[0].connected, true);
});

test('配对消息只接受本扩展实际设置页，普通content sender不能伪装', async () => {
  const { connections, calls } = fixture();
  connections.api.runtime.id = 'self';
  connections.api.tabs = { get: async () => ({ url: 'https://example.test/' }) };
  const message = { type: 'product_pair', extensionId };
  for (const sender of [
    { id: 'foreign', url: 'chrome-extension://self/product-connections.html' },
    { id: 'self', url: 'https://example.test/' },
    { id: 'self', url: 'chrome-extension://self/product-connections.html', tab: { id: 17 } },
  ])
    await assert.rejects(connections.handleUi(message, sender), /PRODUCT_UNTRUSTED_UI/);
  assert.equal(calls.length, 0);
  await connections.handleUi(message, {
    id: 'self',
    url: 'chrome-extension://self/product-connections.html',
  });
  assert.equal(calls[0].id, extensionId);
});

test('只对可信界面显式登记的精确ID主动建Port，不改变扩展身份', async () => {
  const { connections, calls, stored } = fixture();
  await assert.rejects(connections.pair('anything'), /PRODUCT_INVALID_ID/);
  assert.equal(calls.length, 0);
  await connections.pair(extensionId);
  assert.deepEqual(stored.productConnections, [extensionId]);
  assert.deepEqual(calls[0], { id: extensionId, options: { name: 'fbl.product.v1' } });
});

test('Port只能转发自己获取的pageHandle且不能指定owner或执行通用动作', async () => {
  const { connections, port, calls, posts, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({ id: 'get-1', operation: 'get', params: { pageHandle: 'foreign' } });
  assert.equal(posts.at(-1).error.code, 'PRODUCT_PAGE_UNAVAILABLE');
  await port.onMessage.fire({
    id: 'attach-1',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  assert.equal(posts.at(-1).result.pageHandle, 'private-page');
  await port.onMessage.fire({
    id: 'run-1',
    operation: 'run',
    params: {
      pageHandle: 'private-page',
      requestId: 'r1',
      command: { operation: 'observe' },
      owner: 'forged',
    },
  });
  assert.equal(posts.at(-1).error.code, 'PRODUCT_INVALID_REQUEST');
  await port.onMessage.fire({
    id: 'run-2',
    operation: 'run',
    params: { pageHandle: 'private-page', requestId: 'r2', command: { operation: 'observe' } },
  });
  assert.equal(calls.at(-1).method, 'extension.product.run');
  assert.deepEqual(calls.at(-1).params.command, { operation: 'observe' });
});

test('断开立即撤销该Port，旧异步回执不能恢复页面资格或发送成功', async () => {
  const { connections, port, calls, posts, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  let resolve;
  const bridge = connections.bridge();
  bridge.request = async (method) => {
    calls.push({ method });
    return new Promise((done) => {
      resolve = done;
    });
  };
  const work = port.onMessage.fire({
    id: 'attach-1',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  await Promise.resolve();
  const count = posts.length;
  await port.onDisconnect.fire();
  resolve({ pageHandle: 'late-page', taskId: 'task', state: 'ready' });
  await work;
  assert.equal(posts.length, count);
  assert.equal((await connections.status())[0].connected, false);
});

test('attach回执丢失不能把空页面集合当清理成功并重新配对', async () => {
  const { connections, port, stored, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  connections.bridge().request = async () => {
    throw Error('lost attach receipt');
  };
  await port.onMessage.fire({
    id: 'lost',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  await assert.rejects(connections.unpair(extensionId), /PRODUCT_REVOCATION_UNKNOWN/);
  await assert.rejects(connections.pair(extensionId), /PRODUCT_REVOCATION_UNKNOWN/);
  assert.deepEqual(stored.productConnections, [extensionId]);
});

test('未知写入不重发且错误正文不暴露', async () => {
  const { connections, port, calls, posts, ready } = fixture();
  await connections.pair(extensionId);
  await ready();
  await port.onMessage.fire({
    id: 'attach-1',
    operation: 'attach',
    params: { url: 'https://example.test/form' },
  });
  const bridge = connections.bridge();
  bridge.request = async (method) => {
    calls.push({ method });
    throw Error('private secret response');
  };
  await port.onMessage.fire({
    id: 'run-1',
    operation: 'run',
    params: {
      pageHandle: 'private-page',
      requestId: 'r1',
      command: { operation: 'commit', grantHandle: 'grant' },
    },
  });
  assert.equal(posts.at(-1).error.code, 'PRODUCT_OUTCOME_UNKNOWN');
  assert.equal(posts.at(-1).error.retryable, false);
  assert.doesNotMatch(JSON.stringify(posts), /private secret/);
  assert.equal(calls.filter((row) => row.method === 'extension.product.run').length, 1);
});
