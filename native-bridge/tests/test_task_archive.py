import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))

from daemon import BridgeDaemon  # noqa: E402


class TaskArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.daemon = BridgeDaemon(self.home)
        self.daemon.data_dir.mkdir(parents=True)
        os.chmod(self.daemon.data_dir, 0o700)

    def task(self, task_id, age_days=8, **changes):
        stamp = time.time() - age_days * 86400
        return {
            "id": task_id,
            "owner": "owner",
            "state": "closed",
            "cleanupState": "succeeded",
            "createdAt": stamp,
            "updatedAt": stamp,
            "requestHistory": [],
            "operationTimeline": [],
            "currentOperation": {"state": "succeeded"},
            "tabIds": [],
            "agentTabIds": [],
            **changes,
        }

    def test_settled_old_task_moves_to_compressed_archive(self):
        old = self.task("old")
        recent = self.task("recent", 1)
        unknown = self.task(
            "unknown",
            requestHistory=[
                {"state": "unknown", "requestIdHash": "a" * 64, "payloadHash": "b" * 64}
            ],
        )
        for task in (old, recent, unknown):
            self.daemon.tasks[task["id"]] = task
        self.daemon._flush_tasks()
        hot = json.loads(self.daemon.tasks_path.read_text())["tasks"]
        self.assertEqual({task["id"] for task in hot}, {"recent", "unknown"})
        self.assertEqual(self.daemon.task_archive.get("old"), old)
        self.assertEqual(os.stat(self.daemon.task_archive.path).st_mode & 0o777, 0o600)
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.assertEqual(set(restored.tasks), {"recent", "unknown"})

    def test_verified_unknown_is_archived_only_after_verification_ages(self):
        old = self.task("verified-old", requestHistory=[{"state": "unknown"}])
        old["userVerified"] = {
            "reason": "checked",
            "at": datetime.fromtimestamp(time.time() - 8 * 86400, timezone.utc).isoformat(),
        }
        recent = self.task("verified-recent", requestHistory=[{"state": "unknown"}])
        recent["userVerified"] = {
            "reason": "checked",
            "at": datetime.now(timezone.utc).isoformat(),
        }
        self.daemon.tasks = {row["id"]: row for row in (old, recent)}
        self.daemon._flush_tasks()
        self.assertEqual(set(self.daemon.tasks), {"verified-recent"})
        self.assertEqual(self.daemon.task_archive.get("verified-old"), old)
        self.assertIsNone(self.daemon.task_archive.get("verified-recent"))

    def test_archive_is_idempotent_if_snapshot_still_contains_task(self):
        old = self.task("old")
        self.daemon.tasks["old"] = old
        self.daemon._flush_tasks()
        self.daemon.tasks_path.write_text(json.dumps({"version": 1, "tasks": [old]}))
        restored = BridgeDaemon(self.home)
        restored._load_tasks()
        self.assertEqual(restored.tasks, {})
        self.assertEqual(json.loads(restored.tasks_path.read_text())["tasks"], [])
        self.assertEqual(restored.task_archive.get("old")["id"], "old")

    def test_archive_write_failure_keeps_hot_task(self):
        old = self.task("old")
        self.daemon.tasks["old"] = old
        self.daemon.task_archive.path.symlink_to(self.daemon.data_dir / "elsewhere")
        with self.assertRaises(OSError):
            self.daemon._flush_tasks()
        self.assertEqual(self.daemon.tasks["old"], old)
        self.assertIsNotNone(self.daemon.persist_error)


if __name__ == "__main__":
    unittest.main()
