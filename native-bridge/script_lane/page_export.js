function serializePage({ resources = {}, maxChars = 200000 }) {
  // 中文注释：克隆根没有父节点，remove 无法删除；只接受规范HTML根，异常活页明确拒绝导出。
  if (
    document.documentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    document.documentElement.localName !== 'html'
  )
    return { unavailable: true };
  // 中文注释：仅复制到无浏览上下文的文档；不改活页、不读取控件的当前 value、不执行克隆脚本。
  const inert = document.implementation.createHTMLDocument('');
  const root = inert.importNode(document.documentElement, true);
  const coverage = {
    frames: document.querySelectorAll('iframe,frame').length,
    openShadowRoots: Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot).length,
    closedShadowRoots: 'not_inspected',
    canvas: document.querySelectorAll('canvas').length,
    cssUnresolved: 0,
    cssDisabled: 0,
    nonHtmlElements: 0,
  };
  const scripts = [];
  const base = document.baseURI;
  function local(value) {
    try {
      const url = new URL(value, base);
      if (url.hash && url.href.split('#')[0] === base.split('#')[0]) return url.hash;
      const path = resources[url.href] || resources[url.href.split('#')[0]];
      if (typeof path === 'string' && /^(assets|preview)\/[a-zA-Z0-9._-]+$/.test(path))
        return path + url.hash;
    } catch {
      /* 中文注释：无法解析的引用不参与离线加载。 */
    }
    return null;
  }
  function css(value) {
    // 中文注释：不猜 CSS 转义/注释语法；禁用不支持的文本并披露缺口，CSP 再阻断漏项。
    if (/\\|\/\*|</.test(value)) {
      coverage.cssDisabled++;
      return '';
    }
    let output = value.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"()]*))\s*\)/gi,
      (_all, a, b, c) => {
        const path = local(a ?? b ?? c);
        if (!path) coverage.cssUnresolved++;
        return `url("${path || ''}")`;
      },
    );
    output = output.replace(/@import\s+(["'])([^"']*)\1/gi, (_all, _quote, url) => {
      const path = local(url);
      if (!path) coverage.cssUnresolved++;
      return `@import "${path || ''}"`;
    });
    // 中文注释：只保留已重写的引用和已知无资源函数；未知函数（含 image-set 裸字符串）整段禁用。
    const syntax = output
      .replace(/@import\s+(?:"[^"]*"|url\("[^"]*"\))/gi, '')
      .replace(/url\("[^"]*"\)/gi, '');
    const safeFunctions = new Set([
      'rgb',
      'rgba',
      'hsl',
      'hsla',
      'hwb',
      'lab',
      'lch',
      'oklab',
      'oklch',
      'color',
      'color-mix',
      'linear-gradient',
      'radial-gradient',
      'conic-gradient',
      'repeating-linear-gradient',
      'repeating-radial-gradient',
      'repeating-conic-gradient',
      'calc',
      'min',
      'max',
      'clamp',
      'var',
      'env',
      'not',
      'is',
      'where',
      'has',
      'nth-child',
      'nth-last-child',
      'nth-of-type',
      'nth-last-of-type',
      'translate',
      'translatex',
      'translatey',
      'translatez',
      'translate3d',
      'scale',
      'scalex',
      'scaley',
      'scalez',
      'scale3d',
      'rotate',
      'rotatex',
      'rotatey',
      'rotatez',
      'rotate3d',
      'skew',
      'skewx',
      'skewy',
      'matrix',
      'matrix3d',
      'perspective',
      'cubic-bezier',
      'steps',
    ]);
    if (
      /@import\b/i.test(syntax) ||
      Array.from(syntax.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/gi)).some(
        (match) => !safeFunctions.has(match[1].toLowerCase()),
      )
    ) {
      coverage.cssDisabled++;
      return '';
    }
    return output;
  }
  function clean(scope) {
    // 中文注释：动态注释可以含结束符，outerHTML 不会转义；无可见内容，直接丢弃。
    const comments = inert.createTreeWalker(scope, 128);
    const discarded = [];
    while (comments.nextNode()) discarded.push(comments.currentNode);
    for (const comment of discarded) comment.remove();
    // 中文注释：精确移除自有宿主后再遍历子树，不能把私有通道内联脚本另存为源码。
    for (const node of scope.querySelectorAll(
      '[data-fast-automation-overlay],[data-fast-interaction-highlight],[data-fast-preveil]',
    ))
      node.remove();
    // 中文注释：只承诺 HTML light DOM；外来命名空间重解析会改变标签/属性语义，整节点禁用。
    for (const element of scope.querySelectorAll('*')) {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        coverage.nonHtmlElements++;
        element.remove();
      }
    }
    for (const element of [
      ...(scope.nodeType === 1 ? [scope] : []),
      ...scope.querySelectorAll('*'),
    ]) {
      // 中文注释：DOM API 可造出 HTML 解析器不会保留的大小写/命名空间属性，重解析前直接丢弃。
      for (const attr of Array.from(element.attributes)) {
        if (attr.namespaceURI || attr.name !== attr.name.toLowerCase())
          element.removeAttributeNode(attr);
      }
      const tag = element.localName.toLowerCase();
      if (tag === 'template') clean(element.content);
      if (tag === 'script') {
        if (!element.hasAttribute('src'))
          scripts.push({
            text: element.textContent || '',
            type: element.getAttribute('type') || '',
          });
        element.remove();
        continue;
      }
      if (
        [
          'iframe',
          'frame',
          'object',
          'embed',
          'base',
          'noscript',
          'xmp',
          'plaintext',
          'noembed',
          'noframes',
        ].includes(tag) ||
        (tag === 'meta' && (element.hasAttribute('http-equiv') || element.hasAttribute('charset')))
      ) {
        element.remove();
        continue;
      }
      if (
        element.hasAttribute('contenteditable') &&
        element.getAttribute('contenteditable').toLowerCase() !== 'false'
      )
        element.textContent = '';
      if (tag === 'textarea') element.textContent = '';
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        if (
          name.startsWith('on') ||
          [
            'value',
            'checked',
            'selected',
            'srcset',
            'imagesrcset',
            'srcdoc',
            'nonce',
            'integrity',
            'autofocus',
            'autoplay',
            'is',
            'ping',
            'manifest',
            'action',
            'formaction',
            'data',
            'codebase',
            'archive',
            'background',
            'poster',
            'xlink:href',
          ].includes(name)
        ) {
          element.removeAttribute(attr.name);
          continue;
        }
        if (name === 'style') {
          element.setAttribute('style', css(attr.value));
          continue;
        }
        if (name === 'href' || name === 'src') {
          const path = local(attr.value);
          if (path && (tag !== 'a' || path.startsWith('#'))) element.setAttribute(attr.name, path);
          else element.removeAttribute(attr.name);
        }
      }
      if (
        tag === 'link' &&
        !['stylesheet', 'icon'].includes(element.getAttribute('rel')?.toLowerCase())
      )
        element.remove();
      if (tag === 'style') element.textContent = css(element.textContent || '');
    }
  }
  clean(root);
  let head = root.querySelector('head');
  if (!head) {
    head = inert.createElement('head');
  }
  // 中文注释：活页可把head移进body；离线策略必须位于首个有效head，不能随畸形布局落入正文。
  root.prepend(head);
  const policy = inert.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute(
    'content',
    "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'",
  );
  // 中文注释：包正文统一 UTF-8 写出，不能沿用活页的编码声明。
  const charset = inert.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset, policy);
  // 中文注释：根属性可超过编码预扫描窗口；BOM在UTF-8字节起始固定编码，不依赖meta位置。
  const html = '\uFEFF<!DOCTYPE html>\n' + root.outerHTML;
  if (html.length + scripts.reduce((n, s) => n + s.text.length, 0) > maxChars)
    return { overBudget: true, coverage };
  return { html, scripts, coverage };
}
