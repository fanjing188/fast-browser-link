// 中文注释：真实原生侧栏、扩展及 Native 链路验收；只用临时 profile 和本地合成材料。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession } from '../native-v2/real-session.mjs';
import { CdpClient, fetchJson, waitFor } from '../native-v2/cdp-client.mjs';

if (!process.env.TMPDIR) throw Error('An explicit private TMPDIR is required');
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(process.env.TMPDIR, `native-workbench-evidence-${browser}`);
await mkdir(output, { recursive: true });
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成任务材料</title><h1>本地任务材料</h1><p>此页面只用于验证表格读取与本机任务，不连接任何模型或外部业务。</p><table aria-label="Synthetic revenue"><thead><tr><th>ID</th><th>Amount</th></tr></thead><tbody><tr><td>A</td><td>0</td></tr><tr><td>A</td><td>0</td></tr><tr><td>B</td><td>2</td></tr></tbody></table></html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let session, panel;
const evidence = {
  browser,
  fixture: 'local synthetic data; actual native side panel',
  matrix: [],
  screenshots: [],
};
try {
  session = await openRealSession({ browser, label: 'wb-real', compactScratch: true });
  await session.enableFullAccess();
  const source = await session.ui.evaluate(
    `chrome.tabs.create({url:${JSON.stringify(origin)},active:true}).then(tab=>({id:tab.id,windowId:tab.windowId}))`,
  );
  await session.ui.evaluate(`chrome.windows.update(${source.windowId},{focused:true})`);
  const sourceTarget = await waitFor(async () =>
    (await fetchJson(`${session.base}/json/list`)).find((row) => row.url === origin + '/'),
  );
  const hostWindow = await session.cdp.call('Browser.getWindowForTarget', {
    targetId: sourceTarget.id,
  });
  await session.cdp.call('Browser.setWindowBounds', {
    windowId: hostWindow.windowId,
    bounds: { width: 1600, height: 1100 },
  });
  // 中文注释：使用浏览器原生 sidePanel API，不把普通标签页冒充侧栏；手势仅用于打开测试容器。
  const opened = await session.ui.call('Runtime.evaluate', {
    expression: `chrome.sidePanel.open({windowId:${source.windowId}}).then(()=>true)`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  assert.equal(opened.exceptionDetails, undefined, JSON.stringify(opened));
  const panelURL = `chrome-extension://${session.extensionId}/copilot-panel.html`;
  const target = await waitFor(async () =>
    (await fetchJson(`${session.base}/json/list`)).find((row) => row.url === panelURL),
  );
  panel = new CdpClient(target.webSocketDebuggerUrl);
  await panel.connect();
  assert.equal(
    await session.ui.evaluate(
      `chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.url===${JSON.stringify(panelURL)}))`,
    ),
    false,
    'must be a native side panel, not a tab',
  );
  const command = async (name, params = {}) => {
    const receipt = await panel.evaluate(
      `chrome.runtime.sendMessage({type:'copilot.command',command:${JSON.stringify(name)},params:${JSON.stringify(params)}})`,
    );
    assert.equal(receipt?.error, undefined, JSON.stringify(receipt));
    assert.ok(receipt?.result);
    return receipt.result;
  };
  const click = async (selector, textPattern) => {
    const point = await panel.evaluate(
      `(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=nodes.find(n=>n.getClientRects().length${textPattern ? `&&new RegExp(${JSON.stringify(textPattern)}).test(n.textContent)` : ''});if(!e)throw Error('visible control missing');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await panel.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await panel.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
  };
  const type = async (selector, text) => {
    await click(selector);
    await panel.call('Input.insertText', { text });
  };
  const selectTask = async (task) => {
    await panel.evaluate(
      `(()=>{const e=document.querySelector('.workbench-form select[aria-label]');e.value=${JSON.stringify(task)};e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()`,
    );
  };
  const matrix = async (state, screenshots = false) => {
    for (const width of [320, 375, 480])
      for (const theme of ['light', 'dark']) {
        await panel.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 760,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await panel.call('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        await panel.evaluate(
          `Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{}))).then(()=>true)`,
        );
        const measured = await panel.evaluate(
          `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const dialog=document.querySelector('#task-workbench');const r=dialog.getBoundingClientRect();resolve({width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,dialogWidth:r.width,dialogScrollWidth:dialog.scrollWidth,dialogClientWidth:dialog.clientWidth,dialogOpen:dialog.open,focused:document.activeElement?.tagName})})))`,
        );
        assert.equal(measured.width, width);
        assert.ok(measured.pageWidth <= width + 1, JSON.stringify({ state, theme, ...measured }));
        if (measured.dialogOpen)
          assert.ok(
            measured.dialogScrollWidth <= measured.dialogClientWidth + 1,
            JSON.stringify({ state, theme, ...measured }),
          );
        evidence.matrix.push({ state, theme, ...measured });
        // 中文注释：原生宿主默认约382px宽；超过宿主宽度的headless截图会平铺，480只保留DOM证据。
        if (screenshots && width <= 375) {
          const name = `${state}-${width}-${theme}.png`;
          const shot = await panel.call('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
          });
          const png = Buffer.from(shot.data, 'base64');
          assert.equal(png.readUInt32BE(16), width);
          assert.equal(png.readUInt32BE(20), 760);
          await writeFile(path.join(output, name), png);
          evidence.screenshots.push(name);
        }
      }
  };
  await waitFor(
    () => panel.evaluate(`Boolean(document.querySelector('#pending article button'))`),
    20000,
    { label: '未开启Agent时的任务入口' },
  );
  const initial = await command('state');
  assert.equal(initial.enabled, false);
  const entry = initial.suggestions.find((row) => row.standard_task && row.status === 'pending');
  assert.ok(entry, 'task configuration remains available without Agent');
  assert.ok(
    initial.suggestions.some(
      (row) => row.task_type === 'native.tables' && row.recommendation_state === 'ready',
    ),
    'page tools remain available without Agent',
  );
  const cardSelector = `#pending article[data-id="${entry.id}"] button[data-action="configure_task"]`;
  await matrix('initial', true);
  await click(cardSelector);
  await waitFor(() => panel.evaluate(`document.querySelector('#task-workbench').open`));
  await selectTask('table.clean');
  assert.equal(
    await panel.evaluate(`document.querySelector('.workbench-form button[type=submit]').disabled`),
    true,
  );
  await click('#task-workbench .workbench-toolbar button', '读取页面表格|Read tables');
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelectorAll('.workbench-material').length===1&&!document.querySelector('#task-workbench').hasAttribute('aria-busy')`,
      ),
    15000,
    { label: '原生侧栏读取当前普通页表格' },
  );
  assert.equal(
    await panel.evaluate(`document.querySelector('.workbench-form select[aria-label]').value`),
    'table.clean',
  );
  assert.equal(
    await panel.evaluate(`document.querySelector('.workbench-form button[type=submit]').disabled`),
    false,
  );
  const collected = await command('workbench_state');
  assert.equal(collected.materials.length, 1);
  assert.equal(collected.materials[0].source, origin + '/');
  await matrix('ready-table', true);
  // 中文注释：原生 Escape 必须关闭对话框并恢复可见控件焦点。
  await panel.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await panel.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  assert.equal(await panel.evaluate(`document.querySelector('#task-workbench').open`), false);
  assert.equal(await panel.evaluate(`document.activeElement?.tagName==='BUTTON'`), true);
  const refreshed = await command('state');
  const current = refreshed.suggestions.find(
    (row) => row.params?.task === 'table.clean' && row.status === 'pending',
  );
  assert.ok(current);
  await waitFor(() =>
    panel.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(`#pending article[data-id="${current.id}"] button[data-action="configure_task"]`)}))`,
    ),
  );
  await click(`#pending article[data-id="${current.id}"] button[data-action="configure_task"]`);
  await waitFor(() => panel.evaluate(`document.querySelector('#task-workbench').open`));
  await click('.workbench-form button[type=submit]');
  const settled = await waitFor(
    async () => {
      const state = await command('state');
      const row = state.suggestions.find(
        (item) =>
          item.params?.task === 'table.clean' &&
          ['completed', 'failed', 'stopped'].includes(item.status),
      );
      return row ? { state, row } : null;
    },
    20000,
    { label: '真实Native任务队列完成本机去重' },
  );
  assert.equal(settled.row.status, 'completed', JSON.stringify(settled.row));
  assert.equal(settled.row.model_source, 'local');
  assert.equal(settled.state.enabled, false);
  // 中文注释：状态推送只给轻量摘要，完整记录通过真实结果接口按需回读。
  const finished = await command('result', { id: settled.row.id });
  assert.equal(finished.result.records.length, 2);
  assert.equal(finished.result.records[0].Amount, '0');
  assert.ok(finished.result.artifacts.length);
  evidence.localTask = {
    id: finished.id,
    status: finished.status,
    model_source: finished.model_source,
    records: finished.result.records,
    artifacts: finished.result.artifacts.length,
  };
  await selectTask('page.summary');
  assert.equal(
    await panel.evaluate(`document.querySelector('.workbench-form button[type=submit]').disabled`),
    true,
    'model task must remain blocked without Agent',
  );
  await matrix('agent-required');
  for (const label of ['第二份合成表格'.repeat(18), '第三份合成表格']) {
    await panel.evaluate(`document.querySelector('#task-workbench details').open=true`);
    await type('#task-workbench details input[placeholder]', label);
    await type('#task-workbench details textarea', 'ID,Amount\nA,1\nC,3');
    await click('#task-workbench details button', '加入表格材料|Add table');
    await waitFor(() =>
      panel.evaluate(`!document.querySelector('#task-workbench').hasAttribute('aria-busy')`),
    );
  }
  assert.equal((await command('workbench_state')).materials.length, 3);
  await selectTask('table.compare');
  assert.equal(
    await panel.evaluate(`document.querySelector('.workbench-form button[type=submit]').disabled`),
    true,
    'pairwise task rejects third selected table',
  );
  await matrix('three-table-rejected');
  await panel.call('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 480,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('#task-workbench header button');
  assert.equal(
    await panel.evaluate(`document.querySelector('#task-workbench').open`),
    false,
    'close control stays reachable in a short viewport',
  );
  await click('#tab-results');
  await waitFor(() => panel.evaluate(`document.querySelector('#results').innerText.length>0`));
  await matrix('results');
  await click(`#results article[data-id="${finished.id}"] button[data-action="open_result"]`);
  const detailTarget = await waitFor(async () =>
    (await fetchJson(`${session.base}/json/list`)).find(
      (row) =>
        row.url.startsWith(`chrome-extension://${session.extensionId}/copilot-result.html?`) &&
        new URL(row.url).searchParams.get('id') === finished.id,
    ),
  );
  const detail = new CdpClient(detailTarget.webSocketDebuggerUrl);
  await detail.connect();
  try {
    await waitFor(() =>
      detail.evaluate(
        `document.querySelector('#result-dialog')?.open&&document.querySelector('#result')?.getAttribute('aria-busy')==='false'&&document.querySelector('#result')?.innerText.includes('Amount')`,
      ),
    );
    for (const width of [1440, 375])
      for (const theme of ['light', 'dark']) {
        await detail.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await detail.call('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        await detail.evaluate(
          `Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{}))).then(()=>true)`,
        );
        const measured = await detail.evaluate(
          `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const d=document.querySelector('#result-dialog');resolve({width:innerWidth,pageWidth:document.documentElement.scrollWidth,dialogClientWidth:d.clientWidth,dialogScrollWidth:d.scrollWidth})})))`,
        );
        assert.ok(measured.pageWidth <= width + 1, JSON.stringify(measured));
        assert.ok(
          measured.dialogScrollWidth <= measured.dialogClientWidth + 1,
          JSON.stringify(measured),
        );
        evidence.matrix.push({ state: 'full-result', theme, ...measured });
        const name = `full-result-${width}-${theme}.png`;
        const shot = await detail.call('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        const png = Buffer.from(shot.data, 'base64');
        assert.equal(png.readUInt32BE(16), width);
        assert.equal(png.readUInt32BE(20), 900);
        await writeFile(path.join(output, name), png);
        evidence.screenshots.push(name);
      }
    await detail.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await detail.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await waitFor(
      async () =>
        !(await fetchJson(`${session.base}/json/list`)).some((row) => row.id === detailTarget.id),
    );
  } finally {
    detail.close();
  }
  await click('#open-settings');
  await waitFor(() =>
    panel.evaluate(`document.querySelector('#settings-view').dataset.active==='true'`),
  );
  assert.equal(
    await panel.evaluate(`document.querySelectorAll('#settings-tabs [role=tab]').length`),
    6,
  );
  for (const category of ['general', 'execution', 'export', 'privacy', 'advanced', 'about']) {
    await click(`#settings-tab-${category}`);
    assert.equal(
      await panel.evaluate(
        `document.querySelector('#settings-tabs [aria-selected=true]').dataset.settingsTab`,
      ),
      category,
    );
    await matrix(`settings-${category}`, category === 'general');
  }
  await click('#settings-tab-general');
  await type('#board-name-input', '合成验收工作台');
  assert.notEqual(
    (await command('state')).board_name,
    '合成验收工作台',
    'draft does not auto-save',
  );
  await click('#settings-tab-export');
  await click('#settings-tab-general');
  assert.equal(
    await panel.evaluate(`document.querySelector('#board-name-input').value`),
    '合成验收工作台',
  );
  await click('#settings-save');
  await waitFor(async () => (await command('state')).board_name === '合成验收工作台', 10000, {
    label: '显式保存本次私有夹具的设置草稿',
  });
  await click('#settings-menu-toggle');
  assert.equal(
    await panel.evaluate(
      `document.querySelector('#settings-menu-toggle').getAttribute('aria-expanded')`,
    ),
    'true',
  );
  await click('#settings-menu-toggle');
  await click('#settings-tab-general');
  await panel.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
  });
  await panel.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
  });
  assert.equal(
    await panel.evaluate(
      `document.querySelector('#settings-tabs [aria-selected=true]').dataset.settingsTab`,
    ),
    'about',
  );
  const finalState = await command('state');
  assert.equal(finalState.enabled, false);
  evidence.checked = [
    'actual native side panel (not a tab)',
    'Agent-off local entry',
    'current ordinary-page capture',
    'local queue and complete readback',
    'model task blocked',
    'pairwise material count rejected',
    'native Escape and focus return',
    'short viewport close',
    'long material title',
    '320/375/480 light/dark overflow',
    'full native result dialog, 1440/375 light/dark, Escape closes result tab',
    'six settings categories, cross-category drafts, explicit local save, native End navigation',
  ];
  evidence.screenshotLimit =
    '480px is DOM-only: headless native side-panel surface is narrower and screenshots would tile. 320/375 screenshots use a tall native host window.';
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    `PASS ${browser} native workbench; ${evidence.matrix.length} DOM matrix rows; ${evidence.screenshots.length} screenshots; ${output}`,
  );
} finally {
  panel?.close();
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
