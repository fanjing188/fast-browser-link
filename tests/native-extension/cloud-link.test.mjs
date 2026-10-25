import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 中文注释：保留已登记 runner，以真实后台启动/重连证明移除连接，而非只隐藏入口。
test('extension runtime never opens the removed cloud Native channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hosts = [],
    alarms = [],
    data = {},
    noop = { addListener() {} };
  let listener;
  const api = {
    notifications: { onClicked: noop },
    storage: {
      local: {
        get: async (key) => ({ [key]: data[key] }),
        set: async (v) => Object.assign(data, v),
      },
      session: {
        get: async (key) => ({ [key]: data[key] }),
        set: async (v) => Object.assign(data, v),
      },
    },
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '0.0.0' }),
      sendMessage: async () => {},
      onMessage: { addListener: (fn) => (listener = fn) },
      connectNative: (host) => {
        hosts.push(host);
        throw Error('synthetic offline host');
      },
    },
    alarms: { create() {}, onAlarm: { addListener: (fn) => alarms.push(fn) } },
    windows: { onFocusChanged: noop },
    tabs: {
      onCreated: noop,
      onRemoved: noop,
      onUpdated: noop,
      create: async () => assert.fail('removed cloud messages cannot open tabs'),
    },
    debugger: { onDetach: noop },
  };
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const previous = globalThis.chrome;
  globalThis.chrome = api;
  try {
    await import('../../native-extension/background.mjs');
    await flush();
    assert.deepEqual(hosts, ['com.fast.browser_link']);
    assert.equal(alarms.length, 1);
    await alarms[0]();
    await flush();
    assert.deepEqual(hosts, ['com.fast.browser_link', 'com.fast.browser_link']);
    const rpc = (message) =>
      new Promise((resolve) => {
        assert.equal(
          listener(message, { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve),
          true,
        );
      });
    assert.equal((await rpc({ type: 'connect' })).result.connected, false);
    assert.deepEqual(hosts, Array(3).fill('com.fast.browser_link'));
    assert.equal(Object.hasOwn((await rpc({ type: 'popup_status' })).result, 'cloud'), false);
    const before = [...hosts];
    for (const type of [
      'cloud_connect',
      'cloud_disconnect',
      'cloud_open_web',
      'cloud_full_access',
    ]) {
      const response = await rpc({ type });
      assert.ok(response.error, type);
      assert.equal(Object.hasOwn(response, 'result'), false, type);
    }
    assert.deepEqual(hosts, before);
    t.mock.timers.tick(60000);
    await flush();
    assert.deepEqual(hosts, before);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test('popup and background source no longer load or advertise cloud runtime', async () => {
  for (const file of ['popup.html', 'popup.mjs', 'popup.css', 'background.mjs']) {
    const source = await readFile(
      new URL('../../native-extension/' + file, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /cloud|CloudLink|云端/, file);
  }
});
