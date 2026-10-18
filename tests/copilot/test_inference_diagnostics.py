"""推理诊断与恢复仅用合成进程、临时日志和受管 profile 夹具。"""

from datetime import date, timedelta
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, private_write
from copilot_setup import setup
from copilot_acp import ACP, ACPError, ACPDisconnected, ACPTimeout
from copilot_diagnostics import ModelOutputInvalid, StderrLog, failure, redact
from copilot_exec_acp import ACPExecutions
from copilot_execution import ExecutionError, Executions


def wait(check, seconds=6):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError("synthetic condition timed out")


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        backoff = patch.object(Copilot, "RECOVERY_BACKOFF", (0.01, 0.02, 0.04))
        backoff.start()
        self.addCleanup(backoff.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        setup(self.root)
        profile = self.root / "profiles/fast-copilot"
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text("synthetic")
        self.config = {
            "hermes_home": str(self.root),
            "hermes_command": sys.executable,
            "acp_command": [
                sys.executable,
                str(ROOT / "tests/copilot/fake-acp.py"),
                "--stderr-fixture",
            ],
            "exec_transport": "oneshot",
            "timeout_seconds": 2,
            "min_interval": 0,
        }
        private_write(self.root / "config.json", json.dumps(self.config))
        self.app = Copilot(self.root, debounce=0.01)

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def start(self):
        self.app.request("fixture", "settings", {"enabled": True})
        wait(lambda: self.app.view("fixture")["ready"])

    def logs(self, event):
        return [row for row in self.app.journal.view("fixture")["entries"] if row["event"] == event]

    def test_classification_preserves_fields_types_timeout_exit_and_redacts_journal(self):
        cases = [
            (ModelOutputInvalid("suggestions", "scene_and_array_required"), "model_output_invalid"),
            (ACPDisconnected(), "acp_disconnected"),
            (ACPTimeout(), "acp_timeout"),
            (KeyError("PRIVATE_SENTINEL"), "internal_error"),
        ]
        for error, reason in cases:
            detail = failure(error)
            self.assertEqual(detail["reason"], reason)
            self.app.journal.add("fixture", "inference_failed", error=True, **detail)
        runtime = type(
            "Runtime",
            (),
            {
                "transport_failure": {
                    "reason": "acp_process_exited",
                    "exit_code": -15,
                    "stderr_tail": ["token=PRIVATE_SENTINEL"],
                }
            },
        )()
        detail = failure(ACPError(), runtime)
        self.app.journal.add("fixture", "process_exit", **detail)
        rows = self.app.journal.view("fixture")["entries"]
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(rows))
        self.assertEqual(rows[-1]["details"]["exit_code"], -15)
        self.assertEqual(rows[0]["details"]["field"], "suggestions")
        self.assertEqual(rows[3]["details"]["error_type"], "KeyError")

    def test_oversized_extra_fields_and_missing_ids_are_normalized_without_error(self):
        self.start()
        rows = [
            {
                "title": "标题" * 30,
                "why": "理由" * 30,
                "action": "general.task",
                "params": {"task": str(i), "unknown": "drop"},
                "unknown": "drop",
            }
            for i in range(10)
        ]
        self.app._replace("fixture", {"scene": "general", "suggestions": rows, "extra": "drop"})
        result = self.app.view("fixture")["suggestions"]
        self.assertEqual(len(result), 10)
        for row in result:
            self.assertEqual(len(row["title"]), 32)
            self.assertEqual(len(row["why"]), 30)
            self.assertTrue(row["title"].endswith("…"))
            self.assertNotIn("unknown", row)
            self.assertNotIn("unknown", row["params"])
            self.assertEqual(len(row["id"]), 24)
        self.assertEqual(len(self.logs("output_repaired")), 1)
        self.assertFalse(self.logs("output_repaired")[0]["error"])
        self.assertIsNone(self.app.view("fixture")["diagnostic"])

    def test_three_consecutive_failures_preserve_suggestions_then_success_clears_error(self):
        self.start()
        state = self.app._state("fixture")
        epoch = state["epoch"]
        state["page"] = {"url": "https://example.test/", "title": "synthetic", "items": []}
        self.app._replace(
            "fixture",
            {
                "scene": "general",
                "suggestions": [
                    {
                        "title": "existing",
                        "why": "keep",
                        "action": "general.task",
                        "params": {"task": "sample"},
                    }
                ],
            },
        )
        previous = dict(state["suggestions"])
        for index in range(3):
            state["dirty"] = True
            with patch.object(
                self.app.runtime,
                "prompt",
                return_value=(
                    "invalid JSON",
                    {"tokens": 1, "source": "fixture", "input_bytes": 1, "seconds": 0},
                ),
            ):
                self.app._infer("fixture", epoch)
            self.assertEqual(state["inference_failures"], index + 1)
            self.assertEqual(state["suggestions"], previous)
            self.assertEqual(
                self.app.view("fixture")["hermes_health"]["state"],
                "error" if index == 2 else "connected",
            )
            self.assertEqual(bool(state["diagnostic"]), index == 2)
        self.assertEqual(
            self.logs("inference_failed")[-1]["details"]["reason"], "model_output_invalid"
        )
        state["dirty"] = True
        self.app._infer("fixture", epoch)
        self.assertEqual(state["inference_failures"], 0)
        self.assertIsNone(state["diagnostic"])

    def test_stderr_rotation_retention_permissions_and_link_refusal(self):
        log = StderrLog(self.root, limit=128)
        secret = "synthetic-" + "k" * 40
        for line in [
            "api_key=" + secret,
            "Authorization: Bearer " + secret,
            "token=" + secret,
            "warning " + secret,
        ]:
            log.append(line)
        directory = self.root / "logs"
        raw = "".join(path.read_text() for path in directory.glob("*.agent-stderr.log*"))
        self.assertNotIn(secret, raw)
        self.assertIn("redacted", raw)
        for i in range(40):
            log.append("warning " + str(i) + " " + "." * 30)
        files = list(directory.glob("*.agent-stderr.log*"))
        self.assertEqual(len(files), 2)
        for path in files:
            self.assertLessEqual(path.stat().st_size, 128)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(log.tail), 20)
        self.assertLessEqual(sum(len(line.encode()) for line in log.finish()), 1024)
        old = directory / ((date.today() - timedelta(days=7)).isoformat() + ".agent-stderr.log")
        old.write_text("old")
        legacy = directory / ((date.today() - timedelta(days=7)).isoformat() + ".hermes-stderr.log")
        legacy.write_text("legacy")
        tomorrow = StderrLog(self.root, today=lambda: date.today() + timedelta(days=1))
        tomorrow.append("next day")
        self.assertFalse(old.exists())
        self.assertFalse(legacy.exists())
        outside = self.root / "outside"
        outside.write_text("keep")
        target = directory / (date.today().isoformat() + ".agent-stderr.log")
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaises(ValueError):
            log.append("unsafe")
        self.assertEqual(outside.read_text(), "keep")

    def test_inference_exit_restarts_once_resumes_summary_and_never_replays_completed_task(self):
        self.start()
        state = self.app._state("fixture")
        state["summary"] = "SYNTHETIC_RETAINED_SUMMARY"
        state["execution_memory"] = ["completed synthetic task"]
        state["suggestions"]["done"] = {
            "id": "done",
            "title": "done",
            "why": "synthetic",
            "action": "general.task",
            "params": {"task": "done"},
            "status": "completed",
        }
        previous = self.app.runtime
        previous.process.terminate()
        wait(lambda: self.app.runtime is not previous and self.app.view("fixture")["ready"])
        self.assertEqual(state["inference_restarts"], 1)
        self.assertEqual(state["suggestions"]["done"]["status"], "completed")
        raw = (self.root / "acp-requests.jsonl").read_text()
        self.assertIn("SYNTHETIC_RETAINED_SUMMARY", raw)
        self.assertIn("completed synthetic task", raw)
        self.assertEqual(len(self.logs("inference_recovering")), 1)
        exit_row = self.logs("process_exit")[0]
        self.assertEqual(exit_row["details"]["exit_code"], -15)
        self.assertTrue(
            any("synthetic Hermes warning" in line for line in exit_row["details"]["stderr_tail"])
        )
        self.assertNotIn("fixture-" + "x" * 30, json.dumps(exit_row))
        for attempt in (2, 3):
            previous = self.app.runtime
            previous.process.terminate()
            wait(lambda: self.app.runtime is not previous and self.app.view("fixture")["ready"])
            self.assertEqual(state["inference_restarts"], attempt)
        self.app.runtime.process.terminate()
        wait(lambda: not state["enabled"])
        self.assertIsNotNone(state["startup_error"])
        self.assertEqual(state["inference_restarts"], 3)

    def test_exit_during_inference_is_classified_and_resumed_with_current_page(self):
        self.app.config["acp_command"].append("--crash-first-infer")
        self.start()
        self.app.request(
            "fixture",
            "observe",
            {
                "trace": [{"description": "点击 表格行 synthetic", "at": 1}],
                "page": {"url": "https://example.test/", "title": "first", "items": []},
            },
        )
        wait(
            lambda: self.app._state("fixture")["inference_restarts"] == 1
            and self.app.view("fixture")["ready"]
            and self.logs("inference_return")
            and self.app.view("fixture")["suggestions"]
        )
        failed = self.logs("inference_failed")
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["details"]["reason"], "acp_process_exited")
        self.assertEqual(failed[0]["details"]["exit_code"], 4)
        requests = [
            json.loads(line) for line in (self.root / "acp-requests.jsonl").read_text().splitlines()
        ]
        payloads = []
        for request in requests:
            if request.get("method") == "session/prompt":
                try:
                    value = json.loads(request["params"]["prompt"][0]["text"])
                except ValueError:
                    continue
                if value.get("type") == "infer":
                    payloads.append(value)
        self.assertEqual(len(payloads), 2)
        self.assertIn("page", payloads[-1])
        self.assertEqual(len(self.logs("execute_start")), 0)

    def test_recovery_start_failure_is_exposed_for_bounded_frontend_retry(self):
        self.start()
        previous = self.app.runtime
        self.app.config["acp_command"] = ["/synthetic/missing-hermes"]
        previous.process.terminate()
        wait(lambda: not self.app.view("fixture")["enabled"])
        view = self.app.view("fixture")
        self.assertEqual(view["startup_error"]["code"], "hermes_command_missing")
        self.assertFalse(view["recovering"])

    def test_user_idle_and_transport_disconnect_reasons_are_distinct(self):
        self.start()
        self.app.request("fixture", "settings", {"enabled": False})
        self.assertEqual(self.logs("disconnected")[-1]["details"]["reason"], "user_closed")
        wait(lambda: self.app.runtime.closed)
        self.assertNotEqual(self.app.view("fixture")["hermes_health"]["state"], "error")
        self.start()
        self.app._state("fixture")["last_activity"] = -1e9
        self.app.tick()
        self.assertEqual(self.logs("disconnected")[-1]["details"]["reason"], "idle_closed")

    def test_execution_stderr_and_exit_reason_survive_transport_wrapper(self):
        work = self.root / "oneshot"
        work.mkdir()
        events = []
        execution = Executions({"timeout_seconds": 2}, self.root, events.append)
        try:
            with self.assertRaises(ExecutionError) as caught:
                execution.run(
                    "synthetic",
                    [
                        sys.executable,
                        "-c",
                        "import sys;print('synthetic execution stderr',file=sys.stderr);sys.exit(7)",
                    ],
                    work / "result.json",
                )
            self.assertEqual(caught.exception.failure["reason"], "acp_process_exited")
            self.assertEqual(caught.exception.failure["exit_code"], 7)
            self.assertEqual(events[0]["exit_code"], 7)
            self.assertIn("synthetic execution stderr", events[0]["stderr_tail"])
        finally:
            execution.close()

    def test_execution_timeout_and_invalid_output_are_not_misclassified_as_process_exit(self):
        work = self.root / "classification"
        work.mkdir()
        execution = Executions({"timeout_seconds": 0.1}, self.root)
        try:
            with self.assertRaises(ExecutionError) as caught:
                execution.run(
                    "timeout",
                    [sys.executable, "-c", "import time;time.sleep(5)"],
                    work / "timeout.json",
                )
            self.assertEqual(caught.exception.failure["reason"], "acp_timeout")
            execution.config["timeout_seconds"] = 2
            (work / "result.json").write_text("invalid JSON")
            code = 'import json;print(json.dumps({"type":"result","exit_code":0}))'
            with self.assertRaises(ValueError) as invalid:
                execution.run("invalid", [sys.executable, "-c", code], work / "result.json")
            self.assertEqual(invalid.exception.failure["reason"], "model_output_invalid")
        finally:
            execution.close()

    def test_profile_creation_and_managed_upgrade_write_verified_version_only(self):
        spec = importlib.util.spec_from_file_location(
            "profile_fixture", ROOT / "scripts/setup-copilot-profile.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name in ("fast-copilot",):
            root = self.root / name
            target = root / "profiles" / name
            target.mkdir(parents=True)
            if name == "fast-copilot":
                shared = root / "plugins/fast-browser-link"
                shared.mkdir(parents=True)
                (target / "plugins").mkdir()
                (target / "plugins/fast-browser-link").symlink_to(shared)
            config = {"model": {"default": "synthetic", "provider": "auto"}, "_config_version": 12}
            files = {
                "config.yaml": json.dumps(config),
                "SOUL.md": "",
                "AGENTS.md": "",
                "workspace/AGENTS.md": "",
                "workspace/.hermes.md": "",
            }
            for field, text in files.items():
                path = target / field
                path.parent.mkdir(exist_ok=True)
                path.write_text(text)
            marker = target / ".copilot-profile.json"
            marker.write_text(
                json.dumps(
                    {
                        "files": {
                            field: hashlib.sha256(text.encode()).hexdigest()
                            for field, text in files.items()
                        }
                    }
                )
            )
            with contextlib.redirect_stdout(io.StringIO()):
                module.setup(root, "synthetic", apply=True, profile=name)
            self.assertEqual(
                json.loads((target / "config.yaml").read_text())["_config_version"], 50
            )
            before = (target / "config.yaml").read_bytes()
            (target / "SOUL.md").write_text("modified")
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                module.setup(root, "synthetic", apply=True, profile=name)
            self.assertEqual((target / "config.yaml").read_bytes(), before)
