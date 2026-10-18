import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPageSemantics } from './index.js';
import { semanticWorldDeclaration } from '../native-extension/core.mjs';
import { rankTargets } from '../native-extension/target-recovery.mjs';

function fixture(html) {
  const dom = new JSDOM(html, { url: 'https://fixture.test/', runScripts: 'outside-only' }),
    w = dom.window,
    doc = w.document;
  // 中文注释：明确合成几何和命中；这些测试只验证解析契约。
  w.HTMLElement.prototype.getClientRects = function () {
    return this.hidden ? [] : [this.getBoundingClientRect()];
  };
  w.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 20,
    top: 20,
    right: 120,
    bottom: 50,
    width: 100,
    height: 30,
  });
  const binding = { taskId: 'task', documentId: 'doc', leaseId: 'lease' },
    semantics = createPageSemantics({ document: doc, ...binding });
  return {
    w,
    doc,
    binding,
    semantics,
    close() {
      semantics.revoke();
      w.close();
    },
  };
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const rect = (left, top, width = 100, height = 30) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});
function retained(f, name) {
  const page = f.semantics.snapshot({ composed: true }),
    item = page.items.find((item) => item.name === name);
  assert.ok(item, name);
  assert.equal(item.blocked, undefined);
  const node = f.semantics.resolve({ ...page.binding, snapshotId: page.snapshotId, ref: item.ref });
  const call = f.w.eval(`(${semanticWorldDeclaration})`),
    scan = call('recovery_scan', { binding: f.binding });
  const chosen = rankTargets(scan, { role: item.role, name })[0];
  assert.ok(chosen, name);
  assert.equal(chosen.visible, true);
  assert.equal(chosen.inViewport, false);
  assert.equal(chosen.occluded, false);
  assert.equal(
    f.w.__fastNativeSemanticsV2.semantics.resolve({
      ...chosen.binding,
      snapshotId: chosen.snapshotId,
      ref: chosen.ref,
    }),
    node,
  );
  return item;
}

for (const axis of ['Y', 'X'])
  test(`S1 窗口 scroll${axis} 后顶部/左侧控件仍在清单及 recovery_scan 中，滚回后重新 hit test`, () => {
    const f = fixture('<button>保存</button>');
    try {
      const node = f.doc.querySelector('button');
      let calls = 0;
      f.doc.elementFromPoint = () => {
        calls++;
        return node;
      };
      f.w[`scroll${axis}`] = 300;
      node.getBoundingClientRect = () =>
        rect(axis === 'X' ? 20 - f.w.scrollX : 20, axis === 'Y' ? 20 - f.w.scrollY : 20);
      retained(f, '保存');
      assert.equal(calls, 0);
      assert.equal(f.semantics.snapshot({ viewport: true }).items.length, 0);
      f.w[`scroll${axis}`] = 0;
      assert.equal(f.semantics.snapshot().items[0].name, '保存');
      assert.equal(calls, 1);
    } finally {
      f.close();
    }
  });
for (const axis of ['Top', 'Left'])
  test(`S1 内部容器 scroll${axis} 后控件仍可恢复，中心在窗口内但在容器外时不 hit test`, () => {
    const f = fixture(
      '<section style="overflow-x:auto;overflow-y:auto"><button>容器保存</button></section>',
    );
    try {
      const box = f.doc.querySelector('section'),
        node = f.doc.querySelector('button');
      let calls = 0;
      box.getBoundingClientRect = () => rect(400, 400, 200, 200);
      Object.defineProperties(box, {
        clientWidth: { value: 200 },
        clientHeight: { value: 200 },
        scrollWidth: { value: 800 },
        scrollHeight: { value: 800 },
      });
      f.doc.elementFromPoint = () => {
        calls++;
        return box;
      };
      for (const offset of [300, 600]) {
        box[`scroll${axis}`] = offset;
        node.getBoundingClientRect = () => rect(420 - box.scrollLeft, 420 - box.scrollTop);
        retained(f, '容器保存');
        assert.equal(calls, 0);
      }
      box[`scroll${axis}`] = 0;
      f.doc.elementFromPoint = () => {
        calls++;
        return node;
      };
      assert.equal(f.semantics.snapshot().items[0].blocked, undefined);
      assert.equal(calls, 1);
    } finally {
      f.close();
    }
  });
test('S1 嵌套容器及窗口滚动累计到各自内容坐标，Shadow 子控件仍可恢复', () => {
  const f = fixture(
    '<section style="overflow-x:auto;overflow-y:auto"><div id="host" style="overflow-x:auto;overflow-y:auto"></div></section>',
  );
  try {
    const outer = f.doc.querySelector('section'),
      host = f.doc.querySelector('#host'),
      root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>影子滚动保存</button>';
    const node = root.querySelector('button');
    f.w.scrollY = 300;
    outer.scrollTop = 200;
    host.scrollTop = 200;
    outer.getBoundingClientRect = () => rect(20, -280, 200, 200);
    host.getBoundingClientRect = () => rect(20, -460, 200, 200);
    for (const box of [outer, host])
      Object.defineProperties(box, {
        clientWidth: { value: 200 },
        clientHeight: { value: 200 },
        scrollHeight: { value: 800 },
      });
    node.getBoundingClientRect = () => rect(40, -640);
    f.doc.elementFromPoint = root.elementFromPoint = () => assert.fail('容器外中心不得 hit test');
    const item = f.semantics.snapshot({ composed: true }).items[0];
    assert.equal(item.name, '影子滚动保存');
    retained(f, '影子滚动保存');
  } finally {
    f.close();
  }
});
test('S1 窗口与容器滚动后仍排除内容原点之前的 -9999px，以及 fixed 屏外控件', () => {
  const f = fixture(
    '<button id="left">文档左侧隐藏</button><button id="top">文档顶部隐藏</button><button id="fixed" style="position:fixed">固定隐藏</button><section style="overflow-x:auto;overflow-y:auto"><button id="inner">容器隐藏</button></section>',
  );
  try {
    f.w.scrollX = 300;
    f.w.scrollY = 300;
    f.doc.querySelector('#left').getBoundingClientRect = () => rect(-9999 - f.w.scrollX, 20);
    f.doc.querySelector('#top').getBoundingClientRect = () => rect(20, -9999 - f.w.scrollY);
    f.doc.querySelector('#fixed').getBoundingClientRect = () => rect(20, -100);
    const box = f.doc.querySelector('section');
    box.scrollTop = 300;
    Object.defineProperties(box, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
      scrollHeight: { value: 800 },
    });
    // 中文注释：容器本身很靠下，元素虽落在文档正坐标，仍在容器内容原点之前。
    box.getBoundingClientRect = () => rect(20, 11000, 200, 200);
    f.doc.querySelector('#inner').getBoundingClientRect = () =>
      rect(40, 11000 - 9999 - box.scrollTop);
    assert.equal(f.semantics.snapshot().items.length, 0);
    assert.equal(
      f.w.eval(`(${semanticWorldDeclaration})`)('recovery_scan', { binding: f.binding }).length,
      0,
    );
  } finally {
    f.close();
  }
});
test('S1 Shadow 滚动容器外的中心虽在窗口内，仍跳过内外两层 hit test', () => {
  const f = fixture('<div id="host" style="overflow-x:auto;overflow-y:auto"></div>');
  try {
    const host = f.doc.querySelector('#host'),
      root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>影子容器保存</button>';
    host.scrollTop = 300;
    host.getBoundingClientRect = () => rect(400, 400, 200, 200);
    Object.defineProperties(host, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
      scrollHeight: { value: 800 },
    });
    root.querySelector('button').getBoundingClientRect = () => rect(420, 120);
    f.doc.elementFromPoint = root.elementFromPoint = () => assert.fail('容器外中心不得 hit test');
    retained(f, '影子容器保存');
  } finally {
    f.close();
  }
});
test('S1 同源 frame 的窗口滚动按自身文档坐标保留控件，外层不 hit test', () => {
  const f = fixture('<iframe></iframe>');
  try {
    const frame = f.doc.querySelector('iframe'),
      child = frame.contentDocument,
      w = child.defaultView;
    child.body.innerHTML = '<button>框架滚动保存</button>';
    w.scrollY = 300;
    w.HTMLElement.prototype.getClientRects = () => [{}];
    w.HTMLElement.prototype.getBoundingClientRect = () => rect(20, -280);
    Object.defineProperties(frame, { offsetWidth: { value: 100 }, offsetHeight: { value: 30 } });
    child.elementFromPoint = f.doc.elementFromPoint = () => assert.fail('视口外中心不得 hit test');
    retained(f, '框架滚动保存');
  } finally {
    f.close();
  }
});
test('S1 单选 label 代理滚出视口后仍保留原 input 引用', () => {
  const f = fixture(
    '<input type="radio" id="plan" style="opacity:0"><label for="plan">Freemium</label>',
  );
  try {
    f.w.scrollY = 300;
    f.doc.querySelector('label').getBoundingClientRect = () => rect(20, -280);
    assert.ok(retained(f, 'Freemium').actions.includes('set_checked'));
  } finally {
    f.close();
  }
});
test('S1 滚动后同名 Description 的只读/可编辑能力及 optional 名称保持不变', () => {
  const f = fixture(
    '<label for="ro">Description</label><textarea id="ro" readonly>只读示例</textarea><label for="edit">Description</label><textarea id="edit"></textarea><label for="optional">Tool Description (optional)</label><textarea id="optional"></textarea>',
  );
  try {
    f.w.scrollY = 600;
    f.w.HTMLElement.prototype.getBoundingClientRect = () => rect(20, -580);
    const items = f.semantics.snapshot().items;
    assert.deepEqual(
      items.map((item) => item.name),
      ['Description', 'Description', 'Tool Description (optional)'],
    );
    assert.equal(items[0].readonly, true);
    assert.ok(!items[0].actions.includes('fill'));
    assert.ok(items[1].actions.includes('fill'));
    assert.ok(items[2].actions.includes('fill'));
    retained(f, 'Tool Description (optional)');
  } finally {
    f.close();
  }
});

test('S1 透明及 sr-only 勾选控件保留可见 label，透明普通按钮不进入交互清单', () => {
  const f = fixture(
    '<input id="check" type="checkbox" style="opacity:0"><label for="check">同意</label><label>选择<input type="radio" style="position:absolute;clip:rect(0px,0px,0px,0px);width:1px"></label><input type="checkbox" id="none" style="display:none"><label for="none">无布局</label><button style="opacity:0">隐藏按钮</button>',
  );
  try {
    for (const composed of [false, true]) {
      const page = f.semantics.snapshot({ composed }),
        items = page.items;
      assert.deepEqual(
        items.map((item) => item.role),
        ['checkbox', 'radio', 'checkbox'],
      );
      assert.deepEqual(
        items.map((item) => item.name),
        ['同意', '选择', '无布局'],
      );
      assert.ok(items.every((item) => item.actions.includes('set_checked')));
      for (const item of items)
        assert.equal(
          f.semantics.resolve({ ...page.binding, snapshotId: page.snapshotId, ref: item.ref })
            .localName,
          'input',
        );
    }
  } finally {
    f.close();
  }
});
test('S1 label 代理不能绕过勾选控件的隐藏祖先或隐私标记', () => {
  for (const attribute of ['style="display:none"', 'hidden', 'aria-hidden="true"', 'inert']) {
    const f = fixture(
      `<div ${attribute}><input id="private" type="checkbox"></div><label for="private">私密</label><input id="missing" type="checkbox" style="display:none">`,
    );
    try {
      for (const composed of [false, true])
        assert.equal(f.semantics.snapshot({ composed }).items.length, 0);
      const scan = f.w.eval(`(${semanticWorldDeclaration})`)('recovery_scan', {
        binding: f.binding,
      });
      assert.equal(scan.length, 0);
    } finally {
      f.close();
    }
  }
});
test('S1 clip、clip-path、tiny 和 -9999px 只过滤交互，正文仍按原规则读取', () => {
  const f = fixture(
    '<button style="clip:rect(0px,0px,0px,0px)">sr-only</button><button style="clip-path:inset(50%)">clip-path</button><button id="tiny">微小</button><button id="off">屏外</button><p style="opacity:0">正文可读</p>',
  );
  try {
    f.doc.querySelector('#tiny').getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 2,
      bottom: 2,
      width: 2,
      height: 2,
    });
    f.doc.querySelector('#off').getBoundingClientRect = () => ({
      left: -9999,
      top: 0,
      right: -9899,
      bottom: 30,
      width: 100,
      height: 30,
    });
    assert.equal(f.semantics.snapshot().items.length, 0);
    assert.equal(f.semantics.snapshot({ mode: 'content' }).items[0].name, '正文可读');
  } finally {
    f.close();
  }
});
test('S1 checkVisibility 与组合祖先的 opacity/aria-hidden/inert 均生效', () => {
  const f = fixture(
    '<div style="opacity:0"><button>透明祖先</button></div><div aria-hidden="true"><button>ARIA</button></div><div inert><button>inert</button></div><button id="check">CSS</button><div id="host"></div>',
  );
  try {
    f.doc.querySelector('#check').checkVisibility = (options) => {
      assert.equal(options.checkOpacity, true);
      assert.equal(options.checkVisibilityCSS, true);
      return false;
    };
    const host = f.doc.querySelector('#host');
    host.setAttribute('inert', '');
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow inert</button>';
    assert.equal(f.semantics.snapshot({ composed: true }).items.length, 0);
  } finally {
    f.close();
  }
});
test('S1 modal 遮挡保留 blocked 提示，恢复扫描共用相同判断，滚动后重新命中', () => {
  const f = fixture('<button id="target">保存</button><aside id="modal">Cookie wall</aside>');
  try {
    const node = f.doc.querySelector('#target'),
      modal = f.doc.querySelector('#modal');
    let hit = modal;
    f.doc.elementFromPoint = () => hit;
    const first = f.semantics.snapshot();
    assert.equal(first.items[0].blocked, 'occluded');
    assert.equal(first.items[0].actionable, false);
    const call = f.w.eval(`(${semanticWorldDeclaration})`),
      scan = call('recovery_scan', { binding: f.binding });
    assert.equal(scan[0].occluded, true);
    assert.equal(scan[0].visible, true);
    hit = node;
    f.w.scrollY = 300;
    const next = f.semantics.snapshot();
    assert.equal(next.items[0].blocked, undefined);
    assert.equal(
      f.semantics.resolve({
        ...first.binding,
        snapshotId: first.snapshotId,
        ref: first.items[0].ref,
      }),
      node,
    );
    assert.equal(call('recovery_scan', { binding: f.binding })[0].occluded, false);
  } finally {
    f.close();
  }
});
test('S1 视口内中心允许祖先/后代命中，视口外不做 hit test', () => {
  const f = fixture('<section><button><span>保存</span></button></section>');
  try {
    const node = f.doc.querySelector('button');
    let calls = 0;
    for (const hit of [node, node.firstElementChild, node.parentElement]) {
      f.doc.elementFromPoint = () => {
        calls++;
        return hit;
      };
      assert.equal(f.semantics.snapshot().items[0].blocked, undefined);
    }
    node.getBoundingClientRect = () => ({
      left: 20,
      top: 2000,
      right: 120,
      bottom: 2030,
      width: 100,
      height: 30,
    });
    f.semantics.snapshot();
    assert.equal(calls, 3);
  } finally {
    f.close();
  }
});
for (const blocked of [true, false])
  test(`S1 插件浮层下${blocked ? '网页遮挡仍标 blocked' : '目标自身不标 blocked'}，恢复扫描一致`, () => {
    const f = fixture(
      '<div data-fast-automation-overlay><span></span></div><aside id="banner">Cookie wall</aside><button>被挡按钮</button>',
    );
    try {
      const overlay = f.doc.querySelector('span'),
        node = f.doc.querySelector('button'),
        banner = f.doc.querySelector('#banner');
      f.doc.elementFromPoint = () => overlay;
      f.doc.elementsFromPoint = () => [
        overlay,
        overlay.parentElement,
        ...(blocked ? [banner] : []),
        node,
        f.doc.body,
        f.doc.documentElement,
      ];
      const item = f.semantics.snapshot().items[0];
      assert.equal(item.blocked, blocked ? 'occluded' : undefined);
      assert.equal(item.actionable, blocked ? false : undefined);
      const scan = f.w.eval(`(${semanticWorldDeclaration})`)('recovery_scan', {
        binding: f.binding,
      });
      assert.equal(scan[0].occluded, blocked);
      assert.equal(scan[0].visible, true);
    } finally {
      f.close();
    }
  });
test('S1 ShadowRoot 只有 elementsFromPoint 时跳过浮层并复查网页遮挡', () => {
  const f = fixture('<div id="host"></div>');
  try {
    const host = f.doc.querySelector('#host'),
      root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<div data-fast-automation-overlay></div><aside></aside><button>Shadow 保存</button>';
    const node = root.querySelector('button'),
      overlay = root.querySelector('div'),
      banner = root.querySelector('aside');
    let blocked = true;
    root.elementsFromPoint = () => [overlay, ...(blocked ? [banner] : []), node];
    f.doc.elementsFromPoint = () => [host, f.doc.body];
    assert.equal(f.semantics.snapshot({ composed: true }).items[0].blocked, 'occluded');
    blocked = false;
    assert.equal(f.semantics.snapshot({ composed: true }).items[0].blocked, undefined);
  } finally {
    f.close();
  }
});
test('S1 Shadow 内使用自身 hit test，并复查外层 host 遮挡', () => {
  const f = fixture('<div id="host"></div><aside id="modal"></aside>');
  try {
    const host = f.doc.querySelector('#host'),
      root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button><span>Shadow 保存</span></button>';
    const node = root.querySelector('button');
    root.elementFromPoint = () => node.firstElementChild;
    f.doc.elementFromPoint = () => host;
    assert.equal(f.semantics.snapshot({ composed: true }).items[0].blocked, undefined);
    f.doc.elementFromPoint = () => f.doc.querySelector('#modal');
    assert.equal(f.semantics.snapshot({ composed: true }).items[0].blocked, 'occluded');
  } finally {
    f.close();
  }
});
test('S1 同源 frame 中心映射到外层后检测遮挡，slot/display:contents 保持可读', () => {
  const f = fixture(
    '<div style="display:contents"><button>普通</button></div><iframe></iframe><aside></aside>',
  );
  try {
    const frame = f.doc.querySelector('iframe'),
      child = frame.contentDocument;
    child.defaultView.HTMLElement.prototype.getClientRects = () => [{}];
    child.defaultView.HTMLElement.prototype.getBoundingClientRect =
      f.w.HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperties(frame, { offsetWidth: { value: 100 }, offsetHeight: { value: 30 } });
    child.body.innerHTML = '<button>框架</button>';
    child.elementFromPoint = () => child.querySelector('button');
    f.doc.elementFromPoint = () => f.doc.querySelector('aside');
    const item = f.semantics
      .snapshot({ composed: true })
      .items.find((item) => item.name === '框架');
    assert.equal(item.blocked, 'occluded');
    assert.ok(f.semantics.snapshot().items.some((item) => item.name === '普通'));
  } finally {
    f.close();
  }
});

test('S2 仅实际更小的 UTF-8 delta 被选用，重建列表与 full 完全等价且不含输入值', () => {
  const f = fixture(
    Array.from(
      { length: 12 },
      (_, i) => `<input aria-label="字段${i}" value="PASSWORD_OR_INPUT_VALUE_${i}">`,
    ).join(''),
  );
  try {
    const first = f.semantics.snapshot({ budget: 6000 }),
      baseline = new Map(first.items.map((item) => [item.ref, item]));
    f.doc.querySelector('input').setAttribute('readonly', '');
    const delta = f.semantics.snapshot({ budget: 6000, baselineId: first.snapshotId });
    assert.equal(delta.kind, 'delta');
    for (const ref of delta.removed) baseline.delete(ref);
    for (const item of delta.items) baseline.set(item.ref, item);
    const full = f.semantics.snapshot({ budget: 6000 });
    assert.deepEqual(
      delta.order.map((ref) => baseline.get(ref)),
      full.items,
    );
    const comparable = { ...full, snapshotId: delta.snapshotId };
    assert.ok(bytes(delta) < bytes(comparable));
    assert.doesNotMatch(JSON.stringify(delta), /PASSWORD_OR_INPUT_VALUE/);
  } finally {
    f.close();
  }
});
test('S2 delta 不比 full 小时返回 full；单项变更和大量移除均不强行发补丁', () => {
  for (const html of [
    '<input aria-label="字段">',
    Array.from({ length: 20 }, (_, i) => `<button id="b${i}">条目${i}</button>`).join(''),
  ]) {
    const f = fixture(html);
    try {
      const first = f.semantics.snapshot({ budget: 6000 });
      if (f.doc.querySelector('input')) f.doc.querySelector('input').setAttribute('readonly', '');
      else for (const node of [...f.doc.querySelectorAll('button')].slice(1)) node.remove();
      const result = f.semantics.snapshot({ budget: 6000, baselineId: first.snapshotId });
      assert.equal(result.kind, 'full');
      assert.equal(result.items.length, 1);
      assert.equal(result.resync, null);
    } finally {
      f.close();
    }
  }
});
test('S2 root/query/role/budget/mode 参数变化仍 resync，片段 epoch 变化仍失效', () => {
  for (const change of [
    { root: '#scope' },
    { query: '字段' },
    { roles: ['textbox'] },
    { budget: 5000 },
    { mode: 'content' },
  ]) {
    const f = fixture('<main id="scope"><input aria-label="字段"></main>');
    try {
      const first = f.semantics.snapshot({ budget: 6000 });
      const next = f.semantics.snapshot({ budget: 6000, ...change, baselineId: first.snapshotId });
      assert.equal(next.kind, 'full');
      assert.equal(next.resync.reason, 'parameters_changed');
    } finally {
      f.close();
    }
  }
  const f = fixture(`<p>${'正文片段'.repeat(1000)}</p>`);
  try {
    const first = f.semantics.snapshot({ mode: 'content', budget: 650 });
    assert.ok(first.nextCursor);
    f.doc.querySelector('p').append('改变 epoch');
    const next = f.semantics.snapshot({ mode: 'content', budget: 650, cursor: first.nextCursor });
    assert.equal(next.resync.reason, 'cursor_invalidated');
  } finally {
    f.close();
  }
});
