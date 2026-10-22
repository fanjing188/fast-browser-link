import { renderResult, trendSeries } from './copilot-result-view.mjs';

const PAGE_ROWS = 100,
  PAGE_COLUMNS = 20,
  TREE_ITEMS = 50;
const t = (doc, zh, en) => (doc.documentElement.lang.startsWith('en') ? en : zh);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const node = (doc, tag, text, cls) => {
  const element = doc.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  element.dataset.userContent = 'true';
  return element;
};
const button = (doc, text, run) => {
  const element = node(doc, 'button', text);
  element.type = 'button';
  element.onclick = run;
  return element;
};
function safeUrl(value, image = false) {
  if (typeof value !== 'string') return null;
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(value))
    return value;
  try {
    const url = new URL(value);
    return (image ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function imageContent(doc, root, source, alt = '') {
  const url = safeUrl(source, true);
  if (!url) {
    root.append(node(doc, 'pre', source, 'task-content-text'));
    return;
  }
  const figure = node(doc, 'figure', undefined, 'task-content-image'),
    image = node(doc, 'img'),
    fallback = node(doc, 'pre', source, 'task-content-text');
  image.src = url;
  image.alt = alt || t(doc, '任务图片', 'Task image');
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  fallback.hidden = true;
  image.onerror = () => {
    image.hidden = true;
    fallback.hidden = false;
    figure.prepend(
      node(
        doc,
        'p',
        t(
          doc,
          '图片加载失败，以下保留原始内容。',
          'Image could not be loaded. Original content is preserved below.',
        ),
        'small',
      ),
    );
    image.onerror = null;
  };
  figure.append(image, fallback);
  root.append(figure);
}
function inline(doc, root, text) {
  const pattern = /(!?\[([^\]\n]*)\]\(([^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    root.append(doc.createTextNode(text.slice(end, match.index)));
    if (match[4]) root.append(node(doc, 'code', match[4]));
    else if (match[5]) root.append(node(doc, 'strong', match[5]));
    else if (match[6]) root.append(node(doc, 'em', match[6]));
    else if (match[1].startsWith('!')) imageContent(doc, root, match[3], match[2]);
    else {
      const url = safeUrl(match[3]);
      if (url) {
        const link = node(doc, 'a', match[2]);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        root.append(link);
      } else root.append(doc.createTextNode(match[0]));
    }
    end = match.index + match[0].length;
  }
  root.append(doc.createTextNode(text.slice(end)));
}
function markdown(doc, root, text) {
  const content = node(doc, 'div', undefined, 'task-content-markdown');
  let list = null,
    code = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      list = null;
      if (code) code = null;
      else {
        const pre = node(doc, 'pre');
        code = node(doc, 'code', '');
        pre.append(code);
        content.append(pre);
      }
      continue;
    }
    if (code) {
      code.append(doc.createTextNode(`${line}\n`));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line),
      item = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
    if (item) {
      const type = item[2] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== type) {
        list = node(doc, type);
        if (item[2]) list.start = Number(item[2]);
        content.append(list);
      }
      const entry = node(doc, 'li');
      inline(doc, entry, item[3]);
      list.append(entry);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const block = node(doc, heading ? `h${heading[1].length}` : 'p');
    inline(doc, block, heading ? heading[2] : line);
    content.append(block);
  }
  root.append(content);
}
function jsonTree(doc, root, value, label = 'JSON') {
  if (!value || typeof value !== 'object') {
    root.append(node(doc, 'pre', JSON.stringify(value) ?? String(value), 'task-content-text'));
    return;
  }
  const details = node(doc, 'details', undefined, 'task-content-json'),
    keys = Object.keys(value),
    content = node(doc, 'div'),
    count = node(doc, 'output', '', 'small');
  details.append(
    node(
      doc,
      'summary',
      t(
        doc,
        `${label} · ${Array.isArray(value) ? '数组' : '对象'} ${keys.length} 项`,
        `${label} · ${Array.isArray(value) ? 'Array' : 'Object'} · ${keys.length} items`,
      ),
    ),
    content,
  );
  let shown = 0;
  const more = button(doc, t(doc, '继续显示', 'Show more'), draw);
  function draw() {
    const limit = Math.min(shown + TREE_ITEMS, keys.length);
    for (; shown < limit; shown++) {
      const key = keys[shown],
        item = node(doc, 'div', undefined, 'task-content-json-entry');
      item.append(node(doc, 'strong', `${key}: `));
      jsonTree(doc, item, value[key], key);
      content.insertBefore(item, count);
    }
    count.textContent = t(
      doc,
      `已显示 ${shown} / ${keys.length} 项`,
      `${shown} / ${keys.length} items shown`,
    );
    more.hidden = shown === keys.length;
  }
  content.append(count, more);
  details.addEventListener('toggle', () => {
    if (details.open && shown === 0) draw();
  });
  root.append(details);
}
function recordsTable(doc, root, records) {
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))],
    wrap = node(doc, 'section', undefined, 'task-content-records'),
    tools = node(doc, 'div', undefined, 'actions'),
    count = node(doc, 'output', '', 'task-content-range'),
    holder = node(doc, 'div', undefined, 'table-wrap');
  let page = 0,
    columnPage = 0;
  const previous = button(doc, t(doc, '上一页', 'Previous page'), () => {
      page--;
      draw();
    }),
    next = button(doc, t(doc, '下一页', 'Next page'), () => {
      page++;
      draw();
    }),
    previousColumns = button(doc, t(doc, '上一组列', 'Previous columns'), () => {
      columnPage--;
      draw();
    }),
    nextColumns = button(doc, t(doc, '下一组列', 'Next columns'), () => {
      columnPage++;
      draw();
    });
  function draw() {
    const start = page * PAGE_ROWS,
      end = Math.min(start + PAGE_ROWS, records.length),
      columnStart = columnPage * PAGE_COLUMNS,
      columns = fields.slice(columnStart, columnStart + PAGE_COLUMNS),
      table = node(doc, 'table'),
      head = node(doc, 'thead'),
      headings = node(doc, 'tr'),
      body = node(doc, 'tbody');
    for (const field of columns) {
      const th = node(doc, 'th', field);
      th.scope = 'col';
      headings.append(th);
    }
    head.append(headings);
    for (const record of records.slice(start, end)) {
      const row = node(doc, 'tr');
      for (const field of columns) {
        const cell = node(doc, 'td'),
          value = Object.hasOwn(record, field) ? record[field] : undefined;
        if (value && typeof value === 'object') jsonTree(doc, cell, value, field);
        else cell.textContent = value === undefined ? '—' : value === null ? 'null' : String(value);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    holder.replaceChildren(table);
    count.textContent = t(
      doc,
      `第 ${start + 1}–${end} / ${records.length} 行 · 第 ${fields.length ? columnStart + 1 : 0}–${columnStart + columns.length} / ${fields.length} 列`,
      `Rows ${start + 1}–${end} / ${records.length} · Columns ${fields.length ? columnStart + 1 : 0}–${columnStart + columns.length} / ${fields.length}`,
    );
    previous.disabled = page === 0;
    next.disabled = end === records.length;
    previousColumns.disabled = columnPage === 0;
    nextColumns.disabled = columnStart + columns.length === fields.length;
    previousColumns.hidden = nextColumns.hidden = fields.length <= PAGE_COLUMNS;
  }
  count.setAttribute('aria-live', 'polite');
  holder.tabIndex = 0;
  holder.setAttribute('aria-label', t(doc, '只读结果表格', 'Read-only result table'));
  tools.append(previous, next, previousColumns, nextColumns, count);
  wrap.append(tools, holder);
  root.append(wrap);
  draw();
}
function knownContract(row, value) {
  return (
    object(value) &&
    typeof row.action === 'string' &&
    ((row.result_view && Array.isArray(row.result_view.columns) && Array.isArray(value.records)) ||
      (typeof value.verdict === 'string' &&
        (row.standard_task ||
          row.action === 'assist.task' ||
          row.action === 'general.task' ||
          row.action === 'workflow.run' ||
          row.action === 'table.export' ||
          row.action.startsWith('seo.')) &&
        (Array.isArray(value.sections) ||
          Array.isArray(value.metrics) ||
          Array.isArray(value.process))))
  );
}

export function renderTaskContent(doc, root, row, { command, clipboard } = {}) {
  root.replaceChildren();
  root.classList.add('task-content');
  let value = row.result;
  if (typeof value === 'string' && ['{', '['].includes(value.trimStart()[0])) {
    try {
      value = JSON.parse(value);
    } catch {
      /* 中文注释：非 JSON 文本保留原文。 */
    }
  }
  if (knownContract(row, value)) {
    const render = (holder) => {
      try {
        renderResult(doc, holder, { ...row, result: value }, { command, clipboard, full: true });
      } catch {
        holder.replaceChildren();
        jsonTree(doc, holder, value);
      }
    };
    if ((value.records?.length || 0) > 200) {
      root.append(node(doc, 'p', value.verdict || value.summary || row.title, 'verdict'));
      if (value.records.every(object)) recordsTable(doc, root, value.records);
      else jsonTree(doc, root, value.records, 'records');
      const details = node(doc, 'details', undefined, 'task-content-contract');
      details.append(
        node(
          doc,
          'summary',
          t(
            doc,
            `结构化结果共 ${value.records.length} 行，展开完整交互视图`,
            `${value.records.length} structured records. Open the full interactive view`,
          ),
        ),
      );
      let drawn = false;
      details.addEventListener('toggle', () => {
        if (!details.open || drawn) return;
        drawn = true;
        const content = node(doc, 'div');
        details.append(content);
        render(content);
      });
      root.append(details);
    } else render(root);
    return;
  }
  if (value == null || value === '' || (typeof value === 'object' && !Object.keys(value).length)) {
    root.append(
      node(doc, 'p', t(doc, '没有结果内容。', 'No result content.'), 'task-content-empty'),
    );
    return;
  }
  if (Array.isArray(value) && value.every(object)) {
    recordsTable(doc, root, value);
    return;
  }
  if (Array.isArray(value)) {
    jsonTree(doc, root, value);
    return;
  }
  if (object(value)) {
    if (
      Array.isArray(value.series) &&
      value.series.length &&
      value.series.every(
        (series) =>
          object(series) &&
          Array.isArray(series.points) &&
          series.points.every(
            (point) =>
              object(point) && typeof point.date === 'string' && Number.isFinite(point.value),
          ),
      )
    ) {
      let displayedPoints = 0,
        omittedSeries = 0;
      for (const series of value.series) {
        if (displayedPoints + series.points.length > 500) {
          omittedSeries++;
          continue;
        }
        displayedPoints += series.points.length;
        root.append(trendSeries(doc, series, true, { autoScale: true }));
      }
      if (omittedSeries)
        root.append(
          node(
            doc,
            'p',
            t(
              doc,
              `${omittedSeries} 个大数据系列未展开图表；完整原始数据保留在下方 JSON 中，可按需展开。`,
              `${omittedSeries} large series charts were not expanded. Complete original data is available in the expandable JSON below.`,
            ),
            'small',
          ),
        );
    }
    const source =
      value.image_url ||
      value.image ||
      (value.type === 'image' ? value.url || value.content : null);
    if (typeof source === 'string') imageContent(doc, root, source, value.alt);
    if (typeof value.markdown === 'string') markdown(doc, root, value.markdown);
    else if (value.type === 'markdown' && typeof value.content === 'string')
      markdown(doc, root, value.content);
    if (Array.isArray(value.records) && value.records.length && value.records.every(object))
      recordsTable(doc, root, value.records);
    jsonTree(doc, root, value);
    return;
  }
  if (typeof value === 'string') {
    if (
      /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value) ||
      /^https:\/\/[^\s]+\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(value)
    )
      imageContent(doc, root, value);
    else if (
      /(^|\n)(?:#{1,6}\s|\s*[-+*]\s|\s*\d+\.\s|```)|\*\*[^*]+\*\*|\[[^\]]*\]\([^\s]+\)/.test(value)
    )
      markdown(doc, root, value);
    else root.append(node(doc, 'pre', value, 'task-content-text'));
    return;
  }
  root.append(node(doc, 'pre', String(value), 'task-content-text'));
}
