// 中文注释：独立协作只调用固定命名能力；原页观察与业务工作页资格由FBL各自持有。
const fail = (code) => Object.assign(Error(code), { code });
const text = (value, limit = 256) =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const extensionId = (value) => typeof value === 'string' && /^[a-p]{32}$/.test(value);
const shapes = {
  'observation.list_pages': [[], []],
  'observation.select_current': [[], []],
  'observation.capture_material': [['pageHandle', 'mode'], []],
  'observation.capture_tables': [['pageHandle'], ['minimumRows', 'headers', 'selectors']],
  'observation.table_confirmation_begin': [
    ['pageHandle', 'captureHandle', 'tableId', 'format', 'all'],
    [],
  ],
  'observation.table_confirmation_control': [['confirmationHandle', 'kind'], []],
  'work.open': [['url', 'incognito'], ['resourceHandle']],
  'work.resource_bind': [['resourceId', 'epoch', 'lane', 'hosts'], ['policy']],
  'work.resource_revoke': [['resourceHandle'], []],
  'work.tables_read': [['workHandle'], ['minimumRows', 'headers', 'selectors']],
  'work.search_read': [['workHandle'], []],
  'work.trends_read': [['workHandle', 'keywords', 'region', 'period', 'report'], []],
  'work.report_inspect': [['workHandle', 'policyHandle'], ['phase']],
  'work.query_submit': [['workHandle', 'queryHandle', 'requestId'], []],
  'work.table_advance': [['workHandle', 'tableHandle', 'kind', 'requestId'], []],
  'work.navigate': [['workHandle', 'url', 'requestId'], []],
  'work.snapshot': [['workHandle'], ['options', 'continuation', 'baseline']],
  'work.click': [['workHandle', 'selector', 'requestId'], []],
  'work.fill': [['workHandle', 'selector', 'text', 'requestId'], []],
  'work.status': [['workHandle'], ['requestId']],
  'work.close': [['workHandle', 'requestId'], []],
};

export class AssistConnections {
  constructor(
    api,
    dispatch,
    consent,
    revoke = (session) => dispatch(session, 'session.close', {}),
  ) {
    this.api = api;
    this.dispatch = dispatch;
    this.consent = consent;
    this.revoke = revoke;
    this.connections = new Map();
    this.registryWork = Promise.resolve();
  }
  async ids() {
    const ids = (await this.api.storage.local.get('assistConnections')).assistConnections ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 4 ||
      ids.some((id) => !extensionId(id)) ||
      new Set(ids).size !== ids.length
    )
      throw fail('ASSIST_INVALID_REGISTRY');
    return ids;
  }
  serialize(work) {
    const next = this.registryWork.then(work);
    this.registryWork = next.catch(() => {});
    return next;
  }
  async handleUi(message, sender) {
    const url = `chrome-extension://${this.api.runtime.id}/product-connections.html`;
    if (sender?.id !== this.api.runtime.id || sender.url !== url) throw fail('ASSIST_UNTRUSTED_UI');
    if (sender.tab && (await this.api.tabs.get(sender.tab.id)).url !== url)
      throw fail('ASSIST_UNTRUSTED_UI');
    if (exact(message, ['type']) && message.type === 'assist_connections') return this.status();
    if (!exact(message, ['type', 'extensionId'])) throw fail('ASSIST_INVALID_REQUEST');
    if (message.type === 'assist_pair') return this.pair(message.extensionId);
    if (message.type === 'assist_unpair') return this.unpair(message.extensionId);
    throw fail('ASSIST_INVALID_REQUEST');
  }
  pair(id) {
    if (!extensionId(id)) return Promise.reject(fail('ASSIST_INVALID_ID'));
    return this.serialize(async () => {
      const ids = await this.ids();
      if (!ids.includes(id)) {
        if (ids.length >= 4) throw fail('ASSIST_CAPACITY');
        await this.api.storage.local.set({ assistConnections: [...ids, id] });
      }
      this.connect(id);
      return this.status();
    });
  }
  restore() {
    return this.serialize(async () => {
      for (const id of await this.ids()) this.connect(id);
    });
  }
  unpair(id) {
    if (!extensionId(id)) return Promise.reject(fail('ASSIST_INVALID_ID'));
    return this.serialize(async () => {
      const state = this.connections.get(id);
      if (state) {
        state.active = false;
        await this.close(state);
        state.port.disconnect();
        this.connections.delete(id);
      }
      await this.api.storage.local.set({
        assistConnections: (await this.ids()).filter((value) => value !== id),
      });
      return this.status();
    });
  }
  async close(state) {
    const receipt = await this.revoke(state.session);
    await Promise.allSettled([...state.pending]);
    if (
      receipt?.closed !== true &&
      !(receipt?.state === 'closed' && receipt.cleanupState === 'succeeded')
    )
      throw fail('ASSIST_REVOCATION_UNKNOWN');
    state.closed = true;
  }
  async status() {
    return (await this.ids()).map((id) => ({
      extensionId: id,
      connected:
        this.connections.get(id)?.active === true && this.connections.get(id)?.ready === true,
    }));
  }
  connect(id) {
    const previous = this.connections.get(id);
    if (previous?.active) return;
    if (previous && !previous.closed) throw fail('ASSIST_REVOCATION_UNKNOWN');
    const port = this.api.runtime.connect(id, { name: 'fbl.assist.v1' });
    const session = Object.freeze({ productId: id, session: crypto.randomUUID() });
    const state = {
      port,
      session,
      active: true,
      ready: false,
      closed: false,
      capabilities: new Set(),
      seen: new Set(),
      pending: new Set(),
    };
    this.connections.set(id, state);
    port.onMessage.addListener((message) => {
      const work = this.receive(state, message);
      state.pending.add(work);
      return work.finally(() => state.pending.delete(work));
    });
    port.onDisconnect.addListener(() => {
      state.active = false;
      void this.close(state).catch(() => {});
    });
  }
  validate(state, message) {
    if (
      !exact(message, ['id', 'operation', 'params']) ||
      !text(message.id) ||
      !Object.hasOwn(shapes, message.operation)
    )
      throw fail('ASSIST_INVALID_REQUEST');
    const capability = message.operation.startsWith('observation.')
      ? 'assist.observation.v1'
      : 'assist.work.v1';
    if (!state.capabilities.has(capability)) throw fail('ASSIST_CAPABILITY_UNAVAILABLE');
    const [required, optional] = shapes[message.operation];
    const params = message.params;
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      required.some((key) => !Object.hasOwn(params, key)) ||
      Object.keys(params).some((key) => !required.includes(key) && !optional.includes(key)) ||
      JSON.stringify(params).length > 256000
    )
      throw fail('ASSIST_INVALID_REQUEST');
    for (const [name, limit] of [
      ['continuation', 256],
      ['baseline', 4096],
    ]) {
      if (message.operation !== 'work.snapshot' || !Object.hasOwn(params, name)) continue;
      const value = params[name];
      if (
        ['options', 'continuation', 'baseline'].filter((key) => Object.hasOwn(params, key))
          .length !== 1 ||
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > limit ||
        Array.from(value).some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
      )
        throw fail('ASSIST_INVALID_REQUEST');
    }
    if (message.operation === 'work.snapshot' && Object.hasOwn(params, 'options')) {
      const o = params.options;
      const validText = (v, max, empty = false) =>
        typeof v === 'string' &&
        v.length <= max &&
        (empty || v.trim().length > 0) &&
        !Array.from(v).some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
      if (
        !o ||
        typeof o !== 'object' ||
        Array.isArray(o) ||
        Object.keys(o).some(
          (k) =>
            ![
              'root',
              'mode',
              'query',
              'roles',
              'viewport',
              'composed',
              'accessibility',
              'budget',
            ].includes(k),
        ) ||
        (Object.hasOwn(o, 'root') && !validText(o.root, 4096)) ||
        (Object.hasOwn(o, 'query') && !validText(o.query, 1000, true)) ||
        (Object.hasOwn(o, 'mode') && !['interactive', 'content', 'table'].includes(o.mode)) ||
        (Object.hasOwn(o, 'roles') &&
          (!Array.isArray(o.roles) ||
            o.roles.length > 32 ||
            o.roles.some((v) => !validText(v, 80)))) ||
        ['viewport', 'composed', 'accessibility'].some(
          (k) => Object.hasOwn(o, k) && typeof o[k] !== 'boolean',
        ) ||
        (Object.hasOwn(o, 'budget') &&
          (!Number.isInteger(o.budget) || o.budget < 512 || o.budget > 6000)) ||
        (o.accessibility === true && (!o.root || (o.mode ?? 'interactive') !== 'interactive'))
      )
        throw fail('ASSIST_INVALID_REQUEST');
    }
    for (const key of [
      'pageHandle',
      'workHandle',
      'captureHandle',
      'confirmationHandle',
      'requestId',
      'tableHandle',
      'queryHandle',
      'policyHandle',
    ])
      if (Object.hasOwn(params, key) && !text(params[key])) throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'incognito') && typeof params.incognito !== 'boolean')
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'all') && typeof params.all !== 'boolean')
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'selector') && !text(params.selector, 1000))
      throw fail('ASSIST_INVALID_REQUEST');
    if (
      Object.hasOwn(params, 'text') &&
      (typeof params.text !== 'string' || params.text.length > 4000)
    )
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'mode') && !['page', 'selection', 'canvas'].includes(params.mode))
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'phase') && !['query', 'report'].includes(params.phase))
      throw fail('ASSIST_INVALID_REQUEST');
    if (
      Object.hasOwn(params, 'minimumRows') &&
      (!Number.isInteger(params.minimumRows) || params.minimumRows < 1 || params.minimumRows > 1000)
    )
      throw fail('ASSIST_INVALID_REQUEST');
    for (const key of ['headers', 'selectors'])
      if (
        Object.hasOwn(params, key) &&
        (!Array.isArray(params[key]) ||
          params[key].length > 64 ||
          params[key].some((value) => !text(value, 1000)))
      )
        throw fail('ASSIST_INVALID_REQUEST');
    if (
      Object.hasOwn(params, 'format') &&
      !['csv', 'xlsx', 'both', 'clipboard'].includes(params.format)
    )
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'resourceHandle') && !text(params.resourceHandle))
      throw fail('ASSIST_INVALID_REQUEST');
    if (
      message.operation === 'work.resource_bind' &&
      (!text(params.resourceId) ||
        !text(params.lane) ||
        !Number.isSafeInteger(params.epoch) ||
        params.epoch < 1 ||
        !Array.isArray(params.hosts) ||
        params.hosts.length < 1 ||
        params.hosts.length > 64 ||
        params.hosts.some(
          (host) =>
            typeof host !== 'string' ||
            !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
            host.includes('..'),
        ))
    )
      throw fail('ASSIST_INVALID_REQUEST');
    if (Object.hasOwn(params, 'url')) {
      let url;
      try {
        url = new URL(params.url);
      } catch {
        throw fail('ASSIST_INVALID_REQUEST');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        params.url.length > 4096
      )
        throw fail('ASSIST_INVALID_REQUEST');
    }
  }
  publish(session, event) {
    const state = [...this.connections.values()].find((row) => row.session === session);
    if (!state?.active || !state.ready) throw fail('ASSIST_SESSION_REVOKED');
    state.port.postMessage({ type: 'fbl.assist.event', event });
  }
  async receive(state, message) {
    if (!state.active) return;
    if (
      exact(message, ['type', 'protocolVersion', 'capabilities']) &&
      message.type === 'fbl.assist.ready' &&
      message.protocolVersion === 1 &&
      Array.isArray(message.capabilities) &&
      message.capabilities.length <= 2 &&
      message.capabilities.every((name) =>
        ['assist.observation.v1', 'assist.work.v1'].includes(name),
      )
    ) {
      if (state.ready) return;
      state.capabilities = new Set(message.capabilities);
      state.ready = true;
      return;
    }
    if (!state.ready) return;
    const id = text(message?.id) ? message.id : null;
    let dispatched = false;
    try {
      this.validate(state, message);
      if (state.seen.has(id)) throw fail('ASSIST_REQUEST_ALREADY_SEEN');
      const cleanup = ['work.close', 'work.resource_revoke'].includes(message.operation);
      state.cleanupSeen ??= new Set();
      if (state.cleanupSeen.has(id)) throw fail('ASSIST_REQUEST_ALREADY_SEEN');
      if (cleanup) {
        if (state.cleanupSeen.size >= 1024) throw fail('ASSIST_CAPACITY');
        state.cleanupSeen.add(id);
      } else {
        if (state.seen.size >= 1024) throw fail('ASSIST_CAPACITY');
        state.seen.add(id);
      }
      if (!(await this.consent())) throw fail('ASSIST_ACCESS_REQUIRED');
      if (!state.active) return;
      dispatched = true;
      const result = await this.dispatch(state.session, message.operation, message.params);
      if (state.active) state.port.postMessage({ id, result });
    } catch (error) {
      if (state.active)
        state.port.postMessage({
          id,
          error: {
            code: dispatched ? 'ASSIST_OUTCOME_UNKNOWN' : error.code || 'ASSIST_INVALID_REQUEST',
            retryable: false,
            fallback_allowed: false,
          },
        });
    }
  }
}
