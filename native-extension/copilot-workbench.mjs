// 中文注释：工作台只管理显式选择的材料；所有执行由宿主复验任务合同。
const node = (doc, tag, text, className) => {
  const value = doc.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
};
export function suitableTask(task, materials) {
  if (!materials.length || materials.length > 10) return false;
  if (['table.compare', 'table.join'].includes(task.id) && materials.length !== 2) return false;
  if (task.subject === 'image') return materials.length === 1 && materials[0].kind === 'image';
  if (['table', 'tables'].includes(task.subject))
    return (
      materials.every((row) => row.kind === 'table') &&
      (task.subject === 'table' ? materials.length === 1 : materials.length >= 2)
    );
  return (
    materials.every((row) => row.kind !== 'image') &&
    (task.subject === 'texts' ? materials.length >= 2 : materials.length === 1)
  );
}
export function describeTaskRules(options, en = false) {
  const t = (zh, english) => (en ? english : zh);
  const labels = {
    keys: t('主键', 'Keys'),
    fields: t('保留列', 'Keep columns'),
    group_by: t('分组', 'Group by'),
    value: t('数值列', 'Value column'),
    aggregate: t('计算', 'Aggregation'),
    pivot: t('交叉维度', 'Pivot'),
    sort: t('排序列', 'Sort column'),
    numeric_fields: t('数字列', 'Numeric columns'),
    date_fields: t('日期列', 'Date columns'),
    date_format: t('日期格式', 'Date format'),
    join: t('关联方式', 'Join mode'),
  };
  const lines = [];
  for (const [key, label] of Object.entries(labels))
    if (options[key] !== undefined)
      lines.push(
        `${label}：${Array.isArray(options[key]) ? options[key].join(' / ') || t('未选择', 'None selected') : options[key]}`,
      );
  for (const [key, label] of [
    ['trim', t('清理首尾空白', 'Trim whitespace')],
    ['dedupe', t('去重', 'Deduplicate')],
    ['descending', t('降序', 'Descending')],
    ['include_unchanged', t('包含未变化记录', 'Include unchanged rows')],
  ])
    if (typeof options[key] === 'boolean')
      lines.push(`${label}：${options[key] ? t('是', 'Yes') : t('否', 'No')}`);
  const operators = {
    equals: '=',
    contains: t('包含', 'contains'),
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    empty: t('为空', 'is empty'),
    not_empty: t('非空', 'is not empty'),
  };
  for (const rule of options.filters || [])
    lines.push(
      `${t('条件', 'Condition')}：${rule.field} ${operators[rule.op] || rule.op} ${rule.value ?? ''}`,
    );
  for (const [field, multiplier] of Object.entries(options.unit_multipliers || {}))
    lines.push(`${t('单位换算', 'Unit conversion')}：${field} × ${multiplier}`);
  for (const split of options.split || [])
    lines.push(
      `${t('拆列', 'Split')}：${split.field} → ${split.into.join(' / ')} (${t('分隔符', 'separator')} ${split.separator})`,
    );
  for (const [name, combine] of Object.entries(options.combine || {}))
    lines.push(
      `${t('合列', 'Combine')}：${combine.fields.join(' / ')} → ${name} (${t('分隔符', 'separator')} ${combine.separator})`,
    );
  return lines.join('\n') || t('采用此任务的默认规则。', 'Use the default rules for this task.');
}
export function optionsFromForm(task, form) {
  const value = (name) => form.elements.namedItem(name)?.value?.trim() || '';
  const checked = (name) => form.elements.namedItem(name)?.checked === true;
  const list = (name) =>
    [...(form.elements.namedItem(name)?.selectedOptions || [])]
      .map((option) => option.value)
      .filter(Boolean);
  const options = {};
  if (task === 'image.table') {
    options.headers = value('image_headers')
      .split(/[,，\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    options.cuts = value('image_cuts')
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map((part) => Number(part.replace(/%$/, '')) / 100);
    options.skip_rows = Number(value('image_skip_rows') || 0);
    if (
      !options.headers.length ||
      new Set(options.headers).size !== options.headers.length ||
      options.cuts.length !== options.headers.length + 1 ||
      options.cuts.some(
        (cut, i) =>
          !Number.isFinite(cut) || cut < 0 || cut > 1 || (i > 0 && cut <= options.cuts[i - 1]),
      )
    )
      throw Error('请填写唯一列名及递增的列边界百分比，边界数量须比列名多1。');
    if (!Number.isInteger(options.skip_rows) || options.skip_rows < 0 || options.skip_rows > 1000)
      throw Error('跳过表头行数须为0–1000的整数。');
  }
  if (['table.compare', 'table.join'].includes(task)) {
    options.keys = list('keys');
    if (task === 'table.join') options.join = value('join');
    else options.include_unchanged = checked('include_unchanged');
  }
  if (task === 'table.clean') {
    Object.assign(options, {
      trim: checked('trim'),
      dedupe: checked('dedupe'),
      numeric_fields: list('numeric_fields'),
      date_fields: list('date_fields'),
      date_format: value('date_format') || '%Y-%m-%d',
    });
    if (list('keys').length) options.keys = list('keys');
    if (value('split_field') && value('split_names'))
      options.split = [
        {
          field: value('split_field'),
          separator: value('separator') || ',',
          into: value('split_names')
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      ];
    if (value('combine_name') && list('combine_fields').length)
      options.combine = {
        [value('combine_name')]: {
          fields: list('combine_fields'),
          separator: value('combine_separator'),
        },
      };
    if (value('unit_field') && value('unit_multiplier'))
      options.unit_multipliers = { [value('unit_field')]: Number(value('unit_multiplier')) };
  }
  if (task === 'table.filter') {
    if (value('filter_field'))
      options.filters = [
        { field: value('filter_field'), op: value('operator'), value: value('filter_value') },
      ];
    if (value('sort'))
      Object.assign(options, { sort: value('sort'), descending: checked('descending') });
    if (list('fields').length) options.fields = list('fields');
  }
  if (['table.stats', 'table.pivot'].includes(task)) {
    Object.assign(options, { group_by: list('group_by'), aggregate: value('aggregate') });
    if (value('value')) options.value = value('value');
    if (task === 'table.pivot') options.pivot = value('pivot');
  }
  if (task === 'table.explain' || !task.startsWith('table.')) {
    for (const key of ['question', 'level', 'answers', 'instructions', 'target_language'])
      if (value(key)) options[key] = value(key);
    for (const key of ['fields', 'dimensions'])
      if (value(key))
        options[key] = value(key)
          .split(/[,，\n]/)
          .map((part) => part.trim())
          .filter(Boolean);
  }
  return options;
}
export class WorkbenchPanel {
  constructor(doc, command, { language = 'zh', capture, onChange = () => {} } = {}) {
    Object.assign(this, { doc, command, capture, onChange });
    this.en = language.startsWith('en');
    this.selected = new Set();
    this.state = { materials: [], tasks: [] };
    this.root = doc.getElementById('task-workbench');
    this.t = (zh, en) => (this.en ? en : zh);
    this.build();
  }
  build() {
    const { doc, root, t } = this;
    root.addEventListener('close', () => {
      if (doc.activeElement !== doc.body && !root.contains(doc.activeElement)) return;
      // 中文注释：读取材料会替换建议卡，原生对话框此时无法把焦点还给已移除的按钮。
      const target =
        this.returnFocus?.isConnected && !this.returnFocus.closest('[hidden],[inert]')
          ? this.returnFocus
          : doc.getElementById('open-settings');
      target?.focus();
    });
    const header = node(doc, 'header', undefined, 'work-dialog-heading');
    const title = node(doc, 'h2', t('配置任务', 'Prepare task'));
    title.id = 'task-workbench-title';
    const close = this.button(t('关闭', 'Close'), () => root.close());
    header.append(title, close);
    const hint = node(
      doc,
      'p',
      t(
        '收集材料，选择任务，查看并继续处理结果。表格计算在本机完成。',
        'Collect materials, choose a task, then review and continue the result. Table calculations run locally.',
      ),
      'work-dialog-hint',
    );
    this.hint = hint;
    this.defaultHint = hint.textContent;
    const captures = node(doc, 'div', undefined, 'workbench-toolbar');
    for (const [mode, zh, en] of [
      ['page', '读取当前页', 'Read page'],
      ['selection', '读取选区', 'Read selection'],
      ['table', '读取页面表格', 'Read tables'],
      ['canvas', '读取 Canvas 图表', 'Read Canvas charts'],
    ])
      captures.append(
        this.button(t(zh, en), () =>
          this.run(async () => {
            const before = new Set(this.state.materials.map((m) => m.id));
            this.state = await this.capture(mode);
            for (const row of this.state.materials)
              if (!before.has(row.id)) this.selected.add(row.id);
            this.render();
            this.onChange();
          }),
        ),
      );
    const paste = node(doc, 'details');
    paste.append(
      node(
        doc,
        'summary',
        t('粘贴文字、CSV / TSV 或导入图片', 'Paste text, CSV / TSV or import an image'),
      ),
    );
    this.pasteTitle = node(doc, 'input');
    this.pasteTitle.placeholder = t('材料名称', 'Material title');
    this.pasteTitle.setAttribute('aria-label', this.pasteTitle.placeholder);
    this.pasteText = node(doc, 'textarea');
    this.pasteText.rows = 4;
    this.pasteText.maxLength = 100000;
    this.pasteText.placeholder = t(
      '粘贴正文或带表头的 CSV / TSV',
      'Paste text or CSV / TSV with headers',
    );
    this.pasteText.setAttribute('aria-label', this.pasteText.placeholder);
    const additions = node(doc, 'div', undefined, 'workbench-toolbar');
    for (const [kind, zh, en] of [
      ['text', '加入文字材料', 'Add text'],
      ['table', '加入表格材料', 'Add table'],
    ])
      additions.append(
        this.button(t(zh, en), () =>
          this.run(async () => {
            await this.add({
              kind,
              title: this.pasteTitle.value || t('粘贴材料', 'Pasted material'),
              text: this.pasteText.value,
              partial: false,
            });
            this.pasteText.value = '';
          }),
        ),
      );
    const fileLabel = node(doc, 'label', t('PNG 图片（最多 150KiB）', 'PNG image (up to 150KiB)'));
    const file = node(doc, 'input');
    file.type = 'file';
    file.accept = 'image/png';
    file.onchange = () =>
      this.run(async () => {
        const image = file.files?.[0];
        if (!image) return;
        if (image.size > 150000 || image.type !== 'image/png')
          throw Error(t('请选择150KiB以内的PNG图片', 'Choose a PNG image up to 150KiB'));
        const bytes = new Uint8Array(await image.arrayBuffer());
        if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => bytes[i] !== byte))
          throw Error(t('图片格式无效', 'Invalid PNG image'));
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await this.add({ kind: 'image', title: image.name, image: btoa(binary), partial: true });
        file.value = '';
      });
    fileLabel.append(file);
    paste.append(this.pasteTitle, this.pasteText, additions, fileLabel);
    this.materials = node(doc, 'section', undefined, 'workbench-materials');
    this.form = node(doc, 'form', undefined, 'workbench-form');
    this.task = node(doc, 'select');
    this.task.setAttribute('aria-label', t('选择任务', 'Choose a task'));
    this.task.onchange = () => {
      this.notice.textContent = '';
      this.renderFields();
    };
    this.search = node(doc, 'input');
    this.search.type = 'search';
    this.search.placeholder = t('查找任务', 'Find task');
    this.search.setAttribute('aria-label', this.search.placeholder);
    this.search.oninput = () => this.renderTasks();
    this.fields = node(doc, 'div', undefined, 'workbench-fields');
    this.interpretation = node(doc, 'details');
    this.interpretation.append(
      node(doc, 'summary', t('用一句话描述处理规则', 'Describe processing rules')),
    );
    this.instruction = node(doc, 'textarea');
    this.instruction.rows = 2;
    this.instruction.maxLength = 2000;
    this.instruction.setAttribute('aria-label', t('处理规则', 'Processing rules'));
    this.interpretButton = this.button(t('生成规则预览', 'Preview rules'), () =>
      this.run(async () => {
        if (!this.instruction.value.trim())
          throw Error(t('请先描述处理规则。', 'Describe the processing rules first.'));
        const value = await this.command('workbench_interpret', {
          task: this.task.value,
          materials: [...this.selected],
          instruction: this.instruction.value.trim(),
        });
        this.renderFields(value.options);
        this.interpretedOptions = structuredClone(value.options);
        this.rulePreview.textContent = [
          value.explanation,
          describeTaskRules(value.options, this.en),
        ]
          .filter(Boolean)
          .join('\n');
        this.useRules.checked = true;
        this.rulesLabel.hidden = false;
        this.fields
          .querySelectorAll('input,select,textarea')
          .forEach((input) => (input.disabled = true));
        this.notice.textContent = t(
          '规则已校验。请核对预览，再点击执行；也可取消采用并手动调整。',
          'Rules validated. Review the preview, then run; or uncheck to edit manually.',
        );
      }),
    );
    this.interpretHint = node(doc, 'p', undefined, 'small');
    this.rulePreview = node(doc, 'p', undefined, 'small rule-preview');
    this.rulePreview.dataset.userContent = 'true';
    this.rulesLabel = node(doc, 'label', t('采用这组已校验规则', 'Use these validated rules'));
    this.useRules = node(doc, 'input');
    this.useRules.type = 'checkbox';
    this.useRules.onchange = () =>
      this.fields
        .querySelectorAll('input,select,textarea')
        .forEach((input) => (input.disabled = this.useRules.checked));
    this.rulesLabel.prepend(this.useRules);
    this.rulesLabel.hidden = true;
    this.interpretation.append(
      this.instruction,
      this.interpretButton,
      this.interpretHint,
      this.rulePreview,
      this.rulesLabel,
    );
    this.readiness = node(doc, 'p', undefined, 'small');
    const preferenceLabel = node(doc, 'label', t('此任务的推荐偏好', 'Recommendation preference'));
    this.preference = node(doc, 'select');
    this.preference.setAttribute('aria-label', t('此任务的推荐偏好', 'Recommendation preference'));
    for (const [value, label] of [
      ['neutral', t('正常推荐', 'Normal')],
      ['prefer', t('优先推荐', 'Prefer')],
      [
        'hide',
        t('隐藏主动推荐（仍可手动执行）', 'Hide proactive suggestions (still available manually)'),
      ],
    ]) {
      const option = node(doc, 'option', label);
      option.value = value;
      this.preference.append(option);
    }
    this.preference.onchange = () =>
      this.run(async () => {
        this.state = await this.command('workbench_preference', {
          task: this.task.value,
          value: this.preference.value,
        });
        this.notice.textContent = t('推荐偏好已更新。', 'Recommendation preference updated.');
        this.onChange();
      });
    preferenceLabel.append(this.preference);
    this.execute = node(doc, 'button', t('执行任务', 'Run task'), 'primary');
    this.execute.type = 'submit';
    this.form.onsubmit = (event) => {
      event.preventDefault();
      void this.run(async () => {
        const plan = await this.command('workbench_plan', {
          task: this.task.value,
          materials: [...this.selected],
          options:
            this.useRules.checked && this.interpretedOptions
              ? structuredClone(this.interpretedOptions)
              : optionsFromForm(this.task.value, this.form),
        });
        const card = plan.card;
        if (!card || card.recommendation_state === 'blocked')
          throw Error(
            t(
              '任务能力尚未就绪，请先配置 Agent 或所需能力。',
              'Required capabilities are not ready. Configure Agent or the required capability.',
            ),
          );
        if (card.recommendation_state === 'needs_parameters')
          throw Error(t('请补全任务参数。', 'Complete the task parameters.'));
        const receipt = await this.command('execute', { id: card.id });
        const execution = receipt?.suggestions?.find((row) => row.id === card.id);
        if (!execution || !['queued', 'executing', 'completed'].includes(execution.status))
          throw Error(
            t(
              '任务尚未进入执行队列，请检查准备状态后重试。',
              'The task has not entered execution. Check readiness and retry.',
            ),
          );
        this.notice.textContent = t(
          '已开始任务，请在进行中或结果中查看。',
          'Task started. Review it in Running or Results.',
        );
        this.onChange();
      });
    };
    this.form.append(
      this.search,
      this.task,
      this.interpretation,
      this.fields,
      this.readiness,
      preferenceLabel,
      this.execute,
    );
    this.history = node(doc, 'details');
    this.history.append(
      node(doc, 'summary', t('任务与学习记录', 'Task and study history')),
      node(doc, 'div'),
    );
    this.notice = node(doc, 'output');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    const footer = node(doc, 'div', undefined, 'workbench-toolbar');
    footer.append(
      this.button(t('清空材料', 'Clear materials'), () =>
        this.run(async () => {
          this.state = await this.command('workbench_clear');
          this.selected.clear();
          this.render();
          this.onChange();
        }),
      ),
      this.button(t('清空任务与学习记录', 'Clear task and study history'), () =>
        this.run(async () => {
          this.state = await this.command('workbench_clear', { history: true });
          this.selected.clear();
          this.render();
          this.onChange();
        }),
      ),
    );
    root.append(
      header,
      hint,
      captures,
      paste,
      this.materials,
      this.form,
      this.notice,
      this.history,
      footer,
    );
  }
  button(label, action) {
    const button = node(this.doc, 'button', label);
    button.type = 'button';
    button.onclick = action;
    return button;
  }
  async run(action) {
    if (this.busy) return;
    this.busy = true;
    this.root.setAttribute('aria-busy', 'true');
    this.notice.textContent = '';
    this.execute.disabled = true;
    try {
      await action();
    } catch (error) {
      this.notice.textContent = error.message;
    } finally {
      this.busy = false;
      this.root.removeAttribute('aria-busy');
      this.updateReady();
    }
  }
  async add(params) {
    const before = new Set(this.state.materials.map((row) => row.id));
    this.state = await this.command('workbench_add', params);
    for (const row of this.state.materials) if (!before.has(row.id)) this.selected.add(row.id);
    this.render();
    this.onChange();
  }
  async open(row) {
    if (!this.root.open) this.returnFocus = this.doc.activeElement;
    this.notice.textContent = '';
    this.search.value = '';
    this.taskTitle = row?.title;
    this.captureMode = row?.capture_mode;
    this.state = await this.command('workbench_state');
    if (row) this.selected = new Set(row.material_ids || row.params?.materials || []);
    this.render();
    if (row?.params?.task) {
      this.task.value = row.params.task;
      this.renderFields(row.params.options);
    }
    if (!this.root.open) this.root.showModal?.();
  }
  render() {
    this.selected = new Set(
      [...this.selected].filter((id) => this.state.materials.some((row) => row.id === id)),
    );
    this.materials.replaceChildren(
      node(
        this.doc,
        'h3',
        this.t(
          `材料 · ${this.state.materials.length} / 30`,
          `Materials · ${this.state.materials.length} / 30`,
        ),
      ),
    );
    if (!this.state.materials.length)
      this.materials.append(
        node(
          this.doc,
          'p',
          this.t('先读取页面或粘贴材料。', 'Read a page or paste materials to start.'),
          'small',
        ),
      );
    for (const row of this.state.materials) {
      const line = node(this.doc, 'div', undefined, 'workbench-material');
      const label = node(this.doc, 'label');
      const check = node(this.doc, 'input');
      check.type = 'checkbox';
      check.checked = this.selected.has(row.id);
      check.onchange = () => {
        if (check.checked) this.selected.add(row.id);
        else this.selected.delete(row.id);
        this.renderTasks();
      };
      const name = node(this.doc, 'strong', row.title);
      name.dataset.userContent = 'true';
      const detail = node(
        this.doc,
        'span',
        `${row.kind} · v${row.revision}${row.kind === 'table' ? ` · ${row.rows} ${this.t('行', 'rows')}` : ''} · ${row.partial ? this.t('范围可能不完整', 'May be partial') : this.t('已提供范围', 'Supplied scope')}`,
        'small',
      );
      label.append(check, name, detail);
      line.append(
        label,
        this.button(this.t('移除', 'Remove'), () =>
          this.run(async () => {
            this.state = await this.command('workbench_remove', { ids: [row.id] });
            this.selected.delete(row.id);
            this.render();
            this.onChange();
          }),
        ),
      );
      if (row.source) {
        const source = node(this.doc, 'span', row.source, 'small workbench-source');
        source.dataset.userContent = 'true';
        line.append(source);
      }
      this.materials.append(line);
    }
    this.renderTasks();
    const history = this.history.querySelector('div');
    history.replaceChildren();
    if (!this.state.history?.length && !this.state.study_records?.length)
      history.append(node(this.doc, 'p', this.t('暂无保存记录。', 'No saved records.'), 'small'));
    for (const record of [...(this.state.history || [])].reverse()) {
      const name =
        this.state.tasks.find((task) => task.id === record.task)?.name[this.en ? 'en' : 'zh'] ||
        record.task;
      history.append(
        node(
          this.doc,
          'p',
          `${name} · ${record.status || record.kind || ''}${record.elapsed_ms != null ? ' · ' + record.elapsed_ms + ' ms' : ''}`,
          'small',
        ),
      );
    }
    for (const record of this.state.study_records || []) {
      const details = node(this.doc, 'details');
      details.dataset.studyId = record.id;
      const title = node(
        this.doc,
        'summary',
        `${record.title} · ${record.self_rating === 'understood' ? this.t('已理解（自评）', 'Understood (self assessed)') : this.t('需要复习 / 已作答', 'Review / answered')}`,
      );
      title.dataset.userContent = 'true';
      const content = node(this.doc, 'div');
      content.append(
        this.button(this.t('读取学习记录', 'Read study record'), () =>
          this.run(async () => {
            const value = await this.command('workbench_study_read', { id: record.id });
            content.replaceChildren();
            for (const [label, text] of [
              [this.t('问题', 'Question'), value.question],
              [this.t('我的作答', 'My answer'), value.answer],
              [this.t('参考答案', 'Reference answer'), value.reference_answer],
              [this.t('来源摘录', 'Source excerpt'), value.source_quote],
            ]) {
              if (!text) continue;
              const block = node(this.doc, 'section');
              block.dataset.userContent = 'true';
              block.append(node(this.doc, 'h3', label), node(this.doc, 'p', text, 'rule-preview'));
              content.append(block);
            }
            content.append(
              this.button(this.t('加入复习材料', 'Add review material'), () =>
                this.run(() =>
                  this.add({
                    kind: 'text',
                    title: record.title || this.t('复习材料', 'Review material'),
                    text: [value.question, value.reference_answer, value.source_quote]
                      .filter(Boolean)
                      .join('\n\n'),
                    partial: true,
                  }),
                ),
              ),
            );
          }),
        ),
      );
      details.append(title, content);
      history.append(details);
    }
    if (this.state.metrics)
      history.append(
        node(
          this.doc,
          'p',
          this.t(
            `已记录 ${this.state.metrics.attempts} 次任务 · 本机验证 ${this.state.metrics.verified} 次 · 来源核对 ${this.state.metrics.source_checked} 次；模型准确性未独立验证。`,
            `${this.state.metrics.attempts} recorded tasks · ${this.state.metrics.verified} locally verified · ${this.state.metrics.source_checked} source checked. Model accuracy not independently verified.`,
          ),
          'small',
        ),
      );
  }
  renderTasks() {
    const previous = this.task.value;
    this.task.replaceChildren();
    for (const task of this.state.tasks.filter(
      (task) =>
        task.id === previous ||
        (task.id + ' ' + task.name.zh + ' ' + task.name.en)
          .toLowerCase()
          .includes(this.search.value.toLowerCase()),
    )) {
      const option = node(
        this.doc,
        'option',
        `${task.name[this.en ? 'en' : 'zh']} · ${task.model ? 'Agent' : this.t('本机', 'Local')}`,
      );
      option.value = task.id;
      this.task.append(option);
    }
    if ([...this.task.options].some((option) => option.value === previous))
      this.task.value = previous;
    else this.task.value = this.task.options[0]?.value || '';
    this.renderFields();
  }
  field(
    name,
    label,
    choices,
    { multiple = false, type = 'text', value = '', required = false } = {},
  ) {
    const wrapper = node(this.doc, 'label', label);
    let input;
    if (choices) {
      input = node(this.doc, 'select');
      input.multiple = multiple;
      if (multiple) input.size = Math.min(4, Math.max(2, choices.length));
      else input.append(node(this.doc, 'option', '—'));
      for (const choice of choices) {
        const [key, title] = Array.isArray(choice) ? choice : [choice, choice];
        const option = node(this.doc, 'option', title);
        option.value = key;
        input.append(option);
      }
    } else input = node(this.doc, type === 'textarea' ? 'textarea' : 'input');
    input.name = name;
    if (!choices && type !== 'textarea') input.type = type;
    input.required = required;
    input.setAttribute('aria-label', label);
    if (type === 'checkbox') input.checked = value === true;
    else if (multiple && Array.isArray(value))
      for (const option of input.options) option.selected = value.includes(option.value);
    else input.value = value;
    wrapper.append(input);
    this.fields.append(wrapper);
    return input;
  }
  renderFields(values = {}) {
    const task = this.task.value,
      t = this.t;
    const spec = this.state.tasks.find((row) => row.id === task);
    this.doc.getElementById('task-workbench-title').textContent =
      spec?.name?.[this.en ? 'en' : 'zh'] || this.taskTitle || t('配置任务', 'Prepare task');
    const prompts = {
      page: t(
        '先读取当前页，再核对材料和参数。',
        'Read the current page, then review materials and parameters.',
      ),
      selection: t(
        '先读取选区，再核对材料和参数。',
        'Read the selection, then review materials and parameters.',
      ),
      table: t(
        '先读取页面表格或粘贴表格，再核对范围和参数。',
        'Read or paste a table, then review its scope and parameters.',
      ),
      canvas: t(
        '先读取 Canvas 图表或导入 PNG，再核对识别范围。',
        'Read a Canvas chart or import PNG, then review the recognition scope.',
      ),
    };
    this.hint.textContent =
      !this.selected.size && this.captureMode
        ? prompts[this.captureMode] || this.defaultHint
        : this.defaultHint;
    this.fields.replaceChildren();
    this.interpretedOptions = null;
    this.useRules.checked = false;
    this.rulesLabel.hidden = true;
    this.rulePreview.textContent = '';
    this.interpretation.hidden = !task.startsWith('table.') || task === 'table.explain';
    this.preference.value = this.state.preferences?.[task] || 'neutral';
    this.preference.disabled = !task;
    if (values.filters?.[0])
      values = {
        ...values,
        filter_field: values.filters[0].field,
        operator: values.filters[0].op,
        filter_value: values.filters[0].value,
      };
    const selected = this.state.materials.filter((row) => this.selected.has(row.id));
    const columns = selected[0]?.columns || [];
    const field = (name, zh, en, choices, options = {}) =>
      this.field(name, t(zh, en), choices, {
        ...options,
        ...(values[name] !== undefined ? { value: values[name] } : {}),
      });
    if (task === 'image.table') {
      if (values.headers)
        values = {
          ...values,
          image_headers: values.headers.join(', '),
          image_cuts: values.cuts?.map((value) => Math.round(value * 1000000) / 10000).join(', '),
          image_skip_rows: values.skip_rows || 0,
        };
      field('image_headers', '列名（逗号分隔）', 'Column names (comma separated)', null, {
        required: true,
      });
      field(
        'image_cuts',
        '列分隔位置（百分比，如0,50,100）',
        'Column boundaries (percent, e.g. 0,50,100)',
        null,
        { required: true },
      );
      const skip = field('image_skip_rows', '跳过表头行数', 'Header rows to skip', null, {
        type: 'number',
        value: 0,
      });
      skip.min = '0';
      skip.max = '1000';
      skip.step = '1';
      this.fields.append(
        node(
          this.doc,
          'p',
          t(
            '列边界按图片宽度设置；识别结果和未分配文字须人工核对。',
            'Boundaries are relative to image width; review recognized and unassigned text.',
          ),
          'small',
        ),
      );
    }
    if (['table.clean', 'table.compare', 'table.join'].includes(task))
      field('keys', '主键列（可多选）', 'Key columns (multiple)', columns, {
        multiple: true,
        required: task !== 'table.clean',
      });
    if (task === 'table.clean') {
      field('trim', '清理首尾空白', 'Trim whitespace', null, { type: 'checkbox', value: true });
      field(
        'dedupe',
        '按主键去重（未选主键则按整行）',
        'Deduplicate (all columns if no key)',
        null,
        { type: 'checkbox', value: true },
      );
      field('numeric_fields', '转为数字的列', 'Numeric columns', columns, { multiple: true });
      field('date_fields', '统一日期的列', 'Date columns', columns, { multiple: true });
      field('date_format', '原始日期格式', 'Input date format', null, { value: '%Y-%m-%d' });
      field('split_field', '拆分列', 'Split column', columns);
      field('separator', '拆分分隔符', 'Split separator', null, { value: ',' });
      field('split_names', '拆分后列名（逗号分隔）', 'New column names (comma separated)');
      field('combine_fields', '合并列', 'Combine columns', columns, { multiple: true });
      field('combine_name', '合并后列名', 'Combined column name');
      field('combine_separator', '合并分隔符', 'Combine separator');
      field('unit_field', '换算单位的列', 'Unit conversion column', columns);
      field('unit_multiplier', '换算倍率', 'Unit multiplier', null, { type: 'number' });
    }
    if (task === 'table.filter') {
      field('filter_field', '筛选列', 'Filter column', columns);
      field(
        'operator',
        '条件',
        'Condition',
        [
          ['contains', t('包含', 'Contains')],
          ['equals', t('等于', 'Equals')],
          ['gt', '>'],
          ['gte', '≥'],
          ['lt', '<'],
          ['lte', '≤'],
          ['empty', t('为空', 'Empty')],
          ['not_empty', t('非空', 'Not empty')],
        ],
        { value: 'contains' },
      );
      field('filter_value', '条件值', 'Filter value');
      field('sort', '排序列', 'Sort column', columns);
      field('descending', '降序', 'Descending', null, { type: 'checkbox' });
      field('fields', '保留列（不选则全部）', 'Keep columns (all by default)', columns, {
        multiple: true,
      });
    }
    if (['table.stats', 'table.pivot'].includes(task)) {
      field('group_by', '分组列', 'Group by', columns, { multiple: true });
      field(
        'aggregate',
        '计算方式',
        'Aggregation',
        [
          ['count', t('计数', 'Count')],
          ['sum', t('求和', 'Sum')],
          ['mean', t('平均', 'Mean')],
          ['min', t('最小', 'Minimum')],
          ['max', t('最大', 'Maximum')],
        ],
        { value: 'count' },
      );
      field('value', '数值列（计数可不选）', 'Value column (optional for count)', columns);
      if (task === 'table.pivot')
        field('pivot', '交叉维度列', 'Pivot column', columns, { required: true });
    }
    if (task === 'table.join')
      field(
        'join',
        '关联方式',
        'Join mode',
        [
          ['left', t('保留左表', 'Left')],
          ['inner', t('仅匹配项', 'Inner')],
          ['outer', t('保留两表', 'Outer')],
        ],
        { value: 'left' },
      );
    if (task === 'table.compare')
      field('include_unchanged', '包含未变化记录', 'Include unchanged rows', null, {
        type: 'checkbox',
      });
    if (this.state.tasks.find((row) => row.id === task)?.model) {
      field('instructions', '关注点或期望产物', 'Focus or desired outcome', null, {
        type: 'textarea',
      });
      if (task === 'page.question')
        field('question', '你的问题', 'Your question', null, { type: 'textarea', required: true });
      if (
        [
          'text.explain',
          'learn.notes',
          'learn.concepts',
          'learn.quiz',
          'learn.practice',
          'organize.tutorial',
        ].includes(task)
      )
        field(
          'level',
          '当前基础',
          'Current knowledge',
          [
            ['beginner', t('入门', 'Beginner')],
            ['intermediate', t('有基础', 'Intermediate')],
            ['advanced', t('深入', 'Advanced')],
          ],
          { value: 'beginner' },
        );
      if (task === 'learn.feedback')
        field('answers', '题目和你的答案', 'Questions and your answers', null, {
          type: 'textarea',
          required: true,
        });
      if (task === 'text.translate')
        field('target_language', '目标语言', 'Target language', null, { required: true });
      if (['page.extract', 'organize.specs', 'form.preview', 'table.explain'].includes(task))
        field('fields', '字段（逗号或换行分隔）', 'Fields (comma or newline separated)');
      if (['research.compare', 'page.product'].includes(task))
        field(
          'dimensions',
          '比较维度（逗号或换行分隔）',
          'Dimensions (comma or newline separated)',
        );
    }
    this.updateReady();
  }
  updateReady() {
    const task = this.state.tasks.find((row) => row.id === this.task.value);
    const selected = this.state.materials.filter((row) => this.selected.has(row.id));
    const ready = task && suitableTask(task, selected) && (!task.model || this.state.model_ready);
    this.interpretButton.disabled =
      !!this.busy || !this.state.model_ready || !task || !suitableTask(task, selected);
    this.interpretHint.textContent = this.state.model_ready
      ? this.t(
          '只生成规则预览，经你确认后执行。',
          'Generate a preview; execute only after your confirmation.',
        )
      : this.t(
          '自然语言解析需要配置并开启 Agent；下方本机规则无需 Agent。',
          'Natural language interpretation requires Agent. The local rules below work without Agent.',
        );
    this.execute.disabled = !!this.busy || !ready;
    const requirements = {
      table: this.t(
        '此任务需要1份表格材料。请读取页面表格或粘贴CSV/TSV，并仅选择表格材料。',
        'This task needs one table. Read or paste CSV/TSV and select only a table.',
      ),
      tables: this.t(
        ['table.compare', 'table.join'].includes(task?.id)
          ? '此任务需要恰好2份表格材料。请取消选择多余表格和其他类型材料。'
          : '此任务需要至少2份表格材料。请读取或粘贴表格，并取消选择其他类型材料。',
        ['table.compare', 'table.join'].includes(task?.id)
          ? 'This task needs exactly two tables. Deselect extra tables and other material types.'
          : 'This task needs at least two tables. Read or paste tables and deselect other material types.',
      ),
      text: this.t(
        '此任务需要1份文字、页面或表格材料。请读取或粘贴内容，并仅选择1份材料。',
        'This task needs one text, page or table material. Read or paste content and select one material.',
      ),
      texts: this.t(
        '此任务需要至少2份非图片材料。请继续收集材料，并取消选择图片。',
        'This task needs at least two non-image materials. Collect more materials and deselect images.',
      ),
      image: this.t(
        '此任务需要1幅PNG图片。请读取Canvas图表或导入PNG，并仅选择1幅图片。',
        'This task needs one PNG image. Read a Canvas chart or import PNG, then select one image.',
      ),
    };
    this.readiness.textContent = !task
      ? this.t('请选择适合材料类型和数量的任务。', 'Choose a task matching the materials.')
      : !suitableTask(task, selected)
        ? selected.length > 10
          ? this.t(
              '每次最多选择10份材料，请取消多余选择。',
              'Select at most ten materials; deselect the extras.',
            )
          : requirements[task.subject]
        : task.model && !this.state.model_ready
          ? this.t(
              '此任务需要配置并开启 Agent；材料仍保留。',
              'Configure and enable Agent for this task. Materials are retained.',
            )
          : this.t(
              '仅处理已选材料；结果会说明验证范围。',
              'Only selected materials are processed. Results state the verification scope.',
            );
  }
  syncReadiness(state) {
    const ready = state.enabled === true && state.ready === true;
    if (this.state.model_ready === ready) return;
    this.state.model_ready = ready;
    this.updateReady();
  }
}
