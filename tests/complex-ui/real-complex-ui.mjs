// 中文注释：手动验收脚本。real-session 使用临时配置加载源码扩展；本文件不进入离线测试清单。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask } from '../native-v2/real-session.mjs';
import { CdpClient, fetchJson, waitFor } from '../native-v2/cdp-client.mjs';

const fixture = await readFile(new URL('./fixture.html', import.meta.url), 'utf8');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // 中文注释：跨源负例也由本地 fixture 提供，禁止浏览器向外网发起页面请求。
  response.end(
    request.url === '/frame'
      ? '<button aria-label="框架按钮">框架按钮</button>'
      : fixture.replace(
          'https://cross-origin.example.test/',
          `http://cross.localhost:${server.address().port}/frame`,
        ),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let session;
try {
  session = await openRealSession({
    browser: process.argv.includes('--edge') ? 'edge' : 'chrome',
    label: 'complex-ui',
    compactScratch: true,
    headed: process.argv.includes('--headed'),
  });
  await session.enableFullAccess();
  const tab = await openTask(session, {
    owner: 'complex-ui',
    origins: [origin],
    url: origin + '/',
    title: '复杂界面',
  });
  const run = async (action, params = {}) => {
    const result = await tab.run(action, params);
    assert.equal(result?.error, undefined, JSON.stringify(result));
    return result;
  };
  const ref = async (name, roles) => {
    const page = await run('semantic_snapshot', {
      options: { mode: 'interactive', query: name, roles, budget: 5000, composed: true },
    });
    const item = page.items.find((value) => value.name === name);
    assert.ok(item, name);
    return { binding: page.binding, snapshot_id: page.snapshotId, ref: item.ref };
  };
  await tab.read(`document.querySelector('#inner').src='/frame'`);
  // 中文注释：等待本地同源框架加载，避免拿导航中的旧框架做快照。
  await tab.read(
    `new Promise(resolve=>{const f=document.querySelector('#inner');if(f.contentDocument?.querySelector('button'))resolve(true);else f.addEventListener('load',()=>resolve(true),{once:true})})`,
  );
  await tab.read(
    `(()=>{const outer=document.querySelector('#component').attachShadow({mode:'open'});outer.innerHTML='<button aria-label="影子按钮">影子按钮</button><input aria-label="影子输入">';outer.querySelector('button').onclick=e=>e.target.setAttribute('aria-pressed','true');return true})()`,
  );
  await tab.read(
    `(()=>{const combo=document.querySelector('#combo'),option=document.querySelector('#options [role=option]');combo.onclick=()=>combo.setAttribute('aria-expanded','true');option.onclick=()=>option.setAttribute('aria-selected','true');return true})()`,
  );
  // 中文注释：夹具点击产生可见状态，回归点击交付与效果观察。
  await tab.read(
    `document.querySelector('#pointer').onclick=e=>e.currentTarget.textContent='已点击';document.querySelector('#save').onclick=e=>e.currentTarget.setAttribute('aria-pressed','true')`,
  );
  const shadow = await ref('影子按钮', ['button']);
  await run('ref_click', shadow);
  await run('ref_fill', { ...(await ref('影子输入', ['textbox'])), text: '测试' });
  const frame = await run('frame_catalog');
  assert.ok(frame.frames?.length);
  await run('ref_click', await ref('框架按钮', ['button']));
  await run('ref_click', await ref('推断点击', ['button']));
  await run('ref_select_option', {
    ...(await ref('地区', ['combobox'])),
    by: 'value',
    values: ['cn'],
  });
  await run('ref_fill', { ...(await ref('受控输入', ['textbox'])), text: '受控内容' });
  await run('ref_fill', { ...(await ref('正文', ['textbox'])), text: '富文本内容' });
  // 中文注释：合法编辑属性和动态上下文通过实际工具、daemon 和浏览器执行，回读只用于断言。
  await tab.read(
    `document.body.insertAdjacentHTML('beforeend','<section id="editable-cases"><div contenteditable aria-label="空属性编辑区"></div><div contenteditable="plaintext-only" aria-label="纯文本编辑区"></div></section><article id="dynamic-cases"><p>进度 0</p><button>保存动态记录</button><button>保存动态记录</button></article>');document.querySelectorAll('#editable-cases div').forEach(n=>n.style.cssText='min-height:30px;width:200px;border:1px solid black');document.querySelectorAll('#dynamic-cases button').forEach((n,i)=>n.onclick=()=>n.setAttribute('data-clicked',String(i)))`,
  );
  for (const name of ['空属性编辑区', '纯文本编辑区'])
    await run('ref_fill', { ...(await ref(name, ['textbox'])), text: '编辑区验收' });
  assert.deepEqual(
    await tab.read(`Array.from(document.querySelectorAll('#editable-cases div'),n=>n.textContent)`),
    ['编辑区验收', '编辑区验收'],
  );
  const dynamic = await run('semantic_snapshot', { options: { root: '#dynamic-cases' } });
  await tab.read(`document.querySelector('#dynamic-cases p').textContent='进度 1'`);
  await run('ref_click', {
    binding: dynamic.binding,
    snapshot_id: dynamic.snapshotId,
    ref: dynamic.items[1].ref,
  });
  assert.equal(
    await tab.read(
      `document.querySelectorAll('#dynamic-cases button')[1].getAttribute('data-clicked')`,
    ),
    '1',
  );
  const table = await run('semantic_snapshot', { options: { mode: 'table', budget: 5000 } });
  assert.ok(table.items.some((item) => item.cells?.includes('示例')));
  // 中文注释：实际 Hermes 插件与 daemon 转发 accessibility 参数，AX 名称仍绑定同一个 DOM 控件。
  await tab.read(
    `document.body.insertAdjacentHTML('beforeend','<section id="native-ax"><button id="native-ax-button"></button></section><style>#native-ax-button::before{content:"完整链路按钮"}</style>')`,
  );
  const ax = await run('semantic_snapshot', {
    options: { root: '#native-ax', accessibility: true, query: '完整链路按钮', budget: 5000 },
  });
  assert.equal(ax.items.length, 1);
  assert.equal(ax.items[0].nameSource, 'accessibility');
  assert.equal(ax.coverage.axEnriched, 1);
  await tab.read(
    `document.querySelector('#native-ax-button').onclick=e=>e.currentTarget.setAttribute('data-clicked','true')`,
  );
  // 中文注释：查询后的真实页面修改需要重新获取快照，不能沿用失效的 AX 名称引用。
  const freshAx = await run('semantic_snapshot', {
    options: { root: '#native-ax', accessibility: true, query: '完整链路按钮', budget: 5000 },
  });
  await run('ref_click', {
    binding: freshAx.binding,
    snapshot_id: freshAx.snapshotId,
    ref: freshAx.items[0].ref,
  });
  assert.equal(
    await tab.read(`document.querySelector('#native-ax-button').getAttribute('data-clicked')`),
    'true',
  );
  await run('ref_click', await ref('更多信息', ['button']));
  const canvas = await run('semantic_snapshot', { options: { mode: 'interactive', budget: 5000 } });
  assert.equal(canvas.coverage.unsupportedCanvas, 1);
  const save = await ref('保存', ['button']);
  await tab.read(`document.querySelector('#save').outerHTML='<button id="save">保存</button>'`);
  const relocated = await run('ref_click', save);
  assert.equal(relocated.relocated, true);
  // 中文注释：控件能力在完整 daemon→扩展→浏览器→公共投影链路核验，不只直调页面库。
  await tab.read(
    `(()=>{const section=document.createElement('section');section.id='standard-controls';section.innerHTML='<button role="future command button">标准保存</button><div id="standard-check" role="future menuitemcheckbox" tabindex="0" aria-label="标准复选菜单" aria-checked="false" style="width:180px;height:32px">显示列</div><div id="standard-radio" role="menuitemradio" tabindex="0" aria-label="标准单选菜单" aria-checked="false" style="width:180px;height:32px">排序</div><input id="standard-mixed" type="checkbox" aria-label="标准三态"><div contenteditable aria-readonly="true" aria-label="标准只读">原有正文</div><div aria-disabled="true"><button>标准禁用</button></div>';document.body.append(section);section.scrollIntoView();document.querySelector('#standard-check').onclick=e=>e.currentTarget.setAttribute('aria-checked','true');document.querySelector('#standard-radio').onclick=e=>e.currentTarget.setAttribute('aria-checked','true');document.querySelector('#standard-mixed').indeterminate=true;return true})()`,
  );
  const standard = await run('semantic_snapshot', {
    options: { root: '#standard-controls', budget: 5000 },
  });
  assert.equal(standard.items.find((item) => item.name === '标准保存').role, 'button');
  assert.ok(
    standard.items.find((item) => item.name === '标准复选菜单').actions.includes('set_checked'),
  );
  assert.equal(standard.items.find((item) => item.name === '标准三态').checked, 'mixed');
  assert.deepEqual(standard.items.find((item) => item.name === '标准禁用').actions, []);
  assert.ok(!standard.items.find((item) => item.name === '标准只读').actions.includes('fill'));
  for (const name of ['标准复选菜单', '标准单选菜单']) {
    const target = await ref(name);
    const result = await run('ref_set_checked', { ...target, checked: true });
    assert.equal(result.verified, true);
  }
  const mixedRef = await ref('标准三态');
  const unsafeMixed = await tab.run('ref_set_checked', { ...mixedRef, checked: false });
  assert.ok(unsafeMixed.error);
  assert.equal(unsafeMixed.outcome_unknown, false);
  assert.equal(await tab.read(`document.querySelector('#standard-mixed').indeterminate`), true);
  const mixed = await run('ref_set_checked', { ...(await ref('标准三态')), checked: true });
  assert.equal(mixed.verified, true);
  assert.equal(await tab.read(`document.querySelector('#standard-mixed').indeterminate`), false);
  const readonly = await tab.run('ref_fill', { ...(await ref('标准只读')), text: '不应填写' });
  assert.ok(readonly.error);
  assert.equal(readonly.outcome_unknown, false);
  assert.equal(
    await tab.read(`document.querySelector('[aria-label="标准只读"]').textContent`),
    '原有正文',
  );
  // 中文注释：1.11.0 起固定遮罩覆盖按钮时插件自动关闭遮罩后点击成功。
  await tab.read(
    `(()=>{const mask=document.createElement('div');mask.id='acceptance-mask';mask.setAttribute('role','dialog');mask.setAttribute('aria-label','验收遮挡层');mask.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.1)';const close=document.createElement('button');close.textContent='关闭遮挡层';close.onclick=()=>mask.remove();mask.append(close);document.body.append(mask);return true})()`,
  );
  const covered = await tab.run('ref_click', await ref('保存', ['button']));
  assert.equal(covered.error, undefined, JSON.stringify(covered));
  assert.equal(covered.recovery?.triggered, true, JSON.stringify(covered.recovery));
  // 中文注释：用真实扩展与 Native 链路验证新增复杂场景；所有内容和回读都是本地合成夹具。
  await tab.read(
    `document.body.innerHTML='<main style="max-width:100%;overflow-wrap:anywhere"><h1>复杂页面执行验收</h1><section id="orders"><article><h2>订单 A</h2><button>删除记录</button></article><article><h2>订单 B</h2><button>删除记录</button></article></section><button id="lazy-combo" role="combobox" aria-label="延迟地区" aria-controls="lazy-list" aria-expanded="false">地区</button><div id="shadow-host" style="display:contents"></div><div id="deep-grid" role="future grid generic"><div role="row generic"><span role="columnheader generic">商品</span><span role="columnheader generic">数量</span></div><div role="row generic"><span role="gridcell generic">苹果</span><span role="gridcell generic">2</span></div></div></main>';window.deepCounts={deleted:0,open:0,selected:0,shadow:0,input:0};document.querySelectorAll('#orders button').forEach(b=>b.onclick=()=>deepCounts.deleted++);document.querySelector('#lazy-combo').onclick=e=>{deepCounts.open++;e.currentTarget.setAttribute('aria-expanded','true');setTimeout(()=>{const list=document.createElement('div');list.id='lazy-list';list.setAttribute('role','listbox');list.innerHTML='<div role="option" data-value="b" style="padding:12px">Beta</div>';list.firstChild.onclick=e=>{deepCounts.selected++;e.currentTarget.setAttribute('aria-selected','true')};document.querySelector('main').append(list)},100)};const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<button>无盒影子按钮</button><input aria-label="影子委托输入"><select aria-label="影子原生选择"><option value="a">A</option><option value="b">B</option></select>';shadow.querySelector('button').onclick=()=>deepCounts.shadow++;document.addEventListener('input',e=>{if(e.composedPath().includes(document.querySelector('#shadow-host')))deepCounts.input++});true`,
  );
  const orders = await run('semantic_snapshot', { options: { root: '#orders' } });
  await tab.read(`document.querySelector('#orders article').remove()`);
  const stale = await tab.run('ref_click', {
    binding: orders.binding,
    snapshot_id: orders.snapshotId,
    ref: orders.items[0].ref,
  });
  assert.ok(stale.error, '旧记录必须拒绝');
  assert.equal(await tab.read('deepCounts.deleted'), 0);
  await run('ref_select_option', {
    ...(await ref('延迟地区', ['combobox'])),
    by: 'value',
    values: ['b'],
  });
  await run('ref_click', await ref('无盒影子按钮', ['button']));
  await run('ref_fill', { ...(await ref('影子委托输入', ['textbox'])), text: '合成验收输入' });
  await run('ref_select_option', {
    ...(await ref('影子原生选择', ['combobox'])),
    by: 'value',
    values: ['b'],
  });
  const counts = await tab.read('deepCounts');
  assert.deepEqual(counts, { deleted: 0, open: 1, selected: 1, shadow: 1, input: 2 });
  const structured = await run('page.parse', {
    options: { root: '#deep-grid', sections: ['tables'] },
  });
  assert.equal(structured.tables.length, 2);
  assert.deepEqual(
    structured.tables[0].cells.map((cell) => cell.text),
    ['商品', '数量'],
  );
  assert.deepEqual(
    structured.tables[1].cells.map((cell) => cell.text),
    ['苹果', '2'],
  );
  const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
  const output = path.join(process.env.TMPDIR, `complex-ui-evidence-${browser}`);
  await mkdir(output, { recursive: true });
  const target = (await fetchJson(`${session.base}/json/list`)).find(
    (target) => target.url === origin + '/',
  );
  assert.ok(target);
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    for (const width of [1440, 375]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitFor(() => tab.read(`innerWidth===${width}`), 5000);
      assert.equal(await tab.read('document.documentElement.scrollWidth<=innerWidth'), true);
      const shot = await run('screenshot');
      assert.equal(typeof shot.data, 'string');
      await writeFile(path.join(output, `complex-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  } finally {
    cdp.close();
  }
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        browser,
        fixture: 'local synthetic page / real Native extension',
        counts,
        rows: structured.tables.length,
        viewports: [1440, 375],
        staleRejected: true,
      },
      null,
      2,
    ),
  );
  console.log(`复杂界面真实浏览器验收通过：${output}`);
} finally {
  await session?.close?.();
  await new Promise((resolve) => server.close(resolve));
}
