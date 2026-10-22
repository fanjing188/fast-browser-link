"""R24 宿主回归：临时安装树与真实 socketpair，不改本机安装。"""

import ast
import contextlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
import daemon
import fbl_cli
from copilot import Copilot, inference_prompt
from copilot_setup import setup as templates_setup
from fbl_panel import readiness
from fbl_runtime import Context, ORIGIN, agent_roots, doctor, private_write
from fbl_profiles import repair
from fbl_update import update
import test_r15 as fixtures


class HostLayouts(unittest.TestCase):
    setUpClass = fixtures.R15.__dict__["setUpClass"]
    tearDownClass = fixtures.R15.__dict__["tearDownClass"]
    setUp = fixtures.R15.setUp
    tearDown = fixtures.R15.tearDown
    install = fixtures.R15.install

    def assert_import_closure(self):
        host = self.ctx.data / "host-bin"
        registered = set(json.loads((host / "runtime-version.json").read_text())["files"])
        local = {path.stem for path in (ROOT / "native-bridge").glob("*.py")}
        local.add("task_diagnostics")
        missing = []
        for path in host.rglob("*.py"):
            if "fbl-assets" in path.parts or "fbl-support" in path.parts:
                continue
            for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
                if isinstance(node, ast.Import):
                    imports = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    imports = [(node.module or "").split(".")[0]]
                else:
                    continue
                for name in imports:
                    if name in local:
                        if not (host / (name + ".py")).is_file():
                            missing.append(f"{path.name}: {name}")
                        if name != "task_diagnostics":
                            self.assertIn(name + ".py", registered)
                    elif name == "browser_diagnostics":
                        self.assertTrue((host / name / "__init__.py").is_file())
        self.assertEqual(missing, [])
        self.assertIn("doctor.py", registered)

    def test_install_and_update_host_bin_contains_ast_local_import_closure(self):
        self.install()
        self.assert_import_closure()
        with patch("client.BridgeClient") as client:
            result = update(self.ctx, self.release, health=lambda _: {"ok": True})
        self.assertEqual(result["status"], "updated")
        self.assert_import_closure()
        client.assert_not_called()

    def test_manual_install_is_ready_without_cli_state_flags(self):
        self.install()
        for name in ("fast-copilot",):
            repair(self.hermes, name, private_write, "fixture-model")
        version = json.loads((self.ctx.data / "host-bin/runtime-version.json").read_text())[
            "version"
        ]
        probe = lambda _: {
            "ok": True,
            "daemonVersion": version,
            "browsers": [{"connected": True, "version": version}],
        }
        with patch("fbl_runtime.shutil.which", return_value=None):
            diagnostic = doctor(self.ctx, probe=probe)
        self.assertFalse((self.ctx.copilot / "fbl-state.json").exists())
        self.assertTrue(readiness(self.ctx, diagnostic)["ready"])
        (self.ctx.copilot / "fbl-state.json").write_text(
            json.dumps({"setup_complete": False, "discovery_reviewed": False})
        )
        self.assertTrue(readiness(self.ctx, diagnostic)["ready"])
        (self.ctx.data / "host-bin/runtime-version.json").unlink()
        with patch("fbl_runtime.shutil.which", return_value=None):
            legacy = doctor(self.ctx, probe=probe)
        integrity = next(row for row in legacy["checks"] if row["component"] == "runtime_integrity")
        self.assertTrue(integrity["ok"])
        self.assertEqual(integrity["code"], "unregistered")
        self.assertTrue(readiness(self.ctx, legacy)["ready"])

    def test_setup_preserves_unmanaged_skill_and_completes_other_steps(self):
        self.install()
        legacy = self.user / ".codex/skills/fast-browser-link"
        legacy.mkdir(parents=True)
        original = b"legacy local skill\n"
        (legacy / "SKILL.md").write_bytes(original)
        (self.user / ".agents").mkdir()
        with (
            patch("fbl_runtime.shutil.which", return_value=None),
            patch("fbl_cli.doctor", return_value={"ok": True}),
        ):
            result = fbl_cli.setup(self.ctx, yes=True)
        self.assertEqual(result["status"], "configured")
        self.assertEqual((legacy / "SKILL.md").read_bytes(), original)
        self.assertFalse((legacy / ".fbl-skill.json").exists())
        self.assertEqual(
            result["preserved_skills"],
            [{"path": str(legacy), "status": "preserved_unmanaged", "message": "保留未接管"}],
        )
        self.assertTrue((self.user / ".agents/skills/fast-browser-link/.fbl-skill.json").is_file())
        self.assertTrue(result["packs"])
        self.assertTrue((self.ctx.copilot / "fbl-state.json").is_file())


class Initialization(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fbl-r24-host-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ctx = Context(
            self.root / "user", self.root / "user/.hermes", self.root / "runtime", ROOT
        )

    def checks(self):
        return {
            "checks": [
                {"component": name, "ok": True, "code": "verified"}
                for name in (
                    "runtime",
                    "daemon",
                    "extension",
                    "host_edge",
                    "runtime_integrity",
                    "templates",
                    "fast-copilot",
                )
            ]
        }

    def test_readiness_uses_actual_installation_without_setup_state_file(self):
        self.assertFalse((self.ctx.copilot / "fbl-state.json").exists())
        result = readiness(self.ctx, self.checks())
        self.assertTrue(result["ready"])
        self.assertTrue(all(item["ok"] for item in result["items"]))
        diagnostic = self.checks()
        next(row for row in diagnostic["checks"] if row["component"] == "fast-copilot")["ok"] = (
            False
        )
        item = next(row for row in readiness(self.ctx, diagnostic)["items"] if row["id"] == "setup")
        self.assertFalse(item["ok"])

    def test_integrity_failure_is_independent_of_browser_connection(self):
        diagnostic = self.checks()
        next(row for row in diagnostic["checks"] if row["component"] == "runtime_integrity").update(
            ok=False, code="mismatch"
        )
        items = {row["id"]: row for row in readiness(self.ctx, diagnostic)["items"]}
        self.assertTrue(items["browser"]["ok"])
        self.assertTrue(items["setup"]["ok"])
        self.assertFalse(items["integrity"]["ok"])
        self.assertEqual(items["integrity"]["command"], "fbl update")

    def test_discovery_is_checked_until_confirmed_sources_change(self):
        source = self.root / "source/SKILL.md"
        source.parent.mkdir()
        source.write_text("source v1")
        from fbl_discovery import file_digest

        self.ctx.copilot.mkdir(parents=True)
        (self.ctx.copilot / "discovery-confirmed.json").write_text(
            json.dumps({"files": {str(source): file_digest(source)}})
        )

        def checked():
            return next(
                row["ok"]
                for row in readiness(self.ctx, self.checks())["items"]
                if row["id"] == "discovery"
            )

        self.assertTrue(checked())
        source.write_text("source v2")
        self.assertFalse(checked())

    def test_default_skills_only_detected_agents_and_dedicated_profiles(self):
        for profile in ("fast-copilot", "member"):
            (self.ctx.hermes / "profiles" / profile).mkdir(parents=True)
        (self.ctx.user / ".codex").mkdir()
        with patch("fbl_runtime.shutil.which", return_value=None):
            rows = agent_roots(self.ctx)
            roots = {Path(row["path"]) for row in rows if row["detected"]}
            self.assertIn(self.ctx.user / ".codex/skills", roots)
            self.assertNotIn(self.ctx.user / ".claude/skills", roots)
            self.assertNotIn(self.ctx.hermes / "profiles/member/skills", roots)
            self.assertTrue(
                all(
                    self.ctx.hermes / f"profiles/{name}/skills" in roots
                    for name in ("fast-copilot",)
                )
            )
            installed = fbl_cli.install_skills(
                self.ctx, [row["agent"] for row in rows if row["detected"]]
            )
            self.assertFalse((self.ctx.hermes / "profiles/member/skills").exists())
            self.assertFalse((self.ctx.user / ".claude").exists())
            self.assertTrue(installed)
            fbl_cli.install_skills(self.ctx, ["hermes"], profiles=["member"])
            self.assertTrue(
                (
                    self.ctx.hermes / "profiles/member/skills/fast-browser-link/.fbl-skill.json"
                ).is_file()
            )
            with self.assertRaisesRegex(ValueError, "invalid agent profile"):
                agent_roots(self.ctx, ["../other"])

    def test_setup_cli_passes_explicit_profile_parameter(self):
        with (
            patch.object(Context, "locate", return_value=self.ctx),
            patch("fbl_cli.setup", return_value={"status": "fixture"}) as setup,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(fbl_cli.main(["setup", "--yes", "--agent-profile", "member"]), 0)
        self.assertEqual(setup.call_args.kwargs["agent_profiles"], ["member"])

    def test_suggestion_title_32_characters_and_prompt_contract(self):
        directory = self.root / "fast-copilot"
        templates_setup(directory)
        app = Copilot(directory)
        self.addCleanup(app.close)
        app.config["auto_zero"] = False
        state = app._state("fixture")
        title = "Check job scheduler SEO metrics"
        app._replace(
            "fixture",
            {
                "scene": "general",
                "suggestions": [
                    {
                        "title": title,
                        "why": "fixture",
                        "action": "local.lookup",
                        "params": {"value": "one"},
                    }
                ],
            },
        )
        self.assertEqual(next(iter(state["suggestions"].values()))["title"], title)
        app._replace(
            "fixture",
            {
                "scene": "general",
                "suggestions": [
                    {
                        "title": "x" * 40,
                        "why": "fixture",
                        "action": "local.lookup",
                        "params": {"value": "two"},
                    }
                ],
            },
        )
        row = next(
            row for row in state["suggestions"].values() if row["params"].get("value") == "two"
        )
        self.assertEqual(row["title"], "x" * 31 + "…")
        self.assertIn("标题最多32字", inference_prompt({}, app.templates))
        app.templates.language = "en"
        self.assertIn("up to 32 chars", inference_prompt({}, app.templates))


class ExtensionFailures(unittest.TestCase):
    def test_unexpected_request_failure_keeps_socket_and_writes_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix="fbl-r24-socket-") as directory:
            app = daemon.BridgeDaemon(Path(directory).resolve())
            app._persist_tasks = lambda: None
            app._ungroup_terminal_tasks = lambda *_: None
            client, server = socket.socketpair()
            client.settimeout(3)
            errors = []

            def serve():
                try:
                    with server.makefile("rb") as reader:
                        app._serve_extension(server, reader, ORIGIN)
                except (EOFError, OSError):
                    pass
                except Exception as error:
                    errors.append(error)

            def dispatch(extension, method, params):
                if method == "copilot.fbl_readiness":
                    raise ModuleNotFoundError("sensitive fixture path must not be returned")
                if method == "fixture.value_error":
                    raise ValueError("fixture arbitrary error")
                return {"alive": True}

            app._dispatch_connected_extension = dispatch
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            try:
                with client.makefile("rb") as reader:

                    def request(identity, method, params):
                        client.sendall(
                            daemon._encode_line(
                                {"id": identity, "method": method, "params": params}
                            )
                        )
                        while True:
                            response = json.loads(reader.readline())
                            if response.get("id") == identity:
                                return response

                    hello = request(
                        "hello",
                        "extension.hello",
                        {"instanceId": "fixture", "browser": "edge", "version": "fixture"},
                    )
                    self.assertTrue(hello["result"]["connected"])
                    for identity, method, kind in [
                        ("missing", "copilot.fbl_readiness", "ModuleNotFoundError"),
                        ("value", "fixture.value_error", "ValueError"),
                    ]:
                        response = request(identity, method, {})
                        self.assertEqual(
                            response,
                            {"id": identity, "error": {"code": "internal_error", "message": kind}},
                        )
                        self.assertIn("fixture", app.extensions)
                        self.assertTrue(thread.is_alive())
                        self.assertEqual(
                            request(identity + "-next", "fixture.good", {})["result"],
                            {"alive": True},
                        )
                    entries = [
                        json.loads(line)
                        for path in (app.data_dir / "diagnostics").glob("events*.jsonl")
                        for line in path.read_text().splitlines()
                    ]
                    failures = [
                        row for row in entries if row.get("event_type") == "extension_request"
                    ]
                    self.assertEqual(len(failures), 2)
                    self.assertTrue(
                        all(
                            row["status"] == "failed" and row["error_code"] == "internal_error"
                            for row in failures
                        )
                    )
                    self.assertNotIn("sensitive fixture", json.dumps(entries))
            finally:
                app.stop()
                for connection in (client, server):
                    try:
                        connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                thread.join(3)
                client.close()
                server.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
