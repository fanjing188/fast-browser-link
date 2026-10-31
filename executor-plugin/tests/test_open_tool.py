"""fast_browser_open: one-call start, with a synthetic daemon; no browser."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN))
import native_runtime  # noqa: E402

open_tool = native_runtime.load_module(PLUGIN / "open_tool.py", "open_tool_under_test_")
integration = native_runtime.load_module(
    PLUGIN / "single_tool_adapter" / "integration.py", "open_integration_under_test_"
)


class FakeBridge:
    def __init__(self):
        self.calls = []

    def bind(self, session_id, *, owner, task_id, tab_id=None):
        self.calls.append(("bind", session_id, task_id))

    def unbind(self, session_id, *, task_id=None):
        self.calls.append(("unbind", session_id))


class FakeRuntime:
    def __init__(self, directory, browsers, *, ready_after=0, tasks=None, run_status=None):
        self.authority = native_runtime.NativeOwnerAuthority(directory)
        self.authority.lease_tools((open_tool.TOOL_NAME,))
        self.browsers = browsers
        self.ready_after = ready_after
        self.tasks = dict(tasks or {})
        self.tabs = {}
        self.run_status = run_status
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, dict(params)))
        if method == "browser.list":
            return self.browsers
        if method == "shared.list":
            return [
                dict(task)
                for task in self.tasks.values()
                if task.get("owner", params["owner"]) == params["owner"]
            ]
        if method == "shared.create":
            task = {
                "id": f"task-{len(self.tasks) + 1}",
                "state": "pending_approval",
                "instanceId": params["instanceId"],
                "allowedOrigins": params["allowedOrigins"],
                "incognito": params.get("incognito", False),
                "owner": params["owner"],
                "polls": 0,
            }
            self.tasks[task["id"]] = task
            return dict(task)
        if method == "shared.get":
            task = self.tasks[params["taskId"]]
            task["polls"] += 1
            if task["state"] == "pending_approval" and task["polls"] > self.ready_after:
                task["state"] = "ready"
            return dict(task)
        if method == "shared.run":
            if params["action"] == "tabs":
                return list(self.tabs.get(params["taskId"], []))
            if self.run_status:
                return {"status": self.run_status, "requestId": params["requestId"]}
            if params["action"] == "semantic_snapshot":
                mode = params["options"]["mode"]
                return {
                    "snapshotId": "snap-1",
                    "binding": {
                        "taskId": params["taskId"],
                        "documentId": "doc-1",
                        "leaseId": "lease-1",
                    },
                    "items": [{"role": "heading", "name": "目录"}]
                    if mode == "content"
                    else [
                        {"ref": f"r{index}", "role": "button", "name": "操作" * 100}
                        for index in range(12)
                    ],
                    "nextCursor": "after-12" if mode != "content" else None,
                    "coverage": {
                        "complete": mode == "content",
                        "returned": 12 if mode != "content" else 1,
                    },
                }
            if params["action"] == "navigate":
                tab = next(
                    row for row in self.tabs[params["taskId"]] if row["id"] == params["tabId"]
                )
                tab["url"] = params["url"]
                return {"tabId": tab["id"], "url": tab["url"], "ready": "interactive"}
            if params["action"] == "ref_click":
                # 中文注释：模拟守护进程按摘要原始快照绑定接受后续引用动作。
                assert params["snapshotId"] == "snap-1"
                assert params["binding"]["taskId"] == params["taskId"]
                return {"clicked": True, "ref": params["ref"]}
            opened = {"tabId": 41 + len(self.tabs.get(params["taskId"], [])), "url": params["url"]}
            self.tabs.setdefault(params["taskId"], []).append(
                {"id": opened["tabId"], "url": params["url"]}
            )
            self.tasks[params["taskId"]].setdefault("workTabs", []).append(
                {"tabId": opened["tabId"]}
            )
            opened["open_tabs"] = sum(len(task.get("workTabs", [])) for task in self.tasks.values())
            return opened
        raise AssertionError(method)


EDGE = {"instanceId": "edge-1", "browser": "edge", "connected": True, "consentStatus": "enabled"}
CHROME = {
    "instanceId": "chrome-1",
    "browser": "chrome",
    "connected": True,
    "consentStatus": "enabled",
}


class OpenToolTests(unittest.TestCase):
    def test_attach_current_page_with_real_vault_coordinator(self):
        from vault_adapter.integration import VaultBindingRegistry

        self.make([EDGE])
        revoked = []
        port = type("Port", (), {"revoke_binding": lambda _, *args: revoked.append(args)})()
        vault = VaultBindingRegistry(self.runtime, port)
        self.bridge.bridges += (vault,)
        original = self.runtime.call

        def call(method, params):
            if method == "shared.create" and "existingTab" in params:
                original(method, {**params, "allowedOrigins": ["https://shop.example"]})
                task = self.runtime.tasks["task-1"]
                task.update(
                    tabIds=[17],
                    attachedTabIds=[17],
                    workTabs=[],
                    generation=3,
                    modeGeneration=2,
                    activeMode="full",
                )
                self.runtime.tabs[task["id"]] = [
                    {"id": 17, "url": "https://shop.example/draft", "title": "草稿"}
                ]
                return dict(task)
            return original(method, params)

        self.runtime.call = call
        result = self.open({"existing_tab": True, "summary": False})
        self.assertTrue(result.get("attached"), result)
        self.assertEqual(result["tab_id"], 17)
        self.assertEqual(vault.resolve_vault_binding("session-a")["tab_id"], 17)
        task = self.runtime.tasks[result["task_id"]]
        self.assertEqual(task["workTabs"], [])
        self.assertNotIn("agentTabIds", task)
        self.assertFalse(
            any(
                method == "shared.run" and params["action"] in {"new_tab", "navigate"}
                for method, params in self.runtime.calls
            )
        )
        task["tabIds"] = []
        self.assertIsNone(vault.resolve_vault_binding("session-a"))
        self.assertTrue(vault.claims("session-a"))

    def test_attach_current_page_binds_without_opening_or_navigating(self):
        self.make([EDGE])
        original = self.runtime.call

        def call(method, params):
            if method == "shared.create" and "existingTab" in params:
                self.assertEqual(params["existingTab"], {})
                task = original(method, {**params, "allowedOrigins": ["https://shop.example"]})
                self.runtime.tasks[task["id"]]["attachedTabIds"] = [17]
                self.runtime.tabs[task["id"]] = [
                    {"id": 17, "url": "https://shop.example/draft", "title": "草稿"}
                ]
                return {**task, "attachedTabIds": [17]}
            return original(method, params)

        self.runtime.call = call
        result = self.open({"existing_tab": True, "summary": False})
        self.assertEqual(result["tab_id"], 17)
        self.assertTrue(result["attached"])
        self.assertEqual(result["url"], "https://shop.example/draft")
        self.assertEqual(self.bridge._bindings["session-a"][1], result["task_id"])
        self.assertFalse(
            any(
                method == "shared.run" and params["action"] in {"new_tab", "navigate"}
                for method, params in self.runtime.calls
            )
        )

    def test_summary_refusal_keeps_fixed_cause_without_reopening_or_prompting_for_consent(self):
        self.make([EDGE])
        original = self.runtime.call
        client_module = native_runtime.load_module(
            PLUGIN.parent / "native-bridge/client.py", "summary_client_"
        )

        def call(method, params):
            if method == "shared.run" and params["action"] == "semantic_snapshot":
                raise client_module.BridgeError(
                    "permission_denied",
                    "SECRET_CANARY",
                    {
                        "stage": "authority",
                        "reasonCode": "stale_generation",
                        "outcomeUnknown": False,
                    },
                )
            return original(method, params)

        self.runtime.call = call
        result = self.open({"url": "https://shop.example/a"})
        self.assertEqual(result["tab_id"], 41)
        self.assertEqual(
            result["summary_missing"],
            {
                "reason": "permission_denied",
                "stage": "authority",
                "reasonCode": "stale_generation",
            },
        )
        self.assertEqual(self.methods().count("shared.create"), 1)
        self.assertNotIn("SECRET_CANARY", json.dumps(result))

    def test_failed_open_preserves_safe_execution_phase_and_original_request(self):
        self.make([EDGE])
        original = self.runtime.call
        client_module = native_runtime.load_module(
            PLUGIN.parent / "native-bridge/client.py", "bug_client_"
        )

        def call(method, params):
            if method == "shared.run" and params["action"] == "new_tab":
                raise client_module.BridgeError(
                    "bridge_execution_failed",
                    "SECRET_CANARY",
                    {
                        "stage": "dispatch_journal",
                        "reasonCode": "runtime_error",
                        "outcomeUnknown": True,
                        "retryable": False,
                    },
                )
            return original(method, params)

        self.runtime.call = call
        result = self.open({"url": "https://shop.example/a"})
        self.assertEqual(result["code"], "bridge_execution_failed")
        self.assertEqual(result["stage"], "dispatch_journal")
        self.assertEqual(result["reasonCode"], "runtime_error")
        self.assertEqual(result["request_id"], "call-1")
        self.assertTrue(result["outcome_unknown"])
        self.assertFalse(result["retryable"])
        self.assertNotIn("SECRET_CANARY", json.dumps(result))

    def test_primary_browser_precedes_environment_default(self):
        self.make([{**EDGE, "primary": True}, CHROME])
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": "chrome"}):
            selected = self.open({"url": "https://shop.example/list"})
        self.assertEqual(selected["instance_id"], "edge-1")
        self.make([{**EDGE, "primary": True, "consentStatus": "disabled"}, CHROME])
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": "chrome"}):
            smart = self.open({"url": "https://shop.example/list"})
        self.assertEqual(smart["instance_id"], "edge-1")
        self.assertNotIn("primaryUnavailable", smart)

    def test_remembered_offline_browser_can_start_a_new_task(self):
        offline = {**EDGE, "connected": False, "primary": True, "consentStatus": "unknown"}
        self.make([offline])
        result = self.open({"url": "https://shop.example/list"})
        self.assertEqual(result["instance_id"], "edge-1")
        self.assertEqual(self.methods().count("shared.create"), 1)
        self.make([offline, {**CHROME, "connected": False}])
        result = self.open({"url": "https://shop.example/list", "instance_id": "chrome-1"})
        self.assertEqual(result["instance_id"], "chrome-1")

    def test_offline_launch_failure_reports_no_task(self):
        offline = {**EDGE, "connected": False, "primary": True, "consentStatus": "unknown"}
        self.make([offline])
        original = self.runtime.call
        client_module = native_runtime.load_module(
            PLUGIN.parent / "native-bridge/client.py", "wake_client_"
        )

        def call(method, params):
            if method == "shared.create":
                raise client_module.BridgeError("browser_launch_failed", "failed")
            return original(method, params)

        self.runtime.call = call
        result = self.open({"url": "https://shop.example/list"})
        self.assertEqual(result["code"], "browser_launch_failed")
        self.assertIn("未创建任务", result["error"])
        self.assertNotIn("task_id", result)

    def test_open_receipt_counts_session_pages_and_reminds_above_six(self):
        self.make([CHROME])
        for index in range(7):
            result = self.open({"url": f"https://site-{index}.example/"}, call=f"open-{index}")
        self.assertEqual(result["open_tabs"], 7)
        self.assertEqual(result["tab_hint"], "不再用的网站先 fast_browser_close")

    def test_explicit_instance_overrides_primary_and_offline_primary_falls_back(self):
        self.make([{**EDGE, "primary": True}, CHROME])
        selected = self.open({"url": "https://shop.example/list", "instance_id": "chrome-1"})
        self.assertEqual(selected["instance_id"], "chrome-1")
        self.make([{**EDGE, "connected": False, "primary": True}, CHROME])
        fallback = self.open({"url": "https://shop.example/list"})
        self.assertEqual(fallback["instance_id"], "chrome-1")
        self.assertTrue(fallback["primaryUnavailable"])
        self.make(
            [
                {**EDGE, "connected": False, "primary": True},
                CHROME,
                {
                    "instanceId": "chrome-2",
                    "browser": "chrome",
                    "connected": True,
                    "consentStatus": "enabled",
                },
            ]
        )
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": "chrome-2"}):
            selected = self.open({"url": "https://shop.example/list"})
        self.assertEqual(selected["instance_id"], "chrome-2")
        self.assertTrue(selected["primaryUnavailable"])

    def setUp(self):
        # 中文注释：每个夹具只清空默认浏览器；保留 HOME/TMPDIR，显式配置测试可局部覆盖。
        default_browser = patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": ""})
        default_browser.start()
        self.addCleanup(default_browser.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def make(self, browsers, **options):
        self.runtime = FakeRuntime(Path(self.temp.name) / "auth", browsers, **options)
        self.bridge = integration.HostBindingCoordinator(FakeBridge())
        self.clock = [0.0]
        self.handler = open_tool.make_handler(
            self.runtime,
            self.bridge,
            lease_error=native_runtime.OwnerLeaseError,
            clock=lambda: self.clock[0],
            sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s),
        )

    def open(self, args, call="call-1"):
        hook = self.runtime.authority.pre_tool_call(
            open_tool.TOOL_NAME, args, session_id="session-a", tool_call_id=call
        )
        self.assertEqual(hook["action"], "modify")
        return json.loads(self.handler({**args, **hook["args"]}, session_id="session-a"))

    def methods(self):
        return [method for method, _ in self.runtime.calls]

    def test_incognito_does_not_reuse_normal_task_and_reuses_private_task(self):
        self.make([EDGE])
        normal = self.open({"url": "https://shop.example/a"})
        private = self.open({"url": "https://shop.example/a", "incognito": True}, call="private")
        self.assertNotEqual(normal["task_id"], private["task_id"])
        self.assertTrue(private["incognito"])
        again = self.open({"url": "https://shop.example/b", "incognito": True}, call="private-2")
        self.assertEqual(private["task_id"], again["task_id"])
        regular = self.open({"url": "https://shop.example/b"}, call="normal-2")
        self.assertEqual(normal["task_id"], regular["task_id"])

    def test_single_authorized_browser_creates_binds_and_opens(self):
        self.make([EDGE], ready_after=1)
        result = self.open({"url": "https://shop.example/list?page=1"})
        self.assertEqual(result["tab_id"], 41)
        self.assertEqual(result["origin"], "https://shop.example")
        self.assertEqual(result["instance_id"], "edge-1")
        created = next(p for m, p in self.runtime.calls if m == "shared.create")
        self.assertEqual(created["allowedOrigins"], ["https://shop.example"])
        run = next(p for m, p in self.runtime.calls if m == "shared.run")
        self.assertEqual((run["action"], run["requestId"]), ("new_tab", "call-1"))
        self.assertEqual(self.bridge._bindings["session-a"][1], result["task_id"])

    def test_bound_ready_task_for_the_same_site_is_reused(self):
        self.make([EDGE])
        first = self.open({"url": "https://shop.example/a"})
        second = self.open({"url": "https://shop.example/b"}, call="call-2")
        self.assertEqual(first["task_id"], second["task_id"])
        self.assertEqual(self.methods().count("shared.create"), 1)
        self.assertEqual(first["tab_id"], second["tab_id"])
        self.assertTrue(second["reused"])
        self.assertEqual(self.runtime.calls[-2][1]["action"], "navigate")

    def test_new_task_forces_separate_workspace(self):
        self.make([EDGE])
        first = self.open({"url": "https://shop.example/a", "summary": False})
        second = self.open(
            {"url": "https://shop.example/b", "new_task": True, "summary": False}, call="call-2"
        )
        self.assertNotEqual(first["task_id"], second["task_id"])
        self.assertEqual(self.methods().count("shared.create"), 2)

    def test_other_session_does_not_reuse_same_site_task(self):
        self.make([EDGE])
        first = self.open({"url": "https://shop.example/a", "summary": False})
        args = {"url": "https://shop.example/b", "summary": False}
        hook = self.runtime.authority.pre_tool_call(
            open_tool.TOOL_NAME, args, session_id="session-b", tool_call_id="call-b"
        )
        second = json.loads(self.handler({**args, **hook["args"]}, session_id="session-b"))
        # 中文注释：owner 由可信会话身份生成；同源任务也不能跨会话借用。
        self.assertNotEqual(first["task_id"], second["task_id"])
        self.assertEqual(self.methods().count("shared.create"), 2)

    def test_summary_delivers_the_whole_budgeted_page_without_reread(self):
        self.make([EDGE])
        # 中文注释：底层已按预算分页，二次字符裁剪会迫使首段重读并使原游标跳项。
        items = [
            {
                "ref": "same",
                "role": "text",
                "name": "正文" * 90,
                "fragment": {
                    "field": "name",
                    "start": i * 180,
                    "end": (i + 1) * 180,
                    "total": 1080,
                    "part": i,
                },
            }
            for i in range(6)
        ]
        page = {
            "snapshotId": "s",
            "binding": {"documentId": "d"},
            "items": items,
            "nextCursor": "after-6",
            "coverage": {"complete": False, "returned": 6},
        }
        with patch.object(self.runtime, "call", return_value=page) as call:
            summary = open_tool._summary(self.runtime, "o", "t", 1, "c", "https://shop.example/")
        self.assertEqual(summary["items"], items)
        self.assertEqual(summary["nextCursor"], "after-6")
        self.assertEqual(summary["coverage"], page["coverage"])
        self.assertEqual(call.call_args.args[1]["options"]["budget"], 1400)
        self.assertNotIn("summary_items", summary.get("truncation", []))

    def test_summary_is_bounded_and_can_be_disabled(self):
        self.make([EDGE])
        result = self.open({"url": "https://shop.example/a"})
        self.assertEqual(result["summary"]["snapshotId"], "snap-1")
        # 中文注释：一页预算由引擎保证，投影头另有界；不再用第二个字符/条数上限截断游标页。
        self.assertLessEqual(
            len(json.dumps(result["summary"], ensure_ascii=False)), 1400 * 4 + 1200
        )
        self.assertEqual(len(result["summary"]["items"]), result["summary"]["coverage"]["returned"])
        self.assertTrue(result["summary"]["truncated"])
        without = self.open({"url": "https://shop.example/b", "summary": False}, call="call-2")
        self.assertNotIn("summary", without)

    def test_summary_projection_cannot_skip_fetched_snapshot_items(self):
        self.make([EDGE])
        page = {
            "snapshotId": "snap-1",
            "items": [{"ref": f"r{i}", "role": "text", "name": "正文" * 80} for i in range(20)],
            "nextCursor": "after-all-20",
            "coverage": {"complete": True, "matched": 20, "returned": 20, "omitted": 0},
        }
        with patch.object(self.runtime, "call", return_value=page):
            summary = open_tool._summary(
                self.runtime,
                "owner",
                "task",
                1,
                "call",
                "https://shop.example/a",
                read_intent="content",
                root="#article",
            )
        self.assertEqual(summary["items"], page["items"])
        self.assertEqual(summary["nextCursor"], "after-all-20")
        self.assertTrue(summary["coverage"]["complete"])
        self.assertEqual(summary["coverage"]["returned"], len(summary["items"]))
        self.assertEqual(summary["coverage"]["omitted"], 20 - len(summary["items"]))
        self.assertIn("续读", summary["read_hint"])
        self.assertEqual(page["coverage"]["returned"], 20)
        self.assertTrue(page["coverage"]["complete"])

    def test_unclipped_summary_preserves_fragments_and_continuation_options(self):
        self.make([EDGE])
        for field in ("name", "cells"):
            with self.subTest(field=field):
                fragment = {"field": field, "start": 0, "end": 2, "total": 4, "part": 0}
                item = {"ref": "r", "role": "text", "name": "正文", "fragment": fragment}
                if field == "cells":
                    item.update(name="", cellText="单元")
                    fragment["index"] = 0
                page = {
                    "snapshotId": "snap-1",
                    "items": [{**item, "fragment": {**fragment, "debug": "not-public"}}],
                    "nextCursor": "next",
                    "coverage": {"complete": False, "matched": 1, "returned": 1},
                }
                with patch.object(self.runtime, "call", return_value=page):
                    summary = open_tool._summary(
                        self.runtime,
                        "owner",
                        "task",
                        1,
                        "call",
                        "https://shop.example/a",
                        read_intent="content",
                        root="#article",
                    )
                self.assertEqual(summary["items"], [item])
                self.assertEqual(summary["nextCursor"], "next")
                self.assertEqual(
                    summary["read_options"], {"mode": "content", "budget": 1400, "root": "#article"}
                )

    def test_open_summary_ref_is_usable_without_another_snapshot(self):
        self.make([EDGE])
        opened = self.open({"url": "https://shop.example/a"})
        summary = opened["summary"]
        selected = self.runtime.call(
            "shared.run",
            {
                "owner": "owner",
                "taskId": opened["task_id"],
                "tabId": opened["tab_id"],
                "requestId": "click-1",
                "action": "ref_click",
                "binding": summary["binding"],
                "snapshotId": summary["snapshotId"],
                "ref": summary["items"][0]["ref"],
            },
        )
        self.assertTrue(selected["clicked"])
        self.assertEqual(self.methods().count("shared.run"), 3)

    def test_open_failure_exposes_existing_task_id(self):
        self.make([EDGE])
        original = self.runtime.call

        def fail(method, params):
            if method == "shared.run" and params.get("action") == "new_tab":
                error = RuntimeError("page failed")
                error.code = "page_not_ready"
                error.data = {"outcomeUnknown": False}
                raise error
            return original(method, params)

        self.runtime.call = fail
        failed = self.open({"url": "https://shop.example/a", "summary": False})
        self.assertEqual(failed["task_id"], "task-1")
        self.runtime.call = original
        retried = self.open({"url": "https://shop.example/a", "summary": False}, call="call-2")
        self.assertEqual(retried["task_id"], "task-1")
        self.assertEqual(self.methods().count("shared.create"), 1)

    def test_resume_reuses_the_exact_owned_work_tab(self):
        self.make(
            [EDGE],
            tasks={
                "held": {
                    "id": "held",
                    "state": "ready",
                    "instanceId": "edge-1",
                    "allowedOrigins": ["https://shop.example"],
                    "polls": 0,
                    "workTabs": [{"tabId": 77}],
                    "tabIds": [77],
                }
            },
        )
        self.runtime.tabs["held"] = [{"id": 77, "url": "https://shop.example/resume"}]
        result = self.open({"url": "https://shop.example/resume"})
        self.assertEqual(result["tab_id"], 77)
        self.assertFalse(
            any(
                params.get("action") == "new_tab"
                for method, params in self.runtime.calls
                if method == "shared.run"
            )
        )

    def test_same_url_on_multiple_owned_tabs_requires_selection(self):
        self.make(
            [EDGE],
            tasks={
                "held": {
                    "id": "held",
                    "state": "ready",
                    "instanceId": "edge-1",
                    "allowedOrigins": ["https://shop.example"],
                    "polls": 0,
                    "workTabs": [{"tabId": 77}, {"tabId": 78}],
                    "tabIds": [77, 78],
                }
            },
        )
        self.runtime.tabs["held"] = [
            {"id": 77, "url": "https://shop.example/resume"},
            {"id": 78, "url": "https://shop.example/resume"},
        ]
        result = self.open({"url": "https://shop.example/resume"})
        self.assertEqual(result["code"], "work_tab_choice_required")
        self.assertEqual(result["tab_ids"], [77, 78])
        self.assertFalse(
            any(
                params.get("action") == "new_tab"
                for method, params in self.runtime.calls
                if method == "shared.run"
            )
        )

    def test_paused_task_is_reused_without_opening_another_page(self):
        self.make(
            [EDGE],
            tasks={
                "held": {
                    "id": "held",
                    "state": "paused",
                    "instanceId": "edge-1",
                    "allowedOrigins": ["https://shop.example"],
                    "polls": 0,
                }
            },
        )
        # 中文注释：用户接管时不创建重复任务，也不在人工操作的页面上打开新页。
        result = self.open({"url": "https://shop.example/a"})
        self.assertEqual(result["status"], "task_paused")
        self.assertEqual(result["task_id"], "held")
        self.assertNotIn("shared.create", self.methods())
        self.assertNotIn("shared.run", self.methods())

    def test_a_new_site_gets_its_own_task_and_the_session_moves_to_it(self):
        self.make([EDGE])
        first = self.open({"url": "https://shop.example/a"})
        second = self.open({"url": "https://pay.example/"}, call="call-2")
        self.assertNotEqual(first["task_id"], second["task_id"])
        self.assertEqual(self.bridge._bindings["session-a"][1], second["task_id"])

    def test_several_authorized_browsers_require_a_choice(self):
        self.make([EDGE, CHROME])
        result = self.open({"url": "https://shop.example/"})
        self.assertEqual(result["code"], "browser_choice_required")
        self.assertEqual({row["instance_id"] for row in result["browsers"]}, {"edge-1", "chrome-1"})
        self.assertNotIn("shared.create", self.methods())
        chosen = self.open(
            {"url": "https://shop.example/", "instance_id": "chrome-1"}, call="call-2"
        )
        self.assertEqual(chosen["instance_id"], "chrome-1")

    def test_default_browser_selects_only_unique_enabled_match(self):
        # 中文注释：显式实例优先；未配置或默认值匹配多台时仍要求选择。
        self.make([EDGE, CHROME])
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": "edge"}):
            self.assertEqual(self.open({"url": "https://shop.example/"})["instance_id"], "edge-1")
            self.assertEqual(
                self.open(
                    {"url": "https://shop.example/", "instance_id": "chrome-1"}, call="call-2"
                )["instance_id"],
                "chrome-1",
            )
        self.assertEqual(
            open_tool._pick_browser([EDGE, {**EDGE, "instanceId": "edge-2"}], None, "edge")[1],
            "browser_choice_required",
        )

    def test_nondefault_profile_reads_shared_browser_default(self):
        # 中文注释：模拟 sample-profile 配置目录，进程变量仍高于共享 .env。
        root = Path(self.temp.name) / "hermes"
        (root / "profiles" / "sample-profile").mkdir(parents=True)
        (root / ".env").write_text("FAST_BROWSER_DEFAULT=edge\n")
        self.make([EDGE, CHROME])
        self.runtime.bridge_home = root
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": ""}):
            self.assertEqual(self.open({"url": "https://shop.example/"})["instance_id"], "edge-1")
        with patch.dict(os.environ, {"FAST_BROWSER_DEFAULT": "chrome"}):
            self.assertEqual(
                self.open({"url": "https://shop.example/", "instance_id": "edge-1"}, call="call-2")[
                    "instance_id"
                ],
                "edge-1",
            )

    def test_redirected_open_returns_final_origin_without_unknown_outcome(self):
        # 中文注释：跨站跳转已确定拒绝，工具只返回来源供新任务使用。
        self.make([EDGE])
        original = self.runtime.call

        class Redirected(Exception):
            code = "redirected_out_of_scope"
            data = {"outcomeUnknown": False, "finalOrigin": "https://other.test"}

        def redirected(method, params):
            if method == "shared.run" and params.get("action") == "new_tab":
                raise Redirected("private path /token")
            return original(method, params)

        self.runtime.call = redirected
        result = self.open({"url": "https://shop.example/"})
        self.assertEqual(result["code"], "redirected_out_of_scope")
        self.assertEqual(result["final_origin"], "https://other.test")
        self.assertFalse(result["outcome_unknown"])
        self.assertNotIn("private path", json.dumps(result))

    def test_unauthorized_task_reports_waiting_instead_of_opening(self):
        self.make([{**EDGE, "consentStatus": "disabled"}], ready_after=10_000)
        result = self.open({"url": "https://shop.example/"})
        self.assertEqual(result["status"], "awaiting_authorization")
        self.assertNotIn("shared.run", self.methods())

    def test_task_stopped_while_waiting_is_not_reported_as_awaiting_authorization(self):
        # 中文注释：批准等待中发生停止、断线或拒绝时，工具不能再让 agent 等待一个已失效的任务。
        for state in ("cancelled", "closed", "failed", "needs_sync"):
            with self.subTest(state=state):
                self.make([EDGE], ready_after=999)
                original = self.runtime.call

                def call(method, params):
                    result = original(method, params)
                    if method == "shared.get":
                        result["state"] = state
                    return result

                self.runtime.call = call
                result = self.open({"url": "https://shop.example/"})
                self.assertEqual(result.get("code"), "task_not_ready")
                self.assertEqual(result["state"], state)
                self.assertNotIn("shared.run", self.methods())
        self.assertNotIn("session-a", self.bridge._bindings)

    def test_waiting_task_is_reused_after_authorization(self):
        # 授权等待和后续重试必须指向同一任务，避免重复创建与重复授权。
        self.make([{**EDGE, "consentStatus": "disabled"}], ready_after=10_000)
        first = self.open({"url": "https://shop.example/"})
        waiting = self.open({"url": "https://shop.example/"}, call="call-2")
        self.assertEqual(first["task_id"], waiting["task_id"])
        self.assertEqual(self.methods().count("shared.create"), 1)
        self.runtime.tasks[first["task_id"]]["state"] = "ready"
        opened = self.open({"url": "https://shop.example/"}, call="call-3")
        self.assertEqual(opened["task_id"], first["task_id"])
        self.assertEqual(self.methods().count("shared.create"), 1)

    def test_invalid_urls_are_refused_before_any_call(self):
        self.make([EDGE])
        for url in ("file:///etc/passwd", "https://user:pw@shop.example/", "not a url"):
            with self.subTest(url=url):
                self.assertEqual(self.open({"url": url}, call=url)["code"], "invalid_url")
        self.assertEqual(self.runtime.calls, [])

    def test_confirmation_needed_returns_the_request_to_query(self):
        self.make([EDGE], run_status="approval_required")
        result = self.open({"url": "https://shop.example/"}, call="call-7")
        self.assertEqual(result["status"], "approval_required")
        self.assertEqual(result["request_id"], "call-7")


class OpenToolEnvironmentTests(unittest.TestCase):
    def test_suite_is_independent_of_parent_default_browser(self):
        # 中文注释：子进程只选原有 23 个用例，排除此回归类，避免递归运行整个 suite。
        argv = [sys.executable, "-m", "unittest", "test_open_tool.OpenToolTests", "-v"]
        for default in ("edge", "chrome", "", None):
            with self.subTest(default=default):
                env = dict(os.environ)
                if default is None:
                    env.pop("FAST_BROWSER_DEFAULT", None)
                else:
                    env["FAST_BROWSER_DEFAULT"] = default
                child = subprocess.run(
                    argv,
                    cwd=Path(__file__).resolve().parent,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                output = child.stdout + child.stderr
                self.assertEqual(child.returncode, 0, output)
                self.assertIn(
                    f"Ran {unittest.defaultTestLoader.loadTestsFromTestCase(OpenToolTests).countTestCases()} tests",
                    output,
                )
                self.assertNotIn("skipped=", output)
                self.assertIn("test_default_browser_selects_only_unique_enabled_match", output)


if __name__ == "__main__":
    unittest.main()
