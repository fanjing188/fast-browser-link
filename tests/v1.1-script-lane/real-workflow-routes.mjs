import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
// 中文注释：SDK/CLI/MCP 真实链路只连接本地临时浏览器，必须显式设置私有 TMPDIR。
import { openRealSession } from '../native-v2/real-session.mjs';
const exec = promisify(execFile),
  root = path.resolve(import.meta.dirname, '../..'),
  py = process.env.HERMES_PYTHON;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<button id="ping" onclick="this.textContent=\'Done\'">Ping</button>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
let session, mcp;
const results = [];
try {
  session = await openRealSession({
    browser: 'chrome',
    packageMode: true,
    label: 'rt',
    compactScratch: true,
  });
  await session.enableFullAccess();
  const home = session.staged.hermesHome,
    env = {
      ...process.env,
      FAST_BROWSER_LINK_HOME: home,
      HERMES_HOME: home,
      PYTHONDONTWRITEBYTECODE: '1',
    };
  const entry = path.join(root, 'agent-link/fast_browser_link.py'),
    file = path.join(session.work, 'cli-session');
  async function cli(operation, params) {
    const r = await exec(py, [entry, '--session', file, operation, JSON.stringify(params)], {
      env,
      timeout: 90000,
    });
    return JSON.parse(r.stdout);
  }
  const instance = (await cli('browsers', {})).find((b) => b.connected).instanceId;
  const created = await cli('create', {
    instanceId: instance,
    title: 'CLI workflow',
    allowedOrigins: [url],
  });
  const id = created.task?.id || created.id;
  assert.ok(id, JSON.stringify(created));
  for (let i = 0; i < 40; i++) {
    if ((await cli('get', { taskId: id })).state === 'ready') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = `import json\nnew_tab(${JSON.stringify(url)})\nprint(json.dumps(run_steps([{'action':'click','name':'Ping','after':{'conditions':[{'kind':'element','selector':'#ping','state':'text','text':'Done'}]}}])))`;
  const out = await cli('script', { taskId: id, code });
  assert.equal(out.exit_code, 0, JSON.stringify(out));
  assert.equal(JSON.parse(out.stdout).completed, true);
  await cli('close', { taskId: id });
  results.push('CLI');
  mcp = spawn(py, [entry, '--mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 1;
  createInterface({ input: mcp.stdout }).on('line', (line) => {
    const r = JSON.parse(line);
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  async function request(method, params) {
    const id = next++;
    const promise = new Promise((r) => pending.set(id, r));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const r = await promise;
    assert.ok(!r.error, JSON.stringify(r));
    return r.result;
  }
  async function tool(operation, params) {
    const r = await request('tools/call', {
      name: 'fast_browser_link',
      arguments: { operation, params },
    });
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  }
  await request('initialize', {});
  const second = await tool('create', {
    instanceId: instance,
    title: 'MCP workflow',
    allowedOrigins: [url],
  });
  const mid = second.task?.id || second.id;
  for (let i = 0; i < 40; i++) {
    if ((await tool('get', { taskId: mid })).state === 'ready') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const mr = await tool('script', { taskId: mid, code });
  assert.equal(mr.exit_code, 0, JSON.stringify(mr));
  assert.equal(JSON.parse(mr.stdout).completed, true);
  await tool('close', { taskId: mid });
  results.push('MCP');
  mcp.stdin.end();
  const sdkcode = `import importlib.util,json,time\nspec=importlib.util.spec_from_file_location('sdk',${JSON.stringify(path.join(root, 'native-bridge/browser_sdk.py'))})\nsdk=importlib.util.module_from_spec(spec);spec.loader.exec_module(sdk)\nwith sdk.Browser(home=${JSON.stringify(home)}) as b:\n    t=b.call('create',{'instanceId':${JSON.stringify(instance)},'title':'SDK workflow','allowedOrigins':[${JSON.stringify(url)}]})\n    ident=t.get('id') or t['task']['id']\n    for _ in range(40):\n        if b.call('get',{'taskId':ident})['state']=='ready': break\n        time.sleep(.1)\n    r=b.call('script',{'taskId':ident,'code':${JSON.stringify(code)}})\n    assert r['exit_code']==0,r\n    assert json.loads(r['stdout'])['completed'],r\n    b.call('close',{'taskId':ident})\nprint(json.dumps({'ok':True}))`;
  const sr = await exec(py, ['-c', sdkcode], { env, timeout: 90000 });
  assert.equal(JSON.parse(sr.stdout).ok, true);
  results.push('SDK');
} finally {
  mcp?.stdin.end();
  await session?.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    path.join(process.env.TMPDIR, 'workflow-routes.json'),
    JSON.stringify({ results }, null, 2),
  );
}
console.log(JSON.stringify({ results }));
