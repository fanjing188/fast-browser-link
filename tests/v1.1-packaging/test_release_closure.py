"""V1.1 release checks use only scratch packages and scratch installation targets."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import argparse
import io
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path(tempfile.gettempdir()).resolve()
ORIGIN = "chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/"
# 中文注释：按已发布标签解析提交，避免仓库历史改写后固定对象失效。
OLD_RELEASE = "v1.8.5^{commit}"
# 中文注释：夹具只复制当前包输入；旧云升级材料从固定 Git 历史读取。
INPUTS = (
    "fbl.py",
    "skills",
    "agent-link",
    "scripts/setup-copilot-profile.py",
    "scripts/setup-copilot-package.py",
    "package.json",
    "package-lock.json",
    "executor-plugin",
    "native-bridge",
    "native-extension",
    "browser-workspaces",
    "browser-diagnostics",
    "page-semantics",
    "browser-interactions",
    "approval-policy",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
    "third-party",
    "scripts/install-executor.py",
    "scripts/install-cli.py",
    "install.sh",
    "docs/installation.md",
    "docs/design/hermes-installation.md",
    "docs/development.md",
    "docs/agent-integration.md",
    "docs/assist.md",
    "docs/fbl-troubleshooting.md",
    "docs/installation.zh-CN.md",
    "docs/python-scripting.md",
    "LICENSE",
)


def load_installer():
    spec = importlib.util.spec_from_file_location(
        "v11_installer", ROOT / "scripts/install-executor.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load installer module")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    return installer


class ReleaseClosure(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH, prefix="v1.1-packaging-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "release"
        # 中文注释：发布夹具跟随当前包版本，仍由打包器独立核对插件和扩展版本。
        self.version = json.loads((ROOT / "package.json").read_text())["version"]
        for relative in INPUTS:
            original, target = ROOT / relative, self.source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if original.is_dir():
                shutil.copytree(
                    original,
                    target,
                    ignore=shutil.ignore_patterns(
                        "node_modules",
                        "tests",
                        "test",
                        "evidence",
                        "__pycache__",
                        "dist-native",
                        ".git",
                        "site",
                    ),
                )
            else:
                shutil.copyfile(original, target)

    def package(self):
        return subprocess.run(
            [
                "node",
                str(ROOT / "scripts/package-executor.mjs"),
                "--source",
                str(self.source),
                "--output",
                str(self.output),
            ],
            cwd=self.root,
            text=True,
            capture_output=True,
            timeout=90,
        )

    def built(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        sums = json.loads((self.output / "SHA256SUMS.json").read_text())
        self.assertEqual(
            set(sums) | {"SHA256SUMS.json"},
            {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()},
        )
        for name, digest in sums.items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
        return sums

    def _commit_fixture(self):
        # 中文注释：使用独立仓库及测试身份，不运行维护者的全局 Git hook 或签名配置。
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        commands = [
            ["git", "init", "-q", str(self.source)],
            ["git", "-C", str(self.source), "add", "."],
            [
                "git",
                "-C",
                str(self.source),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "测试发布输入",
            ],
        ]
        for command in commands:
            subprocess.run(command, env=env, check=True, capture_output=True)
        return subprocess.check_output(
            ["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True
        ).strip()

    def test_formal_package_records_committed_source(self):
        commit = self._commit_fixture()
        result = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/package-executor.mjs"),
                "--source",
                str(self.source),
                "--output",
                str(self.output),
                "--release",
                self.version,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(commit, (self.output / "RELEASE-STATUS.txt").read_text())
        self.assertEqual(load_installer().release_status(self.output), "RELEASE V" + self.version)

    def test_shared_release_parser_keeps_public_status_and_strict_metadata(self):
        self.output.mkdir()
        marker = self.output / "RELEASE-STATUS.txt"
        commit = self._commit_fixture()
        status = (
            f"SHARED RELEASE V{self.version}: formal release built from commit {commit}. "
            "See docs/CHANGELOG.md for the verified scope and stated limits.\n"
        )
        installer = load_installer()
        marker.write_text(status)
        self.assertEqual(installer.release_status(self.output), "RELEASE V" + self.version)
        for invalid in (
            status.replace(commit, commit[:-1]),
            status.replace(commit, commit + "a"),
            status.replace("V" + self.version, "V01.9.0"),
            "prefix " + status,
            status + "extra",
            status.replace("SHARED RELEASE", "SHARED"),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                marker.write_text(invalid)
                installer.release_status(self.output)
        marker.write_text(status.removeprefix("SHARED "))
        self.assertEqual(installer.release_status(self.output), "RELEASE V" + self.version)
        marker.write_text("NOT FROZEN: development candidate, not a formal release.\n")
        self.assertEqual(installer.release_status(self.output), "NOT FROZEN candidate only")

    def test_formal_package_refuses_ignored_untracked_runtime_input(self):
        (self.source / ".gitignore").write_text("native-extension/unreviewed.mjs\n")
        self._commit_fixture()
        (self.source / "native-extension/unreviewed.mjs").write_text("// unreviewed input\n")
        result = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/package-executor.mjs"),
                "--source",
                str(self.source),
                "--output",
                str(self.output),
                "--release",
                self.version,
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("input is not tracked", result.stderr)
        self.assertFalse(self.output.exists())

    def test_fixed_old_updater_rejects_shared_formal_package_before_old_cli(self):
        commit = self._commit_fixture()
        result = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/package-executor.mjs"),
                "--source",
                str(self.source),
                "--output",
                str(self.output),
                "--release",
                self.version,
            ],
            capture_output=True,
            text=True,
            timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["releaseStatus"], "RELEASE V" + self.version)
        sums = load_installer().verify_package(self.output)
        self.assertEqual(
            set(sums) | {"SHA256SUMS.json"},
            {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()},
        )
        for name, digest in sums.items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
        old_directory = self.root / "old/maintenance"
        old_directory.mkdir(parents=True)
        old_hashes = {}
        for relative in (
            "executor-plugin/maintenance/update.py",
            "scripts/install-cli.py",
            "scripts/install-executor.py",
        ):
            content = subprocess.check_output(
                [
                    "git",
                    "-C",
                    os.environ.get("BROWSER_LINK_RELEASE_HISTORY", str(ROOT)),
                    "show",
                    f"{OLD_RELEASE}:{relative}",
                ]
            )
            (old_directory / Path(relative).name).write_bytes(content)
            old_hashes[relative] = hashlib.sha256(content).hexdigest()
        spec = importlib.util.spec_from_file_location(
            "fixed_old_update", old_directory / "update.py"
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load fixed old updater")
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        cli = updater.installer_modules()
        self.assertFalse(
            cli.EXECUTOR.RELEASE_LINE.match((self.output / "RELEASE-STATUS.txt").read_text())
        )
        home, user_home = self.root / "hermes", self.root / "home"
        # 中文注释：执行真实旧更新器时保留它的安装与下载命名空间，不改写固定旧源码。
        plugin = home / "plugins/browser-link"
        plugin.mkdir(parents=True)
        (plugin / "plugin.yaml").write_bytes(
            subprocess.check_output(
                [
                    "git",
                    "-C",
                    os.environ.get("BROWSER_LINK_RELEASE_HISTORY", str(ROOT)),
                    "show",
                    f"{OLD_RELEASE}:executor-plugin/plugin.yaml",
                ]
            )
        )
        before = (plugin / "plugin.yaml").read_bytes()
        legacy_asset = updater.REPOSITORY.rsplit("/", 1)[-1] + "-" + self.version
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
            for file in sorted(self.output.rglob("*")):
                if file.is_file():
                    zipped.write(
                        file, legacy_asset + "/" + file.relative_to(self.output).as_posix()
                    )
        payload = archive.getvalue()
        url = f"https://github.com/{updater.REPOSITORY}/releases/download/v{self.version}/{legacy_asset}.zip"
        # 中文注释：只替换网络传输与外部空闲状态；API 解析、ZIP/包摘要、旧解析器及旧 CLI 保持真实逻辑。
        api = json.dumps(
            {
                "draft": False,
                "prerelease": False,
                "tag_name": "v" + self.version,
                "assets": [
                    {
                        "name": legacy_asset + ".zip",
                        "browser_download_url": url,
                        "state": "uploaded",
                        "size": len(payload),
                        "digest": "sha256:" + hashlib.sha256(payload).hexdigest(),
                    }
                ],
            }
        ).encode()

        def fetch(address, limit):
            self.assertIn(address, (updater.API, url))
            data = api if address == updater.API else payload
            self.assertLessEqual(len(data), limit)
            return data

        calls = []
        codes = {
            cli.EXECUTOR.verify_package.__code__: "verify_package",
            cli.EXECUTOR.release_status.__code__: "release_status",
            cli.run.__code__: "old_cli.run",
        }

        def guard(frame, event, arg):
            if event == "call" and frame.f_code in codes:
                name = codes[frame.f_code]
                calls.append(name)
                if name == "old_cli.run":
                    raise AssertionError("旧更新器越过包校验进入旧 CLI；禁止执行安装")

        previous = sys.getprofile()
        try:
            sys.setprofile(guard)
            with (
                mock.patch.object(updater, "fetch", side_effect=fetch),
                mock.patch.object(updater, "applications_running", return_value=False),
                self.assertRaisesRegex(ValueError, "安装包顶层布局无效"),
            ):
                updater.update(
                    argparse.Namespace(hermes_home=home, user_home=user_home, check=False), cli
                )
        finally:
            sys.setprofile(previous)
        # 中文注释：改名包被旧更新器在布局检查时更早拒绝；旧状态解析器仍须单独拒绝新格式。
        self.assertEqual(calls, ["verify_package"])
        with self.assertRaisesRegex(ValueError, "拒绝缺少候选或正式发布状态声明"):
            cli.EXECUTOR.release_status(self.output)
        self.assertEqual((plugin / "plugin.yaml").read_bytes(), before)
        self.assertFalse(user_home.exists())
        self.assertEqual(
            {p.relative_to(home).as_posix() for p in home.rglob("*") if p.is_file()},
            {"plugins/browser-link/plugin.yaml"},
        )
        marker = self.output / "RELEASE-STATUS.txt"
        original = marker.read_bytes()
        marker.write_bytes(original + b"changed metadata\n")
        try:
            for verifier in (load_installer(), cli.EXECUTOR):
                with self.assertRaisesRegex(ValueError, "哈希不匹配: RELEASE-STATUS.txt"):
                    verifier.verify_package(self.output)
        finally:
            marker.write_bytes(original)
        print(
            json.dumps(
                {
                    "fixtureCommit": commit,
                    "oldReleaseCommit": OLD_RELEASE,
                    "oldSourceSHA256": old_hashes,
                    "manifestFiles": len(sums),
                    "archiveSHA256": hashlib.sha256(payload).hexdigest(),
                    "oldCalls": calls,
                }
            )
        )

    def test_package_includes_script_lane_and_no_hermes_patch_materials(self):
        # 当前发布包只保留共享浏览器桥接与脚本通道。
        sums = self.built()
        self.assertFalse(any(name.startswith("docs/upstream-patches/") for name in sums))
        self.assertFalse(any("official_adapter" in name for name in sums))
        runtime = self.output / "fast-browser-link/native_bridge"
        members = (
            "assist_adapter.py",
            "product_adapter.py",
            "browser_sdk.py",
            "fbl_scripts.py",
            "script_lane/host_bridge.py",
            "script_lane/action_session.py",
            "script_lane/child.py",
            "script_lane/tool.py",
            "script_lane/page-request.js",
            "site_tools/store.py",
            "site_tools/tools.py",
        )
        members += ("script_lane/page_export.py", "script_lane/page_export.js")
        for relative in members:
            # 中文注释：导出运行闭包逐字节随包保留，缺件负例由安装预检套件覆盖。
            self.assertIn("fast-browser-link/native_bridge/" + relative, sums)
            self.assertEqual(
                (runtime / relative).read_bytes(),
                (self.source / "native-bridge" / relative).read_bytes(),
            )
        self.assertFalse((self.output / "fast-browser-link/script_lane").exists())
        self.assertFalse((self.output / "fast-browser-link/site_tools").exists())
        self.assertFalse(
            any(
                "cloud_link" in name
                or name.endswith("cloud-link.mjs")
                or name.endswith("cloud-popup.mjs")
                for name in sums
            )
        )
        # 中文注释：脱离源码树的新进程实际加载 SDK，并走真实脚本子进程，不借 Hermes 依赖。
        probe = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                """
import pathlib, sys
sys.path.insert(0, sys.argv[1])
import browser_sdk
class Client:
    def call(self, method, params):
        if method == 'browser.list':
            return [{'instanceId': 'fixture', 'connected': True}]
        assert method == 'shared.get', method
        return {'id': 'packaged', 'state': 'ready', 'generation': 1,
                'instanceId': 'fixture', 'tabIds': [], 'agentTabIds': [], 'allowedOrigins': []}
    def close(self): pass
with browser_sdk.Browser(home=pathlib.Path(sys.argv[2]), owner='fixture-owner', client=Client()) as browser:
    receipt = browser.call('script', {'taskId': 'packaged', 'code': "print('packaged-sdk')"})
    assert receipt['execution_complete'], receipt
    assert receipt['stdout'].strip() == 'packaged-sdk', receipt
assert pathlib.Path(browser_sdk.__file__).parent == pathlib.Path(sys.argv[1])
""",
                str(runtime),
                str(self.root / "sdk-runtime"),
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
        )
        self.assertEqual(probe.returncode, 0, probe.stdout + probe.stderr)
        self.assertIn("docs/python-scripting.md", sums)
        self.assertIn("docs/CHANGELOG.md", sums)
        self.assertIn("README.md", sums)
        # 中文注释：图标在发布清单中登记并逐字复制，扩展和工具栏引用同一套文件。
        manifest = json.loads((self.output / "native-extension/manifest.json").read_text())
        icons = {str(size): f"icon-{size}.png" for size in (16, 32, 48, 128)}
        self.assertEqual(manifest["icons"], icons)
        self.assertEqual(manifest["action"]["default_icon"], icons)
        for filename in icons.values():
            relative = f"native-extension/{filename}"
            self.assertIn(relative, sums)
            self.assertEqual(
                (self.output / relative).read_bytes(), (self.source / relative).read_bytes()
            )
        self.assertIn("NOT FROZEN", (self.output / "RELEASE-STATUS.txt").read_text())
        # 中文注释：1.5.2 起 INSTALL.txt 只保留运行方式和支持范围；"不改 Hermes 源码"由上面的包内容断言保证，不再要求写进安装说明。
        instructions = (self.output / "INSTALL.txt").read_text()
        self.assertIn("./install.sh", instructions)
        self.assertIn("macOS", instructions)

    def test_product_extension_resources_are_packaged_and_required_before_output(self):
        names = (
            "product-fill.mjs",
            "product-fill-content.mjs",
            "product-connections.mjs",
            "product-connections-page.mjs",
            "product-connections.html",
            "product-connections.css",
        )
        sums = self.built()
        for name in names:
            relative = "native-extension/" + name
            self.assertIn(relative, sums)
            self.assertEqual(
                (self.output / relative).read_bytes(),
                (self.source / relative).read_bytes(),
            )
        shutil.rmtree(self.output)
        for name in names:
            with self.subTest(name=name):
                member = self.source / "native-extension" / name
                data = member.read_bytes()
                member.unlink()
                try:
                    result = self.package()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Missing input native-extension/" + name, result.stderr)
                    self.assertFalse(self.output.exists())
                finally:
                    member.write_bytes(data)

    def test_missing_script_lane_member_rejected_before_output(self):
        for relative in (
            "assist_adapter.py",
            "product_adapter.py",
            "browser_sdk.py",
            "fbl_scripts.py",
            "script_lane/host_bridge.py",
            "script_lane/action_session.py",
            "script_lane/child.py",
            "script_lane/tool.py",
            "script_lane/page-request.js",
            "site_tools/tools.py",
            "site_tools/store.py",
        ):
            with self.subTest(relative=relative):
                member = self.source / "native-bridge" / relative
                data = member.read_bytes()
                member.unlink()
                try:
                    result = self.package()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(relative, result.stderr)
                    self.assertFalse(self.output.exists())
                finally:
                    member.write_bytes(data)

    def test_package_describes_one_shared_program_with_isolated_profiles(self):
        self.built()
        instructions = (self.output / "INSTALL.txt").read_text()
        self.assertIn("One shared program at <shared-root>/plugins/fast-browser-link", instructions)
        self.assertIn("direct links", instructions)
        self.assertIn("profile settings and private data remain separate", instructions)
        readme = (self.output / "README.md").read_text()
        for document in (
            "development.md",
            "agent-integration.md",
            "assist.md",
            "fbl-troubleshooting.md",
            "installation.zh-CN.md",
            "design/hermes-installation.md",
        ):
            self.assertIn(f"](docs/{document})", readme)
            self.assertTrue((self.output / "docs" / document).is_file())
        readme = (self.output / "docs/design/hermes-installation.md").read_text()
        self.assertIn("one regular program directory", readme)
        self.assertIn("Disabled profiles stay disabled", readme)
        self.assertEqual(
            (self.output / "install-cli.py").read_bytes(),
            (self.output / "fast-browser-link/maintenance/install-cli.py").read_bytes(),
        )

    def test_missing_canonical_runtime_dependency_rejected_before_output(self):
        dependency = self.source / "browser-interactions/index.mjs"
        dependency.unlink()
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(
            self.output.exists(),
            "missing dependency preflight must not create the output directory",
        )
        self.assertIn("Missing input", result.stderr)
        self.assertIn("browser-interactions/index.mjs", result.stderr)

    def test_missing_extension_import_rejected_before_manifest(self):
        background = self.source / "native-extension/background.mjs"
        background.write_text(background.read_text() + "\nimport './unpacked-only.mjs';\n")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unpacked-only.mjs", result.stderr)
        self.assertFalse((self.output / "SHA256SUMS.json").exists())

    def test_missing_extension_page_resource_rejected_before_manifest(self):
        popup = self.source / "native-extension/popup.html"
        popup.write_text(popup.read_text() + '<script type="module" src="missing-ui.mjs"></script>')
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing-ui.mjs", result.stderr)
        self.assertFalse((self.output / "SHA256SUMS.json").exists())

    def test_installer_rejects_missing_script_lane_before_writes(self):
        self.built()
        sums_path = self.output / "SHA256SUMS.json"
        original = sums_path.read_bytes()
        sums = json.loads(original)
        installer = load_installer()
        home, hermes = self.root / "home", self.root / "hermes"
        for relative in (
            "assist_adapter.py",
            "product_adapter.py",
            "browser_sdk.py",
            "fbl_scripts.py",
            "script_lane/host_bridge.py",
            "script_lane/action_session.py",
            "script_lane/child.py",
            "script_lane/tool.py",
            "script_lane/page-request.js",
            "site_tools/tools.py",
            "site_tools/store.py",
        ):
            with self.subTest(relative=relative):
                name = "fast-browser-link/native_bridge/" + relative
                member = self.output / name
                data = member.read_bytes()
                member.unlink()
                sums_path.write_text(
                    json.dumps({key: value for key, value in sums.items() if key != name})
                )
                try:
                    with self.assertRaisesRegex(ValueError, relative):
                        installer.install(self.output, home, hermes, [ORIGIN], apply=True)
                    self.assertFalse(home.exists())
                    self.assertFalse(hermes.exists())
                finally:
                    member.write_bytes(data)
                    sums_path.write_bytes(original)

    def test_unmanifested_empty_package_directory_is_rejected(self):
        self.built()
        (self.output / "unexpected-empty").mkdir()
        installer = load_installer()
        with self.assertRaisesRegex(ValueError, "目录"):
            installer.verify_package(self.output)

    def test_scratch_install_matches_every_packaged_runtime_hash(self):
        sums = self.built()
        installer = load_installer()
        home, hermes = self.root / "home", self.root / "hermes"
        result = installer.install(self.output, home, hermes, [ORIGIN], apply=True)
        self.assertEqual(result["status"], "installed_disabled")
        self.assertFalse((hermes / "plugin-data/fast-browser-link-cloud").exists())
        self.assertFalse(list(home.rglob("com.fast.browser_link.cloud.json")))
        target = hermes / "plugins/fast-browser-link"
        installer.verify_installed(target, sums)
        for relative, digest in sums.items():
            if relative.startswith("fast-browser-link/"):
                installed = target / relative.removeprefix("fast-browser-link/")
                self.assertEqual(
                    hashlib.sha256(installed.read_bytes()).hexdigest(), digest, relative
                )


class PublicSourceExport(unittest.TestCase):
    """中文注释：公开源码只允许导出已审阅提交，不能夹带历史和工作区数据。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="public-source-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.output = self.root / "public"
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        self.git("init", "-q")
        spec = importlib.util.spec_from_file_location(
            "public_export", ROOT / "scripts/prepare-public-source.py"
        )
        self.exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.exporter)

    def git(self, *args):
        return subprocess.check_output(
            [
                "git",
                "-C",
                str(self.source),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            env=self.env,
            text=True,
        ).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "测试公开源码导出")
        return self.git("rev-parse", "HEAD")

    def test_export_excludes_history_untracked_and_uncommitted_content(self):
        (self.source / "old.txt").write_text("old private fixture")
        self.commit()
        (self.source / "old.txt").unlink()
        script = self.source / "run.py"
        script.write_text("# 中文注释：已提交脚本。\n")
        script.chmod(0o755)
        commit = self.commit()
        script.write_text("uncommitted fixture")
        (self.source / "personal.txt").write_text("untracked fixture")
        result = self.exporter.export_source(self.source, "HEAD", self.output)
        self.assertEqual(result["sourceCommit"], commit)
        self.assertEqual(result["files"], 1)
        self.assertFalse(result["gitHistoryIncluded"])
        self.assertEqual({p.name for p in self.output.iterdir()}, {"run.py"})
        self.assertIn("已提交", (self.output / "run.py").read_text())
        self.assertTrue((self.output / "run.py").stat().st_mode & 0o111)

    def test_unreviewed_inputs_are_rejected_without_partial_export(self):
        for kind in ("binary", "symlink", "personal-data"):
            with self.subTest(kind=kind):
                candidate = self.source / ("capture.har" if kind == "personal-data" else "asset")
                if kind == "symlink":
                    candidate.symlink_to("../outside")
                else:
                    candidate.write_bytes(b"\0binary" if kind == "binary" else b"{}")
                self.commit()
                with self.assertRaises(ValueError):
                    self.exporter.export_source(self.source, "HEAD", self.output)
                self.assertFalse(self.output.exists())
                candidate.unlink()

    def test_reviewed_benchmark_images_are_exported_without_allowing_other_binaries(self):
        # 中文注释：两张合成基准图片必须原样导出，其他二进制仍由原拒绝用例覆盖。
        names = ["bench/site/assets/logo.png", "bench/site/assets/screenshot.png"]
        for name in names:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        self.commit()
        result = self.exporter.export_source(self.source, "HEAD", self.output)
        self.assertEqual(result["files"], 2)
        for name in names:
            self.assertEqual((self.output / name).read_bytes(), (ROOT / name).read_bytes())

    def test_existing_output_is_preserved(self):
        (self.source / "file.txt").write_text("source")
        self.commit()
        self.output.mkdir()
        (self.output / "keep.txt").write_text("existing")
        with self.assertRaisesRegex(ValueError, "Output must not exist"):
            self.exporter.export_source(self.source, "HEAD", self.output)
        self.assertEqual((self.output / "keep.txt").read_text(), "existing")

    def test_reviewed_branding_exports_exact_bytes(self):
        # 中文注释：所有已审阅品牌图片按原字节导出，不能依赖后缀或宽泛目录放行。
        for name in self.exporter.REVIEWED_BRANDING:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        self.commit()
        result = self.exporter.export_source(self.source, "HEAD", self.output)
        self.assertEqual(result["files"], len(self.exporter.REVIEWED_BRANDING))
        for name in self.exporter.REVIEWED_BRANDING:
            self.assertEqual((self.output / name).read_bytes(), (ROOT / name).read_bytes())

    def test_changed_branding_is_rejected_without_partial_export(self):
        # 中文注释：相同路径下替换成未知二进制也必须拒绝，并清理本次未完成的导出。
        target = self.source / "docs/assets/readme-banner.png"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"\0unreviewed-image")
        self.commit()
        with self.assertRaisesRegex(ValueError, "branding digest changed"):
            self.exporter.export_source(self.source, "HEAD", self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
