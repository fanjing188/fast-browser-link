import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

// 复用浏览器交互模块的测试依赖，不再读取已删除的独立执行器。
const require = createRequire(new URL('../../browser-interactions/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [css, brand, html] = await Promise.all(
  ['popup.css', 'brand.css', 'popup.html'].map((file) =>
    readFile(new URL('../../native-extension/' + file, import.meta.url), 'utf8'),
  ),
);
const version = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

// 中文注释：真实生产结构在中英文与连接状态下保持固定弹窗宽度，窄/宽视口均不横向溢出。
test('production popup fits 375px and 1440px without a bundled Assist row', async () => {
  // 中文注释：宽度验收同样只用新 profile，并保留真实 HOME。
  const work = await mkdtemp(path.join(tmpdir(), 'fast-popup-')),
    profile = path.join(work, 'profile'),
    temp = path.join(work, 'tmp');
  await mkdir(temp);
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, {
      executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      headless: true,
      args: ['--use-mock-keychain', '--password-store=basic'],
      env: {
        HOME: process.env.HOME,
        HERMES_HOME: path.join(work, 'hermes'),
        TMPDIR: temp,
        PATH: process.env.PATH || '/usr/bin:/bin',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    });
    const page = await browser.newPage();
    await page.setContent(
      html
        .replace(/<link[^>]*>/g, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
        .replace('</head>', `<style>${brand}\n${css}</style></head>`),
    );
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      for (const language of ['zh', 'en'])
        for (const connected of [false, true]) {
          await page.evaluate(
            ({ language, connected, version }) => {
              for (const el of document.querySelectorAll('[data-zh]'))
                el.textContent = el.dataset[language];
              document.getElementById('local-connect').hidden = connected;
              for (const id of ['access-status']) {
                const status = document.getElementById(id);
                status.className = 'st bare';
                status.innerHTML =
                  '<svg class="g" aria-hidden="true"></svg>' +
                  (language === 'zh' ? '正在重连' : 'Reconnecting');
              }
              const header = document.getElementById('connection-label');
              header.className = 'st idle';
              header.textContent = language === 'zh' ? '未就绪' : 'Not ready';
              document.getElementById('version-label').textContent = `v${version}`;
            },
            { language, connected, version },
          );
          const actual = await page.evaluate(() => ({
            body: document.body.getBoundingClientRect().width,
            width: document.documentElement.scrollWidth,
            rows: [...document.querySelectorAll('.connections > .connection-row')].map((row) => ({
              width: row.scrollWidth,
              client: row.clientWidth,
            })),
          }));
          assert.equal(actual.body, 320);
          assert.equal(actual.rows.length, 1);
          assert.equal(actual.width, width, `${width}/${language}/${connected} overflowed`);
          assert.ok(
            actual.rows.every((row) => row.width === row.client),
            `${width}/${language}/${connected} feature row overflowed`,
          );
          if (language === 'zh' && !connected && process.env.FBL_POPUP_EVIDENCE_DIR) {
            await mkdir(process.env.FBL_POPUP_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({
              path: path.join(process.env.FBL_POPUP_EVIDENCE_DIR, `${width}.png`),
            });
          }
        }
    }
  } finally {
    await browser?.close();
    await rm(work, { recursive: true, force: true });
  }
});
