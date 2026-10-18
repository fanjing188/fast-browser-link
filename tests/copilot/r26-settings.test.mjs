import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SettingsForm, presetValues } from '../../native-extension/copilot-settings.mjs';
const html = await readFile(
  new URL('../../native-extension/copilot-panel.html', import.meta.url),
  'utf8',
);
const defaults = { export_dir: '/synthetic/default exports', logs_dir: '/synthetic/copilot/logs' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((done) => setImmediate(done));
};
function fixture(handler) {
  const dom = new JSDOM(html, { url: 'chrome-extension://fixture/copilot-panel.html' }),
    doc = dom.window.document,
    calls = [],
    timers = new Map();
  let timerId = 0;
  let state = {
    locale: 'en',
    settings_saved: true,
    table_export_dir: '/synthetic/old exports',
    config: { ...presetValues('balanced'), exec_transport: 'acp' },
  };
  dom.window.setTimeout = (callback) => {
    timers.set(++timerId, callback);
    return timerId;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const settings = new SettingsForm(doc, async (name, params) => {
    calls.push({ name, params });
    if (handler) return handler(name, params, state);
    if (name === 'directory_defaults') return defaults;
    if (name === 'preferences') return (state = { ...state, ...params });
    throw Error(`Unexpected fixture command: ${name}`);
  });
  settings.update(state);
  const snapshot = () => ({
    html: doc.documentElement.outerHTML,
    values: [...doc.querySelectorAll('input,textarea,select')].map((input) => [
      input.id,
      input.value,
      input.checked,
    ]),
  });
  return {
    dom,
    doc,
    calls,
    settings,
    snapshot,
    async poll() {
      assert.equal(timers.size, 1, 'one pending polling timer');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await flush();
    },
    close() {
      settings.dispose();
      dom.window.close();
    },
  };
}
test('legacy defaults display Assist without writing preferences; custom names survive updates and failed saves', async () => {
  const f = fixture(() => {
    throw Error('synthetic save failure');
  });
  try {
    const field = f.doc.getElementById('board-name-input');
    for (const [locale, expected] of [
      ['zh', '协作'],
      ['en', 'Assist'],
    ]) {
      for (const board_name of [
        'Hermes协作看板',
        'Hermes Copilot',
        'Agent协作看板',
        'Agent Board',
      ]) {
        const state = { ...f.settings.state, locale, board_name };
        f.settings.update(state);
        assert.equal(field.value, expected);
        assert.equal(state.board_name, board_name);
        assert.equal(f.calls.length, 0);
      }
    }
    f.settings.update({ ...f.settings.state, locale: 'en', board_name: 'Hermes Copilot' });
    field.value = 'new name';
    assert.equal(await f.settings.savePreference('board_name', field.value, field), false);
    assert.equal(field.value, 'Assist');
    for (const locale of ['zh', 'en']) {
      f.settings.update({ ...f.settings.state, locale, board_name: 'My workspace' });
      assert.equal(field.value, 'My workspace');
    }
  } finally {
    f.close();
  }
});
test('folder choice saves only a selected result after polling and preserves its exact path', async () => {
  const f = fixture((name, params, state) => {
    if (name === 'directory_choose_start') return { id: 'choice', status: 'pending' };
    if (name === 'directory_choose_status')
      return { id: 'choice', status: 'selected', path: '/synthetic/My exports/资料' };
    if (name === 'preferences') return { ...state, ...params };
    throw Error(name);
  });
  try {
    const work = f.settings.chooseExportDirectory();
    await flush();
    assert.deepEqual(f.calls, [{ name: 'directory_choose_start', params: {} }]);
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/old exports');
    await f.poll();
    await work;
    assert.deepEqual(f.calls, [
      { name: 'directory_choose_start', params: {} },
      { name: 'directory_choose_status', params: { id: 'choice' } },
      { name: 'preferences', params: { table_export_dir: '/synthetic/My exports/资料' } },
    ]);
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/My exports/资料');
    assert.equal(f.doc.getElementById('choose-export-directory').disabled, false);
    assert.match(f.doc.getElementById('export-directory-status').textContent, /updated/);
  } finally {
    f.close();
  }
});
for (const status of ['cancelled', 'timeout', 'failed'])
  test(`folder choice ${status} preserves the old path without preferences writes`, async () => {
    const f = fixture((name) => {
      assert.equal(name, 'directory_choose_start');
      return { id: 'choice', status };
    });
    try {
      await f.settings.chooseExportDirectory();
      assert.deepEqual(f.calls, [{ name: 'directory_choose_start', params: {} }]);
      assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/old exports');
      assert.equal(f.doc.getElementById('choose-export-directory').disabled, false);
      assert.match(
        f.doc.getElementById('export-directory-status').textContent,
        status === 'cancelled' ? /Cancelled/ : status === 'timeout' ? /timed out/ : /Cannot choose/,
      );
    } finally {
      f.close();
    }
  });
test('folder choice start failure preserves the old path and exposes retry feedback', async () => {
  const f = fixture(() => {
    throw Error('fixture unavailable');
  });
  try {
    await f.settings.chooseExportDirectory();
    assert.deepEqual(f.calls, [{ name: 'directory_choose_start', params: {} }]);
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/old exports');
    assert.equal(
      f.doc.getElementById('export-directory-status').classList.contains('failure'),
      true,
    );
    assert.equal(f.doc.getElementById('choose-export-directory').disabled, false);
  } finally {
    f.close();
  }
});
test('restore default exports uses directory metadata and never substitutes the logs path', async () => {
  const f = fixture();
  try {
    await f.settings.resetExportDirectory();
    assert.deepEqual(f.calls, [
      { name: 'directory_defaults', params: {} },
      { name: 'preferences', params: { table_export_dir: defaults.export_dir } },
    ]);
    assert.equal(f.doc.getElementById('table-export-dir').value, defaults.export_dir);
    assert.equal(f.doc.getElementById('open-log-directory').title, defaults.logs_dir);
    await f.settings.resetExportDirectory();
    assert.deepEqual(
      f.calls.map((row) => row.name),
      ['directory_defaults', 'preferences', 'preferences'],
    );
  } finally {
    f.close();
  }
});
test('selected folder save failure retains the previous setting and offers retry', async () => {
  const f = fixture((name) => {
    if (name === 'directory_choose_start')
      return { id: 'choice', status: 'selected', path: '/synthetic/new exports' };
    if (name === 'preferences') throw Error('synthetic write failure');
    throw Error(name);
  });
  try {
    await f.settings.chooseExportDirectory();
    assert.deepEqual(f.calls, [
      { name: 'directory_choose_start', params: {} },
      { name: 'preferences', params: { table_export_dir: '/synthetic/new exports' } },
    ]);
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/old exports');
    assert.equal(f.settings.state.table_export_dir, '/synthetic/old exports');
    assert.equal(f.doc.getElementById('table-export-dir').disabled, false);
    assert.equal(
      f.doc.getElementById('export-directory-status').classList.contains('failure'),
      true,
    );
  } finally {
    f.close();
  }
});
test('repeated folder actions share one active choice and do not start a restore in parallel', async () => {
  const start = deferred(),
    f = fixture((name) => {
      assert.equal(name, 'directory_choose_start');
      return start.promise;
    });
  try {
    const work = f.settings.chooseExportDirectory();
    await f.settings.chooseExportDirectory();
    await f.settings.resetExportDirectory();
    assert.deepEqual(f.calls, [{ name: 'directory_choose_start', params: {} }]);
    start.resolve({ id: 'choice', status: 'cancelled' });
    await work;
    assert.equal(f.doc.getElementById('choose-export-directory').disabled, false);
    assert.equal(f.doc.getElementById('reset-export-directory').disabled, false);
  } finally {
    f.close();
  }
});
test('dispose cancels a late choice start and ignores its selected path', async () => {
  const start = deferred(),
    f = fixture((name) => {
      if (name === 'directory_choose_start') return start.promise;
      if (name === 'directory_choose_cancel') return { cancelled: true };
      throw Error(name);
    });
  try {
    const work = f.settings.chooseExportDirectory();
    f.settings.dispose();
    const before = f.snapshot();
    start.resolve({ id: 'late-choice', status: 'selected', path: '/synthetic/late' });
    await work;
    await flush();
    assert.deepEqual(f.calls, [
      { name: 'directory_choose_start', params: {} },
      { name: 'directory_choose_cancel', params: { id: 'late-choice' } },
    ]);
    assert.deepEqual(f.snapshot(), before);
  } finally {
    f.close();
  }
});
test('dispose ignores late defaults without writing preferences or changing directory controls', async () => {
  const metadata = deferred(),
    f = fixture((name) => {
      assert.equal(name, 'directory_defaults');
      return metadata.promise;
    });
  try {
    const work = f.settings.resetExportDirectory();
    f.settings.dispose();
    const before = f.snapshot();
    metadata.resolve(defaults);
    await work;
    await flush();
    assert.deepEqual(f.calls, [{ name: 'directory_defaults', params: {} }]);
    assert.deepEqual(f.snapshot(), before);
  } finally {
    f.close();
  }
});
for (const rejected of [false, true])
  test(`dispose ignores a late directory save ${rejected ? 'failure' : 'success'} without changing DOM`, async () => {
    const saved = deferred(),
      f = fixture((name) => {
        if (name === 'directory_choose_start')
          return { id: 'choice', status: 'selected', path: '/synthetic/new exports' };
        if (name === 'preferences') return saved.promise;
        throw Error(name);
      });
    try {
      const work = f.settings.chooseExportDirectory();
      await flush();
      assert.equal(f.calls.at(-1).name, 'preferences');
      f.settings.dispose();
      const before = f.snapshot();
      if (rejected) saved.reject(Error('late write failure'));
      else
        saved.resolve({
          locale: 'en',
          settings_saved: true,
          table_export_dir: '/synthetic/new exports',
          config: { ...presetValues('balanced'), exec_transport: 'acp' },
        });
      await work;
      await flush();
      assert.deepEqual(f.snapshot(), before);
    } finally {
      f.close();
    }
  });
test('logs opens only the dedicated directory action and suppresses duplicate clicks', async () => {
  const opened = deferred(),
    f = fixture((name) => {
      assert.equal(name, 'directory_open_logs');
      return opened.promise;
    });
  try {
    const work = f.settings.openLogsDirectory();
    await f.settings.openLogsDirectory();
    assert.deepEqual(f.calls, [{ name: 'directory_open_logs', params: {} }]);
    opened.resolve({ opened: true });
    await work;
    assert.match(f.doc.getElementById('directory-action-status').textContent, /Log folder opened/);
    assert.equal(f.doc.getElementById('open-log-directory').disabled, false);
  } finally {
    f.close();
  }
});
for (const rejected of [false, true])
  test(`dispose ignores a late log-open ${rejected ? 'failure' : 'success'} without changing DOM`, async () => {
    const opened = deferred(),
      f = fixture(() => opened.promise);
    try {
      const work = f.settings.openLogsDirectory();
      f.settings.dispose();
      const before = f.snapshot();
      if (rejected) opened.reject(Error('late open failure'));
      else opened.resolve({ opened: true });
      await work;
      assert.deepEqual(f.calls, [{ name: 'directory_open_logs', params: {} }]);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      f.close();
    }
  });
test('polling failure cancels the outstanding choice exactly once without saving a path', async () => {
  const f = fixture((name) => {
    if (name === 'directory_choose_start') return { id: 'choice', status: 'pending' };
    if (name === 'directory_choose_status') throw Error('synthetic polling failure');
    if (name === 'directory_choose_cancel') return { cancelled: true };
    throw Error(name);
  });
  try {
    const work = f.settings.chooseExportDirectory();
    await flush();
    await f.poll();
    await work;
    await flush();
    assert.deepEqual(f.calls, [
      { name: 'directory_choose_start', params: {} },
      { name: 'directory_choose_status', params: { id: 'choice' } },
      { name: 'directory_choose_cancel', params: { id: 'choice' } },
    ]);
    assert.equal(f.doc.getElementById('table-export-dir').value, '/synthetic/old exports');
    assert.equal(f.doc.getElementById('choose-export-directory').disabled, false);
    assert.equal(
      f.doc.getElementById('export-directory-status').classList.contains('failure'),
      true,
    );
  } finally {
    f.close();
  }
});
test('dispose cancels an outstanding polled choice without further status reads', async () => {
  const f = fixture((name) => {
    if (name === 'directory_choose_start') return { id: 'choice', status: 'pending' };
    if (name === 'directory_choose_cancel') return { cancelled: true };
    throw Error(name);
  });
  try {
    const work = f.settings.chooseExportDirectory();
    await flush();
    f.settings.dispose();
    const before = f.snapshot();
    await work;
    await flush();
    assert.deepEqual(f.calls, [
      { name: 'directory_choose_start', params: {} },
      { name: 'directory_choose_cancel', params: { id: 'choice' } },
    ]);
    assert.deepEqual(f.snapshot(), before);
  } finally {
    f.close();
  }
});
