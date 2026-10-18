export class CapabilitiesPanel {
  constructor(doc, request, { language = 'zh' } = {}) {
    this.doc = doc;
    this.request = request;
    this.en = !language.startsWith('zh');
    this.root = doc.getElementById('local-capabilities');
    this.draft = null;
    this.root.addEventListener('toggle', () => {
      if (this.root.open && !this.state && doc.defaultView?.document === doc) void this.refresh();
    });
  }
  t(zh, en) {
    return this.en ? en : zh;
  }
  async refresh() {
    try {
      this.state = await this.request('capability_state');
      this.render();
    } catch {
      this.doc.getElementById('capability-notice').textContent = this.t(
        '本机能力暂不可用，请检查扩展包。',
        'Local capabilities unavailable. Check extension packages.',
      );
    }
  }
  render() {
    const doc = this.doc,
      root = this.root.querySelector('.capability-body'),
      notice = doc.getElementById('capability-notice');
    root.replaceChildren();
    const node = (tag, text, className) => {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (className) el.className = className;
      return el;
    };
    const button = (text, work) => {
      const el = node('button', text);
      el.type = 'button';
      el.onclick = async () => {
        el.disabled = true;
        el.setAttribute('aria-busy', 'true');
        try {
          await work();
        } catch {
          notice.textContent = this.t(
            '操作未完成；请核对绑定声明、模型状态或页面登录状态。',
            'Action failed. Verify binding declaration, model status or page access.',
          );
        } finally {
          el.disabled = false;
          el.removeAttribute('aria-busy');
        }
      };
      return el;
    };
    const toolbar = (...buttons) => {
      const row = node('div', undefined, 'capability-actions');
      row.append(...buttons);
      return row;
    };
    const field = (id, text, input) => {
      const wrap = node('div', undefined, 'capability-field'),
        label = node('label', text, 'capability-label');
      input.id = id;
      label.htmlFor = id;
      input.setAttribute('aria-label', text);
      wrap.append(label, input);
      return wrap;
    };
    const editor = (rows, value) => {
      const el = node('textarea');
      el.className = 'capability-input';
      el.rows = rows;
      el.value = value;
      el.spellcheck = false;
      el.addEventListener('input', () => el.removeAttribute('aria-invalid'));
      return el;
    };
    const parse = (el) => {
      try {
        return JSON.parse(el.value);
      } catch (error) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
        throw error;
      }
    };
    const info = (text) => {
      const el = node('button', this.t('查看说明', 'View info'), 'info-button');
      el.type = 'button';
      el.title = text;
      el.setAttribute('aria-label', text);
      return el;
    };
    const pending = this.state.pending_templates || [],
      disabled = Object.keys(this.state.disabled_templates || {});
    notice.textContent = [
      pending.length
        ? this.t('有模板需要合并：', 'Templates need merging: ') + pending.join('、')
        : '',
      disabled.length
        ? this.t('已跳过无效模板：', 'Invalid templates skipped: ') + disabled.join('、')
        : '',
    ]
      .filter(Boolean)
      .join('；');
    const status = {
      work_origin_changed: this.t(
        '工具入口跳转到其他来源，请重新核实链接',
        'Tool redirected to another origin; review the route',
      ),
      work_ownership_changed: this.t('工作页归属已变化', 'Workspace ownership changed'),
      work_page_focused: this.t(
        '正在查看工作页，后台检查已暂停',
        'Work page is focused; background check paused',
      ),
      available: this.t('可调用，实际数据待任务核实', 'Callable; data verified during tasks'),
      needs_browser_check: this.t('待只读体检', 'Needs read-only probe'),
      needs_login_or_readable_report: this.t('需登录或可读报表', 'Needs login or readable report'),
      needs_route_confirmation: this.t('需核实报表链接', 'Confirm report route'),
      disabled_today: this.t('今日已停用', 'Disabled today'),
      wrong_browser: this.t('需指定浏览器', 'Requires configured browser'),
      missing_command: this.t('缺命令', 'Command missing'),
      missing_script: this.t('缺脚本', 'Script missing'),
      needs_explicit_fallback: this.t('需开启独立后备', 'Enable fallback execution'),
    };
    root.append(
      toolbar(
        button(this.t('检查状态', 'Check status'), async () => {
          this.state = await this.request('capability_health', {
            browser: /Edg\//.test(globalThis.navigator?.userAgent || '') ? 'edge' : 'chrome',
          });
          this.render();
        }),
        button(this.t('发现工具', 'Find tools'), async () => {
          this.discovery = await this.request('fbl_discover', {
            urls: (this.urls || '')
              .split(/[\n,]/)
              .map((url) => url.trim())
              .filter(Boolean),
            scan_tabs: this.scanTabs === true,
          });
          this.render();
        }),
        button(this.t('重读声明', 'Reload bindings'), async () => {
          this.state = await this.request('capability_reload');
          this.render();
          notice.textContent = this.t(
            '声明已重读，新经验在下次开启协作时发送。',
            'Declarations reloaded. New experience is sent when Assist starts again.',
          );
        }),
      ),
    );
    const urls = editor(2, this.urls || '');
    urls.placeholder = this.t('逗号或换行分隔，可留空', 'Comma or newline separated; optional');
    urls.oninput = () => {
      this.urls = urls.value;
    };
    root.append(field('capability-urls', this.t('工具站地址', 'Tool URLs'), urls));
    const tabs = node('input');
    tabs.type = 'checkbox';
    tabs.checked = this.scanTabs === true;
    tabs.onchange = () => {
      this.scanTabs = tabs.checked;
    };
    const tabLabel = node('label', undefined, 'capability-toggle');
    tabLabel.append(
      tabs,
      node('span', this.t('扫描当前标签URL与标题', 'Scan open tab URLs and titles')),
    );
    root.append(tabLabel);
    if (this.discovery) {
      const selected = [],
        edits = new Map();
      this.discovery.candidates.forEach((row, index) => {
        const section = node('section', undefined, 'capability-candidate'),
          check = node('input');
        check.type = 'checkbox';
        check.checked = row.selected === true;
        selected.push([row.id, check]);
        const label = node('label', undefined, 'capability-toggle');
        label.append(
          check,
          node(
            'span',
            `${row.capability} · ${row.source} · ${Math.round(row.confidence * 100)}% · ${row.cost} · ${row.validation}`,
          ),
        );
        const input = editor(
          3,
          JSON.stringify({
            priority: row.binding.priority || 100,
            batch_limit: row.binding.batch_limit || 1,
          }),
        );
        input.classList.add('capability-code');
        edits.set(row.id, input);
        section.append(
          label,
          node('p', row.basis, 'capability-help'),
          field(
            `capability-candidate-${index}`,
            this.t('绑定参数、优先级与批量上限', 'Binding parameters, priority and batch limit'),
            input,
          ),
        );
        root.append(section);
      });
      root.append(
        toolbar(
          button(this.t('确认绑定', 'Bind selected'), async () => {
            const ids = selected.filter(([, check]) => check.checked).map(([id]) => id);
            await this.request('fbl_confirm', {
              ids,
              edits: Object.fromEntries(ids.map((id) => [id, parse(edits.get(id))])),
            });
            this.discovery = null;
            await this.refresh();
            notice.textContent = this.t(
              '已保存，关闭协作后重读声明',
              'Saved. Close Assist and reload declarations.',
            );
          }),
        ),
      );
      for (const error of this.discovery.errors)
        root.append(
          node('p', `${error.source}: ${error.code}`, 'capability-help capability-error'),
        );
    }
    if (this.state.running)
      root.append(
        info(
          this.t(
            '正在后台核实页面；不会输入凭据。',
            'Checking pages in background; no credentials are entered.',
          ),
        ),
      );
    for (const [capability, value] of Object.entries(this.state.capabilities || {})) {
      const detail = node('details', undefined, 'capability-binding');
      detail.append(
        node(
          'summary',
          capability +
            ' · ' +
            (value.status === 'available'
              ? this.t('已绑定', 'Bound')
              : this.t('需绑定 / 暂无可用后备', 'Needs binding / no available fallback')),
        ),
      );
      for (const binding of value.bindings)
        detail.append(
          info(
            `${binding.id} · ${status[binding.status] || binding.status} · ${binding.cost} · ${this.t('每批', 'batch')} ${binding.batch_limit}${binding.serial ? ' · ' + this.t('串行', 'serial') : ''}`,
          ),
        );
      root.append(detail);
    }
    const candidates = node('select'),
      blank = node('option', this.t('手动绑定 / 选择候选', 'Manual binding / select candidate'));
    blank.value = '';
    candidates.append(blank);
    for (const candidate of this.state.candidates || []) {
      const item = node(
        'option',
        candidate.name +
          ' → ' +
          candidate.capabilities.join(', ') +
          this.t('（待确认）', ' (unconfirmed)'),
      );
      item.value = candidate.id;
      candidates.append(item);
    }
    candidates.value = this.candidateValue || '';
    candidates.onchange = () => {
      this.candidateValue = candidates.value;
    };
    root.append(
      field('capability-candidate', this.t('选择技能候选', 'Select skill candidate'), candidates),
    );
    const cap = node('select');
    for (const name of Object.keys(this.state.capabilities || {})) {
      const option = node('option', name);
      option.value = name;
      cap.append(option);
    }
    cap.value = this.capabilityValue || cap.value;
    cap.onchange = () => {
      this.capabilityValue = cap.value;
    };
    root.append(field('capability-name', this.t('选择标准能力', 'Choose capability'), cap));
    const binding = editor(
      6,
      this.bindingValue ||
        JSON.stringify(
          {
            id: 'my-local-binding',
            type: 'command',
            argv: [],
            priority: 10,
            batch_limit: 100,
            cost: 'local',
          },
          null,
          2,
        ),
    );
    binding.classList.add('capability-code');
    binding.oninput = () => {
      this.bindingValue = binding.value;
    };
    root.append(
      field(
        'capability-binding',
        this.t('审阅能力绑定JSON', 'Review capability binding JSON'),
        binding,
      ),
    );
    root.append(
      toolbar(
        info(
          this.t(
            '只接受你审阅的本机绑定。发现只运行帮助、读取 schema；确认后保存。',
            'Only your reviewed local binding is saved. Discovery runs help only and reads MCP schemas; confirmation saves bindings.',
          ),
        ),
        button(this.t('保存绑定', 'Confirm and save binding'), async () => {
          this.state = await this.request('capability_bind', {
            candidate: candidates.value,
            capability: cap.value,
            binding: parse(binding),
          });
          this.render();
          notice.textContent = this.t(
            '已保存本机声明；请再次体检。',
            'Local declaration saved. Run health check again.',
          );
        }),
        button(this.t('记住工具', 'Remember this tool'), async () => {
          await this.request('learn_current');
          this.draft = await this.request('tool_draft');
          this.draftValue = null;
          this.render();
          notice.textContent = this.t(
            '草稿未保存，请核对URL、字段和链接；未知链接请留空。',
            'Draft not saved. Review URL, fields and links; leave unknown links empty.',
          );
        }),
      ),
    );
    if (this.draft) {
      const input = editor(12, this.draftValue || JSON.stringify(this.draft.profile, null, 2));
      input.classList.add('capability-code');
      input.oninput = () => {
        this.draftValue = input.value;
      };
      root.append(
        field(
          'capability-tool-draft',
          this.t('修改工具画像草稿', 'Edit tool-profile draft'),
          input,
        ),
        toolbar(
          button(this.t('保存工具', 'Confirm and save tool profile'), async () => {
            this.state = await this.request('tool_save', {
              id: this.draft.id,
              profile: parse(input),
            });
            this.draft = null;
            this.render();
            notice.textContent = this.t(
              '画像已保存；能力仍需单独绑定和体检。',
              'Profile saved. Bind and probe capabilities separately.',
            );
          }),
        ),
      );
    }
  }
}
