// 中文注释：只在临时 profile 使用合成登录页，不操作个人账号或安装目录。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openRealSession, openTask } from './real-session.mjs';
import { waitFor } from './cdp-client.mjs';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/a') res.end('<h1>A</h1><button onclick="location.href=\'/b\'">Login</button>');
  else if (req.url === '/b')
    res.end(
      '<h1>B</h1><script>setTimeout(()=>window.open("/c","login","width=600,height=500"),500)</script>',
    );
  else res.end('<h1>C</h1><button onclick="window.close()">Return</button>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let session;
async function overlay(tabId, { expand = false } = {}) {
  return session.ui.evaluate(`(async()=>{
  const target={tabId:${tabId}},send=(method,params={})=>chrome.debugger.sendCommand(target,method,params);
  const tree=await send('Page.getFrameTree');
  const world=await send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'fast-automation-overlay'});
  const host=await send('Runtime.evaluate',{contextId:world.executionContextId,expression:'globalThis.__fastAutomationOverlay?.overlay.host',objectGroup:'fixture-overlay'});
  if(!host.result.objectId)return null;
  try{
   const {node}=await send('DOM.describeNode',{objectId:host.result.objectId,depth:1,pierce:true});
   const {object}=await send('DOM.resolveNode',{backendNodeId:node.shadowRoots[0].backendNodeId,executionContextId:world.executionContextId,objectGroup:'fixture-overlay'});
   const result=await send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){const all=this.querySelector("[data-role=all-steps]");if(${expand}&&all&&!all.hidden&&/^(展开|Show)/.test(all.textContent))all.click();return {taskId:globalThis.__fastAutomationOverlay.taskId,steps:this.querySelector("ol").textContent}}',returnByValue:true});
   if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
  }finally{await send('Runtime.releaseObjectGroup',{objectGroup:'fixture-overlay'});}
 })()`);
}

try {
  session = await openRealSession({
    browser: process.argv.includes('--edge') ? 'edge' : 'chrome',
    headed: process.argv.includes('--headed'),
    label: 'login-private',
    allowPopups: true,
    oauthProviders: [{ origin, paths: ['/c'] }],
  });
  await session.enableFullAccess();
  const instance = await session.instance();
  const denied = await session.rpc('private-denied', 'create', {
    title: 'private',
    instance_id: instance.instanceId,
    allowed_origins: [origin],
    incognito: true,
  });
  assert.equal(denied.code, 'incognito_access_required', JSON.stringify(denied));
  console.log('PASS permission denied before task/window creation');
  await session.enableIncognito();
  for (const incognito of [false, true]) {
    const task = await openTask(session, {
      owner: `login-${incognito}`,
      origins: [origin],
      url: `${origin}/a`,
      incognito,
    });
    const tab = await session.ui.evaluate(`chrome.tabs.get(${task.tabId})`);
    assert.equal(tab.incognito, incognito);
    if (!incognito) await task.read("document.cookie='fixture_mode=regular;path=/'");
    else {
      assert.equal(await task.read("document.cookie.includes('fixture_mode=')"), false);
      await task.read("document.cookie='fixture_mode=private;path=/'");
      const normal = await openTask(session, {
        owner: 'cookie-check',
        origins: [origin],
        url: `${origin}/a`,
      });
      assert.equal(await normal.read("document.cookie.includes('fixture_mode=regular')"), true);
      assert.equal(await normal.read("document.cookie.includes('fixture_mode=private')"), false);
      assert.notEqual(
        (await session.ui.evaluate(`chrome.tabs.get(${normal.tabId})`)).windowId,
        tab.windowId,
      );
      await session.rpc(normal.owner, 'close', { task_id: normal.task.id });
    }

    const other = await openTask(session, {
      owner: `peer-${incognito}`,
      origins: [origin],
      url: `${origin}/a`,
      incognito,
    });
    assert.equal(
      (await session.ui.evaluate(`chrome.tabs.get(${other.tabId})`)).windowId,
      tab.windowId,
    );
    await session.rpc(other.owner, 'close', { task_id: other.task.id });
    const loginBefore = await task.ref('Login', ['button']);
    const click = await task.act('ref_click', loginBefore);
    assert.equal(click.error, undefined, JSON.stringify(click));
    const popup = await waitFor(
      async () => {
        const result = await session.ui.evaluate(
          `chrome.runtime.sendMessage({type:'oauth_fixture_diagnostics',taskId:${JSON.stringify(task.task.id)}})`,
        );
        const diagnostic = result.result;
        return (
          diagnostic?.receipts.find((row) => row.result && !row.error) && {
            id: diagnostic.receipts.find((row) => row.result && !row.error).tabId,
          }
        );
      },
      15000,
      { label: '新弹窗加入原任务' },
    );
    const view = await waitFor(async () => {
      const state = await overlay(popup.id);
      return state?.steps.includes('点击') && state;
    }, 10000);
    assert.equal(view.taskId, task.task.id);
    const source = await waitFor(async () => {
      const state = await overlay(task.tabId);
      return state?.steps.includes('点击') && state;
    }, 10000);
    assert.equal(source.taskId, task.task.id);
    assert.equal((await session.ui.evaluate(`chrome.tabs.get(${popup.id})`)).incognito, incognito);
    const snapshot = await task.run('semantic_snapshot', {
      tab_id: popup.id,
      options: { mode: 'interactive', query: 'Return', budget: 1000 },
    });
    assert.ok(snapshot.items.length, JSON.stringify(snapshot));
    await session.ui.evaluate(`chrome.tabs.remove(${popup.id}).then(()=>true)`);
    // 中文注释：跨界面链返回 A 后继续沿同一任务执行；新文档必须重新取得引用。
    const returned = await task.run('navigate', { url: `${origin}/a` });
    assert.equal(returned.tabId, task.tabId);
    const loginAfter = await task.ref('Login', ['button']);
    assert.equal(loginAfter.binding.taskId, task.task.id);
    assert.notEqual(loginAfter.binding.documentId, loginBefore.binding.documentId);
    const returnedPanel = await waitFor(async () => {
      const panel = await overlay(task.tabId, { expand: true });
      return panel?.steps.includes('点击') && panel;
    }, 10000);
    assert.equal(returnedPanel.taskId, task.task.id);
    const state = await session.rpc(task.owner, 'get', { task_id: task.task.id });
    assert.equal(state.id, task.task.id);
    assert.equal(state.state, 'ready');
    await session.rpc(task.owner, 'close', { task_id: task.task.id });
    assert.equal(
      await session.ui.evaluate(
        `chrome.windows.getAll().then(rows=>rows.some(row=>row.id===${tab.windowId}))`,
      ),
      false,
    );
    console.log(
      `PASS incognito=${incognito}: A→B→C→A, shared task ID, fresh return-page reference, popup execution, cookie isolation and cleanup`,
    );
  }
} finally {
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
