import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderStatus } from '../../native-extension/ui-design.mjs';

const root = new URL('../../native-extension/', import.meta.url);
const [html, popup, cloud] = await Promise.all(
  ['popup.html', 'popup.mjs', 'cloud-popup.mjs'].map((file) =>
    readFile(new URL(file, root), 'utf8'),
  ),
);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function mount(initial, language = 'zh-CN') {
  const dom = new JSDOM(html, {
      url: 'chrome-extension://fixture/popup.html',
      runScripts: 'outside-only',
    }),
    calls = [];
  let status = initial,
    changed;
  dom.window.setInterval = () => 1;
  dom.window.chrome = {
    i18n: { getUILanguage: () => language },
    runtime: {
      getManifest: () => ({ version: '2.2.0' }),
      onMessage: {
        addListener: (listener) => {
          changed = listener;
        },
      },
      sendMessage: async (message) => {
        calls.push(message);
        return {
          result: message.type === 'popup_status' ? status : { opened: true, enabled: true },
        };
      },
    },
  };
  dom.window.renderStatus = renderStatus;
  dom.window.eval(cloud.replace(/^import\s[^;]*;\n/gm, ''));
  dom.window.eval(popup.replace(/^import\s[^;]*;\n/gm, ''));
  await flush();
  return {
    dom,
    doc: dom.window.document,
    calls,
    async update(next) {
      status = next;
      changed({ type: 'changed' });
      await flush();
    },
  };
}

test('popup always has exactly the three requested feature rows in Chinese and English', async () => {
  for (const [language, labels] of [
    ['zh-CN', ['本地Agent连接', '云端Agent连接', 'Agent协作模式']],
    ['en-US', ['Local Agent connection', 'Cloud Agent connection', 'Agent collaboration']],
  ]) {
    const h = await mount(
      { connected: true, copilot: { enabled: false }, cloud: { state: 'unpaired' } },
      language,
    );
    try {
      const rows = [...h.doc.querySelectorAll('.connections > .connection-row')];
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((row) => row.querySelector('.row-label').textContent),
        labels,
      );
      assert.equal(h.doc.querySelector('#hermes-row,#popup-hermes-status,#hermes-refresh'), null);
      assert.equal(h.doc.querySelector('#page-task').hidden, true);
      assert.equal(h.doc.querySelector('#open-copilot').hidden, true);
      await h.update({
        connected: false,
        copilot: { enabled: true },
        cloud: { state: 'active', paired: true, online: true },
      });
      assert.ok(rows.every((row) => !row.hidden));
      assert.equal(h.doc.querySelector('#cloud-connect').disabled, true);
      assert.equal(h.doc.querySelector('#cloud-expand').disabled, true);
      assert.equal(h.doc.querySelector('#copilot-toggle').disabled, true);
      assert.equal(h.doc.querySelector('#open-copilot').hidden, true);
      assert.notEqual(h.doc.querySelector('#cloud-status').dataset.state, 'active');
    } finally {
      h.dom.window.close();
    }
  }
});

test('board appears only for confirmed enabled collaboration and enabling keeps the immediate gesture request', async () => {
  const h = await mount({ connected: true, copilot: { enabled: false } });
  try {
    h.doc.querySelector('#copilot-toggle').click();
    assert.deepEqual(
      h.calls.filter((row) => row.type.startsWith('copilot.')).map((row) => row.type),
      ['copilot.open', 'copilot.popup_settings'],
    );
    await flush();
    await h.update({ connected: true, copilot: { enabled: true } });
    assert.equal(h.doc.querySelector('#open-copilot').hidden, false);
    assert.equal(h.doc.querySelector('#open-copilot').textContent, '协作看板');
    await h.update({ connected: true, copilot: { enabled: false } });
    assert.equal(h.doc.querySelector('#open-copilot').hidden, true);
    assert.equal(
      h.calls.some((row) => row.type === 'copilot.fbl_fix'),
      false,
    );
  } finally {
    h.dom.window.close();
  }
});

test('compact feature rows retain accessible connection scopes and reject synthetic cloud actions', async () => {
  const h = await mount({ connected: true, cloud: { state: 'unpaired' } });
  try {
    assert.ok(h.doc.querySelector('#connection-detail').closest('[role=tooltip]'));
    assert.match(h.doc.querySelector('#connection-detail').textContent, /任务页.*密码输入值不回显/);
    assert.match(h.doc.querySelector('#cloud-access-detail').textContent, /已有个人标签页不授权/);
    for (const id of ['cloud-connect', 'cloud-regenerate', 'cloud-disconnect', 'cloud-open-web'])
      h.doc.getElementById(id).click();
    await flush();
    assert.equal(
      h.calls.some((row) => row.type.startsWith('cloud_')),
      false,
    );
    assert.equal(h.doc.querySelector('#cloud-dialog').dataset.open, 'false');
  } finally {
    h.dom.window.close();
  }
});
