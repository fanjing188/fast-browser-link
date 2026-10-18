// 中文注释：只生成合成选区的真实悬浮窗DOM样稿，不执行网页任务或模型。
import { JSDOM } from 'jsdom';
import { writeFile, mkdir } from 'node:fs/promises';
import { SelectionPopup } from '../../native-extension/copilot-selection.mjs';
const assets = new URL('../../docs/growth/assets/', import.meta.url);
await mkdir(assets, { recursive: true });
for (const [type, text] of [
  ['keyword', 'image background remover'],
  ['domain', 'example.test'],
  ['multiple', 'image remover\nphoto cleaner\nbackground eraser'],
]) {
  const dom = new JSDOM('<p></p>', { url: 'https://article.example.test/?sort=volume' }),
    doc = dom.window.document;
  doc.querySelector('p').textContent = text;
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('p'));
  doc.getSelection().addRange(range);
  range.getBoundingClientRect = () => ({ left: 10, top: 10, right: 100, bottom: 30 });
  const popup = new SelectionPopup(doc, {
    request: async () =>
      type === 'keyword'
        ? {
            pool: { tier: 'test', last_checked: '2026-10-16' },
            cached: { id: 'synthetic-result', tier: 'test', at: 1792108800 },
          }
        : {},
    related: () => ['photo editor'],
  });
  await popup.show();
  const markup = popup.root.innerHTML.replaceAll(':host', 'body');
  await writeFile(
    new URL('r8-selection-' + type + '.html', assets),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R8 ' +
      type +
      ' · synthetic offline preview</title><body>' +
      markup +
      '<p style="font:12px system-ui;margin:12px 0">合成选区与词池/缓存回执样例。静态DOM样稿，按钮不执行任务。</p></body></html>',
  );
  popup.destroy();
  dom.window.close();
}
