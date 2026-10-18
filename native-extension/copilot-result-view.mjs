import { readableCopy } from './ui-design.mjs';
import { renderGenericTable } from './copilot-generic-result.mjs';
export const actionNames = {
  'local.lookup': '读取本机信息',
  'seo.keyword_check': '检查关键词',
  'seo.longtail': '拆长尾',
  'seo.competitor_keywords': '竞品关键词',
  'seo.serp_breakdown': '拆解搜索结果',
  'seo.save_pool': '存词池',
  'general.task': '通用任务',
  'seo.trends': '查热度趋势',
  'seo.ranking_sites': '谁在排',
  'seo.domain_rating': '查域名评分',
  'seo.top_pages': '看热门页面',
  'browser.open': '在后台打开',
  'workflow.run': '组合工作流',
  'table.export': '表格导出',
};
export const levels = { go: '建议做', test: '测一页', skip: '不做', info: '无档位' };
export const actionName = (row) => row.flow_name || actionNames[row.action] || row.title;
export const flatten = (result) =>
  result.records ||
  result.groups?.flatMap((group) =>
    group.keywords.map((word) => ({ ...word, group: group.name })),
  ) ||
  result.checks ||
  result.keywords ||
  (result.keyword ? [result] : []);
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
export function normalized(row) {
  const value = row.result || {};
  if (value.verdict) return value;
  const words = value.keywords || [],
    result = {
      verdict: (value.summary || '旧版结果待核对').slice(0, 30),
      level: 'info',
      metrics: [],
      missing: (value.missing_data || []).map((reason) => ({ field: 'data', reason })),
      process: ['旧版结构转换，未补造指标或档位'],
      next: [],
      bullets: [],
      links: [],
      artifacts: [],
    };
  if (row.action === 'seo.longtail')
    result.groups = [...new Set(words.map((w) => w.group || '未分组'))].map((name) => ({
      name,
      intent: '待判断',
      recommended: false,
      keywords: words.filter((w) => (w.group || '未分组') === name),
    }));
  else if (row.action === 'seo.keyword_check') {
    result.checks = words.map((word) => ({
      ...word,
      tier: word.tier || '待判断',
      intent: '待判断',
      serp: [],
      reasons: [],
    }));
    Object.assign(
      result,
      result.checks[0] || {
        keyword: row.params?.keyword,
        tier: '待判断',
        intent: '待判断',
        serp: [],
        reasons: [],
      },
    );
  } else if (row.action === 'seo.competitor_keywords')
    Object.assign(result, { domain: row.params?.url, top_pages: [], keywords: words });
  else if (row.action === 'seo.serp_breakdown')
    Object.assign(result, { query: row.params?.url, results: [], gaps: [] });
  return result;
}
export function ordered(rows, sort = 'opportunity', direction = 1, query = '') {
  return rows
    .filter((row) => row.keyword.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sort === 'opportunity') return Number(!!b.opportunity) - Number(!!a.opportunity);
      if (a[sort] == null && b[sort] == null) return 0;
      if (a[sort] == null) return 1;
      if (b[sort] == null) return -1;
      return (
        (typeof a[sort] === 'number'
          ? a[sort] - b[sort]
          : String(a[sort]).localeCompare(String(b[sort]))) * direction
      );
    });
}
function el(doc, tag, text, cls) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  if (['verdict', 'result-text'].includes(cls)) node.dataset.userContent = 'true';
  return node;
}
function trendSeries(doc, series, full) {
  const wrap = el(doc, 'figure', undefined, full ? 'trend-chart' : ''),
    caption = el(doc, 'figcaption', `${series.keyword} · ${series.region} · ${series.period}`);
  caption.dataset.userContent = 'true';
  wrap.append(caption);
  const points = series.points || [];
  if (!points.length) return wrap;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    en = doc.documentElement.lang.startsWith('en');
  const shape = (name, attributes = {}, text) => {
    const node = doc.createElementNS(svg.namespaceURI, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  svg.setAttribute('viewBox', full ? '0 0 640 240' : '0 0 280 72');
  svg.setAttribute('role', full ? 'group' : 'img');
  svg.setAttribute(
    'aria-label',
    `${caption.textContent} · ${points[0].date} → ${points.at(-1).date} · 0–100`,
  );
  const x = (index) =>
      full
        ? 52 + (index / Math.max(1, points.length - 1)) * 564
        : 8 + (index / Math.max(1, points.length - 1)) * 264,
    y = (value) => (full ? 184 - value * 1.6 : 64 - value * 0.56);
  if (full) {
    for (const value of [0, 50, 100])
      svg.append(
        shape('line', { x1: 52, x2: 616, y1: y(value), y2: y(value), class: 'trend-grid' }),
        shape(
          'text',
          { x: 40, y: y(value) + 4, 'text-anchor': 'end', class: 'trend-axis-label' },
          value,
        ),
      );
    svg.append(
      shape('line', { x1: 52, x2: 52, y1: 24, y2: 184, class: 'trend-axis' }),
      shape('line', { x1: 52, x2: 616, y1: 184, y2: 184, class: 'trend-axis' }),
    );
    for (const index of new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])) {
      const label = shape(
        'text',
        {
          x: x(index),
          y: 209,
          'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
          class: 'trend-axis-label',
        },
        points[index].date,
      );
      label.dataset.userContent = 'true';
      svg.append(label);
    }
  }
  svg.append(
    shape('polyline', {
      points: points.map((point, index) => `${x(index)},${y(point.value)}`).join(' '),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': full ? 2.5 : 2,
      class: 'trend-line',
    }),
  );
  if (full) {
    const reading = el(
      doc,
      'output',
      en
        ? 'Focus or hover a point to read its date and value.'
        : '聚焦或悬停数据点，查看日期与热度。',
      'trend-point-reading',
    );
    reading.setAttribute('aria-live', 'polite');
    reading.dataset.userContent = 'true';
    for (const [index, point] of points.entries()) {
      const label = `${point.date} · ${point.value}`,
        dot = shape('circle', {
          cx: x(index),
          cy: y(point.value),
          r: 4,
          tabindex: 0,
          role: 'img',
          'aria-label': label,
          class: 'trend-point',
        });
      dot.append(shape('title', {}, label));
      dot.onfocus = dot.onmouseenter = () => {
        reading.textContent = label;
      };
      svg.append(dot);
    }
    const table = el(doc, 'table', undefined, 'trend-data-table sr-only'),
      head = el(doc, 'tr'),
      thead = el(doc, 'thead'),
      body = el(doc, 'tbody');
    table.append(el(doc, 'caption', en ? 'Observed trend points' : '趋势观测数据'));
    for (const label of en ? ['Date', 'Interest'] : ['日期', '热度']) {
      const th = el(doc, 'th', label);
      th.scope = 'col';
      head.append(th);
    }
    thead.append(head);
    table.append(thead);
    body.dataset.userContent = 'true';
    for (const point of points) {
      const row = el(doc, 'tr');
      row.append(el(doc, 'td', point.date), el(doc, 'td', String(point.value)));
      body.append(row);
    }
    table.append(body);
    wrap.append(svg, reading, table);
  } else {
    svg.style.cssText = 'width:100%;max-height:100px;color:var(--accent, #286849)';
    wrap.append(svg);
    const data = el(doc, 'details');
    data.append(el(doc, 'summary', '曲线数据'));
    for (const point of points) data.append(el(doc, 'p', `${point.date} · ${point.value}`));
    wrap.append(data);
  }
  return wrap;
}
export function renderResult(
  doc,
  article,
  row,
  { command, clipboard = globalThis.navigator?.clipboard, full = false } = {},
) {
  if (row.action === 'workflow.run' && row.result_deferred && !full) {
    const owner = article,
      holder = el(doc, 'div', undefined, 'workflow-result');
    owner.append(holder);
    const cached = owner._workflowToken === row.result_token ? owner._workflowFull : null;
    renderResult(
      doc,
      holder,
      {
        ...row,
        result_deferred: false,
        result: cached?.result || {
          ...row.result,
          records: [],
          steps: [],
          artifacts: [],
          process: [],
          next: [],
        },
      },
      { command, clipboard, full: false },
    );
    if (!cached) {
      const detail = holder.querySelector('.result-details');
      let loading = false;
      detail.addEventListener('toggle', async () => {
        if (!detail.open || loading) return;
        loading = true;
        try {
          const complete = await command('result', { id: row.id });
          owner._workflowToken = row.result_token;
          owner._workflowFull = complete;
          holder.replaceChildren();
          renderResult(doc, holder, complete, { command, clipboard });
          holder.querySelector('.result-details').open = true;
        } catch {
          holder
            .querySelector('.result-details')
            .append(el(doc, 'p', '结果读取未完成，请稍后重试。', 'missing'));
          loading = false;
        }
      });
    }
    return;
  }
  row = { ...row, action: row.render_as || row.action };
  const result = normalized(row),
    view = (article._resultState ||= {
      selected: new Set(),
      group: 0,
      expanded: new Set(),
      sort: 'opportunity',
      direction: 1,
      query: '',
    });
  view.selectedObjects ??= new Map();
  const objectEntries = (result.records || [])
    .filter((item) => !item.keyword && (item.domain || item.url))
    .map((item) => ({ type: item.domain ? 'domain' : 'url', value: item.domain || item.url }));
  for (const key of view.selectedObjects.keys())
    if (!objectEntries.some((item) => item.type + '|' + item.value === key))
      view.selectedObjects.delete(key);
  const selectedEntries = () => [
    ...[...view.selected].map((value) => ({ type: 'keyword', value })),
    ...view.selectedObjects.values(),
  ];
  const action = (label, name, params = {}) => {
    const button = el(doc, 'button', label);
    button.type = 'button';
    button.dataset.action = name;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await command(name, { id: row.id, ...(typeof params === 'function' ? params() : params) });
      } catch {
        doc.getElementById('notice').textContent = '操作未完成，请检查本地连接和数据源后重试。';
      } finally {
        button.disabled = false;
      }
    };
    return button;
  };
  if (row.rerun_warning) article.append(el(doc, 'p', row.rerun_warning, 'failure'));
  if (row.reason)
    article.append(
      el(doc, 'p', readableCopy(row.reason, doc.documentElement.lang || 'zh'), 'failure'),
    );
  const summary = full ? el(doc, 'section', undefined, 'result-card result-overview') : article;
  if (full) article.append(summary);
  const level = el(doc, 'span', levels[result.level] || '无档位', 'level');
  level.dataset.level = result.level;
  if (result.level && result.level !== 'info') summary.append(level);
  summary.append(el(doc, 'p', result.verdict, 'verdict'));
  const metrics = el(doc, 'div', undefined, 'result-metrics');
  for (const metric of result.metrics || [])
    metrics.append(el(doc, 'span', metric.label + ' ' + metric.value));
  if (metrics.childNodes.length) summary.append(metrics);
  const missing = result.missing || [],
    allWords = row.result_view ? [] : flatten(result).filter((item) => item.keyword),
    noVol = allWords.length && !allWords.some((w) => w.vol != null),
    noKD = allWords.length && !allWords.some((w) => w.kd != null);
  if (missing.length || noVol || noKD) {
    const notice = el(
      doc,
      'p',
      `${noVol && noKD ? '未取得量和 KD' : noVol ? '未取得量' : noKD ? '未取得 KD' : '缺数据'}：${missing.map((item) => readableCopy(item.reason, doc.documentElement.lang || 'zh')).join('；') || '数据源未提供'}`,
      'missing',
    );
    article.append(notice);
    if (row.basket_batch) article.append(action('重估工作篮', 'open_basket'));
    else if (row.resume_from) article.append(action('继续', 'retry'));
    else if (row.action !== 'table.export')
      article.append(
        ['seo.keyword_check', 'seo.longtail', 'seo.competitor_keywords'].includes(row.action)
          ? action('补取数据', 'replenish')
          : action('重试', 'retry'),
      );
  }
  const detail = el(
    doc,
    full ? 'section' : 'details',
    undefined,
    full ? 'result-card result-details' : 'result-details',
  );
  if (!full) detail.append(el(doc, 'summary', '展开结果'));
  else
    detail.append(
      el(
        doc,
        'h2',
        result.groups
          ? '关键词分组'
          : row.action === 'workflow.run'
            ? '工作流结果'
            : row.action === 'seo.trends'
              ? '趋势分析'
              : row.action === 'seo.serp_breakdown'
                ? '搜索结果'
                : result.export
                  ? '导出文件'
                  : allWords.length
                    ? '关键词数据'
                    : '任务内容',
      ),
    );
  const content = el(doc, 'div', undefined, 'result-content');
  detail.append(content);
  article.append(detail);
  for (const word of view.selected)
    if (!allWords.some((item) => item.keyword === word)) view.selected.delete(word);
  const batches = el(doc, 'div', undefined, 'batch-actions');
  batches.hidden = true;
  const count = el(doc, 'span');
  batches.append(count);
  const refresh = () => {
    batches.hidden = !selectedEntries().length;
    count.textContent = `已选 ${selectedEntries().length} 个对象`;
    for (const button of batches.querySelectorAll('[data-keyword-only]'))
      button.disabled = !view.selected.size;
  };
  for (const [label, operation] of [
    ['批量查词', 'check'],
    ['存词池', 'save'],
  ]) {
    const button = el(doc, 'button', label);
    button.dataset.keywordOnly = 'true';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await command('batch', { id: row.id, operation, keywords: [...view.selected] });
      } catch {
        doc.getElementById('notice').textContent = '批量操作未完成，请核对连接或重新选择关键词。';
      } finally {
        button.disabled = false;
      }
    };
    batches.append(button);
  }
  const collect = el(doc, 'button', '加入工作篮');
  collect.onclick = async () => {
    collect.disabled = true;
    try {
      await command('basket_add', {
        items: selectedEntries().map((item) => ({ ...item, source: row.params?.url || '' })),
      });
    } finally {
      collect.disabled = false;
    }
  };
  batches.append(collect);
  const copy = el(doc, 'button', '复制选中');
  copy.onclick = () =>
    clipboard.writeText(
      selectedEntries()
        .map((item) => item.value)
        .join('\n'),
    );
  batches.append(copy);
  function check(word) {
    const box = el(doc, 'input');
    box.type = 'checkbox';
    box.checked = view.selected.has(word.keyword);
    box.setAttribute('aria-label', '选择 ' + word.keyword);
    box.onchange = () => {
      if (box.checked) view.selected.add(word.keyword);
      else view.selected.delete(word.keyword);
      refresh();
    };
    return box;
  }
  function stateLabel(word) {
    const state = row.row_states?.[word.keyword];
    return [
      state?.pool ? '✓池' : '',
      state?.tier || '',
      word.vol == null && word.kd == null ? '缺' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  function list(words, limit) {
    const wrap = el(doc, 'div', undefined, 'table-wrap'),
      table = el(doc, 'table'),
      head = el(doc, 'tr');
    const columns = [
      ['keyword', '词'],
      ...(!noVol ? [['vol', '量']] : []),
      ...(!noKD ? [['kd', 'KD']] : []),
      ...(row.action === 'seo.competitor_keywords' ? [['position', '排名']] : []),
      ...(full
        ? [
            ['group', '分组'],
            ['source', '来源'],
          ]
        : row.action !== 'seo.longtail' && allWords.some((word) => word.group)
          ? [['group', '分组']]
          : []),
    ];
    head.append(el(doc, 'th', '选'));
    for (const [field, label] of columns) {
      const th = el(doc, 'th', label);
      th.scope = 'col';
      if (['vol', 'kd'].includes(field)) {
        const sort = el(doc, 'button', label);
        sort.setAttribute('aria-label', '按' + label + '排序');
        sort.onclick = () => {
          view.direction = view.sort === field ? -view.direction : 1;
          view.sort = field;
          draw();
        };
        th.replaceChildren(sort);
      }
      head.append(th);
    }
    const thead = el(doc, 'thead');
    thead.append(head);
    table.append(thead);
    const body = el(doc, 'tbody');
    for (const word of words.slice(0, limit)) {
      const tr = el(doc, 'tr'),
        selected = el(doc, 'td');
      selected.append(check(word));
      tr.append(selected);
      for (const [field] of columns) {
        const td = el(doc, 'td'),
          value = el(doc, 'span', word[field] == null ? '—' : String(word[field]));
        value.dataset.userContent = 'true';
        td.append(value);
        if (word.field_sources?.[field]) td.title = word.field_sources[field];
        if (field === 'keyword') {
          const state = el(doc, 'span', stateLabel(word), 'word-state');
          state.title =
            row.row_states?.[word.keyword]?.missing ||
            missing
              .map((item) => readableCopy(item.reason, doc.documentElement.lang || 'zh'))
              .join('；') ||
            '此词的数据源未提供量或KD';
          td.append(state);
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    return wrap;
  }
  function serp(rows) {
    const list = el(doc, 'ol', undefined, 'serp-list');
    for (const row of rows || []) {
      const line = el(
        doc,
        'li',
        `${row.rank}. ${row.domain} · ${row.page_type}${row.small_site ? ' · 小站' : ''}`,
      );
      if (row.small_site) line.className = 'small-site';
      list.append(line);
    }
    return list;
  }
  function points(items) {
    const list = el(doc, 'ul');
    list.dataset.userContent = 'true';
    for (const item of items || [])
      list.append(
        el(
          doc,
          'li',
          String(item).trim().startsWith('{') || String(item).trim().startsWith('[')
            ? '结构化过程记录，请打开报告核对'
            : item,
        ),
      );
    return list;
  }
  function draw() {
    content.replaceChildren();
    if (row.result_view && !row.action.startsWith('seo.')) {
      renderGenericTable(doc, content, row, { command, clipboard });
      for (const step of result.steps || [])
        content.append(el(doc, 'p', `${step.label} · ${step.status} · ${step.count}`, 'small'));
      if (result.decision)
        content.append(el(doc, 'p', JSON.stringify(result.decision), 'result-text'));
    } else if (full && allWords.length && row.action !== 'workflow.run' && !result.groups) {
      const filter = el(doc, 'input');
      filter.type = 'search';
      filter.placeholder = '筛选关键词';
      filter.setAttribute('aria-label', '筛选关键词');
      filter.value = view.query;
      filter.oninput = () => {
        view.query = filter.value;
        const start = filter.selectionStart;
        draw();
        const field = content.querySelector('input[type=search]');
        field.focus();
        field.setSelectionRange(start, start);
      };
      content.append(
        filter,
        list(ordered(allWords, view.sort, view.direction, view.query), Infinity),
      );
      if (row.action === 'seo.keyword_check') {
        for (const item of result.checks?.length ? result.checks : [result]) {
          if (!item.serp?.length && !item.reasons?.length) continue;
          const insight = el(doc, 'section', undefined, 'keyword-insight');
          insight.append(
            el(doc, 'h3', item.keyword || '关键词分析'),
            el(doc, 'p', `意图：${item.intent || '待判断'} · 档位：${item.tier || '待判断'}`),
            serp(item.serp),
            points(item.reasons),
          );
          content.append(insight);
        }
      }
      if (row.action === 'seo.competitor_keywords')
        for (const page of result.top_pages || []) {
          const url = safeLink(page.url);
          if (url) {
            const a = el(doc, 'a', page.url);
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            content.append(a);
          }
        }
    } else if (result.groups) {
      const tabs = el(doc, 'div', undefined, 'group-tabs');
      tabs.setAttribute('role', 'tablist');
      result.groups.forEach((group, index) => {
        const tab = el(doc, 'button', `${group.name} ${group.keywords.length}`);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(view.group === index));
        if (group.recommended) tab.className = 'recommended';
        tab.onclick = () => {
          view.group = index;
          draw();
          content.querySelectorAll('[role=tab]')[index]?.focus();
        };
        tabs.append(tab);
      });
      content.append(tabs);
      const group = result.groups[view.group] || result.groups[0];
      if (group) {
        content.append(el(doc, 'p', group.intent, 'small'));
        const all = el(doc, 'input');
        all.type = 'checkbox';
        all.setAttribute('aria-label', '全选 ' + group.name);
        all.checked =
          group.keywords.length > 0 &&
          group.keywords.every((word) => view.selected.has(word.keyword));
        all.onchange = () => {
          for (const word of group.keywords) {
            if (all.checked) view.selected.add(word.keyword);
            else view.selected.delete(word.keyword);
          }
          draw();
        };
        const label = el(doc, 'label', '全选本组');
        label.prepend(all);
        content.append(
          label,
          list(group.keywords, full || view.expanded.has(view.group) ? Infinity : 5),
        );
        if (!full && group.keywords.length > 5 && !view.expanded.has(view.group)) {
          const more = el(doc, 'button', `展开其余 ${group.keywords.length - 5} 个`);
          more.onclick = () => {
            view.expanded.add(view.group);
            draw();
          };
          content.append(more);
        }
      }
    } else if (row.action === 'seo.keyword_check') {
      if (result.checks?.length > 1) content.append(list(result.checks, 1000));
      else
        content.append(
          el(doc, 'p', `意图：${result.intent || '待判断'} · 档位：${result.tier || '待判断'}`),
          serp(result.serp),
          points(result.reasons),
        );
    } else if (row.action === 'seo.competitor_keywords') {
      const rows = ordered(result.keywords || [], view.sort, view.direction);
      content.append(list(rows, view.expanded.has('competitor') ? Infinity : 10));
      if (rows.length > 10 && !view.expanded.has('competitor')) {
        const more = el(doc, 'button', '展开');
        more.onclick = () => {
          view.expanded.add('competitor');
          draw();
        };
        content.append(more);
      }
      for (const page of result.top_pages || []) {
        const url = safeLink(page.url);
        if (url) {
          const a = el(doc, 'a', page.url);
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          content.append(a);
        }
      }
    } else if (row.action === 'workflow.run') {
      if (result.steps?.length) {
        const steps = el(doc, 'section', undefined, 'workflow-steps');
        steps.append(
          el(doc, 'h3', '执行步骤'),
          points(
            result.steps.map(
              (step, index) =>
                `${index + 1}. ${step.label} · ${step.status}${step.count != null ? ' · ' + step.count : ''}${step.source ? ' · ' + step.source : ''}`,
            ),
          ),
        );
        content.append(steps);
      }
      const table = el(doc, 'table'),
        head = el(doc, 'tr');
      for (const title of ['选', '对象', '量', 'KD', '档位', '热度末3点 / 范围', '来源'])
        head.append(el(doc, 'th', title));
      const thead = el(doc, 'thead');
      thead.append(head);
      table.append(thead);
      const body = el(doc, 'tbody');
      for (const item of (result.records || []).slice(
        0,
        full || view.expanded.has('workflow') ? Infinity : 10,
      )) {
        const tr = el(doc, 'tr'),
          selected = el(doc, 'td');
        if (item.keyword) selected.append(check(item));
        else if (item.domain || item.url) {
          const value = { type: item.domain ? 'domain' : 'url', value: item.domain || item.url },
            key = value.type + '|' + value.value,
            box = el(doc, 'input');
          box.type = 'checkbox';
          box.checked = view.selectedObjects.has(key);
          box.setAttribute('aria-label', '选择 ' + value.value);
          box.onchange = () => {
            if (box.checked) view.selectedObjects.set(key, value);
            else view.selectedObjects.delete(key);
            refresh();
          };
          selected.append(box);
        }
        tr.append(selected);
        for (const value of [
          item.keyword || item.domain || item.url || '—',
          item.vol ?? '—',
          item.kd ?? '—',
          item.tier || item.verdict || '—',
          item.trend12?.length
            ? item.trend12.slice(-3).join(' → ') + ' · ' + (item.trend_source || '')
            : '—',
          item.source || '—',
        ]) {
          const td = el(doc, 'td', String(value));
          td.dataset.userContent = 'true';
          td.title = Object.entries(item.field_sources || {})
            .map(([field, source]) => field + ': ' + source)
            .join('\n');
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(body);
      const wrap = el(doc, 'div', undefined, 'table-wrap');
      wrap.append(table);
      content.append(wrap);
      if (!full && (result.records || []).length > 10 && !view.expanded.has('workflow')) {
        const more = el(doc, 'button', '展开');
        more.onclick = () => {
          view.expanded.add('workflow');
          draw();
        };
        content.append(more);
      }
      for (const file of result.artifacts || [])
        content.append(el(doc, 'p', file.label + ' · ' + file.path, 'small'));
    } else if (row.action === 'seo.trends') {
      content.append(
        el(
          doc,
          'p',
          {
            rising: '上升',
            stable: '平稳',
            seasonal: '季节性',
            falling: '下降',
            unknown: '数据不足，暂不判断',
          }[result.pattern] || result.pattern,
        ),
      );
      for (const series of result.series || []) content.append(trendSeries(doc, series, full));
      if (result.peak_months?.length)
        content.append(el(doc, 'p', '峰值月份：' + result.peak_months.join('、')));
    } else if (row.action === 'seo.ranking_sites') {
      for (const site of result.sites || []) {
        content.append(
          el(doc, 'strong', site.domain),
          points(
            site.keywords.map((word) => word.keyword + (word.vol != null ? ' · ' + word.vol : '')),
          ),
        );
      }
      content.append(points(result.reasons));
    } else if (row.action === 'seo.domain_rating')
      content.append(
        el(doc, 'p', result.domain + ' · ' + (result.rating ?? '缺数据')),
        el(doc, 'p', result.source),
      );
    else if (row.action === 'seo.top_pages')
      content.append(
        points(
          result.top_pages.map(
            (page) => page.url + (page.traffic != null ? ' · ' + page.traffic : ''),
          ),
        ),
      );
    else if (row.action === 'seo.serp_breakdown')
      content.append(serp(result.results), points(result.gaps));
    else if (row.action === 'seo.save_pool')
      content.append(
        el(doc, 'p', '实际新增：' + (result.written ?? '回执待核对')),
        points((result.skipped || []).map((word) => word.keyword + '：' + word.reason)),
      );
    else if (result.export) {
      if (result.export.pages > 1)
        content.append(el(doc, 'p', '后台页面与当前页面筛选可能不同；请核对导出范围。', 'missing'));
      content.append(
        el(
          doc,
          'p',
          `${result.export.rows} 行 · ${result.export.pages} ${result.export.unit || '页'}`,
        ),
      );
      for (const file of result.export.files || []) {
        content.append(
          el(doc, 'p', file.path, 'small'),
          action('打开文件', 'table_open', { id: file.id }),
          action('打开目录', 'table_open', { id: file.id, folder: true }),
        );
      }
    } else {
      content.append(points(result.bullets));
      if (full) {
        for (const value of [result.text, result.markdown, result.content].filter(
          (value) => typeof value === 'string' && value.trim(),
        ))
          content.append(el(doc, 'p', value, 'result-text'));
        if (result.records?.length) {
          const wrap = el(doc, 'div', undefined, 'table-wrap'),
            table = el(doc, 'table'),
            head = el(doc, 'tr'),
            keys = [...new Set(result.records.flatMap((item) => Object.keys(item)))].slice(0, 12),
            thead = el(doc, 'thead'),
            body = el(doc, 'tbody');
          for (const key of keys) head.append(el(doc, 'th', key));
          thead.append(head);
          table.append(thead);
          for (const item of result.records) {
            const tr = el(doc, 'tr');
            for (const key of keys) {
              const value = item[key];
              const td = el(
                doc,
                'td',
                value == null
                  ? '—'
                  : typeof value === 'object'
                    ? JSON.stringify(value)
                    : String(value),
              );
              td.dataset.userContent = 'true';
              tr.append(td);
            }
            body.append(tr);
          }
          table.append(body);
          wrap.append(table);
          content.append(wrap);
        }
      }
      for (const link of result.links || []) {
        const url = safeLink(link.url);
        if (url) {
          const a = el(doc, 'a', link.label);
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          content.append(a);
        }
      }
      for (const file of result.artifacts || [])
        content.append(el(doc, 'p', file.label + ' · ' + file.path, 'small'));
    }
    if (!row.result_view) {
      content.append(batches);
      refresh();
    }
  }
  draw();
  const actions = el(doc, 'div', undefined, 'actions');
  if (allWords.length) {
    const copyAll = el(doc, 'button', '复制全部');
    copyAll.dataset.action = 'copy';
    copyAll.onclick = async () => {
      await clipboard.writeText(allWords.map((w) => w.keyword).join('\n'));
      doc.getElementById('notice').textContent = `已复制 ${allWords.length} 个关键词`;
    };
    actions.append(copyAll);
    if (!full) actions.append(action('打开全表', 'open_result'));
    if (full)
      actions.append(
        action('导出 CSV', 'export_results', () => ({
          keywords: ordered(allWords, view.sort, view.direction, view.query).map((w) => w.keyword),
        })),
      );
    if (!row.pool_saved) actions.append(action('存词池', 'save_result'));
  }
  if (!full && result.records?.length && !allWords.length)
    actions.append(action('打开全表', 'open_result'));
  if (row.report) actions.append(action('打开报告', 'open_report'));
  for (const [index, next] of (result.next || []).entries())
    actions.append(action('继续', 'next_action', { index }));
  if (row.action === 'seo.keyword_check' && allWords.length)
    actions.append(action('拆长尾', 'followup', { action: 'seo.longtail' }));
  if (actions.childNodes.length) {
    if (full) actions.classList.add('result-card', 'result-action-card');
    article.append(actions);
  }
  if (full) {
    if (result.process?.length) {
      const source = el(doc, 'section', undefined, 'result-card result-source');
      source.append(el(doc, 'h2', '数据说明'), points(result.process));
      article.append(source);
    }
  } else {
    const process = el(doc, 'details', undefined, 'result-process');
    process.append(el(doc, 'summary', '过程与来源'), points(result.process));
    article.append(process);
  }
}
