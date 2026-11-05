// 中文注释：工作窗口仅由本扩展创建，以固定的扩展首页验证身份，避免重启后复用用户窗口编号。
export const INPUT_ACTIONS = new Set([
  'click',
  'fill',
  'press',
  'ref_click',
  'ref_fill',
  'ref_press',
  'ref_set_checked',
  'ref_select_option',
  'interaction.click',
  'interaction.drag_coordinates',
  'interaction.drag_elements',
  'scroll',
]);
const KEY = 'fast.workWindow.v1';
// 已在 macOS Edge 的无扩展浏览器中复现。只提示已知风险，不改变网址、权限或执行结果。
export function withBackgroundFocusNotice(
  receipt,
  url,
  userAgent = globalThis.navigator?.userAgent || '',
) {
  if (!/\bEdg\//.test(userAgent) || !/Macintosh|Mac OS X/.test(userAgent)) return receipt;
  let target;
  try {
    target = new URL(url);
  } catch {
    return receipt;
  }
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (target.protocol !== 'http:' || !loopback) return receipt;
  return {
    ...receipt,
    backgroundFocus: {
      code: 'EDGE_LOOPBACK_FOCUS_RISK',
      guaranteed: false,
      message: 'Edge 访问本地 HTTP 地址可能切走桌面焦点；任务继续执行，无法保证静默。',
    },
  };
}

// 中文注释：只接受已由执行器核对过的任务页；返回置前期间的可见性和恢复结果。
export async function focusTaskWindow(api, tabId, windowId, guard, { restore = true, holdMs = 1000, groupId, restoreOnFailure = false } = {}) {
  if (typeof restore !== 'boolean' || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 15000)
    throw Object.assign(Error('INVALID_FOCUS_OPTIONS'), { preDispatch: true });
  let previous;
  try { previous = await api.windows.getLastFocused(); }
  catch { previous = null; }
  guard();
  const previousWindowId = previous?.focused && Number.isInteger(previous.id) ? previous.id : null;
  // 中文注释：其他应用由原生宿主恢复；浏览器无法识别时仍允许置前。
  let attempted = false, succeeded = false, result, restored = false, restoreReason = restore && previousWindowId === null ? 'previous_window_unavailable' : null;
  try {
    guard();
    const tab = await api.tabs.get(tabId); guard();
    if (tab.windowId !== windowId || (groupId !== undefined && tab.groupId !== groupId))
      throw Object.assign(Error('FOCUS_WINDOW_DENIED'), { preDispatch: true });
    attempted = true;
    await api.tabs.update(tabId, { active: true }); guard();
    const selected = await api.tabs.get(tabId); guard();
    if (selected.windowId !== windowId || (groupId !== undefined && selected.groupId !== groupId))
      throw Error('FOCUS_WINDOW_CHANGED');
    if (previousWindowId !== null) {
      const current = await api.windows.getLastFocused(); guard();
      if (current?.id !== previousWindowId || current.focused !== true) throw Error('FOCUS_WINDOW_CHANGED');
    }
    await api.windows.update(windowId, { focused: true }); guard();
    const deadline = Date.now() + 2000;
    while (true) {
      const win = await api.windows.get(windowId); guard();
      const check = await api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'document.visibilityState', returnByValue: true,
      }); guard();
      if (check?.exceptionDetails || !['visible', 'hidden'].includes(check?.result?.value))
        throw Error('FOCUS_VISIBILITY_UNAVAILABLE');
      result = { focused: win.focused === true, visible: check.result.value === 'visible', previousWindowId };
      if (result.focused && result.visible || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50)); guard();
    }
    if (holdMs) { await new Promise(resolve => setTimeout(resolve, holdMs)); guard(); }
    if (restoreOnFailure && (!result.focused || !result.visible)) throw Error('FOCUS_VISIBILITY_UNAVAILABLE');
    succeeded = true;
  } finally {
    if ((restore || (restoreOnFailure && !succeeded)) && attempted && previousWindowId !== null && previousWindowId !== windowId) {
      try {
        const current = await api.windows.getLastFocused();
        // 中文注释：用户主动切走时尊重其选择，不重新抢回焦点。
        if (current?.id === windowId && current.focused === true) {
          await api.windows.get(previousWindowId);
          await api.windows.update(previousWindowId, { focused: true });
          restored = (await api.windows.get(previousWindowId)).focused === true;
          if (!restored) restoreReason = 'restore_unverified';
        } else restoreReason = 'focus_changed';
      } catch { restoreReason = 'restore_failed'; }
    } else if (restore && previousWindowId === windowId) restored = true;
  }
  return { ...result, restored, ...(restoreReason ? { restoreReason } : {}) };
}
export class WorkWindow {
  constructor(api, { incognito = false, scope = null } = {}) {
    this.api = api;
    this.incognito = incognito;
    this.scope = scope;
    this.key = `${incognito ? `${KEY}.incognito` : KEY}${scope ? `.${encodeURIComponent(scope)}` : ''}`;
    this.pending = null;
    this.windowId = null;
    this.tails = new Map();
    this.owners = new Map();
    this.lifecycle = Promise.resolve();
  }
  // 中文注释：窗口创建与空窗口回收共用队列，避免关闭检查和新任务创建交错。
  enqueue(work) {
    const next = this.lifecycle.catch(() => {}).then(work);
    this.lifecycle = next.catch(() => {});
    return next;
  }
  retain(owner, windowId) {
    this.owners.set(owner, windowId);
  }
  async ensure(owner) {
    if (owner !== undefined) this.retain(owner, null);
    try {
      const windowId = await this.ensureWindow();
      if (owner !== undefined) this.retain(owner, windowId);
      return windowId;
    } catch (error) {
      if (owner !== undefined) this.owners.delete(owner);
      throw error;
    }
  }
  async ensureWindow() {
    if (this.pending) return this.pending;
    this.pending = this.enqueue(() => this.resolve());
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  // 中文注释：spanning 扩展页不能作为无痕窗口主框架，使用固定且不联网的占位页。
  marker() {
    const suffix = this.scope ? `#task=${encodeURIComponent(this.scope)}` : '';
    return this.incognito
      ? `data:text/html,<title>Fast-browser-link</title><p>Fast-browser-link incognito workspace</p>${suffix}`
      : `${this.api.runtime.getURL('work-window.html')}${suffix}`;
  }
  async resolve() {
    const marker = this.marker();
    if (this.incognito && !(await this.api.extension?.isAllowedIncognitoAccess()))
      throw Object.assign(Error('请在浏览器扩展设置中开启允许无痕模式访问'), {
        code: 'incognito_access_required',
        preDispatch: true,
      });
    const stored = (await this.api.storage.local.get(this.key))[this.key];
    if (Number.isInteger(stored?.windowId) && Number.isInteger(stored?.tabId)) {
      try {
        const tab = await this.api.tabs.get(stored.tabId);
        const win = await this.api.windows.get(stored.windowId);
        if (tab.windowId === win.id && tab.url === marker && !!win.incognito === this.incognito) {
          this.windowId = win.id;
          return win.id;
        }
      } catch {
        /* 中文注释：已关闭的工作窗口下次建页时重建，不恢复用户拖走的标签。 */
      }
    }
    // 中文注释：浏览器恢复会改变窗口和标签编号；用完整扩展首页地址查找已有窗口，再更新编号。
    const markers = await this.api.tabs.query(this.incognito ? {} : { url: marker });
    for (const tab of markers) {
      if (tab.url !== marker || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId))
        continue;
      const win = await this.api.windows.get(tab.windowId);
      if (win.type !== 'normal' || !!win.incognito !== this.incognito) continue;
      this.windowId = win.id;
      await this.api.storage.local.set({ [this.key]: { windowId: win.id, tabId: tab.id } });
      return win.id;
    }
    const win = await this.api.windows.create({
      url: marker,
      type: 'normal',
      focused: false,
      state: 'normal',
      ...(this.incognito ? { incognito: true } : {}),
    });
    const tab = win.tabs?.[0];
    if (
      !Number.isInteger(win.id) ||
      !Number.isInteger(tab?.id) ||
      !!win.incognito !== this.incognito
    )
      throw Error('WORK_WINDOW_UNAVAILABLE');
    this.windowId = win.id;
    await this.api.storage.local.set({ [this.key]: { windowId: win.id, tabId: tab.id } });
    return win.id;
  }
  // 中文注释：只删除已记录的扩展首页；有其他任务、结果页或用户页时保留窗口，绝不整窗删除。
  closeIdle(owner, windowId, { timeoutMs = 2000, canDelete, keepTabIds = [] } = {}) {
    this.owners.delete(owner);
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 2000));
    const idle = () =>
      Date.now() < deadline &&
      !this.tails.has(windowId) &&
      ![...this.owners.values()].some((id) => id === null || id === windowId);
    return this.enqueue(async () => {
      if (!idle()) return;
      const stored = (await this.api.storage.local.get(this.key))[this.key];
      if (
        !idle() ||
        stored?.windowId !== windowId ||
        !Number.isInteger(stored.tabId) ||
        keepTabIds.includes(stored.tabId)
      )
        return;
      const tabs = await this.api.tabs.query({ windowId });
      if (tabs.length !== 1 || tabs[0].id !== stored.tabId || tabs[0].url !== this.marker()) return;
      const tab = await this.api.tabs.get(stored.tabId);
      if (
        !idle() ||
        tab.windowId !== windowId ||
        tab.url !== tabs[0].url ||
        (canDelete && canDelete(tab.id) !== true)
      )
        return;
      await this.api.tabs.remove(tab.id);
      if (this.windowId === windowId) this.windowId = null;
      await this.api.storage.local.set({ [this.key]: null });
    });
  }
  // 中文注释：独立工作窗口内串行切换任务页，不改变系统前台窗口。
  async input(windowId, tabId, guard, work) {
    const previous = this.tails.get(windowId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        guard();
        const tab = await this.api.tabs.get(tabId);
        guard();
        if (tab.windowId !== windowId)
          throw Object.assign(Error('WORK_WINDOW_CHANGED'), { preDispatch: true });
        if (!tab.active) {
          await this.api.tabs.update(tabId, { active: true });
          guard();
        }
        guard();
        return work();
      });
    const settled = next.catch(() => {});
    this.tails.set(windowId, settled);
    try {
      return await next;
    } finally {
      if (this.tails.get(windowId) === settled) this.tails.delete(windowId);
    }
  }
}
