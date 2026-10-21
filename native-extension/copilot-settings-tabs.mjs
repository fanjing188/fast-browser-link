const groups = [
  ['general', '通用', 'General', ['界面']],
  ['execution', '模型与执行', 'Models & execution', ['执行模式', '协作 Agent']],
  ['export', '表格与导出', 'Tables & export', ['表格与导出']],
  ['privacy', '记忆与隐私', 'Memory & privacy', ['记忆']],
  ['advanced', '插件与高级', 'Plugins & advanced', ['功能插件', '本机能力', '高级']],
  ['about', '关于', 'About', ['关于']],
];

// 中文注释：停放非当前类别的原控件，保留事件与草稿；只有当前类别进入页面 DOM。
export class SettingsTabs {
  constructor(doc) {
    this.doc = doc;
    this.parked = doc.createElement('div');
    this.form = doc.getElementById('copilot-settings-form');
    this.panel = doc.getElementById('settings-category');
    this.nav = doc.getElementById('settings-tabs');
    this.menuToggle = doc.getElementById('settings-menu-toggle');
    this.menuToggle.onclick = () => {
      const expanded = this.menuToggle.getAttribute('aria-expanded') !== 'true';
      this.menuToggle.setAttribute('aria-expanded', String(expanded));
      this.nav.parentElement.dataset.expanded = String(expanded);
      this.localize();
      if (!expanded)
        this.nav
          .querySelector('[aria-selected=true]')
          ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    this.sections = new Map();
    this.scroll = new Map();
    const sections = [...this.form.children].filter((el) =>
      el.classList.contains('settings-group'),
    );
    for (const [id, zh, en, titles] of groups) {
      const nodes = sections.filter((el) =>
        titles.includes(el.querySelector('legend,summary,h3')?.textContent.trim()),
      );
      this.sections.set(id, nodes);
      this.parked.append(...nodes);
      const tab = doc.createElement('button');
      tab.type = 'button';
      tab.id = 'settings-tab-' + id;
      tab.dataset.settingsTab = id;
      tab.dataset.zh = zh;
      tab.dataset.en = en;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'settings-category');
      tab.onclick = () => this.select(id);
      this.nav.append(tab);
    }
    this.nav.onkeydown = (event) => {
      const tabs = [...this.nav.children],
        index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      this.select(tabs[next].dataset.settingsTab);
      tabs[next].focus();
      tabs[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    this.document = this.scope();
    this.select('general');
  }
  scope() {
    const doc = this.doc,
      parked = this.parked;
    const scope = {
      getElementById: (id) =>
        doc.getElementById(id) ||
        [...parked.querySelectorAll('[id]')].find((el) => el.id === id) ||
        null,
      contains: (node) => doc.contains(node) || parked.contains(node),
      querySelector: (selector) => doc.querySelector(selector) || parked.querySelector(selector),
      querySelectorAll: (selector) => [
        ...doc.querySelectorAll(selector),
        ...parked.querySelectorAll(selector),
      ],
      get activeElement() {
        return doc.activeElement;
      },
      get title() {
        return doc.title;
      },
      set title(value) {
        doc.title = value;
      },
      defaultView: doc.defaultView,
      documentElement: doc.documentElement,
      body: doc.body,
    };
    for (const key of [
      'createElement',
      'createElementNS',
      'createTextNode',
      'createDocumentFragment',
      'createTreeWalker',
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
    ])
      scope[key] = doc[key].bind(doc);
    return scope;
  }
  select(id) {
    if (!this.sections.has(id)) return;
    if (this.current) this.scroll.set(this.current, this.panel.scrollTop);
    this.parked.append(...this.panel.children);
    this.panel.replaceChildren(...this.sections.get(id));
    this.current = id;
    this.panel.setAttribute('aria-labelledby', 'settings-tab-' + id);
    this.panel.scrollTop = this.scroll.get(id) || 0;
    this.panel.getAnimations?.().forEach((animation) => animation.cancel());
    if (!this.doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      this.panel.animate?.(
        [
          { opacity: 0.65, transform: 'translateY(3px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 150, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    for (const tab of this.nav.children) {
      const selected = tab.dataset.settingsTab === id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.localize();
  }
  reveal(field) {
    const match = [...this.sections].find(([, nodes]) =>
      nodes.some((node) => node.contains(field)),
    );
    if (match) this.select(match[0]);
    field.closest('details')?.setAttribute('open', '');
  }
  localize() {
    const en = this.doc.documentElement.lang.startsWith('en');
    for (const tab of this.nav.children) tab.textContent = en ? tab.dataset.en : tab.dataset.zh;
    const expanded = this.menuToggle.getAttribute('aria-expanded') === 'true';
    this.menuToggle.textContent = expanded
      ? en
        ? 'Collapse menu'
        : '收起菜单'
      : en
        ? 'Expand all menus'
        : '展开所有菜单';
    this.document
      ?.getElementById('settings-save')
      ?.setAttribute('aria-label', en ? 'Save all changes' : '保存全部更改');
  }
}
