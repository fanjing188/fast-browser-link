// 中文注释：生成无网络/无真实任务的静态渲染样稿，供本机截图与人工验收。
import { JSDOM } from 'jsdom';
import { readFile, writeFile } from 'node:fs/promises';
import { renderDashboard } from '../../native-extension/copilot-view.mjs';
const root = new URL('../../', import.meta.url),
  assets = new URL('docs/growth/assets/', root),
  html = await readFile(new URL('native-extension/copilot-panel.html', root), 'utf8'),
  css = await readFile(new URL('native-extension/copilot-panel.css', root), 'utf8');
const real = JSON.parse(await readFile(new URL('real-longtail-r7.json', assets), 'utf8'));
const head = {
  verdict: '先验证一个明确用途',
  level: 'test',
  metrics: [],
  missing: [],
  process: ['合成数据，用于样稿；不是本机取数或词池回执'],
  next: [],
};
const rows = [
  {
    id: 'keyword',
    action: 'seo.keyword_check',
    title: '检查关键词',
    params: { keyword: 'sample tool' },
    result: {
      ...head,
      keyword: 'sample tool',
      tier: '测一页',
      vol: 1240,
      kd: 18,
      cpc: 1.2,
      intent: '工具',
      metrics: [
        { label: '月量', value: '1240' },
        { label: 'KD', value: '18' },
      ],
      serp: [{ rank: 1, domain: 'small.test', page_type: 'tool', small_site: true }],
      reasons: ['用户任务明确'],
    },
  },
  {
    id: 'longtail',
    action: 'seo.longtail',
    title: '拆长尾',
    params: { keyword: 'zombie skeleton' },
    result: real,
  },
  {
    id: 'competitor',
    action: 'seo.competitor_keywords',
    title: '竞品关键词',
    params: { url: 'https://example.test' },
    result: {
      ...head,
      domain: 'example.test',
      top_pages: [],
      keywords: [
        { keyword: 'sample low kd', vol: 500, kd: 10, position: 3, opportunity: true },
        { keyword: 'sample broad', vol: 5000, kd: 65, position: 8, opportunity: false },
      ],
    },
  },
  {
    id: 'serp',
    action: 'seo.serp_breakdown',
    title: '拆解搜索结果',
    params: { url: 'https://search.test' },
    result: {
      ...head,
      query: 'sample',
      results: [{ rank: 1, domain: 'small.test', page_type: 'tool', small_site: true }],
      gaps: ['尚无直达任务的工具'],
    },
  },
  {
    id: 'general',
    action: 'general.task',
    title: '通用任务',
    params: { task: '整理验证事项' },
    result: {
      ...head,
      level: 'info',
      bullets: ['核对数据来源', '保留缺数据原因'],
      links: [{ label: '示例来源', url: 'https://example.test' }],
      artifacts: [],
    },
  },
  {
    id: 'pool',
    action: 'seo.save_pool',
    title: '保存词池',
    params: {},
    result: {
      ...head,
      level: 'info',
      verdict: '已保存所选词',
      written: 3,
      skipped: [{ keyword: 'existing example', reason: '已存在' }],
    },
  },
  {
    id: 'failure',
    action: 'seo.keyword_check',
    title: '查词失败',
    params: { keyword: 'sample missing' },
    status: 'failed',
    reason: '数据源未就绪，请登录或检查取数命令后重试',
  },
].map((row, index) => ({
  scene: row.action === 'general.task' ? 'general' : 'seo',
  status: 'completed',
  finished_at: 100 - index,
  ...row,
}));
const dom = new JSDOM(html),
  doc = dom.window.document;
renderDashboard(
  doc,
  { enabled: false, suggestions: rows },
  { command: async () => {}, clipboard: { writeText: async () => {} } },
  100000,
);
const frame = (body) =>
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R7 离线渲染</title><style>' +
  css +
  'body{max-width:480px;margin:auto} .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}body.gallery-page{max-width:1440px}</style><body>' +
  body +
  '<footer>离线静态样稿。查词/竞品/保存/通用为合成数据；zombie skeleton 卡来自本机旧报告转换，未补造指标。</footer></body></html>';
const cards = [];
for (const row of rows) {
  const card = doc.querySelector(`article[data-id="${row.id}"]`);
  cards.push(card.outerHTML);
  await writeFile(new URL('r7-' + row.id + '-collapsed.html', assets), frame(card.outerHTML));
  if (card.querySelector('.result-details')) {
    card.querySelector('.result-details').open = true;
    await writeFile(new URL('r7-' + row.id + '-expanded.html', assets), frame(card.outerHTML));
  }
}
await writeFile(
  new URL('r7-cards.html', assets),
  frame('<h1>R7 结果卡样稿</h1><div class="gallery">' + cards.join('') + '</div>').replace(
    '<body>',
    '<body class="gallery-page">',
  ),
);
dom.window.close();
