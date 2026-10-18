// 中文注释：隔离世界中的确认装饰层；只持有原节点，不给站点节点添加样式、属性或输入锁。
export function tableConfirmation(
  {
    action = 'begin',
    token,
    tables,
    index = 0,
    format = 'xlsx',
    all = false,
    language = 'zh',
    url,
    sharedCSS = '',
  },
  doc = globalThis.document,
) {
  const win = doc.defaultView || globalThis,
    key = '__fastTableConfirmation';
  if (action !== 'begin') return win[key]?.control(action, token) || { cancelled: true };
  win[key]?.control('cancel');
  if (doc.location.href !== url) throw Error('table page changed');
  const en = !language.startsWith('zh'),
    t = (zh, english) => (en ? english : zh);
  const resolve = (path) => {
    let root = doc;
    const parts = path.split(/ (>>>|::frame::) /);
    for (let i = 0; i < parts.length; i += 2) {
      const node = root?.querySelector(parts[i]);
      if (i === parts.length - 1) return node;
      try {
        root = parts[i + 1] === '>>>' ? node?.shadowRoot : node?.contentDocument;
      } catch {
        return null;
      }
    }
    return null;
  };
  // 中文注释：表头和行内容由后台复用采集器校验，避免原始 textContent 与可见文字、无障碍名称不一致。
  const candidates = tables
    .map((table) => ({
      ...table,
      target: resolve(table.dom_path),
      visual: resolve(table.visual_path || table.dom_path),
    }))
    .filter((table) => table.target && table.visual);
  if (!candidates.length) throw Error('table target missing');
  if (candidates.length !== tables.length) throw Error('table candidates changed');
  let current = Math.max(
      0,
      candidates.findIndex((row) => row.id === tables[index]?.id),
    ),
    frame,
    closed = false;
  const host = doc.createElement('div');
  host.setAttribute('data-fast-automation-overlay', 'table-confirmation');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'closed' }),
    style = doc.createElement('style');
  style.textContent =
    sharedCSS +
    ':host{color-scheme:light dark;font:13px/1.5 system-ui}.frame{position:fixed;border:2px solid #638bff;border-radius:6px;overflow:hidden;pointer-events:none;background:#638bff0d}.beam{position:absolute;inset:0;background:linear-gradient(transparent,#638bff44,transparent);height:50%;animation:scan 2s linear infinite}.cell{position:fixed;outline:1px solid #638bff44;background:#638bff15;animation:light 2s ease-in-out infinite}.card{position:fixed;pointer-events:auto;display:flex;align-items:center;gap:8px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:var(--r);padding:8px 12px;width:min(720px,calc(100vw - 16px));max-height:45vh;overflow:auto;box-shadow:0 5px 24px #0002}button{flex:none}p{margin:0;flex:1;font-size:12px}strong{font-size:12px}@keyframes scan{from{transform:translateY(-100%)}to{transform:translateY(200%)}}@keyframes light{50%{background:#638bff40}}@media(prefers-reduced-motion:reduce){.beam,.cell{animation:none}}';
  const outline = doc.createElement('div');
  outline.className = 'frame';
  const beam = doc.createElement('div');
  beam.className = 'beam';
  outline.append(beam);
  const marks = doc.createElement('div'),
    card = doc.createElement('section');
  card.className = 'card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', t('确认提取页面数据', 'Confirm page data extraction'));
  shadow.append(style, outline, marks, card);
  doc.documentElement.append(host);
  const describe = () => {
    const row = candidates[current];
    return {
      token,
      candidate_count: candidates.length,
      id: row.id,
      name: row.name,
      headers: row.headers,
      rows: row.rows.length,
      pages: row.pagination.totalPages,
      format,
      all,
      url,
    };
  };
  const send = (kind) => {
    if (kind === 'cancel' || kind === 'removed') cleanup();
    return chrome.runtime
      .sendMessage({ type: 'copilot.table_confirmation', kind, token })
      .then(async (response) => {
        if (response?.error) throw Error(response.error);
        if (response?.result?.clipboard)
          await win.navigator.clipboard.writeText(response.result.clipboard);
      })
      .catch(() => {
        chrome.runtime.sendMessage({ type: 'copilot.table_confirmation_error' }).catch(() => {});
        if (!closed)
          card.textContent = t('操作未完成，请回看板重试', 'Action failed. Retry from the board.');
      });
  };
  function draw() {
    card.replaceChildren();
    const row = describe(),
      info = doc.createElement('p');
    info.textContent = t(
      `保存这张表？${row.headers.length} 列 · ${row.rows} 行 · ${row.pages || '?'} 页`,
      `Save this table? ${row.headers.length} columns · ${row.rows} rows · ${row.pages || '?'} pages`,
    );
    card.append(info);
    for (const [label, kind] of [
      ...(candidates.length > 1 ? [[t('换一张', 'Switch'), 'switch']] : []),
      [t('取消', 'Cancel'), 'cancel'],
      [
        t(
          format === 'clipboard' ? '复制' : all ? '保存全部' : '保存',
          format === 'clipboard' ? 'Copy' : all ? 'Save all' : 'Save',
        ),
        'confirm',
      ],
    ]) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = kind === 'confirm' ? 'primary' : 'ghost';
      b.textContent = label;
      b.onclick = () => void send(kind);
      card.append(b);
    }
    const visual = candidates[current].visual,
      box = visual.getBoundingClientRect();
    if (
      box.bottom <= 0 ||
      box.top >= win.innerHeight ||
      box.right <= 0 ||
      box.left >= win.innerWidth
    )
      visual.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
  const same = () => {
    const row = candidates[current];
    return (
      row.target.isConnected &&
      resolve(row.dom_path) === row.target &&
      row.visual.isConnected &&
      resolve(row.visual_path || row.dom_path) === row.visual &&
      doc.location.href === url
    );
  };
  function cleanup() {
    if (closed) return;
    closed = true;
    win.cancelAnimationFrame(frame);
    doc.removeEventListener('keydown', escape);
    win.removeEventListener('pagehide', gone);
    host.remove();
    delete win[key];
  }
  function control(kind, value) {
    if (value && value !== token) throw Error('stale confirmation');
    if (kind === 'cancel') {
      cleanup();
      return { cancelled: true };
    }
    if (!same()) {
      cleanup();
      throw Error('table removed');
    }
    if (kind === 'switch') {
      current = (current + 1) % candidates.length;
      draw();
      return describe();
    }
    if (kind === 'confirm') {
      const result = describe();
      cleanup();
      return result;
    }
    return describe();
  }
  function escape(event) {
    if (event.key === 'Escape') void send('cancel');
  }
  function gone() {
    void send('cancel');
    cleanup();
  }
  function tick() {
    if (!same()) {
      void send('removed');
      cleanup();
      return;
    }
    const row = candidates[current],
      target = row.visual,
      offset = { left: 0, top: 0 };
    for (
      let view = target.ownerDocument.defaultView;
      view?.frameElement;
      view = view.frameElement.ownerDocument.defaultView
    ) {
      const box = view.frameElement.getBoundingClientRect();
      offset.left += box.left;
      offset.top += box.top;
    }
    const box = target.getBoundingClientRect(),
      rect = {
        left: box.left + offset.left,
        top: box.top + offset.top,
        width: box.width,
        height: box.height,
        bottom: box.bottom + offset.top,
      };
    outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    card.style.left =
      Math.max(8, Math.min(rect.left, win.innerWidth - Math.min(720, win.innerWidth - 16) - 8)) +
      'px';
    card.style.top =
      Math.max(
        8,
        Math.min(rect.bottom + 8, win.innerHeight - card.getBoundingClientRect().height - 8),
      ) + 'px';
    const rows =
      target === row.target ? [...target.querySelectorAll('tr,[role=row]')].slice(0, 20) : [];
    while (marks.children.length > rows.length) marks.lastElementChild.remove();
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect(),
        mark = marks.children[i] || doc.createElement('div');
      mark.className = 'cell';
      mark.style.cssText = `left:${r.left + offset.left}px;top:${r.top + offset.top}px;width:${r.width}px;height:${r.height}px;animation-delay:${i * 90}ms`;
      marks.append(mark);
    });
    frame = win.requestAnimationFrame(tick);
  }
  win[key] = { control };
  doc.addEventListener('keydown', escape);
  win.addEventListener('pagehide', gone, { once: true });
  draw();
  tick();
  return describe();
}
