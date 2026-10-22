import { localize } from './copilot-i18n.mjs';
import { actionName } from './copilot-result-view.mjs';
import { renderTaskContent } from './copilot-result-content.mjs';
import { TaskLogPanel } from './copilot-task-logs.mjs';
import { statusNode } from './ui-design.mjs';

export async function mountResultDocument(
  doc,
  api,
  {
    url = doc.location.href,
    language = api.i18n?.getUILanguage?.() || doc.defaultView.navigator.language,
    closePage = async () => {
      const tab = await api.tabs.getCurrent();
      if (!Number.isInteger(tab?.id)) throw Error('Result tab unavailable');
      await api.tabs.remove(tab.id);
    },
  } = {},
) {
  const en = !language.startsWith('zh'),
    t = (zh, english) => (en ? english : zh);
  doc.documentElement.lang = en ? 'en' : 'zh-CN';
  const id = new URL(url).searchParams.get('id'),
    notice = doc.getElementById('notice'),
    root = doc.getElementById('result'),
    dialog = doc.getElementById('result-dialog');
  const tabs = [doc.getElementById('result-data-tab'), doc.getElementById('result-task-log')];
  const panes = tabs.map((tab) => doc.getElementById(tab.getAttribute('aria-controls')));
  const layout = doc.getElementById('result-layout'),
    outline = doc.getElementById('result-outline'),
    outlineItems = doc.getElementById('result-outline-items'),
    format = doc.getElementById('result-format'),
    taskInformation = doc.getElementById('result-context').parentElement,
    desktop = doc.defaultView.matchMedia?.('(min-width: 1000px)');
  let sections = [];
  const adaptOutline = () => {
    outline.open = desktop?.matches ?? doc.defaultView.innerWidth >= 1000;
    if (outline.open) layout.append(outline);
    else layout.prepend(outline);
  };
  adaptOutline();
  desktop?.addEventListener?.('change', adaptOutline);
  doc.getElementById('result-outline-label').textContent = t('内容导航', 'On this page');
  outlineItems.setAttribute('aria-label', t('结果章节', 'Result sections'));
  doc.getElementById('result-context-label').textContent = t('任务信息', 'Task information');
  doc.getElementById('result-close').setAttribute('aria-label', t('关闭详情', 'Close details'));
  doc.getElementById('result-close').title = t('关闭详情', 'Close details');
  let row = null,
    disposed = false,
    loading = false,
    logsLoaded = false,
    closing = false,
    backdropPressed = false;
  function updatePresentation() {
    if (disposed || loading) return;
    const data = !!root.querySelector('table,figure,.task-content-json'),
      headings = [
        ...root.querySelectorAll(
          '.result-content h3,.task-content-markdown h2,.task-content-markdown h3',
        ),
      ],
      overview = root.querySelector('.result-overview');
    const next = data
      ? []
      : [
          ...(overview ? [{ node: overview, label: t('结果概览', 'Overview') }] : []),
          ...headings.map((node) => ({ node, label: node.textContent })),
        ];
    layout.dataset.mode = data ? 'data' : 'document';
    outline.hidden = next.length < 2;
    layout.dataset.outline = String(!outline.hidden);
    root
      .querySelector('.result-details')
      ?.classList.toggle('has-sections', !!root.querySelector('.result-content h3'));
    if (
      next.length !== sections.length ||
      next.some(
        (entry, index) =>
          entry.node !== sections[index].node || entry.label !== sections[index].label,
      )
    ) {
      sections = next;
      outlineItems.replaceChildren();
      for (const [index, entry] of next.entries()) {
        if (!entry.node.id) entry.node.id = 'preview-section-' + index;
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = entry.label;
        button.dataset.userContent = 'true';
        button.setAttribute('aria-controls', entry.node.id);
        button.onclick = () => {
          entry.node.tabIndex = -1;
          entry.node.scrollIntoView?.({
            block: 'start',
            behavior: doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches
              ? 'instant'
              : 'smooth',
          });
          entry.node.focus({ preventScroll: true });
          for (const sibling of outlineItems.children) sibling.removeAttribute('aria-current');
          button.setAttribute('aria-current', 'location');
        };
        outlineItems.append(button);
      }
    }
    format.textContent =
      tabs[1].getAttribute('aria-selected') === 'true'
        ? t('执行日志', 'Execution logs')
        : root.querySelector('.task-content-image')
          ? t('图片预览', 'Image preview')
          : root.querySelector('.trend-chart')
            ? t('图表预览', 'Chart preview')
            : root.querySelector('table')
              ? t('表格预览', 'Table preview')
              : root.querySelector('.task-content-json')
                ? t('结构化数据', 'Structured data')
                : t('文档预览', 'Document preview');
    if (row?.standard_task || row?.action === 'assist.task')
      root
        .querySelector('.result-content > p.small:first-child')
        ?.classList.add('result-verification');
  }
  const outside = (event) => {
    const bounds = dialog.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  async function close() {
    if (closing || disposed) return;
    closing = true;
    dialog.dataset.closing = 'true';
    if (!doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      await new Promise((resolve) => doc.defaultView.setTimeout(resolve, 160));
    if (disposed) return;
    try {
      await closePage();
      if (dialog.open) dialog.close();
    } catch {
      notice.textContent = t(
        '详情暂时无法关闭，请重试或关闭此标签页。',
        'Could not close details. Retry or close this tab.',
      );
      delete dialog.dataset.closing;
      closing = false;
      doc.getElementById('result-close').focus();
    }
  }
  const cancel = (event) => {
    event.preventDefault();
    void close();
  };
  const pointerDown = (event) => {
    backdropPressed = event.target === dialog && outside(event);
  };
  const backdropClick = (event) => {
    if (!taskInformation.contains(event.target)) taskInformation.open = false;
    if (backdropPressed && event.target === dialog && outside(event)) void close();
    backdropPressed = false;
  };
  const trapFocus = (event) => {
    if (event.key !== 'Tab' || !dialog.open) return;
    const controls = [
      ...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]'),
    ].filter(
      (node) =>
        node.tabIndex >= 0 &&
        !node.matches(':disabled') &&
        node.getClientRects().length &&
        !node.closest('[hidden],[inert]'),
    );
    const first = controls[0],
      last = controls.at(-1);
    if (!first) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    if (
      (event.shiftKey && doc.activeElement === first) ||
      (!event.shiftKey && doc.activeElement === last)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('pointerdown', pointerDown);
  dialog.addEventListener('click', backdropClick);
  dialog.addEventListener('keydown', trapFocus);
  async function command(command, params = {}) {
    const response = await api.runtime.sendMessage({ type: 'copilot.command', command, params });
    if (response?.error || !response?.result) throw Error('本地结果不可用');
    const value = response.result;
    if (value.files) {
      notice.replaceChildren();
      notice.append(
        doc.createTextNode(
          value.error
            ? t(
                '导出失败，请核对目录；数据仍保留本机。',
                'Export failed. Check the directory and retry.',
              )
            : t('已导出：', 'Exported: ') + value.files.map((file) => file.path).join('；'),
        ),
      );
      for (const file of value.files)
        for (const [label, folder] of [
          [t('打开文件', 'Open file'), false],
          [t('打开所在文件夹', 'Open folder'), true],
        ]) {
          const button = doc.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.onclick = () =>
            command('table_open', { id: file.id, folder }).catch(() => {
              notice.textContent = t(
                '文件暂不可用，请检查本地连接。',
                'File unavailable. Check the local connection.',
              );
            });
          notice.append(button);
        }
    }
    if (Array.isArray(value.suggestions)) logs.update(value);
    return value;
  }
  const logs = new TaskLogPanel(doc, command, {
    language,
    container: panes[1],
    download: async (text) => {
      const blob = new doc.defaultView.Blob([text], { type: 'application/x-ndjson' });
      const downloadUrl = doc.defaultView.URL.createObjectURL(blob);
      try {
        await api.downloads.download({
          url: downloadUrl,
          filename:
            'fast-browser-link-task-logs-' + new Date().toISOString().slice(0, 10) + '.jsonl',
          saveAs: true,
        });
      } finally {
        doc.defaultView.setTimeout(() => doc.defaultView.URL.revokeObjectURL(downloadUrl), 30000);
      }
    },
  });
  async function selectTab(index) {
    if (disposed || tabs[index].disabled) return;
    taskInformation.open = false;
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panes[i].hidden = i !== index;
    });
    updatePresentation();
    if (index === 1 && !logsLoaded) {
      logsLoaded = true;
      await logs.open(row);
    }
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(index);
    tab.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      if (tabs[next].disabled) return;
      tabs[next].focus();
      void selectTab(next);
    };
  });
  doc.getElementById('result-close').onclick = close;
  dialog.showModal();
  const listener = (message) => {
    if (message?.type === 'copilot.logs')
      logs.append({ ...message.event, revision: message.event.log_revision });
  };
  api.runtime.onMessage.addListener(listener);
  async function loadResult() {
    if (loading || disposed) return;
    loading = true;
    outline.hidden = true;
    layout.dataset.outline = 'false';
    format.textContent = t('读取中…', 'Loading…');
    root.setAttribute('aria-busy', 'true');
    notice.textContent = '';
    root.replaceChildren();
    const pending = doc.createElement('p');
    pending.className = 'empty';
    pending.setAttribute('role', 'status');
    pending.textContent = t('正在读取任务结果…', 'Loading task results…');
    root.append(pending);
    try {
      if (!id) throw Error('缺少结果标识');
      const value = await command('result', { id });
      if (disposed) return;
      row = value;
      doc.getElementById('result-title').textContent =
        row.flow_name || row.title || actionName(row) || t('任务结果', 'Task results');
      doc.getElementById('result-context').textContent =
        row.params?.keyword || row.params?.url || row.params?.task || '';
      taskInformation.hidden = !doc.getElementById('result-context').textContent;
      const label =
        {
          completed: t('已完成', 'Completed'),
          failed: t('失败', 'Failed'),
          stopped: t('已停止', 'Stopped'),
          executing: t('执行中', 'Running'),
          queued: t('排队中', 'Queued'),
        }[row.status] || t('状态未知', 'Unknown status');
      doc.getElementById('result-status').replaceChildren(
        statusNode(
          doc,
          row.completion_status === 'partial'
            ? 'partial'
            : row.status === 'completed'
              ? 'connected'
              : row.status === 'failed'
                ? 'failed'
                : row.status === 'stopped'
                  ? 'stopped'
                  : row.status === 'executing'
                    ? 'running'
                    : 'idle',
          {
            language,
            label:
              row.completion_status === 'partial' ? t('部分完成', 'Partially completed') : label,
          },
        ),
      );
      const seconds =
        typeof row.started_at === 'number' && typeof row.finished_at === 'number'
          ? Math.max(0, row.finished_at - row.started_at)
          : typeof row.elapsed_ms === 'number'
            ? Math.max(0, row.elapsed_ms / 1000)
            : null;
      doc.getElementById('result-elapsed').textContent =
        seconds === null
          ? t('耗时未记录', 'Duration not recorded')
          : t(`耗时 ${seconds.toFixed(1)} 秒`, `Duration ${seconds.toFixed(1)}s`);
      const tokens = doc.getElementById('result-tokens');
      tokens.hidden = !Number.isFinite(row.tokens) || row.tokens < 0;
      if (!tokens.hidden) {
        const number = new Intl.NumberFormat(en ? 'en-US' : 'zh-CN'),
          estimated = row.estimated_tokens > 0,
          total = number.format(row.tokens),
          details = [];
        for (const [key, label] of [
          ['input', t('输入', 'Input')],
          ['cache_read', t('缓存读取', 'Cache read')],
          ['output', t('输出', 'Output')],
        ])
          if (Number.isFinite(row.usage?.[key]))
            details.push(`${label} ${number.format(row.usage[key])}`);
        tokens.textContent = `${total} tokens${estimated ? t(' · 含估算', ' · Includes estimates') : ''}`;
        tokens.title = [
          t('本任务用量', 'This task usage'),
          row.model,
          ...details,
          estimated ? t('包含估算值', 'Includes estimated usage') : t('实际用量', 'Actual usage'),
        ]
          .filter(Boolean)
          .join(' · ');
        tokens.setAttribute('aria-label', `${tokens.textContent} · ${tokens.title}`);
      }
      root.replaceChildren();
      renderTaskContent(doc, root, row, {
        command,
        clipboard: doc.defaultView.navigator.clipboard,
      });
      tabs[1].disabled = false;
      if (logsLoaded) logs.update({ suggestions: [row] });
    } catch {
      if (disposed) return;
      root.replaceChildren();
      notice.textContent = t(
        '结果已清除或连接不可用，请从侧栏重新打开。',
        'Result cleared or connection unavailable. Reopen from the sidebar.',
      );
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.textContent = t('重新读取结果', 'Reload results');
      retry.onclick = loadResult;
      root.append(retry);
    } finally {
      loading = false;
      root.setAttribute('aria-busy', 'false');
      updatePresentation();
    }
  }
  localize(doc, language);
  const observer = new doc.defaultView.MutationObserver(() => localize(doc, language));
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  const contentObserver = new doc.defaultView.MutationObserver(updatePresentation);
  contentObserver.observe(root, { subtree: true, childList: true, characterData: true });
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    contentObserver.disconnect();
    desktop?.removeEventListener?.('change', adaptOutline);
    logs.dispose();
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('pointerdown', pointerDown);
    dialog.removeEventListener('click', backdropClick);
    dialog.removeEventListener('keydown', trapFocus);
    api.runtime.onMessage.removeListener?.(listener);
  };
  doc.defaultView.addEventListener('unload', dispose, { once: true });
  await loadResult();
  return { logs, dispose, selectTab, reload: loadResult, close };
}
if (globalThis.document && globalThis.chrome) void mountResultDocument(document, chrome);
