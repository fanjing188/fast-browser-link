import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountProductConnections } from '../../native-extension/product-connections-page.mjs';
test('Assist is a visible explicit pairing choice and uses its separate registry', async () => {
  const html = await readFile(
    new URL('../../native-extension/product-connections.html', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(html);
  const calls = [];
  const runtime = {
    sendMessage: async (message) => {
      calls.push(message);
      return { result: [] };
    },
  };
  mountProductConnections(dom.window.document, runtime);
  await new Promise((r) => setImmediate(r));
  const picker = dom.window.document.querySelector('#product-kind');
  assert.ok(picker);
  assert.ok([...picker.options].some((o) => o.value === 'assist'));
  picker.value = 'assist';
  picker.dispatchEvent(new dom.window.Event('change'));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-1).type, 'assist_connections');
  dom.window.document.querySelector('#extension-id').value = 'a'.repeat(32);
  dom.window.document
    .querySelector('#pair-form')
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-1).type, 'assist_pair');
  dom.window.close();
});

test('preselected Assist identity is reflected when the settings module mounts', async () => {
  const html = await readFile(
    new URL('../../native-extension/product-connections.html', import.meta.url),
    'utf8',
  );
  const dom = new JSDOM(html);
  dom.window.document.querySelector('#product-kind').value = 'assist';
  mountProductConnections(dom.window.document, { sendMessage: async () => ({ result: [] }) });
  await new Promise((r) => setImmediate(r));
  assert.match(
    dom.window.document.querySelector('[data-copy="label"]').textContent,
    /Fast-browser-assist/,
  );
  assert.match(
    dom.window.document.querySelector('[data-copy="intro"]').textContent,
    /Fast-browser-assist/,
  );
  dom.window.close();
});
