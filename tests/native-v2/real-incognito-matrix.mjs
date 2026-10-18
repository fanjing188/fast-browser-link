// 中文注释：仅用临时 Chrome/Edge profile 和合成数据逐项回读，无个人账号、付款或真实凭据。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { openRealSession, openTask, helperCall, sha256 } from './real-session.mjs';
import { waitFor } from './cdp-client.mjs';
const exec = promisify(execFile),
  browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
const uploadBodies = [],
  slowResponses = new Set(),
  downloadBytes = Buffer.from('incognito-download-fixture\n');
const fixture = `<!doctype html><meta charset="utf-8"><title>Incognito capability matrix</title>
<style>body{font:16px sans-serif}input,button,select{margin:8px}#bottom{margin-top:1500px}</style>
<h1>Capability fixture</h1><label>Draft<input id="draft"></label><button id="apply" onclick="document.querySelector('#result').textContent=document.querySelector('#draft').value">Apply</button><output id="result">empty</output>
<label><input type="checkbox" id="check">Accept fixture</label><label>Choice<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<div id="drag" style="display:inline-block;width:90px;height:45px;background:#ddd" onpointerdown="document.body.dataset.dragStarted='yes'">Drag source</div><div id="drop" style="display:inline-block;width:90px;height:45px;background:#ccc" onpointerup="if(document.body.dataset.dragStarted)document.body.dataset.dragged='done'">Drop target</div><input id="file" type="file" aria-label="Upload fixture"><output id="uploaded">none</output>
<a href="/download" download="fixture.txt">Download fixture</a><a href="/slow" download="slow.bin">Slow fixture</a>
<iframe id="same" title="Same frame" src="/child"></iframe><iframe title="Cross frame" src="http://frame.test:__PORT__/child"></iframe>
<button id="dialog" onclick="document.querySelector('#result').textContent=confirm('Synthetic confirmation')?'accepted':'declined'">Dialog fixture</button>
<label>Password<input id="password" type="password"></label><label>OTP<input id="otp" autocomplete="one-time-code"></label><label>Card<input id="card" autocomplete="cc-number"></label>
<div id="bottom">Bottom fixture</div><script>document.querySelector('#file').onchange=async e=>{const r=await fetch('/upload',{method:'POST',body:e.target.files[0]});document.querySelector('#uploaded').textContent=await r.text()};document.querySelector('#draft').onkeydown=e=>{if(e.key==='Enter')document.querySelector('#result').textContent='pressed'};</script>`;
const server = createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="fixture.txt"',
    });
    res.end(downloadBytes);
    return;
  }
  if (req.url === '/slow') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="slow.bin"',
      'Content-Length': 10000000,
    });
    slowResponses.add(res);
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 100);
    res.on('close', () => {
      clearInterval(timer);
      slowResponses.delete(res);
    });
    return;
  }
  if (req.url === '/upload') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      uploadBodies.push(Buffer.concat(chunks));
      res.end('upload received');
    });
    return;
  }
  if (req.url === '/api') {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"fixture":true,"items":[1,2,3]}');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/child') {
    res.end('<button onclick="this.textContent=\'Frame done\'">Frame action</button>');
    return;
  }
  res.end(fixture.replaceAll('__PORT__', String(server.address().port)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`,
  cross = `http://frame.test:${server.address().port}`,
  passed = [];
let session, t;
function ok(value) {
  assert.equal(value?.error, undefined, JSON.stringify(value));
  return value;
}
async function check(name, work) {
  await work();
  passed.push(name);
  console.log('PASS', name);
}
try {
  session = await openRealSession({
    browser,
    label: 'private-matrix',
    headed: process.argv.includes('--headed'),
    packageMode: process.argv.includes('--package'),
    hostRules: 'MAP frame.test 127.0.0.1',
  });
  await session.enableFullAccess();
  await session.enableIncognito();
  t = await openTask(session, {
    owner: 'private-matrix',
    origins: [origin, cross],
    url: origin,
    incognito: true,
  });
  await check('incognito tab identity', async () =>
    assert.equal((await session.ui.evaluate(`chrome.tabs.get(${t.tabId})`)).incognito, true),
  );

  await check('semantic and structured page reads', async () => {
    assert.ok((await t.run('semantic_snapshot')).items.length);
    assert.equal(
      ok(await t.run('page.parse', { options: { sections: ['forms'], budget: 5000 } }))
        .schemaVersion,
      1,
    );
  });
  await check('fill / press / click / checkbox / select', async () => {
    ok(await t.act('ref_fill', await t.ref('Draft', ['textbox']), { text: 'synthetic-text' }));
    assert.equal(await t.read('document.querySelector("#draft").value'), 'synthetic-text');
    ok(await t.act('ref_press', await t.ref('Draft', ['textbox']), { key: 'Enter' }));
    assert.equal(await t.read('document.querySelector("#result").textContent'), 'pressed');
    ok(await t.act('ref_click', await t.ref('Apply', ['button'])));
    assert.equal(await t.read('document.querySelector("#result").textContent'), 'synthetic-text');
    ok(
      await t.act('ref_set_checked', await t.ref('Accept fixture', ['checkbox']), {
        checked: true,
      }),
    );
    assert.equal(await t.read('document.querySelector("#check").checked'), true);
    ok(
      await t.act('ref_select_option', await t.ref('Choice', ['combobox']), {
        by: 'value',
        values: ['b'],
      }),
    );
    assert.equal(await t.read('document.querySelector("#choice").value'), 'b');
  });
  await check('local upload received by server', async () => {
    const file = path.join(session.work, 'fixture-upload.txt'),
      bytes = Buffer.from('incognito-upload-fixture');
    await writeFile(file, bytes);
    assert.equal(
      ok(await t.run('files.upload', { selector: '#file', paths: [file] })).selectedCount,
      1,
    );
    await waitFor(() => uploadBodies.length === 1);
    assert.equal(sha256(uploadBodies[0]), sha256(bytes));
    assert.equal(
      await t.read('document.querySelector("#uploaded").textContent'),
      'upload received',
    );
  });
  const dl = (args = {}) => session.rpc(t.owner, 'downloads', { task_id: t.task.id, ...args });
  if (!process.argv.includes('--core-only')) {
    await check('download attribution / claim / hash', async () => {
      ok(
        await t.act('ref_click', await t.ref('Download fixture', ['link']), {
          clickMode: 'pointer',
        }),
      );
      let row;
      try {
        row = await waitFor(
          async () => (await dl()).downloads?.find((row) => row.state === 'complete'),
          120000,
          { label: 'incognito download complete' },
        );
      } catch (error) {
        console.log(
          'download diagnostics',
          JSON.stringify(await dl()),
          await session.ui.evaluate(
            'chrome.downloads.search({}).then(rows=>rows.map(({id,state,error,filename,incognito})=>({id,state,error,filename,incognito})))',
          ),
          await t.run('cdp.events', { max: 30 }),
        );
        throw error;
      }
      const claimed = ok(await dl({ action: 'claim', download_id: row.id }));
      assert.equal(claimed.sha256, sha256(downloadBytes));
      assert.equal(sha256(await readFile(claimed.localPath)), sha256(downloadBytes));
    });
    await check('download cancellation', async () => {
      ok(await t.act('ref_click', await t.ref('Slow fixture', ['link']), { clickMode: 'pointer' }));
      const row = await waitFor(
        async () => (await dl()).downloads?.find((row) => row.state === 'in_progress'),
        15000,
      );
      assert.equal(ok(await dl({ action: 'cancel', download_id: row.id })).state, 'cancelled');
    });
  }
  await check('same-origin and cross-origin frames', async () => {
    const same = await t.ref('Frame action', ['button'], { root: '#same', composed: true });
    ok(await t.act('ref_click', same));
    assert.equal(
      await t.read(
        'document.querySelector("#same").contentDocument.querySelector("button").textContent',
      ),
      'Frame done',
    );
    const frame = (await t.run('frame_catalog')).frames.find((row) => row.origin === cross);
    assert.equal(frame.access, 'ready');
    const snap = ok(
      await t.run('semantic_snapshot', {
        options: {
          frameToken: frame.frameToken,
          mode: 'interactive',
          query: 'Frame action',
          budget: 1500,
        },
      }),
    );
    ok(
      await t.run('ref_click', {
        binding: snap.binding,
        snapshot_id: snap.snapshotId,
        ref: snap.items[0].ref,
        frame_token: frame.frameToken,
      }),
    );
    const after = ok(
      await t.run('semantic_snapshot', {
        options: {
          frameToken: frame.frameToken,
          mode: 'interactive',
          query: 'Frame done',
          budget: 1500,
        },
      }),
    );
    assert.equal(after.items[0].name, 'Frame done');
  });
  await check('screenshot / coordinate capture / scroll', async () => {
    assert.ok(ok(await t.run('screenshot')).data.length > 100);
    const shot = ok(await t.run('interaction.capture'));
    const target = ok(
      await t.run('interaction.bounds', { screenshot_id: shot.id, selector: '#apply' }),
    );
    ok(
      await t.run('interaction.click', {
        screenshot_id: shot.id,
        point: target.imageCenter,
        expected_ref: target.ref,
      }),
    );
    ok(await t.run('scroll', { direction: 'down' }));
    assert.ok(await t.read('scrollY>0'));
    ok(await t.run('scroll', { direction: 'up' }));
  });
  await check('pointer drag', async () => {
    const shot = ok(await t.run('interaction.capture'));
    for (const selector of ['#drag', '#drop'])
      ok(await t.run('interaction.bounds', { screenshot_id: shot.id, selector }));
    ok(
      await t.run('interaction.drag_elements', {
        screenshot_id: shot.id,
        source: '#drag',
        target: '#drop',
        mode: 'pointer',
      }),
    );
    assert.equal(await t.read('document.body.dataset.dragged'), 'done');
  });
  await check('page JavaScript and raw CDP', async () => {
    assert.equal(ok(await t.run('js.evaluate', { expression: '21*2' })).value, 42);
    assert.equal(
      ok(
        await t.run('cdp.send', {
          method: 'Runtime.evaluate',
          cdp_params: { expression: 'document.title', returnByValue: true },
        }),
      ).result.value,
      'Incognito capability matrix',
    );
  });
  await check('Python workflow / network capture', async () => {
    const result = await helperCall(
      'script',
      session.work,
      t.owner,
      t.task.id,
      "assert wait_for('#apply', timeout=5)['satisfied']\ncap=network_start()\nassert evaluate('()=>fetch(\"/api\").then(r=>r.json())')['fixture']\nrows=network_list(cap['captureId'], filter='/api')['entries']\nassert rows\nassert 'fixture' in network_detail(cap['captureId'], rows[0]['seq'])['body']['text']\nnetwork_stop()\nprint('PRIVATE_SCRIPT_OK')",
    );
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.match(result.stdout, /PRIVATE_SCRIPT_OK/);
  });
  await check('dialog dismissal', async () => {
    await t.read('setTimeout(()=>document.querySelector("#dialog").click(),100);true');
    await waitFor(async () => {
      const r = await t.run('dialog', { accept: false });
      if (r.error) {
        assert.equal(r.bridgeCode, 'no_dialog', JSON.stringify(r));
        return false;
      }
      return true;
    });
    assert.equal(await t.read('document.querySelector("#result").textContent'), 'declined');
  });
  await check('takeover / resume', async () => {
    const control = (kind) =>
      session.ui.evaluate(
        `chrome.runtime.sendMessage({type:'popup_action',taskId:${JSON.stringify(t.task.id)},generation:${t.task.generation},tabId:${t.tabId},kind:${JSON.stringify(kind)}})`,
      );
    assert.equal((await control('takeover')).result.verified, true);
    assert.equal((await t.run('semantic_snapshot')).code, 'task_paused');
    assert.equal((await control('resume')).result.verified, true);
    assert.ok(ok(await t.run('semantic_snapshot')).items.length);
  });
  await check('multiple tabs / navigation / back', async () => {
    const second = ok(await t.run('new_tab', { url: origin + '/second' }));
    assert.equal((await t.run('tabs')).length, 2);
    ok(await t.run('navigate', { url: origin + '/next' }));
    assert.equal(await t.read('location.pathname'), '/next');
    ok(await t.run('back'));
    assert.equal(await t.read('location.pathname'), '/');
    assert.equal((await session.ui.evaluate(`chrome.tabs.get(${second.tabId})`)).incognito, true);
  });
  await check('password / OTP / payment manual-input boundary', async () => {
    for (const name of ['Password', 'OTP', 'Card']) {
      const response = await t.act('ref_fill', await t.ref(name, ['textbox']), {
        text: 'synthetic-only',
      });
      assert.equal(response.status, 'user_input_required', JSON.stringify(response));
    }
    assert.equal(
      await t.read('[...document.querySelectorAll("#password,#otp,#card")].every(e=>e.value==="")'),
      true,
    );
  });
  await check('task close and revoked action', async () => {
    const closed = ok(await session.rpc(t.owner, 'close', { task_id: t.task.id }));
    assert.equal(closed.state, 'closed');
    assert.equal(closed.cleanupState, 'succeeded');
    assert.equal((await t.run('js.evaluate', { expression: '1' })).bridgeCode, 'task_closed');
  });
  // 中文注释：独立入口另外建立自身身份，验证它自己的无痕下载命令与保留页面合同。
  if (!process.argv.includes('--core-only'))
    await check('independent CLI downloads / handoff', async () => {
      const cli = path.resolve(import.meta.dirname, '../../agent-link/fast_browser_link.py'),
        identity = path.join(session.work, 'cli.session');
      const invoke = async (operation, params = {}) => {
        const { stdout } = await exec(
          'python3',
          [cli, '--session', identity, operation, JSON.stringify(params)],
          {
            env: { ...process.env, FAST_BROWSER_LINK_HOME: session.staged.hermesHome },
            timeout: 65000,
          },
        );
        return JSON.parse(stdout);
      };
      const task = await invoke('create', {
        title: 'CLI private download',
        instanceId: (await session.instance()).instanceId,
        allowedOrigins: [origin],
        incognito: true,
      });
      await waitFor(async () => (await invoke('get', { taskId: task.id })).state === 'ready');
      const page = await invoke('run', { taskId: task.id, action: 'new_tab', url: origin });
      const snap = await invoke('run', {
        taskId: task.id,
        tabId: page.tabId,
        action: 'semantic_snapshot',
        options: { query: 'Download fixture', mode: 'interactive', budget: 1500 },
      });
      await invoke('run', {
        taskId: task.id,
        tabId: page.tabId,
        action: 'ref_click',
        binding: snap.binding,
        snapshotId: snap.snapshotId,
        ref: snap.items[0].ref,
      });
      const row = await waitFor(
        async () =>
          (await invoke('downloads', { taskId: task.id })).downloads.find(
            (row) => row.state === 'complete',
          ),
        120000,
      );
      const claim = await invoke('download_claim', { taskId: task.id, downloadId: row.id });
      assert.equal(claim.sha256, sha256(downloadBytes));
      const close = await invoke('close', {
        taskId: task.id,
        keepTabs: true,
        handoffReason: 'user_requested',
      });
      assert.equal(close.cleanupState, 'succeeded');
      assert.equal((await session.ui.evaluate(`chrome.tabs.get(${page.tabId})`)).incognito, true);
      await session.ui.evaluate(`chrome.tabs.remove(${page.tabId}).then(()=>true)`);
    });
  const dir = path.join(import.meta.dirname, 'evidence');
  await mkdir(dir, { recursive: true });
  const report = {
    browser,
    scope: process.argv.includes('--core-only') ? 'core-without-downloads' : 'full',
    version: JSON.parse(
      await readFile(path.join(session.work, 'dist-native/manifest.json'), 'utf8').catch(() =>
        readFile(path.join(session.work, 'package/native-extension/manifest.json'), 'utf8'),
      ),
    ).version,
    passed,
    profile: 'temporary',
    packageMode: process.argv.includes('--package'),
    notClaimed: [
      'third-party website acceptance',
      'incognito Cookie mirror',
      'real payment or OTP submission',
      'external password manager unlock',
    ],
  };
  await writeFile(
    path.join(
      dir,
      `incognito-matrix-${browser}${process.argv.includes('--core-only') ? '-core' : ''}.json`,
    ),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  for (const res of slowResponses) res.destroy();
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
