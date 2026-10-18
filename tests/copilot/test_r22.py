"""维护时识别弹窗接管终态及未结历史；仅使用合成账本和临时安装树。"""

import contextlib
import copy
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_r17 as fixtures
from fbl_update import task_status, update
from fbl_runtime import load


class R22(unittest.TestCase):
    setUpClass = fixtures.R17.__dict__["setUpClass"]
    tearDownClass = fixtures.R17.__dict__["tearDownClass"]
    setUp = fixtures.R17.setUp
    tearDown = fixtures.R17.tearDown
    install = fixtures.R17.install
    persist = fixtures.R17.persist
    run_update = fixtures.R17.run_update

    def prepare(self):
        cli = fixtures.R17.prepare(self)
        self.rows = [
            {
                **self.rows[0],
                "state": "cancelled",
                "cleanupState": "succeeded",
                "agentTabIds": [],
                "adoptedPopupTabIds": [],
                "requestHistory": [
                    {
                        "action": "popup_adopt",
                        "state": "confirmed",
                        "automatic": True,
                        "dispatched": True,
                        "time": 105,
                    }
                ],
                "operationTimeline": [
                    {
                        "action": "popup_adopt",
                        "automatic": True,
                        "state": "confirmed",
                        "startedAt": 105,
                        "completedAt": 105,
                        "durationMs": 0,
                        "tabId": 7,
                    }
                ],
            }
        ]
        self.persist()
        return cli

    def test_reported_confirmed_popup_dry_run_is_ready_and_read_only(self):
        cli = self.prepare()
        before = self.path.read_bytes()
        with patch.object(cli, "stop_daemon") as stop, patch.object(cli, "browser_epoch") as epoch:
            result = update(self.ctx, self.release, dry_run=True)
        self.assertEqual(
            {key: row["count"] for key, row in result["task_check"].items()},
            {"active": 0, "after_daemon_stop": 0, "needs_verification": 0},
        )
        self.assertTrue(result["ready_after_confirmation"])
        self.assertEqual(result["safe_to_settle"], 0)
        stop.assert_not_called()
        epoch.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))
        self.assertFalse((self.runtime / "fbl-backups").exists())

    def test_completed_operation_states_and_unknown_cleanup_use_same_terminal_set(self):
        cli = self.prepare()
        base = copy.deepcopy(self.rows[0])
        self.assertEqual(cli.TERMINAL_OPERATION_STATES, {"succeeded", "failed", "confirmed"})
        for state in cli.TERMINAL_OPERATION_STATES:
            for cleanup in ("succeeded", "unknown", "failed"):
                with self.subTest(state=state, cleanup=cleanup):
                    row = copy.deepcopy(base)
                    row["cleanupState"] = cleanup
                    row["currentOperation"]["state"] = state
                    row["operationTimeline"][0]["state"] = state
                    self.assertEqual(
                        cli.task_block_reason(row), None if cleanup == "succeeded" else "cleanup"
                    )
                    self.assertEqual(cli.old_browser_task(row, 200), cleanup != "succeeded")

    def test_unfinished_history_requires_old_epoch_and_all_activity_times(self):
        cli = self.prepare()
        base = copy.deepcopy(self.rows[0])
        for task_state in ("closed", "cancelled", "failed"):
            for state in ("running", "pending", "unknown", "dispatched"):
                for old in (True, False):
                    with self.subTest(task=task_state, operation=state, old=old):
                        row = copy.deepcopy(base)
                        row["state"] = task_state
                        row["operationTimeline"][0].update(
                            state=state, completedAt=109 if old else 300
                        )
                        self.rows = [row]
                        self.persist()
                        groups, eligible = task_status(self.ctx, cli)
                        self.assertFalse(groups["active"])
                        self.assertFalse(groups["after_daemon_stop"])
                        (pending,) = groups["needs_verification"]
                        self.assertEqual(pending["safe_to_settle"], old)
                        self.assertEqual(bool(eligible), old)
        row = copy.deepcopy(base)
        row["operationTimeline"][0]["state"] = "running"
        for change in (
            {"updatedAt": None},
            {"lastActivityAt": 300},
            {"createdAt": float("nan")},
            {"requestHistory": [{"state": "confirmed", "time": 300}]},
        ):
            with self.subTest(change=change):
                self.assertFalse(cli.old_browser_task({**row, **change}, 200))
        self.assertFalse(cli.old_browser_task(row, None))

    def test_unfinished_history_settles_only_after_confirmation_and_stop(self):
        cli = self.prepare()
        self.rows[0]["operationTimeline"][0]["state"] = "running"
        self.persist()
        before = self.path.read_bytes()
        with patch.object(cli, "stop_daemon") as stop, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "尚未确认"):
                update(self.ctx, self.release)
        stop.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        result = self.run_update(yes=True)
        self.assertEqual(result["status"], "updated")
        (receipt,) = result["acknowledged_tasks"]
        backup = Path(receipt["backup"])
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.ctx.data.glob("tasks.json.ack-*"))), 1)
        (row,) = json.loads(self.path.read_text())["tasks"]
        for field in ("currentOperation", "operationTimeline", "requestHistory"):
            self.assertEqual(row[field], self.rows[0][field])
        self.assertEqual(
            row["userVerified"]["operations"],
            [
                {
                    "field": "operationTimeline",
                    "index": 0,
                    "state": "verified_complete",
                    "previousState": "running",
                }
            ],
        )
        cli.assert_tasks_idle(self.runtime, daemon_stopped=True)
        groups, eligible = task_status(self.ctx, cli)
        self.assertEqual(len(groups["after_daemon_stop"]), 1)
        self.assertFalse(groups["needs_verification"])
        self.assertFalse(eligible)

    def test_current_epoch_history_refuses_yes_without_writing_or_stopping(self):
        cli = self.prepare()
        self.rows[0]["operationTimeline"][0].update(state="running", startedAt=300)
        self.persist()
        before = self.path.read_bytes()
        with patch.object(cli, "stop_daemon") as stop:
            with self.assertRaisesRegex(ValueError, "需要核实：1"):
                update(self.ctx, self.release, yes=True)
        stop.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))
        self.assertFalse((self.runtime / "fbl-backups").exists())

    def test_active_resources_current_operations_and_malformed_history_still_block(self):
        cli = self.prepare()
        base = copy.deepcopy(self.rows[0])
        for change in (
            {"state": "running"},
            {"cleanupState": "pending"},
            {"vaultPermit": {}},
            {"gatewayPermit": {}},
            {"idlePendingHuman": True},
            {"idleRecoveryState": "paused"},
            {"agentTabIds": [7]},
            {"adoptedPopupTabIds": [8]},
            {"requestHistory": [{"state": "awaiting_approval"}]},
            {"requestHistory": [{"state": "awaiting_human"}]},
            {"currentOperation": {"state": "running"}},
            {"currentOperation": {"state": "pending"}},
            {"operationTimeline": None},
            {"operationTimeline": [None]},
            {"operationTimeline": [{}]},
            {"operationTimeline": [{"state": []}]},
        ):
            with self.subTest(change=change):
                row = {**base, **change}
                self.assertEqual(cli.task_block_reason(row), "active")
                self.assertFalse(cli.old_browser_task(row, 200))

    def test_locked_recheck_refuses_new_current_operation_before_backup(self):
        cli = self.prepare()
        self.rows[0]["operationTimeline"][0]["state"] = "running"
        self.persist()

        def stop(*_):
            self.rows[0]["currentOperation"]["state"] = "running"
            self.persist()

        with (
            patch.object(cli, "stop_daemon", side_effect=stop),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(ValueError):
                update(self.ctx, self.release, yes=True)
        self.assertFalse(list(self.ctx.data.glob("tasks.json.ack-*")))
        self.assertTrue((self.ctx.data / "host-bin/old-fixture").exists())

    def test_runtime_idle_semantics_remain_unchanged(self):
        cli = self.prepare()
        row = self.rows[0]
        daemon = load("r22_daemon", Path(__file__).resolve().parents[2] / "native-bridge/daemon.py")
        self.assertIsNone(cli.task_block_reason(row, daemon_stopped=True))
        self.assertFalse(daemon.BridgeDaemon._task_safe_for_idle_exit(row))


if __name__ == "__main__":
    unittest.main()
