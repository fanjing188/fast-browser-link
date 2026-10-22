import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspectControls, fillControls, VaultController } from '../../native-extension/vault.mjs';
import { Executor } from '../../native-extension/core.mjs';
import { PageRuntime } from '../../native-extension/page-runtime.mjs';

function attachedVaultFixture() {
  const dom = new JSDOM('<input type="password" autocomplete="current-password">', {
    url: 'https://example.test/login',
    runScripts: 'outside-only',
  });
  dom.window.document.querySelector('input').getClientRects = () => [{ width: 100, height: 20 }];
  // 中文注释：使用扩展真实 attachment/tabIds 合同，不虚构 attachedTabs 属性。
  const task = {
    id: 'task',
    instanceId: 'browser',
    generation: 3,
    policy: { modeGeneration: 2, activeMode: 'full' },
    allowedOrigins: ['https://example.test'],
    attachment: { tabId: 7, url: 'https://example.test/login' },
    tabIds: new Set([7]),
    agentTabs: new Set(),
  };
  const sent = [];
  const executor = Object.assign(Object.create(Executor.prototype), {
    tasks: new Map([['task', task]]),
    leases: new Map([[7, 'task']]),
    attached: new Set([7]),
    docs: new Map([[7, 4]]),
    tabQueues: new Map(),
    ensureOverlay: async () => ({ contextId: 42 }),
    api: {
      tabs: { get: async () => ({ id: 7, url: task.attachment.url }) },
      debugger: {
        sendCommand: async (target, method, params) => {
          sent.push({ target, method, contextId: params.executionContextId });
          const fn = dom.window.eval(`(${params.functionDeclaration})`);
          return { result: { value: fn(...params.arguments.map(({ value }) => value)) } };
        },
      },
    },
  });
  const payload = {
    taskId: 'task',
    instanceId: 'browser',
    generation: 3,
    modeGeneration: 2,
    tabId: 7,
    nonce: 'a'.repeat(48),
    documentGeneration: 4,
    expectedOrigin: 'https://example.test',
    kind: 'login',
    fills: [{ index: 0, token: 'current-password', value: 'SyntheticSecret!' }],
  };
  return { dom, task, sent, executor, payload, vault: new VaultController(executor) };
}

test('attached Vault page inspects and fills without acquiring creation ownership', async (t) => {
  const f = attachedVaultFixture();
  t.after(() => f.dom.window.close());
  const inspected = await f.vault.inspect(f.payload);
  assert.equal(inspected.controls.length, 1);
  assert.equal(inspected.documentGeneration, 4);
  assert.deepEqual(await f.vault.fill(f.payload), { filled: 1 });
  assert.equal(f.dom.window.document.querySelector('input').value, 'SyntheticSecret!');
  assert.equal(f.task.agentTabs.size, 0);
  assert.deepEqual([...f.task.credentialTabs], [7]);
  assert.deepEqual(await f.vault.fill(f.payload), { filled: 0, refused: 'inspection_stale' });
});

test('attached Vault scope is rechecked after asynchronous tab lookup', async (t) => {
  for (const [name, change] of [
    [
      'attachment',
      (f) => {
        delete f.task.attachment;
      },
    ],
    ['tabIds', (f) => f.task.tabIds.clear()],
    [
      'instance',
      (f) => {
        f.task.instanceId = 'other';
      },
    ],
    ['lease', (f) => f.executor.leases.delete(7)],
    ['generation', (f) => f.task.generation++],
    ['mode', (f) => f.task.policy.modeGeneration++],
    [
      'script',
      (f) => {
        f.task.scriptedTabs = new Set([7]);
      },
    ],
    [
      'revoked',
      (f) => {
        f.task.revoked = true;
      },
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = attachedVaultFixture();
      t.after(() => f.dom.window.close());
      f.executor.api.tabs.get = async () => {
        change(f);
        return { id: 7, url: 'https://example.test/login' };
      };
      await assert.rejects(f.vault.inspect(f.payload), /VAULT_SCOPE_CHANGED|stale generation/);
      assert.deepEqual(f.sent, []);
    });
  }
});

test('attached Vault revocation during overlay preparation prevents credential dispatch', async (t) => {
  const f = attachedVaultFixture();
  t.after(() => f.dom.window.close());
  await f.vault.inspect(f.payload);
  f.sent.length = 0;
  f.executor.ensureOverlay = async () => {
    f.task.tabIds.clear();
    return { contextId: 42 };
  };
  await assert.rejects(f.vault.fill(f.payload), /VAULT_SCOPE_CHANGED/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.dom.window.document.querySelector('input').value, '');
});

test('attached Vault refuses missing leases, stale identity and scripts before dispatch', async (t) => {
  for (const [name, change] of [
    ['missing lease', (f) => f.executor.leases.clear()],
    ['foreign lease', (f) => f.executor.leases.set(7, 'other')],
    ['generation', (f) => f.payload.generation++],
    ['mode', (f) => f.payload.modeGeneration++],
    [
      'instance',
      (f) => {
        f.payload.instanceId = 'other';
      },
    ],
    [
      'attachment',
      (f) => {
        f.task.attachment.tabId = 8;
      },
    ],
    ['live tabs', (f) => f.task.tabIds.clear()],
    ['script', (f) => new PageRuntime(f.executor).assert(f.task, f.payload)],
    [
      'revoked',
      (f) => {
        f.task.revoked = true;
      },
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = attachedVaultFixture();
      t.after(() => f.dom.window.close());
      change(f);
      await assert.rejects(
        f.vault.inspect(f.payload),
        /tab lease denied|stale generation|VAULT_SCOPE_CHANGED|CREDENTIAL_MODE_CONFLICT/,
      );
      assert.deepEqual(f.sent, []);
    });
  }
});

test('credential-filled attached page blocks subsequent arbitrary scripts', async (t) => {
  const f = attachedVaultFixture();
  t.after(() => f.dom.window.close());
  await f.vault.inspect(f.payload);
  assert.deepEqual(await f.vault.fill(f.payload), { filled: 1 });
  assert.throws(
    () => new PageRuntime(f.executor).assert(f.task, f.payload),
    /CREDENTIAL_MODE_CONFLICT/,
  );
  assert.equal(f.task.agentTabs.size, 0);
});

test('Vault 检查只返回控件元信息，填写要求同一 nonce、来源和字段类型', () => {
  const dom = new JSDOM(
    '<form><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><input id="otp" autocomplete="one-time-code"></form>',
    { url: 'https://example.test/login' },
  );
  const names = [
    'document',
    'location',
    'HTMLInputElement',
    'InputEvent',
    'Event',
    'getComputedStyle',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  try {
    // 中文注释：jsdom 不计算布局，这里只模拟两个可见的真实输入框。
    for (const element of dom.window.document.querySelectorAll('input'))
      element.getClientRects = () => [{ width: 100, height: 20 }];
    const password = dom.window.document.getElementById('password');
    const otp = dom.window.document.getElementById('otp');
    const events = [];
    password.addEventListener('input', () => events.push('input'));
    const inspected = inspectControls('a'.repeat(48));
    assert.equal(inspected.origin, 'https://example.test');
    assert.equal(inspected.controls.length, 2);
    assert.equal(JSON.stringify(inspected).includes('SyntheticSecret!'), false);
    assert.deepEqual(
      fillControls('b'.repeat(48), 'https://example.test', [
        { index: 0, token: 'current-password', value: 'SyntheticSecret!' },
      ]),
      { refused: 'inspection_stale' },
    );
    assert.deepEqual(
      fillControls('a'.repeat(48), 'https://other.test', [
        { index: 0, token: 'current-password', value: 'SyntheticSecret!' },
      ]),
      { refused: 'origin_changed' },
    );
    assert.deepEqual(
      fillControls('a'.repeat(48), 'https://example.test', [
        { index: 1, token: 'current-password', value: 'SyntheticSecret!' },
      ]),
      { refused: 'inspection_stale' },
    );
    assert.equal(password.value, '');
    assert.deepEqual(
      fillControls('a'.repeat(48), 'https://example.test', [
        { index: 0, token: 'current-password', value: 'SyntheticSecret!' },
        { index: 1, token: 'one-time-code', value: '123456' },
      ]),
      { filled: 2 },
    );
    assert.equal(password.value, 'SyntheticSecret!');
    assert.equal(otp.value, '123456');
    assert.deepEqual(events, ['input']);
    assert.deepEqual(
      fillControls('a'.repeat(48), 'https://example.test', [
        { index: 0, token: 'current-password', value: 'NewSecret' },
      ]),
      { refused: 'inspection_stale' },
    );
  } finally {
    for (const name of names)
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    dom.window.close();
  }
});

test('Vault 检查后字段被禁用、只读、隐藏或改成新密码时拒绝填写', () => {
  // 中文注释：两阶段检查之间页面可改变字段；旧 nonce 不能绕过当前可填写性。
  const dom = new JSDOM('<input id="password" type="password" autocomplete="current-password">', {
    url: 'https://example.test/login',
  });
  const names = [
    'document',
    'location',
    'HTMLInputElement',
    'InputEvent',
    'Event',
    'getComputedStyle',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  try {
    const input = dom.window.document.querySelector('input');
    input.getClientRects = () => [{ width: 100, height: 20 }];
    for (const change of [
      () => {
        input.disabled = true;
      },
      () => {
        input.readOnly = true;
      },
      () => {
        input.style.visibility = 'hidden';
      },
      () => {
        input.autocomplete = 'new-password';
      },
    ]) {
      input.disabled = false;
      input.readOnly = false;
      input.style.visibility = '';
      input.autocomplete = 'current-password';
      input.value = '';
      inspectControls('c'.repeat(48));
      change();
      assert.deepEqual(
        fillControls('c'.repeat(48), 'https://example.test', [
          { index: 0, token: 'current-password', value: 'SyntheticSecret!' },
        ]),
        { refused: 'inspection_stale' },
      );
      assert.equal(input.value, '');
    }
  } finally {
    delete globalThis.__fastVaultSlots;
    for (const name of names)
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    dom.window.close();
  }
});
