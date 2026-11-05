"""中文注释：只使用临时 daemon 目录与合成任务，覆盖回收配置和跨层效果字段。"""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from daemon import BridgeDaemon, ProtocolError, _safe_error_data
from client import BridgeError


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


RUNTIME = load("window160_runtime", "executor-plugin/runtime.py")
ACTION = load("window160_action", "native-bridge/script_lane/action_session.py")
CHILD = load("window160_child", "native-bridge/script_lane/child.py")
HINT = (
    "输入已派发但未观察到效果；请读取目标页核对，检查按钮状态或改用页面支持的操作，不要反复重试。"
)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bl160-")
        self.addCleanup(self.temp.cleanup)
        with patch.dict(
            os.environ,
            {
                "FAST_BROWSER_WORK_WINDOW": "separate",
                "FAST_BROWSER_TASK_IDLE_TIMEOUT_SECONDS": "1200",
            },
        ):
            self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        self.daemon._notify_tasks_changed = lambda _: None
        self.addCleanup(self.daemon._flush_tasks)
        # 中文注释：不连接真实浏览器，旧页面记录默认没有确认不存在的证据。
        self.daemon._extension_call = lambda *_a, **_k: {"cleanupState": "unknown"}
        self.daemon.extensions["fixture"] = {"instanceId": "fixture", "browser": "chrome"}

    def task(self):
        result = self.daemon._dispatch_client(
            "shared.create",
            {
                "owner": "fixture-owner",
                "title": "Task",
                "instanceId": "fixture",
                "allowedOrigins": ["http://fixture.localhost"],
            },
        )
        task = self.daemon.tasks[result["id"]]
        task.update(state="needs_sync", lastActivityAt=1, createdAt=1, workTabs=[])
        return task

    def test_focus_window_validation_and_restricted_tasks(self):
        common = {
            "owner": "fixture-owner",
            "taskId": "t",
            "requestId": "r",
            "action": "focus_window",
            "tabId": 7,
        }
        for fields in ({}, {"restore": False, "holdMs": 15000}):
            self.daemon._validate_run_params("focus_window", {**common, **fields})
        for fields in (
            {"holdMs": -1},
            {"holdMs": 15001},
            {"holdMs": True},
            {"restore": None},
            {"windowId": 2},
        ):
            with self.subTest(fields=fields), self.assertRaises(ProtocolError):
                self.daemon._validate_run_params("focus_window", {**common, **fields})
        task = self.task()
        params = {**common, "taskId": task["id"]}
        for changes in (
            {"silent": True},
            {"executionLane": "product_fill"},
            {"executionLane": "product_work"},
        ):
            task.update(silent=False, executionLane="default")
            task.update(changes)
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._run_task(params)
            self.assertIn(caught.exception.code, {"focus_window_denied", "execution_lane_denied"})
            self.assertFalse(caught.exception.data["outcomeUnknown"])

    def test_select_tab_runs_through_owned_task_without_focusing_window(self):
        task = self.task()
        task.update(state="ready", activeMode="smart", tabIds=[7], agentTabIds=[7])
        self.daemon.tab_leases[("fixture", 7)] = task["id"]
        calls = []

        def execute(_extension, method, params, **_kwargs):
            calls.append((method, params))
            return {"tabId": 7}

        self.daemon._extension_call = execute
        result = self.daemon._run_task(
            {
                "owner": "fixture-owner",
                "taskId": task["id"],
                "requestId": "select",
                "action": "select_tab",
                "tabId": 7,
            }
        )
        self.assertEqual(result["tabId"], 7)
        self.assertEqual(calls[0][1]["action"], "select_tab")

    def test_focus_window_dispatches_without_action_approval(self):
        task = self.task()
        task.update(state="ready", activeMode="smart", tabIds=[7], agentTabIds=[7])
        self.daemon.tab_leases[("fixture", 7)] = task["id"]
        calls = []

        def execute(_extension, method, params, **_kwargs):
            calls.append((method, params))
            return {"focused": True, "visible": True, "previousWindowId": 4, "restored": True}

        self.daemon._extension_call = execute
        app = {"pid": 321, "bundle": "example.editor", "started": 123.0}
        with (
            patch("daemon._front_app", return_value=app),
            patch("daemon._restore_front_app", return_value="restored"),
        ):
            result = self.daemon._run_task(
                {
                    "owner": "fixture-owner",
                    "taskId": task["id"],
                    "requestId": "focus",
                    "action": "focus_window",
                    "tabId": 7,
                }
            )
        self.assertTrue(result["visible"])
        self.assertEqual([item[0] for item in calls], ["browser.execute"])
        self.assertEqual(self.daemon.action_approvals, {})

    def test_focus_restores_only_recorded_other_application(self):
        app = {"pid": 321, "bundle": "example.editor", "started": 123.0}
        calls = []

        def command(args, **_kwargs):
            calls.append(args)
            if len(calls) == 1:
                return SimpleNamespace(
                    stdout='{"pid":321,"bundle":"example.editor","started":123.0}'
                )
            self.assertEqual(args[-4:], ["321", "example.editor", "123.0", "com.google.Chrome"])
            return SimpleNamespace(stdout="restored\n")

        self.daemon._extension_call = lambda *_a, **_k: {
            "focused": True,
            "visible": True,
            "previousWindowId": None,
            "restored": False,
            "restoreReason": "previous_window_unavailable",
        }
        with patch("daemon.sys.platform", "darwin"), patch("daemon.subprocess.run", command):
            result = self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)
        self.assertTrue(result["restored"])
        self.assertNotIn("restoreReason", result)
        self.assertEqual(len(calls), 2)
        self.assertEqual(app["pid"], 321)

    def test_focus_restoration_failures_and_user_switch_are_reported(self):
        app = {"pid": 321, "bundle": "example.editor", "started": 123.0}
        self.daemon._extension_call = lambda *_a, **_k: {"focused": True, "visible": True}
        with patch("daemon._front_app", return_value=None):
            result = self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)
        self.assertEqual(
            (result["restored"], result["restoreReason"]), (False, "previous_app_unavailable")
        )
        for reason in (
            "focus_changed",
            "previous_app_gone",
            "restore_failed",
            "restore_unverified",
        ):
            with (
                self.subTest(reason=reason),
                patch("daemon._front_app", return_value=app),
                patch("daemon._restore_front_app", return_value=reason),
            ):
                result = self.daemon._focus_window_call({"browser": "edge"}, {}, 25)
            self.assertEqual((result["restored"], result["restoreReason"]), (False, reason))
        with (
            patch("daemon._front_app", return_value=app),
            patch("daemon._restore_front_app") as restore,
        ):
            self.daemon._extension_call = lambda *_a, **_k: {
                "restoreReason": "focus_changed",
                "restored": False,
            }
            self.daemon._focus_window_call({"browser": "edge"}, {}, 25)
            restore.assert_not_called()

    def test_focus_same_browser_and_restore_disabled(self):
        self.daemon._extension_call = lambda *_a, **_k: {"restored": True}
        with (
            patch(
                "daemon._front_app",
                return_value={"pid": 1, "bundle": "com.google.Chrome", "started": 2},
            ),
            patch("daemon._restore_front_app") as restore,
        ):
            self.assertTrue(
                self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)["restored"]
            )
            restore.assert_not_called()
        app = {"pid": 1, "bundle": "com.google.Chrome", "started": 2}
        for later, expected in (
            (None, "restore_unverified"),
            ({"pid": 9, "bundle": "example.editor", "started": 3}, "focus_changed"),
        ):
            with self.subTest(later=later), patch("daemon._front_app", side_effect=[app, later]):
                result = self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)
            self.assertFalse(result["restored"])
            self.assertEqual(result["restoreReason"], expected)
        with patch("daemon._front_app") as front:
            self.daemon._focus_window_call({"browser": "chrome"}, {"restore": False}, 25)
            front.assert_called_once()

    def test_focus_exception_attempts_restoration_and_busy_is_predispatch(self):
        app = {"pid": 1, "bundle": "example.editor", "started": 2}

        def fail(*_args, **_kwargs):
            raise ProtocolError("extension_disconnected", "closed")

        self.daemon._extension_call = fail
        with (
            patch("daemon._front_app", return_value=app),
            patch("daemon._restore_front_app") as restore,
        ):
            with self.assertRaises(ProtocolError):
                self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)
            restore.assert_called_once_with(app, "com.google.Chrome")
        with self.daemon.focus_window_lock:
            with self.assertRaises(ProtocolError) as caught:
                self.daemon._focus_window_call({"browser": "chrome"}, {}, 25)
        self.assertEqual(caught.exception.code, "focus_window_busy")
        self.assertFalse(caught.exception.data["outcomeUnknown"])

    def test_attach_resolves_browser_selected_page_without_cleanup_ownership(self):
        calls = []

        def browser(_extension, method, params, **_):
            calls.append((method, params))
            if method == "browser.execute":
                return []
            return {"tabId": 17, "url": "https://example.test/draft", "incognito": False}

        self.daemon._extension_call = browser
        result = self.daemon._create_task(
            {
                "owner": "fixture-owner",
                "title": "接管",
                "instanceId": "fixture",
                "existingTab": {},
            }
        )
        self.assertEqual(calls, [("browser.select_existing_tab", {"incognito": False})])
        self.assertEqual(result["allowedOrigins"], ["https://example.test"])
        self.assertNotIn("attachment", result)
        task = self.daemon.tasks[result["id"]]
        approved = self.daemon._dispatch_extension(
            "fixture",
            "extension.approve",
            {
                "taskId": task["id"],
                "generation": 1,
                "tabIds": [17],
                "allowedOrigins": task["allowedOrigins"],
                "workspaceOnly": False,
            },
        )
        self.assertEqual(approved["attachedTabIds"], [17])
        self.assertEqual(approved["state"], "authorizing")
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._run_task(
                {
                    "owner": "fixture-owner",
                    "taskId": task["id"],
                    "requestId": "before-install",
                    "action": "tabs",
                }
            )
        self.assertEqual(caught.exception.code, "task_preparing")
        self.assertEqual(len(calls), 1)
        ready = self.daemon._dispatch_extension(
            "fixture",
            "extension.mode",
            {
                "taskId": task["id"],
                "generation": 1,
                "modeGeneration": 1,
                "mode": "full",
            },
        )
        self.assertEqual((ready["state"], ready["activeMode"]), ("ready", "full"))
        self.assertEqual(
            self.daemon._run_task(
                {
                    "owner": "fixture-owner",
                    "taskId": task["id"],
                    "requestId": "after-install",
                    "action": "tabs",
                }
            ),
            [],
        )
        self.assertEqual(task["agentTabIds"], [])
        self.assertEqual(task["workTabs"], [])
        self.assertEqual(self.daemon.tab_leases[("fixture", 17)], task["id"])

    def test_attachment_reuses_pending_and_installing_task_after_fresh_selection(self):
        self.daemon._extension_call = lambda *_a, **_k: {
            "tabId": 17,
            "url": "https://example.test/draft",
            "incognito": False,
        }
        params = {
            "owner": "fixture-owner",
            "title": "接管",
            "instanceId": "fixture",
            "existingTab": {},
        }
        first = self.daemon._create_task(params)
        retry = self.daemon._create_task(params)
        self.assertEqual(retry["id"], first["id"])
        self.assertEqual(len(self.daemon.tasks), 1)
        approved = self.daemon._dispatch_extension(
            "fixture",
            "extension.approve",
            {
                "taskId": first["id"],
                "generation": 1,
                "tabIds": [17],
                "allowedOrigins": first["allowedOrigins"],
            },
        )
        self.assertEqual(approved["state"], "authorizing")
        self.assertEqual(self.daemon._create_task(params)["id"], first["id"])
        self.assertEqual(len(self.daemon.tasks), 1)

    def test_attachment_pending_does_not_cross_owner_or_connection(self):
        self.daemon._extension_call = lambda *_a, **_k: {
            "tabId": 17,
            "url": "https://example.test/draft",
            "incognito": False,
        }
        params = {
            "owner": "fixture-owner",
            "title": "接管",
            "instanceId": "fixture",
            "existingTab": {},
        }
        first = self.daemon._create_task(params)
        other = self.daemon._create_task({**params, "owner": "other-owner"})
        self.assertNotEqual(first["id"], other["id"])
        self.daemon.extensions["fixture"]["connectionGeneration"] = "new-connection"
        fresh = self.daemon._create_task(params)
        self.assertNotIn(fresh["id"], {first["id"], other["id"]})

    def test_attachment_approval_requires_exact_tab_generation_and_connection(self):
        self.daemon._extension_call = lambda *_a, **_k: {
            "tabId": 17,
            "url": "https://example.test/draft",
            "incognito": False,
        }
        created = self.daemon._create_task(
            {
                "owner": "fixture-owner",
                "title": "接管",
                "instanceId": "fixture",
                "existingTab": {},
            }
        )
        request = {
            "taskId": created["id"],
            "generation": 1,
            "tabIds": [17],
            "allowedOrigins": created["allowedOrigins"],
            "workspaceOnly": False,
        }
        for changed in ({"tabIds": [18]}, {"generation": True}, {"workspaceOnly": True}):
            with self.subTest(changed=changed), self.assertRaises(ProtocolError):
                self.daemon._dispatch_extension(
                    "fixture", "extension.approve", {**request, **changed}
                )
            self.assertEqual(self.daemon.tab_leases, {})
        self.daemon.extensions["fixture"]["connectionGeneration"] = "new-connection"
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_extension("fixture", "extension.approve", request)
        self.assertEqual(self.daemon.tab_leases, {})

    def test_attachment_rejects_model_tab_ids_and_does_not_resume_stale_selection(self):
        for selector in ({"tabId": 17}, {"url": "file:///etc/passwd"}):
            with self.subTest(selector=selector), self.assertRaises(ProtocolError):
                self.daemon._create_task(
                    {
                        "owner": "fixture-owner",
                        "title": "接管",
                        "instanceId": "fixture",
                        "existingTab": selector,
                    }
                )
        self.daemon._extension_call = lambda *_a, **_k: {
            "tabId": 17,
            "url": "https://example.test/draft",
            "incognito": False,
        }
        created = self.daemon._create_task(
            {
                "owner": "fixture-owner",
                "title": "接管",
                "instanceId": "fixture",
                "existingTab": {},
            }
        )
        self.daemon.tasks[created["id"]]["state"] = "needs_sync"
        with self.assertRaises(ProtocolError) as caught:
            self.daemon._resume_task({"owner": "fixture-owner", "taskId": created["id"]})
        self.assertEqual(caught.exception.code, "reattach_required")

    def test_default_timeout_and_work_window_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            daemon = BridgeDaemon(Path(self.temp.name))
        self.assertEqual(daemon.task_idle_timeout_seconds, 1200)
        self.assertEqual(daemon.idle_close_seconds, 0)
        self.assertEqual(daemon.work_window_mode, "separate")
        with patch.dict(os.environ, {"FAST_BROWSER_WORK_WINDOW": "current"}):
            self.assertEqual(BridgeDaemon(Path(self.temp.name)).work_window_mode, "current")
        with patch.dict(os.environ, {"FAST_BROWSER_WORK_WINDOW": "invalid"}):
            with self.assertRaises(ValueError):
                BridgeDaemon(Path(self.temp.name))

    # 中文注释：未知结果也保留固定错误码，日志不写异常正文或输入；成功步骤不带残留错误。
    def test_recent_log_retains_error_code_without_changing_unknown_state(self):
        task = self.task()
        for state, code in [
            ("unknown", "stale_reference"),
            ("failed", "content_shield_uninspectable"),
        ]:
            self.daemon._append_task_log(
                task["id"],
                {
                    "action": "ref_fill",
                    "startedAt": 1,
                    "durationMs": 50,
                    "state": state,
                    "errorCode": code,
                    "message": "PRIVATE_ERROR_CANARY",
                    "text": "PRIVATE_INPUT_CANARY",
                },
            )
        self.daemon._append_task_log(
            task["id"],
            {
                "action": "semantic_snapshot",
                "startedAt": 2,
                "durationMs": 20,
                "state": "succeeded",
                "errorCode": "stale_reference",
            },
        )
        self.daemon._append_task_log(
            task["id"],
            {
                "action": "ref_fill",
                "startedAt": 3,
                "durationMs": 10,
                "state": "failed",
                "errorCode": "PRIVATE_ERROR_CANARY https://private.invalid/?token=SECRET_CANARY",
            },
        )
        rows = self.daemon._read_task_log(task["id"], 20)
        self.assertEqual(rows[0]["result"], "unknown")
        self.assertEqual(rows[0]["errorCode"], "stale_reference")
        self.assertEqual(rows[1]["result"], "content_shield_uninspectable")
        self.assertEqual(rows[1]["errorCode"], "content_shield_uninspectable")
        self.assertNotIn("errorCode", rows[2])
        self.assertEqual(rows[3]["result"], "operation_failed")
        self.assertEqual(rows[3]["errorCode"], "operation_failed")
        raw = self.daemon._task_log_path(task["id"]).read_text()
        self.assertNotIn("CANARY", raw)
        self.assertNotIn("private.invalid", raw)

    def test_fixed_execution_reasons_survive_task_log_and_readback(self):
        task = self.task()
        for reason in (
            "tab_closed",
            "debugger_detached",
            "frame_destroyed",
            "execution_context_lost",
            "cdp_timeout",
            "service_worker_disconnected",
            "chrome_api_error",
            "internal_exception",
        ):
            self.daemon._append_task_log(
                task["id"],
                {
                    "action": "js.evaluate",
                    "startedAt": 1,
                    "state": "unknown",
                    "errorCode": "execution_denied",
                    "stage": "execution",
                    "reasonCode": reason,
                },
            )
        rows = self.daemon._read_task_log(task["id"], 20)
        self.assertEqual(
            [row["reasonCode"] for row in rows],
            [
                "tab_closed",
                "debugger_detached",
                "frame_destroyed",
                "execution_context_lost",
                "cdp_timeout",
                "service_worker_disconnected",
                "chrome_api_error",
                "internal_exception",
            ],
        )
        self.assertTrue(
            all(row["stage"] == "execution" and row["result"] == "unknown" for row in rows)
        )

    def test_hourly_cleanup_revokes_empty_old_needs_sync_only(self):
        old = self.task()
        fresh = self.task()
        fresh["lastActivityAt"] = 100000
        paused = self.task()
        paused["idleRecoveryState"] = "paused"
        awaiting = self.task()
        awaiting["idleRecoveryState"] = "pending_approval"
        occupied = self.task()
        occupied["workTabs"] = [{"tabId": 7, "windowId": 1, "groupId": 3}]
        unknown = self.task()
        unknown["requestHistory"] = [{"action": "new_tab", "state": "unknown"}]
        for task in (old, paused, awaiting, occupied, unknown):
            task["lastActivityAt"] = 1
        with patch("time.time", return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(old["state"], "closed")
        self.assertEqual(
            [
                fresh["state"],
                paused["state"],
                awaiting["state"],
                occupied["state"],
                unknown["state"],
            ],
            ["needs_sync"] * 5,
        )
        fresh["lastActivityAt"] = 1
        with patch("time.time", return_value=100100):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(fresh["state"], "needs_sync")
        with patch("time.time", return_value=103600):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(fresh["state"], "closed")

    def test_stale_work_records_require_live_browser_proof(self):
        task = self.task()
        task["workTabs"] = [{"tabId": 7, "windowId": 1, "groupId": 3}]
        calls = []

        def browser(_extension, method, params, **_):
            calls.append(method)
            return {
                "cleanupState": "succeeded",
                "remainingTabIds": [],
                "preservedTabIds": [],
                "unknownTabIds": [],
            }

        self.daemon._extension_call = browser
        with patch("time.time", return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(task["state"], "closed")
        self.assertEqual(calls, ["browser.cleanup_status"])

    def test_pending_human_task_is_not_cleaned(self):
        task = self.task()
        self.daemon.action_approvals[(task["id"], "pending")] = {
            "taskId": task["id"],
            "generation": task["generation"],
            "status": "user_input_required",
            "expiresAt": 100001,
        }
        with patch("time.time", return_value=100000):
            self.daemon._sweep_empty_needs_sync()
        self.assertEqual(task["state"], "needs_sync")

    def test_session_count_includes_only_held_work_pages(self):
        a = self.task()
        b = self.task()
        a.update(state="ready", tabIds=[7], agentTabIds=[7])
        b.update(state="ready", tabIds=[8, 9], agentTabIds=[8, 9])
        for tab, task in [(7, a), (8, b)]:
            self.daemon.tab_leases[("fixture", tab)] = task["id"]
        self.assertEqual(self.daemon._public_task(a)["open_tabs"], 2)
        self.assertEqual(self.daemon._public_task(a)["workWindowMode"], "separate")
        b["owner"] = "other-session"
        self.assertEqual(self.daemon._public_task(a)["open_tabs"], 1)
        b["owner"] = a["owner"]
        self.daemon.tab_leases.pop(("fixture", 8))
        self.assertEqual(self.daemon._public_task(a)["open_tabs"], 1)

    def test_no_effect_fields_survive_daemon_client_and_script_exception(self):
        data = {
            "effect": "unobserved",
            "suggestion": HINT,
            "outcomeUnknown": True,
            "retryable": False,
            "secret": "discard",
        }
        error = ProtocolError("click_no_effect", "fixed", data)
        client = BridgeError(error.code, error.message, error.data)
        self.assertEqual(
            client.data,
            {
                **{k: v for k, v in data.items() if k != "secret"},
                "category": "site",
                "hint": "请检查浏览器页面和任务状态",
            },
        )
        uncertain = ACTION.OutcomeUnknown("fixed", code=client.code, data=client.data)
        child = CHILD.BrowserError(
            "fixed",
            code=uncertain.code,
            effect=uncertain.data["effect"],
            suggestion=uncertain.data["suggestion"],
        )
        self.assertEqual(
            (child.code, child.effect, child.suggestion), ("click_no_effect", "unobserved", HINT)
        )
        self.assertNotIn("suggestion", _safe_error_data({"suggestion": "arbitrary page data"}))

    def test_observed_and_count_fields_survive_result_projection(self):
        for action in ("click", "ref_click", "ref_press", "press", "interaction.click"):
            result = RUNTIME._project_schema(
                {"effect": "observed", "secret": "discard"}, RUNTIME._RESULT_ACTIONS[action]
            )
            self.assertEqual(result, {"effect": "observed"})
        self.assertEqual(
            RUNTIME._project_schema(
                {"tabId": 7, "open_tabs": 8, "tab_hint": "不再用的网站先 fast_browser_close"},
                RUNTIME._RESULT_ACTIONS["new_tab"],
            )["open_tabs"],
            8,
        )


if __name__ == "__main__":
    unittest.main()


class FocusLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="focus-lease-")
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon._prepare_data_dir()
        self.app = {"pid": 1, "bundle": "example.editor", "started": 2}
        self.daemon._extension_call = lambda *_a, **_kw: {
            "focused": True,
            "visible": True,
            "workWindowId": 2,
            "previousWindowId": 1,
        }

    def test_deferred_restores_once_and_rejects_other_task(self):
        with (
            patch("daemon._front_app", return_value=self.app),
            patch("daemon._restore_front_app", return_value="restored") as restore,
        ):
            lease = self.daemon._focus_window_call(
                {"browser": "chrome"}, {"taskId": "a", "restore": "deferred"}, 1
            )
            self.assertFalse(lease["restored"])
            restore.assert_not_called()
            with self.assertRaises(ProtocolError):
                self.daemon._restore_focus_lease("b", lease["focusLeaseId"])
            self.assertTrue(
                self.daemon._restore_focus_lease("a", lease["focusLeaseId"])["restored"]
            )
            restore.assert_called_once()
            with self.assertRaises(ProtocolError):
                self.daemon._restore_focus_lease("a", lease["focusLeaseId"])
            self.assertFalse(self.daemon.focus_window_lock.locked())

    def test_task_close_restores_lease(self):
        self.daemon._prepare_data_dir()
        self.daemon._notify_tasks_changed = lambda _: None
        self.daemon.extensions["fixture"] = {"instanceId": "fixture", "browser": "chrome"}
        task = self.daemon._dispatch_client(
            "shared.create",
            {
                "owner": "owner",
                "title": "Task",
                "instanceId": "fixture",
                "allowedOrigins": ["https://example.test"],
            },
        )
        task_id = task["id"]
        self.daemon._extension_call = lambda _ext, method, _params, **_kw: (
            {"focused": True, "visible": True, "workWindowId": 2, "previousWindowId": 1}
            if method == "browser.execute"
            else {"released": True, "cleanupState": "succeeded"}
        )
        with (
            patch("daemon._front_app", return_value=self.app),
            patch("daemon._restore_front_app", return_value="restored") as restore,
        ):
            self.daemon._focus_window_call(
                {"browser": "chrome"}, {"taskId": task_id, "restore": "deferred"}, 1
            )
            self.daemon._release_task({"owner": "owner", "taskId": task_id}, "closed", True)
            restore.assert_called_once()
            self.assertFalse(self.daemon.focus_window_lock.locked())

    def test_revoked_task_restores_without_blocking_callback(self):
        import threading

        done = threading.Event()
        task = {"id": "a", "instanceId": "fixture", "tabIds": [], "owner": "owner"}
        with (
            patch("daemon._front_app", return_value=self.app),
            patch("daemon._restore_front_app", side_effect=lambda *_: (done.set(), "restored")[1]),
        ):
            self.daemon._focus_window_call(
                {"browser": "chrome"}, {"taskId": "a", "restore": "deferred"}, 1
            )
            self.daemon._revoke_task_locked(task, "cancelled")
            self.assertTrue(done.wait(1))

    def test_timeout_restores_and_unlocks(self):
        import time

        with (
            patch("daemon._front_app", return_value=self.app),
            patch("daemon._restore_front_app", return_value="restored") as restore,
        ):
            self.daemon._focus_window_call(
                {"browser": "chrome"}, {"taskId": "a", "restore": "deferred", "maxMs": 20}, 1
            )
            deadline = time.monotonic() + 1
            while self.daemon.focus_window_lock.locked() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.daemon.focus_window_lock.locked())
            restore.assert_called_once()

    def test_locked_screen_never_dispatches(self):
        self.daemon._extension_call = unittest.mock.Mock()
        locked = SimpleNamespace(
            stdout='{"pid":99065,"bundle":"com.apple.loginwindow","started":null}'
        )
        with (
            patch("daemon.sys.platform", "darwin"),
            patch("daemon.subprocess.run", return_value=locked),
        ):
            for restore in (True, False, "deferred"):
                with self.subTest(restore=restore), self.assertRaises(ProtocolError) as caught:
                    self.daemon._focus_window_call({"browser": "edge"}, {"restore": restore}, 1)
                self.assertEqual(caught.exception.code, "screen_locked")
                self.assertEqual(
                    (caught.exception.data["outcomeUnknown"], caught.exception.data["retryable"]),
                    (False, False),
                )
                self.assertFalse(self.daemon.focus_window_lock.locked())
        self.daemon._extension_call.assert_not_called()

    def test_missing_start_time_for_normal_app_remains_unavailable(self):
        app = SimpleNamespace(stdout='{"pid":321,"bundle":"example.editor","started":null}')
        with (
            patch("daemon.sys.platform", "darwin"),
            patch("daemon.subprocess.run", return_value=app),
            patch("daemon._restore_front_app") as restore,
        ):
            result = self.daemon._focus_window_call({"browser": "chrome"}, {}, 1)
        self.assertEqual(
            (result["restored"], result["restoreReason"]), (False, "previous_app_unavailable")
        )
        restore.assert_not_called()

    def test_context_restores_on_exception_and_preserves_tab_scope(self):
        calls = []

        def call(op, args):
            calls.append((op, args, CHILD._tab_scope.get()))
            return {"focusLeaseId": "lease"}

        with patch.object(CHILD, "_call", side_effect=call):
            with self.assertRaisesRegex(RuntimeError, "body"):
                with CHILD.focused_window(tab=7, max_ms=100):
                    self.assertIsNone(CHILD._tab_scope.get())
                    raise RuntimeError("body")
        self.assertEqual(
            calls,
            [
                ("run", ["focus_window", {"restore": "deferred", "maxMs": 100}], 7),
                ("run", ["focus_restore", {"focusLeaseId": "lease"}], 7),
            ],
        )

    def test_context_does_not_restore_when_locked_before_lease(self):
        error = ProtocolError("screen_locked", "屏幕已锁定", {"outcomeUnknown": False})
        with patch.object(CHILD, "_call", side_effect=error) as call:
            with self.assertRaises(ProtocolError) as caught:
                with CHILD.focused_window(tab=7):
                    self.fail("锁屏时不应进入上下文")
        self.assertIs(caught.exception, error)
        call.assert_called_once_with(
            "run", ["focus_window", {"restore": "deferred", "maxMs": 120000}]
        )

    def test_doctor_only_checks_browser_main_process(self):
        runtime = load("focus_lease_runtime", "native-bridge/fbl_runtime.py")
        output = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --disable-backgrounding-occluded-windows\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --disable-backgrounding-occluded-windows\n"
        flags = runtime.browser_render_flags(
            [{"browser": "edge"}, {"browser": "chrome"}],
            run=lambda *a, **k: SimpleNamespace(stdout=output),
        )
        self.assertEqual(
            [(f["browser"], f["enabled"]) for f in flags], [("chrome", False), ("edge", True)]
        )
        self.assertIn("--disable-backgrounding-occluded-windows", flags[0]["command"])
