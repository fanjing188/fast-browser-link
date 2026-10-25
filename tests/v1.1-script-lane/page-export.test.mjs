import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = new URL('../../native-bridge/script_lane/page_export.js', import.meta.url);
function serialize(document, options = {}) {
  const before = document.documentElement.outerHTML;
  const result = document.defaultView.eval(`(${fs.readFileSync(source, 'utf8')})`)(options);
  assert.equal(document.documentElement.outerHTML, before, 'live document must not change');
  return result;
}

test('non-HTML roots fail closed without exporting dangerous detached roots', () => {
  for (const tag of ['meta', 'iframe', 'svg']) {
    const dom = new JSDOM('<!doctype html><p>original</p>', { runScripts: 'outside-only' });
    const { document } = dom.window;
    const root =
      tag === 'svg'
        ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        : document.createElement(tag);
    root.setAttribute('http-equiv', 'refresh');
    root.setAttribute('content', '0;url=/outside');
    root.setAttribute('src', '/outside');
    document.replaceChild(root, document.documentElement);
    const result = serialize(document);
    assert.equal(result.unavailable, true, tag);
    assert.equal(result.html, undefined, tag);
  }
});

test('canonical first head retains effective CSP after live head moves into or after body', () => {
  for (const position of ['nested', 'after-body']) {
    const dom = new JSDOM(
      '<!doctype html><head><title>keep title</title></head><body><form><button>Send</button></form><p>keep body</p></body>',
      { runScripts: 'outside-only' },
    );
    const { document } = dom.window;
    if (position === 'nested') document.body.prepend(document.head);
    else document.documentElement.append(document.head);
    const result = serialize(document);
    const offline = new JSDOM(Buffer.from(result.html, 'utf8')).window.document;
    const policy = offline.querySelector('meta[http-equiv="Content-Security-Policy"]');
    assert.equal(policy?.parentElement, offline.head, position);
    assert.equal(offline.documentElement.firstElementChild, offline.head, position);
    assert.ok(policy.content.includes("form-action 'none'"));
    assert.equal(offline.title, 'keep title');
    assert.equal(offline.querySelector('p').textContent, 'keep body');
    assert.equal(offline.querySelector('button').textContent, 'Send');
  }
});

test('foreign namespace nodes cannot reparse into refresh directives', () => {
  const dom = new JSDOM('<!doctype html><p>keep HTML</p>', {
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const { document } = dom.window;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const meta = document.createElementNS(svg.namespaceURI, 'meta');
  meta.setAttribute('HTTP-EQUIV', 'refresh');
  meta.setAttribute('content', '0;url=https://example.invalid/');
  svg.append(meta);
  document.body.append(svg);
  const result = serialize(document);
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('meta[http-equiv="refresh"]'), null);
  assert.equal(offline.querySelector('svg'), null);
  assert.equal(offline.querySelector('p').textContent, 'keep HTML');
  assert.equal(result.coverage.nonHtmlElements, 2);
});

test('unsupported CSS resource syntax is disabled instead of relying on same-origin CSP', () => {
  const dom = new JSDOM('<!doctype html><head></head><body><div></div></body>', {
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const { document } = dom.window;
  const unsafe = [
    'background-image:image-set("/probe.png" 1x)',
    'background-image:-webkit-image-set("/probe.png" 1x)',
    'background-image:future-image("/probe.png")',
    'background-image:url("/probe.png" extra)',
  ];
  for (const declaration of unsafe) {
    const style = document.createElement('style');
    style.textContent = `div{${declaration}}`;
    document.head.append(style);
    const div = document.createElement('div');
    div.setAttribute('style', declaration);
    document.body.append(div);
  }
  const safe = document.createElement('style');
  safe.textContent =
    '@import "/theme.css";div{color:rgb(1,2,3);width:calc(100% - 1px);background:url("/mapped.png")}';
  document.head.append(safe);
  const result = serialize(document, {
    resources: {
      'https://example.test/mapped.png': 'assets/0001.img',
      'https://example.test/theme.css': 'preview/0000.css',
    },
  });
  const offline = new JSDOM(result.html, { url: 'https://preview.test/offline/index.html' }).window
    .document;
  assert.ok(!result.html.includes('/probe.png'));
  assert.equal(result.coverage.cssDisabled, unsafe.length * 2);
  assert.equal(
    offline.querySelectorAll('style')[unsafe.length].textContent,
    '@import "preview/0000.css";div{color:rgb(1,2,3);width:calc(100% - 1px);background:url("assets/0001.img")}',
  );
});

test('UTF-8 bytes reparse Chinese text without stale charset declarations', () => {
  const dom = new JSDOM(
    '<!doctype html><head><meta charset="gbk"><meta http-equiv="Content-Type" content="text/html;charset=big5"></head><body><p>中文内容</p></body>',
    { runScripts: 'outside-only' },
  );
  const result = serialize(dom.window.document);
  const offline = new JSDOM(Buffer.from(result.html, 'utf8'), { contentType: 'text/html' }).window
    .document;
  assert.equal(offline.characterSet, 'UTF-8');
  assert.equal(offline.querySelector('p').textContent, '中文内容');
  assert.equal(offline.querySelectorAll('meta[charset]').length, 1);
  assert.equal(offline.head.firstElementChild.getAttribute('charset'), 'utf-8');
});

test('UTF-8 is detected before a long root attribute exceeds the charset prescan', () => {
  const dom = new JSDOM('<!doctype html><p>中文内容</p>', { runScripts: 'outside-only' });
  dom.window.document.documentElement.setAttribute('data-state', 'x'.repeat(1100));
  const result = serialize(dom.window.document);
  const offline = new JSDOM(Buffer.from(result.html, 'utf8'), { contentType: 'text/html' }).window
    .document;
  assert.equal(offline.characterSet, 'UTF-8');
  assert.equal(offline.querySelector('p').textContent, '中文内容');
});

test('case-sensitive attributes created through DOM APIs cannot gain authority on reparse', () => {
  const dom = new JSDOM('<!doctype html><p>keep</p>', {
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const { document } = dom.window;
  for (const tag of ['meta', 'META', 'img']) {
    const element = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
    const attribute = document.createAttributeNS(null, tag === 'img' ? 'SRC' : 'HTTP-EQUIV');
    attribute.value = tag === 'img' ? '/outside-package.png' : 'refresh';
    element.setAttributeNode(attribute);
    element.setAttribute('content', '0;url=https://example.invalid/');
    document.body.append(element);
  }
  const result = serialize(document);
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('meta[http-equiv="refresh"]'), null);
  assert.equal(offline.querySelector('img').getAttribute('src'), null);
});

test('dynamic comments cannot introduce active markup when serialized HTML is reparsed', () => {
  const dom = new JSDOM('<!doctype html><p>keep</p><template></template>', {
    runScripts: 'outside-only',
  });
  const { document } = dom.window;
  const payload = '--><meta http-equiv=refresh content=0;url=https://example.invalid/><!--';
  document.body.append(document.createComment(payload));
  document.querySelector('template').content.append(document.createComment(payload));
  const result = serialize(document);
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('meta[http-equiv="refresh"]'), null);
  assert.equal(offline.querySelector('template').content.querySelector('meta'), null);
  assert.equal(offline.querySelector('p').textContent, 'keep');
});

test('dynamic raw-text nodes cannot generate scripts, forms, resource links or navigation on reparse', () => {
  const dom = new JSDOM('<!doctype html><p>keep</p><template></template>', {
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const { document } = dom.window;
  for (const tag of [
    'style',
    'xmp',
    'plaintext',
    'noscript',
    'noembed',
    'noframes',
    'textarea',
    'title',
  ]) {
    const element = document.createElement(tag);
    element.textContent = `</${tag}><meta http-equiv=refresh content=0;url=https://example.invalid/><script>alert(1)</script><form action=https://example.invalid/><img src=/outside-package.png>`;
    document.querySelector('template').content.append(element);
  }
  const result = serialize(document);
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('meta[http-equiv="refresh"],script,form,img'), null);
  assert.equal(
    offline.querySelector('template').content.querySelector('meta,script,form,img'),
    null,
  );
  assert.ok(result.coverage.cssDisabled > 0);
  assert.equal(offline.querySelector('p').textContent, 'keep');
});

test('root contenteditable drafts are omitted without modifying the live document', () => {
  for (const mode of ['', 'true', 'plaintext-only']) {
    const dom = new JSDOM(
      '<!doctype html><head><title>page</title></head><body>root-draft-secret</body>',
      { runScripts: 'outside-only' },
    );
    dom.window.document.documentElement.setAttribute('contenteditable', mode);
    const result = serialize(dom.window.document);
    // 中文注释：真实包以UTF-8字节加载，BOM由字节解析器消费，不能按JS字符串文本插入body。
    const offline = new JSDOM(Buffer.from(result.html, 'utf8')).window.document;
    assert.ok(!result.html.includes('root-draft-secret'));
    assert.equal(offline.head.firstElementChild.getAttribute('charset'), 'utf-8');
    assert.ok(offline.querySelector('meta[http-equiv="Content-Security-Policy"]'));
  }
});

test('mapped url imports remain usable as offline stylesheet references', () => {
  const dom = new JSDOM('<!doctype html><style>@import url("/theme.css");p{color:red}</style>', {
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const result = serialize(dom.window.document, {
    resources: { 'https://example.test/theme.css': 'preview/0000.css' },
  });
  const offline = new JSDOM(result.html, { url: 'https://preview.test/offline/index.html' }).window
    .document;
  assert.equal(
    offline.querySelector('style').textContent,
    '@import url("preview/0000.css");p{color:red}',
  );
  assert.equal(result.coverage.cssDisabled, 0);
});

test('offline forms retain visible controls without submission or external loading authority', () => {
  const dom = new JSDOM(
    '<!doctype html><form action="/submit" method="post"><input value="secret"><button formaction="/override">Send</button></form><img src="/outside.png"><a href="/outside" ping="/track">Go</a>',
    { url: 'https://example.test/page', runScripts: 'outside-only' },
  );
  const result = serialize(dom.window.document);
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('form').textContent, 'Send');
  assert.equal(offline.querySelector('[action],[formaction],[src],[href],[ping],[value]'), null);
  const policy = offline.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  for (const directive of [
    "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ])
    assert.ok(policy.includes(directive), directive);
});

test('self-contained serializer preserves rendered DOM, not input state or executable content', () => {
  assert.ok(fs.existsSync(source), 'fixed serializer must exist');
  const dom = new JSDOM(
    `<!doctype html><html><head><base href="https://elsewhere.test/"><meta http-equiv="refresh" content="0;url=https://example.test"><link rel="stylesheet" href="https://example.test/a.css"><script src="https://example.test/a.js"></script><script>window.embeddedState='sensitive source';</script></head><body><h1>server</h1><input value="default-secret" checked><textarea>default-text</textarea><select><option value="secret-option" selected>Label</option></select><div contenteditable="plaintext-only">draft-secret</div><button onclick="alert(1)">OK</button><a href="java&#x0A;script:alert(1)">bad</a><img src="https://example.test/a.png" srcset="https://example.test/a.png 2x"><iframe srcdoc="<script>alert(1)</script>" src="https://example.test/frame"></iframe><object data="https://example.test/object"></object><embed src="https://example.test/embed"><template><input value="template-secret"><script>alert(1)</script></template><div id="shadow"></div></body></html>`,
    { url: 'https://example.test/page', runScripts: 'outside-only' },
  );
  const { document } = dom.window;
  document.documentElement.setAttribute('onload', 'rootHandler()');
  document.documentElement.setAttribute('contenteditable', 'FALSE');
  const maliciousStyle = document.createElement('style');
  maliciousStyle.textContent =
    'x{--x:"</style><meta http-equiv=refresh content=0;url=https://example.invalid/>"}';
  document.head.append(maliciousStyle);
  const rawText = document.createElement('xmp');
  rawText.textContent = '</xmp><meta http-equiv=refresh content=0;url=https://example.invalid/>';
  document.body.append(rawText);
  document.querySelector('h1').textContent = 'rendered';
  document.querySelector('input').value = 'runtime-secret';
  document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML =
    '<b>not serialized</b>';
  const before = document.documentElement.outerHTML;
  const overlay = document.createElement('div');
  overlay.setAttribute('data-fast-automation-overlay', '');
  overlay.innerHTML =
    '<script>privateChannel="do not archive"</script><input value="overlay-task-secret">';
  document.body.append(overlay);
  const result = dom.window.eval(`(${fs.readFileSync(source, 'utf8')})`)({
    resources: {
      'https://example.test/a.css': 'preview/0000.css',
      'https://example.test/a.png': 'assets/0001.img',
    },
    maxChars: 200000,
  });
  const offline = new JSDOM(result.html).window.document;
  assert.equal(offline.querySelector('h1').textContent, 'rendered');
  assert.equal(offline.querySelector('img').getAttribute('src'), 'assets/0001.img');
  assert.equal(offline.querySelector('link').getAttribute('href'), 'preview/0000.css');
  for (const value of [
    'runtime-secret',
    'default-secret',
    'default-text',
    'draft-secret',
    'secret-option',
    'template-secret',
  ])
    assert.ok(!result.html.includes(value), value);
  assert.equal(
    offline.querySelectorAll(
      'script,iframe,object,embed,base,[onload],[onclick],[srcset],[checked],[selected],[value]',
    ).length,
    0,
  );
  assert.equal(offline.querySelector('a').getAttribute('href'), null);
  assert.equal(offline.querySelector('meta[http-equiv="refresh"]'), null);
  assert.ok(
    offline
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      .content.includes("script-src 'none'"),
  );
  assert.ok(
    offline
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      .content.includes("connect-src 'none'"),
  );
  assert.ok(result.scripts.some((s) => s.text.includes('sensitive source')));
  assert.equal(result.coverage.openShadowRoots, 1);
  assert.equal(result.coverage.frames, 1);
  assert.ok(!result.html.includes('overlay-task-secret'));
  assert.ok(!result.scripts.some((s) => s.text.includes('privateChannel')));
  overlay.remove();
  assert.equal(document.documentElement.outerHTML, before);
  assert.equal(document.querySelector('input').value, 'runtime-secret');
});
