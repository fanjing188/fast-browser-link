// 中文注释：已知独立网页弹窗抢焦点的真实桌面复现；仅临时profile，需要显式 --headed 及用户同意。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';
const exec = promisify(execFile),
  browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const desktop = async () =>
  JSON.parse(
    (
      await exec('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit");var a=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(a.processIdentifier),bundle:ObjC.unwrap(a.bundleIdentifier)})',
      ])
    ).stdout,
  );
if (!process.argv.includes('--headed')) throw Error('真实桌面验收须先获用户同意并显式传 --headed');
const original = await desktop(),
  events = [];
let session,
  timer,
  pending = Promise.resolve(),
  busy = false,
  failure,
  receipts = [];
const server = createServer((req, res) => {
  if (req.url === '/file.csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="file.csv"');
    res.end('id\n1\n');
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      "<button onclick=\"const a=document.createElement('a');a.href='/file.csv';a.download='file.csv';a.click()\">Download</button><button onclick=\"window.open('/popup','fixture','width=450,height=350')\">Popup</button>",
    );
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = path.join(process.env.TMPDIR, `desktop-extra-${browser}`);
await mkdir(output, { recursive: true });
try {
  session = await openRealSession({
    browser,
    headed: true,
    allowPopups: true,
    packageMode: true,
    label: 'dx',
    compactScratch: true,
  });
  await session.enableFullAccess();
  const t = await openTask(session, {
    owner: 'desktop-extra',
    origins: [origin],
    url: origin,
    title: '下载弹窗后台验收',
    activate: false,
  });
  await exec('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("AppKit");$.NSRunningApplication.runningApplicationWithProcessIdentifier(${original.pid}).activateWithOptions(2)`,
  ]);
  for (let i = 0; i < 40; i++) {
    if (
      (await desktop()).pid === original.pid &&
      (await session.ui.evaluate('chrome.windows.getAll().then(ws=>ws.every(w=>!w.focused))'))
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await desktop()).pid, original.pid);
  timer = setInterval(() => {
    if (!busy) {
      busy = true;
      pending = desktop()
        .then((x) => events.push(x))
        .finally(() => (busy = false));
    }
  }, 100);
  for (const [name, kind] of [
    ['Download', 'download'],
    ['Popup', 'popup'],
  ]) {
    const r = await helperCall(
      'script',
      session.work,
      t.owner,
      t.task.id,
      "import json\nprint(json.dumps(run_steps([{'action':'click','name':'" +
        name +
        "','after':{'conditions':[{'kind':'" +
        kind +
        "'}]}}])))",
    );
    assert.equal(r.exit_code, 0, JSON.stringify(r));
    const value = JSON.parse(r.stdout);
    assert.equal(value.completed, true, JSON.stringify(value));
    receipts.push({ name, value });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await desktop()).pid, original.pid, name + ' stole OS focus');
  }
  assert.ok(
    events.every((x) => x.pid === original.pid),
    'transient focus switch ' + JSON.stringify(events),
  );
} catch (e) {
  failure = String(e.stack || e);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await pending;
  await session?.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        browser,
        original,
        after: await desktop(),
        receipts,
        samples: events,
        failure: failure || null,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ browser, passed: receipts.length, failure: failure || null, output }));
