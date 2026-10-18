// 中文注释：包管理仅操作本地声明；执行中的协作会话关闭后才允许修改包集合。
export class PacksPanel {
  constructor(doc, request, { language = 'zh' } = {}) {
    this.doc = doc;
    this.request = request;
    this.en = !language.startsWith('zh');
    this.root = doc.getElementById('functional-plugins');
    this.root.addEventListener('toggle', () => {
      if (this.root.open) void this.refresh();
    });
  }
  t(zh, en) {
    return this.en ? en : zh;
  }
  busy(value) {
    if (this.enabled === value) return;
    this.enabled = value;
    if (this.root.open) void this.refresh();
  }
  async refresh() {
    try {
      this.state = await this.request('fbl_pack_state');
      this.render();
    } catch {
      this.notice(
        this.t(
          '无法读取功能插件，请检查本地连接。',
          'Cannot read plugins. Check the local connection.',
        ),
      );
    }
  }
  notice(text) {
    this.doc.getElementById('plugins-notice').textContent = text;
  }
  render() {
    const doc = this.doc,
      body = this.root.querySelector('.plugins-body');
    body.replaceChildren();
    const node = (tag, text) => {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const busy = this.state.busy || this.enabled;
    if (busy)
      body.append(
        node(
          'p',
          this.t(
            '关闭协作并等待任务结束后，可以安装或卸载。',
            'Turn off Copilot and wait for tasks before installing or uninstalling.',
          ),
        ),
      );
    const act = (label, command, name) => {
      const button = node('button', label);
      button.type = 'button';
      button.disabled = !!busy;
      button.onclick = async () => {
        button.disabled = true;
        try {
          const value = typeof name === 'function' ? name() : name;
          if (!value) throw Error('package path required');
          this.state = await this.request(command, { name: value });
          this.render();
          this.notice(
            this.t(
              '功能插件已更新，重新开启协作后生效。',
              'Plugins updated. Start Copilot again to apply.',
            ),
          );
        } catch {
          this.notice(
            this.t(
              '操作未完成：请关闭协作，并确认插件未被修改、路径有效。',
              'Action failed. Turn off Copilot and check the package path and local modifications.',
            ),
          );
        } finally {
          button.disabled = !!busy;
        }
      };
      return button;
    };
    for (const row of this.state.plugins) {
      const card = node('section');
      card.dataset.pack = row.id;
      card.append(
        node('h3', row.name || row.id),
        node(
          'p',
          `${row.id} · ${row.release || this.t('契约 ', 'schema ') + row.schema_version} · ${this.t(row.loaded ? '已加载' : '未加载', row.loaded ? 'Loaded' : 'Not loaded')}`,
        ),
      );
      card.append(
        node(
          'p',
          this.t('来源：', 'Source: ') +
            ({
              builtin: this.t('内置', 'Built-in'),
              managed: this.t('受管安装', 'Managed install'),
              local: this.t('本地自定义', 'Local adapter'),
            }[row.source] || row.source),
        ),
        node('p', row.path),
      );
      if (row.description) card.append(node('p', row.description));
      card.append(
        node('p', this.t('能力：', 'Capabilities: ') + (row.capabilities.join(', ') || '—')),
        node('p', this.t('工作流：', 'Workflows: ') + (row.workflows.join(', ') || '—')),
      );
      if (row.needs_setup.length)
        card.append(node('p', this.t('待初始化：', 'Needs setup: ') + row.needs_setup.join(', ')));
      if (row.modified)
        card.append(
          node(
            'p',
            this.t(
              '本地修改或未受管：文件已保留，无法直接覆盖或卸载。',
              'Modified or unmanaged: files are preserved and cannot be replaced or uninstalled here.',
            ),
          ),
        );
      if (row.error)
        card.append(
          node(
            'p',
            this.t('声明不可读取或未通过校验。', 'Package declaration is unreadable or invalid.'),
          ),
        );
      if (row.can_remove) {
        const remove = node('button', this.t('卸载', 'Uninstall'));
        remove.type = 'button';
        remove.disabled = !!busy;
        remove.onclick = () => {
          const confirm = act(this.t('确认卸载', 'Confirm uninstall'), 'fbl_pack_remove', row.id),
            cancel = node('button', this.t('取消', 'Cancel'));
          cancel.type = 'button';
          cancel.onclick = () => this.render();
          remove.replaceWith(confirm, cancel);
        };
        card.append(remove);
      }
      body.append(card);
    }
    const input = node('input');
    input.type = 'text';
    input.value = this.path || '';
    input.placeholder = this.t('本地插件文件夹的绝对路径', 'Absolute local plugin folder');
    input.setAttribute('aria-label', this.t('插件文件夹', 'Plugin folder'));
    input.oninput = () => {
      this.path = input.value;
    };
    const install = act(this.t('安装本地插件', 'Install local plugin'), 'fbl_pack_install', () =>
      input.value.trim(),
    );
    body.append(
      node(
        'p',
        this.t(
          '只安装可信来源的适配包；任务执行时可能运行包声明的本机命令。',
          'Install trusted adapters only; tasks may run commands declared by the package.',
        ),
      ),
      input,
      install,
    );
    for (const item of this.state.available)
      if (!item.installed)
        body.append(
          act(this.t('安装内置 ', 'Install built-in ') + item.id, 'fbl_pack_install', item.id),
        );
    const refresh = node('button', this.t('刷新列表', 'Refresh list'));
    refresh.type = 'button';
    refresh.onclick = () => this.refresh();
    body.append(refresh);
  }
}
