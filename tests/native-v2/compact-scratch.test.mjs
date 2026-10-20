// 中文注释：离线验证真实会话的短 socket 隔离布局；只构建和安装 fixture，不启动浏览器。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import * as runner from './real-session.mjs';

const exec = promisify(execFile);
const python =
  process.env.HERMES_PYTHON || path.join(process.env.HOME, '.hermes/hermes-agent/venv/bin/python');

test('离线夹具不绕过 TMPDIR 写入系统临时目录', async () => {
  for (const file of [
    '../../native-bridge/tests/test_fd_lifecycle.py',
    '../v1.1-diagnostics-install/test_stage_diagnostics.py',
    '../v1.6.0/test_lifecycle.py',
    '../v1.1-packaging/dev-sync-daemon.test.mjs',
    '../v1.1-packaging/directory-swap.test.mjs',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:dir\s*=\s*['"]\/(?:private\/)?tmp['"]|const testTemp\s*=[^;]*['"]\/(?:private\/)?tmp['"])/u,
      file,
    );
  }
});

test('socket address preserves its target and enforces encoded-byte limits', () => {
  const absolute = `/${'a'.repeat(102)}`;
  assert.equal(runner.socketAddress(absolute), absolute);
  const longPath = path.join(runner.root, '汉'.repeat(20), 'bridge.sock');
  assert.ok(Buffer.byteLength(longPath) > 103);
  const address = runner.socketAddress(longPath);
  assert.equal(path.resolve(runner.root, address), longPath);
  assert.ok(Buffer.byteLength(address) <= 103);
  for (const invalid of [`/${'a'.repeat(104)}`, `/${'汉'.repeat(36)}`]) {
    assert.ok(Buffer.byteLength(invalid) > 103);
    assert.throws(() => runner.socketAddress(invalid), /too long/u);
  }
});

test('real-session verifies connection access without removed approval controls', async () => {
  for (const file of ['real-session.mjs', 'real-native-v2.mjs']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /#access-toggle|#confirm-enable/, file);
    assert.ok(source.includes("browserFullConsentStatus==='enabled'"), file);
  }
});

test('真实测试连接选择器与当前弹窗状态契约一致', async () => {
  const popup = await readFile(
    new URL('../../native-extension/popup.html', import.meta.url),
    'utf8',
  );
  assert.match(popup, /id="local-connect"/);
  assert.match(popup, /id="connection-label"[^>]*data-state=/);
  for (const file of [
    './real-session.mjs',
    './real-native-v2.mjs',
    './real-concurrent.mjs',
    '../native-extension/real-browser.mjs',
    '../native-extension/real-bridge.mjs',
    '../approval-integration/real-approval.mjs',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(source.includes('#local-connect'), file);
    assert.ok(source.includes("dataset.state==='connected'"), file);
    assert.ok(source.includes(':not([hidden]):not(:disabled)'), file);
    assert.doesNotMatch(
      source,
      /['"]#connect['"]|['"]#connection['"]|#primary \[data-action="connect"\]/,
      file,
    );
    assert.doesNotMatch(source, /querySelector\(['"]#connection-label['"]\)\??\.textContent/, file);
  }
});

test('compactScratch stages isolated source and package homes with a bindable socket', async () => {
  assert.equal(typeof runner.stageRealSession, 'function', 'offline staging must be available');
  const scratch = await realpath(process.env.TMPDIR);
  const fixtures = [];
  try {
    for (const packageMode of [false, true]) {
      const fixture = await runner.stageRealSession({
        browser: 'chrome',
        packageMode,
        compactScratch: true,
        label: 'compact-test',
      });
      fixtures.push(fixture);
      const { work, profile, staged, compactHome, temp } = fixture;
      assert.equal(path.dirname(work), scratch);
      assert.equal(path.dirname(compactHome), scratch);
      assert.match(path.basename(compactHome), /^[a-f0-9]{4}$/u);
      assert.equal(staged.hermesHome, compactHome);
      assert.equal(profile, path.join(work, 'profile'));
      assert.equal(temp, path.join(work, 'tmp'));
      assert.equal(staged.home, path.join(work, 'h'));
      for (const filename of [staged.host, staged.plugin, ...staged.manifests]) {
        assert.ok(
          filename.startsWith(`${work}/`) || filename.startsWith(`${compactHome}/`),
          filename,
        );
        await access(filename);
      }
      const socketPath = path.join(compactHome, 'plugin-data/fast-browser-link-native/bridge.sock');
      const address = runner.socketAddress(socketPath);
      assert.equal(path.resolve(runner.root, address), socketPath);
      assert.ok(Buffer.byteLength(address) <= 103, address);
      console.log(`compact socket address: ${Buffer.byteLength(address)} bytes`);
      await exec(python, [
        '-c',
        'import socket,sys; sys.path.insert(0,sys.argv[2]); from client import socket_address; s=socket.socket(socket.AF_UNIX); s.bind(socket_address(sys.argv[1])); s.close()',
        socketPath,
        path.join(runner.root, 'native-bridge'),
      ]);
      const manifest = JSON.parse(await readFile(staged.manifests[0], 'utf8'));
      assert.equal(manifest.path, staged.host);
      assert.ok((await readFile(staged.host, 'utf8')).includes(compactHome));
      const { stdout } = await exec(
        python,
        [
          '-c',
          'import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps({k:str(v) for k,v in m["paths"](m["Path"](sys.argv[2])).items()}))',
          path.join(runner.root, 'tests/native-v2/real-helper.py'),
          work,
        ],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
      );
      const restored = JSON.parse(stdout);
      assert.equal(restored.hermes, compactHome);
      assert.equal(restored.plugin, staged.plugin);
      assert.equal(restored.extension, staged.extension);
      await unlink(socketPath);
      // 中文注释：真实 helper RPC 仅查询空实例，验证 daemon 路径与安全清理，不启动浏览器。
      const inheritedBridge = process.env.FAST_BROWSER_BRIDGE_HOME;
      const unrelatedBridge = path.join(work, 'must-not-use-as-bridge');
      process.env.FAST_BROWSER_BRIDGE_HOME = unrelatedBridge;
      try {
        assert.deepEqual(
          await runner.helperCall('rpc', work, 'compact-offline', 'browsers', '{}'),
          [],
        );
        await assert.rejects(realpath(unrelatedBridge), { code: 'ENOENT' });
        const identity = await runner.helperCall('inspect', work);
        assert.ok(identity.daemonCommand.includes(compactHome));
      } finally {
        if (inheritedBridge === undefined) delete process.env.FAST_BROWSER_BRIDGE_HOME;
        else process.env.FAST_BROWSER_BRIDGE_HOME = inheritedBridge;
        await runner.helperCall('cleanup', work);
      }
    }
    assert.notEqual(fixtures[0].compactHome, fixtures[1].compactHome);
    const shared = await runner.stageRealSession({
      browser: 'edge',
      compactScratch: true,
      sharedWith: fixtures[1],
      label: 'compact-shared',
    });
    try {
      assert.equal(shared.compactHome, undefined);
      assert.equal(shared.staged.hermesHome, fixtures[1].compactHome);
    } finally {
      await shared.dispose();
    }
    await access(fixtures[1].compactHome);
    const first = fixtures[0];
    await first.dispose();
    await assert.rejects(access(first.work), { code: 'ENOENT' });
    await assert.rejects(access(first.compactHome), { code: 'ENOENT' });
    await access(fixtures[1].compactHome);
    await access(scratch);
  } finally {
    for (const fixture of fixtures) await fixture.dispose();
  }
});

test('compactScratch refuses missing or overlong TMPDIR without leaking work', async () => {
  const original = process.env.TMPDIR;
  // 中文注释：即使 CI 的临时根目录很短，负例也必须确定超过 socket 字节上限。
  const longScratch = await mkdtemp(
    path.join(await realpath(original), `compact-too-long-${'x'.repeat(103)}-`),
  );
  try {
    assert.ok(
      Buffer.byteLength(
        path.join(longScratch, '0000/plugin-data/fast-browser-link-native/bridge.sock'),
      ) > 103,
    );
    await assert.rejects(
      runner.stageRealSession({
        browser: 'chrome',
        compactScratch: true,
        label: 'missing/compact-escape',
      }),
      /label/u,
    );
    delete process.env.TMPDIR;
    await assert.rejects(
      runner.stageRealSession({ browser: 'chrome', compactScratch: true }),
      /explicit TMPDIR/u,
    );
    process.env.TMPDIR = longScratch;
    await assert.rejects(
      runner.stageRealSession({ browser: 'chrome', compactScratch: true }),
      /too long/u,
    );
    assert.deepEqual(await readdir(longScratch), []);
  } finally {
    process.env.TMPDIR = original;
    await rm(longScratch, { recursive: true, force: true });
  }
});

test('helper staging without compact home preserves the legacy isolated layout', async () => {
  const work = await mkdtemp(path.join(await realpath(process.env.TMPDIR), 'compact-legacy-'));
  try {
    const staged = await runner.helperCall(
      'stage',
      work,
      JSON.stringify(['chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/']),
    );
    assert.equal(staged.home, path.join(work, 'h'));
    assert.equal(staged.hermesHome, path.join(work, 'h/.hermes'));
    assert.equal(staged.plugin, path.join(work, 'plugin/fast-browser-link'));
    assert.ok((await readFile(staged.host, 'utf8')).includes(staged.hermesHome));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
