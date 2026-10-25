"""R15：临时安装树、合成协议与无查询发现；从不访问真实配置或供应商。"""

import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import private_write, Copilot
from fbl_runtime import Context, doctor, choose_model, manifests, load
from fbl_profiles import repair, profile_plan
from fbl_update import update, tree_digest, verify_source, legacy_cli, idle, layouts
from fbl_discovery import scan, confirm, changes, candidate, report_layout, no_network_help, mcp_rpc
from fbl_cli import init_pack, install_pack, logs, setup, install_core
from fbl_panel import readiness
from fbl_browser import BrowserDiscovery
from copilot_packages import Packages


def write(path, value):
    private_write(path, json.dumps(value))


class R15(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release_temp = tempfile.TemporaryDirectory(prefix="fbl-r15-package-")
        cls.release = Path(cls.release_temp.name).resolve() / "release"
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/package-agent.py"), "--output", str(cls.release)],
            check=True,
            capture_output=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.release_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fbl-r15-fixture-")
        self.user = Path(self.temp.name).resolve() / "user"
        self.user.mkdir()
        self.hermes = self.user / ".hermes"
        self.runtime = self.user / ".fast-browser-link"
        self.ctx = Context(self.user, self.hermes, self.runtime, self.release)

    def tearDown(self):
        self.temp.cleanup()

    def install(self, layout="standalone"):
        native = load("r15_native", self.release / "native-bridge/install.py")
        roots = []
        if layout in {"standalone", "mixed"}:
            install_core(self.ctx)
            roots.append(self.runtime)
        if layout in {"adapter", "mixed"}:
            plugin = self.hermes / "plugins/fast-browser-link"
            plugin.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(self.release / "adapter/fast-browser-link", plugin)
            native.stage(
                self.user,
                ["chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/"],
                runtime_home=self.hermes,
            )
            roots.append(self.hermes)
        if layout == "adapter":
            self.ctx.runtime = self.hermes
        if layout == "mixed":
            for path in manifests(self.user):
                value = json.loads(path.read_text())
                value["path"] = str(self.ctx.data / "host-bin/com.fast.browser_link")
                write(path, value)
        for root in roots:
            host = root / "plugin-data/fast-browser-link-native/host-bin"
            (host / "old-fixture").write_text("old")
        return roots

    def test_three_layout_update_and_import_failure_rollback_real_filesystem(self):
        records = []
        for layout in ("standalone", "adapter", "mixed"):
            for fail in (False, True):
                with (
                    self.subTest(layout=layout, rollback=fail),
                    tempfile.TemporaryDirectory(prefix="fbl-r15-layout-") as temporary,
                ):
                    self.user = Path(temporary).resolve() / "user"
                    self.user.mkdir()
                    self.hermes = self.user / ".hermes"
                    self.runtime = self.user / ".fast-browser-link"
                    self.ctx = Context(self.user, self.hermes, self.runtime, self.release)
                    roots = self.install(layout)
                    skills = []
                    for agent in (".agents", ".codex"):
                        skill = self.user / agent / "skills/fast-browser-link"
                        skill.mkdir(parents=True)
                        (skill / "SKILL.md").write_text("legacy fixture skill")
                        write(
                            skill / ".fbl-skill.json", {"version": 1, "sha256": tree_digest(skill)}
                        )
                        skills.append(skill)
                    template = self.ctx.copilot / "templates/general.task.json"
                    original_template = template.read_text()
                    template.write_text(original_template + "\n")
                    repair(self.hermes, "fast-copilot", private_write, "old-model")
                    config = self.hermes / "profiles/fast-copilot/config.yaml"
                    value = json.loads(config.read_text())
                    value["model"]["default"] = "migrated-model"
                    value["reasoning_effort"] = "high"
                    value["_config_version"] = 99
                    write(config, value)
                    auth = self.hermes / "profiles/fast-copilot/auth.json"
                    auth.write_text("DO_NOT_COPY_CREDENTIAL")
                    cli = legacy_cli(self.ctx)
                    self.assertTrue(cli.cloud_never_configured(self.ctx.runtime, self.user))
                    original = cli.command

                    def command(argv, env):
                        if fail and "-I" in argv:
                            return subprocess.CompletedProcess(
                                argv, 1, "", "synthetic import failure"
                            )
                        return original(argv, env)

                    with (
                        patch("fbl_update.legacy_cli", return_value=cli),
                        patch.object(cli, "command", side_effect=command),
                    ):
                        if fail:
                            with self.assertRaisesRegex(ValueError, "import validation") as error:
                                update(self.ctx, self.release)
                            self.assertTrue(error.exception.rolled_back)
                            for root in roots:
                                self.assertEqual(
                                    (
                                        root
                                        / "plugin-data/fast-browser-link-native/host-bin/old-fixture"
                                    ).read_text(),
                                    "old",
                                )
                            self.assertEqual(
                                json.loads(config.read_text())["reasoning_effort"], "high"
                            )
                            for skill in skills:
                                self.assertEqual(
                                    (skill / "SKILL.md").read_text(), "legacy fixture skill"
                                )
                        else:
                            result = update(self.ctx, self.release)
                            self.assertEqual(result["status"], "updated")
                            for root in roots:
                                self.assertFalse(
                                    (
                                        root
                                        / "plugin-data/fast-browser-link-native/host-bin/old-fixture"
                                    ).exists()
                                )
                            for skill in skills:
                                self.assertEqual(
                                    (skill / "SKILL.md").read_text(),
                                    (
                                        self.release / "skills/fast-browser-link/SKILL.md"
                                    ).read_text(),
                                )
                            self.assertTrue(template.with_suffix(".json.new").is_file())
                            self.assertEqual(template.read_text(), original_template + "\n")
                            merged = json.loads(config.read_text())
                            self.assertEqual(merged["model"]["default"], "migrated-model")
                            self.assertEqual(merged["_config_version"], 99)
                            self.assertEqual(merged["platform_toolsets"]["acp"], [])
                            self.assertEqual(merged["reasoning_effort"], "low")
                    self.assertEqual(auth.read_text(), "DO_NOT_COPY_CREDENTIAL")
                    for path in self.ctx.runtime.glob("fbl-backups/**/*"):
                        if path.is_file():
                            self.assertNotIn(b"DO_NOT_COPY_CREDENTIAL", path.read_bytes())
                    records.append((layout, "rollback" if fail else "updated"))
        self.assertEqual(len(records), 6)

    def retired_cloud(self):
        self.install()
        state = self.ctx.data / "install-state.json"
        write(state, {"cloudRetired": {"version": 1}})
        cloud = self.ctx.runtime / "plugin-data/fast-browser-link-cloud"
        instance = cloud / "instances/11111111-1111-4111-8111-111111111111"
        instance.mkdir(parents=True, mode=0o700)
        cloud.chmod(0o700)
        instance.parent.chmod(0o700)
        journal = instance / "requests.sqlite"
        with contextlib.closing(sqlite3.connect(journal)) as database, database:
            database.execute(
                "CREATE TABLE commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, delivered INTEGER NOT NULL DEFAULT 0)"
            )
            database.execute(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT, last_used REAL NOT NULL, closed INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0)"
            )
            database.execute("INSERT INTO commands VALUES ('old', 'digest', '{}', 1)")
            database.execute("INSERT INTO sessions VALUES ('old', 'task', 1, 1, 1)")
        journal.chmod(0o600)
        private_write(instance / "pairing.json", "opaque private fixture")
        lock = instance / "native.lock"
        lock.touch(mode=0o600)
        return cloud, journal, lock, state

    def assert_cloud_lock_held(self, lock):
        # 中文注释：独立打开实际实例锁，不能用 mock 证明交换和回滚期间仍持有排他锁。
        with lock.open("r") as descriptor:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_retired_cloud_update_preserves_private_data_and_locks_import_validation(self):
        cloud, _, lock, state = self.retired_cloud()
        before = {
            path: (path.read_bytes(), path.stat().st_ino)
            for path in [state, *cloud.rglob("*")]
            if path.is_file()
        }
        cli = legacy_cli(self.ctx)
        self.assertTrue(cli.cloud_retired(self.ctx.runtime, self.user))
        self.assertFalse(cli.cloud_never_configured(self.ctx.runtime, self.user))
        original = cli.command
        original_replace = os.replace
        imports = []
        swaps = []

        def command(argv, env):
            if "-I" in argv:
                self.assert_cloud_lock_held(lock)
                imports.append(argv)
            return original(argv, env)

        def replace(source, target):
            if Path(target) == self.ctx.data / "host-bin":
                self.assert_cloud_lock_held(lock)
                swaps.append(Path(target))
            return original_replace(source, target)

        with (
            patch("fbl_update.legacy_cli", return_value=cli),
            patch.object(cli, "command", side_effect=command),
            patch("fbl_update.os.replace", side_effect=replace),
        ):
            result = update(self.ctx, self.release)
        self.assertEqual(result["status"], "updated")
        self.assertEqual(len(imports), 1)
        self.assertEqual(len(swaps), 1)
        self.assertFalse((self.ctx.data / "host-bin/old-fixture").exists())
        self.assertEqual(
            before,
            {
                path: (path.read_bytes(), path.stat().st_ino)
                for path in [state, *cloud.rglob("*")]
                if path.is_file()
            },
        )
        with lock.open("r") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def retired_cloud_rollback(self, *, restart=False):
        cloud, _, lock, state = self.retired_cloud()
        before = {path: path.read_bytes() for path in [state, *cloud.rglob("*")] if path.is_file()}
        old_host = tree_digest(self.ctx.data / "host-bin")
        cli = legacy_cli(self.ctx)
        original_command = cli.command
        original_replace = os.replace
        restored = []

        def command(argv, env):
            if "-I" in argv:
                self.assert_cloud_lock_held(lock)
                if not restart:
                    return subprocess.CompletedProcess(argv, 1, "", "synthetic import failure")
            return original_command(argv, env)

        def replace(source, target):
            if Path(source).name.startswith("old-"):
                self.assert_cloud_lock_held(lock)
                restored.append(Path(target))
            return original_replace(source, target)

        def health(_):
            self.assert_cloud_lock_held(lock)
            return {"ok": False}

        calls = 0

        def verified_pid(*_):
            nonlocal calls
            calls += 1
            # 中文注释：仅模拟更新前曾运行，禁止夹具真正启动服务；停止和文件交换仍走正式路径。
            return 123 if restart and calls == 1 else None

        with (
            patch("fbl_update.legacy_cli", return_value=cli),
            patch.object(cli, "command", side_effect=command),
            patch.object(cli, "verified_daemon_pid", side_effect=verified_pid),
            patch("client.BridgeClient") as client,
            patch("fbl_update.os.replace", side_effect=replace),
        ):
            expected = "restarted daemon" if restart else "import validation"
            with self.assertRaisesRegex(ValueError, expected) as error:
                update(self.ctx, self.release, health=health)
            self.assertEqual(client.call_count, 2 if restart else 0)
        self.assertTrue(getattr(error.exception, "rolled_back", False))
        self.assertIn(self.ctx.data / "host-bin", restored)
        self.assertEqual(tree_digest(self.ctx.data / "host-bin"), old_host)
        self.assertEqual(
            before,
            {path: path.read_bytes() for path in [state, *cloud.rglob("*")] if path.is_file()},
        )
        self.assertFalse((self.ctx.data / "maintenance.json").exists())
        with lock.open("r") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_retired_cloud_import_failure_holds_lock_through_real_rollback(self):
        self.retired_cloud_rollback()

    def test_retired_cloud_restart_failure_holds_lock_through_health_and_rollback(self):
        self.retired_cloud_rollback(restart=True)

    def test_retired_cloud_rejects_unknown_wal_schema_pending_and_live_lock_without_data_loss(self):
        cloud, journal, lock, state = self.retired_cloud()
        cli = legacy_cli(self.ctx)
        original_journal = journal.read_bytes()
        original_state = state.read_bytes()
        host = self.ctx.data / "host-bin"
        host_before = tree_digest(host)
        for case in ("unknown", "wal", "schema", "undelivered", "unsynced", "live_lock"):
            with self.subTest(case=case), contextlib.ExitStack() as stack:
                try:
                    if case == "unknown":
                        write(state, {"cloudRetired": {"version": 2}})
                    elif case == "wal":
                        private_write(Path(str(journal) + "-wal"), "unmerged fixture")
                    elif case in {"schema", "undelivered", "unsynced"}:
                        with contextlib.closing(sqlite3.connect(journal)) as database, database:
                            database.execute(
                                {
                                    "schema": "ALTER TABLE sessions ADD COLUMN future INTEGER",
                                    "undelivered": "UPDATE commands SET delivered=0",
                                    "unsynced": "UPDATE sessions SET synced=0",
                                }[case]
                            )
                    else:
                        descriptor = stack.enter_context(lock.open("r"))
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    before = {
                        path: (path.read_bytes(), path.stat().st_ino)
                        for path in [state, *cloud.rglob("*")]
                        if path.is_file()
                    }
                    with (
                        patch("fbl_update.legacy_cli", return_value=cli),
                        patch.object(
                            cli, "assert_cloud_fenced", wraps=cli.assert_cloud_fenced
                        ) as fence,
                        patch.object(cli, "wait_cloud_released") as wait,
                    ):
                        with self.assertRaisesRegex(ValueError, "Cloud state is active or unknown"):
                            update(self.ctx, self.release)
                        self.assertEqual(fence.call_count, 1 if case == "unknown" else 0)
                        wait.assert_not_called()
                    self.assertEqual(tree_digest(host), host_before)
                    self.assertEqual(
                        before,
                        {
                            path: (path.read_bytes(), path.stat().st_ino)
                            for path in [state, *cloud.rglob("*")]
                            if path.is_file()
                        },
                    )
                    self.assertFalse((self.ctx.data / "maintenance.json").exists())
                finally:
                    journal.write_bytes(original_journal)
                    state.write_bytes(original_state)
                    Path(str(journal) + "-wal").unlink(missing_ok=True)
        with lock.open("r") as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_idle_unknown_operation_and_cloud_gate_fail_closed(self):
        self.install()
        cli = legacy_cli(self.ctx)
        task = {
            "id": "fixture",
            "owner": "fixture",
            "state": "running",
            "cleanupState": "pending",
            "requestHistory": [],
        }
        write(self.ctx.data / "tasks.json", {"version": 1, "tasks": [task]})
        # 中文注释：确认现有安装器使用的真实持久化文件位置。
        path, _ = cli.private_task_files(self.ctx.runtime)
        write(path, {"version": 1, "tasks": [task]})
        with self.assertRaisesRegex(ValueError, "active or unsettled"):
            idle(self.ctx, cli)
        task.update(state="closed", cleanupState="succeeded", currentOperation={"state": "unknown"})
        write(path, {"version": 1, "tasks": [task]})
        with self.assertRaises(ValueError):
            idle(self.ctx, cli)
        task["currentOperation"]["state"] = "succeeded"
        write(path, {"version": 1, "tasks": [task]})
        idle(self.ctx, cli)
        (self.ctx.runtime / "plugin-data/fast-browser-link-cloud").mkdir()
        self.assertFalse(cli.cloud_never_configured(self.ctx.runtime, self.user))
        with self.assertRaises(cli.CloudGateError):
            cli.assert_cloud_fenced(self.ctx.runtime)

    def test_profile_merge_ownership_and_unknown_config_preservation(self):
        repair(self.hermes, "fast-copilot", private_write, "initial")
        target = self.hermes / "profiles/fast-copilot/config.yaml"
        value = json.loads(target.read_text())
        value.update(_config_version=101, reasoning_effort="high", custom={"keep": True})
        value["model"]["default"] = "migrated"
        value["platform_toolsets"]["acp"] = ["unsafe"]
        write(target, value)
        repair(self.hermes, "fast-copilot", private_write, "ignored")
        value = json.loads(target.read_text())
        self.assertEqual(value["model"]["default"], "migrated")
        self.assertEqual(value["custom"], {"keep": True})
        self.assertEqual(value["reasoning_effort"], "low")
        self.assertEqual(value["platform_toolsets"]["acp"], [])
        self.assertEqual(value["known_plugin_toolsets"]["acp"], ["fast-browser-link"])
        before = target.read_bytes()
        repair(self.hermes, "fast-copilot", private_write)
        self.assertEqual(before, target.read_bytes())
        self.assertEqual(profile_plan(self.hermes, "fast-copilot")["state"], "ready")
        (self.hermes / "profiles/fast-copilot/.copilot-profile.json").unlink()
        unknown = self.hermes / "profiles/fast-copilot/config.yaml"
        write(unknown, {"model": "USER"})
        self.assertEqual(repair(self.hermes, "fast-copilot", private_write)["state"], "unmanaged")
        self.assertEqual(json.loads(unknown.read_text()), {"model": "USER"})

    def test_doctor_each_chain_safe_fix_and_malformed_preservation(self):
        self.install()
        repair(self.hermes, "fast-copilot", private_write, "fixture")
        config = self.hermes / "profiles/fast-copilot/config.yaml"
        value = json.loads(config.read_text())
        value["reasoning_effort"] = "high"
        write(config, value)
        manifests(self.user)[0].unlink()
        live = lambda _: {"ok": True, "browsers": [{"connected": True, "version": "2.2.0"}]}
        result = doctor(self.ctx, probe=live)
        self.assertFalse(
            next(row for row in result["checks"] if row["component"] == "host_chrome")["ok"]
        )
        result = doctor(self.ctx, fix=True, probe=live)
        self.assertIn("manifest", result["actions"])
        self.assertIn("fast-copilot", result["actions"])
        self.assertEqual(json.loads(config.read_text())["reasoning_effort"], "low")
        names = {row["component"] for row in result["checks"]}
        self.assertTrue(
            {
                "runtime",
                "daemon",
                "extension",
                "version",
                "runtime_integrity",
                "runtime_root",
                "hermes",
                "fast-copilot",
                "packages",
                "models",
                "templates",
                "logs",
                "discovery",
                "cloud",
            }
            <= names
        )
        manifests(self.user)[0].write_text("{broken")
        doctor(self.ctx, fix=True, probe=live)
        self.assertEqual(manifests(self.user)[0].read_text(), "{broken")

    def test_available_model_selection_is_metadata_driven(self):
        self.assertEqual(
            choose_model(
                {
                    "availableModels": [
                        {"modelId": "vendor:large"},
                        {"modelId": "vendor:fixture", "speed": "fast"},
                    ]
                }
            ),
            ("fixture", "vendor"),
        )
        with self.assertRaises(ValueError):
            choose_model({"availableModels": []})

    def skill(self, name, manifest=None):
        root = self.user / ".agents/skills" / name
        private_write(root / "SKILL.md", "Synthetic skill metadata")
        if manifest:
            write(root / "fbl-capabilities.json", manifest)
        return root

    def test_discovery_all_sources_defaults_confirm_change_and_no_query(self):
        skill = self.skill(
            "declared",
            {
                "version": 1,
                "bindings": [
                    {
                        "capability": "keyword.expand",
                        "cost": "zero",
                        "binding": {
                            "id": "local-expand",
                            "type": "command",
                            "argv": [sys.executable, "scripts/tool.py", "{keyword}"],
                        },
                    }
                ],
            },
        )
        private_write(skill / "scripts/tool.py", 'print("help only")')
        draft_skill = self.skill("unlisted")
        private_write(draft_skill / "scripts/helper.py", 'print("help")')
        write(
            self.user / ".claude.json",
            {
                "mcpServers": {
                    "fixture": {"command": "fixture-mcp", "env": {"PRIVATE_VALUE": "NEVER_EXPORT"}}
                }
            },
        )
        calls = []

        def help_probe(argv):
            calls.append(("help", argv))
            return {"status": "available", "help": "keyword expand help", "digest": "help-hash"}

        def mcp_probe(server, method):
            self.assertEqual(method, "tools/list")
            calls.append(("schema", method))
            return {
                "tools": [
                    {
                        "name": "keyword_expand",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        def model(rows):
            calls.append(("model", len(rows)))
            return [
                {
                    "capability": "keyword.questions",
                    "source_ref": str(draft_skill / "SKILL.md"),
                    "binding": {
                        "id": "draft-questions",
                        "type": "command",
                        "argv": [sys.executable, str(draft_skill / "scripts/helper.py")],
                    },
                }
            ]

        pages = []

        def page(url):
            pages.append(url)
            return {"tables": [{"headers": ["Keyword", "Volume", "KD"]}], "blocked": None}

        value = scan(
            self.ctx,
            draft=model,
            help_probe=help_probe,
            mcp_probe=mcp_probe,
            browser_probe=page,
            urls=["https://example.test/report"],
            scan_tabs=True,
            tab_probe=lambda: [{"url": "https://other.example.test/report", "title": "Report"}],
        )
        self.assertEqual(
            {row["source"] for row in value["candidates"]},
            {"manifest", "model_draft", "mcp", "browser"},
        )
        self.assertEqual(len([row for row in value["candidates"] if row["selected"]]), 1)
        self.assertEqual(len(pages), 2)
        self.assertNotIn("NEVER_EXPORT", json.dumps(value))
        self.assertEqual(sum(row[0] == "model" for row in calls), 1)
        selected = [row["id"] for row in value["candidates"] if row["source"] != "browser"]
        result = confirm(self.ctx, selected)
        self.assertEqual(Path(result["path"]), self.ctx.copilot / "extensions/discovered")
        package = Packages([result["path"]], include_builtin=False)
        self.assertIn("keyword.expand", package.bindings)
        self.assertIn(
            result["path"],
            json.loads((self.ctx.copilot / "config.json").read_text())["extension_dirs"],
        )
        before = (Path(result["path"]) / "package.json").read_bytes()
        bad = next(row["id"] for row in value["candidates"] if row["source"] == "manifest")
        with self.assertRaises(ValueError):
            confirm(self.ctx, [bad], {bad: {"batch_limit": 0}})
        self.assertEqual(before, (Path(result["path"]) / "package.json").read_bytes())
        self.assertFalse(changes(self.ctx))
        changed = changes(
            self.ctx,
            deep=True,
            help_probe=lambda _: {"digest": "new"},
            mcp_probe=lambda *_: {"tools": []},
        )
        self.assertTrue(any(row.startswith("help:") for row in changed))
        self.assertTrue(any(row.startswith("mcp:") for row in changed))
        private_write(skill / "scripts/tool.py", "changed")
        self.assertTrue(changes(self.ctx))
        self.skill("new-skill")
        self.assertTrue(any("new-skill" in row for row in changes(self.ctx)))
        # 中文注释：深度检查已撤销变更的 MCP 候选，旧 ID 不能再次确认。
        with self.assertRaisesRegex(ValueError, "unknown discovery candidate"):
            confirm(self.ctx, selected)

    def test_layout_login_cost_and_default_selection(self):
        self.assertIsNone(
            report_layout(
                "https://example.test/",
                {"blocked": "login", "tables": [{"headers": ["keyword", "volume"]}]},
            )
        )
        for cost, confidence, valid, expected in [
            ("zero", 1, "available", True),
            ("paid", 1, "available", False),
            ("unknown", 1, "available", False),
            ("zero", 0.8, "available", False),
            ("zero", 1, "needs_login", False),
        ]:
            self.assertEqual(
                candidate({"cost": cost, "confidence": confidence, "validation": valid})[
                    "selected"
                ],
                expected,
            )
        with self.assertRaises(ValueError):
            report_layout("file:///private.txt", {})

    def test_help_network_fence_removes_query_args(self):
        seen = []

        def runner(argv, **kwargs):
            seen.append(argv)
            return subprocess.CompletedProcess(argv, 0, "help", "")

        with patch("shutil.which", return_value="/usr/bin/sandbox-exec"):
            no_network_help([sys.executable, "--query", "NEVER_QUERY"], runner)
        self.assertEqual(seen[0][-2:], [sys.executable, "--help"])
        self.assertIn("(deny network*)", seen[0][2])

    def test_mcp_metadata_protocol_only_no_actual_tool(self):
        script = self.user / "mcp.py"
        record = self.user / "methods.jsonl"
        script.write_text(
            'import sys,json\nfrom pathlib import Path\nfor line in sys.stdin:\n r=json.loads(line);p=Path(sys.argv[1]);p.open("a").write(r["method"]+"\\n")\n if "id" in r:print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":{"tools":[]}}),flush=True)\n'
        )
        self.assertEqual(
            mcp_rpc({"command": sys.executable, "args": [str(script), str(record)]}, "tools/list"),
            {"tools": []},
        )
        self.assertEqual(
            record.read_text().splitlines(),
            ["initialize", "notifications/initialized", "tools/list"],
        )

    def test_packs_init_paths_and_managed_install(self):
        result = init_pack(
            self.ctx, "fixture", [sys.executable], "https://example.test/report", "keyword.expand"
        )
        Packages([result["path"]], include_builtin=False)
        with self.assertRaises(ValueError):
            init_pack(self.ctx, "../outside")
        with self.assertRaisesRegex(ValueError, "script path"):
            init_pack(
                self.ctx,
                "bad",
                [sys.executable, "/missing/fixture.py"],
                capability="keyword.expand",
            )
        self.assertFalse((self.ctx.copilot / "extensions/bad").exists())
        install_pack(self.ctx, "general")
        install_pack(self.ctx, "seo")
        Packages(
            json.loads((self.ctx.copilot / "config.json").read_text())["extension_dirs"],
            include_builtin=False,
        )
        install_pack(self.ctx, "general", remove=True)
        self.assertFalse((self.ctx.copilot / "packs/general").exists())

    def test_log_filter_and_shareable_bundle_excludes_arbitrary_text(self):
        directory = self.ctx.copilot / "logs"
        write(directory / "2026.events.jsonl", {})
        rows = [
            {
                "id": 1,
                "time": 1,
                "type": "system",
                "event": "disconnected",
                "error": True,
                "details": {
                    "reason": "acp_timeout",
                    "detail": "PRIVATE_PAGE_SENTINEL",
                    "argv": ["PRIVATE_PAGE_SENTINEL"],
                },
            },
            {"id": 2, "time": 2, "type": "capture", "event": "capture", "details": {"count": 1}},
            {"id": 3, "time": 3, "type": "system", "event": "PRIVATE_PAGE_SENTINEL", "details": {}},
        ]
        (directory / "2026.events.jsonl").write_text("\n".join(map(json.dumps, rows)))
        private_write(
            directory / "2026.hermes-stderr.log",
            "ERROR LEGACY_AGENT_LOG\nERROR PRIVATE_PAGE_SENTINEL token=secret-value",
        )
        private_write(
            directory / "2026.agent-stderr.log",
            "ERROR NEW_AGENT_LOG\nERROR private page alpha\nValueError: private page beta",
        )
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stderr):
            logs(self.ctx, kind="stderr")
        self.assertIn("NEW_AGENT_LOG", stderr.getvalue())
        self.assertIn("LEGACY_AGENT_LOG", stderr.getvalue())
        self.assertNotIn("PRIVATE_PAGE_SENTINEL", stderr.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            logs(self.ctx, kind="system", errors=True)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertNotIn("PRIVATE_PAGE_SENTINEL", output.getvalue())
        with patch(
            "fbl_cli.doctor",
            return_value={
                "checks": [
                    {
                        "component": "runtime",
                        "ok": True,
                        "code": "installed",
                        "path": "PRIVATE_PAGE_SENTINEL",
                    }
                ]
            },
        ):
            logs(self.ctx, bundle=self.user / "diagnostics.tar.gz")
        with tarfile.open(self.user / "diagnostics.tar.gz") as archive:
            text = "".join(
                archive.extractfile(member).read().decode() for member in archive.getmembers()
            )
            self.assertNotIn("PRIVATE_PAGE_SENTINEL", text)
            self.assertNotIn("secret-value", text)
            self.assertNotIn("private page alpha", text)
            self.assertNotIn("private page beta", text)

    def test_first_readiness_discovery_and_symlink_refusal(self):
        result = readiness(self.ctx, {"checks": []})
        self.assertFalse(result["ready"])
        self.assertIn("discovery", [row["id"] for row in result["items"]])
        write(
            self.ctx.copilot / "fbl-state.json",
            {"setup_complete": True, "discovery_reviewed": True},
        )
        checks = [
            {"component": name, "ok": True}
            for name in (
                "runtime",
                "daemon",
                "extension",
                "runtime_integrity",
                "version",
                "host_chrome",
                "templates",
                "fast-copilot",
            )
        ]
        self.assertTrue(readiness(self.ctx, {"checks": checks})["ready"])
        (self.ctx.copilot / "drafts").symlink_to(self.user / "outside", target_is_directory=True)
        with self.assertRaises(ValueError):
            init_pack(self.ctx, "unsafe")

    def test_update_tampered_release_rejected_before_install_mutation(self):
        self.install()
        copy = self.user / "release"
        shutil.copytree(self.release, copy)
        (copy / "fbl.py").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            update(self.ctx, copy)
        self.assertTrue((self.ctx.data / "host-bin/old-fixture").is_file())
        self.assertFalse((self.ctx.runtime / "fbl-backups").exists())

    def test_setup_yes_without_hermes_installs_python_entry_and_general_only(self):
        def discover(ctx, *args):
            return scan(
                ctx,
                help_probe=lambda _: {
                    "status": "available",
                    "help": "fixture help",
                    "digest": "fixture",
                },
                mcp_probe=lambda *_: {"tools": []},
            )

        with (
            patch("fbl_cli.shutil.which", return_value=None),
            patch("fbl_cli.discover", side_effect=discover),
        ):
            result = setup(self.ctx, yes=True)
        self.assertEqual(result["status"], "configured")
        self.assertFalse((self.ctx.copilot / "packs/seo").exists())
        self.assertTrue((self.ctx.copilot / "packs/general/package.json").is_file())
        self.assertTrue((self.ctx.data / "host-bin/fbl-support/update.py").is_file())
        entry = self.user / ".local/bin/fbl"
        command = subprocess.run(
            [str(entry), "--help"],
            capture_output=True,
            text=True,
            env={**os.environ, "PATH": "/no-node-or-hermes"},
        )
        self.assertEqual(command.returncode, 0, command.stderr)
        self.assertIn("doctor", command.stdout)
        self.assertEqual(
            json.loads((self.ctx.copilot / "fbl-state.json").read_text())["setup_complete"], True
        )

    def test_browser_discovery_uses_only_owned_navigation_headers_and_cleanup(self):
        calls = []

        class Client:
            def __init__(inner, *_):
                pass

            def call(inner, method, params):
                calls.append((method, params))
                if method == "browser.list":
                    return [{"instanceId": "fixture", "connected": True}]
                if method == "fbl.tabs":
                    return [{"url": "https://example.test/report", "title": "Report"}]
                if method == "shared.create":
                    return {"id": "task", "state": "ready"}
                if method == "shared.close":
                    return {"cleanupState": "succeeded"}
                if method == "shared.run" and params["action"] == "new_tab":
                    return {"tabId": 7}
                if method == "shared.run":
                    self.assertEqual(params["options"]["mode"], "table")
                    self.assertNotIn("mode", params)
                    return {"items": [{"role": "row", "cells": ["Keyword", "Volume", "KD"]}]}
                return {}

            def close(inner):
                calls.append(("client.close", {}))

        browser = BrowserDiscovery(self.ctx, Client)
        self.assertEqual(len(browser.tabs()), 1)
        value = browser.page("https://example.test/report")
        self.assertEqual(value["tables"][0]["headers"], ["Keyword", "Volume", "KD"])
        self.assertEqual(
            [params["action"] for method, params in calls if method == "shared.run"],
            ["new_tab", "semantic_snapshot"],
        )
        self.assertTrue(any(method == "shared.close" for method, _ in calls))

    def test_http_mcp_schema_handshake_never_calls_tool_or_follows_redirect(self):
        from email.message import Message
        from fbl_discovery import mcp_http

        calls = []

        class Response:
            headers = Message()
            headers["Content-Type"] = "application/json"

            def __enter__(inner):
                return inner

            def __exit__(inner, *_):
                pass

            def read(inner, limit):
                return json.dumps(
                    {"jsonrpc": "2.0", "id": calls[-1].get("id"), "result": {"tools": []}}
                ).encode()

        class Opener:
            def open(inner, request, timeout):
                calls.append(json.loads(request.data))
                return Response()

        with patch("urllib.request.build_opener", return_value=Opener()):
            self.assertEqual(
                mcp_http({"url": "https://example.test/mcp"}, "tools/list", {}), {"tools": []}
            )
        self.assertEqual(
            [row["method"] for row in calls],
            ["initialize", "notifications/initialized", "tools/list"],
        )

    def test_maintenance_client_starts_selected_installed_daemon_instead_of_download(self):
        import client

        self.install()
        spawned = []
        with (
            patch.object(client, "_probe", side_effect=[False, False, False, True]),
            patch.object(client, "_spawn_detached", side_effect=lambda argv: spawned.append(argv)),
        ):
            client.ensure_service(self.ctx.runtime)
        self.assertEqual(Path(spawned[0][1]), self.ctx.data / "host-bin/assist_adapter.py")
        self.assertEqual(spawned[0][-1], str(self.ctx.runtime))

    def test_update_dry_run_leaves_installation_and_backups_untouched(self):
        self.install()
        result = update(self.ctx, self.release, dry_run=True)
        self.assertEqual(result["status"], "dry_run")
        self.assertTrue((self.ctx.data / "host-bin/old-fixture").is_file())
        self.assertFalse((self.ctx.runtime / "fbl-backups").exists())

    def test_prebuilt_python_module_dry_run_without_node_preserves_full_manifest(self):
        target = self.user / "no-write-user"
        result = subprocess.run(
            [sys.executable, "-B", "-m", "fbl", "setup", "--dry-run", "--user-home", str(target)],
            cwd=self.release,
            capture_output=True,
            text=True,
            env={**os.environ, "PATH": "/no-node-or-hermes"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "dry_run")
        self.assertFalse(target.exists())
        verify_source(self.release)

    def test_source_setup_dry_run_does_not_create_directories(self):
        context = Context(
            self.user / "absent",
            self.user / "absent/.hermes",
            self.user / "absent/.fast-browser-link",
            ROOT,
        )
        result = setup(context, dry_run=True)
        self.assertEqual(result["status"], "dry_run")
        self.assertFalse(context.user.exists())


if __name__ == "__main__":
    unittest.main()
