"""Offline tests for starting a previously connected browser with a new task."""

import os
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from types import SimpleNamespace

BRIDGE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_DIR))

import daemon as daemon_module  # noqa: E402
from daemon import BridgeDaemon, ProtocolError  # noqa: E402


class BrowserWakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon.data_dir.mkdir(parents=True, mode=0o700)
        self.daemon._notify_tasks_changed = lambda _instance: None
        self.daemon._remember_browser("old-profile", "chrome")
        self.addCleanup(self.daemon._flush_tasks)

    def connect(self):
        with self.daemon.state_lock:
            self.daemon.extensions["old-profile"] = {
                "instanceId": "old-profile",
                "browser": "chrome",
                "version": "2.5.1",
            }

    def test_remembered_offline_browser_is_listed_and_task_waits_for_reconnect(self):
        rows = self.daemon._dispatch_client("browser.list", {})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["instanceId"], "old-profile")
        self.assertIs(rows[0]["connected"], False)
        self.assertEqual(os.stat(self.daemon.known_browsers_path).st_mode & 0o777, 0o600)
        launches = []

        def launch(browser):
            launches.append(browser)
            self.connect()

        self.daemon._launch_browser = launch
        task = self.daemon._create_task(
            {
                "owner": "owner",
                "title": "new task",
                "instanceId": "old-profile",
                "allowedOrigins": ["https://example.test"],
            }
        )
        self.assertEqual(launches, ["chrome"])
        self.assertEqual(task["instanceId"], "old-profile")
        self.assertEqual(task["state"], "pending_approval")

    def test_unknown_instance_and_invalid_task_never_launch(self):
        launches = []
        self.daemon._launch_browser = launches.append
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._ensure_task_browser("unknown-profile")
        self.assertEqual(caught.exception.code, "instance_unavailable")
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._create_task(
                {
                    "owner": "owner",
                    "title": "invalid",
                    "instanceId": "old-profile",
                    "allowedOrigins": ["javascript:bad"],
                }
            )
        self.assertEqual(caught.exception.code, "invalid_origin")
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._create_task(
                {
                    "owner": "owner",
                    "title": "invalid attachment",
                    "instanceId": "old-profile",
                    "existingTab": {"url": "javascript:bad"},
                }
            )
        self.assertEqual(caught.exception.code, "invalid_url")
        self.assertEqual(launches, [])

    def test_launch_failure_or_missing_reconnect_creates_no_task(self):
        def fail(_browser):
            raise ProtocolError("browser_launch_failed", "browser startup failed")

        self.daemon._launch_browser = fail
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._ensure_task_browser("old-profile")
        self.assertEqual(caught.exception.code, "browser_launch_failed")
        self.assertEqual(self.daemon.tasks, {})
        self.daemon._launch_browser = lambda _browser: None
        with patch.object(daemon_module, "_BROWSER_WAKE_WAIT_SECONDS", 0.01):
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._ensure_task_browser("old-profile")
        self.assertEqual(caught.exception.code, "instance_unavailable")
        self.assertEqual(self.daemon.tasks, {})

    def test_previous_primary_record_is_eligible_before_first_new_handshake(self):
        self.daemon.known_browsers_path.unlink()
        self.daemon.primary_path.write_text(
            json.dumps({"instanceId": "old-profile", "browser": "chrome"})
        )
        self.daemon.primary_path.chmod(0o600)
        launches = []

        def launch(browser):
            launches.append(browser)
            self.connect()

        self.daemon._launch_browser = launch
        self.daemon._ensure_task_browser("old-profile")
        self.assertEqual(launches, ["chrome"])

    def test_legacy_task_ledger_seeds_previous_connection(self):
        self.daemon.known_browsers_path.unlink()
        now = time.time()
        self.daemon.tasks_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "tasks": [
                        {
                            "id": "old-task",
                            "owner": "old-owner",
                            "instanceId": "old-profile",
                            "browser": "chrome",
                            "state": "closed",
                            "cleanupState": "succeeded",
                            "createdAt": now,
                            "updatedAt": now,
                            "requestHistory": [],
                            "operationTimeline": [],
                        }
                    ],
                }
            )
        )
        self.daemon.tasks_path.chmod(0o600)
        restored = BridgeDaemon(Path(self.temp.name))
        restored._load_tasks()
        self.assertEqual(restored._known_browsers()[0]["instanceId"], "old-profile")
        self.assertIs(restored._dispatch_client("browser.list", {})[0]["connected"], False)

    def test_corrupt_history_does_not_start_or_break_a_connected_browser(self):
        self.daemon.known_browsers_path.write_text("not-json")
        self.daemon.known_browsers_path.chmod(0o600)
        self.daemon._launch_browser = lambda _browser: self.fail("must not launch")
        self.assertEqual(self.daemon._dispatch_client("browser.list", {}), [])
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._ensure_task_browser("old-profile")
        self.assertEqual(caught.exception.code, "instance_unavailable")
        self.connect()
        self.daemon._ensure_task_browser("old-profile")

    def test_concurrent_task_starts_coalesce_one_launch(self):
        launches = []

        def launch(browser):
            launches.append(browser)
            threading.Timer(0.03, self.connect).start()

        self.daemon._launch_browser = launch
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.daemon._ensure_task_browser, ["old-profile"] * 2))
        self.assertEqual(results, [None, None])
        self.assertEqual(launches, ["chrome"])

    def test_launcher_uses_fixed_background_bundle_without_url(self):
        with (
            patch.object(daemon_module.sys, "platform", "darwin"),
            patch.object(
                daemon_module.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ) as run,
        ):
            self.daemon._launch_browser("edge")
        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/open", "-g", "-b", "com.microsoft.edgemac"],
        )
        with (
            patch.object(daemon_module.sys, "platform", "darwin"),
            patch.object(
                daemon_module.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=1),
            ),
        ):
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._launch_browser("edge")
        self.assertEqual(caught.exception.code, "browser_launch_failed")


if __name__ == "__main__":
    unittest.main()
