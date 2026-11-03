import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
// Manual isolated Edge fixture: TMPDIR=$PWD/.ci/s node tests/v1.1-script-lane/real-loading-overlay-guards.mjs
import { openRealSession, openTask, helperCall } from '../native-v2/real-session.mjs';

const fixture = await readFile(new URL('./loading-overlay-fixture.html', import.meta.url));
const server = createServer((_req, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let session;
let stage = 'start';
try {
  session = await openRealSession({ browser: 'edge', label: 'overlayfix', compactScratch: true });
  await session.enableFullAccess();
  const tab = await openTask(session, {
    owner: 'overlayfix',
    origins: [origin],
    url: `${origin}/?persistent`,
    title: 'local fixture',
  });
  await tab.read(
    "document.querySelector('#target').onclick=()=>{window.__clicks=(window.__clicks||0)+1}",
  );
  const blocked = await helperCall(
    'script',
    session.work,
    tab.owner,
    tab.task.id,
    "click_element('继续', timeout=0.5)",
  );
  assert.notEqual(blocked.exit_code, 0);
  assert.equal(await tab.read('window.__clicks||0'), 0);
  assert.equal(await tab.read("!!document.querySelector('#loading')"), true);
  console.log('persistent=blocked clicks=0 overlay=present');
  await tab.read("setTimeout(()=>document.querySelector('#loading')?.remove(),500);true");
  const resolved = await helperCall(
    'script',
    session.work,
    tab.owner,
    tab.task.id,
    "click_element('继续', timeout=3)",
  );
  assert.equal(resolved.exit_code, 0);
  assert.equal(await tab.read('window.__clicks||0'), 1);
  console.log('natural=clicked clicks=1');
  await tab.read(
    "(()=>{for(const label of ['Straße','Strasse']){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{window.__unicodeClicks=(window.__unicodeClicks||0)+1};document.body.append(b)}return true})()",
  );
  const ambiguous = await helperCall(
    'script',
    session.work,
    tab.owner,
    tab.task.id,
    "click_element('Strasse', timeout=0)",
  );
  assert.notEqual(ambiguous.exit_code, 0);
  assert.equal(await tab.read('window.__unicodeClicks||0'), 0);
  console.log('unicode=ambiguous clicks=0');
  stage = 'epoch_script';
  await tab.read(
    "setTimeout(()=>{const next=document.createElement('html');next.innerHTML='<body><button>Continue</button></body>';document.replaceChild(next,document.documentElement)},1500);true",
  );
  const epochCheck = await helperCall(
    'script',
    session.work,
    tab.owner,
    tab.task.id,
    "import time\nfirst=semantic_snapshot()\ntime.sleep(2.2)\nsecond=semantic_snapshot()\nif first['binding']!=second['binding']: raise RuntimeError('loader_or_lease_changed')\nif first.get('documentEpoch')==second.get('documentEpoch'): raise RuntimeError('epoch_not_rotated')\ntry:\n    semantic_snapshot(_binding=first['binding'],_document_epoch=first['documentEpoch'])\nexcept Exception as error:\n    print('rejected_'+str(getattr(error,'code','unknown')))\nelse:\n    raise RuntimeError('stale_accepted')",
  );
  console.log(`epoch_script_exit=${epochCheck.exit_code}`);
  const epochCode = String(epochCheck.stdout || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 50);
  console.log(`epoch_code=${epochCode}`);
  assert.equal(epochCheck.exit_code, 0);
  assert.equal(epochCode, 'rejected_stale_reference');
  console.log('root_replacement=old_epoch_rejected');
} catch (error) {
  console.log(
    `failure_code=${String(error?.code || error?.name || 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40)} stage=${stage}`,
  );
  process.exitCode = 1;
} finally {
  await session?.close();
  await new Promise((resolve) => server.close(resolve));
}
