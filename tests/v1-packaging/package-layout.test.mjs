import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function packageCandidate(output) {
  return spawnSync(
    process.execPath,
    [path.join(repo, 'scripts/package-executor.mjs'), '--source', repo, '--output', output],
    { encoding: 'utf8', timeout: 90_000 },
  );
}

test('桥接候选包包含完整清单且不包含旧独立引擎', (t) => {
  // 临时输出只用于验证候选包，不触碰用户的 Hermes 安装。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-link-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'candidate');
  const result = packageCandidate(output);
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'SHA256SUMS.json'), 'utf8'));
  const expected = [
    'fast-browser-link/open_tool.py',
    'fast-browser-link/skills/fast-browser-link/SKILL.md',
    'fast-browser-link/native_bridge/daemon.py',
    'native-extension/manifest.json',
    'install-executor.py',
  ];
  for (const name of expected) assert.ok(manifest[name], `missing ${name}`);
  assert.ok(Object.keys(manifest).every((name) => !name.startsWith('fast-browser-link/engine/')));
  assert.ok(!Object.hasOwn(manifest, 'docs/EXECUTOR-ACCEPTANCE.md'));
  for (const [name, expectedHash] of Object.entries(manifest)) {
    const actualHash = createHash('sha256')
      .update(fs.readFileSync(path.join(output, name)))
      .digest('hex');
    assert.equal(actualHash, expectedHash, name);
  }
  assert.notEqual(packageCandidate(output).status, 0, 'must refuse an existing target');
});
