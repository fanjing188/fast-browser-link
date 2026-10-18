import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { CapabilitiesPanel } from '../../native-extension/copilot-capabilities-panel.mjs';
import { mountControls } from '../../native-extension/copilot-controls.mjs';
const css = await readFile(
  new URL('../../native-extension/copilot-capabilities.css', import.meta.url),
  'utf8',
);
const brand = await readFile(new URL('../../native-extension/brand.css', import.meta.url), 'utf8');
const state = {
  capabilities: { 'keyword.metrics': { status: 'missing', bindings: [] } },
  candidates: [{ id: 'candidate', name: 'Example skill', capabilities: ['keyword.metrics'] }],
  running: false,
};
async function fixture(handler = () => state) {
  const dom = new JSDOM(
      '<!doctype html><html lang="en"><head></head><body><details id="local-capabilities"><summary>Local</summary><output id="capability-notice" role="status"></output><div class="capability-body"></div></details></body></html>',
      { pretendToBeVisual: true },
    ),
    doc = dom.window.document,
    calls = [];
  for (const text of [brand, css]) {
    const style = doc.createElement('style');
    style.textContent = text;
    doc.head.append(style);
  }
  const panel = new CapabilitiesPanel(
    doc,
    async (method, params) => {
      calls.push([method, params]);
      return handler(method, params);
    },
    { language: 'en' },
  );
  await panel.refresh();
  const controls = mountControls(doc);
  return {
    dom,
    doc,
    panel,
    calls,
    controls,
    click: (text) =>
      [...doc.querySelectorAll('button')].find((el) => el.textContent === text).onclick(),
    close() {
      controls.dispose();
      dom.window.close();
    },
  };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
test('capability form uses labeled branded controls with bounded widths and shared select interactions', async () => {
  const f = await fixture();
  try {
    for (const input of f.doc.querySelectorAll('textarea,select')) {
      assert.ok(input.labels.length > 0, input.outerHTML);
      assert.ok(input.labels[0].textContent.trim());
      if (input.tagName === 'TEXTAREA') {
        const style = f.dom.window.getComputedStyle(input);
        assert.equal(style.width, '100%');
        assert.equal(style.maxWidth, '100%');
        assert.equal(style.minWidth, '0px');
        assert.equal(style.boxSizing, 'border-box');
        assert.equal(style.resize, 'vertical');
      }
    }
    const candidate = f.doc.getElementById('capability-candidate');
    assert.equal(candidate.hidden, true);
    const trigger = candidate.nextElementSibling.querySelector('[role=combobox]');
    assert.equal(trigger.getAttribute('aria-label'), 'Select skill candidate');
    trigger.click();
    const option = [...candidate.nextElementSibling.querySelectorAll('[role=option]')].find((el) =>
      el.textContent.includes('Example skill'),
    );
    option.click();
    assert.equal(candidate.value, 'candidate');
    assert.equal(f.panel.candidateValue, 'candidate');
    for (const row of f.doc.querySelectorAll('.capability-actions')) {
      const style = f.dom.window.getComputedStyle(row);
      assert.equal(style.display, 'flex');
      assert.equal(style.flexWrap, 'wrap');
      assert.ok([...row.children].every((el) => el.tagName === 'BUTTON' && el.type === 'button'));
    }
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ['capability_state'],
    );
  } finally {
    f.close();
  }
});
test('capability discovery preserves optional tab scan and confirmed selected parameter edits', async () => {
  const discovery = {
    candidates: [
      {
        id: 'one',
        selected: true,
        capability: 'keyword.metrics',
        source: 'fixture',
        confidence: 0.95,
        cost: 'local',
        validation: 'review',
        basis: 'Visible schema',
        binding: { priority: 10, batch_limit: 20 },
      },
      {
        id: 'two',
        selected: false,
        capability: 'keyword.metrics',
        source: 'fixture',
        confidence: 0.5,
        cost: 'local',
        validation: 'review',
        basis: 'Unselected candidate',
        binding: {},
      },
    ],
    errors: [],
  };
  const f = await fixture((method) => (method === 'fbl_discover' ? discovery : state));
  try {
    const urls = f.doc.getElementById('capability-urls');
    urls.value = 'https://one.example.test, https://two.example.test\nhttps://three.example.test';
    urls.dispatchEvent(new f.dom.window.Event('input'));
    const scan = f.doc.querySelector('.capability-toggle input');
    assert.equal(scan.checked, false);
    scan.checked = true;
    scan.dispatchEvent(new f.dom.window.Event('change'));
    await f.click('Find tools');
    await wait();
    assert.deepEqual(f.calls.find(([method]) => method === 'fbl_discover')[1], {
      urls: ['https://one.example.test', 'https://two.example.test', 'https://three.example.test'],
      scan_tabs: true,
    });
    assert.equal(
      f.calls.some(([method]) => method === 'fbl_confirm'),
      false,
    );
    const edits = f.doc.getElementById('capability-candidate-0');
    assert.ok(edits.labels.length);
    edits.value = '{"priority":3,"batch_limit":12}';
    await f.click('Bind selected');
    assert.deepEqual(f.calls.find(([method]) => method === 'fbl_confirm')[1], {
      ids: ['one'],
      edits: { one: { priority: 3, batch_limit: 12 } },
    });
  } finally {
    f.close();
  }
});
test('JSON validation focuses the reviewed field and preserves explicit save gates', async () => {
  const f = await fixture((method) =>
    method === 'tool_draft' ? { id: 'draft', profile: { name: 'fixture' } } : state,
  );
  try {
    let input = f.doc.getElementById('capability-binding');
    input.value = 'invalid json';
    await f.click('Confirm and save binding');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(f.doc.activeElement, input);
    assert.equal(
      f.calls.some(([method]) => method === 'capability_bind'),
      false,
    );
    input.value = '{"id":"reviewed","type":"command","argv":[]}';
    input.dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(input.hasAttribute('aria-invalid'), false);
    await f.click('Confirm and save binding');
    assert.equal(f.calls.filter(([method]) => method === 'capability_bind').length, 1);
    await f.click('Remember this tool');
    assert.equal(f.calls.filter(([method]) => method === 'tool_save').length, 0);
    input = f.doc.getElementById('capability-tool-draft');
    assert.ok(input.labels.length);
    input.value = '{"name":"reviewed tool"}';
    await f.click('Confirm and save tool profile');
    assert.deepEqual(f.calls.find(([method]) => method === 'tool_save')[1], {
      id: 'draft',
      profile: { name: 'reviewed tool' },
    });
    await f.click('Reload bindings');
    assert.equal(f.calls.filter(([method]) => method === 'capability_reload').length, 1);
  } finally {
    f.close();
  }
});
test('capability scoped stylesheet defines focus, disabled and invalid states from shared tokens', async () => {
  const f = await fixture();
  try {
    const rules = [...f.doc.styleSheets].at(-1).cssRules,
      find = (selector) => [...rules].find((rule) => rule.selectorText === selector)?.style;
    for (const rule of rules)
      assert.ok(
        rule.selectorText.startsWith('#local-capabilities') ||
          rule.selectorText.startsWith('#capability-notice'),
        rule.selectorText,
      );
    assert.equal(
      find('#local-capabilities .capability-input:focus-visible').getPropertyValue('outline'),
      '2px solid var(--brand)',
    );
    assert.equal(
      find('#local-capabilities .capability-input:disabled').getPropertyValue('background'),
      'var(--bg)',
    );
    assert.equal(
      find('#local-capabilities .capability-input[aria-invalid=true]').getPropertyValue(
        'border-color',
      ),
      'var(--bad)',
    );
    for (const theme of ['light', 'dark']) {
      f.doc.documentElement.dataset.theme = theme;
      const field = f.doc.getElementById('capability-binding'),
        style = f.dom.window.getComputedStyle(field);
      assert.equal(style.maxWidth, '100%');
      assert.equal(style.minWidth, '0px');
    }
  } finally {
    f.close();
  }
});
