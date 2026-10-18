// 中文注释：生产组件 + 合成回执生成离线样稿；不运行浏览器、安装、Native RPC或模型。
import { readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SettingsForm, presetValues } from '../../native-extension/copilot-settings.mjs';
import { renderDashboard, PanelViews } from '../../native-extension/copilot-view.mjs';
import { LogPanel } from '../../native-extension/copilot-logs.mjs';
import { localize } from '../../native-extension/copilot-i18n.mjs';
const root = new URL('../../', import.meta.url),
  source = new URL('native-extension/', root),
  out = new URL('docs/growth/assets/', root);
const [html, css, brand, logo] = await Promise.all(
  ['copilot-panel.html', 'copilot-panel.css', 'brand.css', 'brand-logo-small.svg'].map((name) =>
    readFile(new URL(name, source), 'utf8'),
  ),
);
const dark =
  brand
    .match(/@media\(prefers-color-scheme:dark\)\{([^}]+\})\}/)?.[1]
    .replace(':root,:host', ':root') || '';
const now = Date.now(),
  state = {
    locale: 'zh',
    enabled: true,
    ready: true,
    running: false,
    settings_saved: true,
    config: {
      ...presetValues('balanced'),
      exec_transport: 'acp',
      inference_model: 'example:fast',
      exec_model: 'example:reasoning',
    },
    daily_usage: { input: 8500, cache_read: 2200, output: 1300 },
    usage: { input: 2400, cache_read: 700, output: 300 },
    daily_model_usage: { 'example:fast': { input: 8500, cache_read: 2200, output: 1300 } },
    show_ball: true,
    selection_popup: true,
    suggestions: [
      {
        id: 'fixture-pending',
        status: 'pending',
        action: 'general.task',
        title: '核对页面说明',
        why: '已识别相关操作',
        params: { task: 'Review the synthetic example' },
      },
      {
        id: 'fixture-running',
        status: 'executing',
        action: 'workflow.run',
        title: '比较示例来源',
        params: { flow: 'intent_split', object: 'example topic' },
        step: '2/4 · 读取候选',
        started_at: now / 1000 - 4,
        model: 'example:reasoning',
        model_source: 'acp',
      },
      {
        id: 'fixture-result',
        status: 'completed',
        action: 'general.task',
        title: '示例结果',
        params: { task: 'Review fixture' },
        finished_at: now / 1000,
        tokens: 3400,
        result: {
          verdict: '已整理需要核对的项目',
          level: 'info',
          metrics: [],
          missing: [],
          process: [],
          next: [],
          bullets: ['此内容仅用于离线界面演示'],
          links: [],
          artifacts: [],
        },
      },
    ],
  };
const types = ['capture', 'inference', 'execution', 'system'];
const events = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  time: now / 1000 - 12 + index,
  type: types[index % 4],
  event: index % 4 === 1 ? 'inference_return' : index % 4 === 2 ? 'execute_step' : 'capture',
  summary: [
    '采集操作轨迹与页面摘要',
    '推理返回，更新建议',
    '执行步骤推进',
    '设置已更新，后续调用生效',
  ][index % 4],
  summary_en: [
    'Captured activity and page summary',
    'Inference returned; suggestions updated',
    'Execution step progressed',
    'Settings updated for subsequent calls',
  ][index % 4],
  error: index === 10,
  details:
    index % 4 === 0
      ? { snapshot_bytes: 2400, steps: 2, kinds: ['navigate', 'selection'] }
      : index % 4 === 1
        ? {
            added: 2,
            updated: 1,
            removed: 0,
            input: 620,
            cache_read: 400,
            output: 80,
            duration_ms: 1200,
          }
        : index % 4 === 2
          ? {
              provider: 'example-metrics',
              capability: 'keyword.metrics',
              page: 3,
              duration_ms: 800,
            }
          : { changes: ['exec_model'] },
}));
const files = [];
for (const theme of ['light', 'dark'])
  for (const page of ['work', 'settings', 'logs']) {
    const dom = new JSDOM(html, { url: 'chrome-extension://fixture/copilot-panel.html' }),
      doc = dom.window.document;
    renderDashboard(doc, state, { command: async () => ({}) });
    const settings = new SettingsForm(doc, async () => ({}));
    settings.models = {
      inference: { available: [{ id: 'example:fast', label: 'example · fast' }] },
      execution: { available: [{ id: 'example:reasoning', label: 'example · reasoning' }] },
    };
    settings.update(state);
    const logs = new LogPanel(doc, async () => ({}));
    logs.active = page === 'logs';
    logs.set({ entries: events, revision: 12 });
    new PanelViews(doc).show(page);
    for (const input of doc.querySelectorAll('input')) {
      if (['checkbox', 'radio'].includes(input.type))
        input.toggleAttribute('checked', input.checked);
      else input.setAttribute('value', input.value);
    }
    for (const option of doc.querySelectorAll('option'))
      option.toggleAttribute('selected', option.selected);
    doc.querySelectorAll('script,link').forEach((node) => node.remove());
    for (const image of doc.querySelectorAll('img'))
      image.src = 'data:image/svg+xml,' + encodeURIComponent(logo);
    const file = `r11-${page}-${theme}.html`;
    await writeFile(
      new URL(file, out),
      `<!doctype html><meta charset="utf-8"><style>${brand}${css}${theme === 'dark' ? dark : ''}</style>` +
        doc.body.outerHTML,
    );
    files.push([theme, page, file]);
    settings.dispose();
    logs.dispose();
    dom.window.close();
  }
await writeFile(
  new URL('r11-sidebar-preview.html', out),
  `<!doctype html><meta charset="utf-8"><title>R11 · Offline sidebar previews</title><style>body{font:14px system-ui;margin:24px;background:#eef1f5;color:#202733}section{display:flex;gap:18px;flex-wrap:wrap}figure{margin:0 0 24px}iframe{width:380px;height:760px;border:1px solid #cbd2df;border-radius:10px}figcaption{margin-bottom:9px}a{color:#315fc7}</style><h1>R11 · 主界面 / 设置 / 实时日志</h1><p>正式组件与合成状态。没有真实取数、Native RPC或模型调用；非已装机Edge验收。</p>${[
    'light',
    'dark',
  ]
    .map(
      (theme) =>
        `<h2>${theme}</h2><section>${files
          .filter((row) => row[0] === theme)
          .map(
            ([, page, file]) =>
              `<figure><figcaption><a href="${file}">${page}</a></figcaption><iframe src="${file}" title="${theme} ${page}"></iframe></figure>`,
          )
          .join('')}</section>`,
    )
    .join('')}`,
);
console.log('Rendered six R11 production-component previews and index.');
