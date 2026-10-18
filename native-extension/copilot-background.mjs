import { BRAND_CSS } from './brand.mjs';
import { SessionRetry } from './copilot-retry.mjs';
import { tableConfirmation } from './copilot-table-confirm.mjs';
import { collectToolReport } from './copilot-tool-reports.mjs';
import { collectBrowserData } from './copilot-browser-data.mjs';
import { captureTables, tableRowKey, tableIdentity } from './copilot-tables.mjs';
import { TableJobs } from './copilot-table-job.mjs';
import { ordinaryPage, appendStep, safeURL, pageIdentity } from './copilot-observation.mjs';
import { redactPageText } from '../page-semantics/redact.mjs';
export function capabilityTables(tables) {
  const result = [];
  for (const table of tables.slice(0, 3)) {
    const summary = {
      headers: table.headers.slice(0, 40).map((header) => redactPageText(header).slice(0, 100)),
      rows: table.rows.length,
      samples: [],
    };
    result.push(summary);
    if (new TextEncoder().encode(JSON.stringify(result)).length > 2400) {
      result.pop();
      break;
    }
    for (const row of table.rows.slice(0, 10)) {
      summary.samples.push(
        row.slice(0, summary.headers.length).map((cell) => ({
          text: redactPageText(typeof cell === 'string' ? cell : cell.text || '').slice(0, 80),
        })),
      );
      if (new TextEncoder().encode(JSON.stringify(result)).length > 2400) {
        summary.samples.pop();
        break;
      }
    }
  }
  return result;
}
export class CopilotBackground {
  constructor(api, request, isWorkTab = () => false, reconnect = async () => {}) {
    this.sessionRetry = new SessionRetry(async () => {
      const state = await this.request('settings', { enabled: true });
      await this.settings(state);
    });
    this.reconnectBridge = reconnect;
    this.protectedHosts = null;
    this.selectionPopup = true;
    this.tableHints = new Map();
    this.annotationProfiles = new Map();
    this.tableCaptures = new Map();
    this.tableEpochs = new Map();
    this.tableLoading = new Set();
    this.tableReceipts = new Map();
    this.tableTab = null;
    this.tableJobs = null;
    this.localJobs = new Map();
    this.api = api;
    this.request = request;
    this.liveWorkTab = isWorkTab;
    this.workspaceTabs = new Set();
    this.workspaceWindows = new Set();
    this.isWorkTab = (id) => this.liveWorkTab(id) || this.workspaceTabs.has(id);
    this.panelPorts = new Set();
    this.lastNavigation = new Map();
    this.enabled = false;
    this.showBall = true;
    this.trace = [];
    this.pages = new Map();
    this.rows = new Map();
    this.unread = new Set();
    this.suggestionsUnread = new Set();
    this.queue = Promise.resolve();
  }
  panel(sender) {
    return (
      sender?.id === this.api.runtime.id &&
      (sender.url === this.api.runtime.getURL('copilot-panel.html') ||
        sender.url?.startsWith(this.api.runtime.getURL('copilot-result.html') + '?'))
    );
  }
  collector(sender) {
    return (
      sender?.id === this.api.runtime.id &&
      sender.frameId === 0 &&
      Number.isInteger(sender.tab?.id) &&
      ordinaryPage(sender.url || '') &&
      !this.owned(sender.tab)
    );
  }
  attachTableAdapter(adapter) {
    this.dataAdapter = adapter;
    this.tableJobs = new TableJobs({
      ...adapter,
      upload: (table, format) => this.exportTable(table, format),
      progress: (job) => {
        if (job.status === 'executing') void this.request('table_activity', {}).catch(() => {});
        this.localJobs.set(job.id, job);
        void this.api.runtime.sendMessage({ type: 'copilot.tables_changed' }).catch(() => {});
        void this.notification({ type: 'local_progress' });
      },
    });
  }
  async exportTable(table, format) {
    const request = async (method, params) => {
      try {
        return await this.request(method, params);
      } catch {
        throw Object.assign(
          Error(
            {
              table_begin: '无法创建本机表格，请检查本机桥连接。',
              table_append: '表格数据未能传入本机，请重新识别后重试。',
              table_finish: '本机导出失败，请检查导出目录。',
            }[method],
          ),
          { tableError: true, stage: method },
        );
      }
    };
    const begin = await request('table_begin', {
      name: table.name,
      site: table.site,
      headers: table.headers,
    });
    let chunk = [],
      bytes = 2;
    const encoder = new TextEncoder();
    for (const row of table.rows) {
      const size = encoder.encode(JSON.stringify(row)).length;
      if (size + 2 > 200000) throw Error('单行内容超过本机分块限制');
      if (bytes + size + (chunk.length ? 1 : 0) > 200000) {
        await request('table_append', { id: begin.id, rows: chunk });
        chunk = [];
        bytes = 2;
      }
      bytes += size + (chunk.length ? 1 : 0);
      chunk.push(row);
    }
    if (chunk.length) await request('table_append', { id: begin.id, rows: chunk });
    return request('table_finish', {
      id: begin.id,
      format,
      pages: table.pages || 1,
      unit: table.unit || '页',
      partial: !!table.partial,
      reason: table.reason || '',
    });
  }
  async localCommand(name, params) {
    if (name === 'learn_current') {
      const [tab] = await this.api.tabs.query({ active: true, currentWindow: true });
      await this.refreshOwnership();
      if (!tab || this.owned(tab) || !ordinaryPage(tab.url)) throw Error('unsupported tool page');
      const [result] = await this.api.scripting.executeScript({
        target: { tabId: tab.id },
        func: captureTables,
      });
      return this.request('tool_learn_context', {
        url: tab.url,
        title: result.result.title || tab.title || '',
        tables: result.result.tables
          .slice(0, 3)
          .map((table) => ({ headers: table.headers, rows: table.rows.length })),
      });
    }
    if (name === 'recognize_tables') {
      const tabs = await this.api.tabs.query({ active: true, currentWindow: true }),
        tab = tabs[0];
      await this.refreshOwnership();
      if (!tab || this.owned(tab) || !ordinaryPage(tab.url || ''))
        throw Error('此页不支持表格读取');
      const epoch = this.tableEpochs.get(tab.id) || 0,
        captured = await this.api.scripting.executeScript({
          target: { tabId: tab.id },
          func: captureTables,
        });
      if (this.tableLoading.has(tab.id) || (this.tableEpochs.get(tab.id) || 0) !== epoch)
        throw Error('目标页面已变化');
      this.tableCaptures.set(tab.id, {
        ...captured[0].result,
        documentId: captured[0].documentId,
        epoch,
        incognito: !!tab.incognito,
      });
      this.tableTab = tab.id;
      void this.notification({ type: 'table_detected' });
    }
    if (name === 'open_result') {
      await this.request('result', { id: params.id });
      const url =
        this.api.runtime.getURL('copilot-result.html') + '?id=' + encodeURIComponent(params.id);
      if (params.popup === true)
        await this.api.windows.create({ url, type: 'popup', width: 1060, height: 820 });
      else await this.api.tabs.create({ url, active: false });
      return {};
    }
    if (name === 'table_state' || name === 'recognize_tables')
      return {
        saved: this.lastTableSaved || null,
        receipts: [...this.tableReceipts.values()],
        confirmation: this.tableConfirmation?.view || null,
        capture: this.tableCaptures.get(this.tableTab) || null,
        jobs: [...this.localJobs.values()],
      };
    if (name === 'confirm_table') return this.resolveTableConfirmation(params.kind, params.token);
    const capture = this.tableCaptures.get(this.tableTab),
      table = capture?.tables.find((item) => item.id === params.id);
    if (name === 'stop_table') {
      this.tableJobs?.stop(params.id);
      return {};
    }
    if (!table) throw Error('表格已变化，请重新识别');
    if (['save_table', 'copy_table', 'collect_table'].includes(name)) {
      const [active] = await this.api.tabs.query({ active: true, currentWindow: true });
      await this.refreshOwnership();
      if (
        !active ||
        active.id !== this.tableTab ||
        active.url !== capture.url ||
        this.owned(active)
      )
        throw Error('目标页面已变化');
      if (this.tableConfirmation)
        await this.resolveTableConfirmation('cancel', this.tableConfirmation.token);
      const token = crypto.randomUUID(),
        pending = {
          token,
          tab: active.id,
          url: capture.url,
          epoch: this.tableEpochs.get(active.id) || 0,
          capture: structuredClone(capture),
          name,
          format: name === 'copy_table' ? 'clipboard' : params.format || 'xlsx',
        };
      const [result] = await this.api.scripting.executeScript({
        target: { tabId: active.id },
        func: tableConfirmation,
        args: [
          {
            sharedCSS: BRAND_CSS,
            token,
            tables: capture.tables,
            index: capture.tables.indexOf(table),
            format: pending.format,
            all: name === 'collect_table',
            url: capture.url,
            language: this.locale || 'zh',
          },
        ],
      });
      if (
        this.tableLoading.has(active.id) ||
        (this.tableEpochs.get(active.id) || 0) !== pending.epoch
      ) {
        await this.api.scripting
          .executeScript({
            target: { tabId: active.id },
            func: tableConfirmation,
            args: [{ action: 'cancel', token }],
          })
          .catch(() => {});
        throw Error('目标页面已变化');
      }
      pending.view = result.result;
      this.tableConfirmation = pending;
      await this.tableConfirmationChanged();
      return { confirmation: pending.view };
    }
    throw Error('未知表格命令');
  }
  async tableConfirmationChanged() {
    await this.api.runtime.sendMessage({ type: 'copilot.tables_changed' }).catch(() => {});
  }
  invalidateTables(tabId) {
    this.tableEpochs.set(tabId, (this.tableEpochs.get(tabId) || 0) + 1);
    this.tableCaptures.delete(tabId);
    this.tableHints.delete(tabId);
    this.annotationProfiles.delete(tabId);
    if (this.tableConfirmation?.tab === tabId)
      void this.resolveTableConfirmation('cancel', this.tableConfirmation.token).catch(() => {});
    void this.tableConfirmationChanged();
  }
  async resolveTableConfirmation(kind, token) {
    const pending = this.tableConfirmation;
    if (!pending || token !== pending.token) throw Error('确认已失效');
    if (kind === 'removed' || kind === 'cancel') {
      this.tableConfirmation = null;
      try {
        await this.api.scripting.executeScript({
          target: { tabId: pending.tab },
          func: tableConfirmation,
          args: [{ action: 'cancel', token }],
        });
      } catch {}
      await this.tableConfirmationChanged();
      if (kind === 'removed')
        void this.api.runtime
          .sendMessage({ type: 'copilot.table_notice', removed: true })
          .catch(() => {});
      return { cancelled: true, removed: kind === 'removed' };
    }
    if (!['switch', 'confirm'].includes(kind)) throw Error('invalid confirmation');
    await this.refreshOwnership();
    const tab = await this.api.tabs.get(pending.tab);
    if (
      this.owned(tab) ||
      tab.url !== pending.url ||
      this.tableLoading.has(pending.tab) ||
      (this.tableEpochs.get(pending.tab) || 0) !== pending.epoch
    ) {
      await this.resolveTableConfirmation('cancel', token);
      throw Error('页面归属已变化');
    }
    let result;
    try {
      [result] = await this.api.scripting.executeScript({
        target: { tabId: pending.tab },
        func: tableConfirmation,
        args: [{ action: kind, token }],
      });
    } catch (error) {
      await this.resolveTableConfirmation('cancel', token);
      throw error;
    }
    const view = result.result;
    if (!view || view.token !== token) throw Error('目标已取消');
    if (kind === 'switch') {
      pending.view = view;
      await this.tableConfirmationChanged();
      return { confirmation: view };
    }
    this.tableConfirmation = null;
    await this.tableConfirmationChanged();
    const capture = pending.capture,
      table = capture.tables.find((row) => row.id === view.id);
    if (!table) throw Error('目标表格已变化，请重新识别');
    // 中文注释：复核沿用已确认的目标和列名提示，不能退回无提示的全页识别而误判自定义表格消失。
    const [fresh] = await this.api.scripting.executeScript({
      target: {
        tabId: pending.tab,
        ...(capture.documentId ? { documentIds: [capture.documentId] } : {}),
      },
      func: captureTables,
      args: [{ minimumRows: 1, headers: table.headers, selectors: [table.dom_path] }],
    });
    if (
      this.tableLoading.has(pending.tab) ||
      (this.tableEpochs.get(pending.tab) || 0) !== pending.epoch
    )
      throw Error('目标页面已变化');
    const current = fresh.result.tables.find((row) => row.dom_path === table.dom_path);
    if (
      !current ||
      JSON.stringify(current.headers) !== JSON.stringify(table.headers) ||
      current.rows.length !== table.rows.length ||
      current.rows.some((row, i) => tableRowKey(row) !== tableRowKey(table.rows[i]))
    ) {
      this.tableCaptures.set(pending.tab, {
        ...fresh.result,
        documentId: fresh.documentId || capture.documentId,
        epoch: pending.epoch,
        incognito: !!capture.incognito,
      });
      await this.tableConfirmationChanged();
      throw Error(
        !current
          ? '目标表格位置已变化，请选择更新后的表格。'
          : JSON.stringify(current.headers) !== JSON.stringify(table.headers)
            ? '表头已变化，请选择更新后的表格。'
            : '表格内容已变化，请查看更新后的表格再保存。',
      );
    }
    if (pending.name === 'copy_table')
      return {
        clipboard: [table.headers, ...table.rows.map((row) => row.map((cell) => cell.text))]
          .map((row) =>
            row.map((value) => value.replaceAll('\t', ' ').replaceAll('\n', ' ')).join('\t'),
          )
          .join('\n'),
      };
    if (pending.name === 'save_table') {
      const result = await this.exportTable(
        {
          name: table.name,
          site: new URL(capture.url).hostname,
          headers: table.headers,
          rows: table.rows,
          pages: 1,
          partial: table.incomplete,
        },
        pending.format,
      );
      this.lastTableSaved = {
        key: capture.url + '|' + table.id,
        identity: tableIdentity(capture, table),
        result,
      };
      if (!result.error && result.files?.length) {
        this.tableReceipts.set(result.id, this.lastTableSaved);
        if (this.tableReceipts.size > 100)
          this.tableReceipts.delete(this.tableReceipts.keys().next().value);
      }
      await this.tableConfirmationChanged();
      return result;
    }
    if (!this.tableJobs) throw Error('工作区尚未连接');
    const state = await this.request('state', {}),
      id = crypto.randomUUID();
    void this.tableJobs
      .run(
        id,
        capture,
        table,
        state.table_config,
        true,
        table.pagination.totalPages || state.table_config.max_pages,
      )
      .catch(() => {});
    return { id };
  }
  owned(tab) {
    return this.isWorkTab(tab.id) || this.workspaceWindows.has(tab.windowId);
  }
  async foreground(tabId) {
    const [tab] = await this.api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id !== tabId || this.owned(tab) || !ordinaryPage(tab.url || '')) return null;
    const window = await this.api.windows.get(tab.windowId);
    return window.focused ? tab : null;
  }
  async refreshOwnership() {
    const saved = await this.api.storage.local.get([
      'fast.backgroundWorkspaces.v1',
      'fast.workWindow.v1',
      'fast.workWindow.v1.incognito',
    ]);
    const windows = [];
    for (const key of ['fast.workWindow.v1', 'fast.workWindow.v1.incognito']) {
      const marker = saved[key];
      if (!Number.isInteger(marker?.windowId) || !Number.isInteger(marker?.tabId)) continue;
      let tab;
      try {
        tab = await this.api.tabs.get(marker.tabId);
      } catch (error) {
        if (new RegExp('^No tab with id: ?' + marker.tabId + '\\.?$').test(error.message)) continue;
        throw error;
      }
      if (
        tab.windowId === marker.windowId &&
        (tab.url === this.api.runtime.getURL('work-window.html') ||
          tab.url?.startsWith('data:text/html,<title>Fast-browser-link</title>'))
      )
        windows.push(marker.windowId);
    }
    this.workspaceWindows = new Set(windows);
    this.workspaceTabs = new Set(
      (saved['fast.backgroundWorkspaces.v1']?.tasks || [])
        .flatMap(([, task]) => (task.requests || []).map(([, request]) => request.tabId))
        .filter(Number.isInteger),
    );
  }
  async synchronize() {
    let state = await this.request('state', {});
    const saved = await this.api.storage.session.get('copilotBridgeEnabled');
    if (
      saved.copilotBridgeEnabled &&
      !state.enabled &&
      !state.startup_error &&
      !state.bridge_recovery_blocked
    )
      state = await this.request('settings', { enabled: true });
    await this.api.storage.session.set({ copilotBridgeEnabled: false });
    this.trace = (await this.api.storage.session.get('copilotTrace')).copilotTrace || [];
    this.rows = new Map(state.suggestions.map((row) => [row.id, row]));
    await this.settings(state);
    return state;
  }
  async settings(state) {
    this.locale = state.locale;
    this.agent = state.agent;
    this.boardName = state.board_name;
    this.hermesHealth =
      state.hermes_health ||
      (state.startup_error
        ? {
            state: 'error',
            reason: state.startup_error.reason,
            reason_en: state.startup_error.reason_en,
          }
        : this.hermesHealth);
    const started = !this.enabled && state.enabled;
    this.protectedHosts = state.protected_hosts || this.protectedHosts || [];
    await this.refreshOwnership();
    if (this.enabled && !state.enabled && this.tableConfirmation)
      await this.resolveTableConfirmation('cancel', this.tableConfirmation.token);
    if (this.enabled && !state.enabled) {
      this.tableCaptures.clear();
      this.tableTab = null;
      this.lastTableSaved = null;
    }
    this.enabled = state.enabled === true;
    this.showBall = state.show_ball !== false;
    this.selectionPopup = state.selection_popup !== false;
    this.pageAnnotations = state.page_annotations !== false;
    this.annotationDensity = state.annotation_density || 'compact';
    const scripts = await this.api.scripting.getRegisteredContentScripts({ ids: ['copilot'] });
    if (this.enabled && !scripts.length)
      await this.api.scripting.registerContentScripts([
        {
          id: 'copilot',
          matches: ['http://*/*', 'https://*/*'],
          js: ['copilot-entry.js'],
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: false,
        },
      ]);
    if (!this.enabled && scripts.length)
      await this.api.scripting.unregisterContentScripts({ ids: ['copilot'] });
    const tabs = await this.api.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => ordinaryPage(tab.url || ''))
        .map(async (tab) => {
          if (!this.enabled || this.owned(tab)) {
            await this.api.tabs.sendMessage(tab.id, { type: 'copilot.teardown' }).catch(() => {});
            return;
          }
          try {
            await this.api.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['copilot-entry.js'],
            });
            await this.api.tabs.sendMessage(tab.id, {
              type: 'copilot.visibility',
              visible: this.showBall,
            });
            await this.api.tabs.sendMessage(tab.id, {
              type: 'copilot.selection_settings',
              enabled: this.selectionPopup,
            });
            await this.api.tabs.sendMessage(tab.id, {
              type: 'copilot.annotation_settings',
              enabled: this.pageAnnotations,
              density: this.annotationDensity,
              profiles: this.annotationProfiles?.get(tab.id) || [],
            });
          } catch {
            /* 中文注释：受限页保持不采集，不通过调试器绕过。 */
          }
        }),
    );
    if (started)
      void this.request('capability_state', {
        browser: /Edg\//.test(globalThis.navigator?.userAgent || '') ? 'edge' : 'chrome',
      }).catch(() => {});
    if (!this.enabled) {
      if (this.tableJobs) for (const id of this.tableJobs.jobs.keys()) this.tableJobs.stop(id);
      this.trace = [];
      this.pages.clear();
      await this.api.storage.session.remove('copilotTrace');
    }
  }
  async observation(sender, page, description, descriptions = []) {
    await this.refreshOwnership();
    if (
      !this.enabled ||
      !this.collector(sender) ||
      !page ||
      !ordinaryPage(page.url) ||
      typeof description !== 'string'
    )
      throw Error('采集已暂停或页面不可用');
    if (
      !Array.isArray(descriptions) ||
      descriptions.length > 30 ||
      descriptions.some((text) => typeof text !== 'string' || text.length > 300)
    )
      throw Error('操作序列超出预算');
    descriptions = descriptions.length ? descriptions : [description];
    if (safeURL(sender.url) !== page.url) throw Error('页面已导航，请重新采集');
    const current = await this.foreground(sender.tab.id);
    if (!current || safeURL(current.url) !== page.url) return { accepted: false };
    if (new TextEncoder().encode(JSON.stringify(page)).length > 6144)
      throw Error('页面快照超出预算');
    const previous = this.pages.get(sender.tab.id);
    if (description === '导航到新页面' && this.lastNavigation.get(sender.tab.id) === page.url)
      description = '页面显著变化';
    if (
      ['页面显著变化', '打开页面'].includes(description) &&
      this.currentPage === current.url &&
      pageIdentity(previous) === pageIdentity(page)
    )
      return { accepted: false };
    const signature = sender.tab.id + '|' + pageIdentity(page) + '|' + JSON.stringify(descriptions),
      at = Date.now();
    if (this.lastCapture?.signature === signature && at - this.lastCapture.at < 1000)
      return { accepted: false };
    this.lastCapture = { signature, at };
    this.lastNavigation.set(sender.tab.id, page.url);
    this.pages.set(sender.tab.id, page);
    for (const step of descriptions) this.trace = appendStep(this.trace, step, sender.tab.id, page);
    await this.api.storage.session.set({ copilotTrace: this.trace });
    this.currentPage = current.url;
    await this.request('page_context', {
      url: current.url,
      incognito: !!current.incognito,
      tab_id: current.id,
    });
    const capabilities = await this.request('capability_context', {
      browser: /Edg\//.test(globalThis.navigator?.userAgent || '') ? 'edge' : 'chrome',
      tables: capabilityTables(this.tableCaptures.get(sender.tab.id)?.tables || []),
    });
    this.tableHints.set(sender.tab.id, capabilities.table_hints || {});
    this.annotationProfiles.set(sender.tab.id, capabilities.annotation_profiles || []);
    await this.api.tabs
      .sendMessage(sender.tab.id, {
        type: 'copilot.annotation_settings',
        enabled: this.pageAnnotations !== false,
        density: this.annotationDensity || 'compact',
        profiles: capabilities.annotation_profiles || [],
      })
      .catch(() => {});
    const latest = await this.foreground(sender.tab.id);
    if (!latest || latest.url !== current.url) return { accepted: false };
    return this.request('observe', { trace: this.trace, page });
  }
  tabEvent(tabId, description, tab) {
    if (description === '关闭标签页') {
      this.pages.delete(tabId);
      this.invalidateTables(tabId);
      this.tableLoading.delete(tabId);
      if (this.tableTab === tabId) this.tableTab = null;
      return;
    }
    if (description === '导航到新页面') {
      this.invalidateTables(tabId);
      if (tab?.status === 'loading') this.tableLoading.add(tabId);
    }
    if (description === '页面加载完成') this.tableLoading.delete(tabId);
    if (description === '切换标签页') {
      this.tableTab = tabId;
      if (this.tableCaptures.get(tabId)?.url !== tab?.url) this.invalidateTables(tabId);
      void this.tableConfirmationChanged();
    }
    if (!this.enabled || this.isWorkTab(tabId)) return;
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await this.refreshOwnership();
        const current = await this.foreground(tabId);
        if (!current) return;
        if (['导航到新页面', '打开标签页', '切换标签页', '页面加载完成'].includes(description)) {
          await this.request('page_context', {
            url: current.url,
            incognito: !!current.incognito,
            tab_id: current.id,
          });
          await this.api.tabs
            .sendMessage(tabId, {
              type: description === '切换标签页' ? 'copilot.activated' : 'copilot.navigation',
            })
            .catch(() => {});
          return;
        }
        const page =
          this.pages.get(tabId) ||
          (ordinaryPage(tab?.url || '')
            ? { url: safeURL(tab.url), title: redactPageText(tab.title || ''), items: [] }
            : null);
        if (!page) return;
        this.trace = appendStep(this.trace, description, tabId, page);
        await this.api.storage.session.set({ copilotTrace: this.trace });
        await this.request('observe', { trace: this.trace, page });
        if (description === '关闭标签页') this.pages.delete(tabId);
      });
  }
  async browserResult(id, data) {
    const text = JSON.stringify(data);
    if (new TextEncoder().encode(text).length <= 120000)
      return this.request('browser_fetch_result', { id, data });
    for (let start = 0, index = 0; start < text.length; start += 40000, index++) {
      const response = await this.request('browser_fetch_chunk', {
        id,
        index,
        text: text.slice(start, start + 40000),
      });
      if (!response.accepted) return;
    }
    return this.request('browser_fetch_result', { id, data: { chunked: true } });
  }
  async notification(event) {
    if (event.type === 'logs') {
      await this.api.runtime.sendMessage({ type: 'copilot.logs', event }).catch(() => {});
      return;
    }
    if (event.type === 'browser_fetch') {
      const enabled = this.enabled;
      const collect = ['capability', 'capability_probe'].includes(event.kind)
        ? (adapter, event, permitted) =>
            collectToolReport(adapter, event, permitted, (params) =>
              this.request('capability_progress', params),
            )
        : collectBrowserData;
      void collect(
        this.dataAdapter,
        event,
        async () =>
          enabled &&
          this.enabled &&
          (await this.request('browser_fetch_status', { id: event.id })).allowed,
      )
        .then(
          (data) => this.browserResult(event.id, data),
          () => this.browserResult(event.id, { error: 'background_data_unavailable' }),
        )
        .catch(() => {});
      return;
    }

    if (event.type === 'add' || event.type === 'update') {
      const previous = this.rows.get(event.suggestion.id);
      this.rows.set(event.suggestion.id, event.suggestion);
      if (!this.panelPorts.size) {
        if (event.type === 'add' && event.suggestion.status === 'pending')
          this.suggestionsUnread.add(event.suggestion.id);
        if (event.suggestion.status === 'completed' && previous?.status !== 'completed')
          this.unread.add(event.suggestion.id);
      }
    }
    if (event.suggestion) void this.onActivity?.(event.suggestion);
    if (event.type === 'remove') {
      this.rows.delete(event.id);
      this.unread.delete(event.id);
      this.suggestionsUnread.delete(event.id);
    }
    if (
      (event.type === 'ready' && !this.sessionRetry.recovery) ||
      (event.type === 'inference' && event.succeeded === true)
    )
      this.sessionRetry.reset();
    if (event.type === 'settings' && event.enabled === false) {
      if (event.startup_error)
        event.startup_error.recovery_exhausted === true
          ? this.sessionRetry.reset()
          : this.sessionRetry.failed();
      else this.sessionRetry.reset();
    }
    if (event.type === 'settings')
      await this.settings({
        ...event,
        enabled: event.enabled ?? this.enabled,
        show_ball: event.show_ball ?? this.showBall,
      });
    void this.api.runtime.sendMessage({ type: 'copilot.changed', event }).catch(() => {});
    const tabs = await this.api.tabs.query({});
    await Promise.all(
      tabs
        .filter((t) => ordinaryPage(t.url || '') && !this.owned(t))
        .map(async (t) => {
          if (['update', 'basket'].includes(event.type))
            await this.api.tabs
              .sendMessage(t.id, { type: 'copilot.annotation_refresh' })
              .catch(() => {});
          await this.api.tabs
            .sendMessage(t.id, {
              type: 'copilot.selection_suggestions',
              suggestions: [...this.rows.values()].filter((row) => row.status === 'pending'),
            })
            .catch(() => {});
          return this.api.tabs
            .sendMessage(t.id, {
              type: 'copilot.badge',
              count: this.unread.size,
              suggestions: this.suggestionsUnread.size,
              running:
                [...this.rows.values()].filter((r) =>
                  ['queued', 'executing', 'stopping'].includes(r.status),
                ).length +
                [...this.localJobs.values()].filter((j) => j.status === 'executing').length,
              tables: this.tableCaptures.get(t.id)?.tables.length || 0,
              panel_open: this.panelPorts.size > 0,
            })
            .catch(() => {});
        }),
    );
  }
  attachPanel(port) {
    if (port.name !== 'copilot-panel' || !this.panel(port.sender)) return;
    this.panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      this.panelPorts.delete(port);
      if (!this.panelPorts.size)
        void this.request('suggestion_hold', { id: '', held: false }).catch(() => {});
    });
    this.unread.clear();
    this.suggestionsUnread.clear();
    void this.notification({ type: 'read' });
  }
  handle(message, sender, respond) {
    if (!message?.type?.startsWith('copilot.') || message.type === 'copilot.changed') return false;
    const content = this.collector(sender),
      panel = this.panel(sender);
    const popup =
      sender?.id === this.api.runtime.id && sender.url === this.api.runtime.getURL('popup.html');
    if (message.type === 'copilot.open' && ((content && this.enabled) || panel || popup)) {
      // 中文注释：在当前点击消息栈立即调用，不能先 await 存储或 Native RPC 消耗用户手势。
      try {
        Promise.resolve(
          this.api.sidePanel.open({
            windowId:
              sender.tab?.windowId ??
              (popup && Number.isInteger(message.windowId) ? message.windowId : undefined),
          }),
        ).then(
          () => respond({ result: { opened: true } }),
          () => respond({ result: { opened: false } }),
        );
      } catch {
        respond({ result: { opened: false } });
      }
      return true;
    }
    let work;
    if (content && message.type === 'copilot.table_confirmation_error') {
      work = this.api.runtime.sendMessage({ type: 'copilot.table_notice', failed: true });
    } else if (
      content &&
      message.type === 'copilot.table_confirmation' &&
      sender.tab.id === this.tableConfirmation?.tab
    ) {
      work = this.resolveTableConfirmation(message.kind, message.token);
    } else if (panel && message.type === 'copilot.reconnect') {
      work = this.reconnectBridge().then(() => this.request('state', {}));
    } else if (popup && message.type === 'copilot.fbl_fix') work = this.request('fbl_fix', {});
    else if (
      popup &&
      message.type === 'copilot.popup_settings' &&
      typeof message.enabled === 'boolean'
    ) {
      this.sessionRetry.reset();
      work = (async () => {
        if (message.enabled) {
          const catalog = await this.request('agent_catalog', {}),
            selected = catalog.agents?.find((agent) => agent.id === catalog.default_agent);
          if (
            catalog.onboarding_required ||
            !selected?.configured ||
            catalog.job?.status === 'pending'
          ) {
            await this.api.runtime
              .sendMessage({ type: 'copilot.agent_onboarding' })
              .catch(() => {});
            return { enabled: false, onboarding_required: true };
          }
        }
        const state = await this.request('settings', { enabled: message.enabled });
        await this.settings(state);
        return { enabled: state.enabled, agent: state.agent };
      })();
    } else if (content && this.enabled && message.type === 'copilot.selection') {
      if (message.command === 'open_capabilities') {
        try {
          void this.api.sidePanel.open({ windowId: sender.tab.windowId });
        } catch {}
      }
      if (message.command === 'open_cached') {
        try {
          void this.api.sidePanel.open({ windowId: sender.tab.windowId });
        } catch {}
      }
      work = this.refreshOwnership().then(async () => {
        if (this.owned(sender.tab)) throw Error('work page excluded');
        const params = message.params || {};
        if (message.command === 'selection_info') {
          await this.request('page_context', {
            url: sender.tab.url || sender.url,
            incognito: !!sender.tab.incognito,
          });
          await this.request('capability_context', {
            browser: /Edg\//.test(globalThis.navigator?.userAgent || '') ? 'edge' : 'chrome',
            tables: capabilityTables(this.tableCaptures.get(sender.tab.id)?.tables || []),
          });
          const info = await this.request('selection_info', params);
          return {
            ...info,
            suggestions: [
              ...(info.workflows || []),
              ...[...this.rows.values()].filter((row) => row.status === 'pending'),
            ],
          };
        }
        if (message.command === 'basket_add') {
          if (
            !Array.isArray(params.items) ||
            params.items.some((item) => !['keyword', 'domain', 'url'].includes(item.type))
          )
            throw Error('invalid basket object');
          return this.request('basket_add', {
            items: params.items.map((item) => ({ ...item, source: sender.tab.url || sender.url })),
          });
        }
        if (message.command === 'confirm_task')
          return this.request('execute', { id: params.id, confirmation: params.confirmation });
        if (message.command === 'selection_context')
          return this.request('selection_context', params);
        if (message.command === 'quick_task')
          return this.request('quick_task', {
            action: params.action,
            params: params.params,
            context: { url: sender.tab.url || sender.url, incognito: !!sender.tab.incognito },
          });
        if (message.command === 'open_capabilities') return this.request('capability_focus', {});
        if (message.command === 'open_cached')
          return this.request('focus_result', { id: params.id });
        if (message.command === 'selection_error')
          return this.request('selection_context', { text: params.text });
        throw Error('unknown selection command');
      });
    } else if (content && this.enabled && message.type === 'copilot.annotation_lookup') {
      work = this.refreshOwnership().then(() => {
        if (this.owned(sender.tab) || sender.url !== sender.tab.url)
          throw Error('work page excluded');
        return this.request('annotation_lookup', message.params || {});
      });
    } else if (content && message.type === 'copilot.tables') {
      const epoch = this.tableEpochs.get(sender.tab.id) || 0;
      work = this.refreshOwnership().then(async () => {
        const tab = await this.foreground(sender.tab.id);
        if (
          !tab ||
          this.tableLoading.has(tab.id) ||
          (this.tableEpochs.get(tab.id) || 0) !== epoch ||
          message.capture?.url !== sender.url ||
          tab.url !== message.capture.url
        )
          throw Error('页面范围已变化');
        this.tableCaptures.set(tab.id, {
          ...message.capture,
          documentId: sender.documentId,
          epoch,
          incognito: !!tab.incognito,
        });
        if (!tab.incognito)
          void this.request('fbl_layout', {
            url: message.capture.url,
            tables: message.capture.tables.slice(0, 3).map((table) => ({ headers: table.headers })),
          })
            .then((result) => {
              if (result.found) return this.api.runtime.sendMessage({ type: 'copilot.new_tool' });
            })
            .catch(() => {});
        void this.request('log_client', {
          event: 'table',
          tables: message.capture.tables.length,
          rows: message.capture.tables.reduce((count, table) => count + table.rows.length, 0),
        }).catch(() => {});
        this.tableTab = tab.id;
        void this.notification({ type: 'table_detected' });
        void this.tableConfirmationChanged();
        return {};
      });
    } else if (panel && message.type === 'copilot.local')
      work = this.localCommand(message.command, message.params || {});
    else if (
      sender?.id === this.api.runtime.id &&
      Number.isInteger(sender.tab?.id) &&
      message.type === 'copilot.collector_state'
    )
      work = this.refreshOwnership()
        .then(() => this.api.storage.local.get('copilotBallPosition'))
        .then(async (saved) => ({
          enabled: this.enabled && !this.owned(sender.tab),
          observing: !!(await this.foreground(sender.tab.id)),
          table_hints: this.tableHints.get(sender.tab.id) || {},
          page_annotations: this.pageAnnotations !== false,
          annotation_density: this.annotationDensity || 'compact',
          annotation_profiles: this.annotationProfiles.get(sender.tab.id) || [],
          selection_popup: this.selectionPopup,
          show_ball: this.showBall,
          position: saved.copilotBallPosition,
          panel_open: this.panelPorts.size > 0,
        }));
    else if (
      content &&
      message.type === 'copilot.position' &&
      Number.isFinite(message.x) &&
      Number.isFinite(message.y)
    )
      work = this.api.storage.local.set({
        copilotBallPosition: {
          x: Math.max(0, Math.min(1, message.x)),
          y: Math.max(0, Math.min(1, message.y)),
        },
      });
    else if (content && message.type === 'copilot.panel_status')
      work = Promise.resolve({ open: this.panelPorts.size > 0 });
    else if (content && this.enabled && message.type === 'copilot.observe') {
      this.queue = this.queue
        .catch(() => {})
        .then(() =>
          this.observation(sender, message.page, message.description, message.descriptions),
        );
      work = this.queue;
    } else if (content && this.enabled && message.type === 'copilot.mini')
      work = Promise.resolve({
        suggestions: [...this.rows.values()].filter((row) => row.status === 'pending'),
      });
    else if (content && this.enabled && message.type === 'copilot.hide_ball')
      work = this.request('settings', { show_ball: false }).then((state) => this.settings(state));
    else if (
      panel &&
      message.type === 'copilot.command' &&
      [
        'agent_catalog',
        'agent_setup_start',
        'agent_setup_status',
        'agent_setup_cancel',
        'agent_select',
        'work_update',
        'memory',
        'feedback',
        'basket_state',
        'basket_add',
        'basket_remove',
        'basket_clear',
        'basket_plan',
        'basket_execute',
        'fbl_readiness',
        'fbl_pack_state',
        'fbl_pack_install',
        'fbl_pack_remove',
        'fbl_fix',
        'fbl_discover',
        'fbl_confirm',
        'preferences',
        'directory_defaults',
        'directory_choose_start',
        'directory_choose_status',
        'directory_choose_cancel',
        'directory_open_logs',
        'logs_read',
        'logs_clear',
        'logs_export',
        'log_client',
        'capability_state',
        'capability_reload',
        'capability_health',
        'capability_discover',
        'capability_bind',
        'tool_learn_context',
        'tool_draft',
        'tool_save',
        'locale',
        'quick_task',
        'selection_context',
        'open_result',
        'export_results',
        'result',
        'clear_read',
        'batch',
        'replenish',
        'next_action',
        'table_begin',
        'table_append',
        'table_finish',
        'table_read',
        'table_column_action',
        'table_open',
        'models',
        'configure',
        'state',
        'settings',
        'execute',
        'ignore',
        'stop',
        'open_report',
        'save_result',
        'followup',
        'retry',
        'retry_inference',
        'suggestion_hold',
      ].includes(message.command)
    ) {
      if (message.command === 'settings' && typeof message.params?.enabled === 'boolean')
        this.sessionRetry.reset();
      work = (
        message.command === 'open_result'
          ? this.localCommand('open_result', message.params || {})
          : this.request(message.command, message.params || {})
      ).then(async (state) => {
        if (message.command === 'settings' || message.command === 'preferences')
          await this.settings(state);
        if (state.hermes_health) this.hermesHealth = state.hermes_health;
        if (state.protected_hosts) this.protectedHosts = state.protected_hosts;
        if (state.suggestions) {
          this.rows = new Map(state.suggestions.map((row) => [row.id, row]));
          this.unread.clear();
          this.suggestionsUnread.clear();
        }
        return state;
      });
    } else return false;
    Promise.resolve(work).then(
      (result) => respond({ result }),
      (error) => {
        if (message.type === 'copilot.local' || message.type === 'copilot.table_confirmation') {
          const known = [
            '确认已失效',
            '页面归属已变化',
            '目标页面已变化',
            '目标表格已变化，请重新识别',
            '目标表格位置已变化，请选择更新后的表格。',
            '表头已变化，请选择更新后的表格。',
            '表格内容已变化，请查看更新后的表格再保存。',
            '目标已取消',
            '表格已变化，请重新识别',
            '单行内容超过本机分块限制',
            '工作区尚未连接',
          ];
          const detail =
            error.tableError || known.includes(error.message)
              ? error.message
              : '无法确认目标表格，请重新识别后重试。';
          respond({
            error: detail,
            code: 'table_operation_failed',
            ...(error.stage ? { stage: error.stage } : {}),
          });
          return;
        }
        respond({
          error:
            {
              'collaboration not ready; suggestion retained':
                '协作会话尚未就绪，请等待连接完成后执行。',
              'suggestion unavailable': '建议已随当前页面更新，请执行当前卡片。',
              'invalid suggestion transition': '任务状态已变化，请查看进行中或结果。',
            }[error.message] || '协作连接或请求失败，请检查本地配置并刷新侧栏。',
        });
      },
    );
    return true;
  }
}
