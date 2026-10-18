export class BasketPanel {
  constructor(doc, request, { language = 'zh' } = {}) {
    this.doc = doc;
    this.request = request;
    this.en = !language.startsWith('zh');
    this.selected = new Set();
    this.root = doc.getElementById('work-basket');
    this.revision = null;
  }
  t(zh, en) {
    return this.en ? en : zh;
  }
  async refresh() {
    this.update(await this.request('basket_state'));
  }
  update(state) {
    if (!this.root || !state || this.revision === state.revision) return;
    this.state = state;
    this.revision = state.revision;
    this.render();
  }
  render() {
    const doc = this.doc,
      root = this.root,
      open = root.open;
    root.hidden = !this.state.items.length;
    root.replaceChildren();
    root.open = open;
    const node = (tag, text) => {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const summary = node(
      'summary',
      this.t('工作篮', 'Work basket') + ` · ${this.state.items.length}`,
    );
    root.append(summary);
    const batch = node('button', this.t('批量执行', 'Run batch'));
    batch.type = 'button';
    batch.className = 'basket-run';
    batch.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.open = true;
      this.selected = new Set(
        this.state.items.filter((item) => item.type === 'keyword').map((item) => item.id),
      );
      this.render();
      root.open = true;
      void this.preview?.('check');
    };
    summary.append(batch);
    const body = node('div');
    body.className = 'basket-body';
    root.append(body);
    const notice = node('output');
    notice.setAttribute('role', 'status');
    notice.className = 'basket-notice';
    body.append(notice);
    const button = (label, work) => {
      const el = node('button', label);
      el.type = 'button';
      el.onclick = async () => {
        el.disabled = true;
        try {
          await work();
        } catch {
          notice.textContent = this.t(
            '操作未完成；请重估并核对能力、连接或导出目录。表格请先选择关键词/域名列。',
            'Action failed. Re-estimate and check bindings, connection or export folder.',
          );
        } finally {
          el.disabled = false;
        }
      };
      return el;
    };
    for (const id of [...this.selected])
      if (!this.state.items.some((item) => item.id === id)) this.selected.delete(id);
    if (!this.state.items.length) {
      body.append(
        node(
          'p',
          this.t(
            '点页面上的＋、划词或勾选结果加入。',
            'Use page +, selection or result checkboxes to collect.',
          ),
        ),
      );
      return;
    }
    const toolbar = node('div');
    toolbar.className = 'basket-actions';
    toolbar.append(
      button(this.t('全选', 'Select all'), () => {
        this.selected = new Set(this.state.items.map((item) => item.id));
        this.render();
      }),
      button(this.t('删除所选', 'Remove selected'), async () =>
        this.update(await this.request('basket_remove', { ids: [...this.selected] })),
      ),
      button(this.t('清空', 'Clear'), async () => this.update(await this.request('basket_clear'))),
    );
    body.append(toolbar);
    const names = {
      keyword: this.t('关键词', 'Keywords'),
      domain: this.t('域名', 'Domains'),
      url: 'URL',
      table: this.t('表格', 'Tables'),
    };
    for (const kind of ['keyword', 'domain', 'url', 'table']) {
      const items = this.state.items.filter((item) => item.type === kind);
      if (!items.length) continue;
      const group = node('fieldset');
      group.append(node('legend', names[kind] + ` · ${items.length}`));
      for (const item of items) {
        const label = node('label'),
          check = node('input');
        check.type = 'checkbox';
        check.checked = this.selected.has(item.id);
        check.onchange = () => {
          if (check.checked) this.selected.add(item.id);
          else this.selected.delete(item.id);
        };
        label.append(check, node('span', item.label || item.value));
        group.append(label);
      }
      body.append(group);
    }
    const operations = node('div');
    operations.className = 'basket-actions';
    body.append(operations);
    const preview = node('section');
    preview.className = 'batch-preview';
    preview.setAttribute('aria-live', 'polite');
    body.append(preview);
    const run = async (operation) => {
      if (!this.selected.size) {
        notice.textContent = this.t('先选择工作篮中的对象。', 'Select basket items first.');
        return;
      }
      const plan = await this.request('basket_plan', { ids: [...this.selected], operation });
      this.review(plan);
    };
    this.preview = run;
    this.review = (plan) => {
      preview.replaceChildren(
        node('strong', this.t('执行前确认', 'Review before execution')),
        node(
          'p',
          `${plan.count} ${this.t('个对象', 'objects')} · ${plan.task_count} ${this.t('任务', 'task')} · ${plan.call_upper_bound} ${this.t('次工具调用上限', 'tool calls at most')}`,
        ),
      );
      preview.append(
        node(
          'p',
          this.t('协作模型：', 'Assistl: ') +
            (plan.model_id || this.t('不调用 / 待回报', 'None / pending')),
        ),
      );
      preview.append(
        node(
          'p',
          this.t('模型调用 ', 'Model calls ') +
            plan.model_calls +
            ' · ' +
            this.t('预计 token ', 'Estimated tokens ') +
            plan.estimated_tokens,
        ),
        node(
          'p',
          plan.estimated_seconds != null
            ? this.t('预计秒数 ', 'Estimated seconds ') + plan.estimated_seconds
            : this.t(
                '耗时未知；调用超时预算秒数（不含排队/人工处理） ',
                'Duration unknown; call timeout budget seconds (excluding queue/human gates) ',
              ) + plan.timeout_upper_seconds,
        ),
      );
      if (plan.objects?.length)
        preview.append(
          node(
            'p',
            this.t('对象预览：', 'Objects: ') +
              plan.objects
                .map((item) => item.keyword || item.domain || item.value || '')
                .join(' · ') +
              (plan.remaining_objects ? this.t('；另有 ', '; plus ') + plan.remaining_objects : ''),
          ),
        );
      if (plan.export_dir)
        preview.append(node('p', this.t('导出目录：', 'Export directory: ') + plan.export_dir));
      for (const tool of plan.tools)
        preview.append(
          node(
            'p',
            `${tool.capability} · ${tool.provider} · ${tool.calls}${tool.upper_bound ? this.t('次以内', ' max') : this.t('次', ' calls')} · ${{ zero: this.t('零成本', 'Zero cost'), metered: this.t('消耗额度', 'Metered'), external: this.t('不可逆 / 对外', 'External') }[tool.risk] || this.t('消耗额度', 'Metered')}`,
          ),
        );
      preview.append(
        node(
          'p',
          this.t(
            '未知/付费来源不会自动执行；预估变化需重新确认。',
            'Unknown/paid sources never run automatically. Changed estimates require review.',
          ),
        ),
      );
      const finish = async (confirmation) => {
        const result = await this.request('basket_execute', {
          token: plan.token,
          ...(confirmation ? { confirmation } : {}),
        });
        if (result.secondary_required) {
          preview.append(
            node(
              'p',
              this.t(
                '这包含不可逆或对外动作。再次确认才会执行。',
                'This includes irreversible or external actions. Confirm again to execute.',
              ),
            ),
            button(this.t('再次确认', 'Confirm again'), () => finish(result.confirmation)),
          );
          return;
        }
        if (result.clipboard !== undefined)
          await doc.defaultView.navigator.clipboard.writeText(result.clipboard);
        if (result.files?.length)
          notice.textContent = result.files.map((file) => file.path).join('；');
        else
          notice.textContent = result.started
            ? this.t(
                '已在后台开始；批次进度见进行中。',
                'Started in background. See running batches.',
              )
            : this.t('已完成', 'Done');
        preview.replaceChildren();
      };
      preview.append(
        button(this.t('确认执行', 'Confirm execution'), () => finish()),
        button(this.t('取消', 'Cancel'), () => preview.replaceChildren()),
      );
    };
    for (const [operation, zh, en] of [
      ['check', '批量查词', 'Check keywords'],
      ['expand', '批量扩词', 'Expand keywords'],
      ['trends', '查热度', 'Check trends'],
      ['competitors', '查竞品', 'Analyze competitors'],
      ['save', '存词池', 'Save to pool'],
      ['export', '导出', 'Export Excel / CSV'],
      ['copy', '复制', 'Copy'],
    ])
      operations.append(button(this.t(zh, en), () => run(operation)));
  }
}
