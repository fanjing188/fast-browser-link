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
const controls = mountControls(document);
let state = null,
  revision = 0,
  agentStarting = false;
const uiLanguage = chrome.i18n?.getUILanguage?.() || navigator.language;
document.title = boardName('', uiLanguage);
document.getElementById('board-name').textContent = document.title;
const logs = new LogPanel(document, command, {
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
const views = new PanelViews(document, (name) => {
  logs.active = name === 'logs';
  if (name === 'logs') void logs.load().then(() => logs.latest());
  if (name === 'settings') {
    void settings.load();
    void agents.refresh({ autoOpen: false });
  }
});
const taskLogs = new TaskLogPanel(document, command, { language: uiLanguage });
const capabilities = new CapabilitiesPanel(
  document,
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
const settings = new SettingsForm(document, command);
const agents = new AgentPanel(document, command, {
  language: uiLanguage,
  onChange: () => render(),
  onEnable: () => enableCollaboration(),
});
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
const plugins = new PacksPanel(document, command, { language: uiLanguage });
chrome.runtime.onMessage.addListener((message) => {
  if (
    message.type === 'copilot.changed' &&
    message.event.type === 'capabilities' &&
    document.getElementById('functional-plugins').open
  )
    void plugins.refresh();
});
const basket = new BasketPanel(document, command, { language: uiLanguage });
const tables = new TablePanel(
  document,
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
for (const id of [
  'local-tables',
  'local-collect',
  'local-annotations',
  'local-basket',
  'local-agent',
]) {
  document.getElementById(id).onclick = async () => {
    const status = document.getElementById('local-tools-status');
    status.textContent = '';
    try {
      if (id === 'local-agent') return await agents.open();
      if (id === 'local-basket') {
        await basket.refresh();
        return await command('open_basket');
      }
      const response = await chrome.runtime.sendMessage({
        type: 'copilot.local',
        command: id === 'local-annotations' ? 'annotate_page' : 'recognize_tables',
        params: {},
      });
      if (response?.error || !response?.result) throw Error(response?.error || '页面读取失败');
      if (id === 'local-annotations') {
        status.textContent = uiLanguage.startsWith('zh')
          ? '已开启当前页标注；再次点击可停止。'
          : 'Annotations on for this page; click again to stop.';
        if (!response.result.active)
          status.textContent = uiLanguage.startsWith('zh')
            ? '当前页标注已停止。'
            : 'Page annotations stopped.';
        return;
      }
      tables.state = response.result;
      const row = tables.suggestions().find((row) => row.status === 'pending');
      tables.render();
      if (row) await tables.command('execute', { id: row.id });
      else
        status.textContent = uiLanguage.startsWith('zh')
          ? '未识别到可导出的表格。'
          : 'No exportable table detected.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.tables_changed') void tables.refresh();
  if (
    message.type === 'copilot.changed' &&
    message.event.type === 'capabilities' &&
    document.getElementById('local-capabilities').open
  )
    void capabilities.refresh();
});
async function command(name, params = {}) {
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
    document.getElementById('work-basket').hidden = false;
    document.getElementById('work-basket').open = true;
    document.getElementById('work-basket').scrollIntoView?.({ block: 'nearest' });
    return {};
  }
  if (name === 'open_capabilities') {
    views.show('settings');
    document.getElementById('local-capabilities').open = true;
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
  if (name === 'models') return response.result;
  if (name === 'fbl_save_flow') {
    const notice = document.getElementById('notice');
    notice.hidden = false;
    notice.setAttribute('role', 'status');
    notice.textContent = `${response.result.label} · ${response.result.path} · ${response.result.test_command}`;
    if (response.result.errors?.length)
      notice.textContent += ` · ${response.result.errors.join('; ')}`;
    if (response.result.fallback) notice.textContent += ` · ${response.result.reason}`;
    return response.result;
  }
  if (name === 'open_result' && !params.popup)
    document.getElementById('notice').textContent = '已在后台打开完整表';
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
    showTaskConfirmation(document, response.result, command);
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
    taskLogs.update(state);
    basket.update(state.basket);
    const title = boardName(state.board_name, uiLanguage);
    document.title = title;
    document.getElementById('board-name').textContent = title;
    renderConnection(
      document.getElementById('bridge-status'),
      { state: state.diagnostic === 'bridge_disconnected' ? 'disconnected' : 'connected' },
      uiLanguage,
    );
    document.getElementById('agent-connection-name').textContent =
      (uiLanguage.startsWith('zh') ? '本地 ' : 'Local ') + (state.agent?.name || 'Agent');
    renderConnection(
      document.getElementById('hermes-status'),
      state.agent?.state ? state.agent : state.hermes_health,
      uiLanguage,
    );
    document.getElementById('hermes-retry').hidden = !['disconnected', 'error'].includes(
      state.hermes_health?.state,
    );
    if (state.capability_focus && render.capabilityFocus !== state.capability_focus) {
      views.show('settings');
      document.getElementById('local-capabilities').open = true;
      render.capabilityFocus = state.capability_focus;
      void capabilities.refresh();
    }
    document.getElementById('selection-popup').checked = state.selection_popup !== false;
    const selected = document.getElementById('selected-text');
    selected.hidden = !state.selection_text;
    selected.querySelector('p').textContent = state.selection_text?.slice(0, 300) || '';
    const tooLong = (state.selection_text?.length || 0) > 11800;
    document.getElementById('process-selection').disabled = tooLong;
    document.getElementById('selection-limit').hidden = !tooLong;
    renderDashboard(
      document,
      {
        ...state,
        agent_connecting: agentStarting,
        suggestions: tables.mergeSuggestions(
          agents.ready()
            ? state.suggestions
            : (state.suggestions || []).filter((row) => row.explicit || row.status !== 'pending'),
        ),
      },
      { command },
    );
    settings.update(state);
    plugins.busy(state.enabled === true);
    const history = document.getElementById('result-history');
    history.querySelector('summary').textContent = `历史结果 ${state.result_history?.length || 0}`;
    const list = history.querySelector('div');
    list.replaceChildren();
    for (const row of [...(state.result_history || [])].reverse()) {
      const p = document.createElement('p');
      p.textContent = row.result?.verdict || row.title;
      const open = document.createElement('button');
      open.textContent = '查看';
      open.onclick = () => command('open_result', { id: row.id, popup: true }).catch(failed);
      p.append(open);
      list.append(p);
    }
    if (state.focused_result && state.focused_result !== render.focused) {
      const card = [...document.querySelectorAll('article[data-id]')].find(
        (item) => item.dataset.id === state.focused_result,
      );
      if (card) {
        views.show('work');
        import('./copilot-view.mjs').then(({ selectDashboardTab }) =>
          selectDashboardTab(document, 'results'),
        );
        card.querySelector('.result-details')?.setAttribute('open', '');
        card.scrollIntoView({ block: 'nearest' });
        render.focused = state.focused_result;
      }
    }
    localize(document);
    controls.sync();
  }
}
function failed() {
  document.getElementById('notice').dataset.source = 'connection';
  document.getElementById('notice').textContent =
    '连接暂时不可用，请确认本地服务已启动后刷新侧栏。';
}
document.getElementById('process-selection').onclick = () =>
  command('quick_task', {
    action: 'general.task',
    params: {
      task:
        (state.locale === 'en' ? 'Explain the selected text:\n' : '解释选中文本：\n') +
        state.selection_text,
    },
  }).catch(failed);
document.getElementById('result-filter').onchange = render;
document.getElementById('clear-read').onclick = () => command('clear_read').catch(failed);
document.getElementById('enabled').onchange = async (event) => {
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
document.getElementById('open-settings').onclick = () => {
  views.show('settings');
  if (document.getElementById('local-capabilities').open && !capabilities.state)
    void capabilities.refresh();
};
document.getElementById('open-logs').onclick = () => views.show('logs');
document.getElementById('hermes-retry').onclick = async (event) => {
  event.target.disabled = true;
  event.target.setAttribute('aria-busy', 'true');
  renderConnection(document.getElementById('hermes-status'), { state: 'connecting' }, uiLanguage);
  try {
    if (state?.bridge_recovery_blocked) await command('settings', { enabled: true });
    else if (state?.startup_error) await enableCollaboration();
    else await command('state');
  } catch {
    failed();
    renderConnection(
      document.getElementById('hermes-status'),
      { state: 'error', reason: 'Local status unavailable' },
      uiLanguage,
    );
  } finally {
    event.target.disabled = false;
    event.target.removeAttribute('aria-busy');
  }
};
document.getElementById('repair-connection').onclick = () =>
  document.getElementById('retry-session').click();
document.getElementById('dismiss-balanced').onclick = () => {
  document.getElementById('balanced-notice').hidden = true;
};
async function reconnect() {
  const button = document.getElementById('reconnect');
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
document.getElementById('reconnect').onclick = reconnect;
document.getElementById('retry-session').onclick = () => {
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
  localize(document, uiLanguage);
});
localeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
localize(document, uiLanguage);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.open_capabilities') {
    views.show('settings');
    document.getElementById('local-capabilities').open = true;
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
    document.getElementById('notice').textContent = message.removed
      ? uiLanguage.startsWith('zh')
        ? '目标表格已消失，已取消'
        : 'Target removed; cancelled'
      : uiLanguage.startsWith('zh')
        ? '表格操作未完成，请重试'
        : 'Table action failed. Retry.';
});

async function connections() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'copilot.connections' });
    const cloud = response?.result?.cloud;
    document.getElementById('sidebar-cloud').hidden = !cloud;
    if (cloud) renderConnection(document.getElementById('sidebar-cloud-status'), cloud, uiLanguage);
  } catch {
    document.getElementById('sidebar-cloud').hidden = true;
  }
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'changed') void connections();
});
void connections();

async function readiness(fix = false) {
  try {
    const value = await command(fix ? 'fbl_fix' : 'fbl_readiness');
    renderReadiness(document, value, {
      language: uiLanguage,
      repair: () => readiness(true),
      discover: () => command('open_capabilities'),
    });
  } catch {
    renderReadiness(
      document,
      { ready: false, items: [{ id: 'browser', ok: false, command: 'fbl doctor' }] },
      {
        language: uiLanguage,
        repair: () => readiness(true),
        discover: () => command('open_capabilities'),
      },
    );
  }
}
document.getElementById('advanced-settings').addEventListener('toggle', () => {
  if (document.getElementById('advanced-settings').open) void readiness();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.new_tool') {
    const notice = document.getElementById('notice');
    notice.textContent = uiLanguage.startsWith('zh')
      ? '发现新工具，是否加入？'
      : 'New tool found. Add it?';
    const action = document.createElement('button');
    action.textContent = uiLanguage.startsWith('zh') ? '审阅' : 'Review';
    action.onclick = () => command('open_capabilities');
    notice.append(action);
  }
});

for (const id of ['all-task-logs', 'execution-logs'])
  document.getElementById(id).onclick = () => command('all_task_logs').catch(failed);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'copilot.agent_onboarding') void agents.open();
});
