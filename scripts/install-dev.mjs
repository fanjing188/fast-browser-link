// 中文注释：开发者显式 --apply 后才构建并安装本地源码；普通 update 仍只接受校验过的包。
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.includes('--apply') || args.some((arg) => arg !== '--apply')) {
  throw Error('用法：npm run install:dev -- --apply');
}
const repo = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'fbl-dev-package-'));
const output = path.join(temporary, 'package');
function command(program, values) {
  const result = spawnSync(program, values, { cwd: repo, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw Error(`${program} failed (${result.status ?? result.signal})`);
}
function queryBrowsers() {
  const result = spawnSync('python3', ['fbl.py', 'browser', 'browsers', '{}'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}
try {
  command('node', ['scripts/package-executor.mjs', '--output', output]);
  command('python3', ['fbl.py', 'update', '--source', output, '--dry-run']);
  const installed = JSON.parse(
    await readFile(path.join(output, 'native-extension/BUILD-DEPS.json'), 'utf8'),
  ).buildId;
  command('python3', ['fbl.py', 'update', '--source', output, '--yes']);
  const deadline = Date.now() + 30000;
  let browsers = [];
  while (Date.now() < deadline) {
    browsers = queryBrowsers();
    if (
      Array.isArray(browsers) &&
      browsers.some((row) => row.connected && row.loadedBuildId === installed)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (
    !Array.isArray(browsers) ||
    !browsers.some((row) => row.connected && row.loadedBuildId === installed)
  )
    throw Error('扩展重载后未读到与安装包一致的构建号');
  process.stdout.write(
    JSON.stringify(
      {
        status: 'installed',
        buildId: installed,
        browsers: browsers
          .filter((row) => row.connected)
          .map((row) => ({ browser: row.browser, loadedBuildId: row.loadedBuildId })),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
