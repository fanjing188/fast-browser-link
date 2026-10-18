const events = new Map(
  Object.entries({
    execute_start: ['任务开始', 'Task started'],
    execute_step: ['执行步骤', 'Execution step'],
    execute_complete: ['任务完成', 'Task completed'],
    execute_failed: ['任务失败', 'Task failed'],
    execute_stop: ['任务停止', 'Task stopped'],
    batch_complete: ['批量执行完成', 'Batch completed'],
  }),
);
const statuses = {
  queued: ['排队中', 'Queued'],
  executing: ['执行中', 'Running'],
  stopping: ['停止中', 'Stopping'],
  completed: ['已完成', 'Completed'],
  failed: ['失败', 'Failed'],
  stopped: ['已停止', 'Stopped'],
};
const activeStatuses = new Set(['queued', 'executing', 'stopping']);
function element(doc, tag, text, className) {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function identifier(value) {
  return typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(value) &&
    !/(?:secret|cookie|bearer|token|sk[-_])/i.test(value)
    ? value
    : '';
}
function stepDescription(value) {
  if (
    typeof value !== 'string' ||
    /(?:authorization|bearer|cookie|password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|argv|params|arguments|(?:sk|pk)[-_][A-Za-z0-9]{8,}|密钥|口令|密码|--[a-z]|[{}[\]=])/i.test(
      value,
    )
  )
    return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export class TaskLogPanel {
  constructor(doc, command, { language = 'zh' } = {}) {
    this.doc = doc;
    this.command = command;
    this.en = !language.startsWith('zh');
    this.entries = [];
    this.revision = 0;
    this.resetRevision = 0;
    this.follow = true;
    this.active = false;
    this.disposed = false;
    this.loadId = 0;
    this.state = { suggestions: [] };
    this.root = element(doc, 'section', undefined, 'secondary-view task-log-view');
    this.root.id = 'task-log-view';
    this.root.dataset.active = 'false';
    this.root.inert = true;
    this.root.setAttribute('inert', '');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.setAttribute('aria-label', this.t('任务日志', 'Task logs'));
    const heading = element(doc, 'header', undefined, 'view-heading');
    this.back = element(doc, 'button', this.t('‹ 返回侧栏', '‹ Back to sidebar'));
    this.back.type = 'button';
    this.back.onclick = () => this.close();
    this.title = element(doc, 'strong');
    heading.append(this.back, this.title);
    this.summary = element(doc, 'section', undefined, 'task-log-summary');
    this.taskTitle = element(doc, 'h3');
    this.step = element(doc, 'p', undefined, 'task-log-step');
    this.elapsed = element(doc, 'span', undefined, 'task-log-elapsed');
    this.summary.append(this.taskTitle, this.step, this.elapsed);
    const tools = element(doc, 'div', undefined, 'task-log-tools');
    this.pause = element(doc, 'button');
    this.pause.type = 'button';
    this.pause.onclick = () => {
      this.follow = !this.follow;
      this.renderControls();
      if (this.follow) this.latest();
    };
    this.total = element(doc, 'span', undefined, 'small');
    tools.append(this.total, this.pause);
    this.notice = element(doc, 'p', undefined, 'small task-log-notice');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    this.viewport = element(doc, 'div', undefined, 'task-log-viewport');
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'region');
    this.viewport.setAttribute('aria-label', this.t('执行日志列表', 'Execution log list'));
    this.list = element(doc, 'div', undefined, 'task-log-list');
    this.viewport.append(this.list);
    this.onScroll = () => {
      if (
        this.viewport.scrollTop < this.lastScroll &&
        this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight > 24
      ) {
        this.follow = false;
        this.renderControls();
      }
      this.lastScroll = this.viewport.scrollTop;
    };
    this.viewport.addEventListener('scroll', this.onScroll);
    this.root.append(heading, this.summary, tools, this.notice, this.viewport);
    doc.body.append(this.root);
    this.onKey = (event) => {
      if (this.active && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      }
    };
    doc.addEventListener('keydown', this.onKey, true);
    this.renderControls();
  }
  t(zh, en) {
    return this.en ? en : zh;
  }
  async open(rowOrNull) {
    if (this.disposed) return;
    if (!this.active) {
      this.returnFocus = this.doc.activeElement;
      this.returnCardId = this.returnFocus?.closest('article[data-id]')?.dataset.id;
      this.returnAction = this.returnFocus?.dataset.action;
      this.work = this.doc.getElementById('work-view');
      this.workWasInert = !!this.work?.inert;
      if (this.work) {
        this.work.inert = true;
        this.work.setAttribute('inert', '');
      }
    }
    this.row = rowOrNull ? { ...rowOrNull } : null;
    this.taskId = rowOrNull?.id ?? null;
    this.active = true;
    this.follow = true;
    this.root.dataset.active = 'true';
    this.root.inert = false;
    this.root.removeAttribute('inert');
    this.root.setAttribute('aria-hidden', 'false');
    this.notice.textContent = '';
    this.render();
    this.back.focus();
    this.startTimer();
    const loadId = ++this.loadId;
    try {
      const value = await this.command('logs_read', {});
      if (!this.active || this.disposed || loadId !== this.loadId) return;
      const revision = value.revision ?? 0;
      if (revision < this.resetRevision) return;
      if (revision >= this.revision) {
        this.entries = this.safeEntries(value.entries);
        this.revision = revision;
      } else this.merge(value.entries);
      if (value.error) this.unavailable();
      this.render();
    } catch {
      if (this.active && loadId === this.loadId) this.unavailable();
    }
  }
  update(state) {
    this.state = state || {};
    if (!this.active) return;
    const current = (state?.suggestions || []).find((row) => row.id === this.taskId);
    if (current) this.row = { ...current };
    this.renderSummary();
    this.startTimer();
  }
  safeEntries(entries) {
    return (Array.isArray(entries) ? entries : [])
      .filter(
        (row) =>
          row &&
          row.type === 'execution' &&
          events.has(row.event) &&
          typeof row.id === 'number' &&
          Number.isFinite(row.id),
      )
      .slice(-2000);
  }
  merge(entries) {
    const rows = new Map(this.entries.map((row) => [row.id, row]));
    for (const row of this.safeEntries(entries)) if (!rows.has(row.id)) rows.set(row.id, row);
    this.entries = [...rows.values()].sort((a, b) => a.id - b.id).slice(-2000);
  }
  append(batch) {
    if (this.disposed || !batch) return;
    if (batch.error) {
      if (this.active) this.unavailable();
      return;
    }
    const revision = batch.revision ?? batch.log_revision ?? 0;
    if (revision <= this.revision) return;
    this.revision = revision;
    if (batch.reset) {
      this.entries = this.safeEntries(batch.entries);
      this.resetRevision = revision;
    } else {
      const rows = new Map(this.entries.map((row) => [row.id, row]));
      for (const row of this.safeEntries(batch.entries)) rows.set(row.id, row);
      this.entries = [...rows.values()].sort((a, b) => a.id - b.id).slice(-2000);
    }
    if (this.active) this.render();
  }
  unavailable() {
    this.notice.textContent = this.t(
      '日志暂不可用，恢复连接后可重新打开。',
      'Logs unavailable. Reopen after reconnecting.',
    );
  }
  renderControls() {
    this.pause.textContent = this.t(
      this.follow ? '暂停跟随' : '跟随最新',
      this.follow ? 'Pause following' : 'Follow latest',
    );
    this.pause.setAttribute('aria-pressed', String(!this.follow));
  }
  renderSummary() {
    this.title.textContent = this.t(
      this.taskId === null ? '全部执行日志' : '任务日志',
      this.taskId === null ? 'All execution logs' : 'Task logs',
    );
    this.summary.hidden = this.taskId === null;
    if (this.taskId === null) return;
    const row = this.row || {},
      status = statuses[row.status] || ['任务', 'Task'];
    this.taskTitle.textContent = row.title || this.t('当前任务', 'Current task');
    let step = '';
    if (activeStatuses.has(row.status)) {
      const value = typeof row.step === 'string' ? row.step : '';
      step = this.t(
        /model/.test(value)
          ? '正在分析数据'
          : /browser|page|snapshot/.test(value)
            ? '正在读取任务页面'
            : /search|web/.test(value)
              ? '正在检索数据'
              : /terminal|script|code|fetch/.test(value)
                ? '正在运行任务工具'
                : /result/.test(value)
                  ? '正在整理结果'
                  : '正在处理任务',
        /model/.test(value)
          ? 'Analyzing data'
          : /browser|page|snapshot/.test(value)
            ? 'Reading task page'
            : /search|web/.test(value)
              ? 'Retrieving data'
              : /terminal|script|code|fetch/.test(value)
                ? 'Running task tool'
                : /result/.test(value)
                  ? 'Preparing results'
                  : 'Processing task',
      );
      const tool = identifier(value),
        description = stepDescription(value);
      if (description && tool && tool !== 'model') step += ` · ${tool}`;
      else if (description && !tool) step = description;
      if (count(row.workflow_total) !== null && row.workflow_total > 0)
        step += this.t(
          ` · ${count(row.workflow_completed) || 0}/${row.workflow_total} 步`,
          ` · ${count(row.workflow_completed) || 0}/${row.workflow_total} steps`,
        );
    }
    this.step.textContent = [status[this.en ? 1 : 0], step].filter(Boolean).join(' · ');
    this.tick();
  }
  tick() {
    if (!this.row) return;
    const start = count(this.row.started_at ?? this.row.queued_at),
      finish = count(this.row.finished_at);
    const end = activeStatuses.has(this.row.status) ? Date.now() / 1000 : (finish ?? start);
    const seconds = start === null ? 0 : Math.max(0, Math.floor(end - start));
    this.elapsed.textContent = this.t(`已用 ${seconds} 秒`, `Elapsed ${seconds}s`);
  }
  startTimer() {
    if (this.timer) this.doc.defaultView.clearInterval(this.timer);
    this.timer = null;
    if (this.active && this.row && activeStatuses.has(this.row.status))
      this.timer = this.doc.defaultView.setInterval(() => this.tick(), 1000);
  }
  render() {
    this.renderSummary();
    this.renderControls();
    const rows = this.entries.filter(
      (row) => this.taskId === null || row.details?.task_id === this.taskId,
    );
    this.total.textContent = this.t(`${rows.length} 条记录`, `${rows.length} entries`);
    const scroll = this.viewport.scrollTop;
    this.list.replaceChildren();
    if (!rows.length)
      this.list.append(
        element(this.doc, 'p', this.t('暂无执行日志', 'No execution logs yet'), 'empty'),
      );
    for (const row of rows) {
      const card = element(this.doc, 'article', undefined, 'task-log-card');
      card.dataset.error = String(!!row.error);
      card.dataset.logId = String(row.id);
      const header = element(this.doc, 'div', undefined, 'task-log-card-heading'),
        stamp = element(this.doc, 'time');
      const time = count(row.time);
      stamp.textContent =
        time === null
          ? '—'
          : new Date(time * 1000).toLocaleTimeString(this.en ? 'en-GB' : 'zh-CN', {
              hour12: false,
            });
      const [zh, en] = events.get(row.event);
      header.append(element(this.doc, 'strong', this.t(zh, en)), stamp);
      card.append(header);
      const detail = row.details || {},
        parts = [];
      const step = count(detail.step_index),
        duration = count(detail.duration_ms),
        records = count(detail.count);
      if (step !== null) parts.push(this.t(`第 ${step} 步`, `Step ${step}`));
      for (const safe of [
        stepDescription(detail.step_name),
        identifier(detail.capability),
        identifier(detail.provider),
      ])
        if (safe && !parts.includes(safe)) parts.push(safe);
      if (records !== null) parts.push(this.t(`${records} 条`, `${records} rows`));
      if (duration !== null) parts.push(`${(duration / 1000).toFixed(1)}s`);
      if (parts.length) card.append(element(this.doc, 'p', parts.join(' · '), 'small'));
      this.list.append(card);
    }
    if (this.follow) this.latest();
    else this.viewport.scrollTop = scroll;
  }
  latest() {
    this.viewport.scrollTop = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
    this.lastScroll = this.viewport.scrollTop;
  }
  close() {
    if (!this.active) return;
    this.active = false;
    this.loadId++;
    if (this.timer) this.doc.defaultView.clearInterval(this.timer);
    this.timer = null;
    this.root.dataset.active = 'false';
    this.root.inert = true;
    this.root.setAttribute('inert', '');
    this.root.setAttribute('aria-hidden', 'true');
    if (this.work && !this.workWasInert) {
      this.work.inert = false;
      this.work.removeAttribute('inert');
    }
    const card = [...this.doc.querySelectorAll('article[data-id]')].find(
        (el) => el.dataset.id === this.returnCardId,
      ),
      replacement = [...(card?.querySelectorAll('button') || [])].find(
        (el) => el.dataset.action === this.returnAction,
      );
    const focus = this.returnFocus?.isConnected
      ? this.returnFocus
      : replacement || this.work?.querySelector('button');
    focus?.focus();
  }
  dispose() {
    this.close();
    this.disposed = true;
    this.doc.removeEventListener('keydown', this.onKey, true);
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.root.remove();
  }
}
