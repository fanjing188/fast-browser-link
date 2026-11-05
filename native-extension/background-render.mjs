// 中文注释：锁屏实测焦点模拟、生命周期和 screencast 均无效；三个候选保持默认关闭。
export const BACKGROUND_RENDER_STRATEGY = null;

export class BackgroundRender {
  constructor(api, strategy = BACKGROUND_RENDER_STRATEGY) {
    this.api = api;
    this.strategy = strategy;
    this.sessions = new Map();
  }
  focusValue(tabId) { return this.sessions.get(tabId)?.strategy === 'focus'; }
  isScreencasting(tabId) { return this.sessions.get(tabId)?.strategy === 'screencast'; }
  async enable(tabId) {
    if (!this.strategy || this.sessions.has(tabId)) return;
    const target = { tabId }, api = this.api;
    let listener;
    if (this.strategy === 'focus')
      await api.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    else if (this.strategy === 'lifecycle')
      await api.debugger.sendCommand(target, 'Page.setWebLifecycleState', { state: 'active' });
    else if (this.strategy === 'screencast') {
      listener = (source, method, params) => {
        if (source.tabId === tabId && !source.sessionId && method === 'Page.screencastFrame')
          void api.debugger.sendCommand(target, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      };
      api.debugger.onEvent.addListener(listener);
      // 中文注释：首帧可能早于 startScreencast 的回执，先登记以阻止画面进入 CDP 事件日志。
      this.sessions.set(tabId, { strategy: this.strategy, listener });
      try { await api.debugger.sendCommand(target, 'Page.startScreencast', { everyNthFrame: 1 }); }
      catch (error) { this.sessions.delete(tabId); api.debugger.onEvent.removeListener(listener); throw error; }
    } else throw Error('INVALID_BACKGROUND_RENDER_STRATEGY');
    this.sessions.set(tabId, { strategy: this.strategy, listener });
  }
  async close(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.strategy === 'screencast')
      await this.api.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
    if (session.strategy === 'focus')
      await this.api.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    this.sessions.delete(tabId);
    if (session.listener) this.api.debugger.onEvent.removeListener(session.listener);
  }
}
