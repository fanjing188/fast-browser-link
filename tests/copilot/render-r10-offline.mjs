// 中文注释：正式DOM/样式离线渲染；所有宿主状态和日志均为合成数据，不运行浏览器、模型或外部服务。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createOverlayView } from '../../native-extension/overlay-view.mjs';
const root = new URL('../../', import.meta.url),
  out = new URL('docs/growth/assets/', root),
  source = new URL('native-extension/', root);
const [html, popup, cloud, popupCSS, brandCSS, logo] = await Promise.all(
  [
    'popup.html',
    'popup.mjs',
    'cloud-popup.mjs',
    'popup.css',
    'brand.css',
    'brand-logo-small.svg',
  ].map((name) => readFile(new URL(name, source), 'utf8')),
);
const dark =
  brandCSS
    .match(/@media\(prefers-color-scheme:dark\)\{([^}]+\})\}/)?.[1]
    .replace(':root,:host', ':root') || '';
const logoData = 'data:image/svg+xml,' + encodeURIComponent(logo),
  flush = async () => {
    for (let n = 0; n < 5; n++) await new Promise((done) => setImmediate(done));
  };
const base = {
  connected: true,
  browserFullConsentStatus: 'enabled',
  tasks: [],
  copilot: { enabled: true, running: 2, unread: 3 },
  cloud: { state: 'active', paired: true, online: true, site: 'https://pair.example.test' },
};
const cases = {
  following: base,
  unpaired: {
    ...base,
    cloud: {
      state: 'pending_pairing',
      paired: false,
      online: false,
      code: 'DEMO-1234',
      expiresAt: Date.now() + 300000,
      site: 'https://pair.example.test',
    },
  },
  reconnecting: { ...base, cloud: { state: 'offline', paired: true } },
  error: { ...base, cloud: { state: 'revoked' } },
  disconnected: { ...base, connected: false },
  first: { connected: false, browserFullConsentStatus: 'disabled' },
  unknown: null,
  task: {
    ...base,
    page: { taskId: 'fixture', tabId: 7, title: 'Review sample report' },
    tasks: [{ id: 'fixture', generation: 1, title: 'Review sample report', state: 'running' }],
  },
  paused: {
    ...base,
    page: { taskId: 'fixture', tabId: 7 },
    tasks: [{ id: 'fixture', generation: 1, title: 'Review sample report', state: 'paused' }],
  },
  loading: 'pending',
};
async function renderPopup(name, status, theme, language = 'zh-CN') {
  const dom = new JSDOM(html, {
    url: 'chrome-extension://fixture/popup.html',
    runScripts: 'outside-only',
  });
  dom.window.setInterval = () => 1;
  dom.window.setTimeout = () => 1;
  dom.window.chrome = {
    i18n: { getUILanguage: () => language },
    runtime: {
      getManifest: () => ({ version: '2.2.0' }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === 'popup_status') {
          if (status === 'pending') return new Promise(() => {});
          if (status === null) throw Error('synthetic unavailable');
          return { result: status };
        }
        return { result: {} };
      },
    },
  };
  dom.window.eval(cloud);
  dom.window.eval(popup);
  await flush();
  if (name === 'unpaired') {
    const panel = dom.window.document.getElementById('cloud-dialog');
    panel.dataset.open = 'true';
    panel.inert = false;
    panel.removeAttribute('inert');
    dom.window.document.getElementById('cloud-expand').setAttribute('aria-expanded', 'true');
    dom.window.document.getElementById('cloud-code').textContent = 'DEMO-1234';
    dom.window.document.getElementById('cloud-code-expiry').textContent = '4:59';
  }
  dom.window.document.querySelectorAll('script,link').forEach((el) => el.remove());
  dom.window.document.querySelectorAll('img').forEach((el) => {
    el.src = logoData;
  });
  const file = `r10-popup-${name}-${theme}-${language.startsWith('zh') ? 'zh' : 'en'}.html`;
  await writeFile(
    new URL(file, out),
    `<!doctype html><meta charset="utf-8"><style>${brandCSS}${popupCSS}${theme === 'dark' ? dark : ''}</style>` +
      dom.window.document.body.outerHTML,
  );
  dom.window.close();
  return file;
}
const groups = [];
for (const theme of ['light', 'dark']) {
  const files = [];
  for (const [name, status] of Object.entries(cases))
    files.push([name, await renderPopup(name, status, theme)]);
  files.push(['English', await renderPopup('following', base, theme, 'en-US')]);
  groups.push([theme, files]);
}
const overlayFiles = [];
for (const state of ['running', 'paused', 'completed', 'failed', 'stopped', 'minimized']) {
  const dom = new JSDOM('<html><body></body></html>'),
    view = createOverlayView(dom.window.document, {
      title: '核对示例报告',
      preferences: { minimized: state === 'minimized' },
    });
  view.state(state === 'minimized' ? 'running' : state, '扫描页面');
  view.setRows(
    Array.from({ length: 10 }, (_, index) => ({
      description: index === 9 ? '点击「提交」' : '扫描页面',
      result:
        index === 9 && state === 'failed'
          ? 'failed'
          : index === 9 && state === 'running'
            ? 'pending'
            : 'succeeded',
      reason: index === 9 && state === 'failed' ? '目标被其他元素遮挡' : '',
      time: '2026-10-17T10:00:' + String(index).padStart(2, '0') + 'Z',
      durationMs: 4200,
    })),
  );
  const file = `r10-overlay-${state}.html`;
  await writeFile(
    new URL(file, out),
    `<!doctype html><meta charset="utf-8"><style>body{background:#f1f3f6;font:13px system-ui;color:#616b7b}p{margin:20px}</style><p>合成任务页 · 只展示正式显示组件，不宣称真实锁定或宿主回执。</p><style>${view.style.textContent}</style>` +
      view.bar.outerHTML,
  );
  overlayFiles.push([state, file]);
  view.dispose();
  dom.window.close();
}
const frames = (files, width, height) =>
  files
    .map(
      ([label, file]) =>
        `<figure><figcaption><a href="${file}">${label}</a></figcaption><iframe src="${file}" width="${width}" height="${height}" title="${label}"></iframe></figure>`,
    )
    .join('');
await writeFile(
  new URL('r10-ui-preview.html', out),
  `<!doctype html><meta charset="utf-8"><title>R10 offline UI previews</title><style>body{font:14px system-ui;margin:24px;color:#202733;background:#eef1f5}section{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0 0 18px}figcaption{margin-bottom:8px}iframe{border:1px solid #c9d0dd;border-radius:10px;background:white}h1{font-size:22px}a{color:#315fc7}</style><h1>R10 · 正式DOM离线样稿</h1><p>全为合成状态；非真实Edge或模型验收。<a href="brand/preview.html">三个品牌方向</a> · <a href="r10-popup-before.html">旧版弹窗</a></p>${groups.map(([theme, files]) => `<h2>${theme}</h2><section>${frames(files, 322, 490)}</section>`).join('')}<h2>执行浮层</h2><section>${frames(overlayFiles, 400, 510)}</section>`,
);
const oldHTML = await readFile('/private/tmp/copilot-r10-baseline/popup.html', 'utf8'),
  oldCSS = await readFile('/private/tmp/copilot-r10-baseline/popup.css', 'utf8');
const old = new JSDOM(oldHTML);
old.window.document.querySelectorAll('script,link').forEach((el) => el.remove());
await writeFile(
  new URL('r10-popup-before.html', out),
  '<!doctype html><meta charset="utf-8"><style>' +
    oldCSS +
    '</style>' +
    old.window.document.body.outerHTML,
);
old.window.close();
await mkdir(new URL('brand/', out), { recursive: true });
const dirs = ['direction-1-link', 'direction-2-collaboration', 'direction-3-forward'];
await writeFile(
  new URL('brand/preview.html', out),
  `<!doctype html><meta charset="utf-8"><title>Fast-browser-link · Brand directions</title><style>body{font:14px system-ui;margin:24px;background:#edf0f5;color:#202733}section{display:flex;gap:24px;padding:24px;margin:12px 0;background:#fff;border-radius:10px}.dark{background:#171b23;color:#edf0f6}figure{margin:0;width:220px}div{display:flex;gap:16px;align-items:center;margin-top:16px}img{flex:none}small{display:block;margin-top:12px}</style><h1>Fast-browser-link · 三个原创几何方向</h1><p>推荐②光标与节点：由用户引导的协作。16/32使用独立简化版；其余方向保留供改选。PNG均由源SVG生成。</p>${['light', 'dark'].map((theme) => `<section class="${theme}">${dirs.map((name, index) => `<figure><figcaption>${['① 链环与速度', '② 光标与节点 · 推荐', '③ F与前进'][index]}</figcaption><div>${[16, 32, 128].map((size) => `<img src="${name}-${size}.png" width="${size}" height="${size}" alt="${name} ${size}px">`).join('')}</div><small>16 · 32 · 128</small><a href="${name}.svg">SVG source</a></figure>`).join('')}</section>`).join('')}`,
);
console.log(
  'Rendered 22 popup states, six overlay states, previous popup and brand preview index.',
);
