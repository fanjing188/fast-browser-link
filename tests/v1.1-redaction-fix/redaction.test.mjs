import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createPageSemantics } from '../../page-semantics/index.js';

function fixture(text, limits = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://redaction.example.test/',
  });
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  document.body.append(paragraph);
  const semantics = createPageSemantics({
    document,
    taskId: 'redaction-task',
    documentId: 'redaction-document',
    leaseId: 'redaction-lease',
    ...limits,
  });
  return {
    dom,
    semantics,
    close() {
      semantics.revoke();
      dom.window.close();
    },
  };
}

function snapshot(f, budget = 3000) {
  return f.semantics.snapshot({ mode: 'content', budget });
}

function content(f) {
  return snapshot(f)
    .items.map((item) => item.name)
    .join('');
}

// 中文注释：1.11.0 原样读取正文中的令牌、卡号与密码字样；输入框密码值另有保留保护测试。
const cases = [
  [
    'unquoted values with spaces and pipes remain readable',
    'Safe prefix | password=SPACE_SECRET WITH SPACE|SAFE_SUFFIX',
  ],
  [
    'an unquoted pipe remains part of page text',
    'Safe prefix | password=QUALITY_SENTINEL_SECRET|SAFE_SUFFIX',
  ],
  [
    'email after a password label remains readable',
    'Safe prefix | password=PII_SECRET; alice@example.com; SAFE_SUFFIX',
  ],
  [
    'semicolon and quoted token text remain readable',
    'Safe prefix | password=OUTER_SECRET; token="INNER_SECRET"|SAFE_SUFFIX',
  ],
  [
    'matched quoted value and suffix remain readable',
    'Safe prefix | password="QUALITY_SENTINEL_SECRET"|SAFE_SUFFIX',
  ],
  [
    'quoted spaces pipes and escaped quotes remain readable',
    `Safe prefix | password=${JSON.stringify('SPACE SECRET | QUOTED "TEXT"')}|SAFE_SUFFIX`,
  ],
  [
    'quoted Bearer text remains readable',
    `Safe prefix | Bearer ${JSON.stringify('BEARER SECRET | QUOTED "TEXT"')}|SAFE_SUFFIX`,
  ],
  [
    'malformed quoted page text remains readable',
    'Safe prefix | password="UNTERMINATED_SECRET|SAFE_SUFFIX',
  ],
  [
    'control characters do not trigger content redaction',
    'Safe prefix | password=CONTROL_\u0000SENTINEL|SAFE_SUFFIX',
  ],
];
for (const [name, text] of cases)
  test(name, () => {
    const f = fixture(text);
    try {
      assert.equal(content(f), text);
    } finally {
      f.close();
    }
  });

test('an irreversible text cap reports truncation without inventing missing text', () => {
  const f = fixture(`${'A'.repeat(16370)} password=CAP_SENTINEL_TRUNCATED|SAFE_SUFFIX`, {
    maxItems: 100,
    maxText: 400,
  });
  try {
    const page = f.semantics.snapshot({ mode: 'content', budget: 12000 });
    const wire = JSON.stringify(page);
    assert.equal(page.coverage.truncated, 1);
    assert.equal(page.coverage.complete, false);
    assert.ok(!wire.includes('CAP_SENTINEL_TRUNCATED'));
    assert.ok(!wire.includes('SAFE_SUFFIX'));
  } finally {
    f.close();
  }
});
