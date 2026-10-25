// 中文注释：手动无头验收，只操作临时profile、本地合成页面和实际安装包。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from './real-session.mjs';
import { CdpClient, fetchJson, waitFor } from './cdp-client.mjs';

const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
for (const option of process.argv.slice(2)) assert.ok(['--edge'].includes(option));
assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
assert.ok(!['/tmp', '/private/tmp'].includes(process.env.TMPDIR));
const output = await mkdtemp(path.join(process.env.TMPDIR, `page-export-${browser}-`));
const report = { browser, passed: false, output, checks: [] };
let session, page, preview, exportedDirectory;
let originRequests = 0,
  previewMissing = 0;
const clients = [];
const requests = [];
const source = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page export synthetic fixture</title><link rel="stylesheet" href="/theme.css">
<h1 id="heading">Initial server HTML</h1><p id="encoding">离线中文</p><img id="image" src="/image.svg" width="40" height="40" alt="Synthetic image">
<label>Private draft<input id="draft"></label><label>Private note<textarea id="note"></textarea></label>
<form id="offline-form" action="/export-submit"><button>Submit synthetic form</button></form>
<div id="editable" contenteditable="true"></div><div id="shadow"></div>
<iframe src="/frame" title="Synthetic frame"></iframe><script src="/app.js"></script>`;
const assets = {
  '/theme.css': [
    'text/css',
    'h1{color:rgb(24,88,149)}body{font:16px/1.5 system-ui;padding:24px}input,textarea{display:block;margin:12px 0}',
  ],
  '/app.js': [
    'application/javascript',
    `document.querySelector('#heading').textContent='Rendered ready';window.exportFixtureMarker=crypto.randomUUID();document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span>Open shadow fixture</span>';`,
  ],
  '/image.svg': [
    'image/svg+xml',
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#185895"/></svg>',
  ],
  '/frame': ['text/html', '<!doctype html><p>Nested frame fixture</p>'],
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.test');
    // 中文注释：浏览器自身的图标探测不是被测页面资源，不污染“导出不重新请求原站”的计数。
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith('/offline/')) {
      if (!exportedDirectory) {
        res.writeHead(404).end();
        return;
      }
      const relative = decodeURIComponent(url.pathname.slice('/offline/'.length));
      const target = path.resolve(exportedDirectory, relative);
      if (!target.startsWith(exportedDirectory + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      let data;
      try {
        data = await readFile(target);
      } catch {
        previewMissing++;
        res.writeHead(404).end();
        return;
      }
      const types = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.png': 'image/png',
      };
      res.setHeader('content-type', types[path.extname(target)] || 'application/octet-stream');
      res.end(data);
      return;
    }
    originRequests++;
    requests.push(url.pathname);
    if (url.pathname === '/page') {
      res.setHeader('content-type', 'text/html');
      res.end(source);
      return;
    }
    const asset = assets[url.pathname];
    if (asset) {
      res.setHeader('content-type', asset[0]);
      res.end(asset[1]);
      return;
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const connect = async (tabId, expectedUrl) => {
  // 中文注释：新标签回执可早于首次导航，持续核同一tab，不能冻结空URL等待不存在的目标。
  const target = await waitFor(async () => {
    const tab = await session.ui.evaluate(
      `chrome.tabs.get(${tabId}).then(t=>({id:t.id,url:t.url}))`,
    );
    if (!tab.url || (expectedUrl && tab.url !== expectedUrl)) return null;
    return (await fetchJson(`${session.base}/json/list`)).find(
      (row) => row.type === 'page' && row.url === tab.url,
    );
  });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  clients.push(client);
  return client;
};
try {
  session = await openRealSession({
    browser,
    packageMode: true,
    label: 'export',
    compactScratch: true,
    headed: false,
  });
  await session.enableFullAccess();
  const owner = 'page-export-fixture';
  const task = await openTask(session, {
    owner,
    origins: [origin],
    url: `${origin}/page`,
    title: 'Synthetic page export',
  });
  page = await connect(task.tabId);
  await waitFor(() =>
    page.evaluate(
      "document.readyState==='complete'&&document.querySelector('#heading')?.textContent==='Rendered ready'&&window.exportFixtureMarker&&document.querySelector('#image').complete&&document.styleSheets.length>0",
    ),
  );
  // 中文注释：SVG命名空间节点在活页不导航；离线HTML重解析也不得提升为刷新导航。
  await page.evaluate(
    `(()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),meta=document.createElementNS(svg.namespaceURI,'meta');meta.setAttribute('HTTP-EQUIV','refresh');meta.setAttribute('content','0;url=/export-navigation-escape');svg.append(meta);document.body.append(svg);document.querySelector('meta[charset]').setAttribute('charset','gbk');const style=document.createElement('style');style.textContent='@media print{body{background-image:image-set("/package-external-probe.svg" 1x)}}';document.head.append(style);return true})()`,
  );
  const sentinel = 'SYNTHETIC_RUNTIME_FORM_VALUE_82';
  await page.evaluate("document.documentElement.setAttribute('data-state','x'.repeat(1100))");
  await page.evaluate('document.body.prepend(document.head);true');
  // 中文注释：仅准备本地合成输入夹具；被测导出仍走实际安装版helper，不代换读取/序列化实现。
  await page.evaluate(
    `(()=>{for(const id of ['draft','note'])document.getElementById(id).value=${JSON.stringify(sentinel)};document.querySelector('#editable').textContent=${JSON.stringify(sentinel)};return true})()`,
  );
  const before = await page.evaluate(
    "({url:location.href,marker:window.exportFixtureMarker,draft:document.querySelector('#draft').value,note:document.querySelector('#note').value,editable:document.querySelector('#editable').textContent})",
  );

  const requestsBefore = originRequests;
  const zipPath = path.join(output, 'page.zip');
  const previousRoots = process.env.FAST_BROWSER_EXPORT_ROOTS;
  process.env.FAST_BROWSER_EXPORT_ROOTS = output;
  let result;
  try {
    result = await helperCall(
      'script',
      session.work,
      owner,
      task.task.id,
      `import json\ncdp('Runtime.enable', tab=${task.tabId})\ncdp('Debugger.enable', tab=${task.tabId})\nexport_page(${JSON.stringify(path.join(output, 'first.zip'))}, tab=${task.tabId})\nprint(json.dumps(export_page(${JSON.stringify(zipPath)}, tab=${task.tabId})))`,
      '',
    );
  } finally {
    if (previousRoots === undefined) delete process.env.FAST_BROWSER_EXPORT_ROOTS;
    else process.env.FAST_BROWSER_EXPORT_ROOTS = previousRoots;
  }
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.equal(result.execution_complete, true, JSON.stringify(result));
  const receipt = JSON.parse(result.stdout.trim());
  await save('requests.json', { before: requestsBefore, requests });
  assert.equal(typeof receipt === 'string' ? receipt : receipt.path, zipPath);
  assert.equal(originRequests, requestsBefore, 'Export must not refetch resources or reload');
  assert.deepEqual(
    await page.evaluate(
      "({url:location.href,marker:window.exportFixtureMarker,draft:document.querySelector('#draft').value,note:document.querySelector('#note').value,editable:document.querySelector('#editable').textContent})",
    ),
    before,
  );
  report.checks.push(
    'actual packaged helper exports through Native/script/CDP without refetch/navigation or changing live form values',
  );
  await save('receipt.json', receipt);
  const inspect = await helperCall(
    'script',
    session.work,
    owner,
    task.task.id,
    `import json,zipfile,pathlib,stat,hashlib\np=pathlib.Path(${JSON.stringify(zipPath)})\ntarget=p.parent/'unpacked'\nwith zipfile.ZipFile(p) as z:\n assert z.testzip() is None\n names=z.namelist()\n assert 'index.html' in names and 'manifest.json' in names\n for i in z.infolist():\n  q=pathlib.PurePosixPath(i.filename)\n  assert not q.is_absolute() and '..' not in q.parts and not stat.S_ISLNK(i.external_attr >> 16)\n html=z.read('index.html').decode()\n assert 'Rendered ready' in html and ${JSON.stringify(sentinel)} not in html\n assert 'Content-Security-Policy' in html\n manifest=json.loads(z.read('manifest.json'))\n for kind in ['Script','Stylesheet','Image']:\n  assert any(row['type']==kind and row['status']=='exported' and z.read(row['path']) for row in manifest['resources']), kind\n for member in manifest['members']:\n  assert hashlib.sha256(z.read(member['path'])).hexdigest()==member['sha256']\n z.extractall(target)\n print(json.dumps({'directory':str(target),'files':len(names),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'manifest':manifest}))`,
    '',
  );
  assert.equal(inspect.exit_code, 0, JSON.stringify(inspect));
  const integrity = JSON.parse(inspect.stdout.trim());
  exportedDirectory = integrity.directory;
  await save('archive.json', integrity);
  report.checks.push(
    'actual ZIP CRC/layout and rendered HTML, CSS, JS/image contents; runtime input values excluded',
  );
  const closed = await session.rpc(owner, 'close', { task_id: task.task.id });
  assert.equal(closed.state, 'closed', JSON.stringify(closed));
  const previewTab = await session.ui.evaluate(
    `chrome.tabs.create({url:${JSON.stringify(origin + '/offline/index.html')},active:false}).then(t=>({id:t.id}))`,
  );
  preview = await connect(previewTab.id, origin + '/offline/index.html');
  await waitFor(() =>
    preview.evaluate(
      "document.readyState==='complete'&&document.querySelector('#heading')?.textContent==='Rendered ready'",
    ),
  );
  assert.equal(
    await preview.evaluate('window.exportFixtureMarker===undefined'),
    true,
    'Exported JS must not execute',
  );
  assert.equal(
    await preview.evaluate("document.querySelector('#encoding')?.textContent"),
    '离线中文',
  );
  assert.equal(
    await preview.evaluate("document.querySelector('meta[http-equiv=refresh]')===null"),
    true,
  );
  assert.equal(
    await preview.evaluate(
      'document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.parentElement===document.head',
    ),
    true,
  );
  await preview.evaluate(
    "window.offlineFormBlocked=false;document.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='form-action')window.offlineFormBlocked=true});document.querySelector('#offline-form').requestSubmit();true",
  );
  await waitFor(() => preview.evaluate('window.offlineFormBlocked===true'));
  assert.equal(await preview.evaluate('location.pathname'), '/offline/index.html');
  await waitFor(() =>
    preview.evaluate(
      "getComputedStyle(document.querySelector('#heading')).color==='rgb(24, 88, 149)'&&document.querySelector('#image').naturalWidth===40",
    ),
  );
  await preview.call('Emulation.setEmulatedMedia', { media: 'print' });
  await waitFor(() => preview.evaluate("getComputedStyle(document.body).backgroundImage==='none'"));
  await preview.call('Emulation.setEmulatedMedia', { media: 'screen' });
  assert.equal(originRequests, requestsBefore, 'Offline preview must not load original URLs');
  assert.equal(previewMissing, 0, 'Offline preview must reference existing archive assets');
  report.previewMissing = previewMissing;
  report.checks.push(
    'offline preview restores rendered content, cached CSS and image; scripts and original-site network requests remain disabled',
  );
  for (const width of [1440, 375]) {
    await preview.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width === 375,
    });
    const shot = await preview.call('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    assert.equal(png.readUInt32BE(16), width);
    await writeFile(path.join(output, `preview-${width}.png`), png);
  }
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  try {
    await session?.close();
  } catch (error) {
    report.cleanupError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await save('result.json', report);
  console.log(JSON.stringify(report, null, 2));
}
