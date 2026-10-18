import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function isolatedInstallerEnv(userHome, runtimeHome) {
  const python = spawnSync(
    process.env.BROWSER_LINK_TEST_PYTHON || 'python3',
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr);
  const launcher = path.join(userHome, 'fixture-python');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${[
      python.stdout.trim(),
      path.join(import.meta.dirname, 'isolated-installer.py'),
      await realpath(userHome),
      await realpath(runtimeHome),
    ]
      .map(quote)
      .join(' ')} "$@"\n`,
    { mode: 0o700 },
  );
  return {
    ...process.env,
    HOME: await realpath(userHome),
    HERMES_HOME: await realpath(runtimeHome),
    BROWSER_LINK_TEST_PYTHON: launcher,
    PYTHONDONTWRITEBYTECODE: '1',
    FBL_TEST_PROCESSES: '{}',
  };
}

// 中文注释：源码不是已验证的发行包；临时安装夹具显式生成与宿主内容一致的围栏声明。
export async function fixtureInstaller(source, destination, host) {
  const digest = createHash('sha256')
    .update(await readFile(host))
    .digest('hex');
  const text = await readFile(source, 'utf8');
  assert.match(text, /^CLOUD_FENCE_HOST_SHA256 = "[a-f0-9]{64}"$/m);
  await writeFile(
    destination,
    text.replace(
      /^CLOUD_FENCE_HOST_SHA256 = "[a-f0-9]{64}"$/m,
      `CLOUD_FENCE_HOST_SHA256 = "${digest}"`,
    ),
  );
}
