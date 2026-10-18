// 中文注释：S1–S4（融合 Hermes 预览栏解析）真实浏览器验收，手动运行，不进入离线清单：
// node tests/parsing-port/real-s1-s4.mjs [--edge]
// 富文本页从 esm.sh 加载固定版本的 Tiptap / ProseMirror / Lexical，需要网络。
import assert from 'node:assert/strict';
import http from 'node:http';
import { openRealSession, openTask } from '../native-v2/real-session.mjs';

const page = (title, body, script = '') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:24px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>${body}${script}`;
const PAGES = {
  '/s1': page(
    'S1 可见性',
    `
  <button id="ghost" style="opacity:0">透明按钮</button>
  <button id="sr" class="sr">读屏按钮</button>
  <p class="sr">读屏说明文字</p>
  <label style="display:inline-block;padding:8px;border:1px solid #888"><input id="agree" type="checkbox" style="opacity:0;position:absolute;width:1px;height:1px">同意条款</label>
  <div style="height:40px"></div>
  <button id="under" onclick="window.__under=(window.__under||0)+1">被挡按钮</button>
  <div id="banner" style="position:fixed;left:0;right:0;top:0;height:240px;background:#222;color:#fff;z-index:99">Cookie 横幅<button id="accept" onclick="document.getElementById('banner').remove()">接受</button></div>`,
  ),
  '/s2': page(
    'S2 增量',
    Array.from({ length: 30 }, (_, i) => `<button id="b${i}">按钮${i}</button>`).join(''),
  ),
  '/s3': page(
    'S3 回读',
    `
  <button id="open" onclick="window.__open=(window.__open||0)+1;document.getElementById('result').innerHTML='<button>菜单项甲</button><button>菜单项乙</button>'">展开菜单</button>
  <a id="go" href="/s3b">去下一页</a>
  <section id="result"></section>`,
  ),
  '/s3b': page('S3 下一页', '<h1>下一页</h1><button>下一页按钮</button>'),
  '/editor': page(
    '富文本',
    `<div id="mount" style="border:1px solid #888;min-height:80px;padding:8px"></div>`,
    `<script type="module">
 const kind=new URL(location.href).searchParams.get('kind');
 window.__events={beforeinput:0,input:0};
 const count=el=>{el.addEventListener('beforeinput',()=>window.__events.beforeinput++);el.addEventListener('input',()=>window.__events.input++);};
 const mount=document.getElementById('mount');
 try{
 if(kind==='tiptap'){
  const {Editor}=await import('https://esm.sh/@tiptap/core@2.11.5');
  const {default:StarterKit}=await import('https://esm.sh/@tiptap/starter-kit@2.11.5');
  const editor=new Editor({element:mount,extensions:[StarterKit],content:'<p>旧内容一</p><p>旧内容二</p>',editorProps:{attributes:{'aria-label':'富文本编辑器'}}});
  window.__model=()=>editor.state.doc.textContent;count(editor.view.dom);
 }else if(kind==='prosemirror'){
  const {EditorState}=await import('https://esm.sh/prosemirror-state@1.4.3');
  const {EditorView}=await import('https://esm.sh/prosemirror-view@1.37.1?deps=prosemirror-state@1.4.3,prosemirror-model@1.24.1');
  const {schema}=await import('https://esm.sh/prosemirror-schema-basic@1.2.3?deps=prosemirror-model@1.24.1');
  const {DOMParser}=await import('https://esm.sh/prosemirror-model@1.24.1');
  const seed=document.createElement('div');seed.innerHTML='<p>旧内容一</p><p>旧内容二</p>';
  const view=new EditorView(mount,{state:EditorState.create({doc:DOMParser.fromSchema(schema).parse(seed)}),attributes:{'aria-label':'富文本编辑器'}});
  window.__model=()=>view.state.doc.textContent;count(view.dom);
 }else if(kind==='lexical'){
  const L=await import('https://esm.sh/lexical@0.23.1');
  const {registerRichText}=await import('https://esm.sh/@lexical/rich-text@0.23.1?deps=lexical@0.23.1');
  const root=document.createElement('div');root.contentEditable='true';root.setAttribute('role','textbox');root.setAttribute('aria-label','富文本编辑器');root.style.minHeight='60px';mount.append(root);
  const editor=L.createEditor({namespace:'t',onError:e=>{throw e;}});editor.setRootElement(root);registerRichText(editor);
  await new Promise(r=>editor.update(()=>{const r0=L.$getRoot();for(const t of ['旧内容一','旧内容二']){const p=L.$createParagraphNode();p.append(L.$createTextNode(t));r0.append(p);}},{onUpdate:r}));
  window.__model=()=>editor.getEditorState().read(()=>L.$getRoot().getTextContent());count(root);
 }
 window.__ready=true;
 }catch(e){window.__loadError=String(e);}
 </script>`,
  ),
};
const server = http.createServer((req, res) => {
  const body = PAGES[new URL(req.url, 'http://x').pathname];
  if (!body) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://www.bench.localhost:${server.address().port}`;
const results = [];
const check = async (label, fn) => {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ label, ok: true, ms: Math.round(performance.now() - started), detail });
  } catch (error) {
    results.push({ label, ok: false, error: String(error?.message || error).slice(0, 600) });
  }
};
const ok = (r) => {
  assert.equal(r?.error, undefined, JSON.stringify(r).slice(0, 600));
  return r;
};
const waitPage = async (tab, expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await tab.read(expr)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error(`timeout: ${expr}`);
};
const go = async (tab, path) => {
  ok(await tab.run('navigate', { url: origin + path }));
  await waitPage(tab, `document.readyState==='complete'`);
};
const snap = (tab, options) =>
  tab.run('semantic_snapshot', { options: { mode: 'interactive', budget: 5000, ...options } });
const names = (s) => (s.items || []).map((i) => i.name);

let session;
try {
  session = await openRealSession({
    browser: process.argv.includes('--edge') ? 'edge' : 'chrome',
    label: 's1s4',
  });
  await session.enableFullAccess();
  const tab = await openTask(session, {
    owner: 's1s4',
    origins: [origin],
    url: `${origin}/s1`,
    title: 'S1–S4 实测',
  });

  await check('S1 透明按钮、读屏专用按钮不进交互清单；正文仍可读到读屏文字', async () => {
    await go(tab, '/s1');
    const s = ok(await snap(tab, {}));
    assert.ok(!names(s).includes('透明按钮'), JSON.stringify(names(s)));
    assert.ok(!names(s).includes('读屏按钮'), JSON.stringify(names(s)));
    const c = ok(
      await tab.run('semantic_snapshot', {
        options: { mode: 'content', query: '读屏说明', budget: 5000 },
      }),
    );
    assert.ok(JSON.stringify(c).includes('读屏说明文字'), JSON.stringify(c).slice(0, 400));
    return names(s);
  });

  await check('S1 透明复选框靠可见 label 保留，并能勾选', async () => {
    const s = ok(await snap(tab, { roles: ['checkbox'] }));
    const item = s.items.find((i) => i.name === '同意条款');
    assert.ok(item, JSON.stringify(s.items));
    ok(
      await tab.run('ref_set_checked', {
        binding: s.binding,
        snapshot_id: s.snapshotId,
        ref: item.ref,
        checked: true,
      }),
    );
    assert.equal(await tab.read(`document.getElementById('agree').checked`), true);
    return item.actions;
  });

  await check('S1 被 cookie 横幅挡住的按钮标 blocked，移开后提示消失', async () => {
    const s = ok(await snap(tab, { query: '被挡按钮' }));
    const item = s.items.find((i) => i.name === '被挡按钮');
    assert.ok(item, JSON.stringify(s.items));
    assert.equal(item.blocked, 'occluded', JSON.stringify(item));
    assert.equal(item.actionable, false);
    await tab.read(`document.getElementById('banner').remove();true`);
    const s2 = ok(await snap(tab, { query: '被挡按钮' }));
    const item2 = s2.items.find((i) => i.name === '被挡按钮');
    assert.ok(item2);
    assert.equal(item2.blocked, undefined);
    assert.equal(item2.actionable, undefined);
    ok(
      await tab.run('ref_click', {
        binding: s2.binding,
        snapshot_id: s2.snapshotId,
        ref: item2.ref,
      }),
    );
    assert.equal(await tab.read(`window.__under`), 1);
    return { before: item.blocked, after: item2.blocked ?? null };
  });

  await check('S2 改一个按钮：delta 比 full 小，且重建结果和新 full 一致', async () => {
    await go(tab, '/s2');
    const first = ok(await snap(tab, {}));
    assert.equal(first.items.length, 30);
    await tab.read(`document.getElementById('b7').disabled=true;true`);
    const delta = ok(await snap(tab, { baselineId: first.snapshotId }));
    assert.equal(delta.kind, 'delta', JSON.stringify(delta).slice(0, 400));
    const full = ok(await snap(tab, {}));
    const map = new Map(first.items.map((i) => [i.ref, i]));
    for (const r of delta.removed || []) map.delete(r);
    for (const i of delta.items) map.set(i.ref, i);
    const rebuilt = (delta.order || [...map.keys()]).map((k) => map.get(k));
    assert.deepEqual(
      rebuilt.map((i) => [i.name, i.disabled ?? false]),
      full.items.map((i) => [i.name, i.disabled ?? false]),
    );
    const db = Buffer.byteLength(JSON.stringify(delta)),
      fb = Buffer.byteLength(JSON.stringify(full));
    assert.ok(db < fb, `${db}>=${fb}`);
    return { deltaItems: delta.items.length, deltaBytes: db, fullBytes: fb };
  });

  await check(
    'S3 带 after 点击：回执附带 #result 的新菜单；不带 after 时无 observation',
    async () => {
      await go(tab, '/s3');
      const s = ok(await snap(tab, { query: '展开菜单' }));
      const item = s.items.find((i) => i.name === '展开菜单');
      const r = ok(
        await tab.run('ref_click', {
          binding: s.binding,
          snapshot_id: s.snapshotId,
          ref: item.ref,
          after: { root: '#result', mode: 'interactive', budget: 1800 },
        }),
      );
      assert.ok(r.observation && !r.observation.error, JSON.stringify(r).slice(0, 600));
      assert.deepEqual(names(r.observation).sort(), ['菜单项乙', '菜单项甲'].sort());
      const s2 = ok(await snap(tab, { query: '展开菜单' }));
      const r2 = ok(
        await tab.run('ref_click', {
          binding: s2.binding,
          snapshot_id: s2.snapshotId,
          ref: s2.items[0].ref,
        }),
      );
      assert.equal('observation' in r2, false);
      assert.equal(await tab.read(`window.__open`), 2);
      return names(r.observation);
    },
  );

  await check('S3 回读根不存在：只报 observation.error，点击只发生一次', async () => {
    await go(tab, '/s3');
    const s = ok(await snap(tab, { query: '展开菜单' }));
    const r = ok(
      await tab.run('ref_click', {
        binding: s.binding,
        snapshot_id: s.snapshotId,
        ref: s.items[0].ref,
        after: { root: '#nope' },
      }),
    );
    assert.ok(r.observation?.error, JSON.stringify(r).slice(0, 400));
    assert.equal(await tab.read(`window.__open`), 1);
    return r.observation.error;
  });

  await check('S3 点击链接跳转：observation 来自新页面且绑定已更新', async () => {
    const s = ok(await snap(tab, { query: '去下一页' }));
    const item = s.items.find((i) => i.name === '去下一页');
    const r = ok(
      await tab.run('ref_click', {
        binding: s.binding,
        snapshot_id: s.snapshotId,
        ref: item.ref,
        after: { mode: 'interactive' },
      }),
    );
    assert.ok(r.observation && !r.observation.error, JSON.stringify(r).slice(0, 600));
    assert.ok(names(r.observation).includes('下一页按钮'), JSON.stringify(names(r.observation)));
    assert.notEqual(r.observation.binding?.leaseId, s.binding?.leaseId);
    return { navigation: r.navigation ?? null, items: names(r.observation) };
  });

  for (const kind of ['tiptap', 'prosemirror', 'lexical']) {
    await check(
      `S4 ${kind}：填写中文/emoji 走真实输入，编辑器内部 model 同步；清空也同步`,
      async () => {
        await go(tab, `/editor?kind=${kind}`);
        await waitPage(tab, `window.__ready===true||!!window.__loadError`, 30000);
        const loadError = await tab.read(`window.__loadError||''`);
        assert.equal(loadError, '', loadError);
        const s = ok(await snap(tab, { query: '富文本编辑器' }));
        const item = s.items.find((i) => i.name === '富文本编辑器');
        assert.ok(item, JSON.stringify(s.items));
        assert.ok(item.actions.includes('fill'), JSON.stringify(item));
        const text = '新内容：你好世界 😀';
        const r = await tab.run('ref_fill', {
          binding: s.binding,
          snapshot_id: s.snapshotId,
          ref: item.ref,
          text,
        });
        const model = await tab.read(`window.__model()`),
          events = await tab.read(`window.__events`);
        const dom = await tab.read(`document.getElementById('mount').innerText`);
        const { recovery: _r, ...receipt } = r;
        assert.equal(
          r.verified,
          true,
          JSON.stringify({ receipt, model, dom, events }).slice(0, 800),
        );
        assert.equal(model, text, `model=${model}`);
        assert.ok(events.beforeinput >= 1, JSON.stringify(events));
        assert.doesNotMatch(JSON.stringify(r), /你好世界/);
        const s2 = ok(await snap(tab, { query: '富文本编辑器' }));
        const r2 = await tab.run('ref_fill', {
          binding: s2.binding,
          snapshot_id: s2.snapshotId,
          ref: s2.items[0].ref,
          text: '',
        });
        const cleared = await tab.read(`window.__model()`),
          clearedDom = await tab.read(`document.getElementById('mount').innerText`);
        const { recovery: _r2, ...receipt2 } = r2;
        assert.equal(
          r2.verified,
          true,
          JSON.stringify({
            receipt2,
            cleared,
            clearedDom,
            events: await tab.read(`window.__events`),
          }).slice(0, 800),
        );
        assert.equal(cleared, '', `cleared=${cleared}`);
        return { delivery: r.delivery, verified: r.verified, events, clearVerified: r2.verified };
      },
    );
  }
} finally {
  await session?.close?.().catch(() => {});
  server.close();
}
for (const row of results)
  console.log(
    `${row.ok ? '✔' : '✖'} ${row.label}${row.ok ? ` (${row.ms}ms) ${JSON.stringify(row.detail).slice(0, 300)}` : `\n   ${row.error}`}`,
  );
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
