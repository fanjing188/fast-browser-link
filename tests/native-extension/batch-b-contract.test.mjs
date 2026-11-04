import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPageSemantics } from '../../page-semantics/index.js';
import { Bridge } from '../../native-extension/bridge.mjs';

test('语义快照按名称、角色、条数与游标读取，区分隐藏和截断', () => {
  const dom = new JSDOM('<!doctype html><meta charset="utf-8"><body></body>', {
    url: 'https://fixture.example.test/',
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }];
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 1,
    top: 1,
    right: 101,
    bottom: 21,
    width: 100,
    height: 20,
  });
  document.body.innerHTML =
    '<button hidden>创建隐藏</button>' +
    Array.from({ length: 24 }, (_, i) => `<button>创建 ${i}</button>`).join('') +
    '<button>删除</button>';
  const semantics = createPageSemantics({ document, taskId: 't', documentId: 'd', leaseId: 'l' });
  try {
    const first = semantics.snapshot({ query: '创建', role: 'button', budget: 20000 });
    assert.equal(first.items.length, 20);
    assert.equal(first.coverage.hidden, 1);
    assert.equal(first.coverage.queryFiltered, 1);
    assert.equal(first.coverage.omitted, 4);
    assert.equal(first.coverage.nextCursor, first.nextCursor);
    const second = semantics.snapshot({
      query: '创建',
      role: 'button',
      budget: 20000,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 4);
    assert.deepEqual(new Set([...first.items, ...second.items].map((item) => item.name)).size, 24);
    assert.equal(
      semantics.snapshot({ query: '创建', role: 'button', limit: 50, budget: 30000 }).items.length,
      24,
    );
    assert.throws(() => semantics.snapshot({ limit: 201 }), /INVALID_OPTIONS/);
  } finally {
    semantics.revoke();
    dom.window.close();
  }
});

test('未知内部错误归插件且只读回执确定未写入', async () => {
  const sent = [];
  const executor = {
    execute: async () => {
      throw Error('private page text');
    },
    diagnostics: { recordSafely: () => {} },
  };
  const bridge = new Bridge(
    { postMessage: (value) => sent.push(value), onMessage: { addListener() {} } },
    executor,
  );
  bridge.receive({
    id: 'read',
    method: 'browser.execute',
    params: { action: 'semantic_snapshot' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const error = sent[0].error;
  assert.equal(error.code, 'execution_denied');
  assert.equal(error.data.category, 'plugin');
  assert.equal(error.data.outcomeUnknown, false);
  assert.equal(typeof error.data.retryable, 'boolean');
  assert.ok(error.data.hint.includes('插件'));
  assert.equal(JSON.stringify(error).includes('private'), false);
});
