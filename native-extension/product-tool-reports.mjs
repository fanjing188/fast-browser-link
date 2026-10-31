// 中文注释：只读状态标记；不读取账号文本、输入值或隐藏字段。
export function inspectToolPage(policy = {}, doc = globalThis.document) {
  const visible = (node) => {
    for (let el = node; el; el = el.parentElement) {
      const css = doc.defaultView.getComputedStyle(el);
      if (
        el.hidden ||
        el.getAttribute('aria-hidden') === 'true' ||
        css.display === 'none' ||
        css.visibility === 'hidden' ||
        css.opacity === '0'
      )
        return false;
    }
    return true;
  };
  const content = (node) => {
    const walker = doc.createTreeWalker(node, 4);
    let value = '',
      item;
    while ((item = walker.nextNode()))
      if (
        item.parentElement &&
        visible(item.parentElement) &&
        !item.parentElement.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )
      )
        value += ' ' + item.textContent;
    return value;
  };
  const text = [...doc.querySelectorAll('h1,h2,h3,[role=alert],iframe[title]')]
    .filter(visible)
    .map((node) => (node.localName === 'iframe' ? node.title : content(node)))
    .join(' ')
    .slice(0, 10000);
  for (const [kind, patterns] of Object.entries(policy.stop_text || {}))
    if (patterns.some((pattern) => new RegExp(pattern, 'i').test(text)))
      return { ready: false, blocked: kind };
  if ([...doc.querySelectorAll('input[type=password]')].some(visible))
    return { ready: false, blocked: 'login' };
  if (/captcha|verify you are human|unusual traffic|验证码|人机验证/i.test(text))
    return { ready: false, blocked: 'captcha' };
  if (/quota exceeded|daily limit|额度用尽|配额耗尽/i.test(text))
    return { ready: false, blocked: 'quota' };
  if (/rate limit|too many requests|限流|请求过于频繁/i.test(text))
    return { ready: false, blocked: 'rate_limit' };
  if (/sign in to continue|session expired|登录过期|请先登录/i.test(text))
    return { ready: false, blocked: 'login' };
  const ready = (policy.ready_selectors || []).some((selector) =>
    [...doc.querySelectorAll(selector)].some(visible),
  );
  return { ready, blocked: null };
}
