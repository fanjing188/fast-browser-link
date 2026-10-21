import { boardName } from './copilot-controls.mjs';
import { MemoryPanel } from './copilot-memory-panel.mjs';
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
  constructor(doc, request, { explicitSave = false, revealField = () => {} } = {}) {
    this.doc = doc;
    this.request = request;
    this.memory = new MemoryPanel(doc, request);
    this.models = {};
    this.state = null;
    this.dirty = false;
    this.version = 0;
    this.queue = Promise.resolve();
    this.timers = new Map();
    this.feedbackTimers = new Map();
    this.explicitSave = explicitSave;
    this.revealField = revealField;
    this.drafts = new Map();
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
    if (explicitSave) this.bindDrafts(form);
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
    this.memory.update(state.memory, state.locale);
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
    if (this.explicitSave) {
      this.restoreDrafts();
      this.draftFeedback();
    }
  }
  valid(values) {
    for (const key of ['inference_model', 'exec_model'])
      this.doc
        .getElementById(key + '-manual')
        .setCustomValidity(
          this.doc.getElementById('setting-' + key).value === 'manual' && !values[key]
            ? this.t('请填写模型 ID，或选择跟随默认', 'Enter a model ID or choose Use default')
            : validModel(values[key])
              ? ''
              : this.t('模型 ID 格式无效', 'Invalid model ID'),
        );
    if (this.explicitSave) {
      const invalid = this.doc
        .querySelectorAll(
          '#settings-category input, #settings-category select, .settings-group input, .settings-group select',
        )
        .find((field) => !field.checkValidity());
      if (invalid) {
        this.revealField(invalid);
        invalid.reportValidity();
        invalid.focus();
        return false;
      }
    }
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
    if (this.explicitSave && !this.savingDraft) {
      field.value = value;
      this.stage(field);
      return true;
    }
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
  bindDrafts(form) {
    const doc = this.doc;
    for (const id of [
      'ball',
      'selection-popup',
      'board-name-input',
      'table-export-dir',
      'table-max-pages',
      'table-delay-min',
      'table-delay-max',
      'page-annotations',
      'auto-zero',
      'annotation-density',
      'memory-enabled',
    ]) {
      const field = doc.getElementById(id);
      field.onchange = null;
    }
    form.oninput = (event) => this.editDraft(event);
    form.onchange = (event) => this.editDraft(event);
    doc.getElementById('settings-save').onclick = () => this.saveDrafts();
    doc.getElementById('settings-reset').onclick = () => this.resetDrafts();
    this.beforeUnload = (event) => {
      if (!this.drafts.size) return;
      event.preventDefault();
      event.returnValue = '';
    };
    doc.defaultView.addEventListener('beforeunload', this.beforeUnload);
    this.draftFeedback();
  }
  bindAgent(agent) {
    this.agent = agent;
    const field = this.doc.getElementById('agent-default-select');
    field.onchange = () => this.stage(field);
  }
  fieldValue(field) {
    return field.type === 'checkbox' ? field.checked : field.value;
  }
  stage(field) {
    if (!field?.id) return;
    if (field.id === 'agent-default-select') field.dataset.settingsDraft = field.value;
    this.drafts.set(field.id, this.fieldValue(field));
    this.dirty = true;
    this.version++;
    this.draftFeedback();
  }
  editDraft(event) {
    const field = event.target;
    if (
      !field.matches('input,select') ||
      field.id === 'agent-default-select' ||
      field.classList.contains('shared-search')
    )
      return;
    if (field.name === 'mode') {
      const values = { ...readSettings(this.doc), ...presetValues(field.value, this.models) };
      this.fill(values);
      for (const key of keys) {
        if (key === 'mode') continue;
        this.stage(this.doc.getElementById('setting-' + key));
        if (key.endsWith('_model')) this.stage(this.doc.getElementById(key + '-manual'));
      }
      this.drafts.set('mode', values.mode);
      this.draftFeedback();
      return;
    }
    const key = field.id.replace(/^setting-/, '').replace(/-manual$/, '');
    if (keys.includes(key)) {
      if (field.value === 'refresh' && key.endsWith('_model')) {
        const value = this.drafts.get(field.id) ?? this.state?.config?.[key] ?? '';
        field.value = value;
        void this.load(true);
        return;
      }
      this.doc.querySelector('[name=mode][value=custom]').checked = true;
      this.drafts.set('mode', 'custom');
      this.manualFields();
    }
    this.stage(field);
  }
  restoreDrafts() {
    for (const [id, value] of this.drafts) {
      if (id === 'mode') this.doc.querySelector(`[name=mode][value="${value}"]`).checked = true;
      else {
        const field = this.doc.getElementById(id);
        if (!field) continue;
        if (field.type === 'checkbox') field.checked = value;
        else field.value = value;
      }
    }
    this.manualFields();
  }
  draftFeedback(message = '', error = false) {
    if (!this.explicitSave) return;
    const pending = this.drafts.size > 0,
      busy = !!this.savingDraft;
    const status = this.doc.getElementById('settings-draft-status');
    status.textContent =
      message ||
      (pending
        ? this.t('有未保存的更改', 'Unsaved changes')
        : this.t('所有更改已保存', 'All changes saved'));
    status.classList.toggle('failure', error);
    for (const id of ['settings-save', 'settings-reset'])
      this.doc.getElementById(id).disabled = !pending || busy;
    this.doc.getElementById('settings-save').textContent = busy
      ? this.t('保存中…', 'Saving…')
      : this.t('保存更改', 'Save changes');
    this.doc.getElementById('settings-reset').textContent = this.t('重置更改', 'Reset changes');
  }
  resetDrafts() {
    if (!this.drafts.size || this.savingDraft) return;
    if (
      !this.doc.defaultView.confirm(
        this.t('放弃全部未保存的更改？', 'Discard all unsaved changes?'),
      )
    )
      return;
    this.drafts.clear();
    delete this.doc.getElementById('agent-default-select').dataset.settingsDraft;
    this.agent?.render();
    this.dirty = false;
    this.lastConfig = null;
    if (this.memory) this.memory.signature = null;
    this.update(this.state);
    this.draftFeedback(this.t('已恢复保存的设置', 'Restored saved settings'));
  }
  confirmLeave() {
    return (
      !this.drafts.size ||
      this.doc.defaultView.confirm(
        this.t(
          '有未保存的更改。离开后仍会保留草稿，是否返回工作区？',
          'There are unsaved changes. Keep the draft and leave settings?',
        ),
      )
    );
  }
  async saveDrafts() {
    if (!this.drafts.size || this.savingDraft) return false;
    const values = readSettings(this.doc);
    if (!this.valid(values)) return false;
    for (const id of ['table-max-pages', 'table-delay-min', 'table-delay-max']) {
      const field = this.doc.getElementById(id);
      if (!field.checkValidity()) {
        this.revealField(field);
        field.reportValidity();
        return false;
      }
    }
    const min = Number(this.doc.getElementById('table-delay-min').value),
      max = Number(this.doc.getElementById('table-delay-max').value);
    if (min > max) {
      this.revealField(this.doc.getElementById('table-delay-max'));
      this.draftFeedback(
        this.t('最大页间间隔不能小于最小间隔', 'Maximum delay must be at least the minimum delay'),
        true,
      );
      return false;
    }
    const pending = new Map(this.drafts),
      preferences = {},
      settings = {};
    const preferenceKeys = {
      'board-name-input': 'board_name',
      'table-export-dir': 'table_export_dir',
      'table-max-pages': 'table_max_pages',
      'table-delay-min': 'table_delay_min',
      'table-delay-max': 'table_delay_max',
      'page-annotations': 'page_annotations',
      'auto-zero': 'auto_zero',
      'annotation-density': 'annotation_density',
    };
    for (const [id, value] of pending) {
      if (preferenceKeys[id])
        preferences[preferenceKeys[id]] =
          id.startsWith('table-') && id !== 'table-export-dir' ? Number(value) : value;
      if (id === 'ball') settings.show_ball = value;
      if (id === 'selection-popup') settings.selection_popup = value;
    }
    const operations = [];
    if (
      [...pending.keys()].some(
        (id) => id === 'mode' || id.startsWith('setting-') || id.endsWith('-manual'),
      )
    )
      operations.push([
        'configure',
        values,
        [...pending.keys()].filter(
          (id) => id === 'mode' || id.startsWith('setting-') || id.endsWith('-manual'),
        ),
      ]);
    if (Object.keys(preferences).length)
      operations.push([
        'preferences',
        preferences,
        [...pending.keys()].filter((id) => preferenceKeys[id]),
      ]);
    if (Object.keys(settings).length)
      operations.push(['settings', settings, ['ball', 'selection-popup']]);
    if (pending.has('agent-default-select'))
      operations.push([
        'agent_select',
        { agent_id: pending.get('agent-default-select') },
        ['agent-default-select'],
      ]);
    if (pending.has('memory-enabled'))
      operations.push(['memory', { enabled: pending.get('memory-enabled') }, ['memory-enabled']]);
    this.savingDraft = true;
    let failed = false;
    this.draftFeedback(this.t('保存中…', 'Saving…'));
    try {
      for (const [name, params, ids] of operations) {
        const state = await this.request(name, params);
        for (const id of ids) if (this.drafts.get(id) === pending.get(id)) this.drafts.delete(id);
        this.dirty = this.drafts.size > 0;
        this.lastConfig = null;
        if (name === 'agent_select') {
          if (!this.drafts.has('agent-default-select'))
            delete this.doc.getElementById('agent-default-select').dataset.settingsDraft;
          this.agent?.apply(state);
          this.agent?.render();
        } else this.update(name === 'memory' ? { ...this.state, memory: state } : state);
      }
      this.draftFeedback(this.t('已保存', 'Saved'));
      return true;
    } catch {
      failed = true;
      this.draftFeedback(
        this.t(
          '部分更改未保存，已保留草稿；请重试',
          'Some changes were not saved. Draft retained; retry.',
        ),
        true,
      );
      return false;
    } finally {
      this.savingDraft = false;
      this.draftFeedback(
        this.drafts.size
          ? failed
            ? this.t('仍有未保存的更改，请重试', 'Changes remain unsaved. Retry.')
            : this.t('新更改尚未保存', 'New changes remain unsaved')
          : this.t('已保存', 'Saved'),
        failed,
      );
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
            ? this.explicitSave
              ? this.t('已选择目录，保存更改后生效', 'Folder selected. Save changes to apply.')
              : this.t('默认导出目录已更新', 'Default export folder updated')
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
          ? this.explicitSave
            ? this.t(
                '已选择默认目录，保存更改后生效',
                'Default folder selected. Save changes to apply.',
              )
            : this.t('已恢复默认导出目录', 'Default export folder restored')
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
    this.memory.dispose();
    if (this.beforeUnload)
      this.doc.defaultView.removeEventListener('beforeunload', this.beforeUnload);
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
