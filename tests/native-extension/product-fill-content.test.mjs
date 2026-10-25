import assert from 'node:assert/strict';

import test from 'node:test';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const sourceUrl = new URL('../../native-extension/product-fill-content.mjs', import.meta.url);
const module = await import(sourceUrl).catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const config = {
  channel: 'private-test-channel-with-entropy',
  documentUrl: 'https://fixture.test/add',
};
const binding = { product: 'p', source: 's', item: 'i', submissionUrl: config.documentUrl };

async function fixture(t, html = '<form><label>Name<input name="product"></label></form>') {
  assert.equal(
    typeof module.installProductFillAuthority,
    'function',
    'self-contained installer exists',
  );
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => pageErrors.push(error));
  const dom = new JSDOM(html, {
    virtualConsole,
    url: config.documentUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const listeners = [];
  dom.window.chrome = {
    runtime: { id: 'fbl-extension', onMessage: { addListener: (fn) => listeners.push(fn) } },
  };
  // 中文注释：JSDOM 没有布局，仅补浏览器布局测量；语义与 guard 均执行真实 DOM 代码。
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') || this.style.display === 'none'
      ? []
      : [{ x: 10, y: 10, width: 120, height: 30 }];
  };
  const install = (options = config) =>
    vm.runInContext(
      `(${module.installProductFillAuthority.toString()})`,
      dom.getInternalVMContext(),
    )(options);
  const installed = install();
  const send = (command, data = {}, sender = { id: 'fbl-extension' }, overrides = {}) => {
    let response;
    const accepted = listeners[0](
      {
        type: 'fbl.product_fill',
        channel: config.channel,
        command: { operation: command, ...data },
        ...overrides,
      },
      sender,
      (result) => {
        response = structuredClone(result);
      },
    );
    assert.notEqual(accepted, true, 'handler is synchronous, so revoke is a synchronous fence');
    return response;
  };
  return {
    window: dom.window,
    document: dom.window.document,
    listeners,
    pageErrors,
    install,
    installed,
    send,
    bind: (epoch = 1, extra = {}) =>
      send('bind', { binding, epoch, submissionLocked: false, ...extra }),
  };
}

async function ready(t, html) {
  const f = await fixture(t, html);
  assert.deepEqual(f.bind(), { bound: true, epoch: 1 });
  const observation = f.send('observe');
  return { ...f, observation };
}

function grant(f, values = ['Example']) {
  const prepared = f.send('prepare', {
    observationHandle: f.observation.observationHandle,
    candidates: values.map((value, i) => ({
      fieldHandle: f.observation.fields.at(i).fieldHandle,
      value,
    })),
  });
  assert.equal(typeof prepared.grantHandle, 'string');
  return prepared;
}

test('serialized isolated installer authenticates extension messages and retains its private closure', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(structuredClone(f.installed), { installed: true, url: config.documentUrl });
  assert.equal(f.send('observe', {}, { id: 'other' }), undefined);
  assert.equal(f.send('observe', {}, { id: 'fbl-extension', tab: { id: 1 } }), undefined);
  assert.equal(f.send('observe', {}, undefined, { channel: 'wrong' }), undefined);
  assert.match(f.send('observe').error, /unbound/);
  f.install();
  assert.equal(f.listeners.length, 1);
  assert.equal(f.document.documentElement.outerHTML.includes(config.channel), false);
});

test('ordinary blank fields fill through native setter with readback and exact replay', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const events = [];
  const input = f.document.querySelector('input');
  for (const name of ['input', 'change'])
    input.addEventListener(name, (event) =>
      events.push([event.type, event.bubbles, event.composed]),
    );
  const request = { grantHandle: prepared.grantHandle, requestId: 'r1' };
  const result = f.send('commit', request);
  assert.deepEqual(result, {
    epoch: 1,
    requestId: 'r1',
    status: 'confirmed',
    results: [
      { fieldHandle: f.observation.fields[0].fieldHandle, status: 'confirmed', reason: 'written' },
    ],
    retryable: false,
    fallback_allowed: false,
  });
  assert.equal(input.value, 'Example');
  assert.deepEqual(events, [
    ['input', true, true],
    ['change', true, false],
  ]);
  assert.deepEqual(f.send('commit', request), result);
  assert.deepEqual(f.send('status', { requestId: 'r1' }), result);
  assert.equal(events.length, 2);
  assert.match(f.send('commit', { ...request, grantHandle: 'another' }).error, /request_conflict/);
  assert.equal(JSON.stringify(result).includes('Example'), false);
});

test('observe excludes sensitive, invisible, custom, valued and non-light-DOM fields', async (t) => {
  const f = await ready(
    t,
    `<form>
    <label>Public description<textarea name="description"></textarea></label>
    <input type="email" name="contact"><input type="url" name="homepage">
    <input type="password"><input name="otp"><input name="account_name">
    <input autocomplete="current-password"><input aria-label="CAPTCHA">
    <input name="consent"><input placeholder="Leave blank for humans">
    <input hidden><input style="display:none"><input disabled><input readonly><input value="draft">
    <input role="combobox"><div role="combobox"><input></div><div contenteditable><input></div>
    <input aria-hidden="true"><input tabindex="-1"><input type="checkbox">
    <input type="text" is="custom-input"><div id="host"></div><iframe></iframe>
    <input aria-describedby="outside"><span id="outside">Password verification</span>
  </form>`,
  );
  f.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML =
    '<input name="shadow">';
  const observed = f.send('observe');
  assert.deepEqual(
    observed.fields.map((field) => field.name),
    ['description', 'contact', 'homepage'],
  );
  assert.equal(observed.fields[0].inputType, 'textarea');
  assert.ok(observed.unsupportedCount >= 18);
  assert.equal(JSON.stringify(observed).includes('draft'), false);
});

test('all own semantics and same-root labels are classified before output shortening', async (t) => {
  const f = await ready(t, '<form></form>');
  const form = f.document.querySelector('form');
  const suffix = `${'x'.repeat(5000)} Password`;
  for (const attribute of ['name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'title']) {
    const input = f.document.createElement('input');
    input.setAttribute(attribute, suffix);
    form.append(input);
  }
  for (const relation of ['aria-labelledby', 'aria-describedby']) {
    const text = f.document.createElement('span');
    text.id = relation;
    text.textContent = suffix;
    const input = f.document.createElement('input');
    input.setAttribute(relation, relation);
    form.append(input, text);
  }
  const label = f.document.createElement('label');
  label.innerHTML = '<input name="labelled">';
  label.append(suffix);
  form.append(label);
  const safe = f.document.createElement('input');
  safe.name = 'public';
  safe.setAttribute('aria-describedby', 'safe-description');
  form.insertAdjacentHTML(
    'beforeend',
    '<div id="safe-description">Public details<input value="password"><span contenteditable>password</span><script>password</script></div>',
  );
  form.append(safe);
  assert.deepEqual(
    f.send('observe').fields.map((field) => field.name),
    ['public'],
  );
});

for (const [name, mutate] of [
  [
    'focus changes type to password',
    (f, node) =>
      node.addEventListener('focus', () => {
        node.type = 'password';
      }),
  ],
  [
    'focus remounts identical field',
    (f, node) => node.addEventListener('focus', () => node.replaceWith(node.cloneNode(true))),
  ],
  [
    'focus moves node into another form',
    (f, node) =>
      node.addEventListener('focus', () => f.document.querySelector('#other').append(node)),
  ],
  [
    'focus redefines label',
    (f, node) => node.addEventListener('focus', () => node.setAttribute('aria-label', 'Password')),
  ],
  [
    'manual value before commit',
    (f, node) => {
      node.value = 'Human draft';
    },
  ],
  ['same form association changes', (f, node) => node.setAttribute('form', 'other')],
  [
    'description changes benign meaning',
    (f) => {
      f.document.querySelector('#hint').textContent = 'Different public purpose';
    },
  ],
  [
    'field becomes readonly',
    (f, node) => {
      node.readOnly = true;
    },
  ],
  [
    'field becomes hidden',
    (f, node) => {
      node.style.visibility = 'hidden';
    },
  ],
  ['node moves within form', (f, node) => f.document.querySelector('#slot').append(node)],
]) {
  test(`final guard refuses ${name} without a setter`, async (t) => {
    const f = await ready(
      t,
      '<form id="main"><label>Name<input name="product" aria-describedby="hint"></label><span id="hint">Public purpose</span><div id="slot"></div></form><form id="other"></form>',
    );
    const prepared = grant(f);
    const node = f.document.querySelector('input');
    let edits = 0;
    node.addEventListener('input', () => {
      edits++;
    });
    mutate(f, node);
    const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: name });
    assert.equal(result.status, 'refused');
    assert.equal(result.results[0].status, 'refused');
    assert.equal(edits, 0);
    assert.notEqual(node.value, 'Example');
    assert.deepEqual(
      f.send('commit', { grantHandle: prepared.grantHandle, requestId: name }),
      result,
    );
  });
}

for (const [name, afterWrite] of [
  [
    'submission during input',
    (f, node) =>
      node.form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true })),
  ],
  [
    'semantic change during input',
    (f, node) => {
      node.type = 'password';
    },
  ],
  [
    'readback differs',
    (f, node) => {
      node.value = 'Other';
    },
  ],
  ['revoke during input', (f) => f.send('revoke', { reason: 'operator' })],
  ['pagehide during input', (f) => f.window.dispatchEvent(new f.window.Event('pagehide'))],
]) {
  test(`post-event guard marks unknown and fences subsequent setters: ${name}`, async (t) => {
    const f = await ready(
      t,
      '<form><input name="product"><textarea name="description"></textarea></form>',
    );
    const prepared = grant(f, ['Example', 'Details']);
    const node = f.document.querySelector('input');
    node.addEventListener('input', () => afterWrite(f, node));
    const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: name });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(
      result.results.map((row) => row.status),
      ['unknown', 'refused'],
    );
    assert.equal(f.document.querySelector('textarea').value, '');
    assert.deepEqual(f.send('status', { requestId: name }), result);
    f.install();
    assert.deepEqual(
      f.send('commit', { grantHandle: prepared.grantHandle, requestId: name }),
      result,
    );
  });
}

// 中文注释：这些测试直接产生真实 DOM 变化，不替换分类器、快照或 guard。
test('binding changes require revoke and a strictly newer epoch, without erasing attempt tombstones', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  assert.match(f.bind(2, { binding: { ...binding, item: 'different' } }).error, /revoke_required/);
  assert.deepEqual(f.send('revoke', { reason: 'switch' }), { revoked: true, epoch: 1 });
  assert.match(f.bind(1).error, /epoch/);
  assert.deepEqual(f.bind(2, { binding: { ...binding, item: 'different' } }), {
    bound: true,
    epoch: 2,
  });
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'old-grant' });
  assert.equal(result.status, 'refused');
  assert.equal(f.document.querySelector('input').value, '');
  f.observation = f.send('observe');
  const next = grant(f);
  const success = f.send('commit', { grantHandle: next.grantHandle, requestId: 'new-grant' });
  assert.equal(success.status, 'confirmed');
  assert.deepEqual(f.send('status', { requestId: 'old-grant' }), result);
  assert.deepEqual(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'old-grant' }),
    result,
  );
});

for (const phase of ['before first bind', 'after bind', 'after reinstall']) {
  test(`submission is sticky when captured ${phase}`, async (t) => {
    const f = await fixture(t);
    if (phase !== 'before first bind') f.bind();
    f.document
      .querySelector('form')
      .dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    f.install();
    if (phase !== 'before first bind') f.send('revoke', { reason: 'new-item' });
    assert.equal(f.bind(phase === 'before first bind' ? 1 : 2).bound, true);
    assert.match(f.send('observe').error, /fenced/);
  });
}

test('a post-write unknown permanently fences this document across new binding and reinstall', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  f.document.querySelector('input').addEventListener('input', (event) => {
    event.target.value = '';
  });
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'unknown' });
  assert.equal(result.status, 'unknown');
  f.send('revoke', { reason: 'switch' });
  const channel = 'a-new-channel-cannot-rekey-closure';
  f.install({ ...config, channel });
  f.send('bind', { binding, epoch: 2, submissionLocked: false }, undefined, { channel });
  assert.match(f.send('observe', {}, undefined, { channel }).error, /fenced/);
  assert.deepEqual(f.send('status', { requestId: 'unknown' }, undefined, { channel }), result);
});

test('trusted human editing intention invalidates every old grant even if the field stays empty', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  // JSDOM has no hardware keyboard. Its internal Event implementation dispatches a trusted event;
  // the installed listener and all DOM guards remain real, with no artificial public test hook.
  const event = new f.window.Event('keydown', { bubbles: true });
  const implementation = (wrapper) =>
    wrapper[Object.getOwnPropertySymbols(wrapper).find((symbol) => symbol.description === 'impl')];
  implementation(event).isTrusted = true;
  implementation(f.document.querySelector('input'))._dispatch(implementation(event));
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'human' }).status,
    'refused',
  );
  assert.deepEqual(f.send('observe').fields, []);
});

test('invalidated grants cannot be replayed under a new request id', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const node = f.document.querySelector('input');
  node.value = 'human';
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'first' }).status,
    'refused',
  );
  node.value = '';
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'second' }).status,
    'refused',
  );
  assert.equal(node.value, '');
});

test('prepare rejects extras, fake handles, duplicate handles, oversized and non-string values', async (t) => {
  const f = await ready(t);
  const candidate = { fieldHandle: f.observation.fields[0].fieldHandle, value: 'Normal' };
  const normal = { observationHandle: f.observation.observationHandle, candidates: [candidate] };
  for (const invalid of [
    { ...normal, selector: 'input' },
    { ...normal, eligible: true },
    { ...normal, scripts: [] },
    { ...normal, candidates: [{ ...candidate, selector: '#x' }] },
    { ...normal, candidates: [{ ...candidate, fieldHandle: 'fake' }] },
    { ...normal, candidates: [candidate, candidate] },
    ...['', ' '.repeat(4), 'x'.repeat(8193), {}, 1, null, ['string'], '\u0000bad'].map((value) => ({
      ...normal,
      candidates: [{ ...candidate, value }],
    })),
    { ...normal, candidates: [] },
    { ...normal, candidates: Array(65).fill(candidate) },
  ])
    assert.equal(typeof f.send('prepare', invalid).error, 'string');
  assert.equal(f.send('prepare', normal).epoch, 1);
});

test('commit rejects extra payload even for an already completed request id', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const payload = { grantHandle: prepared.grantHandle, requestId: 'exact' };
  assert.equal(f.send('commit', payload).status, 'confirmed');
  assert.match(f.send('commit', { ...payload, selector: 'input' }).error, /invalid|conflict/);
});

test('short monotonic grant TTL is enforced at final guard', async (t) => {
  const f = await ready(t);
  let time = 100;
  Object.defineProperty(f.window.performance, 'now', { value: () => time });
  const prepared = grant(f);
  time += 5001;
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'expired' }).status,
    'refused',
  );
  assert.equal(f.document.querySelector('input').value, '');
});

test('all fields share the first observation human revision, and trusted edits cannot be erased', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product"><textarea name="description"></textarea></form>',
  );
  const prepared = grant(f, ['Example', 'Details']);
  const field = f.document.querySelector('textarea');
  const event = new f.window.Event('input', { bubbles: true });
  const impl = (wrapper) =>
    wrapper[Object.getOwnPropertySymbols(wrapper).find((symbol) => symbol.description === 'impl')];
  impl(event).isTrusted = true;
  field.value = 'Human draft';
  impl(field)._dispatch(impl(event));
  field.value = '';
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'all-stale' });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['refused', 'refused'],
  );
  assert.equal(f.document.querySelector('input').value, '');
  assert.deepEqual(
    f.send('observe').fields.map((item) => item.name),
    ['product'],
  );
});

test('a benign input instance value accessor is never invoked', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const node = f.document.querySelector('input');
  Object.defineProperty(node, 'value', {
    get() {
      throw Error('instance getter');
    },
    set() {
      throw Error('instance setter');
    },
  });
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'native' }).status,
    'confirmed',
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(f.window.HTMLInputElement.prototype, 'value').get.call(node),
    'Example',
  );
});

test('change handler exceptions after the setter are unknown and never replayed', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product"><textarea name="description"></textarea></form>',
  );
  const prepared = grant(f, ['Example', 'Details']);
  const node = f.document.querySelector('input');
  const dispatch = node.dispatchEvent;
  node.dispatchEvent = function (event) {
    if (event.type === 'change') throw Error('dispatch fails');
    return dispatch.call(this, event);
  };
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'throws' });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['unknown', 'refused'],
  );
  assert.equal(f.document.querySelector('textarea').value, '');
  assert.deepEqual(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'throws' }),
    result,
  );
});

test('observe never leaks an editable ancestor referenced as a description', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product" aria-describedby="editable-description"></form><div contenteditable><span id="editable-description">password private draft</span></div>',
  );
  assert.deepEqual(
    f.observation.fields.map((item) => item.name),
    ['product'],
  );
  assert.equal(JSON.stringify(f.observation).includes('private draft'), false);
});

test('type semantics include the real property, and hidden offscreen traps stay unsupported', async (t) => {
  const f = await ready(
    t,
    '<form><input name="public"><input name="trap" style="position:absolute;left:-10000px"><input name="trap2" style="clip-path:inset(100%)"><input name="trap3" style="pointer-events:none"><input name="trap4" aria-autocomplete="list"><input name="trap5" list="choices"><datalist id="choices"><option value="X"></datalist></form>',
  );
  assert.deepEqual(
    f.observation.fields.map((item) => item.name),
    ['public'],
  );
});

test('ordinary insecure HTTP pages use getRandomValues rather than secure-context randomUUID', async (t) => {
  const f = await ready(t);
  Object.defineProperty(f.window.crypto, 'randomUUID', { value: undefined });
  const observation = f.send('observe');
  assert.equal(typeof observation.observationHandle, 'string');
  assert.equal(observation.fields.length, 1);
});

test('two ordinary fields are written sequentially and both confirm against their new values', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product"><textarea name="description"></textarea></form>',
  );
  const prepared = grant(f, ['Example', 'Details']);
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'two' });
  assert.deepEqual(
    result.results.map((row) => row.status),
    ['confirmed', 'confirmed'],
  );
  assert.equal(f.document.querySelector('textarea').value, 'Details');
});

test('submissionLocked is monotonic and never reset by same-binding rebind', async (t) => {
  const f = await ready(t);
  assert.equal(f.bind(1, { submissionLocked: true }).bound, true);
  assert.equal(f.bind(1, { submissionLocked: false }).bound, true);
  assert.match(f.send('observe').error, /fenced/);
});

test('the exported function itself installs the same authenticated synchronous handler', (t) => {
  const dom = new JSDOM('<form><input name="product"></form>', { url: config.documentUrl });
  t.after(() => dom.window.close());
  let listener;
  const chrome = {
    runtime: {
      id: 'direct-fbl',
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
  };
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  try {
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'chrome', { value: chrome, configurable: true });
    assert.deepEqual(module.installProductFillAuthority(config), {
      installed: true,
      url: config.documentUrl,
    });
    let response;
    listener(
      {
        type: 'fbl.product_fill',
        channel: config.channel,
        command: { operation: 'bind', binding, epoch: 1, submissionLocked: false },
      },
      { id: 'direct-fbl' },
      (value) => {
        response = value;
      },
    );
    assert.deepEqual(response, { bound: true, epoch: 1 });
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete globalThis.window;
    if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome);
    else delete globalThis.chrome;
  }
});

test('trusted pointer intention inside an input handler is not swallowed by ownWriteDepth', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product"><textarea name="description"></textarea></form>',
  );
  const prepared = grant(f, ['Example', 'Details']);
  f.document.querySelector('input').addEventListener('input', () => {
    const event = new f.window.Event('pointerdown', { bubbles: true });
    const impl = (wrapper) =>
      wrapper[
        Object.getOwnPropertySymbols(wrapper).find((symbol) => symbol.description === 'impl')
      ];
    impl(event).isTrusted = true;
    impl(f.document.querySelector('textarea'))._dispatch(impl(event));
  });
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'pointer' });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['unknown', 'refused'],
  );
  assert.equal(f.document.querySelector('textarea').value, '');
});

test('the envelope cannot smuggle selectors or scripts alongside an otherwise valid command', async (t) => {
  const f = await ready(t);
  assert.match(f.send('observe', {}, undefined, { selector: 'input' }).error, /invalid/);
  assert.match(f.send('observe', {}, undefined, { scripts: [] }).error, /invalid/);
});

test('guard sees transient remove and restore mutations before the observer microtask', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const node = f.document.querySelector('input');
  const parent = node.parentNode;
  node.remove();
  parent.append(node);
  assert.equal(
    f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'transient' }).status,
    'refused',
  );
  assert.equal(node.value, '');
});

test('maxlength is rejected before any write', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product" maxlength="3"><textarea name="description"></textarea></form>',
  );
  assert.match(
    f.send('prepare', {
      observationHandle: f.observation.observationHandle,
      candidates: [{ fieldHandle: f.observation.fields[0].fieldHandle, value: 'long' }],
    }).error,
    /long/,
  );
  assert.equal(f.document.querySelector('input').value, '');
});

test('a real input event listener exception is unknown and blocks subsequent fields', async (t) => {
  const f = await ready(
    t,
    '<form><input name="product"><textarea name="description"></textarea></form>',
  );
  const prepared = grant(f, ['Example', 'Details']);
  f.document.querySelector('input').addEventListener('input', () => {
    throw Error('fixture handler exception');
  });
  const result = f.send('commit', { grantHandle: prepared.grantHandle, requestId: 'real-throw' });
  assert.equal(f.pageErrors.length, 1);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['unknown', 'refused'],
  );
  assert.equal(f.document.querySelector('textarea').value, '');
});

test('new private channel requires the previous authority revoke and does not revive old grants', async (t) => {
  const f = await ready(t);
  const prepared = grant(f);
  const channel = 'another-unpredictable-private-channel';
  assert.equal(f.install({ ...config, channel }).installed, false);
  assert.deepEqual(f.send('revoke', { reason: 'new-connection' }), { revoked: true, epoch: 1 });
  assert.deepEqual(structuredClone(f.install({ ...config, channel })), {
    installed: true,
    url: config.documentUrl,
  });
  assert.equal(f.send('observe'), undefined);
  const send = (operation, data = {}) => f.send(operation, data, undefined, { channel });
  assert.match(send('observe').error, /unbound/);
  assert.equal(send('bind', { binding, epoch: 2, submissionLocked: false }).bound, true);
  assert.equal(
    send('commit', { grantHandle: prepared.grantHandle, requestId: 'pre-rekey' }).status,
    'refused',
  );
  assert.equal(send('observe').fields.length, 1);
  assert.equal(f.listeners.length, 1);
});

test('a rekey never clears submission facts captured before bind', async (t) => {
  const f = await fixture(t);
  f.document.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true }));
  const channel = 'new-channel-must-keep-submission';
  assert.equal(f.install({ ...config, channel }).installed, false);
  f.send('revoke', { reason: 'rekey-before-bind' });
  assert.equal(f.install({ ...config, channel }).installed, true);
  f.send('bind', { binding, epoch: 1, submissionLocked: false }, undefined, { channel });
  assert.match(f.send('observe', {}, undefined, { channel }).error, /fenced/);
});
