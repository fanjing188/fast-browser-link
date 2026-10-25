import { renderStatus } from './ui-design.mjs';
// 中文注释：只用当前宿主回执证明连接/任务状态，缓存和旧授权都不能充当在线证据。
const $ = (selector) => document.querySelector(selector);
const chinese = (chrome.i18n?.getUILanguage?.() || navigator.language || 'zh').startsWith('zh');
const t = (zh, en) => (chinese ? zh : en);
document.documentElement.lang = chinese ? 'zh-CN' : 'en';
for (const el of document.querySelectorAll('[data-zh]'))
  el.textContent = t(el.dataset.zh, el.dataset.en);
for (const [id, zh, en] of [
  ['copilot-toggle', '协作', 'Assist'],
  ['error-close', '关闭错误提示', 'Dismiss error'],
  ['version-label', '扩展版本', 'Extension version'],
])
  $('#' + id).setAttribute('aria-label', t(zh, en));
if (!chinese)
  document.querySelector('.connections').setAttribute('aria-label', 'Connection status');
for (const [selector, en] of [
  ['#local-row .info-button', 'Local connection information'],
  ['#page-task .info-button', 'Task controls information'],
])
  if (!chinese) $(selector).setAttribute('aria-label', en);
if (!chinese)
  $('#connection-detail').textContent =
    'Confirming connection lets Fast-browser-link read, click and run scripts on task pages without per-site or per-action approval. Takeover, stop and task isolation remain available; password values are never echoed.';
let stopConfirmation = null,
  stopTimer;
let connected = false,
  known = false,
  statusData = null,
  refreshing = false,
  uncertainControl = null,
  busy = false,
  revision = 0,
  controlPending = null,
  stoppedReceipt = null,
  errorSource = null,
  windowId;
$('#version-label').textContent = `v${chrome.runtime.getManifest().version}`;
void chrome.windows
  ?.getCurrent?.()
  .then((view) => {
    windowId = view.id;
  })
  .catch(() => {});
function error(message, source = 'action') {
  // 中文注释：连接状态另有独立展示，临时断连不能覆盖尚未解决的操作失败。
  if (source === 'connection' && errorSource === 'action') return;
  errorSource = source;
  $('#error').textContent = message;
  $('#error').hidden = false;
  $('#error-bar').hidden = false;
}
function clearError() {
  errorSource = null;
  $('#error').hidden = true;
  $('#error-bar').hidden = true;
}
$('#error-close').addEventListener('click', clearError);
async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.error || !Object.hasOwn(response, 'result'))
    throw Error(t('状态未确认', 'Status not confirmed'));
  return response.result;
}
async function feedback(button, action, source = 'action') {
  if (button.disabled || button.dataset.feedback === 'loading') return;
  button.disabled = true;
  button.dataset.feedback = 'loading';
  button.setAttribute('aria-busy', 'true');
  try {
    await action();
    button.dataset.feedback = 'success';
    setTimeout(() => {
      if (button.dataset.feedback === 'success') delete button.dataset.feedback;
    }, 900);
  } catch (failure) {
    delete button.dataset.feedback;
    error(failure.message || t('操作失败，请重试', 'Action failed. Try again.'), source);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
function render() {
  const update = statusData?.build;
  $('#version-label').textContent =
    `v${chrome.runtime.getManifest().version}` +
    (update?.pending ? t(' · 更新待应用', ' · Update pending') : '');
  $('#version-label').title = update
    ? t('已加载构建：', 'Loaded build: ') +
      (update.loadedBuildId || '') +
      (update.pending
        ? '\n' +
          t('磁盘构建：', 'Installed build: ') +
          (update.installedBuildId || '') +
          '\n' +
          t(
            '等待任务结束且清理状态核实后自动更新。',
            'Updates automatically after tasks and cleanup are verified.',
          )
        : '')
    : '';
  if (update?.pending && update.waiting)
    $('#version-label').title +=
      '\n' +
      ({
        connecting: t(
          '连接初始化与恢复清理尚未完成。',
          'Connection initialization and recovery cleanup are incomplete.',
        ),
        access_confirmation: t(
          '连接确认窗口尚未关闭。',
          'The connection confirmation window is open.',
        ),
        table_confirmation: t('表格保存确认尚未结束。', 'Table confirmation is pending.'),
        table_job: t('表格采集尚未结束。', 'Table collection is active.'),
        suggestion: t('协作任务尚未结束。', 'A collaboration task is active.'),
        browser_task: t('浏览器任务尚未释放。', 'A browser task has not been released.'),
        busy: t('仍有活动任务或确认操作。', 'A task or confirmation is active.'),
        unverified: t('本机空闲状态尚未核实。', 'Local idle status is not verified.'),
        tasks_unsettled: t(
          '本机任务或生命周期操作尚未结清。',
          'Local tasks or lifecycle operations are unsettled.',
        ),
      }[update.waiting] || '');
  const state = !known ? 'error' : connected ? 'connected' : busy ? 'connecting' : 'disconnected';
  $('#connection-label').dataset.state = state;
  $('#connection-label').setAttribute(
    'aria-label',
    t(
      !known ? '状态待确认' : connected ? '本地已连接' : busy ? '连接中' : '未连接',
      !known
        ? 'Status unknown'
        : connected
          ? 'Local connected'
          : busy
            ? 'Connecting'
            : 'Disconnected',
    ),
  );
  renderStatus($('#access-status'), connected ? 'connected' : busy ? 'running' : 'disconnected', {
    language: chinese ? 'zh' : 'en',
    bare: true,
  });
  renderStatus($('#connection-label'), connected ? 'connected' : 'failed', {
    language: chinese ? 'zh' : 'en',
    label: t(connected ? '就绪' : '未就绪', connected ? 'Ready' : 'Not ready'),
  });
  $('#access-detail').textContent = t(
    !known
      ? '连接状态待确认。'
      : connected
        ? '已连接 · 任务页可由 Fast-browser-link 直接访问。'
        : '未连接 · 确认连接后才能直接访问任务页。',
    !known
      ? 'Connection status is unknown.'
      : connected
        ? 'Connected. Fast-browser-link can directly access task pages.'
        : 'Disconnected. Confirm connection before accessing task pages.',
  );
  const first = known && !connected && statusData?.browserFullConsentStatus === 'disabled';
  $('#local-connect').classList.toggle('primary', first);
  $('#open-copilot').classList.remove('primary');
  $('#local-connect').hidden = connected || busy;
  $('#local-connect').textContent = t('重试', 'Retry');
  const copilot = statusData?.copilot;
  $('#open-copilot').hidden = !known || !connected || copilot?.enabled !== true;
  $('#copilot-toggle').setAttribute('aria-checked', String(copilot?.enabled === true));
  $('#copilot-toggle').disabled = !known || !connected;
  renderWork();
}
async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  const token = ++revision;
  try {
    const result = await call({ type: 'popup_status' });
    if (token !== revision) return;
    known = true;
    statusData = result;
    connected = result.connected === true;
    // 中文注释：真实连接已恢复才移除连接错误；普通操作失败不能被轮询吞掉。
    if (connected && errorSource === 'connection') clearError();
    if (uncertainControl) {
      const task = result.tasks?.find((row) => row.id === uncertainControl.taskId);
      if (
        !task ||
        ['cancelled', 'closed'].includes(task.state) ||
        task.generation !== uncertainControl.generation ||
        (uncertainControl.kind === 'takeover' && task.state === 'paused') ||
        (uncertainControl.kind === 'resume' && ['paused', 'ready', 'running'].includes(task.state))
      )
        uncertainControl = null;
    }
  } catch {
    if (token !== revision) return;
    known = false;
    connected = false;
    error(t('连接状态暂时无法读取。', 'Cannot read connection status.'), 'connection');
  } finally {
    refreshing = false;
  }
  render();
}
function renderWork() {
  const page = known && connected ? statusData?.page : null,
    task = page
      ? statusData.tasks?.find(
          (row) => row.id === page.taskId && !['closed', 'cancelled'].includes(row.state),
        )
      : null;
  const receipt =
    !task && known && connected && stoppedReceipt && (!page || page.tabId === stoppedReceipt.tabId)
      ? stoppedReceipt
      : null;
  $('#page-task').dataset.taskId = task?.id || '';
  $('#page-task').dataset.tabId = task ? String(page.tabId) : '';
  $('#page-task').hidden = !task && !receipt;
  $('#task-title').textContent = task?.title || page?.title || t('当前页任务', 'Current task');
  $('#task-title').title = $('#task-title').textContent;
  $('#operation').textContent = receipt
    ? t('已停止', 'Stopped')
    : t(
        task?.state === 'pausing'
          ? '正在暂停任务…'
          : task?.state === 'paused'
            ? '任务已暂停'
            : task?.pendingInteraction
              ? task.pendingInteraction.kind === 'manual_input'
                ? '等待人工输入'
                : '等待确认'
              : task?.state === 'running'
                ? '执行中'
                : '已就绪',
        task?.state === 'pausing'
          ? 'Pausing…'
          : task?.state === 'paused'
            ? 'Paused'
            : task?.pendingInteraction
              ? 'Waiting for user'
              : task?.state === 'running'
                ? 'Running'
                : 'Ready',
      );
  const uncertain =
    !!uncertainControl &&
    uncertainControl.taskId === task?.id &&
    uncertainControl.generation === task?.generation;
  $('#stop-task').disabled = busy || !task || (uncertain && uncertainControl.kind === 'stop');
  $('#takeover').disabled = busy || !task || task.state === 'pausing' || uncertain;
  $('#takeover').textContent = t(
    task?.state === 'paused' ? '继续' : '接管',
    task?.state === 'paused' ? 'Resume' : 'Take over',
  );
  if (
    stopConfirmation &&
    (stopConfirmation.taskId !== task?.id ||
      stopConfirmation.generation !== task?.generation ||
      stopConfirmation.until < Date.now())
  )
    stopConfirmation = null;
  $('#stop-task').textContent = receipt
    ? t('已停止', 'Stopped')
    : stopConfirmation
      ? t('确认停止', 'Confirm stop')
      : t('停止', 'Stop');
  for (const id of ['takeover', 'stop-task']) {
    const pending = controlPending === (id === 'takeover' ? 'takeover' : 'stop');
    if (pending) $('#' + id).dataset.feedback = 'loading';
    else if ($('#' + id).dataset.feedback === 'loading') delete $('#' + id).dataset.feedback;
    $('#' + id).setAttribute('aria-busy', String(pending));
  }
}
async function controlTask(kind) {
  const page = statusData?.page,
    task = statusData?.tasks?.find((row) => row.id === page?.taskId);
  if (
    !known ||
    !connected ||
    busy ||
    !page ||
    !task ||
    (kind !== 'stop' && task.state === 'pausing') ||
    (uncertainControl?.kind === kind &&
      uncertainControl.taskId === task.id &&
      uncertainControl.generation === task.generation)
  )
    return;
  busy = true;
  controlPending = kind === 'stop' ? 'stop' : 'takeover';
  ++revision;
  render();
  try {
    const result = await call({
      type: 'popup_action',
      taskId: task.id,
      generation: task.generation,
      tabId: page.tabId,
      kind,
    });
    if (result.verified !== true) throw Error('unverified');
    uncertainControl = null;
    const button = $(kind === 'stop' ? '#stop-task' : '#takeover');
    button.dataset.feedback = 'success';
    setTimeout(() => {
      if (button.dataset.feedback === 'success') delete button.dataset.feedback;
    }, 900);
    if (kind === 'stop') {
      stoppedReceipt = { tabId: page.tabId };
      setTimeout(() => {
        stoppedReceipt = null;
        renderWork();
      }, 1500);
    }
  } catch {
    uncertainControl = { kind, taskId: task.id, generation: task.generation };
    error(
      t(
        '操作结果尚未确认，正在读取状态，不会重复发送。',
        'Result unconfirmed. Checking status without replaying the command.',
      ),
    );
  } finally {
    busy = false;
    controlPending = null;
    await refresh();
  }
}
$('#stop-task').addEventListener('click', () => {
  const task = statusData?.tasks?.find((row) => row.id === statusData?.page?.taskId);
  if (!task) return;
  if (
    !stopConfirmation ||
    stopConfirmation.taskId !== task.id ||
    stopConfirmation.generation !== task.generation ||
    Date.now() > stopConfirmation.until
  ) {
    stopConfirmation = { taskId: task.id, generation: task.generation, until: Date.now() + 3000 };
    $('#stop-task').textContent = t('确认停止', 'Confirm stop');
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopConfirmation = null;
      renderWork();
    }, 3000);
    return;
  }
  stopConfirmation = null;
  clearTimeout(stopTimer);
  void controlTask('stop');
});
$('#takeover').addEventListener('click', () => {
  const task = statusData?.tasks?.find((row) => row.id === statusData?.page?.taskId);
  void controlTask(task?.state === 'paused' ? 'resume' : 'takeover');
});
async function connect(button) {
  await feedback(
    button,
    async () => {
      if (busy) return;
      busy = true;
      ++revision;
      render();
      let failure;
      try {
        const result = await call({ type: 'connect' });
        if (result.connected !== true)
          throw Error(result.lastError || t('本地连接未完成', 'Local connection did not complete'));
      } catch (error) {
        failure = error;
      } finally {
        busy = false;
        await refresh();
      }
      // 中文注释：连接启动回执可能早于握手；以随后真实状态为准，不重发连接动作。
      if (failure && (!known || !connected)) throw failure;
    },
    'connection',
  );
}
$('#local-connect').addEventListener('click', () => void connect($('#local-connect')));
$('#open-products').addEventListener(
  'click',
  () =>
    void feedback($('#open-products'), () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('product-connections.html') }),
    ),
);
function openCopilot(button) {
  return feedback(button, async () => {
    const result = await call({ type: 'copilot.open', windowId });
    if (result.opened !== true)
      throw Error(t('侧栏未打开，请重试', 'Could not open the side panel. Try again.'));
    window.close();
  });
}
$('#open-copilot').addEventListener('click', () => void openCopilot($('#open-copilot')));
$('#copilot-toggle').addEventListener(
  'click',
  () =>
    void feedback($('#copilot-toggle'), async () => {
      const enabling = $('#copilot-toggle').getAttribute('aria-checked') !== 'true';
      // 中文注释：在用户点击的同步阶段请求侧栏，保留浏览器的手势授权。
      const opening = enabling ? call({ type: 'copilot.open', windowId }) : Promise.resolve(null);
      const [opened, state] = await Promise.all([
        opening,
        call({ type: 'copilot.popup_settings', enabled: enabling }),
      ]);
      if (state.onboarding_required) {
        await refresh();
        window.close();
        return;
      }
      if (typeof state.enabled !== 'boolean')
        throw Error(t('协作状态未确认', 'Assist state not confirmed'));
      await refresh();
      if (enabling && opened.opened !== true)
        throw Error(t('侧栏未打开，请点击协作重试', 'Open Assist to retry.'));
    }),
);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  window.close();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'changed' || message?.type === 'copilot.changed') void refresh();
});
void refresh();
setInterval(refresh, 1500);
