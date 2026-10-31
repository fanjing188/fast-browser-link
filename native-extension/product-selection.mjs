import { redactPageText, privateAccountNode } from '../page-semantics/redact.mjs';
const controls =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[autocomplete*="password"],[data-fast-automation-overlay]';
export const normalized = (value) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function classifySelection(text) {
  text = text.trim();
  if (!text) return 'none';
  try {
    const url = new URL(text.includes('://') ? text : 'https://' + text);
    if (
      !/\s/u.test(text) &&
      /^https?:$/.test(url.protocol) &&
      url.hostname.includes('.') &&
      !url.username &&
      !url.password &&
      /^[\p{L}\p{N}.-]+$/u.test(url.hostname)
    )
      return 'domain';
  } catch {}
  const parts = text
    .split(/[\n,，;；]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  if (parts.length > 1) return 'multiple';
  const units = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(
    (unit) => unit.isWordLike,
  );
  return units.length >= 1 && units.length <= 8 && !/[。！？.!?;；\n]/u.test(text)
    ? 'keyword'
    : 'text';
}
// 中文注释：Range.toString 会包含隐藏后代；所有选区入口只投影可见文本节点，并保留精确边界。
export function visibleRangeText(doc, range) {
  const root = range.commonAncestorContainer,
    walker = doc.createTreeWalker(root, 4),
    parts = [];
  let current = root.nodeType === 3 ? root : walker.nextNode(),
    scanned = 0,
    length = 0,
    previousBlock = null;
  while (current) {
    if (++scanned > 20000) return '';
    const parent = current.parentElement;
    if (
      parent &&
      range.intersectsNode(current) &&
      !parent.closest(`${controls},script,style,noscript,template`) &&
      !privateAccountNode(parent)
    ) {
      let visible = true;
      for (let element = parent; element; element = element.parentElement) {
        const style = doc.defaultView.getComputedStyle(element);
        if (
          element.hidden ||
          element.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' ||
          ['hidden', 'collapse'].includes(style.visibility) ||
          style.opacity === '0'
        ) {
          visible = false;
          break;
        }
      }
      if (visible) {
        const value = current.textContent.slice(
          current === range.startContainer ? range.startOffset : 0,
          current === range.endContainer ? range.endOffset : undefined,
        );
        length += value.length;
        if (length > 100000) return '';
        const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre');
        if (value && parts.length && block && previousBlock && block !== previousBlock)
          parts.push('\n');
        if (value) parts.push(value);
        if (value && block) previousBlock = block;
      }
    }
    current = walker.nextNode();
  }
  return parts.join('');
}
export function selectedText(doc) {
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0),
    element = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
  const start = element(range.startContainer),
    end = element(range.endContainer),
    common = element(range.commonAncestorContainer);
  if (
    [start, end, common].some((node) =>
      node?.closest('form,[role=dialog]')?.querySelector('input[type=password]'),
    )
  )
    return null;
  if (
    !start ||
    !end ||
    !common ||
    start.closest(controls) ||
    end.closest(controls) ||
    common.closest(controls) ||
    doc.activeElement?.closest?.(controls)
  )
    return null;
  for (const node of common.querySelectorAll?.(controls) || []) {
    if (
      node.matches('input[type=checkbox],input[type=radio],input[type=button],input[type=submit]')
    )
      continue;
    if (range.intersectsNode(node)) return null;
  }
  for (const node of [start, end]) {
    const style = doc.defaultView.getComputedStyle(node);
    if (
      node.closest('[hidden],[aria-hidden="true"]') ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    )
      return null;
  }
  if ([start, end, common].some(privateAccountNode)) return null;
  for (const node of common.querySelectorAll?.(
    'button,a,img,[role=button],[role=menu],[role=dialog],[aria-haspopup=menu],[data-account],[data-profile]',
  ) || []) {
    if (privateAccountNode(node) && range.intersectsNode(node)) return null;
  }
  const text = visibleRangeText(doc, range)
    .split(/\r\n?|\n/u)
    .map(redactPageText)
    .join('\n')
    .trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect?.();
  return { text, rect: rect || { left: 0, right: 0, top: 0, bottom: 0 } };
}
