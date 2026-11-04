"""任务批次 C 的离线协议与隐私边界。"""

import json
import importlib.util
import sys
import tempfile
import unittest
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
import fbl_update  # noqa: E402


class BatchCContractTests(unittest.TestCase):
    def test_only_unknown_read_can_auto_settle(self):
        path = Path(__file__).resolve().parents[2] / "scripts/install-cli.py"
        spec = importlib.util.spec_from_file_location("batch_c_install_cli", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        task = {
            "id": "closed-1",
            "owner": "owner",
            "state": "closed",
            "cleanupState": "succeeded",
            "currentOperation": {"state": "unknown", "action": "snapshot"},
            "operationTimeline": [{"state": "unknown", "action": "snapshot"}],
            "requestHistory": [{"state": "dispatched", "action": "snapshot"}],
        }
        self.assertIsNone(module.task_block_reason(task))
        task["operationTimeline"][0]["action"] = "ref_fill"
        self.assertEqual(module.task_block_reason(task), "verification")

    def test_clean_closed_task_needs_no_browser_epoch(self):
        task = {"id": "closed-1", "state": "closed", "cleanupState": "succeeded"}
        cli = SimpleNamespace(
            InstallError=RuntimeError,
            load_basket_jobs=lambda _: {},
            load_task_records=lambda _: {"tasks": [task]},
            task_block_reason=lambda _: None,
        )
        with patch.object(fbl_update, "layouts", return_value=([Path("/tmp/fixture")], [])):
            groups, eligible = fbl_update.task_status(None, cli)
        self.assertEqual(groups["auto_settled"][0]["id"], "closed-1")
        self.assertEqual(eligible, {})

    def test_navigation_wait_validation(self):
        base = {
            "owner": "owner",
            "taskId": "task",
            "requestId": "request",
            "action": "new_tab",
            "url": "https://example.test",
        }
        for wait_for in (
            "load",
            "idle",
            {"type": "selector", "value": "#ready"},
            {"type": "text", "value": "Ready"},
        ):
            BridgeDaemon._validate_run_params(
                "new_tab", {**base, "waitFor": wait_for, "timeoutMs": 15000}
            )
        for wait_for in (
            "selector",
            {"type": "selector", "value": ""},
            {"type": "text", "value": "x", "secret": True},
        ):
            with self.assertRaises(ProtocolError):
                BridgeDaemon._validate_run_params("new_tab", {**base, "waitFor": wait_for})

    def test_report_contains_only_sanitized_log(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as home:
            daemon = BridgeDaemon(Path(home))
            task = {"id": "task-1", "state": "closed"}
            daemon._append_task_log(
                task["id"],
                {
                    "action": "navigate",
                    "state": "succeeded",
                    "startedAt": 1,
                    "durationMs": 12,
                    "url": "https://example.test/path",
                    "category": "site",
                },
            )
            daemon._append_task_log(
                task["id"],
                {
                    "action": "ref_fill",
                    "state": "unknown",
                    "startedAt": 2,
                    "durationMs": 3,
                    "category": "site",
                },
                {"role": "textbox", "name": "Email"},
            )
            paths = daemon._write_task_report(task)
            report = json.loads(Path(paths["json"]).read_text())
            self.assertEqual(report["urls"], ["https://example.test/path"])
            self.assertEqual(len(report["unknown"]), 1)
            self.assertIn("Email", Path(paths["markdown"]).read_text())

    def test_tasks_ack_accepts_multiple_ids_without_home_flag(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            home = Path(directory) / ".fast-browser-link"
            data = home / "plugin-data/fast-browser-link-native"
            data.mkdir(parents=True, mode=0o700)
            tasks = {
                "version": 1,
                "tasks": [
                    {
                        "id": identity,
                        "owner": "owner",
                        "state": "closed",
                        "cleanupState": "unknown",
                        "requestHistory": [],
                    }
                    for identity in ("first", "second")
                ],
            }
            (data / "tasks.json").write_text(json.dumps(tasks))
            (data / "tasks.json").chmod(0o600)
            script = Path(__file__).resolve().parents[2] / "scripts/tasks-ack.py"
            result = subprocess.run(
                [sys.executable, str(script), "first", "second"],
                env={
                    **{key: value for key, value in os.environ.items() if key != "HERMES_HOME"},
                    "HOME": directory,
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            updated = json.loads((data / "tasks.json").read_text())
            self.assertTrue(all(row["cleanupState"] == "succeeded" for row in updated["tasks"]))


if __name__ == "__main__":
    unittest.main()
