import { renderStatus, readableCopy } from '../../native-extension/ui-design.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = new URL('../../native-extension/', import.meta.url);
const [html, popupModule] = await Promise.all(
  ['popup.html', 'popup.mjs'].map((file) => readFile(new URL(file, root), 'utf8')),
);
// 中文注释：jsdom 的 eval 只执行经典脚本；把弹窗依赖的共享组件模块内联成同一作用域，行为与浏览器按模块加载一致。
const script = '(()=>{' + popupModule.replace(/^import\s[^;]*;\n/gm, '') + '\n})()';

async function mount(initial) {
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/popup.html',
    runScripts: 'outside-only',
  });
  const calls = [];
  let status = initial;
  let changed;
  dom.window.chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      getManifest: () => ({ version: '9.8.7' }),
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'popup_status') return { result: status };
        if (message.type === 'page_content_filter') {
          status = { ...status, pageContentFilter: message.enabled };
          return { result: { enabled: status.pageContentFilter } };
        }
        if (message.type === 'popup_action') {
          const row = status.tasks.find((t) => t.id === message.taskId);
          row.state =
            message.kind === 'takeover'
              ? 'paused'
              : message.kind === 'resume'
                ? 'ready'
                : 'cancelled';
          return { result: { verified: true, state: row.state } };
        }

        if (message.type === 'connect') {
          status = { ...status, connected: true };
          return { result: { connected: true } };
        }
        return { result: { connected: true } };
      },
      onMessage: {
        addListener: (listener) => {
          changed = listener;
        },
      },
    },
  };
  dom.window.setInterval = () => 1;
  dom.window.renderStatus = renderStatus;
  dom.window.readableCopy = readableCopy;
  dom.window.eval(script);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await flush();
  return {
    dom,
    document: dom.window.document,
    calls,
    flush,
    setStatus(value) {
      status = value;
      changed({ type: 'changed' });
    },
  };
}

test('弹窗提供本机产品连接入口，点击只打开自己的设置页', async () => {
  const h = await mount({ connected: false, tasks: [] });
  const opened = [];
  h.dom.window.chrome.runtime.getURL = (file) => `chrome-extension://test/${file}`;
  h.dom.window.chrome.tabs = { create: async (options) => opened.push(options) };
  try {
    const button = h.document.querySelector('#open-products');
    assert.ok(button);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, '产品连接');
    button.click();
    await h.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
      { url: 'chrome-extension://test/product-connections.html' },
    ]);
    assert.equal(
      h.calls.some((call) => call.type?.startsWith('product.')),
      false,
    );
  } finally {
    h.dom.window.close();
  }
});

test('弹窗只展示当前页归属，不展示其他任务或诊断正文', async () => {
  const h = await mount({
    connected: true,
    browserFullConsentStatus: 'disabled',
    tasks: [{ id: 'private', title: '不展示的任务' }],
    tabs: [],
    approvals: [],
  });
  assert.equal(
    h.document.querySelector('#connection-label').getAttribute('aria-label'),
    '本地已连接',
  );
  assert.equal(h.document.querySelector('#access-toggle,#confirm'), null);
  assert.equal(h.document.querySelector('#tasks'), null);
  assert.equal(h.document.querySelector('#diagnostics'), null);
  assert.doesNotMatch(h.document.body.textContent, /不展示的任务/);
  assert.ok(h.calls.some((call) => call.type === 'popup_status'));
  assert.equal(
    h.calls.some((call) => call.type === 'status'),
    false,
  );
  h.dom.window.close();
});

test('连接确认授予任务页直接访问，不再显示权限开关或二次确认', async () => {
  const h = await mount({
    connected: true,
    browserFullConsentStatus: 'disabled',
    tasks: [],
    tabs: [],
  });
  try {
    assert.equal(
      h.document.querySelector('#access-toggle,#confirm,#confirm-enable,#confirm-cancel'),
      null,
    );
    assert.match(h.document.querySelector('#access-detail').textContent, /已连接.*任务页.*直接/);
    assert.doesNotMatch(
      h.document.querySelector('#access-detail').textContent,
      /智能审批|逐项确认|首次读网站确认/,
    );
    assert.equal(
      h.calls.some((call) => call.type === 'browser_consent'),
      false,
    );
  } finally {
    h.dom.window.close();
  }
});

test('连接前说明授权范围，一次连接点击即读取结果，不追加权限确认', async () => {
  const h = await mount({
    connected: false,
    browserFullConsentStatus: 'enabled',
    tasks: [],
    tabs: [],
  });
  try {
    assert.equal(h.document.querySelector('#local-connect').hidden, false);
    assert.match(h.document.querySelector('#access-detail').textContent, /^未连接/);
    assert.match(
      h.document.querySelector('#connection-detail').textContent,
      /确认连接.*允许.*直接.*任务页.*脚本/,
    );
    assert.doesNotMatch(h.document.querySelector('#access-detail').textContent, /已连接|已授权/);
    h.document.querySelector('#local-connect').click();
    await h.flush();
    assert.equal(
      h.document.querySelector('#connection-label').getAttribute('aria-label'),
      '本地已连接',
    );
    assert.equal(h.document.querySelector('#local-connect').hidden, true);
    assert.equal(h.calls.filter((call) => call.type === 'connect').length, 1);
    assert.equal(
      h.calls.some((call) => call.type === 'browser_consent'),
      false,
    );
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：旧宿主仍可能返回云端摘要，但不能恢复已删除的入口、轮询或配对动作。
test('旧云端回执不会恢复配对UI或请求，Esc直接关闭弹窗', async () => {
  const h = await mount({
    connected: true,
    tasks: [],
    cloud: { state: 'active', paired: true, online: true },
  });
  const dispose = h.dom.window.close.bind(h.dom.window);
  try {
    for (const state of ['active', 'offline', 'pending_pairing', 'revoked']) {
      h.setStatus({
        connected: true,
        tasks: [],
        cloud: { state, paired: true, code: 'OBSOLETE-CODE' },
      });
      await h.flush();
      assert.equal(h.document.querySelector('[id^="cloud-"],.cloud-row'), null);
      assert.doesNotMatch(h.document.body.textContent, /OBSOLETE-CODE|云端Agent连接/);
    }
    assert.ok(h.document.querySelector('#local-row'));
    assert.equal(h.document.querySelector('#copilot-toggle'), null);
    assert.equal(
      h.calls.some((call) => call.type.startsWith('cloud_')),
      false,
    );
    let closed = 0;
    h.dom.window.close = () => {
      closed++;
    };
    h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 1);
  } finally {
    dispose();
  }
});

// 中文注释：读取失败必须显示未知，不能把失败读取当成已断开或继续开放控制。
test('状态读取失败时显示未知并禁用页面控制，连接读回恢复后清除过时连接错误', async () => {
  const h = await mount({
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { tabId: 7, taskId: 't', title: '测试页', origin: 'https://example.test' },
    tasks: [{ id: 't', generation: 1, title: '测试任务', state: 'ready' }],
  });
  assert.equal(h.document.querySelector('#page-task').hidden, false);
  const original = h.dom.window.chrome.runtime.sendMessage;
  h.dom.window.chrome.runtime.sendMessage = async () => {
    throw Error('unavailable');
  };
  h.setStatus({});
  await h.flush();
  assert.equal(
    h.document.querySelector('#connection-label').getAttribute('aria-label'),
    '状态待确认',
  );
  assert.match(h.document.querySelector('#access-detail').textContent, /状态待确认/);
  assert.doesNotMatch(
    h.document.querySelector('#access-detail').textContent,
    /已连接|已授权|可由 Fast-browser-link 直接访问/,
  );
  assert.equal(h.document.querySelector('#local-connect').hidden, false);
  assert.equal(h.document.querySelector('#page-task').hidden, true);
  assert.equal(h.document.querySelector('#error-bar').hidden, false);
  h.dom.window.chrome.runtime.sendMessage = original;
  h.setStatus({ connected: true, tasks: [] });
  await h.flush();
  assert.equal(h.document.querySelector('#error-bar').hidden, true);
  h.dom.window.close();
});

test('连接请求暂未就绪但真实状态已恢复时不显示过时连接失败', async () => {
  const h = await mount({ connected: false, tasks: [] });
  try {
    const original = h.dom.window.chrome.runtime.sendMessage;
    h.dom.window.chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'connect') {
        h.setStatus({ connected: true, tasks: [] });
        return { result: { connected: false, lastError: '尚未连接本地桥' } };
      }
      return original(message);
    };
    h.document.querySelector('#local-connect').click();
    await h.flush();
    assert.equal(
      h.document.querySelector('#connection-label').getAttribute('aria-label'),
      '本地已连接',
    );
    assert.equal(h.document.querySelector('#error-bar').hidden, true);
  } finally {
    h.dom.window.close();
  }
});

test('正常刷新或状态失败后重连都不能清除产品设置打开失败的操作错误', async () => {
  const h = await mount({ connected: true, tasks: [] });
  try {
    h.dom.window.chrome.runtime.getURL = (file) => `chrome-extension://test/${file}`;
    h.dom.window.chrome.tabs = {
      create: async () => {
        throw Error('settings unavailable');
      },
    };
    h.document.querySelector('#open-products').click();
    await h.flush();
    h.setStatus({ connected: true, tasks: [] });
    await h.flush();
    assert.equal(h.document.querySelector('#error-bar').hidden, false);
    assert.equal(h.document.querySelector('#error').textContent, 'settings unavailable');
    const original = h.dom.window.chrome.runtime.sendMessage;
    h.dom.window.chrome.runtime.sendMessage = async () => {
      throw Error('disconnected');
    };
    h.setStatus({});
    await h.flush();
    assert.equal(
      h.document.querySelector('#connection-label').getAttribute('aria-label'),
      '状态待确认',
    );
    assert.equal(h.document.querySelector('#error').textContent, 'settings unavailable');
    h.dom.window.chrome.runtime.sendMessage = original;
    h.setStatus({ connected: true, tasks: [] });
    await h.flush();
    assert.equal(h.document.querySelector('#error-bar').hidden, false);
    assert.equal(h.document.querySelector('#error').textContent, 'settings unavailable');
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：新弹窗只保留当前页一行任务状态，模拟鼠标和过滤设置直接展示。
test('授权说明迁入可聚焦提示，无任务时隐藏任务区', async () => {
  const h = await mount({ connected: true, browserFullConsentStatus: 'enabled', tasks: [] });
  try {
    assert.ok(h.document.querySelector('#access-detail').closest('[role=tooltip]'));
    assert.ok(
      h.document
        .querySelector('#local-row .info-button')
        .getAttribute('aria-describedby')
        .includes('access-detail'),
    );
    assert.equal(h.document.querySelector('#filter-toggle'), null);
    assert.equal(h.document.querySelector('#page-task').hidden, true);
    assert.equal(h.document.querySelector('#task-list,#verify-control'), null);
  } finally {
    h.dom.window.close();
  }
});
test('当前任务停止失败后不自动重发，切页也不会误停其他任务', async () => {
  const current = {
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { tabId: 7, taskId: 't' },
    tasks: [{ id: 't', generation: 1, state: 'running' }],
  };
  const h = await mount(current);
  try {
    const base = h.dom.window.chrome.runtime.sendMessage;
    h.dom.window.chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'popup_action') {
        h.calls.push(message);
        throw Error('断线');
      }
      return base(message);
    };
    h.document.querySelector('#stop-task').click();
    h.document.querySelector('#stop-task').click();
    await h.flush();
    assert.equal(h.document.querySelector('#stop-task').disabled, true);
    h.setStatus(current);
    await h.flush();
    assert.equal(h.calls.filter((row) => row.type === 'popup_action').length, 1);
    h.setStatus({ ...current, page: null });
    await h.flush();
    assert.equal(h.document.querySelector('#page-task').hidden, true);
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：两个入口共享状态读回，继续不会创建任务或重发旧动作。
test('弹窗接管变为继续，外部遮罩接管也同步显示继续', async () => {
  const initial = {
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { taskId: 't', tabId: 7 },
    tasks: [{ id: 't', generation: 1, state: 'ready' }],
  };
  const h = await mount(initial);
  try {
    h.document.querySelector('#takeover').click();
    await h.flush();
    assert.equal(h.document.querySelector('#takeover').textContent, '继续');
    assert.equal(h.calls.filter((row) => row.type === 'popup_action').at(-1).kind, 'takeover');
    h.document.querySelector('#takeover').click();
    await h.flush();
    assert.equal(h.document.querySelector('#takeover').textContent, '接管');
    h.setStatus({ ...initial, tasks: [{ id: 't', generation: 1, state: 'paused' }] });
    await h.flush();
    assert.equal(h.document.querySelector('#takeover').textContent, '继续');
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：两个就绪任务的按钮文案相同，验收必须能区分弹窗当前渲染的是哪个任务页。
test('切换同文案任务页时同步更新渲染的任务身份', async () => {
  const first = {
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { taskId: 'a', tabId: 7 },
    tasks: [{ id: 'a', generation: 1, state: 'ready' }],
  };
  const h = await mount(first);
  try {
    const section = h.document.querySelector('#page-task');
    assert.equal(section.dataset.taskId, 'a');
    assert.equal(section.dataset.tabId, '7');
    h.setStatus({
      ...first,
      page: { taskId: 'b', tabId: 8 },
      tasks: [{ id: 'b', generation: 1, state: 'ready' }],
    });
    await h.flush();
    assert.equal(h.document.querySelector('#takeover').textContent, '接管');
    assert.equal(section.dataset.taskId, 'b');
    assert.equal(section.dataset.tabId, '8');
    // 中文注释：旧等待条件在任务乙也会成立；任务身份条件必须阻止对任务甲的误点击。
    assert.equal(
      !section.hidden && h.document.querySelector('#takeover').textContent === '接管',
      true,
    );
    assert.equal(section.dataset.taskId === 'a' && section.dataset.tabId === '7', false);
    h.setStatus({ ...first, page: null, tasks: [] });
    await h.flush();
    assert.equal(section.dataset.taskId, '');
    assert.equal(section.dataset.tabId, '');
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：恢复失败后读回仍为 paused，用户必须能再次显式继续；暂停结果未知时仍可停止任务。
test('继续结果未知但已读回暂停时，继续按钮不能永久禁用', async () => {
  const h = await mount({
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { tabId: 7, taskId: 't' },
    tasks: [{ id: 't', generation: 1, state: 'paused' }],
  });
  try {
    const send = h.dom.window.chrome.runtime.sendMessage;
    h.dom.window.chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'popup_action') {
        h.calls.push(message);
        return { result: { state: 'unknown' } };
      }
      return send(message);
    };
    h.document.querySelector('#takeover').click();
    await h.flush();
    assert.equal(h.document.querySelector('#takeover').textContent, '继续');
    assert.equal(h.document.querySelector('#takeover').disabled, false);
    assert.equal(
      h.calls.filter((row) => row.type === 'popup_action').length,
      1,
      '状态轮询不能自动重试',
    );
    h.document.querySelector('#takeover').click();
    await h.flush();
    assert.equal(h.calls.filter((row) => row.type === 'popup_action').length, 2);
  } finally {
    h.dom.window.close();
  }
});
test('接管结果未知不阻止用户显式停止任务', async () => {
  const h = await mount({
    connected: true,
    browserFullConsentStatus: 'enabled',
    page: { tabId: 7, taskId: 't' },
    tasks: [{ id: 't', generation: 1, state: 'ready' }],
  });
  try {
    const send = h.dom.window.chrome.runtime.sendMessage;
    h.dom.window.chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'popup_action') {
        h.calls.push(message);
        return { result: { state: 'unknown' } };
      }
      return send(message);
    };
    h.document.querySelector('#takeover').click();
    await h.flush();
    assert.equal(h.document.querySelector('#stop-task').disabled, false);
    h.document.querySelector('#stop-task').click();
    h.document.querySelector('#stop-task').click();
    await h.flush();
    assert.equal(h.calls.filter((row) => row.type === 'popup_action').at(-1).kind, 'stop');
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：宿主已冻结但仍在等待在途动作时，不能把页面交出状态显示为已完成。
test('暂停进行中显示等待且只允许停止', async () => {
  const h = await mount({
    connected: true,
    page: { tabId: 7, taskId: 't' },
    tasks: [{ id: 't', generation: 1, state: 'pausing' }],
  });
  try {
    assert.match(h.document.querySelector('#operation').textContent, /正在暂停/);
    assert.equal(h.document.querySelector('#takeover').disabled, true);
    assert.equal(h.document.querySelector('#stop-task').disabled, false);
  } finally {
    h.dom.window.close();
  }
});

// 中文注释：弹窗只保留桌面深链和待确认入口，重开不再读取或重发复制。
// 中文注释：删除的入口不再隐藏在 DOM 或设置折叠区，自动屏蔽仍可单独操作。
test('弹窗仅保留访问说明和自动屏蔽，Cookie 与模拟鼠标和额外区域均移除', async () => {
  const h = await mount({ connected: true, browserFullConsentStatus: 'disabled', tasks: [] });
  assert.equal(
    h.document.querySelector(
      '#cookie-mirror,#cookie-pending,#cookie-desktop,#cursor-toggle,#cursor-label,#shield-settings,#shield-origin,#shield-selectors,#shield-save',
    ),
    null,
  );
  assert.equal(h.document.querySelector('#filter-toggle'), null);
  assert.equal(
    h.calls.some(
      (call) =>
        call.type === 'visual_cursor' ||
        call.type === 'cookie_mirror_pending' ||
        call.type.startsWith('page_content_shield'),
    ),
    false,
  );
  h.dom.window.close();
});
// 中文注释：版本直接来自当前扩展，在后台断开或给出不同版本时也不会变成宿主版本。
test('右上角版本使用当前 manifest，后台断线仍显示版本', async () => {
  const h = await mount({ connected: false, version: '0.0.1', tasks: [] });
  assert.equal(h.document.querySelector('#version-label').textContent, 'v9.8.7');
  assert.ok(h.document.querySelector('.header-meta #version-label'));
  h.setStatus({ connected: true, version: '0.0.2', tasks: [] });
  await h.flush();
  assert.equal(h.document.querySelector('#version-label').textContent, 'v9.8.7');
  h.dom.window.close();
});
test('弹窗不保留过滤开关或规则入口', async () => {
  const h = await mount({ connected: false, tasks: [] });
  assert.equal(h.document.querySelector('#filter-toggle,#filter-label,#shield-settings'), null);
  h.dom.window.close();
});
