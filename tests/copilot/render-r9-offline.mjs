// 中文注释：只把声明/合成状态渲染为离线HTML，不运行取数、模型或保存动作。
import { JSDOM } from 'jsdom';
import { readFile, writeFile } from 'node:fs/promises';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
const root = new URL('../../', import.meta.url),
  state = JSON.parse(
    await readFile(new URL('docs/growth/assets/r9-suggestions.json', root), 'utf8'),
  ),
  html = await readFile(new URL('native-extension/copilot-panel.html', root), 'utf8'),
  css = await readFile(new URL('native-extension/copilot-panel.css', root), 'utf8');
const dom = new JSDOM(html),
  doc = dom.window.document;
renderDashboard(doc, state, { command: async () => {} });
const body =
  '<h1>工具感知建议 · 离线声明样例</h1><p>来源仅为本机包路径检查与场景声明，未运行真实报表、API或模型。待核入口按需绑定，不表示已经可用。</p>' +
  doc.getElementById('pending').outerHTML;
await writeFile(
  new URL('docs/growth/assets/r9-tool-suggestions.html', root),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    css +
    'body{max-width:480px;margin:auto;padding:12px}</style><body>' +
    body +
    '</body></html>',
);
dom.window.close();
