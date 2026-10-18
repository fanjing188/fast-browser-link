import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// 复用浏览器交互模块的测试依赖，不再读取已删除的独立执行器。
const require = createRequire(new URL('../../browser-interactions/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [css, brand, html] = await Promise.all(
  ['popup.css', 'brand.css', 'popup.html'].map((file) =>
    readFile(new URL('../../native-extension/' + file, import.meta.url), 'utf8'),
  ),
);

// 中文注释：真实生产结构在中英文、连接状态和协作开关变化时保持 320px，无横向滚动。
test('production popup fits 320px for both languages and collaboration states', async () => {
  // 中文注释：宽度验收同样只用新 profile，并保留真实 HOME。
  const work = await mkdtemp('/tmp/fast-popup-'),
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
    await page.setViewportSize({ width: 320, height: 600 });
    await page.setContent(
      html
        .replace(/<link[^>]*>/g, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
        .replace('</head>', `<style>${brand}\n${css}</style></head>`),
    );
    for (const language of ['zh', 'en'])
      for (const enabled of [false, true])
        for (const connected of [false, true]) {
          await page.evaluate(
            ({ language, enabled, connected }) => {
              for (const el of document.querySelectorAll('[data-zh]'))
                el.textContent = el.dataset[language];
              document.getElementById('open-copilot').hidden = !enabled || !connected;
              document.getElementById('local-connect').hidden = connected;
              for (const id of ['access-status', 'cloud-status']) {
                const status = document.getElementById(id);
                status.className = 'st bare';
                status.innerHTML =
                  '<svg class="g" aria-hidden="true"></svg>' +
                  (language === 'zh' ? '正在重连' : 'Reconnecting');
              }
              const header = document.getElementById('connection-label');
              header.className = 'st idle';
              header.textContent = language === 'zh' ? '未就绪' : 'Not ready';
              document.getElementById('version-label').textContent = 'v2.2.0';
            },
            { language, enabled, connected },
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
          assert.equal(actual.width, 320, `${language}/${enabled}/${connected} overflowed`);
          assert.ok(
            actual.rows.every((row) => row.width === row.client),
            `${language}/${enabled}/${connected} feature row overflowed`,
          );
        }
  } finally {
    await browser?.close();
    await rm(work, { recursive: true, force: true });
  }
});
