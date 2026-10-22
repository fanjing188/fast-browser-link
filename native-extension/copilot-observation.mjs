import { selectedText } from './copilot-selection.mjs';
import { createPageSemantics } from '../page-semantics/index.js';
import { redactPageText, privateAccountNode } from '../page-semantics/redact.mjs';

export function ordinaryPage(url, contentType = 'text/html') {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.pathname.toLowerCase().endsWith('.pdf') &&
      !/pdf/i.test(contentType)
    );
  } catch {
    return false;
  }
}
export const clipBytes = (value, budget) =>
  new TextDecoder()
    .decode(new TextEncoder().encode(value).slice(0, budget))
    .replace(/\uFFFD$/u, '');
const controls =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]';
function sensitiveField(field) {
  const labelText = (label) => {
    const walker = label.ownerDocument.createTreeWalker(label, 4);
    let node,
      text = '',
      scanned = 0;
    while ((node = walker.nextNode()) && scanned++ < 300) {
      if (!node.parentElement?.closest(controls)) text += ' ' + node.textContent;
    }
    return text;
  };
  const metadata =
    ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder']
      .map((key) => field.getAttribute(key) || '')
      .join(' ') +
    ' ' +
    [...(field.labels || [])].map(labelText).join(' ');
  return /password|passwd|otp|one.?time|verification|captcha|cvc|cvv|credit|debit|card.?number|cardholder|cc-|payment|billing|iban|security.?code|密码|验证码|支付|银行卡|持卡|卡号|安全码|有效期|expiry|expiration/i.test(
    metadata,
  );
}
function visibleSignal(node, requireLayout = true) {
  if (
    privateAccountNode(node) ||
    node.closest('[hidden],[aria-hidden="true"],[data-fast-automation-overlay]')
  )
    return false;
  for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
    const style = node.ownerDocument.defaultView.getComputedStyle(parent);
    if (
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility) ||
      style.opacity === '0'
    )
      return false;
  }
  if (!requireLayout) return true;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}
export function safeText(node, limit = 220, coverage) {
  if (!node || node.closest?.(controls) || privateAccountNode(node)) return '';
  // 中文注释：行文字只读可见文本节点；不能通过祖先 textContent 把文本域和编辑区的值带出去。
  const walk = node.ownerDocument.createTreeWalker(node, 4);
  let current,
    text = '',
    scanned = 0;
  while ((current = walk.nextNode()) && scanned++ < 500 && text.length < limit * 2) {
    const parent = current.parentElement;
    if (
      !parent ||
      (parent.closest('label')?.control && sensitiveField(parent.closest('label').control)) ||
      privateAccountNode(parent) ||
      parent.closest(
        `${controls},script,style,[hidden],[aria-hidden="true"],[data-fast-automation-overlay]`,
      )
    )
      continue;
    if (!visibleSignal(parent, false)) continue;
    text += ' ' + current.textContent;
  }
  const sanitized = redactPageText(text);
  if (coverage && (current || sanitized.length > limit)) coverage.partial = true;
  return sanitized.slice(0, limit);
}
export function describeEvent(event, doc) {
  if (['selectionchange', 'copy'].includes(event.type)) {
    const selection = selectedText(doc);
    if (!selection) return null;
    return `${event.type === 'copy' ? '复制' : '选中'} ${selection.text.slice(0, 220)}`;
  }
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  if (
    !target ||
    privateAccountNode(target) ||
    target.closest('[data-fast-automation-overlay]') ||
    target.closest(controls)
  )
    return null;
  const row = target.closest('tr,[role="row"]'),
    element = target.closest('a,button,[role="button"],[role="option"]') || target;
  const kind = row
    ? '表格行'
    : element.matches('a')
      ? '链接'
      : element.matches('button,[role="button"]')
        ? '按钮'
        : '内容';
  const label =
    safeText(row || element) ||
    redactPageText(element.getAttribute('aria-label') || '').slice(0, 220) ||
    element.localName;
  if (event.type === 'click') return `点击 ${kind} ${label}`;
  if (event.type === 'change' && element.getAttribute('role') === 'option') return `选中 ${label}`;
  return null;
}
export function pageSnapshot(doc, url, budget = 3072, summarizeTables = false, summaries = []) {
  if (!ordinaryPage(url, doc.contentType)) return null;
  const engine = createPageSemantics({
    document: doc,
    taskId: 'copilot-readonly',
    documentId: 'current',
    leaseId: 'no-execution',
    maxScan: 2500,
    maxItems: 60,
    maxText: 180,
  });
  try {
    const items = [],
      headings = [],
      fields = [];
    for (const level of [1, 2, 3]) {
      let count = 0;
      for (const heading of doc.querySelectorAll('h' + level)) {
        if (!visibleSignal(heading)) continue;
        const name = safeText(heading, 180);
        if (name) headings.push({ role: 'heading', level, name });
        if (name && ++count === 5) break;
      }
    }
    let sensitive = false;
    for (const field of [...doc.querySelectorAll('input,textarea,select')].slice(0, 2500)) {
      if (!visibleSignal(field) || field.type === 'hidden') continue;
      if (sensitiveField(field)) {
        sensitive = true;
        continue;
      }
      const labels = [...(field.labels || [])].map((label) => safeText(label)).filter(Boolean);
      const name = redactPageText(
        [...labels, field.getAttribute('aria-label'), field.getAttribute('placeholder')]
          .filter(Boolean)
          .join(' · '),
      ).slice(0, 180);
      if (name && fields.length < 30) fields.push({ role: 'form-label', name });
    }
    const selection = selectedText(doc);
    for (const mode of summarizeTables
      ? ['content', 'interactive']
      : ['table', 'content', 'interactive']) {
      const snapshot = engine.snapshot({ mode, budget: 1600 });
      for (const row of snapshot.items) {
        // 中文注释：只投影语义库已经排除输入值的名称和角色，不输出动作引用、状态或表单值。
        const node = engine.resolve({
          ...snapshot.binding,
          snapshotId: snapshot.snapshotId,
          ref: row.ref,
        });
        if (
          summarizeTables &&
          node.closest(
            'table,[role="table"],[role="grid"],[role="treegrid"],[role="row"],[data-ui-name="Body.Row"]',
          )
        )
          continue;
        if (
          privateAccountNode(node) ||
          node.closest(
            '[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]',
          )
        )
          continue;
        const field = node.matches('input,textarea,select');
        if (field || node.matches('h1,h2,h3,label') || node.closest('label')) continue;
        const label = safeText(node);
        const item = {
          role: row.role,
          name: label || redactPageText(node.getAttribute('aria-label') || '').slice(0, 180),
        };
        if (item.name) items.push(item);
      }
    }
    const page = {
      url: safeURL(url),
      title: redactPageText(doc.title).slice(0, 200),
      items: [],
      truncated: false,
    };
    const prioritized = [
      ...summaries,
      ...(selection
        ? [{ role: 'selection', name: redactPageText(selection.text).slice(0, 220) }]
        : []),
      ...(sensitive
        ? [{ role: 'sensitive-fields', name: '存在敏感字段 / Sensitive fields present' }]
        : []),
      ...headings,
      ...fields,
      ...items,
    ];
    const seen = new Set();
    for (const item of prioritized) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      page.items.push(item);
      if (new TextEncoder().encode(JSON.stringify(page)).length > budget - 32) {
        page.items.pop();
        page.truncated = true;
        continue;
      }
    }
    return page;
  } finally {
    engine.revoke();
  }
}
export function safeURL(raw) {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.hash = '';
  // 中文注释：搜索词来自已导航的 URL，绝不读取搜索框值；其他查询参数可能携带凭据，删除。
  const search = url.searchParams.get('q') || url.searchParams.get('query');
  url.search = '';
  if (search && /^(www\.)?(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/.test(url.hostname))
    url.searchParams.set('q', redactPageText(search).slice(0, 200));
  return clipBytes(redactPageText(url.toString()), 1200);
}
export function appendStep(trace, description, tabId, page, now = Date.now()) {
  return [
    ...trace,
    {
      at: now,
      tabId,
      description: description.slice(0, 300),
      url: page.url,
      title: page.title?.slice(0, 200) || '',
    },
  ].slice(-30);
}

// 中文注释：所有导航和SPA变更共用静默窗口，5秒上限只约束同一批变化。
export function stableSnapshots(
  capture,
  {
    quiet = 1000,
    maxWait = 5000,
    ready = () => true,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  let silence = null,
    deadline = null,
    reasons = [];
  const flush = () => {
    cancel(silence);
    cancel(deadline);
    silence = deadline = null;
    if (!ready()) {
      silence = schedule(flush, quiet);
      return;
    }
    const current = reasons;
    reasons = [];
    capture(current.at(-1) || null, current);
  };
  return {
    change(description) {
      if (description) {
        reasons.push(description);
        reasons = reasons.slice(-30);
      }
      if (deadline === null) deadline = schedule(flush, maxWait);
      cancel(silence);
      silence = schedule(flush, quiet);
    },
    stop() {
      cancel(silence);
      cancel(deadline);
      silence = deadline = null;
      reasons = [];
    },
  };
}

export function readingContext(doc) {
  const headings = [
    ...doc.querySelectorAll(
      'main h1,main h2,main h3,article h1,article h2,article h3,[role="main"] h2',
    ),
  ];
  const heading = headings.find((node) => {
    const box = node.getBoundingClientRect();
    return box.bottom > 0 && box.top < (doc.defaultView?.innerHeight || 800) && safeText(node);
  });
  return heading ? safeText(heading, 160) : '';
}

// 中文注释：表格数据留在本机采集/导出通路；推理仅收到列名与已识别行数。
export function tableSummary(capture) {
  return (capture.tables || []).slice(0, 3).map((table) => ({
    role: 'table',
    name: clipBytes(
      redactPageText(
        `识别到表格：${table.headers.length} 列 · ${table.rows.length} 行${table.incomplete ? ' · 可能不完整' : ''}；列名 ${table.headers.join(' / ')}`,
      ),
      280,
    ),
  }));
}

export function pageIdentity(page) {
  return JSON.stringify([
    page?.url,
    page?.title,
    [
      ...new Set(
        (page?.items || []).map((item) =>
          JSON.stringify([item.role, item.name?.replace(/\s+/g, ' ').trim()]),
        ),
      ),
    ].sort(),
  ]);
}

// 中文注释：显式采集与后台摘要共用隐私过滤；正文快照不保留任何可执行引用。
export function captureMaterial(doc, url, mode = 'page') {
  if (!ordinaryPage(url, doc.contentType)) throw Error('此页不支持内容读取');
  if (mode === 'canvas') {
    const canvases = [...doc.querySelectorAll('canvas')]
      .filter((canvas) => {
        if (
          !visibleSignal(canvas) ||
          canvas.closest(
            `${controls},[data-private],[data-sensitive],[data-account],[data-profile]`,
          )
        )
          return false;
        const box = canvas.getBoundingClientRect();
        return (
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < doc.defaultView.innerHeight &&
          box.left < doc.defaultView.innerWidth
        );
      })
      .slice(0, 3);
    if (!canvases.length) throw Error('当前视图没有可读取的 Canvas 图表');
    const materials = canvases.map((canvas, index) => {
      if (!canvas.width || !canvas.height || canvas.width > 4096 || canvas.height > 4096)
        throw Error('Canvas 图尺寸过大或为空，请导入较小的 PNG 图片');
      let value;
      try {
        value = canvas.toDataURL('image/png');
      } catch {
        throw Error('Canvas 受跨源保护，无法读取；请导入有权使用的 PNG 图片');
      }
      if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value))
        throw Error('Canvas 未返回有效 PNG 图片');
      const image = value.slice('data:image/png;base64,'.length),
        bytes = (image.length * 3) / 4 - (image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0);
      if (bytes > 150000) throw Error('Canvas 图片超过150KiB，请导入较小的 PNG 图片');
      return {
        kind: 'image',
        title: `${redactPageText(doc.title).slice(0, 90)} · Canvas ${index + 1}`,
        image,
        source: safeURL(url),
        partial: true,
      };
    });
    return { materials };
  }
  if (mode === 'selection') {
    const selection = selectedText(doc);
    if (!selection?.text) throw Error('请先选择非输入区域的文字');
    return {
      kind: 'text_selection',
      title: redactPageText(doc.title).slice(0, 120),
      text: clipBytes(selection.text, 90000),
      source: safeURL(url),
      partial: true,
    };
  }
  const roots = [...doc.querySelectorAll('main,article,[role="main"]')];
  const root = roots[0] || doc.body;
  const parts = [],
    seen = new Set(),
    coverage = { partial: false };
  let bytes = 0,
    partial = false,
    scanned = 0;
  for (const node of root.querySelectorAll(
    'h1,h2,h3,h4,p,li,blockquote,pre,dt,dd,td,th,label,[role="alert"]',
  )) {
    if (++scanned > 5000) {
      partial = true;
      break;
    }
    if (!visibleSignal(node)) continue;
    const value = safeText(node, 6000, coverage).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    bytes += new TextEncoder().encode(value).length + 1;
    if (bytes > 90000) {
      partial = true;
      break;
    }
    parts.push(value);
  }
  if (!parts.length) {
    const fallback = safeText(root, 20000).trim();
    if (fallback) parts.push(fallback);
    partial = true;
  }
  if (!parts.length) throw Error('页面暂无可读取的正文');
  return {
    kind: 'page',
    title: redactPageText(doc.title).slice(0, 120),
    text: parts.join('\n'),
    source: safeURL(url),
    partial: partial || coverage.partial || roots.length > 1,
  };
}
