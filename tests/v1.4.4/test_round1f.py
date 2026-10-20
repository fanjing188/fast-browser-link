"""中文注释：1f 契约、等待、摘要和脱敏来源的离线行为验收。"""

import importlib.util
import json
import os
import tempfile
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from client import BridgeError
from daemon import BridgeDaemon, ProtocolError


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TOOLS = load("round1f_tools", "executor-plugin/native_tools.py")
OPEN = load("round1f_open", "executor-plugin/open_tool.py")
CHILD = load("round1f_child", "executor-plugin/script_lane/child.py")
SCRIPT = load("round1f_script_tool", "executor-plugin/script_lane/tool.py")
REFERENCE = load("round1f_reference", "executor-plugin/reference.py")
BINDING = {"taskId": "t", "documentId": "d", "leaseId": "l"}


class Runtime:
    # 中文注释：合成已授权实例和导航回执，不连接任何浏览器。
    def __init__(self, ready="complete", summary=None):
        self.authority = types.SimpleNamespace(
            consume=lambda *a, **k: types.SimpleNamespace(owner="o", tool_call_id="call")
        )
        self.calls, self.ready, self.summary = [], ready, summary

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "browser.list":
            return [
                {
                    "instanceId": "i",
                    "browser": "chrome",
                    "connected": True,
                    "consentStatus": "enabled",
                }
            ]
        if method == "shared.list":
            return [
                {
                    "id": "t",
                    "state": "ready",
                    "instanceId": "i",
                    "allowedOrigins": ["https://fixture.test"],
                }
            ]
        if method == "shared.run" and params["action"] == "new_tab":
            return {"tabId": 7, "ready": self.ready, "url": "https://fixture.test/"}
        if method == "shared.run" and params["action"] == "semantic_snapshot":
            if isinstance(self.summary, Exception):
                raise self.summary
            return self.summary
        raise AssertionError(method)


class Round1fTests(unittest.TestCase):
    def test_wait_uses_one_cross_layer_request_and_an_absolute_deadline(self):
        receipt = {
            "satisfied": True,
            "timed_out": False,
            "last_observation": {"count": 1},
            "coverage": {"complete": True},
            "reason": None,
        }

        def call(op, args):
            self.assertEqual((op, args[0]), ("run", "page.observe"))
            self.assertIn("wait", args[1]["options"])
            self.assertEqual(args[1]["options"]["wait"]["deadlineMs"], 103000)
            return receipt

        with (
            patch.object(CHILD.time, "time", return_value=100),
            patch.object(CHILD, "_call", side_effect=call) as rpc,
        ):
            self.assertIs(CHILD.wait_for("#result", timeout=3), receipt)
        self.assertEqual(rpc.call_count, 1)

    def test_run_fields_are_fixed_and_values_are_not_echoed(self):
        runtime = Runtime()
        handler = TOOLS.make_tool_handler("fast_browser_run", runtime)
        result = json.loads(handler({"task_id": "PRIVATE", "action": "semantic_snapshot"}))
        self.assertEqual((result["code"], result["fields"]), ("missing_fields", ["tab_id"]))
        self.assertNotIn("PRIVATE", str(result))
        for args, fields in [
            ({"tab_id": "PRIVATE"}, ["tab_id"]),
            ({"tab_id": 7, "text": "PRIVATE"}, ["text"]),
        ]:
            result = json.loads(handler({"task_id": "t", "action": "snapshot", **args}))
            self.assertEqual((result["code"], result["fields"]), ("invalid_fields", fields))
            self.assertNotIn("PRIVATE", str(result))
        self.assertEqual(runtime.calls, [])
        schema = TOOLS.TOOL_SCHEMAS["fast_browser_run"]["parameters"]["allOf"][0]
        self.assertNotIn("new_tab", schema["if"]["properties"]["action"]["enum"])
        self.assertEqual(schema["then"]["required"], ["tab_id"])

    def test_wait_passes_conditions_and_tab_without_child_polling(self):
        # 中文注释：命中/稳定/覆盖/文档变化的算法断言迁到 round1f.test.mjs，Python 只守传参边界。
        for state in ("present", "absent", "stable", "text", "count"):
            with patch.object(CHILD, "_call", return_value={"satisfied": True}) as call:
                self.assertTrue(
                    CHILD.wait_for("#result", state=state, text="ready", count=1, tab=7)[
                        "satisfied"
                    ]
                )
            self.assertEqual(call.call_count, 1)
            options = call.call_args.args[1][1]["options"]
            self.assertEqual(options["selector"], "#result")
            self.assertEqual(options["wait"]["state"], state)
            self.assertEqual(options["wait"].get("text"), "ready" if state == "text" else None)
            self.assertEqual(options["wait"].get("count"), 1 if state == "count" else None)

    def test_wait_preserves_negative_extension_receipt_without_reread(self):
        for reason in ("deadline_reached", "condition_changed"):
            receipt = {
                "satisfied": False,
                "timed_out": reason == "deadline_reached",
                "reason": reason,
                "coverage": {"complete": False},
                "last_observation": None,
            }
            with patch.object(CHILD, "_call", return_value=receipt) as call:
                self.assertIs(CHILD.wait_for("#result"), receipt)
            self.assertEqual(call.call_count, 1)

    def test_wait_timeout_limits_are_explicit_and_safe(self):
        for timeout in [65, 90, 120, float("nan"), 0, True]:
            with self.assertRaises(CHILD.BrowserError) as caught:
                CHILD.wait_for("#PRIVATE", timeout=timeout)
            self.assertEqual(caught.exception.code, "invalid_fields")
            self.assertIn("timeout_must_be_in_0_60_seconds", str(caught.exception))
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_wait_selector_errors_and_authority_denials_are_not_retried(self):
        for code in ["invalid_params", "task_paused", "browser_access_revoked", "tab_out_of_scope"]:
            with patch.object(
                CHILD,
                "_call",
                side_effect=CHILD.BrowserError("PRIVATE", code=code, outcome_unknown=False),
            ) as call:
                with self.assertRaises(CHILD.BrowserError) as caught:
                    CHILD.wait_for("#PRIVATE")
                self.assertEqual(call.call_count, 1)
                self.assertEqual(
                    caught.exception.code, "invalid_fields" if code == "invalid_params" else code
                )
                if code == "invalid_params":
                    self.assertNotIn("PRIVATE", str(caught.exception))

    def test_open_loading_and_single_intent_summary(self):
        bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
        runtime = Runtime("loading")
        result = json.loads(
            OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)(
                {"url": "https://fixture.test/", "read_intent": "content"}, session_id="s"
            )
        )
        self.assertEqual(result["summary_missing"]["reason"], "page_loading")
        self.assertIn("原 tab", result["read_hint"])
        self.assertFalse(
            any(params.get("action") == "semantic_snapshot" for _, params in runtime.calls)
        )
        for mode in ["content", "interactive"]:
            runtime = Runtime(
                summary={
                    "binding": BINDING,
                    "snapshotId": "s",
                    "coverage": {"complete": True},
                    "items": [{"ref": "r", "role": "heading", "name": "hello"}],
                }
            )
            result = json.loads(
                OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)(
                    {"url": "https://fixture.test/", "read_intent": mode, "root": "#main"},
                    session_id="s",
                )
            )
            reads = [
                params for _, params in runtime.calls if params.get("action") == "semantic_snapshot"
            ]
            self.assertEqual(len(reads), 1)
            self.assertEqual(reads[0]["options"]["mode"], mode)
            self.assertEqual(reads[0]["options"]["root"], "#main")
            self.assertEqual(result["summary"]["binding"], BINDING)
            self.assertTrue(result["summary"]["coverage"]["complete"])

    def test_summary_failure_and_clipping_are_explicit(self):
        for page, reason in [
            (None, "summary_return_type"),
            (BridgeError("overlay_injection_failed", "PRIVATE"), "overlay_injection_failed"),
        ]:
            runtime = Runtime(summary=page)
            bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
            result = json.loads(
                OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)(
                    {"url": "https://fixture.test/"}, session_id="s"
                )
            )
            self.assertEqual(result["summary_missing"]["reason"], reason)
            self.assertNotIn("PRIVATE", str(result))
        runtime = Runtime(
            summary={
                "binding": BINDING,
                "snapshotId": "s",
                "coverage": {"complete": False},
                "nextCursor": "cursor",
                "items": [{"ref": "r", "name": "x" * 2000}],
            }
        )
        summary = OPEN._summary(runtime, "o", "t", 7, "c", "https://fixture.test/")
        self.assertNotIn("summary_items", summary["truncation"])
        self.assertEqual(summary["items"], runtime.summary["items"])
        self.assertIn("snapshot_coverage", summary["truncation"])
        self.assertEqual(summary["nextCursor"], "cursor")
        self.assertIn("续读", summary["read_hint"])

    def test_origin_and_fixed_stage_metadata_survive_client_and_tool(self):
        for code in ["origin_denied", "tab_out_of_scope"]:
            error = BridgeError(
                code,
                "PRIVATE",
                {"currentOrigin": "https://fixture.test/private?q=SECRET", "outcomeUnknown": False},
            )
            self.assertEqual(error.data["currentOrigin"], "https://fixture.test")
            runtime = Runtime()
            runtime.call = lambda *a, **k: (_ for _ in ()).throw(error)
            result = json.loads(
                TOOLS.make_tool_handler("fast_browser_run", runtime)(
                    {"task_id": "t", "action": "snapshot", "tab_id": 7}
                )
            )
            self.assertEqual(result["currentOrigin"], "https://fixture.test")
            self.assertIn("goto_url", result["scopeHint"])
            self.assertNotIn("PRIVATE", str(result))
            self.assertNotIn("SECRET", str(result))
        for reason in ["initialization_exception", "return_type_invalid"]:
            self.assertEqual(
                BridgeError(
                    "overlay_injection_failed",
                    "PRIVATE",
                    {"stage": "overlay", "reasonCode": reason},
                ).data["reasonCode"],
                reason,
            )
        self.assertNotIn(
            "stage",
            BridgeError(
                "execution_denied", "PRIVATE", {"stage": "PRIVATE", "reasonCode": "SECRET"}
            ).data,
        )

    def test_observer_wire_is_bounded_and_uses_read_approval(self):
        BridgeDaemon._validate_run_params(
            "page.observe",
            {
                "owner": "o",
                "taskId": "t",
                "requestId": "r",
                "action": "page.observe",
                "tabId": 7,
                "options": {"selector": "#result"},
            },
        )
        with self.assertRaises(ProtocolError):
            BridgeDaemon._validate_run_params(
                "page.observe",
                {
                    "owner": "o",
                    "taskId": "t",
                    "requestId": "r",
                    "action": "page.observe",
                    "tabId": 7,
                    "options": {"selector": "#result", "maxScan": 1000000},
                },
            )
        from daemon import SITE_READ_ACTIONS, SCRIPT_ACTIONS

        self.assertIn("page.observe", SITE_READ_ACTIONS)
        self.assertNotIn("page.observe", SCRIPT_ACTIONS)

    def test_wait_wire_accepts_bounded_condition_and_rejects_scope_expansion(self):
        import time

        wait = {
            "state": "text",
            "text": "ready",
            "intervalMs": 50,
            "deadlineMs": time.time() * 1000 + 59000,
        }
        params = {
            "owner": "o",
            "taskId": "t",
            "requestId": "r",
            "action": "page.observe",
            "tabId": 7,
            "options": {"selector": "#result", "wait": wait},
        }
        BridgeDaemon._validate_run_params("page.observe", params)
        for change in [
            {"deadlineMs": float("nan")},
            {"deadlineMs": time.time() * 1000 + 90000},
            {"intervalMs": True},
            {"intervalMs": 0},
            {"state": "click"},
            {"count": -1, "state": "count"},
            {"text": "x" * 12001},
            {"script": "PRIVATE"},
        ]:
            with self.subTest(change=list(change)), self.assertRaises(ProtocolError):
                BridgeDaemon._validate_run_params(
                    "page.observe",
                    {**params, "options": {"selector": "#result", "wait": {**wait, **change}}},
                )

    def test_wait_client_deadline_covers_condition_then_resets(self):
        import time

        class Client:
            def __init__(self, _home, timeout):
                self.timeout = timeout

            def call(self, *args):
                return self.timeout

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as home:
            runtime = TOOLS.runtime_module().NativeProfileRuntime(home, ROOT / "executor-plugin")
            runtime._client_module = types.SimpleNamespace(BridgeClient=Client)
            try:
                timeout = runtime.call(
                    "shared.run",
                    {
                        "action": "page.observe",
                        "options": {"wait": {"deadlineMs": time.time() * 1000 + 59000}},
                    },
                )
                self.assertGreater(timeout, 60)
                self.assertLessEqual(timeout, 65)
                self.assertEqual(runtime.call("health", {}), 35)
            finally:
                runtime.close()

    def test_wait_daemon_queue_expires_without_browser_dispatch(self):
        import time
        import threading

        with tempfile.TemporaryDirectory() as home:
            daemon = BridgeDaemon(Path(home))
            daemon._prepare_data_dir()
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions["i"] = {"instanceId": "i", "browser": "edge", "version": "2.2.0"}
            created = daemon._dispatch_client(
                "shared.create",
                {
                    "owner": "o",
                    "instanceId": "i",
                    "title": "queue",
                    "allowedOrigins": ["https://fixture.test"],
                },
            )
            task = daemon.tasks[created["id"]]
            task.update(state="ready", tabIds=[7], agentTabIds=[7])
            daemon.tab_leases[("i", 7)] = task["id"]
            done, errors, calls = threading.Event(), [], []
            daemon._extension_call = lambda *a, **k: calls.append(a) or {"count": 0}
            params = {
                "owner": "o",
                "taskId": task["id"],
                "tabId": 7,
                "requestId": "wait",
                "action": "page.observe",
                "options": {
                    "selector": "#result",
                    "wait": {
                        "state": "present",
                        "intervalMs": 50,
                        "deadlineMs": time.time() * 1000 + 50,
                    },
                },
            }

            def work():
                try:
                    daemon._dispatch_client("shared.run", params)
                except ProtocolError as exc:
                    errors.append(exc)
                finally:
                    done.set()

            with daemon.task_locks[task["id"]]:
                worker = threading.Thread(target=work)
                worker.start()
                expired = done.wait(0.5)
            worker.join(2)
            self.assertTrue(expired, "daemon queue ignored the wait deadline")
            self.assertEqual(calls, [])
            self.assertEqual(errors[0].code, "element_timeout")
            self.assertFalse(errors[0].data["outcomeUnknown"])

    def test_wait_expiring_during_journal_flush_never_dispatches_to_browser(self):
        import time

        with tempfile.TemporaryDirectory() as home:
            daemon = BridgeDaemon(Path(home))
            daemon._prepare_data_dir()
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions["i"] = {"instanceId": "i", "browser": "edge", "version": "2.2.0"}
            task = daemon._create_task(
                {
                    "owner": "o",
                    "instanceId": "i",
                    "title": "journal",
                    "allowedOrigins": ["https://fixture.test"],
                }
            )
            task = daemon.tasks[task["id"]]
            task.update(state="ready", tabIds=[7], agentTabIds=[7])
            daemon.tab_leases[("i", 7)] = task["id"]
            calls = []
            daemon._extension_call = lambda *a, **k: calls.append(a) or {
                "origin": "https://fixture.test",
                "satisfied": True,
            }
            params = {
                "owner": "o",
                "taskId": task["id"],
                "tabId": 7,
                "requestId": "wait-journal",
                "action": "page.observe",
                "options": {
                    "selector": "#result",
                    "wait": {
                        "state": "present",
                        "intervalMs": 50,
                        "deadlineMs": time.time() * 1000 + 50,
                    },
                },
            }
            persist = daemon._persist_dispatched
            with patch("daemon.time.time", return_value=time.time()) as clock:

                def flush(*args):
                    persist(*args)
                    clock.return_value += 1

                with patch.object(daemon, "_persist_dispatched", side_effect=flush):
                    with self.assertRaises(ProtocolError) as caught:
                        daemon._dispatch_client("shared.run", params)
            self.assertEqual(caught.exception.code, "element_timeout")
            self.assertFalse(caught.exception.data["outcomeUnknown"])
            # 中文注释：准入前的来源复核仍须执行，落盘跨截止后不得再发 browser.execute。
            self.assertEqual([call[1] for call in calls], ["browser.read_origin"])
            daemon._flush_tasks()

    def test_script_output_clip_reports_category_and_workspace_continuation(self):
        class Launch:
            # 中文注释：脚本只打印合成数据，继承空设备 fd，不接触浏览器或用户配置。
            def __init__(self):
                self.fd = os.open(os.devnull, os.O_RDONLY)

            def close(self):
                os.close(self.fd)
                self.receipt = {
                    "last_operation": None,
                    "execution_complete": True,
                    "outcome_unknown": False,
                }

        bridge = types.SimpleNamespace(prepare=lambda **kwargs: Launch())
        with tempfile.TemporaryDirectory(prefix="bf-") as directory:
            workspace = Path(directory)
            (workspace / "tmp").mkdir()
            result = SCRIPT.run_script(
                bridge,
                session_id="synthetic",
                tool_call_id="r",
                workspace=workspace,
                code="print('x'*25000)",
                timeout_s=5,
            )
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["stdout_truncated"])
        self.assertEqual(len(result["stdout"]), 20000)
        self.assertEqual(result["truncation"][0]["category"], "stdout_prefix")
        self.assertIn("工作区", result["truncation"][0]["continuation"])
        self.assertTrue(result["execution_complete"])

    def test_open_and_script_missing_and_invalid_fields_do_not_echo_values(self):
        runtime = Runtime()
        bridge = types.SimpleNamespace(_bindings={}, bind=lambda *a, **k: None)
        open_handler = OPEN.make_handler(runtime, bridge, lease_error=RuntimeError)
        for args, code, fields in [
            ({}, "missing_fields", ["url"]),
            (
                {"url": "https://fixture.test/", "read_intent": "PRIVATE"},
                "invalid_fields",
                ["read_intent"],
            ),
        ]:
            result = json.loads(open_handler(args))
            self.assertEqual((result["code"], result["fields"]), (code, fields))
            self.assertNotIn("PRIVATE", str(result))
        script_handler = SCRIPT.make_handler(
            bridge,
            runtime.authority,
            Path("/tmp"),
            lease_error=RuntimeError,
            bridge_denied=RuntimeError,
        )
        for args, code, fields in [
            ({}, "missing_fields", ["code"]),
            ({"code": "PRIVATE", "timeout_s": 0}, "invalid_fields", ["timeout_s"]),
        ]:
            result = json.loads(script_handler(args))
            self.assertEqual((result["code"], result["fields"]), (code, fields))
            self.assertNotIn("PRIVATE", str(result))

    def test_reference_comes_from_real_helper_docs(self):
        catalog = {row["name"]: row for row in REFERENCE.helper_catalog()}
        for name in ["page_text", "read_page", "semantic_snapshot", "wait_for"]:
            self.assertIn("dict", catalog[name]["description"])
        self.assertIn("60", catalog["wait_for"]["description"])
        self.assertIn("arguments", catalog["evaluate"]["description"])


if __name__ == "__main__":
    unittest.main()
