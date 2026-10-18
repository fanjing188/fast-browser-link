"""升级守卫：真实文件事务配合合成进程纪元，不接触本机安装。"""

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import test_r15 as fixtures
from fbl_update import update, legacy_cli, task_status, task_message, UpdateRefused
from fbl_runtime import doctor
from fbl_profiles import repair
from copilot import private_write


class R17(unittest.TestCase):
    setUpClass = fixtures.R15.__dict__["setUpClass"]
    tearDownClass = fixtures.R15.__dict__["tearDownClass"]
    setUp = fixtures.R15.setUp
    tearDown = fixtures.R15.tearDown
    install = fixtures.R15.install

    def prepare(self, ready=False):
        self.install()
        self.cli = legacy_cli(self.ctx)
        self.path = self.ctx.data / "tasks.json"
        self.rows = []
        for index in range(1123):
            row = {
                "id": str(index),
                "owner": "fixture",
                "title": f"Task {index}",
                "state": "closed" if index < 1104 or index >= 1120 else "cancelled",
                "cleanupState": "succeeded" if index < 1120 else "unknown",
                "createdAt": 100,
                "updatedAt": 110,
                "requestHistory": [{"state": "dispatched", "time": 105}],
                "currentOperation": {"state": "succeeded", "completedAt": 109},
            }
            self.rows.append(row)
        if ready:
            self.rows.append(
                {
                    **self.rows[0],
                    "id": "current",
                    "title": "Current ready task",
                    "createdAt": 300,
                    "updatedAt": 301,
                    "state": "ready",
                    "cleanupState": "pending",
                }
            )
        self.persist()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("fbl_update.legacy_cli", return_value=self.cli))
        self.stack.enter_context(patch.object(self.cli, "browser_epoch", return_value=200))
        return self.cli

    def persist(self):
        private_write(self.path, json.dumps({"version": 1, "tasks": self.rows}))

    def test_dry_run_groups_large_history_and_current_task_without_mutation(self):
        cli = self.prepare(ready=True)
        before = self.path.read_bytes()
        with patch.object(cli, "stop_daemon") as stop:
            result = update(self.ctx, self.release, dry_run=True)
        self.assertEqual(result["task_check"]["active"]["count"], 1)
        self.assertEqual(result["task_check"]["after_daemon_stop"]["count"], 1120)
        self.assertEqual(result["task_check"]["needs_verification"]["count"], 3)
        self.assertEqual(result["safe_to_settle"], 3)
        self.assertFalse(result["ready_after_confirmation"])
        self.assertEqual(len(result["task_check"]["after_daemon_stop"]["examples"]), 5)
        stop.assert_not_called()
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.runtime / "fbl-backups").exists())

    def test_nonterminal_and_current_epoch_never_ack_even_with_yes(self):
        cli = self.prepare(ready=True)
        before = self.path.read_bytes()
        with patch.object(cli, "stop_daemon") as stop:
            with self.assertRaisesRegex(ValueError, "真正进行中：1"):
                update(self.ctx, self.release, yes=True)
        stop.assert_not_called()
        self.assertEqual(before, self.path.read_bytes())
        self.rows.pop()
        self.rows[-1]["updatedAt"] = 300
        self.persist()
        with patch.object(cli, "stop_daemon") as stop:
            with self.assertRaisesRegex(ValueError, "需要核实：3"):
                update(self.ctx, self.release, yes=True)
        stop.assert_not_called()
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))

    def test_confirmation_decline_never_stops_or_writes(self):
        cli = self.prepare()
        before = self.path.read_bytes()
        for confirm in (None, lambda _: False):
            with (
                patch.object(cli, "stop_daemon") as stop,
                contextlib.redirect_stderr(io.StringIO()),
            ):
                with self.assertRaisesRegex(ValueError, "尚未确认"):
                    update(self.ctx, self.release, confirm=confirm)
            stop.assert_not_called()
            self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.runtime / "fbl-backups").exists())

    def run_update(self, **kwargs):
        running = [True]
        events = []

        def stopped(*_):
            events.append("stop")
            running[0] = False

        def check(*_):
            self.assertFalse(running[0])
            events.append("stopped")

        original = self.cli.acknowledge_tasks

        def ack(*args, **options):
            self.assertFalse(running[0])
            events.append("ack")
            return original(*args, **options)

        with (
            patch.object(
                self.cli, "verified_daemon_pid", side_effect=lambda *_: 123 if running[0] else None
            ),
            patch.object(self.cli, "stop_daemon", side_effect=stopped),
            patch.object(self.cli, "check_daemon_stopped", side_effect=check),
            patch.object(self.cli, "acknowledge_tasks", side_effect=ack),
            patch("client.BridgeClient") as client,
            contextlib.redirect_stderr(io.StringIO()),
        ):
            result = update(self.ctx, self.release, health=lambda _: {"ok": True}, **kwargs)
            client.return_value.call.assert_called_once_with("health")
        self.assertLess(events.index("stop"), events.index("ack"))
        return result

    def test_yes_updates_after_daemon_stop_and_one_backup_for_three_tasks(self):
        self.prepare()
        before = self.path.read_bytes()
        result = self.run_update(yes=True)
        self.assertEqual(result["status"], "updated")
        receipts = result["acknowledged_tasks"]
        self.assertEqual(len(receipts), 1)
        self.assertEqual(Path(receipts[0]["backup"]).read_bytes(), before)
        self.assertEqual(Path(receipts[0]["backup"]).stat().st_mode & 0o777, 0o600)
        rows = json.loads(self.path.read_text())["tasks"]
        self.assertEqual(sum("userVerified" in row for row in rows), 3)
        self.assertEqual(rows[:1120], self.rows[:1120])
        self.cli.assert_tasks_idle(self.runtime, daemon_stopped=True)
        self.assertFalse((self.ctx.data / "host-bin/old-fixture").exists())

    def test_interactive_confirmation_can_authorize_old_epoch(self):
        self.prepare()
        prompts = []
        result = self.run_update(confirm=lambda prompt: prompts.append(prompt) or True)
        self.assertEqual(result["status"], "updated")
        self.assertEqual(len(prompts), 1)

    def test_successful_history_alone_passes_after_stop_without_confirmation(self):
        cli = self.prepare()
        self.rows = self.rows[:1120]
        self.persist()
        with patch.object(cli, "stop_daemon") as stop:
            result = update(self.ctx, self.release)
        self.assertEqual(result["status"], "updated")
        stop.assert_called_once()
        self.assertEqual(result["acknowledged_tasks"], [])

    def test_epoch_or_tasks_change_before_locked_ack_refuses(self):
        cli = self.prepare()
        before = self.path.read_bytes()

        def stop(*_):
            self.rows[-1]["updatedAt"] = 300
            self.persist()

        with (
            patch.object(cli, "stop_daemon", side_effect=stop),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(ValueError):
                update(self.ctx, self.release, yes=True)
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))
        self.assertTrue((self.ctx.data / "host-bin/old-fixture").exists())
        self.assertNotEqual(self.path.read_bytes(), before)

    def test_eligible_requires_completed_operation_no_permit_finite_dates(self):
        cli = self.prepare()
        base = self.rows[-1]
        for change in (
            {"state": "ready"},
            {"vaultPermit": {}},
            {"gatewayPermit": {}},
            {"idlePendingHuman": True},
            {"currentOperation": {"state": "running"}},
            {"cleanupState": "pending"},
            {"updatedAt": float("nan")},
            {"updatedAt": None},
            {"updatedAt": 200},
            {"requestHistory": None},
            {"requestHistory": [{"time": 300}]},
            {"currentOperation": {"state": "running"}, "userVerified": {"at": 110}},
        ):
            with self.subTest(change=change):
                self.assertFalse(cli.old_browser_task({**base, **change}, 200))
        self.assertFalse(cli.old_browser_task(base, None))
        self.assertTrue(cli.old_browser_task(base, 200))

    def test_grouped_message_bounded_samples_and_next_commands(self):
        cli = self.prepare(ready=True)
        groups, _ = task_status(self.ctx, cli)
        message = task_message(groups)
        self.assertIn("停 daemon 后可通过：1120", message)
        self.assertIn("需要核实：3", message)
        self.assertIn("真正进行中：1", message)
        self.assertIn("Task 1122", message)
        self.assertNotIn("Task 1000", message)
        self.assertIn("tasks:ack", message)
        self.assertLess(len(message.splitlines()), 20)

    def test_cli_refusal_preserves_grouped_lines_after_redaction(self):
        import fbl_cli

        cli = self.prepare(ready=True)
        groups, _ = task_status(self.ctx, cli)
        output = io.StringIO()
        stdout = io.StringIO()
        with (
            patch.object(fbl_cli.Context, "locate", return_value=self.ctx),
            patch.object(fbl_cli, "update", side_effect=UpdateRefused(groups)),
            contextlib.redirect_stderr(output),
            contextlib.redirect_stdout(stdout),
        ):
            code = fbl_cli.main(["update", "--source", str(self.release), "--yes"])
        self.assertEqual(code, 1)
        self.assertIn("\n真正进行中：1\n", output.getvalue())
        self.assertIn("\n停 daemon 后可通过：1120\n", output.getvalue())
        self.assertIn("\n需要核实：3\n", output.getvalue())
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "refused")
        self.assertEqual(result["blocking"][0]["title"], "Current ready task")

    def test_browser_epoch_uses_main_process_earliest_start_not_reconnect(self):
        cli = legacy_cli(self.ctx)
        value = "Sun Oct 18 10:00:00 2026 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge\nSun Oct 18 11:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nSun Oct 18 08:00:00 2026 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper\n"
        from datetime import datetime

        expected = datetime(2026, 10, 18, 10).timestamp()
        with patch.object(
            cli, "command", return_value=subprocess.CompletedProcess([], 0, value, "")
        ):
            self.assertEqual(cli.browser_epoch({}), expected)
        with patch.object(cli, "command", side_effect=cli.InstallError("blocked", "retry")):
            self.assertIsNone(cli.browser_epoch({}))
        with patch.object(cli, "command", return_value=subprocess.CompletedProcess([], 0, "", "")):
            self.assertIsNone(cli.browser_epoch({}))

    def test_ack_requires_startup_lock_and_rejects_current_task_before_backup(self):
        cli = self.prepare()
        before = self.path.read_bytes()
        lock = self.ctx.data / "daemon.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        child = subprocess.Popen(
            [
                fixtures.sys.executable,
                "-u",
                "-c",
                'import fcntl,sys;f=open(sys.argv[1],"r");fcntl.flock(f,fcntl.LOCK_EX);print("locked",flush=True);sys.stdin.read()',
                str(lock),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            with self.assertRaises(cli.CloudGateError):
                cli.acknowledge_tasks(self.runtime, ["1120"], "fixture", {}, fd, epoch=200)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))
        finally:
            child.communicate("")
            os.close(fd)
        self.rows[-1]["updatedAt"] = 300
        self.persist()
        before = self.path.read_bytes()
        fd = os.open(lock, os.O_RDONLY)
        try:
            with self.assertRaises(ValueError):
                cli.acknowledge_tasks(self.runtime, ["1122"], "fixture", {}, fd, epoch=200)
        finally:
            os.close(fd)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))

    def test_tasks_ack_command_shares_backup_and_verified_record(self):
        self.prepare()
        self.rows = self.rows[-1:]
        self.persist()
        before = self.path.read_bytes()
        result = subprocess.run(
            [
                fixtures.sys.executable,
                str(fixtures.ROOT / "scripts/tasks-ack.py"),
                self.rows[0]["id"],
                "--hermes-home",
                str(self.runtime),
                "--reason",
                "Synthetic user verification",
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["taskId"], self.rows[0]["id"])
        self.assertEqual(Path(receipt["backup"]).read_bytes(), before)
        task = json.loads(self.path.read_text())["tasks"][0]
        self.assertEqual(task["cleanupState"], "succeeded")
        self.assertEqual(task["userVerified"]["previousCleanupState"], "unknown")

    def test_doctor_unregistered_info_and_drift_details_preserve_migrated_model(self):
        self.install()
        stamp = self.ctx.data / "host-bin/runtime-version.json"
        stamp.unlink()
        repair(self.hermes, "fast-copilot", private_write, "initial-model")
        config = self.hermes / "profiles/fast-copilot/config.yaml"
        value = json.loads(config.read_text())
        value["model"]["default"] = "migrated-model"
        value["reasoning_effort"] = "high"
        value["_config_version"] = 101
        private_write(config, json.dumps(value))
        live = lambda _: {"ok": True, "browsers": [{"connected": True}]}
        result = doctor(self.ctx, probe=live)
        for name in ("daemon_version", "version", "runtime_integrity"):
            row = next(row for row in result["checks"] if row["component"] == name)
            self.assertEqual(row["code"], "unregistered")
            self.assertEqual(row["severity"], "info")
            self.assertIn("--source", row["command"])
            self.assertIn("尚未验证", row["message"])
        row = next(row for row in result["checks"] if row["component"] == "fast-copilot")
        self.assertIn("initial-model → migrated-model", " ".join(row["details"]))
        self.assertIn("high → low", " ".join(row["details"]))
        self.assertIn("保留当前模型", row["fix_policy"])
        doctor(self.ctx, fix=True, probe=live)
        fixed = json.loads(config.read_text())
        self.assertEqual(fixed["model"]["default"], "migrated-model")
        self.assertEqual(fixed["_config_version"], 101)
        self.assertEqual(fixed["reasoning_effort"], "low")


if __name__ == "__main__":
    unittest.main()
