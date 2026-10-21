import { tableIdentity } from './copilot-tables.mjs';
export class TablePanel {
  constructor(doc, request, { onChange = () => {} } = {}) {
    this.doc = doc;
    this.request = request;
    this.onChange = onChange;
    this.saved = new Map();
    this.finishedAt = new Map();
    this.columns = new Map();
    this.records = new Map();
    this.current = new Map();
    this.ids = new Map();
    this.receiptKeys = new Map();
    this.dismissed = new Set();
    this.nextId = 0;
    this.refreshVersion = 0;
    this.selectedKey = null;
    this.error = '';
    const dialog = doc.getElementById('table-export-dialog'),
      close = doc.getElementById('table-export-close');
    if (close) close.onclick = () => this.close();
    dialog?.addEventListener('cancel', (event) => {
      event.preventDefault();
      void this.close();
    });
    dialog?.addEventListener('close', () => {
      const trigger = this.trigger?.isConnected
        ? this.trigger
        : doc.querySelector(`article[data-id="${this.returnId}"] button:not([disabled])`);
      trigger?.focus();
    });
  }
  recognizes(id) {
    return typeof id === 'string' && id.startsWith('local-table-');
  }
  key(capture, table) {
    return tableIdentity(capture, table);
  }
  id(key) {
    if (!this.ids.has(key)) this.ids.set(key, `local-table-${++this.nextId}`);
    return this.ids.get(key);
  }
  synchronize() {
    this.current.clear();
    const capture = this.state?.capture;
    for (const table of capture?.tables || []) {
      const key = this.key(capture, table),
        record = { key, capture, table };
      this.current.set(key, record);
      this.records.set(key, record);
    }
    for (const saved of [
      ...(this.state?.receipts || []),
      ...(this.state?.saved ? [this.state.saved] : []),
    ])
      this.rememberSaved(saved.key, saved.result, saved.identity);
    for (const job of this.state?.jobs || [])
      if (job.status === 'completed' && job.sourceKey && job.export)
        this.rememberSaved(job.sourceKey, job.export, job.sourceIdentity);
    const keep = new Set([...this.current.keys(), ...this.saved.keys()]);
    for (const store of [this.records, this.ids, this.dismissed])
      for (const key of store.keys()) if (!keep.has(key)) store.delete(key);
  }
  rememberSaved(baseKey, result, identity) {
    if (result.error || !result.files?.length) {
      this.error = result.reason || '表格未能导出，请检查默认导出目录后重试。';
      return null;
    }
    let key = identity || this.receiptKeys.get(result.id);
    if (!key)
      key =
        [...this.current.values()].find(
          (record) => `${record.capture.url}|${record.table.id}` === baseKey,
        )?.key || `saved:${baseKey}`;
    if (result.id) this.receiptKeys.set(result.id, key);
    const previous = this.saved.get(key),
      receiptIds = [...new Set([...(previous?.receiptIds || []), result.id].filter(Boolean))],
      files = [
        ...new Map(
          [...(previous?.files || []), ...result.files].map((file) => [file.id || file.path, file]),
        ).values(),
      ];
    this.saved.set(key, { ...result, files, receiptIds });
    if (!this.finishedAt.has(key)) this.finishedAt.set(key, Date.now() / 1000);
    return key;
  }
  mergeSuggestions(suggestions = []) {
    const local = this.suggestions(),
      receipts = new Set(local.flatMap((row) => row.native_ids || [])),
      pending = local.some((row) => row.status === 'pending');
    return [
      ...suggestions.filter(
        (row) =>
          !receipts.has(row.id) &&
          !(
            pending &&
            row.status === 'pending' &&
            !row.explicit &&
            (row.action === 'table.export' ||
              (row.action === 'native.tool' && row.task_type === 'native.tables') ||
              (row.action === 'general.task' &&
                row.title === '保存本页表格' &&
                /^保存(?:本页|当前)(?:的)?表格[。.]?$/.test(row.params?.task || '')))
          ),
      ),
      ...local,
    ];
  }
  suggestions() {
    this.synchronize();
    const rows = [];
    for (const [key, record] of this.current) {
      if (this.dismissed.has(key) || this.saved.has(key)) continue;
      const { table } = record;
      rows.push({
        id: this.id(key),
        action: 'table.export',
        local_table: true,
        status: 'pending',
        risk: 'zero',
        title: '保存本页表格',
        params: { object: table.name },
        why: `${table.headers.length} 列 · ${table.rows.length} 行${table.pagination?.totalPages ? ` · 共 ${table.pagination.totalPages} 页` : ''}`,
      });
    }
    for (const [key, result] of this.saved) {
      const table = this.records.get(key)?.table;
      rows.push({
        id: this.id(key),
        ...(result.id
          ? {
              native_id: `table-${result.id}`,
              native_ids: result.receiptIds.map((id) => `table-${id}`),
            }
          : {}),
        action: 'table.export',
        local_table: true,
        status: 'completed',
        completion_status: result.partial ? 'partial' : 'completed',
        finished_at: this.finishedAt.get(key),
        risk: 'zero',
        title: table?.name || '表格已保存',
        params: { object: table?.name || '表格导出' },
        result: {
          verdict: result.reason || '表格已保存',
          export: result,
          metrics: [{ label: '文件', value: String(result.files.length) }],
        },
      });
    }
    return rows;
  }
  async command(name, params = {}) {
    if (name === 'suggestion_hold') return {};
    this.synchronize();
    const key = [...this.ids].find(([, id]) => id === params.id)?.[0];
    if (!key || (!this.current.has(key) && !this.saved.has(key)))
      throw Error('表格已变化，请查看当前建议。');
    if (name === 'feedback' || name === 'ignore') {
      this.dismissed.add(key);
      this.render();
      return {};
    }
    if (name !== 'execute' && name !== 'open_result') throw Error('此表格操作暂不可用。');
    if (name === 'execute' && !this.current.has(key)) throw Error('表格已变化，请查看当前建议。');
    this.selectedKey = key;
    this.error = '';
    const dialog = this.doc.getElementById('table-export-dialog');
    if (!dialog.open) {
      this.trigger = this.doc.activeElement;
      this.returnId = params.id;
    }
    this.render();
    if (!dialog.open) dialog.showModal();
    return {};
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.pendingAction;
      if (this.state?.confirmation) {
        await this.request('confirm_table', {
          kind: 'cancel',
          token: this.state.confirmation.token,
        });
        this.state.confirmation = null;
        await this.refresh();
      }
      this.doc.getElementById('table-export-dialog').close();
    } catch {
      this.error = '未能取消表格确认，请检查连接后重试。';
      this.render();
    } finally {
      this.closing = false;
      this.render();
    }
  }
  async refresh() {
    const version = ++this.refreshVersion;
    try {
      const state = await this.request('table_state');
      if (version !== this.refreshVersion) return;
      this.state = state;
      this.error = '';
      this.render();
    } catch {
      if (version !== this.refreshVersion || (!this.selectedKey && !this.state?.confirmation))
        return;
      this.error = '表格连接未就绪，请刷新侧栏。';
      this.render();
    }
  }
  render() {
    this.synchronize();
    const doc = this.doc,
      root = doc.getElementById('table-tools'),
      live = doc.getElementById('table-confirmation-live');
    root.replaceChildren();
    live.replaceChildren();
    for (const job of doc.querySelectorAll('.table-job')) job.remove();
    const node = (tag, text) => {
      const el = doc.createElement(tag);
      el.textContent = text;
      return el;
    };
    const button = (label, work) => {
      const el = node('button', label);
      el.type = 'button';
      el.disabled = !!this.pendingAction || !!this.closing;
      el.onclick = () => {
        if (this.closing) return;
        if (this.pendingAction) return this.pendingAction;
        if (el.disabled) return;
        el.disabled = true;
        const pending = Promise.resolve()
          .then(work)
          .catch((error) => {
            this.error =
              error.code === 'table_operation_failed'
                ? error.message
                : '表格操作未完成，请检查本机桥、导出目录和工作页状态。';
          })
          .finally(() => {
            this.pendingAction = null;
            el.disabled = false;
            this.render();
          });
        this.pendingAction = pending;
        return pending;
      };
      return el;
    };
    const confirmation = this.state?.confirmation;
    if (confirmation) {
      const record = [...this.current.values()].find(
        (record) => record.capture.url === confirmation.url && record.table.id === confirmation.id,
      );
      if (record) this.selectedKey = record.key;
      const card = doc.createElement('section');
      card.className = 'confirmation-card';
      card.append(
        node('strong', confirmation.name),
        node(
          'p',
          `${confirmation.headers.length} 列（${confirmation.headers.slice(0, 4).join(' / ')}） · ${confirmation.rows} 行 · ${confirmation.pages || '?'} 页 · ${confirmation.format}`,
        ),
      );
      if (confirmation.all)
        card.append(
          node('p', `将在后台打开同一页面收集 ${confirmation.pages || '?'} 页（最多200页）`),
        );
      for (const [label, kind] of [
        ['确认保存', 'confirm'],
        ['取消', 'cancel'],
        ['换一个表格', 'switch'],
      ])
        if (kind !== 'switch' || confirmation.candidate_count > 1) {
          const action = button(label, async () => {
            const value = await this.request('confirm_table', {
              kind,
              token: confirmation.token,
            });
            if (value.clipboard)
              await doc.defaultView.navigator.clipboard.writeText(value.clipboard);
            if (value.files && this.rememberSaved(`${confirmation.url}|${confirmation.id}`, value))
              doc.getElementById('notice').textContent =
                `已保存：${value.files.map((file) => file.path).join('；')}`;
            await this.refresh();
          });
          if (kind === 'confirm') action.className = 'primary';
          card.append(action);
        }
      live.append(card);
    }
    const current = this.current.get(this.selectedKey),
      record = current || this.records.get(this.selectedKey),
      saved = this.saved.get(this.selectedKey),
      table = record?.table;
    doc.getElementById('table-export-title').textContent =
      table?.name || confirmation?.name || '表格导出';
    const receipt = (section, value) => {
      for (const file of value.files || [])
        section.append(
          node('p', file.path),
          button('打开文件', () => this.request('table_open', { id: file.id })),
          button('打开所在文件夹', () => this.request('table_open', { id: file.id, folder: true })),
        );
      if (value.deduplication)
        section.append(
          node(
            'p',
            value.deduplication === 'row_index'
              ? '已按页面声明的行号识别重复记录。'
              : '缺少稳定行号，跨页按内容及重复次数去重；完全相同记录的跨页归属仍待核实。',
          ),
        );
    };
    if (current || saved) {
      const section = doc.createElement('section');
      section.className = 'table-strip';
      if (table)
        section.append(
          node('strong', table.name),
          node(
            'p',
            `${table.headers.length} 列 · 已识别 ${table.rows.length} 行${table.incomplete ? ' · 可能不完整' : ''}`,
          ),
        );
      if (current && !confirmation) {
        const pager = table.pagination || {};
        section.append(
          node(
            'p',
            `${pager.totalPages ? `共 ${pager.totalPages} 页` : '页数未知'}${pager.totalRows ? ` · 约 ${pager.totalRows} 行` : ''}`,
          ),
        );
        const start = async (name, params = {}) => {
          const value = await this.request(name, { id: table.id, ...params });
          if (value.confirmation) this.state = { ...this.state, confirmation: value.confirmation };
          await this.refresh();
        };
        const save = (format) => start('save_table', { format });
        section.append(
          button('保存为 Excel', () => save('xlsx')),
          button('保存为 CSV', () => save('csv')),
          button('复制为表格', () => start('copy_table')),
        );
        if (table.incomplete) {
          section.append(
            node(
              'p',
              `保存全部${pager.totalPages ? ` ${pager.totalPages} 页` : ''}为 Excel · ${pager.totalPages ? `预计至少 ${Math.ceil(pager.totalPages * 1.5)} 秒` : '耗时取决于页数和加载速度'}`,
            ),
            node('p', '后台页面与当前页面筛选可能不同；仅保留地址中的筛选参数。'),
            button('保存全部', () => start('collect_table')),
            button('只存当前页', () => save('xlsx')),
          );
        }
      }
      if (saved) {
        receipt(section, saved);
        if (table) {
          section.append(node('p', '选择关键词列 · 单次最多1000词，超出请先缩小范围'));
          const column = doc.createElement('select');
          column.setAttribute('aria-label', '选择关键词所在列');
          table.headers.forEach((name, index) => {
            const option = node('option', name || `未命名列 ${index + 1}`);
            option.value = String(index);
            column.append(option);
          });
          column.value =
            this.columns.get(this.selectedKey) ||
            String(
              Math.max(
                0,
                table.headers.findIndex((name) => /keyword|关键词|^词$/i.test(name)),
              ),
            );
          column.onchange = () => this.columns.set(this.selectedKey, column.value);
          section.append(
            column,
            button('整表加入工作篮', () =>
              this.request('basket_add', { items: [{ type: 'table', value: saved.id }] }),
            ),
            button('所选列加入工作篮', () =>
              this.request('basket_add', {
                items: [{ type: 'table', value: saved.id, columns: [Number(column.value)] }],
              }),
            ),
          );
          for (const [label, operation] of [
            ['批量查词', 'check'],
            ['存词池', 'save'],
          ])
            section.append(
              button(label, () =>
                this.request('table_column_action', {
                  id: saved.id,
                  column: Number(column.value),
                  operation,
                }),
              ),
            );
        }
      }
      root.append(section);
    } else if (this.selectedKey && !confirmation) {
      const error = node('p', '表格已变化，请关闭后选择当前建议。');
      error.className = 'local-table-error failure';
      root.append(error);
    }
    const active = (this.state?.jobs || []).filter((job) => job.status === 'executing');
    for (const job of active) {
      const progress = doc.createElement('section');
      progress.className = 'table-job';
      progress.setAttribute('role', 'status');
      progress.setAttribute('aria-live', 'polite');
      progress.append(
        node(
          'p',
          `第 ${job.pages || 1}/${job.totalPages || '?'} ${job.unit || '页'} · 已收 ${job.rowCount || 0} 行`,
        ),
        button('停止并保存部分', () => this.request('stop_table', { id: job.id })),
      );
      progress.dataset.active = 'true';
      doc.getElementById('running').append(progress);
    }
    if (this.selectedKey || confirmation) {
      for (const job of (this.state?.jobs || []).filter((item) => item.status === 'failed')) {
        const error = node('p', job.reason || '后台采集未完成，请重新识别后重试');
        error.className = 'local-table-error failure';
        root.append(error);
      }
      if (this.error) {
        const error = node('p', this.error);
        error.className = 'local-table-error failure';
        root.append(error);
      }
    }
    root.hidden = !root.childElementCount;
    const count = doc.getElementById('running-count');
    if (count) count.textContent = String(Number(count.dataset.native || 0) + active.length);
    if (active.length) doc.getElementById('running').querySelector('.empty')?.remove();
    this.onChange();
  }
}
