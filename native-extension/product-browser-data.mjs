// 中文注释：只读可见的搜索链接和曲线表/可访问标签；不访问页面私有接口、Cookie或隐藏字段。
export function readSearch(doc = globalThis.document) {
  const blocked = [...doc.querySelectorAll('h1,h2,[role="alert"],iframe[title]')]
    .map((el) => el.textContent + ' ' + (el.title || ''))
    .join(' ');
  if (
    /captcha|verify you are human|unusual traffic|验证码|额度|sign in to continue|登录后/i.test(
      blocked,
    ) ||
    doc.querySelector('input[type=password]')
  )
    return { error: 'blocked' };
  const visible = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true'
      )
        return false;
    }
    return true;
  };
  const results = [],
    seen = new Set();
  for (const heading of doc.querySelectorAll('h3')) {
    const link = heading.closest('a[href]');
    if (!link) continue;
    if (!visible(heading)) continue;
    try {
      let url = new URL(link.href, doc.location.href);
      if (url.hostname.endsWith('google.com') && url.pathname === '/url')
        url = new URL(url.searchParams.get('q') || url.searchParams.get('url'));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.hostname.endsWith('google.com') ||
        seen.has(url.href)
      )
        continue;
      seen.add(url.href);
      results.push({ url: url.href, title: heading.textContent.trim().slice(0, 500) });
      if (results.length === 10) break;
    } catch {}
  }
  return { results, source: 'Google Search · visible result links' };
}
export function readTrends(keywords, region, period, doc = globalThis.document) {
  const rising = !Array.isArray(keywords) && keywords.report === 'rising';
  keywords = Array.isArray(keywords) ? keywords : keywords.keywords;
  const visible = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true'
      )
        return false;
    }
    return !el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  };
  const nodes = [...doc.querySelectorAll('h1,h2,[role="alert"],iframe[title]')].filter(visible),
    alert = nodes.map((node) => node.textContent + ' ' + (node.title || '')).join(' ');
  if (
    /captcha|verify you are human|unusual traffic|验证码|额度|sign in to continue|登录后/i.test(
      alert,
    ) ||
    [...doc.querySelectorAll('input[type=password]')].some(visible)
  )
    return { error: 'blocked' };
  const cellText = (cell) => {
    const walker = doc.createTreeWalker(cell, 4);
    let text = '',
      node;
    while ((node = walker.nextNode()))
      if (node.parentElement && visible(node.parentElement)) text += ' ' + node.textContent;
    return text.trim();
  };
  const observation = () => ({
    state: doc.readyState,
    visibility: doc.visibilityState,
    tables: doc.querySelectorAll('table').length,
    widgets: doc.querySelectorAll('widget').length,
    headings: nodes
      .filter((node) => node.localName !== 'iframe')
      .map(cellText)
      .join(' ')
      .slice(0, 500),
  });
  if (rising) {
    const records = [],
      seen = new Set();
    for (const widget of doc.querySelectorAll('widget,[data-trend-report="related-queries"]')) {
      if (!visible(widget)) continue;
      const text = cellText(widget);
      if (!/相关查询|Related queries/i.test(text) || !/搜索量上升|Rising/i.test(text)) continue;
      for (const link of widget.querySelectorAll('a[href]')) {
        if (!visible(link)) continue;
        let url;
        try {
          url = new URL(link.href, doc.location.href);
        } catch {
          continue;
        }
        const keyword = url.searchParams.get('q'),
          label = cellText(link);
        if (
          url.hostname !== 'trends.google.com' ||
          !keyword ||
          keyword.startsWith('/') ||
          !label ||
          !/(?:\+?[\d,.]+%|Breakout|飙升)/i.test(label) ||
          seen.has(keyword)
        )
          continue;
        seen.add(keyword);
        records.push({
          keyword,
          reason: label.replace(/\s+/g, ' ').slice(0, 300),
          trend_source: 'Google Trends rising queries',
          source: 'Google Trends · related queries · rising',
        });
      }
    }
    return {
      records,
      source: 'Google Trends · related queries · rising',
      missing: records.length ? [] : ['no readable rising queries'],
      ...(!records.length ? { observation: observation() } : {}),
    };
  }
  const series = keywords.map((keyword) => ({ keyword, region, period, points: [] }));
  const query = new URL(doc.location.href).searchParams.get('q')?.split(',') || [];
  const dateText = (value) => {
    value = value.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    const localized = value.match(/^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/);
    if (localized)
      value = `${localized[1]}-${localized[2].padStart(2, '0')}${localized[3] ? '-' + localized[3].padStart(2, '0') : ''}`;
    return /^\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?$/.test(value) ? value : null;
  };
  // 中文注释：图表自带的无障碍表是页面公开数据；x/y1 仅在搜索词顺序与当前 URL 一致时映射。
  for (const table of doc.querySelectorAll('table,[role=table],[role=grid]')) {
    if (!visible(table)) continue;
    const rows = [...table.querySelectorAll('tr,[role=row]')].map((row) =>
      [...row.querySelectorAll('th,td,[role=columnheader],[role=cell],[role=gridcell]')].map(
        (cell) => (visible(cell) ? cellText(cell) : ''),
      ),
    );
    if (rows.length < 2) continue;
    const headers = rows[0],
      accessible = table.closest(
        '[aria-label="A tabular representation of the data in the chart."]',
      );
    for (const [index, item] of series.entries()) {
      let col = headers.findIndex(
        (text) => text.trim().toLowerCase() === item.keyword.toLowerCase(),
      );
      if (
        col < 1 &&
        accessible &&
        headers[0] === 'x' &&
        headers[index + 1] === 'y' + (index + 1) &&
        query.length === keywords.length &&
        query.every((word, i) => word === keywords[i])
      )
        col = index + 1;
      if (col < 1) continue;
      for (const row of rows.slice(1, 401)) {
        const date = dateText(row[0] || ''),
          value = Number(row[col]);
        if (date && row[col]?.trim() && Number.isFinite(value) && value >= 0 && value <= 100)
          item.points.push({ date, value });
      }
    }
  }
  const measured = series.filter((item) => item.points.length);
  return {
    series: measured,
    source: 'Google Trends · accessible chart data table; independently normalized per comparison',
    ...(!measured.length ? { observation: observation() } : {}),
  };
}
