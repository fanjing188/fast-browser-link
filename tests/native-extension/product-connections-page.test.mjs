import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mountProductConnections } from '../../native-extension/product-connections-page.mjs';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'pppppppppppppppppppppppppppppppp';
// 中文注释：仅读取仓库固定页面，不接收调用方路径。
// eslint-disable-next-line security/detect-non-literal-fs-filename
const html = await readFile(
  new URL('../../native-extension/product-connections.html', import.meta.url),
  'utf8',
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(
  language = 'zh',
  url = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/product-connections.html',
) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, 'language', { value: language });
  const calls = [];
  const pending = [];
  const runtime = {
    sendMessage(message) {
      calls.push(message);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  mountProductConnections(dom.window.document, runtime);
  return { dom, doc: dom.window.document, calls, pending };
}

test('initial status stays reading until the exact registry receipt arrives', async () => {
  const { doc, calls, pending } = fixture();
  assert.deepEqual(calls, [{ type: 'product_connections' }]);
  assert.match(doc.querySelector('#registry-status').textContent, /读取中/);
  assert.equal(doc.querySelector('#connections').children.length, 0);
  pending.shift().resolve({ result: [] });
  await tick();
  assert.match(doc.querySelector('#registry-status').textContent, /尚未配对/);
  assert.equal(doc.querySelector('#extension-id').value, '');
});

test('rejects names, URLs, whitespace, uppercase and wrong-length IDs without normalization', async () => {
  const { dom, doc, calls, pending } = fixture();
  pending.shift().resolve({ result: [] });
  await tick();
  const input = doc.querySelector('#extension-id');
  const form = doc.querySelector('#pair-form');
  for (const value of [
    '',
    'Fast-Backlink',
    `chrome-extension://${ID}/`,
    ` ${ID}`,
    `${ID} `,
    ID.toUpperCase(),
    ID.slice(1),
    'q'.repeat(32),
  ]) {
    input.value = value;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(calls.length, 1, value);
    assert.equal(input.value, value);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(doc.activeElement, input);
    assert.match(doc.querySelector('#action-status').textContent, /32/);
  }
});

test('explicit submit pairs only the entered ID once and waits for the registry receipt', async () => {
  const { dom, doc, calls, pending } = fixture(
    'zh',
    `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/product-connections.html?extensionId=${OTHER}&pair=true`,
  );
  pending.shift().resolve({ result: [] });
  await tick();
  assert.equal(doc.querySelector('#extension-id').value, '');
  assert.equal(calls.length, 1);
  doc.querySelector('#extension-id').value = ID;
  doc.querySelector('#extension-id').dispatchEvent(new dom.window.Event('input'));
  await tick();
  assert.equal(calls.length, 1);
  const form = doc.querySelector('#pair-form');
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.deepEqual(calls[1], { type: 'product_pair', extensionId: ID });
  assert.equal(calls.length, 2);
  assert.equal(doc.querySelector('#pair-button').disabled, true);
  assert.equal(doc.querySelector('#extension-id').disabled, true);
  assert.doesNotMatch(doc.querySelector('#action-status').textContent, /已连接/);
  pending.shift().resolve({ result: [{ extensionId: ID, connected: false }] });
  await tick();
  assert.equal(doc.querySelector('#pair-button').disabled, false);
  assert.equal(doc.querySelector('#extension-id').value, ID);
  assert.match(doc.querySelector('#action-status').textContent, /已登记/);
  const row = doc.querySelector('.product-row');
  assert.equal(row.querySelector('.product-id').textContent, ID);
  assert.match(row.querySelector('.product-state').textContent, /离线/);
  assert.equal(doc.activeElement, doc.querySelector('#extension-id'));
});

test('failed, malformed and rejected status reads fail closed without exposing runtime text', async () => {
  for (const receipt of [
    undefined,
    {},
    { result: true },
    { result: [{ extensionId: ID, connected: 'true' }] },
    { result: [{ extensionId: `${ID}\n`, connected: true }] },
    { result: [{ extensionId: '<img src=x onerror=alert(1)>', connected: true }] },
    {
      result: [
        { extensionId: ID, connected: true },
        { extensionId: ID, connected: false },
      ],
    },
    { result: [{ extensionId: ID, connected: true }], error: 'PRODUCT_OFFLINE' },
    { error: 'secret://private-token' },
  ]) {
    const { doc, calls, pending } = fixture();
    pending.shift().resolve(receipt);
    await tick();
    assert.equal(doc.querySelector('#connections').children.length, 0);
    assert.equal(doc.querySelector('#registry-status').dataset.state, 'error');
    assert.match(doc.querySelector('#registry-status').textContent, /核对/);
    assert.doesNotMatch(doc.body.textContent, /secret:|private-token|已连接/);
    assert.equal(doc.querySelector('#refresh-button').disabled, false);
    assert.equal(calls.length, 1);
  }
  const { doc, calls, pending } = fixture();
  pending.shift().reject(Error('sensitive host details'));
  await tick();
  assert.equal(doc.querySelector('#registry-status').dataset.state, 'error');
  assert.doesNotMatch(doc.body.textContent, /sensitive/);
  assert.equal(calls.length, 1);
});

test('failed pair preserves input and uses controlled bilingual error copy without replay', async () => {
  for (const language of ['zh-CN', 'en-US'])
    for (const code of [
      'PRODUCT_INVALID_ID',
      'PRODUCT_CAPACITY',
      'PRODUCT_OFFLINE',
      'PRODUCT_ACCESS_REQUIRED',
      'PRODUCT_INVALID_REGISTRY',
      'PRODUCT_OUTCOME_UNKNOWN',
      'PRODUCT_REVOCATION_UNKNOWN',
      'PRODUCT_UNTRUSTED_UI',
      'private runtime body',
    ]) {
      const { dom, doc, calls, pending } = fixture(language);
      pending.shift().resolve({ result: [] });
      await tick();
      doc.querySelector('#extension-id').value = ID;
      doc
        .querySelector('#pair-form')
        .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      pending.shift().resolve({ error: code });
      await tick();
      assert.equal(calls.length, 2);
      assert.equal(doc.querySelector('#extension-id').value, ID);
      assert.equal(doc.querySelector('#pair-button').disabled, false);
      assert.equal(doc.querySelector('#action-status').dataset.state, 'error');
      assert.doesNotMatch(doc.body.textContent, /private runtime body|PRODUCT_/);
      if (code === 'PRODUCT_REVOCATION_UNKNOWN')
        assert.match(
          doc.querySelector('#action-status').textContent,
          language.startsWith('en') ? /revocation/i : /解除配对/,
        );
      if (code === 'PRODUCT_UNTRUSTED_UI')
        assert.match(
          doc.querySelector('#action-status').textContent,
          language.startsWith('en') ? /page.*FBL|FBL.*page/ : /FBL.*页面/,
        );
      assert.match(
        doc.querySelector('#action-status').textContent,
        language.startsWith('en') ? /check/i : /核对|检查/,
      );
      assert.equal(doc.documentElement.lang, language.startsWith('en') ? 'en' : 'zh-CN');
      assert.match(
        doc.querySelector('h1').textContent,
        language.startsWith('en') ? /Product connections/ : /产品连接/,
      );
    }
  for (const receipt of [
    undefined,
    {},
    { result: [] },
    { result: [{ extensionId: OTHER, connected: true }] },
  ]) {
    const { dom, doc, calls, pending } = fixture('en');
    pending.shift().resolve({ result: [] });
    await tick();
    doc.querySelector('#extension-id').value = ID;
    doc
      .querySelector('#pair-form')
      .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    pending.shift().resolve(receipt);
    await tick();
    assert.equal(doc.querySelector('#action-status').dataset.state, 'error');
    assert.equal(calls.length, 2);
  }
  const { dom, doc, calls, pending } = fixture('en');
  pending.shift().resolve({ result: [] });
  await tick();
  doc.querySelector('#extension-id').value = ID;
  doc
    .querySelector('#pair-form')
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  pending.shift().reject(Error('secret body'));
  await tick();
  assert.equal(calls.length, 2);
  assert.match(doc.querySelector('#action-status').textContent, /unknown|confirm/i);
  assert.doesNotMatch(doc.body.textContent, /secret body/);
});

test('reconnect sends the registered ID and restores keyboard focus', async () => {
  const { doc, calls, pending } = fixture();
  pending.shift().resolve({ result: [{ extensionId: ID, connected: false }] });
  await tick();
  const button = doc.querySelector('[data-action="reconnect"]');
  assert.ok(button, 'each registered entry offers reconnect');
  button.focus();
  button.click();
  button.click();
  assert.deepEqual(calls[1], { type: 'product_pair', extensionId: ID });
  assert.equal(calls.length, 2);
  pending.shift().resolve({ result: [{ extensionId: ID, connected: true }] });
  await tick();
  assert.match(doc.querySelector('.product-state').textContent, /已连接/);
  assert.equal(doc.activeElement, doc.querySelector('[data-action="reconnect"]'));
});

test('unpair waits for a confirming registry receipt and retains the entry on failure', async () => {
  for (const receipt of [
    { error: 'PRODUCT_OUTCOME_UNKNOWN' },
    { result: [{ extensionId: ID, connected: true }] },
    { result: [] },
  ]) {
    const { doc, calls, pending } = fixture();
    pending.shift().resolve({ result: [{ extensionId: ID, connected: true }] });
    await tick();
    doc.querySelector('#extension-id').value = OTHER;
    assert.match(
      doc.querySelector('footer').textContent,
      /后续控制.*保留原页面和已填数据.*不保证取消已派发/,
    );
    const button = doc.querySelector('[data-action="unpair"]');
    assert.ok(button, 'each registered entry offers unpair');
    assert.equal(button.classList.contains('danger'), true, 'distinguish unpair from reconnect');
    assert.ok(button.getAttribute('aria-describedby'), 'unpair must reference the consequences');
    button.focus();
    button.click();
    button.click();
    assert.deepEqual(calls[1], { type: 'product_unpair', extensionId: ID });
    assert.equal(calls.length, 2);
    assert.equal(doc.querySelector('.product-id').textContent, ID);
    pending.shift().resolve(receipt);
    await tick();
    const success = receipt.result?.length === 0;
    assert.equal(doc.querySelectorAll('.product-row').length, success ? 0 : 1);
    assert.equal(doc.querySelector('#action-status').dataset.state, success ? 'success' : 'error');
    assert.equal(doc.querySelector('#extension-id').value, OTHER);
    assert.equal(
      doc.activeElement,
      success ? doc.querySelector('#extension-id') : doc.querySelector('[data-action="unpair"]'),
    );
  }
});

test('manual status check never replays mutations and marks old connection claims unknown on failure', async () => {
  const { doc, calls, pending } = fixture('en');
  pending.shift().resolve({ result: [{ extensionId: ID, connected: true }] });
  await tick();
  const refresh = doc.querySelector('#refresh-button');
  refresh.focus();
  refresh.click();
  refresh.click();
  assert.deepEqual(calls[1], { type: 'product_connections' });
  assert.equal(calls.length, 2);
  assert.match(doc.querySelector('#registry-status').textContent, /Reading/);
  assert.doesNotMatch(doc.querySelector('.product-state').textContent, /^Connected$/);
  pending.shift().reject(Error('hidden details'));
  await tick();
  assert.equal(doc.querySelectorAll('.product-row').length, 1);
  assert.equal(doc.querySelector('#registry-status').dataset.state, 'error');
  assert.equal(doc.activeElement, refresh);
  assert.equal(calls.length, 2);
  refresh.click();
  pending.shift().resolve({ result: [{ extensionId: ID, connected: false }] });
  await tick();
  assert.equal(doc.querySelector('.product-state').textContent, 'Offline');
  assert.equal(calls.length, 3);
});

test('uncertain mutations retain registration but not a stale connected claim, even for non-Error rejections', async () => {
  for (const action of ['reconnect', 'unpair']) {
    const { doc, calls, pending } = fixture('en');
    pending.shift().resolve({ result: [{ extensionId: ID, connected: true }] });
    await tick();
    doc.querySelector(`[data-action="${action}"]`).click();
    pending.shift().reject(null);
    await tick();
    assert.equal(doc.querySelectorAll('.product-row').length, 1);
    assert.equal(doc.querySelector('.product-state').textContent, 'Not confirmed');
    assert.equal(doc.querySelector('#action-status').dataset.state, 'error');
    assert.equal(doc.querySelector('#pair-button').disabled, false);
    assert.equal(calls.length, 2);
  }
});

// 中文注释：显式启用的真实 DOM 验收；消息边界是唯一 mock，不加载个人 profile、不安装扩展。
if (process.env.FBL_PAGE_BROWSER === '1') {
  test('production page browser matrix and keyboard pairing with a message-only fixture', async () => {
    const require = createRequire(
      path.resolve(process.env.FBL_PAGE_PLAYWRIGHT_ROOT || 'browser-interactions', 'package.json'),
    );
    const { chromium } = require('playwright-core');
    const evidence = path.resolve('tests/native-extension/evidence/product-connections-page');
    await mkdir(evidence, { recursive: true });
    const work = await mkdtemp(path.join(evidence, 'isolated-'));
    const assets = new Map();
    for (const file of [
      'product-connections.html',
      'product-connections.css',
      'product-connections-page.mjs',
      'brand.css',
      'brand-logo-small.svg',
    ]) {
      assets.set(
        `/${file}`,
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await readFile(new URL(`../../native-extension/${file}`, import.meta.url)),
      );
    }
    const server = createServer((request, response) => {
      const filename = new URL(request.url, 'http://localhost').pathname;
      if (!assets.has(filename)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const type = filename.endsWith('.mjs')
        ? 'text/javascript'
        : filename.endsWith('.css')
          ? 'text/css'
          : filename.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/html';
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      response.end(assets.get(filename));
    });
    const matrix = [],
      screenshots = [],
      errors = [];
    let browser;
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launchPersistentContext(path.join(work, 'profile'), {
        executablePath:
          process.env.FBL_PAGE_BROWSER_PATH ||
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        headless: true,
        args: ['--use-mock-keychain', '--password-store=basic'],
        env: { ...process.env, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      });
      const page = await browser.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      // 中文注释：一个初始化脚本读取每次导航的测试配置，避免跨矩阵累积互相覆盖的脚本。
      await page.addInitScript(() => {
        const config = JSON.parse(new URL(location.href).searchParams.get('fixture'));
        Object.defineProperty(navigator, 'language', { value: config.language });
        window.fixtureCalls = [];
        window.fixturePending = [];
        window.chrome = {
          runtime: {
            sendMessage(message) {
              window.fixtureCalls.push(message);
              return new Promise((resolve, reject) =>
                window.fixturePending.push({ resolve, reject }),
              );
            },
          },
        };
      });
      for (const width of [320, 375, 480, 1440])
        for (const theme of ['light', 'dark'])
          for (const language of ['zh-CN', 'en-US'])
            for (const state of [
              'loading',
              'empty',
              'connected',
              'offline',
              'failure',
              'success',
            ]) {
              await page.setViewportSize({ width, height: 900 });
              await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
              await page.goto(
                `${origin}/product-connections.html?extensionId=${OTHER}&pair=true&fixture=${encodeURIComponent(JSON.stringify({ language }))}`,
              );
              await page.waitForFunction(() => window.fixtureCalls?.length === 1);
              assert.equal(await page.locator('#extension-id').inputValue(), '');
              if (state !== 'loading') {
                const response =
                  state === 'failure'
                    ? { error: 'PRIVATE_ERROR_BODY' }
                    : {
                        result: ['empty', 'success'].includes(state)
                          ? []
                          : [{ extensionId: ID, connected: state === 'connected' }],
                      };
                await page.evaluate(
                  (response) => window.fixturePending.shift().resolve(response),
                  response,
                );
                await page.waitForFunction(() => !document.querySelector('#pair-button').disabled);
              }
              if (state === 'success') {
                await page.locator('#extension-id').fill(ID);
                await page.locator('#extension-id').press('Enter');
                await page.waitForFunction(() => window.fixtureCalls.length === 2);
                assert.deepEqual(await page.evaluate(() => window.fixtureCalls[1]), {
                  type: 'product_pair',
                  extensionId: ID,
                });
                await page.evaluate(
                  (ID) =>
                    window.fixturePending
                      .shift()
                      .resolve({ result: [{ extensionId: ID, connected: true }] }),
                  ID,
                );
                await page.waitForFunction(
                  () => document.querySelector('#action-status').dataset.state === 'success',
                );
                assert.equal(await page.evaluate(() => document.activeElement.id), 'extension-id');
              }
              const metrics = await page.evaluate(() => ({
                width: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                lang: document.documentElement.lang,
                inputFont: parseFloat(
                  window.getComputedStyle(document.querySelector('input')).fontSize,
                ),
                inputTop: document.querySelector('input').getBoundingClientRect().top,
                smallTargets: [...document.querySelectorAll('button, input')].filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width < 44 || rect.height < 44;
                }).length,
                rowOverflow: [...document.querySelectorAll('.product-row')].some(
                  (row) => row.scrollWidth > row.clientWidth,
                ),
                state: document.querySelector('#registry-status').dataset.state,
              }));
              assert.equal(
                metrics.scrollWidth,
                width,
                `${width}/${theme}/${language}/${state}: overflow`,
              );
              assert.equal(metrics.lang, language.startsWith('zh') ? 'zh-CN' : 'en');
              assert.ok(metrics.inputFont >= 16);
              assert.ok(metrics.inputTop < 600, 'first field is visible without scrolling');
              assert.equal(metrics.smallTargets, 0);
              assert.equal(metrics.rowOverflow, false);
              const key = `${width}-${theme}-${language}-${state}`;
              matrix.push({ key, ...metrics });
              if (
                [
                  '375-light-zh-CN-success',
                  '375-dark-en-US-offline',
                  '1440-light-en-US-success',
                  '320-dark-zh-CN-failure',
                  '480-light-en-US-empty',
                  '375-dark-zh-CN-loading',
                ].includes(key)
              ) {
                const filename = `${key}.png`;
                await page.screenshot({ path: path.join(evidence, filename), fullPage: true });
                screenshots.push(filename);
              }
            }
      assert.deepEqual(errors, []);
      await page.locator('#extension-id').fill(OTHER);
      await page.locator('[data-action="unpair"]').click();
      await page.evaluate(() =>
        window.fixturePending.shift().resolve({ error: 'PRODUCT_OUTCOME_UNKNOWN' }),
      );
      await page.waitForFunction(
        () => document.querySelector('#action-status').dataset.state === 'error',
      );
      assert.equal(await page.locator('.product-row').count(), 1);
      assert.equal(await page.locator('#extension-id').inputValue(), OTHER);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'unpair');
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.at(-1)), {
        type: 'product_unpair',
        extensionId: ID,
      });
      await page.locator('[data-action="unpair"]').click();
      await page.evaluate(() => window.fixturePending.shift().resolve({ result: [] }));
      await page.waitForFunction(
        () => document.querySelector('#action-status').dataset.state === 'success',
      );
      assert.equal(await page.locator('.product-row').count(), 0);
      assert.equal(await page.locator('#extension-id').inputValue(), OTHER);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'extension-id');
      await page.locator('#refresh-button').click();
      await page.evaluate(() =>
        window.fixturePending.shift().resolve({
          result: ['a', 'b', 'c', 'p'].map((letter) => ({
            extensionId: letter.repeat(32),
            connected: false,
          })),
        }),
      );
      await page.waitForFunction(() => document.querySelectorAll('.product-row').length === 4);
      for (const width of [320, 375, 480, 1440]) {
        await page.setViewportSize({ width, height: 480 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      }
      await writeFile(
        path.join(evidence, 'matrix.json'),
        JSON.stringify(
          {
            fixture: 'production page; mock runtime messages only; isolated headless profile',
            matrix,
            screenshots,
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ matrix: matrix.length, screenshots, evidence }));
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(work, { recursive: true, force: true });
    }
  });
}
