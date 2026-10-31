import { BRAND_CSS, createBrandMark } from './brand.mjs';
import { renderStatus, statusNode } from './ui-design.mjs';

// 中文注释：这里只展示任务；授权、输入锁和可信点击留在执行层。
export function createOverlayView(
  doc,
  { title = '', startedAt, language = 'zh', preferences = {}, onPreference = () => {} } = {},
) {
  const zh = language.startsWith('zh'),
    t = (a, b) => (zh ? a : b);
  const make = (tag, role, text = '') => {
    const el = doc.createElement(tag);
    if (role) el.dataset.role = role;
    el.textContent = text;
    return el;
  };
  const button = (role, text) => {
    const el = make('button', role, text);
    el.type = 'button';
    return el;
  };
  const style = make('style');
  style.textContent =
    BRAND_CSS +
    `
 [data-role=status]{position:fixed;right:16px;bottom:16px;width:min(288px,calc(100vw - 32px));max-height:calc(100vh - 32px);background:var(--paper);color:var(--ink);font:13px/1.45 var(--ui);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);pointer-events:auto;overflow:auto;overscroll-behavior:contain}.overlay-top,[data-role=actions],.timeline-head{display:flex;align-items:center;gap:8px}.overlay-top{padding:8px 12px}.overlay-brand{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600;flex:1}.overlay-title{padding:0 12px 6px}.overlay-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.elapsed{font:12px var(--mono);color:var(--ink-2)}[data-role=minimize]{width:28px;border:0;padding:0}.now{margin:0 12px 8px;padding:8px 10px;border-radius:var(--r);background:var(--run-bg)}.now[data-tone=bad]{background:var(--bad-bg)}.now[data-tone=warn]{background:var(--warn-bg)}.now[data-tone=ok]{background:var(--ok-bg)}[data-role=step-index]{font:11px var(--mono);color:var(--ink-2)}[data-role=detail]{font-size:13px;font-weight:650;margin:2px 0 6px;overflow-wrap:anywhere}[data-role=state]{margin-bottom:4px}progress{display:block;width:100%;height:4px;accent-color:var(--brand)}.stats{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ink-2);margin-top:6px}.stats:empty,[data-role=explanation]:empty{display:none}.stats>div{display:flex;align-items:baseline;gap:4px;min-width:0;overflow-wrap:anywhere}.stats b{font:13px var(--mono);color:var(--ink)}[data-role=actions]{padding:0 12px 8px;flex-wrap:wrap}[data-action=takeover],[data-action=resume]{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}[data-role=recent]{border-top:1px solid var(--line-2);padding:2px 12px 6px}summary{cursor:pointer;color:var(--ink-2);font-size:11px;min-height:24px;line-height:24px}[data-role=recent-list]{padding:0;margin:0;list-style:none;max-height:144px;overflow:auto;overscroll-behavior:contain}[data-role=recent-list]>li{padding:4px 0;border-bottom:1px solid var(--line-2)}.timeline-head>.st{padding:0;background:none}.timeline-head>.st span{display:none}.step-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}[data-role=step-time]{font:11px var(--mono);color:var(--ink-2)}.step-reason{color:var(--bad);font-size:12px;margin:4px 0 0 20px;overflow-wrap:anywhere}[data-result=failed],[data-result=unknown]{background:var(--bad-bg)}.log-toolbar{display:flex;gap:6px;padding-top:4px}.log-toolbar button{font-size:11px;padding:2px 6px;border:0}.takeover-tip{display:none;position:absolute;bottom:100%;left:0;padding:8px;background:var(--paper);border:1px solid var(--line);border-radius:var(--rc);font-size:11px;white-space:nowrap}.takeover-wrap{position:relative}.takeover-wrap:hover .takeover-tip,.takeover-wrap:focus-within .takeover-tip{display:block}[data-role=status][data-minimized=true]{width:auto;border-radius:999px}[data-minimized=true]>.overlay-title,[data-minimized=true]>.now,[data-minimized=true]>[data-role=actions],[data-minimized=true]>details{display:none}[data-minimized=true] .overlay-brand>span{display:none}[data-minimized=true] .overlay-brand{flex:none}[data-role=capsule-step]{max-width:140px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}button[data-busy=true]{opacity:.6}`;
  // 中文注释：已知状态与当前动作共用一行；没有总步数时不显示伪进度。
  style.textContent += `
    .now [data-role=step-index]{margin-bottom:4px}
    .now [data-role=state]{display:inline-flex;vertical-align:baseline;margin:0}
    .now [data-role=detail]{display:inline;margin:0;font-weight:600}
    .now [data-role=detail]:not(:empty)::before{content:' · '}
    .now [data-role=task-progress]{margin-top:8px}
  `;
  const bar = make('section', 'status');
  Object.assign(bar.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    width: 'min(288px,calc(100vw - 32px))',
    boxSizing: 'border-box',
  });
  bar.setAttribute('aria-label', t('页面任务', 'Page task'));
  const top = make('div');
  top.className = 'overlay-top';
  const brand = make('div');
  brand.className = 'overlay-brand';
  brand.append(createBrandMark(doc), make('span', null, 'Fast-browser-link'));
  const elapsed = make('time', 'elapsed');
  elapsed.className = 'elapsed';
  const minimize = button('minimize', '−');
  top.append(brand, elapsed, minimize);
  bar.append(top);
  const heading = make('div');
  heading.className = 'overlay-title';
  const taskTitle = make('strong', 'task-title', title || t('浏览器任务', 'Browser task'));
  taskTitle.title = taskTitle.textContent;
  heading.append(taskTitle);
  bar.append(heading);
  const now = make('div');
  now.className = 'now';
  const indexLabel = make('div', 'step-index'),
    label = make('span', 'state'),
    detail = make('div', 'detail');
  indexLabel.hidden = true;
  label.setAttribute('aria-live', 'polite');
  const progress = make('progress', 'task-progress');
  progress.setAttribute('aria-label', t('任务进度', 'Task progress'));
  progress.hidden = true;
  const stats = make('div', 'stats');
  stats.className = 'stats';
  now.append(indexLabel, label, detail, progress, stats);
  bar.append(now);
  const explanation = make('p', 'explanation');
  explanation.style.cssText = 'font-size:12px;color:var(--ink-2);margin:6px 0 0';
  now.append(explanation);
  const actions = make('div', 'actions');
  bar.append(actions);
  const recent = make('details', 'recent');
  recent.open = true;
  recent.append(make('summary', null, t('执行步骤', 'Steps')));
  const recentList = make('ol', 'recent-list');
  recent.append(recentList);
  const empty = make('p', 'log-empty', t('等待第一步…', 'Waiting for first step…'));
  recent.append(empty);
  const toolbar = make('div');
  toolbar.className = 'log-toolbar';
  const all = button('all-steps', ''),
    latest = button('latest', t('看最新', 'Show latest')),
    copy = button('copy-log', t('复制', 'Copy'));
  latest.hidden = true;
  toolbar.append(all, latest, copy);
  recent.append(toolbar);
  bar.append(recent);
  const capsule = make('span', 'capsule-step');
  capsule.hidden = true;
  top.insertBefore(capsule, elapsed);
  let minimized = preferences.minimized === true,
    expanded = false,
    pausedScroll = false,
    lastScrollTop = 0,
    disposed = false,
    rows = [],
    nodes = new Map(),
    start = Number.isFinite(startedAt) ? Math.min(startedAt, Date.now()) : Date.now(),
    lastState = 'waiting',
    current = '',
    stateKey = '',
    timer,
    copyTimer,
    totalSteps = 0,
    completedSteps = 0;
  function save() {
    onPreference({ minimized, collapsed: !recent.open });
  }
  function minimizeView() {
    bar.dataset.minimized = String(minimized);
    bar.style.width = minimized ? 'auto' : 'min(288px,calc(100vw - 32px))';
    capsule.hidden = !minimized;
    minimize.textContent = minimized ? '+' : '−';
    minimize.setAttribute(
      'aria-label',
      t(minimized ? '恢复' : '最小化', minimized ? 'Restore' : 'Minimize'),
    );
    minimize.setAttribute('aria-expanded', String(!minimized));
  }
  minimize.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    minimized = !minimized;
    minimizeView();
    save();
  });
  top.addEventListener('click', (event) => {
    if (minimized && event.isTrusted && event.target !== minimize) {
      minimized = false;
      minimizeView();
      save();
    }
  });
  recent.addEventListener('toggle', () => {
    if (!disposed) save();
  });
  recentList.addEventListener('scroll', () => {
    const near = recentList.scrollHeight - recentList.scrollTop - recentList.clientHeight <= 24;
    if (recentList.scrollTop < lastScrollTop && !near) pausedScroll = true;
    if (near) pausedScroll = false;
    lastScrollTop = recentList.scrollTop;
    latest.hidden = !pausedScroll;
  });
  function scrollLatest() {
    pausedScroll = false;
    latest.hidden = true;
    recentList.scrollTo?.({ top: recentList.scrollHeight, behavior: 'instant' });
  }
  latest.addEventListener('click', scrollLatest);
  all.addEventListener('click', () => {
    expanded = !expanded;
    renderRows();
  });
  copy.addEventListener('click', async (event) => {
    if (!event.isTrusted || copy.disabled) return;
    copy.disabled = true;
    try {
      await doc.defaultView.navigator.clipboard.writeText(
        rows
          .map((row) =>
            [
              row.description,
              row.targetLabel,
              row.result,
              row.time,
              Number.isFinite(row.durationMs) ? `${(row.durationMs / 1000).toFixed(1)}s` : '',
              row.reason,
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      );
      copy.textContent = t('已复制', 'Copied');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copy.textContent = t('复制', 'Copy');
      }, 1500);
    } catch {
      copy.textContent = t('重试', 'Retry');
    } finally {
      copy.disabled = false;
    }
  });
  function renderRows() {
    if (empty.hidden !== rows.length > 0) empty.hidden = rows.length > 0;
    const visible = expanded ? rows : rows.slice(-4),
      next = new Map(),
      occurrences = new Map();
    if (all.hidden !== rows.length <= 4) all.hidden = rows.length <= 4;
    const caption = expanded
      ? t('收起', 'Collapse')
      : t(`展开 ${rows.length - 4} 步`, `Show ${rows.length - 4} more`);
    if (all.textContent !== caption) all.textContent = caption;
    for (const row of visible) {
      const base = JSON.stringify(row),
        occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      const key = JSON.stringify({ ...row, occurrence });
      let item = nodes.get(key);
      if (!item) {
        item = make('li');
        item.dataset.result = row.result;
        item.title = row.errorCode || '';
        const head = make('div');
        head.className = 'timeline-head';
        const stateKey =
          {
            succeeded: 'connected',
            pending: 'running',
            paused: 'waiting',
            stopped: 'stopped',
            queued: 'queued',
          }[row.result] || 'failed';
        const sign = statusNode(doc, stateKey, {
          language,
          bare: true,
          label:
            row.result === 'unknown'
              ? t('结果不确定', 'Uncertain')
              : stateKey === 'connected'
                ? t('已完成', 'Completed')
                : undefined,
        });
        sign.setAttribute('aria-label', sign.textContent);
        const name = make(
          'span',
          null,
          [row.description, row.targetLabel].filter(Boolean).join(' · '),
        );
        name.className = 'step-name';
        name.title = name.textContent;
        const duration = make(
          'time',
          'step-time',
          Number.isFinite(row.durationMs) ? `${(row.durationMs / 1000).toFixed(1)}s` : '',
        );
        head.append(sign, name, duration);
        item.append(head);
        if (row.reason && ['failed', 'unknown'].includes(row.result)) {
          const reason = make('p', null, row.reason);
          reason.className = 'step-reason';
          item.append(reason);
        }
      }
      next.set(key, item);
    }
    for (const [key, item] of nodes) if (!next.has(key)) item.remove();
    let index = 0;
    for (const item of next.values()) {
      if (recentList.children[index] !== item)
        recentList.insertBefore(item, recentList.children[index] || null);
      index++;
    }
    const changed = next.size !== nodes.size || [...next.keys()].some((key) => !nodes.has(key));
    nodes = next;
    if (changed && !pausedScroll) scrollLatest();
  }
  function state(value, step = '') {
    lastState = value;
    if (step) current = step;
    // 中文注释：轮询回执相同时保留状态节点，进度或步骤变化仍会刷新。
    const nextKey = JSON.stringify([value, current, completedSteps, totalSteps]);
    if (stateKey === nextKey) return;
    stateKey = nextKey;
    const key =
      {
        waiting: 'running',
        running: 'running',
        pausing: 'waiting',
        paused: 'waiting',
        resuming: 'running',
        stopping: 'running',
        completed: 'connected',
        failed: 'failed',
        stopped: 'stopped',
        unknown: 'failed',
        disconnected: 'disconnected',
      }[value] || 'idle';
    const captions = {
      pausing: t('正在接管', 'Taking over'),
      resuming: t('正在交还', 'Returning control'),
      stopping: t('正在停止', 'Stopping'),
      disconnected: t('连接中断', 'Disconnected'),
      unknown: t('状态待核查', 'Check status'),
      completed: t('已完成', 'Completed'),
    };
    renderStatus(label, key, { language, label: captions[value] });
    label.dataset.state = value;
    now.dataset.tone =
      { failed: 'bad', unknown: 'bad', paused: 'warn', completed: 'ok' }[value] || 'run';
    const detailText =
      value === 'paused' ? t('你已接管这个页面', 'You control this page') : current;
    detail.textContent = detailText;
    indexLabel.hidden = totalSteps <= 0;
    indexLabel.textContent =
      value === 'paused'
        ? t(
            `处理后交还，从第 ${completedSteps + 1} 步继续`,
            `Return to continue from step ${completedSteps + 1}`,
          )
        : totalSteps
          ? t(
              `第 ${Math.min(totalSteps, completedSteps + 1)} / ${totalSteps} 步`,
              `Step ${Math.min(totalSteps, completedSteps + 1)} / ${totalSteps}`,
            )
          : '';
    capsule.textContent = current || label.textContent;
    capsule.setAttribute('aria-label', label.textContent);
  }
  function activity(completed, total, metrics = {}) {
    totalSteps = total;
    completedSteps = completed;
    progress.hidden = total <= 0;
    if (total > 0) {
      progress.max = total;
      progress.value = Math.max(0, Math.min(total, completed));
    } else progress.removeAttribute('value');
    stats.replaceChildren();
    for (const [caption, value] of Object.entries(metrics)) {
      const item = make('div');
      item.append(make('b', null, String(value)), make('span', null, caption));
      stats.append(item);
    }
    state(lastState);
  }
  function tick() {
    if (disposed) return;
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    timer = setTimeout(tick, 1000);
    timer.unref?.();
  }
  minimizeView();
  state('waiting');
  tick();
  return {
    bar,
    label,
    detail,
    actions,
    outcome(value = {}) {
      state(value.state || lastState, value.reason || value.summary || current);
      activity(value.completed ?? completedSteps, value.total ?? totalSteps, value.metrics || {});
      explanation.textContent = value.resumeFrom
        ? t(
            `已完成步骤已保留，从第 ${value.resumeFrom} 步继续`,
            `Completed steps saved. Continue from step ${value.resumeFrom}`,
          )
        : '';
    },
    recent,
    recentList,
    style,
    state,
    activity,
    setRows(value) {
      rows = value;
      renderRows();
    },
    setBusy(el, value) {
      el.dataset.busy = String(value);
      el.setAttribute('aria-busy', String(value));
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(copyTimer);
    },
    get minimized() {
      return minimized;
    },
  };
}
