import { boardName } from './copilot-controls.mjs';
export const modeNames = { saving: '省钱', balanced: '均衡', quality: '高质量', custom: '自定义' };
const keys = [
  'inference_model',
  'exec_model',
  'max_parallel',
  'context_limit',
  'mode',
  'turn_multiplier',
  'exec_transport',
];
const validModel = (value) => !value || /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/.test(value);
function pick(catalog, tier) {
  const patterns =
    tier === 'fast'
      ? [/luna/i, /haiku|mini|flash/i]
      : [/gpt-6\.1-sol/i, /gpt-6-sol|opus|pro(?!vider)/i];
  for (const pattern of patterns) {
    const row = (catalog?.available || []).find((row) => pattern.test(row.id.split(':').at(-1)));
    if (row) return row.id;
  }
  return '';
}
export function presetValues(mode, models = {}) {
  if (mode === 'custom') return { mode };
  const high = mode === 'quality';
  return {
    mode,
    inference_model: pick(models.inference, high ? 'high' : 'fast'),
    exec_model: mode === 'balanced' ? '' : pick(models.execution, high ? 'high' : 'fast'),
    max_parallel: mode === 'saving' ? 1 : 3,
    context_limit: 6000,
    turn_multiplier: high ? 2 : 1,
  };
}
export function readSettings(doc) {
  const values = { mode: doc.querySelector('input[name=mode]:checked').value };
  for (const key of keys.filter((key) => key !== 'mode')) {
    const field = doc.getElementById('setting-' + key);
    values[key] = key.endsWith('_model')
      ? field.value === 'manual'
        ? doc.getElementById(key + '-manual').value.trim()
        : field.value
      : key === 'exec_transport'
        ? field.value
        : Number(field.value);
  }
  return values;
}
export class SettingsForm {
  constructor(doc, request) {
    this.doc = doc;
    this.request = request;
    this.models = {};
    this.state = null;
    this.dirty = false;
    this.version = 0;
    this.queue = Promise.resolve();
    this.timers = new Map();
    this.feedbackTimers = new Map();
    const form = doc.getElementById('copilot-settings-form');
    form.onsubmit = (event) => event.preventDefault();
    form.oninput = (event) => {
      const key = event.target.id?.replace(/^setting-/, '').replace(/-manual$/, '');
      if (!keys.includes(key)) return;
      this.dirty = true;
      this.version++;
      if (key !== 'mode') doc.querySelector('[name=mode][value=custom]').checked = true;
      this.manualFields();
      if (event.target.matches('input[type=number],input[id$="-manual"]')) {
        clearTimeout(this.timers.get(key));
        this.timers.set(
          key,
          setTimeout(() => void this.saveField(key), 450),
        );
      }
    };
    form.onchange = (event) => {
      if (event.target.name === 'mode') {
        const mode = event.target.value;
        this.version++;
        this.dirty = true;
        const values = { ...readSettings(doc), ...presetValues(mode, this.models) };
        this.fill(values);
        void this.save(values, 'mode');
        return;
      }
      const key = event.target.id?.replace(/^setting-/, '').replace(/-manual$/, '');
      if (event.target.value === 'refresh' && key?.endsWith('_model')) {
        this.fill(this.state?.config || readSettings(doc));
        void this.load(true);
        return;
      }
      if (!keys.includes(key)) return;
      clearTimeout(this.timers.get(key));
      doc.querySelector('[name=mode][value=custom]').checked = true;
      this.dirty = true;
      this.version++;
      void this.saveField(key);
    };
    for (const [id, key] of [
      ['ball', 'show_ball'],
      ['selection-popup', 'selection_popup'],
    ])
      doc.getElementById(id).onchange = () =>
        void this.saveInterface(key, doc.getElementById(id).checked);
    for (const [id, key] of [
      ['board-name-input', 'board_name'],
      ['table-export-dir', 'table_export_dir'],
      ['table-max-pages', 'table_max_pages'],
      ['table-delay-min', 'table_delay_min'],
      ['table-delay-max', 'table_delay_max'],
    ]) {
      const field = doc.getElementById(id);
      if (field)
        field.onchange = () =>
          this.savePreference(
            key,
            field.type === 'number' ? Number(field.value) : field.value,
            field,
          );
    }
    doc.getElementById('choose-export-directory').onclick = () => this.chooseExportDirectory();
    doc.getElementById('reset-export-directory').onclick = () => this.resetExportDirectory();
    doc.getElementById('open-log-directory').onclick = () => this.openLogsDirectory();
    for (const [id, key] of [
      ['page-annotations', 'page_annotations'],
      ['auto-zero', 'auto_zero'],
      ['annotation-density', 'annotation_density'],
    ]) {
      const field = doc.getElementById(id);
      if (field)
        field.onchange = async () => {
          field.disabled = true;
          try {
            this.update(
              await request('preferences', {
                [key]: field.type === 'checkbox' ? field.checked : field.value,
              }),
            );
            this.feedback(key, '✓');
          } catch {
            this.update(this.state);
            this.feedback(
              key,
              this.t('保存失败，请重试', 'Save failed. Retry.'),
              true,
              field.onchange,
            );
          } finally {
            field.disabled = false;
          }
        };
    }
  }
  t(zh, en) {
    return this.state?.locale === 'en' ? en : zh;
  }
  feedback(key, message, error = false, retryWork = null) {
    const el = this.doc.querySelector(`[data-feedback="${key}"]`);
    if (!el) return;
    clearTimeout(this.feedbackTimers.get(key));
    el.textContent = message;
    el.setAttribute('aria-label', message === '✓' ? this.t('已保存', 'Saved') : message);
    el.classList.toggle('failure', error);
    el.tabIndex = error ? 0 : -1;
    el.toggleAttribute('data-retry', error);
    if (error) {
      el.setAttribute('role', 'button');
      el.onclick =
        retryWork ||
        (() =>
          ['show_ball', 'selection_popup'].includes(key)
            ? this.saveInterface(
                key,
                this.doc.getElementById(key === 'show_ball' ? 'ball' : 'selection-popup').checked,
              )
            : key === 'mode'
              ? this.save(readSettings(this.doc), key)
              : this.saveField(key));
      el.onkeydown = (event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          el.click();
        }
      };
    } else {
      el.removeAttribute('role');
      el.onclick = null;
      el.onkeydown = null;
    }
    if (message === '✓')
      this.feedbackTimers.set(
        key,
        setTimeout(() => {
          el.textContent = '';
          el.removeAttribute('aria-label');
        }, 1200),
      );
  }

  manualFields() {
    for (const key of ['inference_model', 'exec_model'])
      this.doc.getElementById(key + '-manual').hidden =
        this.doc.getElementById('setting-' + key).value !== 'manual';
  }
  fill(values) {
    const doc = this.doc;
    for (const key of ['inference_model', 'exec_model']) {
      const select = doc.getElementById('setting-' + key),
        catalog = this.models[key === 'inference_model' ? 'inference' : 'execution'] || {},
        value = values[key] || '';
      select.replaceChildren();
      const option = (text, id) => {
        const node = doc.createElement('option');
        node.textContent = text;
        node.value = id;
        select.append(node);
      };
      option(
        this.t('跟随默认', 'Use default') + (catalog.current ? ' · ' + catalog.current : ''),
        '',
      );
      for (const row of catalog.available || [])
        option(row.label + (row.default ? this.t('（默认）', ' (default)') : ''), row.id);
      option(this.t('手动输入…', 'Enter manually…'), 'manual');
      option(this.t('刷新模型…', 'Refresh models…'), 'refresh');
      select.value = [...select.options].some((row) => row.value === value) ? value : 'manual';
      doc.getElementById(key + '-manual').value = value;
    }
    for (const key of keys.filter((key) => !key.endsWith('_model') && key !== 'mode'))
      doc.getElementById('setting-' + key).value =
        values[key] ?? (key === 'turn_multiplier' ? 1 : '');
    doc.querySelector(
      `[name=mode][value="${Object.hasOwn(modeNames, values.mode) ? values.mode : 'balanced'}"]`,
    ).checked = true;
    this.manualFields();
  }
  update(state) {
    this.state = state;
    for (const [id, key] of [
      ['page-annotations', 'page_annotations'],
      ['auto-zero', 'auto_zero'],
      ['annotation-density', 'annotation_density'],
    ]) {
      const field = this.doc.getElementById(id);
      if (field) {
        if (field.type === 'checkbox') field.checked = state[key] !== false;
        else field.value = state[key] || 'compact';
      }
    }
    const name = this.doc.getElementById('board-name-input');
    if (name) name.placeholder = boardName('', state.locale || 'zh');
    for (const [id, value] of [
      [
        'board-name-input',
        state.board_name ? boardName(state.board_name, state.locale || 'zh') : '',
      ],
      ['table-export-dir', state.table_export_dir || ''],
      ['table-max-pages', state.table_config?.max_pages || 50],
      ['table-delay-min', state.table_config?.delay_min || 1.5],
      ['table-delay-max', state.table_config?.delay_max || 3],
    ]) {
      const input = this.doc.getElementById(id);
      if (input && this.doc.activeElement !== input) {
        input.value = value;
        if (id === 'table-export-dir') input.title = value;
      }
    }
    if (state.config && !this.dirty && JSON.stringify(state.config) !== this.lastConfig) {
      this.fill(state.config);
      this.lastConfig = JSON.stringify(state.config);
    }
    this.doc.getElementById('ball').checked = state.show_ball !== false;
    this.doc.getElementById('selection-popup').checked = state.selection_popup !== false;
  }
  valid(values) {
    for (const key of ['inference_model', 'exec_model'])
      this.doc
        .getElementById(key + '-manual')
        .setCustomValidity(
          validModel(values[key]) ? '' : this.t('模型 ID 格式无效', 'Invalid model ID'),
        );
    return this.doc.getElementById('copilot-settings-form').reportValidity();
  }
  async saveField(key) {
    const values = readSettings(this.doc);
    if (
      key.endsWith('_model') &&
      this.doc.getElementById('setting-' + key).value === 'manual' &&
      !values[key]
    )
      return;
    return this.save({ [key]: values[key], mode: values.mode }, key);
  }
  save(values, key) {
    const all = { ...readSettings(this.doc), ...values };
    if (!this.valid(all)) return Promise.resolve(false);
    const version = this.version;
    this.feedback(key, this.t('保存中', 'Saving'));
    const job = this.queue.then(async () => {
      try {
        const state = await this.request('configure', values);
        this.state = state;
        if (version === this.version) {
          this.dirty = false;
          this.lastConfig = null;
          this.update(state);
        }
        this.feedback(key, '✓');
        return true;
      } catch {
        this.feedback(key, this.t('保存失败 · 重试', 'Save failed · retry'), true);
        return false;
      }
    });
    this.queue = job.then(() => {});
    return job;
  }
  async saveInterface(key, value) {
    const input = this.doc.getElementById(key === 'show_ball' ? 'ball' : 'selection-popup');
    if (input.disabled) return;
    input.dataset.busy = 'true';
    input.disabled = true;
    this.feedback(key, this.t('保存中', 'Saving'));
    try {
      this.update(await this.request('settings', { [key]: value }));
      this.feedback(key, '✓');
    } catch {
      input.checked = this.state?.[key] !== false;
      this.feedback(key, this.t('保存失败 · 重试', 'Save failed · retry'), true, () =>
        this.saveInterface(key, value),
      );
    } finally {
      delete input.dataset.busy;
      input.disabled = false;
    }
  }
  async savePreference(key, value, field) {
    if (this.disposed) return false;
    const feedback =
        this.doc.querySelector(`[data-feedback="${key}"]`) ||
        this.doc.getElementById(
          key === 'table_export_dir' ? 'export-directory-status' : 'preferences-feedback',
        ),
      before = this.state;
    const previous =
      key === 'board_name'
        ? before?.board_name
          ? boardName(before.board_name, before.locale || 'zh')
          : ''
        : key === 'table_export_dir'
          ? before?.table_export_dir || ''
          : before?.table_config?.[key.replace('table_', '')];
    feedback.textContent = this.t('保存中', 'Saving');
    feedback.classList.remove('failure');
    field.disabled = true;
    try {
      const state = await this.request('preferences', { [key]: value });
      if (!this.disposed) {
        this.update(state);
        feedback.textContent = this.t('已保存', 'Saved');
      }
      return true;
    } catch {
      if (!this.disposed) {
        if (before) this.update(before);
        field.value = previous ?? '';
        feedback.classList.add('failure');
        feedback.textContent = this.t('保存失败，请重试', 'Save failed. Retry.');
      }
      return false;
    } finally {
      if (!this.disposed) field.disabled = false;
    }
  }
  async loadDirectories() {
    if (this.directoryDefaults) return this.directoryDefaults;
    if (this.directoryLoading) return this.directoryLoading;
    this.directoryLoading = this.request('directory_defaults', {})
      .then((value) => {
        if (
          !value ||
          typeof value.export_dir !== 'string' ||
          !value.export_dir ||
          typeof value.logs_dir !== 'string' ||
          !value.logs_dir
        )
          throw Error('invalid directory defaults');
        if (this.disposed) return value;
        this.directoryDefaults = value;
        const button = this.doc.getElementById('open-log-directory');
        button.title = value.logs_dir;
        button.setAttribute(
          'aria-label',
          this.t('打开日志目录', 'Open log directory') + ' · ' + value.logs_dir,
        );
        return value;
      })
      .finally(() => {
        this.directoryLoading = null;
      });
    return this.directoryLoading;
  }
  directoryFeedback(message, error = false, target = 'export-directory-status') {
    if (this.disposed) return;
    const output = this.doc.getElementById(target);
    output.textContent = message;
    output.classList.toggle('failure', error);
  }
  directoryBusy(value) {
    if (this.disposed) return;
    for (const id of ['choose-export-directory', 'reset-export-directory']) {
      const button = this.doc.getElementById(id);
      button.disabled = value;
      button.setAttribute('aria-busy', String(value));
    }
  }
  async chooseExportDirectory() {
    const button = this.doc.getElementById('choose-export-directory');
    if (button.disabled || this.disposed) return;
    this.directoryBusy(true);
    const version = (this.directoryVersion = (this.directoryVersion || 0) + 1);
    this.directoryFeedback(
      this.t('请在系统窗口中选择目录', 'Choose a folder in the system dialog'),
    );
    let pending = false;
    try {
      let value = await this.request('directory_choose_start', {});
      if (this.disposed || version !== this.directoryVersion) {
        if (value.id)
          void this.request('directory_choose_cancel', { id: value.id }).catch(() => {});
        return;
      }
      this.directorySelection = value.id;
      pending = value.status === 'pending';
      while (value.status === 'pending' && !this.disposed && version === this.directoryVersion) {
        await new Promise((resolve) => {
          this.directoryWait = resolve;
          this.directoryTimer = this.doc.defaultView.setTimeout(() => {
            this.directoryWait = null;
            this.directoryTimer = null;
            resolve();
          }, 350);
        });
        if (this.disposed || version !== this.directoryVersion) return;
        value = await this.request('directory_choose_status', { id: this.directorySelection });
        pending = value.status === 'pending';
      }
      if (this.disposed || version !== this.directoryVersion) return;
      if (value.status === 'selected') {
        const saved = await this.savePreference(
          'table_export_dir',
          value.path,
          this.doc.getElementById('table-export-dir'),
        );
        this.directoryFeedback(
          saved
            ? this.t('默认导出目录已更新', 'Default export folder updated')
            : this.t('目录未保存，请重试', 'Folder was not saved. Retry.'),
          !saved,
        );
      } else if (value.status === 'cancelled')
        this.directoryFeedback(
          this.t('已取消，导出目录未更改', 'Cancelled. Export folder unchanged.'),
        );
      else
        this.directoryFeedback(
          value.status === 'timeout'
            ? this.t('选择目录超时，请重试', 'Folder selection timed out. Retry.')
            : this.t(
                '无法选择目录，请检查本地服务',
                'Cannot choose a folder. Check the local service.',
              ),
          true,
        );
    } catch {
      if (!this.disposed)
        this.directoryFeedback(
          this.t(
            '无法选择目录，请检查本地服务',
            'Cannot choose a folder. Check the local service.',
          ),
          true,
        );
    } finally {
      if (version === this.directoryVersion) {
        if (pending && this.directorySelection)
          void this.request('directory_choose_cancel', { id: this.directorySelection }).catch(
            () => {},
          );
        this.directorySelection = null;
        this.directoryBusy(false);
      }
    }
  }
  async resetExportDirectory() {
    const button = this.doc.getElementById('reset-export-directory');
    if (button.disabled || this.disposed) return;
    this.directoryBusy(true);
    try {
      const defaults = await this.loadDirectories();
      if (this.disposed) return;
      const saved = await this.savePreference(
        'table_export_dir',
        defaults.export_dir,
        this.doc.getElementById('table-export-dir'),
      );
      this.directoryFeedback(
        saved
          ? this.t('已恢复默认导出目录', 'Default export folder restored')
          : this.t('目录未保存，请重试', 'Folder was not saved. Retry.'),
        !saved,
      );
    } catch {
      this.directoryFeedback(
        this.t(
          '无法读取默认目录，请检查本地服务',
          'Cannot read the default folder. Check the local service.',
        ),
        true,
      );
    } finally {
      this.directoryBusy(false);
    }
  }
  async openLogsDirectory() {
    const button = this.doc.getElementById('open-log-directory');
    if (button.disabled || this.disposed) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const value = await this.request('directory_open_logs', {});
      if (value.opened !== true) throw Error('directory not opened');
      this.directoryFeedback(
        this.t('已打开日志目录', 'Log folder opened'),
        false,
        'directory-action-status',
      );
    } catch {
      this.directoryFeedback(
        this.t(
          '无法打开日志目录，请检查本地服务',
          'Cannot open the log folder. Check the local service.',
        ),
        true,
        'directory-action-status',
      );
    } finally {
      if (!this.disposed) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }
  async load(refresh = false) {
    if (this.loading) return this.loading;
    void this.loadDirectories().catch(() => {});
    const message = this.doc.getElementById('models-message');
    message.textContent = this.t('读取模型中…', 'Loading models…');
    this.loading = (async () => {
      try {
        this.models = await this.request('models', { refresh });
        if (this.state) this.fill(readSettings(this.doc));
        message.textContent = Object.values(this.models).some((row) => row.error)
          ? this.t('清单不完整，可手动填写模型 ID', 'Catalog incomplete; enter a model ID')
          : '';
      } catch {
        message.textContent = this.t(
          '清单不可用，可手动填写模型 ID',
          'Catalog unavailable; enter a model ID',
        );
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
  async enable() {
    await this.queue;
    const initial = !this.state?.settings_saved;
    try {
      if (initial) {
        if (!Object.keys(this.models).length) await this.load();
        const values = {
          ...presetValues('balanced', this.models),
          exec_transport: this.state?.config?.exec_transport || 'acp',
        };
        this.state = await this.request('configure', values);
        this.dirty = false;
        this.update(this.state);
      }
      this.update(await this.request('settings', { enabled: true }));
      if (initial) {
        const notice = this.doc.getElementById('balanced-notice');
        notice.hidden = false;
        this.feedbackTimers.set(
          'balanced-notice',
          setTimeout(() => {
            notice.hidden = true;
          }, 3000),
        );
      }
      return true;
    } catch {
      this.doc.getElementById('notice').textContent = this.t(
        '未能开启，请检查本地连接后重试',
        'Could not start. Check the local connection and retry.',
      );
      return false;
    }
  }
  dispose() {
    this.disposed = true;
    this.directoryVersion = (this.directoryVersion || 0) + 1;
    if (this.directoryTimer) this.doc.defaultView.clearTimeout(this.directoryTimer);
    this.directoryWait?.();
    this.directoryWait = null;
    if (this.directorySelection)
      void this.request('directory_choose_cancel', { id: this.directorySelection }).catch(() => {});
    for (const timer of [...this.timers.values(), ...this.feedbackTimers.values()])
      clearTimeout(timer);
  }
}
