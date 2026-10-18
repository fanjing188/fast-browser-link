import { statusNode } from './ui-design.mjs';
import { BRAND_CSS } from './brand.mjs';
import { selectionTasks } from './copilot-selection.mjs';
import { redactPageText, privateAccountNode } from '../page-semantics/redact.mjs';
const controls =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-fast-automation-overlay],script,style';
const normalized = (value) =>
  String(value).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const objectId = (obj) => obj.type + '\0' + obj.value;
const labels = {
  go: '建站',
  test: '测一页',
  skip: '不做',
  建站: '建站',
  测一页: '测一页',
  不做: '不做',
};
function visible(node) {
  if (
    privateAccountNode(node) ||
    node.closest(controls) ||
    node.closest('[hidden],[aria-hidden=true]') ||
    node.closest('form,[role=dialog]')?.querySelector('input[type=password]')
  )
    return false;
  for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
    const style = parent.ownerDocument.defaultView.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return node.getClientRects().length > 0;
}
function readText(node) {
  const doc = node.ownerDocument,
    walker = doc.createTreeWalker(node, 4);
  let result = '',
    text;
  while ((text = walker.nextNode()))
    if (visible(text.parentElement)) result += text.nodeValue + ' ';
  return result.trim();
}
export function recognizeObjects(doc, { profiles = [], limit = 300 } = {}) {
  const found = [],
    seen = new Set(),
    add = (type, value, node) => {
      value = redactPageText(value || '');
      if (!value || value.length > 2000 || !visible(node)) return;
      if (type === 'domain' || type === 'url') {
        try {
          const url = new URL(value.includes('://') ? value : 'https://' + value);
          if (
            !/^https?:$/.test(url.protocol) ||
            !url.hostname.includes('.') ||
            url.username ||
            url.password
          )
            return;
          value = type === 'domain' ? url.hostname : url.href;
        } catch {
          return;
        }
      }
      if (
        !seen.has(node) &&
        !found.some(
          (item) =>
            item.type === type &&
            normalized(item.value) === normalized(value) &&
            (item.node.contains(node) || node.contains(item.node)),
        )
      ) {
        seen.add(node);
        found.push({ type, value, node });
      }
    };
  const configured = profiles
    .filter((profile) => profile.hosts?.includes(doc.location.hostname))
    .flatMap((profile) => profile.pages || []);
  const roots = new Set(doc.querySelectorAll('table,[role=grid],[role=table],[role=treegrid]'));
  for (const profile of configured)
    for (const selector of profile.table_selectors || [])
      try {
        for (const node of doc.querySelectorAll(selector)) roots.add(node);
      } catch {}
  for (const table of [...roots].slice(0, 100)) {
    const rows = [...table.querySelectorAll('tr,[role=row],[data-ui-name*="Row"]')].filter(
      (row) =>
        !table.matches('table,[role=grid],[role=table],[role=treegrid]') ||
        row.closest('table,[role=grid],[role=table],[role=treegrid]') === table,
    );
    const cells = (row) => {
      const named = [
        ...row.querySelectorAll('th,td,[role=columnheader],[role=cell],[role=gridcell]'),
      ].filter((cell) => cell.closest('tr,[role=row],[data-ui-name*="Row"]') === row);
      return named.length ? named : [...row.children];
    };
    const header = rows.find(
      (row) =>
        row.querySelector('th,[role=columnheader]') ||
        /head/i.test((row.getAttribute('data-ui-name') || '') + ' ' + row.className),
    );
    if (!header) continue;
    const headers = cells(header).map((node) => normalized(readText(node)));
    const aliases = {
      keyword: ['keyword', 'keywords', '关键词', '搜索词', 'search term'],
      domain: ['domain', '域名'],
      url: ['url', '页面地址'],
    };
    for (const profile of configured)
      for (const kind of Object.keys(aliases))
        aliases[kind].push(...(profile.columns?.[kind] || []).map(normalized));
    headers.forEach((name, index) => {
      const kind = Object.keys(aliases).find((type) => aliases[type].includes(name));
      if (kind)
        for (const row of rows) {
          if (row === header) continue;
          const node = cells(row)[index];
          if (node) add(kind, readText(node), node);
        }
    });
  }
  // 中文注释：仅使用搜索语义/公开链接结构，不在页面脚本中调用查询或读取输入值。
  const search = doc.querySelector('[role=search]') || doc.querySelector('form[action*="search"]');
  if (search) {
    const query = new URL(doc.location.href).searchParams.get('q');
    const heading = doc.querySelector('main h1,[role=main] h1');
    if (query) {
      const rect = heading?.getBoundingClientRect();
      add(
        'keyword',
        query,
        heading && visible(heading) && rect.bottom > 0 && rect.top < doc.defaultView.innerHeight
          ? heading
          : search,
      );
    }
  }
  for (const link of doc.querySelectorAll('main a[href],[role=main] a[href]')) {
    if (link.querySelector('h3') || link.closest('h3'))
      add('domain', link.href, link.querySelector('h3') || link.closest('h3'));
    else {
      try {
        const query = new URL(link.href).searchParams.get('q');
        if (query && readText(link).trim() && query.length < 300) add('keyword', query, link);
      } catch {}
    }
  }
  for (const node of doc.querySelectorAll('[data-question],[role=button][aria-expanded]')) {
    if (
      /[?？]$|^(?:how|what|why|who|when|where|can|is|are|do|does|should)\b|^(?:如何|什么|怎么|为什么|是否|哪里)/i.test(
        readText(node).trim(),
      )
    )
      add('keyword', readText(node), node);
  }
  const viewport = (item) => {
    const rect = item.node.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.top < doc.defaultView.innerHeight &&
      rect.right > 0 &&
      rect.left < doc.defaultView.innerWidth
    );
  };
  return (found.length > limit ? found.filter(viewport) : found).slice(0, limit);
}
export function annotationLabel(info = {}, density = 'compact', language = 'zh') {
  const en = !language.startsWith('zh'),
    tier = labels[info.tier],
    parts = [];
  if (tier)
    parts.push(en ? { go: 'Build', test: 'Test one page', skip: 'Skip' }[info.tier] || tier : tier);
  if (info.pool) parts.push(en ? 'In pool' : '已在词池');
  if (info.weak === true || info.weak === 1 || info.small_site === true || info.small_site === 1)
    parts.push(en ? 'Small site' : '小站');
  if (info.analyzed) parts.push(en ? 'Analyzed' : '竞品已分析');
  if (density === 'full') {
    if (info.vol != null) parts.push((en ? 'Vol ' : '量 ') + info.vol);
    if (info.kd != null) parts.push('KD ' + info.kd);
    if (info.authority != null) parts.push((en ? 'Authority ' : '权重 ') + info.authority);
    if (Number.isFinite(info.checked_at))
      parts.push(
        (en ? 'Checked ' : '查过 · ') + new Date(info.checked_at * 1000).toISOString().slice(0, 10),
      );
  }
  if (!parts.length && info.checked_at) parts.push(en ? 'Checked' : '查过');
  return parts.join(' · ') || '＋';
}
export class AnnotationLayer {
  constructor(
    doc,
    {
      request,
      profiles = [],
      enabled = true,
      density = 'compact',
      language = 'zh',
      owned = false,
    } = {},
  ) {
    this.doc = doc;
    this.win = doc.defaultView;
    this.request = request;
    this.profiles = profiles;
    this.enabled = enabled && !owned;
    this.density = density;
    this.language = language;
    this.entries = new Map();
    this.data = new Map();
    this.generation = 0;
    this.nodeIds = new WeakMap();
    this.nextId = 0;
    this.owned = owned;
    if (this.owned) return;
    this.host = doc.createElement('div');
    this.host.dataset.fastAutomationOverlay = 'copilot-annotations';
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent =
      BRAND_CSS +
      `:host{position:fixed;inset:0;z-index:2147483645;pointer-events:none;font:11px/1.4 var(--ui);color:var(--brand-ink)}button{font:inherit;color:inherit;background:var(--brand-surface);border:1px solid var(--brand-line);border-radius:5px;padding:1px 5px;cursor:pointer;pointer-events:auto;max-width:230px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}button:hover{background:var(--brand-soft)}button:focus-visible{outline:2px solid var(--brand-primary);outline-offset:2px}.mark{position:fixed;min-width:22px;min-height:22px}.mark.empty{opacity:0;pointer-events:none}.mark.empty.hovered,.mark.empty:focus-visible{opacity:1;pointer-events:auto}.tasks{position:fixed;pointer-events:auto;width:230px;background:var(--brand-surface);border:1px solid var(--brand-line);padding:8px;border-radius:8px}.tasks button{display:block;width:100%;text-align:start;min-height:30px;margin-block:3px}.status{display:block;font-size:11px;white-space:normal} [hidden]{display:none!important}`;
    this.root.append(style);
    doc.documentElement.append(this.host);
    this.abort = new this.win.AbortController();
    const options = { signal: this.abort.signal };
    this.win.addEventListener(
      'scroll',
      () => {
        this.closeMenu();
        this.schedule();
      },
      { ...options, capture: true, passive: true },
    );
    this.win.addEventListener('resize', () => this.schedule(), options);
    doc.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') this.closeMenu();
      },
      options,
    );
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.composedPath().includes(this.host)) this.closeMenu();
      },
      options,
    );
    doc.addEventListener(
      'pointerover',
      (event) => {
        if (event.composedPath().includes(this.host)) return;
        this.hovered =
          event.target.closest?.('tr,[role=row],[data-ui-name*="Row"]') || event.target;
        this.updateHover();
      },
      options,
    );
    doc.addEventListener(
      'pointerout',
      (event) => {
        if (event.composedPath().includes(this.host) || event.relatedTarget === this.host) return;
        this.hovered =
          event.relatedTarget?.closest?.('tr,[role=row],[data-ui-name*="Row"]') ||
          event.relatedTarget;
        this.updateHover();
      },
      options,
    );
    this.observer = new this.win.MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !record.target.closest?.('[data-fast-automation-overlay]') &&
            !(
              record.type === 'childList' &&
              record.addedNodes.length + record.removedNodes.length > 0 &&
              [...record.addedNodes, ...record.removedNodes].every((node) => node === this.host)
            ),
        )
      )
        this.schedule();
    });
    this.observer.observe(doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-rowindex', 'hidden'],
    });
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 80);
  }
  configure({ enabled = this.enabled, density = this.density, profiles = this.profiles } = {}) {
    this.enabled = enabled && !this.owned;
    this.density = density;
    this.profiles = profiles;
    if (!this.enabled) {
      this.generation++;
      this.entries.clear();
      for (const node of this.root?.querySelectorAll('.mark,.tasks') || []) node.remove();
    } else this.schedule();
  }
  async refresh(force = false) {
    if (!this.enabled || !this.host?.isConnected) return;
    const objects = recognizeObjects(this.doc, { profiles: this.profiles });
    this.objects = objects;
    if (
      this.menuObject &&
      !objects.some(
        (item) =>
          item.node === this.menuObject.node && objectId(item) === objectId(this.menuObject),
      )
    )
      this.closeMenu();
    const current = new Set();
    for (const object of objects) {
      if (!this.nodeIds.has(object.node)) this.nodeIds.set(object.node, ++this.nextId);
      const key = this.nodeIds.get(object.node) + '|' + objectId(object);
      current.add(key);
      let badge = this.entries.get(key);
      if (!badge) {
        badge = this.doc.createElement('button');
        badge.className = 'mark';
        badge.type = 'button';
        badge.setAttribute('aria-label', '工作篮 · ' + object.value);
        badge.onclick = (event) => {
          if (event.isTrusted) void this.add(object, badge);
        };
        badge.onmouseenter = () => {
          clearTimeout(this.closeTimer);
          clearTimeout(this.menuTimer);
          this.menuTimer = setTimeout(() => this.openMenu(object, badge), 300);
        };
        badge.onmouseleave = () => {
          clearTimeout(this.menuTimer);
          this.closeMenuSoon();
        };
        badge.onfocus = () => this.openMenu(object, badge);
        this.root.append(badge);
        this.entries.set(key, badge);
      }
      const rect = object.node.getBoundingClientRect();
      badge.style.left =
        Math.min(Math.max(0, rect.right + 4), Math.max(0, this.win.innerWidth - 180)) + 'px';
      badge.style.top = Math.max(-30, rect.top) + 'px';
      badge.hidden = rect.bottom < 0 || rect.top > this.win.innerHeight;
      const info = this.data.get(objectId(object)) || {},
        label = annotationLabel(info, this.density, this.language);
      badge.replaceChildren();
      if (label !== '＋')
        badge.append(
          statusNode(
            this.doc,
            info.tier === 'test' ? 'waiting' : info.pool ? 'connected' : 'partial',
            { language: this.language, label, bare: true },
          ),
        );
      else badge.textContent = label;
      badge.title = object.value;
    }
    this.updateHover();
    for (const [key, badge] of this.entries)
      if (!current.has(key)) {
        badge.remove();
        this.entries.delete(key);
      }
    const unique = [
        ...new Map(
          objects.map((object) => [objectId(object), { type: object.type, value: object.value }]),
        ).values(),
      ],
      signature = JSON.stringify(unique);
    if (!force && signature === this.signature) return;
    this.signature = signature;
    if (new TextEncoder().encode(signature).length > 100000) {
      this.signature = null;
      return;
    }
    const generation = ++this.generation;
    try {
      const response = await this.request('lookup', { objects: unique });
      if (generation !== this.generation || !this.enabled) return;
      for (const item of response.items || []) this.data.set(objectId(item), item.info || {});
      this.signature = signature;
      await this.refresh();
    } catch {
      if (generation === this.generation) this.signature = null;
    }
  }
  current(object) {
    return recognizeObjects(this.doc, { profiles: this.profiles }).some(
      (item) => item.node === object.node && objectId(item) === objectId(object),
    );
  }
  updateHover() {
    for (const object of this.objects || []) {
      const key = this.nodeIds.get(object.node) + '|' + objectId(object),
        badge = this.entries.get(key);
      if (!badge) continue;
      const empty =
        annotationLabel(this.data.get(objectId(object)) || {}, this.density, this.language) ===
        '＋';
      badge.classList.toggle('empty', empty);
      const row = object.node.closest('tr,[role=row],[data-ui-name*="Row"]') || object.node;
      badge.classList.toggle(
        'hovered',
        (!!this.hovered && (row === this.hovered || row.contains(this.hovered))) ||
          this.menuObject?.node === object.node,
      );
    }
  }
  closeMenu() {
    clearTimeout(this.closeTimer);
    clearTimeout(this.menuTimer);
    this.menu?.remove();
    this.menu = null;
    this.menuObject = null;
    this.updateHover();
  }
  closeMenuSoon() {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.closeMenu(), 400);
  }
  async add(object, badge) {
    badge.disabled = true;
    try {
      if (!this.current(object)) throw Error('object changed');
      await this.request('basket_add', {
        items: [{ type: object.type, value: object.value, source: this.doc.location.href }],
      });
      badge.textContent = this.language.startsWith('zh') ? '已加入' : 'Added';
    } catch {
      badge.textContent = this.language.startsWith('zh') ? '重试' : 'Retry';
    } finally {
      badge.disabled = false;
    }
  }
  openMenu(object, badge) {
    if (!badge.isConnected || !this.enabled) return;
    this.closeMenu();
    const menu = this.doc.createElement('section');
    menu.className = 'tasks';
    menu.onmouseenter = () => clearTimeout(this.closeTimer);
    menu.onmouseleave = () => this.closeMenuSoon();
    menu.setAttribute(
      'aria-label',
      this.language.startsWith('zh') ? '对象快捷任务' : 'Object tasks',
    );
    const rect = badge.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(rect.left, this.win.innerWidth - 245)) + 'px';
    menu.style.top = Math.max(0, Math.min(rect.bottom + 4, this.win.innerHeight - 300)) + 'px';
    const title = this.doc.createElement('strong');
    title.textContent = object.value;
    menu.append(title);
    const add = this.doc.createElement('button');
    add.textContent = this.language.startsWith('zh') ? '加入工作篮' : 'Add to basket';
    add.onclick = (event) => {
      if (event.isTrusted) void this.add(object, badge);
    };
    menu.append(add);
    for (const task of selectionTasks(object.value, {
      url: this.doc.location.href,
      language: this.language,
    }).tasks.filter((task) => !['copy', 'basket_add'].includes(task.action))) {
      const button = this.doc.createElement('button');
      button.textContent = task.label;
      button.onclick = async (event) => {
        if (!event.isTrusted) return;
        button.disabled = true;
        try {
          if (!this.current(object)) throw Error('object changed');
          const result = await this.request('quick_task', {
            action: task.action,
            params: task.params,
          });
          if (result.secondary_required) {
            const confirm = this.doc.createElement('button');
            confirm.textContent = this.language.startsWith('zh')
              ? '对外动作 · 再次确认'
              : 'External action · confirm again';
            confirm.onclick = async (event) => {
              if (!event.isTrusted) return;
              confirm.disabled = true;
              try {
                await this.request('confirm_task', { id: result.id, confirmation: result.token });
                this.closeMenu();
              } finally {
                confirm.disabled = false;
              }
            };
            menu.append(confirm);
          } else this.closeMenu();
        } catch {
          button.textContent = this.language.startsWith('zh')
            ? '未执行，请重试'
            : 'Not executed. Retry.';
        } finally {
          button.disabled = false;
        }
      };
      menu.append(button);
    }
    this.menu = menu;
    this.menuObject = object;
    this.root.append(menu);
    this.updateHover();
  }
  destroy() {
    clearTimeout(this.timer);
    this.closeMenu();
    this.generation++;
    this.abort?.abort();
    this.observer?.disconnect();
    this.host?.remove();
    this.entries.clear();
  }
}
