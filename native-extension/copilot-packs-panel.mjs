import { statusNode } from './ui-design.mjs';

const reasons = {
  declaration_valid: ['插件声明已通过校验。', 'Plugin declarations passed validation.'],
  template_valid: ['任务模板已通过校验。', 'Task templates passed validation.'],
  invalid_template: [
    '任务模板无效，请修复模板或重新安装插件。',
    'Invalid task template. Repair it or reinstall the plugin.',
  ],
  invalid_or_unreadable_package: [
    '插件声明无效、缺少文件或不可读取，请核对安装内容。',
    'Plugin declarations or files are invalid, missing or unreadable. Review the installation.',
  ],
  unmanaged_or_modified: [
    '存在本地修改或非受管文件，请核对完整性。',
    'Local modifications or unmanaged files require an integrity review.',
  ],
  package_not_loaded: [
    '插件尚未加载，请关闭协作后重新读取声明。',
    'Plugin is not loaded. Turn off Assist and reload declarations.',
  ],
  binding_not_loaded: [
    '插件绑定尚未加载，请检查配置并重读声明。',
    'Plugin bindings are not loaded. Review setup and reload declarations.',
  ],
  agent_configured: [
    'Agent 配置存在，实际连接仍需核实。',
    'Agent configuration exists; the live connection still needs verification.',
  ],
  agent_setup_required: ['需要先配置并连接 Agent。', 'Configure and connect Agent first.'],
  local_prerequisites_passed: [
    '本地先决条件通过；实际服务和数据待任务验证。',
    'Local prerequisites passed; verify real services and data during tasks.',
  ],
  missing_command: [
    '找不到所需本机命令，请修复依赖或调整绑定。',
    'A required local command is missing. Repair dependencies or adjust the binding.',
  ],
  missing_script: [
    '找不到插件脚本，请检查安装与绑定路径。',
    'A plugin script is missing. Check installation and binding paths.',
  ],
  missing_local_data: [
    '找不到所需本地数据，请检查数据配置。',
    'Required local data is missing. Review data configuration.',
  ],
  needs_metadata_refresh: [
    '能力声明已变化，请重新扫描并核实。',
    'Capability metadata changed. Refresh discovery and verify it.',
  ],
  needs_mcp_check: [
    '连接器工具合同尚未核实，请检查连接配置。',
    'Connector tool contracts need verification. Review the connection setup.',
  ],
  needs_browser_check: [
    '尚需只读页面检查，请进入配置后检查本机能力。',
    'A read-only page check is required. Open configuration and check local capabilities.',
  ],
  needs_login_or_readable_report: [
    '需要登录工具站或打开可读取的报表。',
    'Sign in to the tool or open a readable report.',
  ],
  needs_route_confirmation: [
    '报表入口尚未确认，请核对并保存链接。',
    'The report route is unconfirmed. Review and save its link.',
  ],
  wrong_browser: [
    '请切换到插件绑定的浏览器后检查。',
    'Check again in the browser configured for this plugin.',
  ],
  missing_profile: [
    '缺少工具页面配置，请补全绑定声明。',
    'Tool page configuration is missing. Complete the binding.',
  ],
  disabled_today: [
    '能力已暂停，请查看停用原因后恢复。',
    'This capability is paused. Review the reason before restoring it.',
  ],
  needs_explicit_fallback: [
    '此能力需要单独启用后备执行方式。',
    'Enable the separate fallback execution mode for this capability.',
  ],
  probe_unavailable: [
    '功能检查未完成，请检查本机连接后重试。',
    'The capability check did not complete. Check the local connection and retry.',
  ],
  available: [
    '依赖已就绪，实际数据仍在任务中核实。',
    'Dependencies are ready; verify actual data during tasks.',
  ],
};
export const pluginReason = (reason, en = false) => reasons[reason]?.[en ? 1 : 0] || String(reason);

// 中文注释：安装/加载与可用性分开；只有宿主本地检查能改变健康状态。
export function pluginStatus(row, pending, en = false) {
  const text = (zh, english) => (en ? english : zh);
  if (pending)
    return {
      key: 'running',
      label: {
        checking: text('检查中', 'Checking'),
        installing: text('安装中', 'Installing'),
        removing: text('卸载中', 'Uninstalling'),
      }[pending],
    };
  if (row.installed === false || row.status === 'not_installed')
    return { key: 'disconnected', label: text('未安装', 'Not installed') };
  const status = row.health?.status || row.status;
  if (row.error || status === 'error') return { key: 'failed', label: text('异常', 'Error') };
  if (status === 'needs_update')
    return { key: 'waiting', label: text('需更新 / 重新检查', 'Update / recheck required') };
  if (status === 'ready')
    return { key: 'connected', label: text('本地先决条件通过', 'Local prerequisites passed') };
  if (status === 'needs_setup' || row.needs_setup?.length)
    return { key: 'waiting', label: text('已安装 · 待配置', 'Installed · setup required') };
  if (row.loaded === false)
    return { key: 'waiting', label: text('已安装 · 未加载', 'Installed · not loaded') };
  return { key: 'waiting', label: text('已安装 · 待检查', 'Installed · not checked') };
}
export class PacksPanel {
  constructor(doc, request, { language = 'zh', onConfigure } = {}) {
    Object.assign(this, { doc, request, onConfigure });
    this.en = !language.startsWith('zh');
    this.root = doc.getElementById('functional-plugins');
    this.pending = new Map();
    this.generation = 0;
    this.root.addEventListener('toggle', () => {
      if (
        this.root.open &&
        (!doc.getElementById('plugins-view') ||
          doc.getElementById('plugins-view').dataset.active === 'true')
      )
        void this.refresh();
    });
  }
  t(zh, en) {
    return this.en ? en : zh;
  }
  busy(value) {
    if (this.enabled === value) return;
    this.enabled = value;
    if (this.state) this.render();
  }
  async refresh() {
    if (this.refreshing || this.pending.size) return;
    this.refreshing = true;
    const generation = ++this.generation;
    this.notice(this.t('正在读取本地插件状态…', 'Reading local plugin status…'));
    try {
      const state = await this.request('fbl_pack_state');
      if (generation !== this.generation) return;
      if (!Array.isArray(state.plugins)) throw Error('invalid plugin state');
      this.state = state;
      this.render();
      this.notice('');
    } catch {
      if (generation !== this.generation) return;
      const message = this.t(
        '无法读取功能插件，请检查本地连接后刷新。',
        'Cannot read plugins. Check the local connection and refresh.',
      );
      this.notice(message);
      const trigger = this.doc.getElementById('open-plugins');
      if (trigger) {
        trigger.dataset.health = 'error';
        trigger.title = message;
      }
      const overview = this.doc.getElementById('plugins-overview');
      if (overview) overview.textContent = message;
    } finally {
      this.refreshing = false;
    }
  }
  notice(text) {
    this.doc.getElementById('plugins-notice').textContent = text;
  }
  async action(name, command, kind) {
    if (this.pending.size) return;
    this.generation++;
    this.pending.set(name, kind);
    this.render();
    this.root.setAttribute('aria-busy', 'true');
    this.notice(
      this.t(
        kind === 'installing'
          ? '正在安装插件…'
          : kind === 'removing'
            ? '正在卸载插件…'
            : '正在检查本地先决条件…',
        kind === 'installing'
          ? 'Installing plugin…'
          : kind === 'removing'
            ? 'Uninstalling plugin…'
            : 'Checking local prerequisites…',
      ),
    );
    try {
      const result = await this.request(command, { name });
      if (result.error || !Array.isArray(result.plugins)) throw Error('invalid plugin state');
      this.state = result;
      this.notice(
        command === 'fbl_pack_check'
          ? this.t(
              '本地检查完成。真实网页、登录和服务数据仍需在任务中核实。',
              'Local checks completed. Verify real pages, login and service data during tasks.',
            )
          : this.t(
              '功能插件已更新；新任务使用当前插件状态。',
              'Plugins updated; new tasks use the current state.',
            ),
      );
    } catch {
      this.notice(
        this.t(
          '操作未完成。请检查异常原因、本机连接及协作运行状态后重试。',
          'Action failed. Review diagnostics, local connection and running Assist tasks, then retry.',
        ),
      );
    } finally {
      this.pending.delete(name);
      this.root.removeAttribute('aria-busy');
      this.render();
    }
  }
  render() {
    if (!this.state) return;
    const doc = this.doc,
      body = this.root.querySelector('.plugins-body');
    body.replaceChildren();
    const node = (tag, text, className) => {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    const button = (label, run, { disabled = false, action } = {}) => {
      const el = node('button', label);
      el.type = 'button';
      el.disabled = disabled || !!this.pending.size;
      if (action) el.dataset.packAction = action;
      el.onclick = run;
      return el;
    };
    const busy = !!this.state.busy || !!this.enabled;
    const installed = this.state.plugins || [],
      available = (this.state.available || []).filter(
        (row) => !row.installed && !installed.some((pack) => pack.id === row.id),
      );
    const overview = this.doc.getElementById('plugins-overview');
    const attention = installed.filter(
      (row) => pluginStatus(row, null, this.en).key !== 'connected',
    );
    if (overview)
      overview.textContent = this.t(
        `已安装 ${installed.length} 个；${attention.length} 项需要配置或处理。`,
        `${installed.length} installed; ${attention.length} need setup or attention.`,
      );
    const trigger = doc.getElementById('open-plugins');
    if (trigger) {
      trigger.dataset.health = attention.length ? 'warning' : 'ok';
      trigger.title = overview?.textContent || '';
      trigger.setAttribute(
        'aria-label',
        this.t(
          `功能插件，${attention.length} 项需要处理`,
          `Functional plugins, ${attention.length} need attention`,
        ),
      );
    }
    if (busy)
      body.append(
        node(
          'p',
          this.t(
            '协作运行期间可以检查；关闭协作并等待任务结束后才能安装或卸载。',
            'Checks remain available during Assist. Turn it off and wait for tasks before installing or uninstalling.',
          ),
          'plugin-scope',
        ),
      );
    for (const row of [...installed, ...available.map((row) => ({ ...row, installed: false }))]) {
      const card = node('section', undefined, 'plugin-card');
      card.dataset.pack = row.id;
      const header = node('header', undefined, 'plugin-card-heading');
      const title = node('h3', row.name || row.id);
      title.dataset.userContent = 'true';
      const status = pluginStatus(row, this.pending.get(row.id), this.en);
      header.append(
        title,
        statusNode(doc, status.key, { language: this.en ? 'en' : 'zh', label: status.label }),
      );
      card.append(header);
      if (row.description) {
        const description = node('p', row.description);
        description.dataset.userContent = 'true';
        card.append(description);
      }
      const meta = node(
        'p',
        `${row.id}${row.release ? ' · ' + row.release : ''} · ${row.installed === false ? this.t('尚未安装到本机', 'Not installed locally') : this.t(row.loaded ? '已加载' : '未加载', row.loaded ? 'Loaded' : 'Not loaded')}`,
        'small',
      );
      meta.dataset.userContent = 'true';
      card.append(meta);
      const health = row.health || {},
        reason = health.reason || row.reason || row.error;
      if (reason) {
        const p = node(
          'p',
          reason === 'local_prerequisites_passed'
            ? this.t('实际服务和数据待任务验证。', 'Verify real services and data during tasks.')
            : pluginReason(reason, this.en),
          `plugin-reason ${status.key === 'failed' ? 'plugin-error' : status.key === 'waiting' ? 'plugin-warning' : ''}`,
        );
        p.dataset.userContent = 'true';
        card.append(p);
      }
      if (row.needs_setup?.length)
        card.append(
          node(
            'p',
            this.t('待配置能力：', 'Capabilities needing setup: ') + row.needs_setup.join(' / '),
            'plugin-reason',
          ),
        );
      const actions = node('div', undefined, 'plugin-actions');
      if (row.installed === false)
        actions.append(
          button(
            this.t('安装', 'Install'),
            () => this.action(row.id, 'fbl_pack_install', 'installing'),
            { disabled: busy, action: 'install' },
          ),
        );
      else {
        actions.append(
          button(
            this.t('检查功能', 'Check functions'),
            () => this.action(row.id, 'fbl_pack_check', 'checking'),
            { action: 'check' },
          ),
        );
        actions.append(
          button(
            this.t('配置', 'Configure'),
            () => (this.onConfigure ? this.onConfigure(row) : this.request('open_capabilities')),
            { action: 'configure' },
          ),
        );
        if (row.can_remove)
          actions.append(
            button(
              this.t('卸载', 'Uninstall'),
              () => {
                const confirm = button(
                  this.t('确认卸载', 'Confirm uninstall'),
                  () => this.action(row.id, 'fbl_pack_remove', 'removing'),
                  { disabled: busy, action: 'confirm-remove' },
                );
                const cancel = button(this.t('取消', 'Cancel'), () => this.render());
                actions.querySelector('[data-pack-action=remove]').replaceWith(confirm, cancel);
              },
              { disabled: busy, action: 'remove' },
            ),
          );
      }
      card.append(actions);
      if (row.installed !== false) {
        const detail = node('details', undefined, 'plugin-details');
        detail.append(node('summary', this.t('检查详情与插件内容', 'Checks and plugin details')));
        detail.append(
          node(
            'p',
            this.t(
              '检查范围：本机声明、文件完整性与依赖；不调用付费服务，不读取真实网页。实际服务和数据仍待任务验证。',
              'Check scope: local declarations, file integrity and dependencies. No paid service calls or real page reads. Verify real services and data during tasks.',
            ),
            'plugin-scope',
          ),
        );
        if (health.checked_at) {
          const at = new Date(health.checked_at * 1000);
          detail.append(
            node(
              'p',
              this.t('检查时间：', 'Checked: ') + at.toLocaleString(this.en ? 'en' : 'zh-CN'),
              'small',
            ),
          );
        }
        for (const check of health.checks || row.checks || []) {
          const p = node(
            'p',
            `${check.label} · ${this.t(check.status === 'ok' ? '通过' : check.status === 'error' ? '异常' : '待核实', check.status === 'ok' ? 'Passed' : check.status === 'error' ? 'Error' : 'Needs verification')}${check.reason ? ' · ' + pluginReason(check.reason, this.en) : ''}`,
          );
          p.dataset.userContent = 'true';
          detail.append(p);
        }
        detail.append(
          node('p', this.t('能力：', 'Capabilities: ') + (row.capabilities?.join(' / ') || '—')),
          node('p', this.t('工作流：', 'Workflows: ') + (row.workflows?.join(' / ') || '—')),
        );
        if (row.path) {
          const path = node('p', row.path, 'small');
          path.dataset.userContent = 'true';
          detail.append(path);
        }
        if (row.modified)
          detail.append(
            node(
              'p',
              this.t(
                '本地修改或非受管文件已保留；此页不会覆盖或卸载受保护文件。',
                'Local modifications and unmanaged files are preserved. Protected files cannot be replaced or uninstalled here.',
              ),
              'plugin-scope',
            ),
          );
        card.append(detail);
      }
      body.append(card);
    }
    const local = node('details', undefined, 'plugin-local-install');
    local.append(node('summary', this.t('安装本地插件', 'Install local plugin')));
    const input = node('input');
    input.type = 'text';
    input.value = this.path || '';
    input.placeholder = this.t('本地插件文件夹的绝对路径', 'Absolute local plugin folder');
    input.setAttribute('aria-label', this.t('插件文件夹', 'Plugin folder'));
    input.oninput = () => {
      this.path = input.value;
    };
    local.append(
      node(
        'p',
        this.t(
          '选择你信任的本地插件目录；安装前先验证声明与完整性。',
          'Use a trusted local plugin folder; declarations and integrity are checked before install.',
        ),
        'plugin-scope',
      ),
      input,
      button(
        this.t('安装本地插件', 'Install local plugin'),
        () => {
          const path = input.value.trim();
          if (!path) {
            this.notice(
              this.t('请填写插件文件夹的绝对路径。', 'Enter the absolute plugin folder path.'),
            );
            return;
          }
          this.path = path;
          return this.action(path, 'fbl_pack_install', 'installing');
        },
        { disabled: busy, action: 'install-local' },
      ),
    );
    body.append(
      local,
      button(this.t('刷新列表', 'Refresh list'), () => this.refresh(), { action: 'refresh' }),
    );
  }
}
