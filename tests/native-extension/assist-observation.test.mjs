import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistObservation } from '../../native-extension/assist-observation.mjs';

function fixture() {
  let documentId = 'doc-1';
  const events = [];
  const tab = {
    id: 7,
    windowId: 3,
    url: 'https://fixture.test/page',
    title: 'Page',
    incognito: false,
  };
  const api = {
    runtime: { getURL: (file) => 'chrome-extension://fbl/' + file },
    tabs: {
      async query() {
        return [{ ...tab }];
      },
      async get() {
        return { ...tab };
      },
    },
    windows: {
      async get() {
        return { id: 3, focused: true };
      },
    },
    scripting: {
      async executeScript(options) {
        events.push(options);
        if (options.args?.[0]?.endsWith('product-observation.mjs'))
          return [
            {
              documentId,
              result: { kind: 'text', title: 'Page', text: 'visible', partial: false },
            },
          ];
        if (options.args?.[0]?.endsWith('product-tables.mjs'))
          return [{ documentId, result: { url: tab.url, tables: [] } }];
        return [{ documentId, result: tab.url }];
      },
    },
  };
  const observer = new AssistObservation(api, () => false);
  const session = Object.freeze({ productId: 'a'.repeat(32), session: 'port-one' });
  return {
    observer,
    session,
    events,
    api,
    replace() {
      documentId = 'doc-2';
    },
  };
}

test('observation selects the actual current page without a task lease or navigation', async () => {
  const f = fixture();
  const selected = await f.observer.select(f.session);
  assert.ok(selected.pageHandle);
  assert.equal(selected.url, 'https://fixture.test/page');
  assert.equal(selected.tabId, 7);
  assert.equal(selected.windowId, 3);
  // 中文注释：实际页身份只供关联；执行仍只接受所属会话的pageHandle。
  await assert.rejects(
    f.observer.capture({ ...f.session }, { pageHandle: selected.pageHandle, mode: 'page' }),
  );
  const result = await f.observer.capture(f.session, {
    pageHandle: selected.pageHandle,
    mode: 'page',
  });
  assert.equal(result.text, 'visible');
  assert.ok(f.events.every((row) => !row.files));
});

test('same URL replacement and foreign session cannot inherit the observation handle', async () => {
  const f = fixture();
  const selected = await f.observer.select(f.session);
  await assert.rejects(
    f.observer.capture({ ...f.session }, { pageHandle: selected.pageHandle, mode: 'page' }),
  );
  f.replace();
  await assert.rejects(
    f.observer.capture(f.session, { pageHandle: selected.pageHandle, mode: 'page' }),
  );
});

test('revocation fences admission before in-flight reads settle', async () => {
  const f = fixture();
  const selected = await f.observer.select(f.session);
  f.observer.revoke(f.session);
  await assert.rejects(
    f.observer.capture(f.session, { pageHandle: selected.pageHandle, mode: 'page' }),
  );
});

test('work pages are never selected as ordinary observation pages', async () => {
  const f = fixture();
  f.observer.isWorkTab = () => true;
  await assert.rejects(f.observer.select(f.session));
  assert.equal(f.events.length, 0);
});

test('discovery inventory excludes work and incognito pages and strips URL secrets', async () => {
  const f = fixture();
  f.observer.isWorkTab = (tab) => tab.id === 8;
  f.api.tabs.query = async () => [
    { id: 7, url: 'https://fixture.test/report?token=synthetic#private', title: 'report' },
    { id: 8, url: 'https://work.test/' },
    { id: 9, url: 'https://private.test/', incognito: true },
    { id: 10, url: 'chrome://settings/' },
  ];
  const result = await f.observer.listPages(f.session);
  assert.deepEqual(result, { pages: [{ url: 'https://fixture.test/report' }] });
  f.observer.revoke(f.session);
  await assert.rejects(f.observer.listPages(f.session));
});

test('table captures return a private capture handle and reject a caller-supplied table', async () => {
  const f = fixture();
  const page = await f.observer.select(f.session);
  const capture = await f.observer.tables(f.session, { pageHandle: page.pageHandle });
  assert.ok(capture.captureHandle);
  await assert.rejects(
    f.observer.beginConfirmation(f.session, {
      pageHandle: page.pageHandle,
      captureHandle: 'forged',
      tableId: 'table-1',
      format: 'csv',
      all: false,
    }),
  );
});

test('page confirmation events require the real document and session before forwarding', async () => {
  const f = fixture();
  const page = await f.observer.select(f.session);
  f.observer.confirmations.set('confirmation', {
    session: f.session,
    pageHandle: page.pageHandle,
    captureHandle: 'capture',
    token: 'confirmation',
  });
  assert.equal(
    f.observer.handles({ type: 'copilot.table_confirmation', token: 'confirmation' }),
    true,
  );
  await assert.rejects(
    f.observer.handleEvent(
      { type: 'copilot.table_confirmation', token: 'confirmation', kind: 'confirm' },
      { tab: { id: 8 }, documentId: 'doc-1' },
      async () => {},
    ),
  );
});
