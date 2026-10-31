// 中文注释：原页只读观察使用文档身份，不创建执行租约、不接管用户输入或导航页面。
const fail = (code) => Object.assign(Error(code), { code });
const ordinary = (tab) => {
  try {
    const url = new URL(tab.url);
    return (
      !tab.incognito && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

export class AssistObservation {
  constructor(api, isWorkTab) {
    this.api = api;
    this.isWorkTab = isWorkTab;
    this.pages = new Map();
    this.captures = new Map();
    this.confirmations = new Map();
    this.revoked = new WeakSet();
  }
  checkSession(session) {
    if (!session || this.revoked.has(session)) throw fail('ASSIST_SESSION_REVOKED');
  }
  async listPages(session) {
    this.checkSession(session);
    const tabs = await this.api.tabs.query({});
    this.checkSession(session);
    const pages = [];
    for (const tab of tabs) {
      if (!ordinary(tab) || this.isWorkTab(tab)) continue;
      const url = new URL(tab.url);
      url.search = '';
      url.hash = '';
      if (url.href.length <= 8192 && !pages.some((page) => page.url === url.href))
        pages.push({ url: url.href });
      if (pages.length >= 20) break;
    }
    return { pages };
  }
  async foreground(tabId) {
    const tabs = await this.api.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1) throw fail('ASSIST_PAGE_UNAVAILABLE');
    const tab = tabs[0];
    if ((tabId !== undefined && tab.id !== tabId) || !ordinary(tab) || this.isWorkTab(tab))
      throw fail('ASSIST_PAGE_UNAVAILABLE');
    if (!(await this.api.windows.get(tab.windowId)).focused) throw fail('ASSIST_PAGE_UNAVAILABLE');
    return tab;
  }
  async identity(tab) {
    const [result] = await this.api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => location.href,
    });
    if (!result?.documentId || result.result !== tab.url) throw fail('ASSIST_DOCUMENT_CHANGED');
    return result.documentId;
  }
  async select(session) {
    this.checkSession(session);
    for (const [handle, page] of this.pages)
      if (page.expires < Date.now()) this.pages.delete(handle);
    for (const [handle, capture] of this.captures)
      if (capture.expires < Date.now() || !this.pages.has(capture.pageHandle))
        this.captures.delete(handle);
    if (this.pages.size >= 256) throw fail('ASSIST_CAPACITY');
    const tab = await this.foreground();
    const documentId = await this.identity(tab);
    const fresh = await this.foreground(tab.id);
    this.checkSession(session);
    if (fresh.url !== tab.url || fresh.windowId !== tab.windowId)
      throw fail('ASSIST_DOCUMENT_CHANGED');
    const pageHandle = crypto.randomUUID();
    this.pages.set(pageHandle, {
      session,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      documentId,
      expires: Date.now() + 300000,
    });
    return {
      pageHandle,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: String(tab.title || '').slice(0, 200),
      documentId,
    };
  }
  async page(session, handle) {
    this.checkSession(session);
    const page = this.pages.get(handle);
    if (!page || page.session !== session || page.expires < Date.now())
      throw fail('ASSIST_PAGE_UNAVAILABLE');
    const tab = await this.foreground(page.tabId);
    if (
      tab.url !== page.url ||
      tab.windowId !== page.windowId ||
      (await this.identity(tab)) !== page.documentId
    )
      throw fail('ASSIST_DOCUMENT_CHANGED');
    this.checkSession(session);
    return page;
  }
  async capture(session, params) {
    if (!['page', 'selection', 'canvas'].includes(params.mode))
      throw fail('ASSIST_INVALID_REQUEST');
    const page = await this.page(session, params.pageHandle);
    const [captured] = await this.api.scripting.executeScript({
      target: { tabId: page.tabId, documentIds: [page.documentId] },
      func: async (moduleURL, mode) => {
        const module = await import(moduleURL);
        return module.captureMaterial(document, location.href, mode);
      },
      args: [this.api.runtime.getURL('product-observation.mjs'), params.mode],
    });
    if (captured?.documentId !== page.documentId) throw fail('ASSIST_DOCUMENT_CHANGED');
    await this.page(session, params.pageHandle);
    return { ...captured.result, document_id: page.documentId };
  }
  async tables(session, params) {
    const page = await this.page(session, params.pageHandle);
    const [captured] = await this.api.scripting.executeScript({
      target: { tabId: page.tabId, documentIds: [page.documentId] },
      func: async (moduleURL, options) => {
        const module = await import(moduleURL);
        return module.captureTables(document, options);
      },
      args: [
        this.api.runtime.getURL('product-tables.mjs'),
        {
          minimumRows: params.minimumRows ?? 1,
          headers: params.headers ?? [],
          selectors: params.selectors ?? [],
        },
      ],
    });
    if (captured?.documentId !== page.documentId) throw fail('ASSIST_DOCUMENT_CHANGED');
    await this.page(session, params.pageHandle);
    const captureHandle = crypto.randomUUID();
    if (this.captures.size >= 128) throw fail('ASSIST_CAPACITY');
    const capture = { ...captured.result, documentId: page.documentId, captureHandle };
    this.captures.set(captureHandle, {
      session,
      pageHandle: params.pageHandle,
      capture,
      expires: Date.now() + 300000,
    });
    return capture;
  }
  async confirmationCommand(page, params) {
    const [result] = await this.api.scripting.executeScript({
      target: { tabId: page.tabId, documentIds: [page.documentId] },
      func: async (moduleURL, params, brandURL) => {
        const { tableConfirmation } = await import(moduleURL);
        const { BRAND_CSS } = await import(brandURL);
        return tableConfirmation({ ...params, sharedCSS: BRAND_CSS });
      },
      args: [
        this.api.runtime.getURL('product-table-confirm.mjs'),
        params,
        this.api.runtime.getURL('brand.mjs'),
      ],
    });
    if (result?.documentId !== page.documentId) throw fail('ASSIST_DOCUMENT_CHANGED');
    return result.result;
  }
  async beginConfirmation(session, params) {
    const page = await this.page(session, params.pageHandle);
    const saved = this.captures.get(params.captureHandle);
    if (
      !saved ||
      saved.session !== session ||
      saved.pageHandle !== params.pageHandle ||
      saved.expires < Date.now()
    )
      throw fail('ASSIST_CAPTURE_UNAVAILABLE');
    const index = saved.capture.tables.findIndex((table) => table.id === params.tableId);
    if (
      index < 0 ||
      !['csv', 'xlsx', 'both', 'clipboard'].includes(params.format) ||
      typeof params.all !== 'boolean'
    )
      throw fail('ASSIST_INVALID_REQUEST');
    if (this.confirmations.size >= 16) throw fail('ASSIST_CAPACITY');
    const confirmationHandle = crypto.randomUUID();
    const record = {
      session,
      pageHandle: params.pageHandle,
      captureHandle: params.captureHandle,
      token: confirmationHandle,
    };
    this.confirmations.set(confirmationHandle, record);
    try {
      const view = await this.confirmationCommand(page, {
        action: 'begin',
        token: confirmationHandle,
        tables: saved.capture.tables,
        index,
        format: params.format,
        all: params.all,
        url: page.url,
        language: this.api.i18n?.getUILanguage?.() || 'zh',
      });
      await this.page(session, params.pageHandle);
      return { confirmationHandle, confirmation: view };
    } catch (error) {
      this.confirmations.delete(confirmationHandle);
      throw error;
    }
  }
  async controlConfirmation(session, params) {
    this.checkSession(session);
    const record = this.confirmations.get(params.confirmationHandle);
    if (
      !record ||
      record.session !== session ||
      !['switch', 'confirm', 'cancel'].includes(params.kind)
    )
      throw fail('ASSIST_CONFIRMATION_UNAVAILABLE');
    const page = await this.page(session, record.pageHandle);
    const view = await this.confirmationCommand(page, { action: params.kind, token: record.token });
    if (params.kind !== 'switch') this.confirmations.delete(params.confirmationHandle);
    if (params.kind === 'cancel') return { cancelled: true };
    await this.page(session, record.pageHandle);
    const saved = this.captures.get(record.captureHandle);
    if (!saved || !view || view.token !== record.token) throw fail('ASSIST_CAPTURE_UNAVAILABLE');
    const table = saved.capture.tables.find((row) => row.id === view.id);
    if (!table) throw fail('ASSIST_CAPTURE_UNAVAILABLE');
    if (params.kind === 'switch') return { confirmationHandle: record.token, confirmation: view };
    const fresh = await this.tables(session, {
      pageHandle: record.pageHandle,
      minimumRows: 1,
      headers: table.headers,
      selectors: [table.dom_path],
    });
    const current = fresh.tables.find((row) => row.dom_path === table.dom_path);
    if (
      !current ||
      JSON.stringify(current.headers) !== JSON.stringify(table.headers) ||
      JSON.stringify(current.rows) !== JSON.stringify(table.rows)
    )
      throw fail('ASSIST_TABLE_CHANGED');
    return {
      confirmed: true,
      table: current,
      url: page.url,
      documentId: page.documentId,
      format: view.format,
      all: view.all,
    };
  }
  handles(message) {
    return message?.type === 'copilot.table_confirmation' && this.confirmations.has(message.token);
  }
  async handleEvent(message, sender, publish) {
    const record = this.confirmations.get(message.token);
    const page = record && this.pages.get(record.pageHandle);
    if (
      !page ||
      sender.tab?.id !== page.tabId ||
      sender.documentId !== page.documentId ||
      sender.frameId !== 0
    )
      throw fail('ASSIST_UNTRUSTED_CONFIRMATION');
    const result = await this.controlConfirmation(record.session, {
      confirmationHandle: record.token,
      kind: message.kind === 'removed' ? 'cancel' : message.kind,
    });
    this.checkSession(record.session);
    await publish(record.session, {
      type: 'table_confirmation',
      confirmationHandle: record.token,
      kind: message.kind,
      ...result,
    });
    return result;
  }
  revoke(session) {
    this.revoked.add(session);
    for (const [handle, capture] of this.captures)
      if (capture.session === session) this.captures.delete(handle);
    for (const [handle, confirmation] of this.confirmations)
      if (confirmation.session === session) {
        const page = this.pages.get(confirmation.pageHandle);
        this.confirmations.delete(handle);
        if (page)
          void this.confirmationCommand(page, { action: 'cancel', token: handle }).catch(() => {});
      }
    for (const [handle, page] of this.pages)
      if (page.session === session) this.pages.delete(handle);
  }
}
