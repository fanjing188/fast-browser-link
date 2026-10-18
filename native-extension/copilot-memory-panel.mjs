// 中文注释：记忆只由本机服务返回；用文本节点展示，删除和开关均等待服务端回执。
export class MemoryPanel {
  constructor(doc, request) {
    this.doc = doc;
    this.request = request;
    this.root = doc.getElementById('assist-memory');
    if (!this.root) return;
    this.root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-memory-delete]');
      if (button) void this.change({ delete: button.dataset.memoryDelete });
    });
    doc.getElementById('memory-enabled').onchange = (event) =>
      void this.change({ enabled: event.target.checked });
    doc.getElementById('memory-clear').onclick = () => void this.change({ clear: true });
  }
  update(memory, locale = 'zh') {
    if (this.disposed || !this.root || this.busy || !memory) return;
    const signature = JSON.stringify([memory, locale]);
    if (this.signature === signature) return;
    this.signature = signature;
    this.locale = locale;
    this.memory = memory;
    const en = locale === 'en';
    this.doc.getElementById('memory-title').textContent = en ? 'Memory' : '记忆';
    this.doc.getElementById('memory-enabled-label').textContent = en
      ? 'Remember my work'
      : '保存工作记忆';
    this.doc.getElementById('memory-hint').textContent = en
      ? 'Work summaries and workflow habits stay on this device. Turning memory off keeps saved records. Enable it to view them.'
      : '工作摘要和流程习惯保存在本机。关闭后停止读取和保存，已有记录保留；重新开启可查看。';
    this.doc.getElementById('memory-enabled').checked = memory.enabled;
    this.doc.getElementById('memory-clear').textContent = en ? 'Clear all memory' : '清空全部记忆';
    const list = this.doc.getElementById('memory-records');
    list.replaceChildren();
    const append = (id, title, text) => {
      const row = this.doc.createElement('li'),
        body = this.doc.createElement('div'),
        heading = this.doc.createElement('strong'),
        detail = this.doc.createElement('p'),
        button = this.doc.createElement('button');
      heading.textContent = title;
      detail.textContent = text;
      body.append(heading, detail);
      button.type = 'button';
      button.textContent = en ? 'Delete' : '删除';
      button.dataset.memoryDelete = id;
      button.setAttribute('aria-label', `${button.textContent} · ${title}`);
      row.append(body, button);
      list.append(row);
    };
    const understanding = (row) =>
      [
        row.user_direction,
        row.work.goal,
        ...row.work.evidence,
        ...row.work.constraints,
        ...row.work.open_questions,
        row.work.next_step,
      ]
        .filter(Boolean)
        .join(' · ');
    if (memory.current)
      append(
        'current',
        en ? 'Current understanding' : '当前工作理解',
        understanding(memory.current),
      );
    for (const [index, row] of (memory.history || []).entries())
      append(`history:${index}`, en ? 'Past understanding' : '历史工作理解', understanding(row));
    for (const row of memory.habits || [])
      append(
        row.id,
        `${row.tool} / ${row.page} → ${row.flow}`,
        `${row.object_type}${row.after ? ` · ${row.after} → ${row.flow}` : ''} · ${en ? 'Accepted' : '接受'} ${row.accepted} · ${en ? 'Ignored' : '忽略'} ${row.ignored}`,
      );
    this.doc.getElementById('memory-empty').textContent = memory.enabled
      ? en
        ? 'No saved memory yet.'
        : '暂无保存的记忆。'
      : en
        ? 'Memory is off. Saved records are retained.'
        : '记忆已关闭，已有记录仍保留。';
    this.doc.getElementById('memory-empty').hidden = !!list.children.length;
  }
  async change(params) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const status = this.doc.getElementById('memory-status');
    status.textContent = this.locale === 'en' ? 'Saving…' : '保存中…';
    for (const control of this.root.querySelectorAll('button,input')) control.disabled = true;
    try {
      const memory = await this.request('memory', params);
      if (this.disposed) return;
      this.busy = false;
      this.signature = null;
      this.update(memory, this.locale);
      status.textContent = this.locale === 'en' ? 'Saved' : '已保存';
    } catch {
      if (this.disposed) return;
      this.busy = false;
      this.signature = null;
      this.update(this.memory, this.locale);
      status.textContent =
        this.locale === 'en'
          ? 'Could not save memory. Retry the action.'
          : '记忆未保存，请重试此操作。';
    } finally {
      this.busy = false;
      if (!this.disposed)
        for (const control of this.root.querySelectorAll('button,input')) control.disabled = false;
    }
  }
  dispose() {
    this.disposed = true;
  }
}
