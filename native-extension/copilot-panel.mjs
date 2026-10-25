import { SettingsTabs } from './copilot-settings-tabs.mjs';
import { WorkbenchPanel } from './copilot-workbench.mjs';
import { BasketPanel } from './copilot-basket.mjs';
import { renderReadiness } from './copilot-readiness.mjs';
import { mountControls, boardName, renderConnection } from './copilot-controls.mjs';
import { LogPanel } from './copilot-logs.mjs';
import { TaskLogPanel } from './copilot-task-logs.mjs';
import { PacksPanel } from './copilot-packs-panel.mjs';
import { CapabilitiesPanel } from './copilot-capabilities-panel.mjs';
import { localize } from './copilot-i18n.mjs';
import { TablePanel } from './copilot-table-panel.mjs';
import { SettingsForm } from './copilot-settings.mjs';
import { AgentPanel } from './copilot-agent-panel.mjs';
import { renderDashboard, PanelViews, showTaskConfirmation } from './copilot-view.mjs';
const settingsTabs = new SettingsTabs(document);
const uiDoc = settingsTabs.document;
const controls = mountControls(uiDoc);
let state = null,
  revision = 0,
  agentStarting = false;
const uiLanguage = chrome.i18n?.getUILanguage?.() || navigator.language;
uiDoc.title = boardName('', uiLanguage);
uiDoc.getElementById('board-name').textContent = uiDoc.title;
const logs = new LogPanel(uiDoc, command, {
  language: uiLanguage,
  download: async (text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    try {
      await chrome.downloads.download({
        url,
        filename: 'fast-browser-link-logs-' + new Date().toISOString().slice(0, 10) + '.jsonl',
        saveAs: true,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  },
});
const views = new PanelViews(uiDoc, (name) => {
  logs.active = name === 'logs';
  if (name === 'logs') void logs.load().then(() => logs.latest());
  if (name === 'plugins') void plugins.refresh();
  if (name === 'settings') {
    settingsTabs.localize();
    void settings.load();
    void agents.refresh({ autoOpen: false });
  }
});
const taskLogs = new TaskLogPanel(uiDoc, command, { language: uiLanguage });
const capabilities = new CapabilitiesPanel(
  uiDoc,
  async (name, params = {}) => {
    if (name === 'learn_current') {
      const response = await chrome.runtime.sendMessage({
        type: 'copilot.local',
        command: name,
        params,
      });
      if (response?.error) throw Error(response.error);
      return response.result;
    }
    return command(name, params);
  },
  { language: chrome.i18n?.getUILanguage?.() || navigator.language },
);
const settings = new SettingsForm(uiDoc, command, {
  explicitSave: true,
  revealField: (field) => settingsTabs.reveal(field),
});
const agents = new AgentPanel(uiDoc, command, {
  language: uiLanguage,
  onChange: () => render(),
  onEnable: () => enableCollaboration(),
});
settings.bindAgent(agents);
async function enableCollaboration() {
  if (!(await agents.ensureReady())) return false;
  agentStarting = true;
  render();
  try {
    return await settings.enable();
  } finally {
    agentStarting = false;
    render();
  }
}
const plugins = new PacksPanel(uiDoc, command, {
  language: uiLanguage,
  onConfigure: (row) => {
    capabilities.capabilityValue = row.needs_setup?.[0] || row.capabilities?.[0] || '';
    return command('open_capabilities');
  },
});
for (const id of ['open-plugins', 'manage-plugins'])
  uiDoc.getElementById(id).onclick = () => views.show('plugins');
uiDoc.getElementById('plugins-refresh').onclick = () => plugins.refresh();
uiDoc.getElementById('plugins-bindings').onclick = () => command('open_capabilities');
chrome.runtime.onMessage.addListener((message) => {
  if (
    message.type === 'copilot.changed' &&
    message.event.type === 'capabilities' &&
    uiDoc.getElementById('functional-plugins').open
  )
    void plugins.refresh();
});
const basket = new BasketPanel(uiDoc, command, { language: uiLanguage });
const tables = new TablePanel(
  uiDoc,
  async (name, params = {}) => {
    if (['basket_add', 'table_open', 'table_column_action'].includes(name))
      return command(name, params);
    if (name === 'configuration') return state;
    const response = await chrome.runtime.sendMessage({
      type: 'copilot.local',
      command: name,
      params,
    });
    if (response?.error || !response?.result)
      throw Object.assign(Error(response?.error || '表格连接不可用'), { code: response?.code });
    return response.result;
  },
  { onChange: () => render() },
);
const workbench = new WorkbenchPanel(uiDoc, command, {
  language: uiLanguage,
  capture: async (mode) => {
    const response = await chrome.runtime.sendMessage({
      type: 'copilot.local',
      command: 'workbench_capture',
      params: { mode },
    });
    if (response?.error || !response?.result) throw Error(response?.error || '页面读取失败');
    return response.result;
  },
  onChange: () => void command('state').catch(failed),
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.tables_changed') void tables.refresh();
  if (
    message.type === 'copilot.changed' &&
    message.event.type === 'capabilities' &&
    uiDoc.getElementById('local-capabilities').open
  )
    void capabilities.refresh();
});
async function openNativeTool(row) {
  const tool = row.params?.tool;
  if (
    row.status !== 'pending' ||
    row.task_type !== `native.${tool}` ||
    !['tables', 'collect', 'annotate', 'basket'].includes(tool)
  )
    throw Error('页面工具已变化，请查看当前建议。');
  const notice = uiDoc.getElementById('notice');
  notice.hidden = false;
  notice.setAttribute('role', 'status');
  notice.dataset.source = 'action';
  notice.textContent = '';
  if (tool === 'basket') {
    await basket.refresh();
    return command('open_basket');
  }
  const response = await chrome.runtime.sendMessage({
    type: 'copilot.local',
    command: tool === 'annotate' ? 'annotate_page' : 'recognize_tables',
    params: {},
  });
  if (response?.error || !response?.result) throw Error(response?.error || '页面读取失败');
  if (tool === 'annotate') {
    notice.textContent = uiLanguage.startsWith('zh')
      ? response.result.active
        ? '已开启当前页标注；再次点击可停止。'
        : '当前页标注已停止。'
      : response.result.active
        ? 'Annotations on for this page; click again to stop.'
        : 'Page annotations stopped.';
    return response.result;
  }
  tables.state = response.result;
  const table = tables.suggestions().find((item) => item.status === 'pending');
  tables.render();
  if (table) return tables.command('execute', { id: table.id });
  notice.textContent = uiLanguage.startsWith('zh')
    ? '未识别到可导出的表格。'
    : 'No exportable table detected.';
  return response.result;
}
async function command(name, params = {}) {
  if (name === 'execute') {
    const row = state?.suggestions?.find((item) => item.id === params.id);
    if (row?.action === 'native.tool') return openNativeTool(row);
  }
  if (name === 'configure_task' || name === 'execute') {
    const row = state?.suggestions?.find((row) => row.id === params.id);
    if (row?.standard_task && (name === 'configure_task' || row.recommendation_state !== 'ready')) {
      await workbench.open(row);
      return {};
    }
  }

  if (tables.recognizes(params.id)) return tables.command(name, params);
  if (name === 'task_logs' || name === 'all_task_logs') {
    const row = params.id
      ? [...(state?.suggestions || []), ...(state?.result_history || [])].find(
          (row) => row.id === params.id,
        )
      : null;
    if (params.id && !row) throw Error('任务已清理，请查看全部执行日志。');
    await taskLogs.open(row);
    return {};
  }

  if (name === 'open_basket') {
    uiDoc.getElementById('work-basket').hidden = false;
    uiDoc.getElementById('work-basket').open = true;
    uiDoc.getElementById('work-basket').scrollIntoView?.({ block: 'nearest' });
    return {};
  }
  if (name === 'open_capabilities') {
    views.show('settings');
    settingsTabs.select('advanced');
    uiDoc.getElementById('local-capabilities').open = true;
    await capabilities.refresh();
    return {};
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'copilot.command', command: name, params });
  } catch (error) {
    if (name === 'state') void logs.connection(false);
    throw error;
  }
  if (response?.error || !response?.result) {
    if (name === 'state') void logs.connection(false);
    throw Error(response?.error || '本地连接未完成，请重新连接。');
  }
  if (name === 'state') void logs.connection(true);
  if (name === 'workbench_plan' && Array.isArray(response.result.state?.suggestions)) {
    // 中文注释：执行路由必须使用刚规划的状态，不能把同ID的旧阻塞卡再次送回配置。
    state = response.result.state;
    revision = state.revision;
    render();
    return response.result;
  }
  if (name === 'workbench_from_result') {
    const material = response.result.materials?.at(-1);
    if (material) workbench.selected = new Set([material.id]);
    await workbench.open();
    return response.result;
  }
  if (name === 'models') return response.result;
  if (name === 'fbl_save_flow') {
    const notice = uiDoc.getElementById('notice');
    notice.hidden = false;
    notice.setAttribute('role', 'status');
    notice.textContent = `${response.result.label} · ${response.result.path} · ${response.result.test_command}`;
    if (response.result.errors?.length)
      notice.textContent += ` · ${response.result.errors.join('; ')}`;
    if (response.result.fallback) notice.textContent += ` · ${response.result.reason}`;
    return response.result;
  }
  if (name === 'open_result' && !params.popup)
    uiDoc.getElementById('notice').textContent = '已在后台打开完整表';
  if (response.result.basket_preview) {
    basket.update(response.result.basket);
    basket.selected = new Set(response.result.selected_ids);
    basket.render();
    basket.root.open = true;
    basket.review(response.result.plan);
    return response.result;
  }
  if (['basket_add', 'basket_remove', 'basket_clear', 'basket_state'].includes(name))
    basket.update(response.result);
  if (response.result.secondary_required) {
    showTaskConfirmation(uiDoc, response.result, command);
    return response.result;
  }
  if (!Array.isArray(response.result.suggestions)) return response.result;
  state = response.result;
  revision = state.revision;
  render();
  return state;
}
function render() {
  if (state) {
    workbench.syncReadiness(state);
    taskLogs.update(state);
    basket.update(state.basket);
    const title = boardName(state.board_name, uiLanguage);
    uiDoc.title = title;
    uiDoc.getElementById('board-name').textContent = title;
    renderConnection(
      uiDoc.getElementById('bridge-status'),
      { state: state.diagnostic === 'bridge_disconnected' ? 'disconnected' : 'connected' },
      uiLanguage,
    );
    uiDoc.getElementById('agent-connection-name').textContent =
      (uiLanguage.startsWith('zh') ? '本地 ' : 'Local ') + (state.agent?.name || 'Agent');
    renderConnection(
      uiDoc.getElementById('hermes-status'),
      state.agent?.state ? state.agent : state.hermes_health,
      uiLanguage,
    );
    uiDoc.getElementById('hermes-retry').hidden = !['disconnected', 'error'].includes(
      state.hermes_health?.state,
    );
    if (state.capability_focus && render.capabilityFocus !== state.capability_focus) {
      views.show('settings');
      settingsTabs.select('advanced');
      uiDoc.getElementById('local-capabilities').open = true;
      render.capabilityFocus = state.capability_focus;
      void capabilities.refresh();
    }
    uiDoc.getElementById('selection-popup').checked = state.selection_popup !== false;
    const selected = uiDoc.getElementById('selected-text');
    selected.hidden = !state.selection_text;
    selected.querySelector('p').textContent = state.selection_text?.slice(0, 300) || '';
    const tooLong = (state.selection_text?.length || 0) > 11800;
    uiDoc.getElementById('process-selection').disabled = tooLong;
    uiDoc.getElementById('selection-limit').hidden = !tooLong;
    renderDashboard(
      uiDoc,
      {
        ...state,
        agent_connecting: agentStarting,
        suggestions: tables.mergeSuggestions(
          agents.ready()
            ? state.suggestions
            : (state.suggestions || []).filter(
                (row) =>
                  row.standard_task ||
                  row.action === 'native.tool' ||
                  row.explicit ||
                  row.status !== 'pending',
              ),
        ),
      },
      { command },
    );
    settings.update(state);
    settingsTabs.localize();
    plugins.busy(state.enabled === true);
    const history = uiDoc.getElementById('result-history');
    history.querySelector('summary').textContent = `历史结果 ${state.result_history?.length || 0}`;
    const list = history.querySelector('div');
    list.replaceChildren();
    for (const row of [...(state.result_history || [])].reverse()) {
      const p = uiDoc.createElement('p');
      p.textContent = row.result?.verdict || row.title;
      const open = uiDoc.createElement('button');
      open.textContent = '查看';
      open.onclick = () => command('open_result', { id: row.id, popup: true }).catch(failed);
      p.append(open);
      list.append(p);
    }
    if (state.focused_result && state.focused_result !== render.focused) {
      const card = [...uiDoc.querySelectorAll('article[data-id]')].find(
        (item) => item.dataset.id === state.focused_result,
      );
      if (card) {
        views.show('work');
        import('./copilot-view.mjs').then(({ selectDashboardTab }) =>
          selectDashboardTab(uiDoc, 'results'),
        );
        card.querySelector('.result-details')?.setAttribute('open', '');
        card.scrollIntoView({ block: 'nearest' });
        render.focused = state.focused_result;
      }
    }
    localize(uiDoc);
    settings.restoreDrafts();
    controls.sync();
  }
}
function failed() {
  uiDoc.getElementById('notice').dataset.source = 'connection';
  uiDoc.getElementById('notice').textContent = '连接暂时不可用，请确认本地服务已启动后刷新侧栏。';
}
uiDoc.getElementById('process-selection').onclick = () =>
  command('quick_task', {
    action: 'general.task',
    params: {
      task:
        (state.locale === 'en' ? 'Explain the selected text:\n' : '解释选中文本：\n') +
        state.selection_text,
    },
  }).catch(failed);
uiDoc.getElementById('result-filter').onchange = render;
uiDoc.getElementById('clear-read').onclick = () => command('clear_read').catch(failed);
uiDoc.getElementById('enabled').onchange = async (event) => {
  const before = state?.enabled === true;
  event.target.disabled = true;
  event.target.dataset.busy = 'true';
  controls.sync();
  try {
    if (event.target.checked) await enableCollaboration();
    else await command('settings', { enabled: false });
  } catch {
    event.target.checked = before;
    failed();
  } finally {
    delete event.target.dataset.busy;
    event.target.disabled = false;
    event.target.checked = state?.enabled === true;
    controls.sync();
  }
};
views.beforeShow = (name) =>
  views.current !== 'settings' || name === 'settings' || settings.confirmLeave();
uiDoc.getElementById('open-settings').onclick = () => {
  views.show('settings');
  if (uiDoc.getElementById('local-capabilities').open && !capabilities.state)
    void capabilities.refresh();
};
uiDoc.getElementById('open-logs').onclick = () => views.show('logs');
uiDoc.getElementById('hermes-retry').onclick = async (event) => {
  event.target.disabled = true;
  event.target.setAttribute('aria-busy', 'true');
  renderConnection(uiDoc.getElementById('hermes-status'), { state: 'connecting' }, uiLanguage);
  try {
    if (state?.bridge_recovery_blocked) await command('settings', { enabled: true });
    else if (state?.startup_error) await enableCollaboration();
    else await command('state');
  } catch {
    failed();
    renderConnection(
      uiDoc.getElementById('hermes-status'),
      { state: 'error', reason: 'Local status unavailable' },
      uiLanguage,
    );
  } finally {
    event.target.disabled = false;
    event.target.removeAttribute('aria-busy');
  }
};
uiDoc.getElementById('repair-connection').onclick = () =>
  uiDoc.getElementById('retry-session').click();
uiDoc.getElementById('dismiss-balanced').onclick = () => {
  uiDoc.getElementById('balanced-notice').hidden = true;
};
async function reconnect() {
  const button = uiDoc.getElementById('reconnect');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'copilot.reconnect' });
    if (response?.error || !response?.result) throw Error('reconnect failed');
    state = response.result;
    revision = state.revision;
    render();
    await logs.connection(true);
    void basket.refresh().catch(failed);
  } catch {
    failed();
  } finally {
    button.disabled = false;
  }
}
uiDoc.getElementById('reconnect').onclick = reconnect;
uiDoc.getElementById('retry-session').onclick = () => {
  if (state?.diagnostic === 'bridge_disconnected') {
    void reconnect();
    return;
  }
  if (state?.diagnostic?.startsWith('execution_acp')) {
    void command('settings', { enabled: false })
      .then(() => enableCollaboration())
      .catch(failed);
    return;
  }
  if (!state?.enabled) void enableCollaboration();
  else void command('retry_inference').catch(failed);
};
chrome.runtime.connect({ name: 'copilot-panel' });
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'copilot.changed' && message.event.revision > revision)
    void command('state').catch(failed);
});
setInterval(render, 1000);
void command('locale', { language: chrome.i18n?.getUILanguage?.() || navigator.language })
  .then(() => command('state'))
  .then(() => {
    void tables.refresh();
    void plugins.refresh();
    void agents.refresh({ autoOpen: false });
    return logs.load();
  })
  .catch(failed);

const localeObserver = new MutationObserver((records) => {
  if (
    records.every((record) =>
      (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(
        '#logs-view',
      ),
    )
  )
    return;
  localize(uiDoc, uiLanguage);
});
localeObserver.observe(uiDoc.body, { subtree: true, childList: true, characterData: true });
localize(uiDoc, uiLanguage);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.open_capabilities') {
    views.show('settings');
    settingsTabs.select('advanced');
    uiDoc.getElementById('local-capabilities').open = true;
    void capabilities.refresh();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.logs') {
    logs.append({ ...message.event, revision: message.event.log_revision });
    taskLogs.append(message.event);
  }
});
window.addEventListener('unload', () => {
  localeObserver.disconnect();
  logs.dispose();
  taskLogs.dispose();
  settings.dispose();
  agents.dispose();
  controls.dispose();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'copilot.connection') return;
  void logs.connection(message.connected === true);
  if (message.connected) void command('state').catch(failed);
  else if (state) {
    state = {
      ...state,
      diagnostic: 'bridge_disconnected',
      ready: false,
      bridge_restored: false,
      hermes_health: {
        state: 'connecting',
        reason: '浏览器与本地服务连接中断，正在重连',
        reason_en: 'Browser connection interrupted; reconnecting',
      },
    };
    render();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.table_notice')
    uiDoc.getElementById('notice').textContent = message.removed
      ? uiLanguage.startsWith('zh')
        ? '目标表格已消失，已取消'
        : 'Target removed; cancelled'
      : uiLanguage.startsWith('zh')
        ? '表格操作未完成，请重试'
        : 'Table action failed. Retry.';
});

async function readiness(fix = false) {
  try {
    const value = await command(fix ? 'fbl_fix' : 'fbl_readiness');
    renderReadiness(uiDoc, value, {
      language: uiLanguage,
      repair: () => readiness(true),
      discover: () => command('open_capabilities'),
    });
  } catch {
    renderReadiness(
      uiDoc,
      { ready: false, items: [{ id: 'browser', ok: false, command: 'fbl doctor' }] },
      {
        language: uiLanguage,
        repair: () => readiness(true),
        discover: () => command('open_capabilities'),
      },
    );
  }
}
uiDoc.getElementById('advanced-settings').addEventListener('toggle', () => {
  if (uiDoc.getElementById('advanced-settings').open) void readiness();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.new_tool') {
    const notice = uiDoc.getElementById('notice');
    notice.textContent = uiLanguage.startsWith('zh')
      ? '发现新工具，是否加入？'
      : 'New tool found. Add it?';
    const action = uiDoc.createElement('button');
    action.textContent = uiLanguage.startsWith('zh') ? '审阅' : 'Review';
    action.onclick = () => command('open_capabilities');
    notice.append(action);
  }
});

for (const id of ['all-task-logs', 'execution-logs'])
  uiDoc.getElementById(id).onclick = () => command('all_task_logs').catch(failed);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.agent_onboarding') void agents.open();
});
