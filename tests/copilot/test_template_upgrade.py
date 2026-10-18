"""旧受管模板迁移及坏模板隔离；仅操作临时目录与合成 ACP。"""

import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, Templates, inference_session_prompt
from copilot_setup import setup, pending_templates
from copilot_health import startup_failure


class TemplateUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.data = self.root / "fast-copilot"

    def tearDown(self):
        self.temp.cleanup()

    def app(self):
        profile = self.root / "profiles/fast-copilot"
        profile.mkdir(parents=True, exist_ok=True)
        (profile / "config.yaml").write_text("synthetic")
        (self.data / "config.json").write_text(
            json.dumps(
                {
                    "hermes_home": str(self.root),
                    "hermes_command": sys.executable,
                    "exec_transport": "oneshot",
                    "acp_command": [sys.executable, str(ROOT / "tests/copilot/fake-acp.py")],
                    "timeout_seconds": 3,
                }
            )
        )
        return Copilot(self.data)

    def ready(self, app):
        app.request("fixture", "settings", {"enabled": True})
        deadline = time.monotonic() + 5
        while (
            time.monotonic() < deadline
            and app.view("fixture")["enabled"]
            and not app.view("fixture")["ready"]
        ):
            time.sleep(0.01)
        self.assertTrue(app.view("fixture")["ready"], app.view("fixture")["diagnostic"])

    def test_actual_legacy_without_manifest_upgrades_and_starts(self):
        target = self.data / "templates/seo.keyword_check.json"
        target.parent.mkdir(parents=True)
        legacy = (ROOT / "tests/copilot/fixtures/legacy-keyword.json").read_bytes()
        self.assertNotIn("decision_schema", json.loads(legacy))
        target.write_bytes(legacy)
        setup(self.data)
        self.assertIn("decision_schema", json.loads(target.read_text()))
        self.assertEqual(
            target.read_bytes(),
            (ROOT / "native-bridge/copilot-templates/seo/seo.keyword_check.json").read_bytes(),
        )
        self.assertEqual(pending_templates(self.data), [])
        app = self.app()
        try:
            self.ready(app)
        finally:
            app.close()

    def test_managed_upgrade_custom_conflict_new_template_and_resolution(self):
        source = self.root / "source"
        shutil.copytree(ROOT / "native-bridge/copilot-templates", source)
        setup(self.data, source)
        target = self.data / "templates/seo.keyword_check.json"
        config = (self.data / "config.json").read_bytes()
        original = target.read_bytes()
        origin = source / "seo/seo.keyword_check.json"
        updated = json.loads(origin.read_text())
        updated["prompt"] += " updated"
        origin.write_text(json.dumps(updated))
        setup(self.data, source)
        self.assertNotEqual(target.read_bytes(), original)
        record = json.loads((self.data / "managed-templates.json").read_text())["templates"][
            target.name
        ]
        self.assertEqual(record["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertTrue(record["version"].startswith("sha256:"))
        custom = target.read_text() + "\n"
        target.write_text(custom)
        updated["prompt"] += " newer"
        origin.write_text(json.dumps(updated))
        setup(self.data, source)
        self.assertEqual(target.read_text(), custom)
        self.assertEqual(target.with_suffix(".json.new").read_bytes(), origin.read_bytes())
        self.assertEqual(pending_templates(self.data), [target.name])
        app = Copilot(self.data)
        try:
            self.assertEqual(
                app.request("fixture", "capability_state", {})["pending_templates"], [target.name]
            )
        finally:
            app.close()
        target.write_bytes(origin.read_bytes())
        setup(self.data, source)
        self.assertFalse(target.with_suffix(".json.new").exists())
        (self.data / "templates/seo.trends.json").unlink()
        setup(self.data, source)
        self.assertTrue((self.data / "templates/seo.trends.json").is_file())
        new = source / "new.action.json"
        new.write_text(json.dumps({"id": "new.action"}))
        setup(self.data, source)
        self.assertTrue((self.data / "templates/new.action.json").is_file())
        self.assertEqual((self.data / "config.json").read_bytes(), config)

    def test_unknown_legacy_preserved_and_symlinks_refused_before_write(self):
        target = self.data / "templates/seo.keyword_check.json"
        target.parent.mkdir(parents=True)
        target.write_text('{"id":"user-custom"}')
        setup(self.data)
        self.assertEqual(target.read_text(), '{"id":"user-custom"}')
        self.assertTrue(target.with_suffix(".json.new").exists())
        manifest = self.data / "managed-templates.json"
        manifest.unlink()
        outside = self.root / "outside"
        outside.write_text("sentinel")
        manifest.symlink_to(outside)
        with self.assertRaises(ValueError):
            setup(self.data)
        self.assertEqual(outside.read_text(), "sentinel")

    def test_default_decision_schema_and_invalid_template_isolated(self):
        setup(self.data)
        target = self.data / "templates/seo.keyword_check.json"
        template = json.loads(target.read_text())
        template.pop("decision_schema")
        target.write_text(json.dumps(template))
        self.assertIn("decision_schema", Templates(target.parent).get("seo.keyword_check"))
        template.pop("params_schema")
        target.write_text(json.dumps(template))
        (self.data / "templates/seo.longtail.json").write_text("{broken")
        app = self.app()
        try:
            self.ready(app)
            self.assertEqual(set(app.templates.disabled), {"seo.keyword_check", "seo.longtail"})
            prompt = inference_session_prompt(app.templates)
            self.assertIn("Fast-browser-link · ", prompt)
            self.assertNotIn("协作·", prompt)
            self.assertNotIn('"action": "seo.keyword_check"', prompt)
            self.assertIn('"action": "general.task"', prompt)
            self.assertIn("跳过 2 个模板", app.view("fixture")["hermes_health"]["reason"])
            app._replace(
                "fixture",
                {
                    "scene": "seo",
                    "suggestions": [
                        {
                            "title": "查词",
                            "why": "测试",
                            "action": "seo.keyword_check",
                            "params": {"keyword": "sample"},
                        }
                    ],
                },
            )
            self.assertEqual(app.view("fixture")["suggestions"], [])
            logs = [
                row
                for row in app.journal.view("fixture")["entries"]
                if row["event"] == "template_disabled"
            ]
            self.assertEqual(len(logs), 2)
        finally:
            app.close()

    def test_start_failure_reason_state_and_log(self):
        setup(self.data)
        app = self.app()
        try:
            with patch("copilot.ACP.start", side_effect=FileNotFoundError("PRIVATE_SENTINEL")):
                app.request("fixture", "settings", {"enabled": True})
                deadline = time.monotonic() + 3
                while app.view("fixture")["enabled"] and time.monotonic() < deadline:
                    time.sleep(0.01)
            view = app.view("fixture")
            self.assertFalse(view["enabled"])
            self.assertEqual(view["startup_error"]["reason"], "Hermes 命令不可用")
            self.assertEqual(view["hermes_health"]["reason"], "Hermes 命令不可用")
            logs = app.journal.view("fixture")["entries"]
            self.assertTrue(any(row["event"] == "startup_failed" for row in logs))
            self.assertNotIn("PRIVATE_SENTINEL", json.dumps(logs))
            with patch("copilot_health.shutil.which", return_value="/synthetic/hermes"):
                self.assertEqual(
                    startup_failure(
                        {"hermes_home": str(self.root), "inference_profile": "missing"},
                        ValueError(),
                    )["code"],
                    "hermes_profile_missing",
                )
        finally:
            app.close()

    def test_startup_transport_exit_keeps_failure_reason(self):
        setup(self.data)
        app = self.app()
        app.config["acp_command"] = [sys.executable, "-c", "pass"]
        try:
            app.request("fixture", "settings", {"enabled": True})
            deadline = time.monotonic() + 4
            while app.view("fixture")["enabled"] and time.monotonic() < deadline:
                time.sleep(0.01)
            view = app.view("fixture")
            self.assertFalse(view["enabled"])
            self.assertEqual(view["startup_error"]["code"], "inference_start_failed")
            self.assertTrue(
                any(
                    row["event"] == "startup_failed"
                    for row in app.journal.view("fixture")["entries"]
                )
            )
        finally:
            app.close()

    def test_capability_log_counts_capabilities_not_probes(self):
        setup(self.data)
        app = Copilot(self.data)
        capabilities = {
            "keyword.metrics": {
                "status": "available",
                "bindings": [{"status": "available"}, {"status": "available"}],
            },
            "serp.top": {"status": "missing", "bindings": [{"status": "needs_browser_check"}]},
            "pool.lookup": {"status": "missing", "bindings": []},
        }
        try:
            with patch.object(app.registry, "inspect", return_value=capabilities):
                app._journal_event("fixture", "capabilities", {})
            row = app.journal.view("fixture")["entries"][-1]
            self.assertEqual(row["summary"], "能力 3 项：可用 1、需登录/待浏览器确认 1、未绑定 1")
            self.assertEqual(row["details"]["total"], 3)
            self.assertEqual(len(row["details"]["capability_statuses"]), 3)
        finally:
            app.close()
