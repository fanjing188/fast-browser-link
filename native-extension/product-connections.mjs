const fail = (code) => Object.assign(Error(code), { code });
const extensionId = (value) => typeof value === 'string' && /^[a-p]{32}$/.test(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const operations = new Set(['bind', 'observe', 'prepare', 'commit', 'status', 'revoke']);

// 中文注释：只主动连接用户在FBL界面登记的精确扩展ID，不开放网页或被动外部执行入口。
export class ProductConnections {
  constructor(api, bridge, consent) {
    this.api = api;
    this.bridge = bridge;
    this.consent = consent;
    this.connections = new Map();
    this.pageOwners = new Map();
    this.registryWork = Promise.resolve();
  }

  async ids() {
    const stored = (await this.api.storage.local.get('productConnections')).productConnections;
    if (stored === undefined) return [];
    if (
      !Array.isArray(stored) ||
      stored.length > 4 ||
      stored.some((id) => !extensionId(id)) ||
      new Set(stored).size !== stored.length
    )
      throw fail('PRODUCT_INVALID_REGISTRY');
    return stored;
  }

  async handleUi(message, sender) {
    const url = `chrome-extension://${this.api.runtime.id}/product-connections.html`;
    if (sender?.id !== this.api.runtime.id || sender.url !== url)
      throw fail('PRODUCT_UNTRUSTED_UI');
    if (sender.tab) {
      const tab = await this.api.tabs.get(sender.tab.id);
      if (tab.url !== url) throw fail('PRODUCT_UNTRUSTED_UI');
    }
    if (message.type === 'product_connections' && exact(message, ['type'])) return this.status();
    if (!exact(message, ['type', 'extensionId'])) throw fail('PRODUCT_INVALID_REQUEST');
    if (message.type === 'product_pair') return this.pair(message.extensionId);
    if (message.type === 'product_unpair') return this.unpair(message.extensionId);
    throw fail('PRODUCT_INVALID_REQUEST');
  }

  async pair(id) {
    if (!extensionId(id)) throw fail('PRODUCT_INVALID_ID');
    return this.serializeRegistry(async () => {
      const ids = await this.ids();
      if (!ids.includes(id)) {
        if (ids.length >= 4) throw fail('PRODUCT_CAPACITY');
        await this.api.storage.local.set({ productConnections: [...ids, id] });
      }
      this.connect(id);
      return this.status();
    });
  }

  async restore() {
    return this.serializeRegistry(async () => {
      for (const id of await this.ids()) this.connect(id);
    });
  }

  async unpair(id) {
    if (!extensionId(id)) throw fail('PRODUCT_INVALID_ID');
    return this.serializeRegistry(async () => {
      const state = this.connections.get(id);
      if (state) {
        state.active = false;
        await this.closePages(state);
        state.port.disconnect();
        if (this.connections.get(id) === state) this.connections.delete(id);
      }
      const ids = await this.ids();
      await this.api.storage.local.set({ productConnections: ids.filter((value) => value !== id) });
      return this.status();
    });
  }

  serializeRegistry(operation) {
    // 中文注释：读取、登记与Port生命周期共用事务；失败不能阻塞后续核实或解除配对。
    const work = this.registryWork.then(operation);
    this.registryWork = work.catch(() => {});
    return work;
  }

  async closePages(state) {
    await Promise.allSettled([...state.pending]);
    if (state.attachUnknown) throw fail('PRODUCT_REVOCATION_UNKNOWN');
    const bridge = this.bridge();
    if (state.pages.size && !bridge) throw fail('PRODUCT_REVOCATION_UNKNOWN');
    for (const pageHandle of state.pages) {
      const result = await bridge.request('extension.product.close', { pageHandle });
      if (!['closed', 'cancelled'].includes(result?.state) || result.cleanupState !== 'succeeded')
        throw fail('PRODUCT_REVOCATION_UNKNOWN');
      state.pages.delete(pageHandle);
      if (this.pageOwners.get(pageHandle) === state) this.pageOwners.delete(pageHandle);
    }
  }

  async status() {
    return (await this.ids()).map((id) => ({
      extensionId: id,
      connected:
        this.connections.get(id)?.active === true && this.connections.get(id)?.ready === true,
    }));
  }

  connect(id) {
    if (this.connections.get(id)?.active) return;
    if (
      this.connections.get(id)?.pages.size ||
      this.connections.get(id)?.pending.size ||
      this.connections.get(id)?.attachUnknown
    )
      throw fail('PRODUCT_REVOCATION_UNKNOWN');
    const port = this.api.runtime.connect(id, { name: 'fbl.product.v1' });
    const state = {
      port,
      active: true,
      ready: false,
      pages: new Set(),
      seen: new Map(),
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
      void this.closePages(state)
        .then(() => {
          if (this.connections.get(id) === state) this.connections.delete(id);
        })
        .catch(() => {});
    });
  }

  validate(state, message) {
    if (!exact(message, ['id', 'operation', 'params']) || !text(message.id))
      throw fail('PRODUCT_INVALID_REQUEST');
    const p = message.params;
    if (message.operation === 'attach') {
      if (!exact(p, ['url']) || typeof p.url !== 'string' || p.url.length > 4096)
        throw fail('PRODUCT_INVALID_REQUEST');
      let url;
      try {
        url = new URL(p.url);
      } catch {
        throw fail('PRODUCT_INVALID_REQUEST');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw fail('PRODUCT_INVALID_REQUEST');
      return;
    }
    const keys =
      message.operation === 'run' ? ['pageHandle', 'requestId', 'command'] : ['pageHandle'];
    if (
      !['get', 'run', 'close'].includes(message.operation) ||
      !exact(p, keys) ||
      !text(p.pageHandle)
    )
      throw fail('PRODUCT_INVALID_REQUEST');
    if (!state.pages.has(p.pageHandle)) throw fail('PRODUCT_PAGE_UNAVAILABLE');
    if (
      message.operation === 'run' &&
      (!text(p.requestId) ||
        !p.command ||
        Array.isArray(p.command) ||
        !operations.has(p.command.operation) ||
        JSON.stringify(p.command).length > 256000)
    )
      throw fail('PRODUCT_INVALID_REQUEST');
  }

  async receive(state, message) {
    if (!state.active) return;
    if (
      exact(message, ['type', 'protocolVersion']) &&
      message.type === 'fbl.product.ready' &&
      message.protocolVersion === 1
    ) {
      state.ready = true;
      return;
    }
    if (!state.ready) return;
    const id = text(message?.id) ? message.id : null;
    let dispatched = false;
    let resolved = false;
    try {
      this.validate(state, message);
      if (state.seen.has(id)) throw fail('PRODUCT_REQUEST_ALREADY_SEEN');
      if (state.seen.size >= 256) throw fail('PRODUCT_CAPACITY');
      state.seen.set(id, true);
      if (!(await this.consent())) throw fail('PRODUCT_ACCESS_REQUIRED');
      if (!state.active) return;
      const bridge = this.bridge();
      if (!bridge) throw fail('PRODUCT_OFFLINE');
      dispatched = true;
      const result = await bridge.request('extension.product.' + message.operation, message.params);
      if (message.operation === 'attach') {
        if (!text(result?.pageHandle)) throw fail('PRODUCT_INVALID_RECEIPT');
        resolved = true;
        // 中文注释：Native按真实页面复用任务，但不能把同一资格发给另一个配对Port。
        const owner = this.pageOwners.get(result.pageHandle);
        if (owner && owner !== state) throw fail('PRODUCT_PAGE_UNAVAILABLE');
        this.pageOwners.set(result.pageHandle, state);
        state.pages.add(result.pageHandle);
      }
      if (!state.active) {
        // 中文注释：迟到任务交给同一撤销屏障收尾，不先删登记或丢弃待核实页面。
        return;
      }
      if (message.operation === 'close') {
        if (!['closed', 'cancelled'].includes(result?.state) || result.cleanupState !== 'succeeded')
          throw fail('PRODUCT_REVOCATION_UNKNOWN');
        state.pages.delete(message.params.pageHandle);
        if (this.pageOwners.get(message.params.pageHandle) === state)
          this.pageOwners.delete(message.params.pageHandle);
      }
      state.port.postMessage({ id, result });
    } catch (error) {
      if (dispatched && message.operation === 'attach' && !resolved) state.attachUnknown = true;
      if (!state.active) return;
      const code = dispatched ? 'PRODUCT_OUTCOME_UNKNOWN' : error.code || 'PRODUCT_INVALID_REQUEST';
      state.port.postMessage({ id, error: { code, retryable: false, fallback_allowed: false } });
    }
  }
}
