import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = import.meta.dirname;
const repo = path.resolve(source, '..');
const dest = path.resolve(process.argv[2] || path.join(source, 'dist-native'));
if (dest === source) throw Error('output must not replace source');

await mkdir(dest, { recursive: true });
// 中文注释：内容过滤模块随扩展打包，保持源码和加载版本一致。
// 中文注释：扩展和系统通知共用的品牌图标也在清单内；清单内不放注释，集成检查器按字面量解析它。
for (const file of [
  'ui-design.mjs',
  'copilot-annotations.mjs',
  'copilot-basket.mjs',
  'copilot-readiness.mjs',
  'copilot-retry.mjs',
  'copilot-controls.mjs',
  'copilot-table-confirm.mjs',
  'copilot-logs.mjs',
  'copilot-task-logs.mjs',
  'copilot-result.css',
  'brand-mark.svg',
  'brand.css',
  'brand.mjs',
  'brand-logo.svg',
  'brand-logo-small.svg',
  'overlay-view.mjs',
  'overlay-logs.mjs',
  'copilot-tool-reports.mjs',
  'copilot-capabilities-panel.mjs',
  'copilot-capabilities.css',
  'copilot-agent-panel.mjs',
  'copilot-agents.css',
  'copilot-packs-panel.mjs',
  'copilot-selection.mjs',
  'copilot-browser-data.mjs',
  'copilot-i18n.mjs',
  'copilot-tables.mjs',
  'copilot-table-job.mjs',
  'copilot-table-panel.mjs',
  'copilot-result-view.mjs',
  'copilot-generic-result.mjs',
  'copilot-result.mjs',
  'copilot-result.html',
  'copilot-settings.mjs',
  'copilot-memory-panel.mjs',
  'copilot-view.mjs',
  'copilot-entry.js',
  'copilot-collector.mjs',
  'copilot-background.mjs',
  'copilot-observation.mjs',
  'copilot-panel.html',
  'copilot-panel.css',
  'copilot-panel.mjs',
  'manifest.json',
  'work-window.mjs',
  'work-window.html',
  'action-effects.mjs',
  'request-ledger.mjs',
  'target-recovery.mjs',
  'password-values.mjs',
  'bridge.mjs',
  'background.mjs',
  'automation-overlay.mjs',
  'interaction-highlight.mjs',
  'official-actions.mjs',
  'downloads.mjs',
  'page-runtime.mjs',
  'network-evidence.mjs',
  'cdp-policy.mjs',
  'page-observers.mjs',
  'page-observation.mjs',
  'vault.mjs',
  'oauth-popups.mjs',
  'approval-notifier.mjs',
  'approval-panel.html',
  'approval-panel.css',
  'approval-panel.mjs',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png',
  'popup.html',
  'popup.css',
  'popup.mjs',
  'cloud-link.mjs',
  'cloud-popup.mjs',
  'build-reload.mjs',
]) {
  await copyFile(path.join(source, file), path.join(dest, file));
}

// 中文注释：归属声明和完整许可证随扩展分发，后续构建身份哈希也覆盖这两个文件。
await mkdir(path.join(dest, 'third-party/licenses'), { recursive: true });
for (const file of ['THIRD_PARTY_NOTICES.md', 'third-party/licenses/hermes-agent-MIT.txt']) {
  await copyFile(path.join(repo, file), path.join(dest, file));
}

const dependencies = {
  'cookie-mirror.mjs': path.join(source, 'cookie-mirror.mjs'),
  'vendor/browser-workspaces.mjs': path.join(repo, 'browser-workspaces/index.mjs'),
  'vendor/browser-diagnostics.mjs': path.join(repo, 'browser-diagnostics/js/diagnostics.mjs'),
  'vendor/approval-policy.mjs': path.join(repo, 'approval-policy/policy.mjs'),
  'vendor/page-parser.mjs': path.join(repo, 'page-semantics/parser.mjs'),
  'vendor/page-semantics.mjs': path.join(repo, 'page-semantics/index.js'),
  'vendor/oauth-providers.mjs': path.join(repo, 'page-semantics/oauth-providers.mjs'),
  'vendor/redact.mjs': path.join(repo, 'page-semantics/redact.mjs'),
  'vendor/browser-interactions.mjs': path.join(repo, 'browser-interactions/index.mjs'),
};
await mkdir(path.join(dest, 'vendor'), { recursive: true });
const manifest = { version: 1, dependencies: {} };
for (const [relative, canonical] of Object.entries(dependencies)) {
  const data = await readFile(canonical);
  await writeFile(path.join(dest, relative), data);
  manifest.dependencies[relative] = {
    source: path.relative(repo, canonical).split(path.sep).join('/'),
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

for (const file of [
  'copilot-observation.mjs',
  'copilot-selection.mjs',
  'copilot-annotations.mjs',
  'copilot-background.mjs',
]) {
  await writeFile(
    path.join(dest, file),
    (await readFile(path.join(source, file), 'utf8'))
      .replace("from '../page-semantics/index.js'", "from './vendor/page-semantics.mjs'")
      .replace("from '../page-semantics/redact.mjs'", "from './vendor/redact.mjs'"),
  );
}
const sourceCore = await readFile(path.join(source, 'core.mjs'), 'utf8');
await writeFile(
  path.join(dest, 'oauth-popups.mjs'),
  (await readFile(path.join(source, 'oauth-popups.mjs'), 'utf8')).replace(
    "from '../page-semantics/oauth-providers.mjs'",
    "from './vendor/oauth-providers.mjs'",
  ),
);
const builtCore = sourceCore
  .replace("from '../page-semantics/parser.mjs'", "from './vendor/page-parser.mjs'")
  .replace(
    "from '../browser-diagnostics/js/diagnostics.mjs'",
    "from './vendor/browser-diagnostics.mjs'",
  )
  .replace("from '../approval-policy/policy.mjs'", "from './vendor/approval-policy.mjs'")
  .replace("from '../page-semantics/index.js'", "from './vendor/page-semantics.mjs'")
  .replace("from '../page-semantics/redact.mjs'", "from './vendor/redact.mjs'")
  .replace("from '../browser-interactions/index.mjs'", "from './vendor/browser-interactions.mjs'");
if (
  builtCore === sourceCore ||
  /\.\.\/(page-semantics|browser-interactions|approval-policy)/.test(builtCore)
) {
  throw Error('native dependency import rewrite failed');
}
await writeFile(path.join(dest, 'core.mjs'), builtCore);
const adapter = (await readFile(path.join(source, 'workspace-adapter.mjs'), 'utf8')).replace(
  "from '../browser-workspaces/index.mjs'",
  "from './vendor/browser-workspaces.mjs'",
);
await writeFile(path.join(dest, 'workspace-adapter.mjs'), adapter);
// 中文注释：构建哈希覆盖除自身两个文件外的全部产物；扩展加载时内嵌该值，连接前与磁盘上的 BUILD-DEPS.json 比对。
async function buildIdentity(root) {
  const entries = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (relative === 'BUILD-DEPS.json' || relative === 'build-id.mjs') continue;
        entries.push(
          `${relative}\0${createHash('sha256')
            .update(await readFile(file))
            .digest('hex')}`,
        );
      }
    }
  };
  await visit(root);
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}
manifest.buildId = await buildIdentity(dest);
await writeFile(
  path.join(dest, 'build-id.mjs'),
  `// 中文注释：由 build.mjs 生成，记录本次构建哈希。\nexport const BUILD_ID='${manifest.buildId}';\n`,
);
await writeFile(path.join(dest, 'BUILD-DEPS.json'), `${JSON.stringify(manifest, null, 2)}\n`);

async function verifyRuntimeClosure() {
  const root = path.resolve(dest);
  const resolveResource = async (from, reference, rootRelative = false) => {
    if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference))
      return;
    const pathname = reference.split(/[?#]/, 1)[0];
    if (!pathname) return;
    const decoded = decodeURIComponent(pathname);
    const rooted = rootRelative || pathname.startsWith('/');
    const resourcePath = rooted ? decoded.replace(/^[/\\]+/, '') : decoded;
    const target = path.resolve(rooted ? root : from, resourcePath);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Error(`native resource escapes build: ${reference}`);
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      throw Error(
        `native build missing referenced resource: ${path.relative(root, from) || '.'} -> ${reference}`,
      );
    }
    if (!info.isFile())
      throw Error(
        `native build reference is not a file: ${path.relative(root, from) || '.'} -> ${reference}`,
      );
  };
  const visit = async (directory, files = []) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw Error(`native build refuses symbolic resource: ${path.relative(root, file)}`);
      if (entry.isDirectory()) await visit(file, files);
      else if (entry.isFile()) files.push(file);
    }
    return files;
  };
  const files = await visit(root);
  const manifestFile = path.join(root, 'manifest.json');
  const extensionManifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const manifestResources = [
    extensionManifest.background?.service_worker,
    ...(extensionManifest.background?.scripts || []),
    extensionManifest.action?.default_popup,
    extensionManifest.browser_action?.default_popup,
    extensionManifest.page_action?.default_popup,
    extensionManifest.options_page,
    extensionManifest.options_ui?.page,
    extensionManifest.side_panel?.default_path,
    extensionManifest.devtools_page,
    ...Object.values(extensionManifest.icons || {}),
    // 中文注释：工具栏图标也纳入资源闭包，不能只检查扩展管理页图标。
    ...Object.values(extensionManifest.action?.default_icon || {}),
    ...(extensionManifest.content_scripts || []).flatMap((script) => [
      ...(script.js || []),
      ...(script.css || []),
    ]),
    ...(extensionManifest.web_accessible_resources || []).flatMap(
      (resource) => resource.resources || [],
    ),
  ].filter((value) => typeof value === 'string');
  for (const reference of manifestResources) await resolveResource(root, reference, true);

  const modulePatterns = [
    /\b(?:from\s*|import\s*)(['"])(\.{1,2}\/[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  ];
  const htmlPattern = /\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi;
  const cssPatterns = [/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, /@import\s+(['"])([^'"]+)\1/gi];
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!['.mjs', '.js', '.html', '.css'].includes(extension)) continue;
    const code = await readFile(file, 'utf8');
    const from = path.dirname(file);
    if (extension === '.mjs' || extension === '.js') {
      for (const pattern of modulePatterns) {
        for (const match of code.matchAll(pattern)) await resolveResource(from, match[2]);
      }
    } else if (extension === '.html') {
      for (const match of code.matchAll(htmlPattern)) await resolveResource(from, match[2]);
    } else {
      for (const pattern of cssPatterns)
        for (const match of code.matchAll(pattern)) await resolveResource(from, match[2]);
    }
  }
}

await verifyRuntimeClosure();
console.log(dest);
