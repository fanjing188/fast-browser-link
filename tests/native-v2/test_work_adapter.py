"""真实 BridgeDaemon 状态和账本 + 合成扩展；不启动个人浏览器。"""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
import copy
import json
import socket
import subprocess
import threading

ROOT = Path(os.environ.get("FBL_WORK_TEST_ROOT", Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(ROOT / "native-bridge"))
from daemon import BridgeDaemon, ProtocolError

PRODUCT = "a" * 32
SESSION = "port-session-opaque"
URL = "https://fixture.test/work"


class WorkAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="work-", dir=os.environ["TMPDIR"])
        self.addCleanup(self.temp.cleanup)

    def make_daemon(self):
        self.assertIsNotNone(importlib.util.find_spec("core_adapter"), "CoreAdapter is missing")
        from core_adapter import CoreAdapter

        self.daemon = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        self.daemon._prepare_data_dir()
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon._notify_tasks_changed = lambda _: None
        self.extension = {
            "instanceId": "fixture",
            "browser": "chrome",
            "connectionGeneration": "c1",
        }
        self.daemon.extensions["fixture"] = self.extension
        self.calls = []
        self.daemon._extension_call = self.browser
        return self.daemon

    def rpc(self, method, **params):
        return self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.assist.work." + method,
            {"productId": PRODUCT, "session": SESSION, **params},
        )

    def browser(self, extension, method, params, **kwargs):
        self.calls.append((method, dict(params)))
        if method == "browser.execute":
            from work_adapter import FIELD_MATCH

            if params.get("expression") == FIELD_MATCH:
                return {"data": {"matches": True}}
            return {"tabId": 17} if params["action"] == "new_tab" else {"status": "confirmed"}
        if method == "browser.assess":
            return {"targetAssessment": "ordinary"}
        if method == "browser.release":
            return {
                "released": True,
                "cleanupState": "succeeded",
                "remainingTabIds": [],
                "preservedTabIds": [],
                "unknownTabIds": [],
            }
        raise AssertionError(method)

    def open_work(self, ready=True):
        self.make_daemon()
        resource = self.rpc(
            "resource_bind", resourceId="r1", epoch=1, lane="reports", hosts=["fixture.test"]
        )
        opened = self.rpc(
            "open", url=URL, incognito=False, resourceHandle=resource["resourceHandle"]
        )
        if ready:
            self.daemon._dispatch_connected_extension(
                self.extension,
                "extension.approve",
                {
                    "taskId": opened["taskId"],
                    "generation": 1,
                    "tabIds": [],
                    "workspaceOnly": True,
                    "allowedOrigins": ["https://fixture.test"],
                },
            )
            self.daemon._dispatch_connected_extension(
                self.extension,
                "extension.mode",
                {"taskId": opened["taskId"], "generation": 1, "modeGeneration": 1, "mode": "full"},
            )
            opened = self.rpc("get", workHandle=opened["workHandle"])
        return opened, resource

    def work_run(self, opened, request_id="op", operation="snapshot", arguments=None):
        return self.rpc(
            "run",
            workHandle=opened["workHandle"],
            requestId=request_id,
            operation=operation,
            arguments={} if arguments is None else arguments,
        )

    def test_local_snapshot_options_reach_existing_semantic_executor_unchanged(self):
        opened, _ = self.open_work()
        options = {
            "root": "main",
            "mode": "content",
            "query": "fixture",
            "roles": ["paragraph"],
            "viewport": True,
            "composed": True,
            "accessibility": False,
            "budget": 1200,
        }
        self.work_run(opened, "local-snapshot", "snapshot", {"options": options})
        command = self.calls[-1][1]
        self.assertEqual(command["action"], "semantic_snapshot")
        self.assertEqual(command["tabId"], 17)
        self.assertEqual(command["options"], options)
        before = len(self.calls)
        self.work_run(opened, "local-snapshot", "snapshot", {"options": options})
        self.assertEqual(len(self.calls), before)

    def test_local_snapshot_invalid_options_never_reach_extension(self):
        opened, _ = self.open_work()
        for index, options in enumerate(
            [
                None,
                [],
                {"frameToken": "foreign"},
                {"cursor": "foreign"},
                {"baselineId": "foreign"},
                {"root": ""},
                {"root": " "},
                {"root": "\ufeff"},
                {"roles": ["\ufeff"]},
                {"budget": True},
                {"budget": 511},
                {"budget": 6001},
                {"query": "bad\nquery"},
                {"query": "😀" * 501},
                {"root": "😀" * 2049},
                {"roles": ["😀" * 41]},
                {"mode": "html"},
                {"viewport": 1},
                {"roles": "button"},
                {"roles": [1]},
                {"roles": ["button"] * 33},
                {"accessibility": True},
                {"root": "main", "mode": "content", "accessibility": True},
            ]
        ):
            with self.subTest(options=options):
                before = len(self.calls)
                with self.assertRaises(ProtocolError):
                    self.work_run(
                        opened, "invalid-snapshot-" + str(index), "snapshot", {"options": options}
                    )
                self.assertEqual(len(self.calls), before)

    def test_native_snapshot_accepts_only_well_formed_optional_internal_binding(self):
        params = {
            "tabId": 17,
            "options": {"mode": "content", "cursor": "native-cursor"},
            "binding": {"taskId": "task", "documentId": "loader", "leaseId": "lease"},
        }
        BridgeDaemon._validate_run_params("semantic_snapshot", params)
        for binding in (
            None,
            [],
            {"taskId": "task", "documentId": "loader"},
            {"taskId": "task", "documentId": "loader", "leaseId": 7},
            {**params["binding"], "tabId": 17},
        ):
            with self.subTest(binding=binding), self.assertRaises(ProtocolError):
                BridgeDaemon._validate_run_params(
                    "semantic_snapshot", {**params, "binding": binding}
                )

    def test_snapshot_delta_reuses_owned_baseline_options_binding_and_native_ledger(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        binding = {"taskId": opened["taskId"], "documentId": "doc", "leaseId": "lease"}
        options = {"root": "main", "mode": "content", "budget": 1200}

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, copy.deepcopy(params)))
                delta = "baselineId" in params.get("options", {})
                if delta:
                    self.assertEqual(params["options"], {**options, "baselineId": "s1"})
                    self.assertEqual(params["binding"], binding)
                return {
                    "binding": binding,
                    "snapshotId": "s2" if delta else "s1",
                    "kind": "delta" if delta else "full",
                    **(
                        {"baselineId": "s1", "removed": ["gone"], "order": ["keep"]}
                        if delta
                        else {}
                    ),
                    "items": [] if delta else [{"ref": "keep"}, {"ref": "gone"}],
                    "nextCursor": None,
                    "coverage": {"complete": False},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = page
        first = self.work_run(opened, "base", "snapshot", {"options": options})
        delta = self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]})
        self.assertEqual(delta["kind"], "delta")
        self.assertEqual(delta["baselineId"], first["snapshotId"])
        self.assertEqual(delta["removed"], ["gone"])
        self.assertEqual(delta["order"], ["keep"])
        self.assertFalse(delta["coverage"]["complete"])
        before = len(self.calls)
        self.assertEqual(
            self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]}), delta
        )
        self.assertEqual(len(self.calls), before)
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "stale", "snapshot", {"baseline": first["snapshotId"]})
        self.assertEqual(len(self.calls), before)

    def test_snapshot_empty_delta_with_cursor_preserves_progress_without_latching_unknown(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        binding = {"taskId": opened["taskId"], "documentId": "doc", "leaseId": "lease"}

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, copy.deepcopy(params)))
                options = params.get("options", {})
                if "baselineId" in options:
                    self.assertEqual(options["baselineId"], "s1")
                    return {
                        "binding": binding,
                        "snapshotId": "s2",
                        "kind": "delta",
                        "baselineId": "s1",
                        "items": [],
                        "removed": [],
                        "order": ["one"],
                        "nextCursor": "native-next",
                        "coverage": {"complete": False},
                    }
                continued = "cursor" in options
                return {
                    "binding": binding,
                    "snapshotId": "s3" if continued else "s1",
                    "kind": "full",
                    "items": [{"ref": "two" if continued else "one"}],
                    "nextCursor": None if continued else "native-first",
                    "coverage": {"complete": False},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = page
        first = self.work_run(opened, "base", "snapshot", {"options": {"budget": 1200}})
        delta = self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]})
        self.assertEqual(delta["items"], [])
        self.assertEqual(delta["order"], ["one"])
        self.assertNotEqual(delta["nextCursor"], "native-next")
        self.assertFalse(self.daemon.tasks[opened["taskId"]].get("workUnknownLatched"))
        before = len(self.calls)
        self.assertEqual(
            self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]}), delta
        )
        self.assertEqual(len(self.calls), before)
        tail = self.work_run(opened, "tail", "snapshot", {"continuation": delta["nextCursor"]})
        self.assertEqual(tail["items"], [{"ref": "two"}])
        self.assertIsNone(tail["nextCursor"])
        self.assertFalse(tail["coverage"]["complete"])
        self.assertFalse(self.daemon.tasks[opened["taskId"]].get("workUnknownLatched"))

    def test_snapshot_empty_delta_cursor_rejects_malformed_progress(self):
        for invalid in (
            {"order": []},
            {"order": [None]},
            {"removed": [None]},
            {"baselineId": "foreign"},
            {"kind": "full"},
        ):
            with self.subTest(invalid=invalid):
                opened, _ = self.open_work()
                original = self.daemon._extension_call
                binding = {"taskId": opened["taskId"], "documentId": "doc", "leaseId": "lease"}

                def page(extension, method, params, **kwargs):
                    if method == "browser.execute" and params["action"] == "semantic_snapshot":
                        if "baselineId" in params.get("options", {}):
                            return {
                                "binding": binding,
                                "snapshotId": "s2",
                                "kind": "delta",
                                "baselineId": "s1",
                                "items": [],
                                "order": ["one"],
                                "removed": [],
                                "nextCursor": "native",
                                **invalid,
                            }
                        return {
                            "binding": binding,
                            "snapshotId": "s1",
                            "items": [{"ref": "one"}],
                            "nextCursor": None,
                        }
                    return original(extension, method, params, **kwargs)

                self.daemon._extension_call = page
                first = self.work_run(opened, "base", "snapshot", {})
                with self.assertRaises(ProtocolError):
                    self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]})
                self.assertTrue(self.daemon.tasks[opened["taskId"]]["workUnknownLatched"])
                self.assertNotIn(
                    "snapshotContinuation",
                    self.daemon.optional_service.work.works[opened["workHandle"]],
                )

    def test_snapshot_delta_late_mode_revocation_never_publishes_a_new_baseline(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        binding = {"taskId": opened["taskId"], "documentId": "doc", "leaseId": "lease"}

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                return {
                    "binding": binding,
                    "snapshotId": "s2" if "baselineId" in params.get("options", {}) else "s1",
                    "items": [{"ref": "one"}],
                    "nextCursor": None,
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = page
        first = self.work_run(opened, "base", "snapshot", {})
        finish = self.daemon._finish_ui_operation

        def revoke(params, *args, **kwargs):
            finish(params, *args, **kwargs)
            task = self.daemon.tasks[opened["taskId"]]
            for mode in ("smart", "full"):
                self.daemon._dispatch_connected_extension(
                    self.extension,
                    "extension.mode",
                    {
                        "taskId": task["id"],
                        "generation": task["generation"],
                        "modeGeneration": task["modeGeneration"],
                        "mode": mode,
                    },
                )

        self.daemon._finish_ui_operation = revoke
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]})
        work = self.daemon.optional_service.work.works[opened["workHandle"]]
        self.assertNotIn("snapshotBaseline", work)
        self.assertNotIn("snapshotReply", work)
        self.assertNotIn("snapshotContinuation", work)

    def test_snapshot_baseline_does_not_survive_mode_reenable_or_another_operation(self):
        for invalidation in ("mode", "navigate", "continuation", "accessibility"):
            with self.subTest(invalidation=invalidation):
                opened, _ = self.open_work()
                original = self.daemon._extension_call
                binding = {"taskId": opened["taskId"], "documentId": "doc", "leaseId": "lease"}

                def page(extension, method, params, **kwargs):
                    if method == "browser.execute" and params["action"] == "semantic_snapshot":
                        self.calls.append((method, copy.deepcopy(params)))
                        return {
                            "binding": binding,
                            "snapshotId": "s1",
                            "items": [{"ref": "one"}],
                            "nextCursor": "cursor"
                            if invalidation == "continuation"
                            and not params.get("options", {}).get("cursor")
                            else None,
                        }
                    return original(extension, method, params, **kwargs)

                self.daemon._extension_call = page
                args = (
                    {"options": {"root": "main", "accessibility": True}}
                    if invalidation == "accessibility"
                    else {}
                )
                first = self.work_run(opened, "base", "snapshot", args)
                if invalidation == "mode":
                    task = self.daemon.tasks[opened["taskId"]]
                    for mode in ("smart", "full"):
                        self.daemon._dispatch_connected_extension(
                            self.extension,
                            "extension.mode",
                            {
                                "taskId": task["id"],
                                "generation": task["generation"],
                                "modeGeneration": task["modeGeneration"],
                                "mode": mode,
                            },
                        )
                elif invalidation == "navigate":
                    self.work_run(opened, "navigate", "navigate", {"url": URL})
                elif invalidation == "continuation":
                    self.work_run(opened, "next", "snapshot", {"continuation": first["nextCursor"]})
                before = len(self.calls)
                with self.assertRaises(ProtocolError):
                    self.work_run(opened, "delta", "snapshot", {"baseline": first["snapshotId"]})
                self.assertEqual(len(self.calls), before)

    def test_snapshot_delta_rejects_foreign_mixed_and_malformed_baseline_before_dispatch(self):
        opened, _ = self.open_work()
        before = len(self.calls)
        for i, args in enumerate(
            (
                {"baseline": "foreign"},
                {"baseline": ""},
                {"baseline": "bad\nbase"},
                {"baseline": "s", "options": {}},
                {"baseline": "s", "continuation": "c"},
                {"baselineId": "native"},
                {"baseline": "s", "binding": {}},
            )
        ):
            with self.subTest(args=args), self.assertRaises(ProtocolError):
                self.work_run(opened, "bad-" + str(i), "snapshot", args)
            self.assertEqual(len(self.calls), before)

    def test_snapshot_continuation_is_work_bound_and_keeps_native_fragment_coverage(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        binding = {"taskId": opened["taskId"], "documentId": "loader-a", "leaseId": "lease-a"}
        options = {"root": "main", "mode": "content", "budget": 1200}

        def paged(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, copy.deepcopy(params)))
                continued = "cursor" in params.get("options", {})
                if continued:
                    self.assertEqual(params["options"], {**options, "cursor": "native-only"})
                    self.assertEqual(params["binding"], binding)
                return {
                    "version": 2,
                    "binding": binding,
                    "snapshotId": "s2" if continued else "s1",
                    "items": [
                        {
                            "ref": "node",
                            "fragment": {"start": 50 if continued else 0, "end": 100, "total": 100},
                        }
                    ],
                    "nextCursor": None if continued else "native-only",
                    "resync": None,
                    "coverage": {"complete": False, "offset": 1 if continued else 0},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = paged
        first = self.work_run(opened, "page-first", "snapshot", {"options": options})
        cursor = first["nextCursor"]
        self.assertIsInstance(cursor, str)
        self.assertNotEqual(cursor, "native-only")
        before = len(self.calls)
        self.assertEqual(
            self.work_run(opened, "page-first", "snapshot", {"options": options}), first
        )
        self.assertEqual(len(self.calls), before)
        for index, invalid in enumerate(
            (
                {"continuation": "native-only"},
                {"continuation": cursor, "options": options},
                {"continuation": cursor, "binding": binding},
            )
        ):
            with self.subTest(arguments=invalid), self.assertRaises(ProtocolError):
                self.work_run(opened, "bad-page-" + str(index), "snapshot", invalid)
            self.assertEqual(len(self.calls), before)
        second = self.work_run(opened, "page-next", "snapshot", {"continuation": cursor})
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(second["items"][0]["fragment"]["start"], 50)
        self.assertFalse(second["coverage"]["complete"])
        self.assertEqual(second["coverage"]["offset"], 1)
        before = len(self.calls)
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "old-page", "snapshot", {"continuation": cursor})
        self.assertEqual(len(self.calls), before)

    def test_snapshot_late_receipt_is_not_published_after_resource_revoke(self):
        opened, resource = self.open_work()
        original = self.daemon._extension_call
        finish = self.daemon._finish_ui_operation

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                return {
                    "binding": {
                        "taskId": opened["taskId"],
                        "documentId": "doc",
                        "leaseId": "lease",
                    },
                    "items": [{"ref": "one"}],
                    "nextCursor": "native",
                }
            return original(extension, method, params, **kwargs)

        def revoke_during_finish(params, *args, **kwargs):
            finish(params, *args, **kwargs)
            if params.get("action") == "semantic_snapshot":
                self.rpc("resource_revoke", resourceHandle=resource["resourceHandle"])

        self.daemon._extension_call = page
        self.daemon._finish_ui_operation = revoke_during_finish
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "late-read", "snapshot", {})
        work = self.daemon.optional_service.work.works[opened["workHandle"]]
        self.assertNotIn("snapshotContinuation", work)
        self.assertNotIn("snapshotReply", work)

    def test_snapshot_late_mode_revoke_blocks_fresh_and_cached_receipt_even_after_reenable(self):
        for cached, reenable in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(cached=cached, reenable=reenable):
                opened, _ = self.open_work()
                original = self.daemon._extension_call
                finish = self.daemon._finish_ui_operation

                def page(extension, method, params, **kwargs):
                    if method == "browser.execute" and params["action"] == "semantic_snapshot":
                        self.calls.append((method, copy.deepcopy(params)))
                        return {
                            "binding": {
                                "taskId": opened["taskId"],
                                "documentId": "doc",
                                "leaseId": "lease",
                            },
                            "items": [{"ref": "one"}],
                            "nextCursor": "native",
                        }
                    return original(extension, method, params, **kwargs)

                self.daemon._extension_call = page
                if cached:
                    self.work_run(opened, "read", "snapshot", {})
                before = len(self.calls)

                def change_mode_after_finish(params, *args, **kwargs):
                    finish(params, *args, **kwargs)
                    if params.get("action") != "semantic_snapshot":
                        return
                    task = self.daemon.tasks[opened["taskId"]]
                    for mode in ["smart", "full"] if reenable else ["smart"]:
                        self.daemon._dispatch_connected_extension(
                            self.extension,
                            "extension.mode",
                            {
                                "taskId": task["id"],
                                "generation": task["generation"],
                                "modeGeneration": task["modeGeneration"],
                                "mode": mode,
                            },
                        )

                self.daemon._finish_ui_operation = change_mode_after_finish
                with self.assertRaises(ProtocolError):
                    self.work_run(opened, "read", "snapshot", {})
                work = self.daemon.optional_service.work.works[opened["workHandle"]]
                self.assertNotIn("snapshotContinuation", work)
                self.assertNotIn("snapshotReply", work)
                if cached:
                    self.assertEqual(len(self.calls), before)

    def test_malformed_page_unknown_is_durable_after_confirmed_snapshot_flushed(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        finish = self.daemon._finish_ui_operation

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                return {
                    "binding": {
                        "taskId": opened["taskId"],
                        "documentId": "doc",
                        "leaseId": "lease",
                    },
                    "items": [],
                    "nextCursor": "native",
                }
            return original(extension, method, params, **kwargs)

        def flush_confirmed_before_adapter(params, *args, **kwargs):
            finish(params, *args, **kwargs)
            if params.get("action") == "semantic_snapshot":
                self.daemon._flush_tasks()
                saved = json.loads(self.daemon.tasks_path.read_text())
                entry = next(t for t in saved["tasks"] if t["id"] == opened["taskId"])
                self.assertEqual(entry["requestHistory"][-1]["state"], "confirmed")

        self.daemon._extension_call = page
        self.daemon._finish_ui_operation = flush_confirmed_before_adapter
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "malformed", "snapshot", {})
        saved = json.loads(self.daemon.tasks_path.read_text())
        entry = next(t for t in saved["tasks"] if t["id"] == opened["taskId"])
        self.assertTrue(entry["workUnknownLatched"])
        self.assertEqual(entry["requestHistory"][-1]["state"], "unknown")

    def test_nonempty_malformed_page_items_never_issue_token(self):
        for items in ([None], [{}], [{"ref": None}], [{"ref": ""}]):
            with self.subTest(items=items):
                opened, _ = self.open_work()
                original = self.daemon._extension_call

                def page(extension, method, params, **kwargs):
                    if method == "browser.execute" and params["action"] == "semantic_snapshot":
                        return {
                            "binding": {
                                "taskId": opened["taskId"],
                                "documentId": "doc",
                                "leaseId": "lease",
                            },
                            "items": items,
                            "nextCursor": "native",
                        }
                    return original(extension, method, params, **kwargs)

                self.daemon._extension_call = page
                with self.assertRaises(ProtocolError) as caught:
                    self.work_run(opened, "malformed", "snapshot", {})
                self.assertTrue(caught.exception.data["outcomeUnknown"])
                self.assertNotIn(
                    "snapshotContinuation",
                    self.daemon.optional_service.work.works[opened["workHandle"]],
                )

    def test_snapshot_continuation_cannot_cross_works_or_survive_reconnect(self):
        opened, resource = self.open_work()
        original = self.daemon._extension_call

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, copy.deepcopy(params)))
                return {
                    "binding": {
                        "taskId": opened["taskId"],
                        "documentId": "doc",
                        "leaseId": "lease",
                    },
                    "items": [{"ref": "one"}],
                    "nextCursor": "native",
                    "coverage": {"complete": False},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = page
        cursor = self.work_run(opened, "first", "snapshot", {})["nextCursor"]
        other_resource = self.rpc(
            "resource_bind", resourceId="r2", epoch=2, lane="other", hosts=["other.test"]
        )
        other = self.rpc(
            "open",
            url="https://other.test/",
            incognito=False,
            resourceHandle=other_resource["resourceHandle"],
        )
        before = len(self.calls)
        with self.assertRaises(ProtocolError):
            self.work_run(other, "cross-work", "snapshot", {"continuation": cursor})
        self.assertEqual(len(self.calls), before)
        old = self.extension
        self.extension = {**old, "connectionGeneration": "c2"}
        self.daemon.extensions["fixture"] = self.extension
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "after-reconnect", "snapshot", {"continuation": cursor})
        self.assertEqual(len(self.calls), before)

    def test_snapshot_local_accessibility_partial_result_does_not_offer_unusable_cursor(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call

        def page(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                return {
                    "binding": {
                        "taskId": opened["taskId"],
                        "documentId": "doc",
                        "leaseId": "lease",
                    },
                    "items": [{"ref": "one"}],
                    "nextCursor": "native",
                    "resync": None,
                    "coverage": {"complete": False, "axOmitted": 1},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = page
        value = self.work_run(
            opened, "ax", "snapshot", {"options": {"root": "main", "accessibility": True}}
        )
        self.assertIsNone(value["nextCursor"])
        self.assertFalse(value["coverage"]["complete"])
        self.assertEqual(value["coverage"]["axOmitted"], 1)
        self.assertEqual(value["resync"]["reason"], "accessibility_pagination_unavailable")

    def test_snapshot_continuation_rejects_foreign_work_and_unknown_does_not_replay(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call

        def pages(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, copy.deepcopy(params)))
                if "cursor" in params.get("options", {}):
                    raise ProtocolError("extension_timeout", "synthetic lost page receipt")
                return {
                    "binding": {
                        "taskId": opened["taskId"],
                        "documentId": "doc",
                        "leaseId": "lease",
                    },
                    "items": [{"ref": "one"}],
                    "nextCursor": "native",
                    "coverage": {"complete": False},
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = pages
        first = self.work_run(opened, "first", "snapshot", {})
        cursor = first["nextCursor"]
        before = len(self.calls)
        with self.assertRaises(ProtocolError):
            self.rpc(
                "run",
                workHandle=opened["workHandle"],
                session="other-session",
                requestId="foreign",
                operation="snapshot",
                arguments={"continuation": cursor},
            )
        self.assertEqual(len(self.calls), before)
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "next", "snapshot", {"continuation": cursor})
        sent = len(self.calls)
        task = self.daemon.tasks[opened["taskId"]]
        self.assertTrue(task["workOutcomeUnknown"])
        for request in ("next", "replacement"):
            with self.assertRaises(ProtocolError):
                self.work_run(opened, request, "snapshot", {"continuation": cursor})
            self.assertEqual(len(self.calls), sent)

    def test_snapshot_resync_and_no_progress_do_not_issue_continuation(self):
        for kind in ("resync", "empty"):
            with self.subTest(kind=kind):
                opened, _ = self.open_work()
                original = self.daemon._extension_call

                def pages(extension, method, params, **kwargs):
                    if method == "browser.execute" and params["action"] == "semantic_snapshot":
                        self.calls.append((method, copy.deepcopy(params)))
                        return {
                            "binding": {
                                "taskId": opened["taskId"],
                                "documentId": "doc",
                                "leaseId": "lease",
                            },
                            "items": [] if kind == "empty" else [{"ref": "one"}],
                            "nextCursor": "native",
                            "resync": {"reason": "cursor_invalidated"}
                            if kind == "resync"
                            else None,
                            "coverage": {"complete": False},
                        }
                    return original(extension, method, params, **kwargs)

                self.daemon._extension_call = pages
                if kind == "empty":
                    with self.assertRaises(ProtocolError) as caught:
                        self.work_run(opened, "read", "snapshot", {})
                    self.assertTrue(caught.exception.data["outcomeUnknown"])
                    # 中文注释：畸形续读资格使已确认的只读动作也封住资源，重启不得洗掉未知。
                    from core_adapter import CoreAdapter

                    restarted = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
                    restarted._load_tasks()
                    self.addCleanup(restarted._flush_tasks)
                    self.assertTrue(restarted.tasks[opened["taskId"]]["workUnknownLatched"])
                else:
                    result = self.work_run(opened, "read", "snapshot", {})
                    self.assertIsNone(result["nextCursor"])
                    self.assertEqual(result["resync"], {"reason": "cursor_invalidated"})
                    self.assertFalse(result["coverage"]["complete"])
                self.assertNotIn(
                    "snapshotContinuation",
                    self.daemon.optional_service.work.works[opened["workHandle"]],
                )

    def test_open_private_silent_full_consent_and_native_ledger_initial_tab(self):
        opened, _ = self.open_work(ready=False)
        task = self.daemon.tasks[opened["taskId"]]
        self.assertTrue(task["silent"])
        self.assertEqual(task["executionLane"], "product_work")
        self.assertEqual(task["workProductId"], PRODUCT)
        self.assertEqual(task["workSession"], SESSION)
        self.assertEqual(opened["state"], "pending_approval")
        self.assertEqual(self.calls, [])
        self.assertNotIn("owner", opened)
        self.assertEqual(self.daemon._dispatch_client("shared.list", {"owner": task["owner"]}), [])
        with self.assertRaises(ProtocolError):
            self.daemon._owned_task({"owner": task["owner"], "taskId": task["id"]})
        self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.approve",
            {
                "taskId": task["id"],
                "generation": 1,
                "tabIds": [],
                "workspaceOnly": True,
                "allowedOrigins": task["allowedOrigins"],
            },
        )
        self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.mode",
            {"taskId": task["id"], "generation": 1, "modeGeneration": 1, "mode": "full"},
        )
        ready = self.rpc("get", workHandle=opened["workHandle"])
        self.assertEqual(ready["tabIds"], [17])
        self.assertEqual(task["requestHistory"][0]["action"], "new_tab")
        self.rpc("get", workHandle=opened["workHandle"])
        self.assertEqual(len(self.calls), 1)

    def test_run_ledger_cache_close_and_no_shared_bypass(self):
        opened, _ = self.open_work()
        self.assertEqual(self.work_run(opened)["status"], "confirmed")
        self.work_run(opened)
        self.assertEqual(len(self.calls), 2)
        task = self.daemon.tasks[opened["taskId"]]
        self.assertEqual(task["requestHistory"][-1]["state"], "confirmed")
        with self.assertRaises(ProtocolError):
            self.daemon._run_task(
                {
                    "owner": task["owner"],
                    "taskId": task["id"],
                    "requestId": "bypass",
                    "action": "semantic_snapshot",
                    "tabId": 17,
                }
            )
        closed = self.rpc("close", workHandle=opened["workHandle"], requestId="close")
        self.assertEqual(closed["state"], "closed")
        self.assertEqual(closed["cleanupState"], "succeeded")

    def test_named_readers_use_fixed_expression_arguments_and_reject_source(self):
        opened, _ = self.open_work()
        options = {"minimumRows": 1, "headers": ["Keyword"], "selectors": []}
        self.work_run(opened, operation="tables_read", arguments=options)
        sent = self.calls[-1][1]
        self.assertEqual(sent["action"], "js.evaluate")
        self.assertEqual(
            sent["expression"],
            "async argument=>{const m=await import('chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/product-tables.mjs');return m.captureTables(document,argument)}",
        )
        self.assertEqual(sent["arguments"], options)
        for operation, args in [
            ("js.evaluate", {"expression": "bad"}),
            ("tables_read", {**options, "expression": "bad"}),
            ("click", {"selector": "button", "tabId": 999}),
        ]:
            with self.subTest(operation=operation), self.assertRaises(ProtocolError):
                self.work_run(opened, "bad", operation, args)

    def test_unknown_write_monotonic_across_new_request_close_resource_and_restart(self):
        opened, resource = self.open_work()
        original = self.daemon._extension_call

        def unknown(extension, method, params, **kwargs):
            if method == "browser.execute":
                raise ProtocolError("extension_timeout", "untrusted raw error")
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = unknown
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "write", "click", {"selector": "button"})
        task = self.daemon.tasks[opened["taskId"]]
        self.assertTrue(task["workOutcomeUnknown"])
        self.assertEqual(task["requestHistory"][-1]["state"], "unknown")
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "replacement", "click", {"selector": "button"})
        self.rpc("close", workHandle=opened["workHandle"], requestId="close")
        with self.assertRaises(ProtocolError):
            self.rpc("open", url=URL, incognito=False, resourceHandle=resource["resourceHandle"])
        with self.assertRaises(ProtocolError):
            self.rpc(
                "resource_bind",
                session="new",
                resourceId="new",
                epoch=2,
                lane="new",
                hosts=["fixture.test"],
            )
        self.daemon._flush_tasks()
        from core_adapter import CoreAdapter

        restarted = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        restarted._load_tasks()
        self.addCleanup(restarted._flush_tasks)
        restarted.extensions["fixture"] = self.extension
        with self.assertRaises(ProtocolError):
            restarted._dispatch_connected_extension(
                self.extension,
                "extension.assist.work.resource_bind",
                {
                    "productId": PRODUCT,
                    "session": "new",
                    "resourceId": "new",
                    "epoch": 3,
                    "lane": "new",
                    "hosts": ["fixture.test"],
                },
            )

    def test_old_disk_snapshot_and_new_dispatched_journal_restore_unknown_after_cleanup(self):
        opened, _ = self.open_work()
        d = self.daemon
        task = d.tasks[opened["taskId"]]
        d._flush_tasks()
        snapshot = d.tasks_path.read_bytes()
        # 真正写 journal 并 fsync，不先刷新 snapshot；模拟派发后断电。
        entry = {
            "requestIdHash": "a" * 64,
            "payloadHash": "b" * 64,
            "state": "dispatched",
            "dispatched": True,
            "action": "click",
        }
        d._persist_dispatched(task, entry)
        self.assertEqual(d.tasks_path.read_bytes(), snapshot)
        self.assertIn(b"dispatched", d.journal_path.read_bytes())
        from core_adapter import CoreAdapter

        restarted = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        restarted._load_tasks()
        self.addCleanup(restarted._flush_tasks)
        restored = restarted.tasks[task["id"]]
        self.assertTrue(restored.get("workUnknownLatched"))
        self.assertTrue(restored.get("workOutcomeUnknown"))
        restored["state"] = "closed"
        restarted.extensions["fixture"] = self.extension
        restarted._record_cleanup(
            restored,
            restored["generation"],
            self.extension,
            {
                "released": True,
                "cleanupState": "succeeded",
                "remainingTabIds": [],
                "preservedTabIds": [],
                "unknownTabIds": [],
            },
        )
        self.assertEqual(restored["cleanupState"], "succeeded")
        self.assertTrue(restored["workUnknownLatched"])
        with self.assertRaises(ProtocolError):
            restarted._dispatch_connected_extension(
                self.extension,
                "extension.assist.work.resource_bind",
                dict(
                    productId=PRODUCT,
                    session="replacement",
                    resourceId="next",
                    epoch=2,
                    lane="next",
                    hosts=["fixture.test"],
                ),
            )

    def test_revoke_stops_work_unknown_cleanup_cannot_unlock(self):
        opened, resource = self.open_work()

        def missing(*args, **kwargs):
            raise ProtocolError("extension_timeout", "lost cleanup")

        self.daemon._extension_call = missing
        revoked = self.rpc("resource_revoke", resourceHandle=resource["resourceHandle"])
        self.assertEqual(revoked["state"], "revoked")
        task = self.daemon.tasks[opened["taskId"]]
        self.assertEqual(task["state"], "closed")
        self.assertEqual(task["cleanupState"], "unknown")
        with self.assertRaises(ProtocolError):
            self.rpc(
                "resource_bind", resourceId="r2", epoch=2, lane="reports", hosts=["fixture.test"]
            )

    def test_all_named_operations_are_ledgered_and_query_submission_has_two_steps(self):
        opened, _ = self.open_work()
        cases = [
            ("search_read", {}),
            ("trends_read", {"keywords": ["fixture"], "region": "US", "period": "12m"}),
            ("report_inspect", {"ready_selectors": ["table"]}),
            ("table_advance", {"headers": ["Keyword"], "kind": "button"}),
            ("navigate", {"url": URL}),
            ("fill", {"selector": "input", "text": "fixture"}),
            ("click", {"selector": "button"}),
        ]
        for index, (operation, args) in enumerate(cases):
            self.work_run(opened, str(index), operation, args)
        self.work_run(
            opened,
            "query",
            "query_submit",
            {"selector": "input", "text": "query", "submitSelector": "button"},
        )
        self.assertEqual(
            [p[1]["action"] for p in self.calls if p[0] == "browser.execute"][-3:],
            ["fill", "js.evaluate", "click"],
        )
        self.assertEqual(len(self.daemon.tasks[opened["taskId"]]["requestHistory"]), 11)
        with self.assertRaises(ProtocolError):
            self.work_run(
                opened,
                "query",
                "query_submit",
                {"selector": "input", "text": "query", "submitSelector": "other"},
            )

    def test_js_envelope_unknown_is_not_cleared_by_new_operation(self):
        opened, _ = self.open_work()
        self.daemon._extension_call = lambda *_a, **_k: {"outcomeUnknown": True}
        self.work_run(opened, "reader", "search_read", {})
        task = self.daemon.tasks[opened["taskId"]]
        self.assertTrue(task["workOutcomeUnknown"])
        self.assertEqual(task["requestHistory"][-1]["state"], "unknown")
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "next")

    def test_logical_request_id_cannot_change_between_single_and_composite_operation(self):
        opened, _ = self.open_work()
        self.work_run(opened, "logical", "click", {"selector": "button"})
        with self.assertRaises(ProtocolError):
            self.work_run(
                opened,
                "logical",
                "query_submit",
                {"selector": "input", "text": "query", "submitSelector": "button"},
            )

    def test_query_plain_ok_requires_matching_field_readback_before_click(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call
        matching = [True]

        def browser(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "fill":
                self.calls.append((method, dict(params)))
                return {"ok": True}
            if method == "browser.execute" and params["action"] == "js.evaluate":
                self.calls.append((method, dict(params)))
                return {"data": {"matches": matching[0]}}
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = browser
        args = dict(selector="input", text="query", submitSelector="button")
        self.work_run(opened, "verified", "query_submit", args)
        self.assertEqual(
            [p["action"] for m, p in self.calls if m == "browser.execute"][-3:],
            ["fill", "js.evaluate", "click"],
        )
        matching[0] = False
        self.calls.clear()
        with self.assertRaises(ProtocolError):
            self.work_run(opened, "mismatch", "query_submit", args)
        self.assertNotIn("click", [p["action"] for m, p in self.calls if m == "browser.execute"])

    def test_query_root_names_keeps_unique_semantic_button_contract_without_fill(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call

        def browser(extension, method, params, **kwargs):
            if method == "browser.execute" and params["action"] == "semantic_snapshot":
                self.calls.append((method, dict(params)))
                return {
                    "binding": {"taskId": opened["taskId"], "documentId": "d", "leaseId": "l"},
                    "snapshotId": "s",
                    "items": [{"role": "button", "name": " Analyze ", "ref": "r"}],
                }
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = browser
        self.work_run(opened, "semantic", "query_submit", dict(root="#report", names=["Analyze"]))
        self.assertEqual(
            [p["action"] for m, p in self.calls if m == "browser.execute"][-2:],
            ["semantic_snapshot", "ref_click"],
        )
        self.assertEqual(self.calls[-1][1]["ref"], "r")
        self.assertEqual(self.calls[-2][1]["options"]["root"], "#report")

    def test_query_does_not_click_when_fill_returns_user_input_required(self):
        opened, _ = self.open_work()
        original = self.daemon._extension_call

        def sensitive(extension, method, params, **kwargs):
            if method == "browser.assess":
                return {"targetAssessment": "sensitive", "fieldKind": "password"}
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = sensitive
        self.work_run(
            opened,
            "query",
            "query_submit",
            {"selector": "input", "text": "query", "submitSelector": "button"},
        )
        self.assertFalse(
            any(p[0] == "browser.execute" and p[1]["action"] == "click" for p in self.calls)
        )

    def test_identity_generation_exact_shapes_and_foreign_tab_fail_closed(self):
        opened, resource = self.open_work()
        for extras in [
            {"session": "other"},
            {"productId": "b" * 32},
            {"productId": "A" * 32},
            {"productId": "a" * 31},
            {"productId": "a" * 32 + " "},
            {"session": {}},
        ]:
            with self.subTest(extras=extras), self.assertRaises(ProtocolError):
                self.rpc("get", workHandle=opened["workHandle"], **extras)
        for method, args in [
            (
                "run",
                {
                    "workHandle": opened["workHandle"],
                    "requestId": "bad",
                    "operation": "snapshot",
                    "arguments": {},
                    "owner": "evil",
                },
            ),
            ("open", {"url": URL, "incognito": False}),
            (
                "open",
                {
                    "url": "https://evil.test",
                    "incognito": False,
                    "resourceHandle": resource["resourceHandle"],
                },
            ),
            (
                "open",
                {
                    "url": URL,
                    "incognito": False,
                    "resourceHandle": resource["resourceHandle"],
                    "_silent": True,
                },
            ),
        ]:
            with self.subTest(method=method), self.assertRaises(ProtocolError):
                self.rpc(method, **args)
        self.daemon.tab_leases.clear()
        with self.assertRaises(ProtocolError):
            self.work_run(opened)
        self.extension["connectionGeneration"] = "c2"
        with self.assertRaises(ProtocolError):
            self.rpc("get", workHandle=opened["workHandle"])

    def test_actual_extension_call_guard_blocks_js_cdp_vault_gateway_before_sending(self):
        opened, _ = self.open_work()
        task = self.daemon.tasks[opened["taskId"]]
        authority = self.daemon.optional_service.work.works[opened["workHandle"]]
        for method, params in [
            ("browser.cdp", {}),
            ("browser.vault_fill", {}),
            ("browser.credentials", {}),
            ("browser.execute", {"action": "js.evaluate", "expression": "bad"}),
        ]:
            with self.subTest(method=method), self.assertRaises(ProtocolError):
                BridgeDaemon._extension_call(
                    self.daemon,
                    self.extension,
                    method,
                    {
                        "taskId": task["id"],
                        "generation": 1,
                        "modeGeneration": 2,
                        "tabId": 17,
                        **params,
                    },
                    _authority=authority,
                )
        with self.assertRaises(Exception) as denied:
            self.daemon._gateway_validate(
                {"taskId": task["id"], "owner": task["owner"], "generation": 1, "modeGeneration": 2}
            )
        self.assertEqual(type(denied.exception).__name__, "GatewayDenied")

    def test_session_close_fences_bind_and_inflight_open_but_keeps_status(self):
        self.make_daemon()
        resource = self.rpc(
            "resource_bind", resourceId="r1", epoch=1, lane="reports", hosts=["fixture.test"]
        )
        entered, finish = threading.Event(), threading.Event()
        original = self.daemon._create_task

        def delayed(*args, **kwargs):
            entered.set()
            self.assertTrue(finish.wait(3))
            return original(*args, **kwargs)

        self.daemon._create_task = delayed
        errors = []

        def opening():
            try:
                self.rpc(
                    "open", url=URL, incognito=False, resourceHandle=resource["resourceHandle"]
                )
            except ProtocolError as exc:
                errors.append(exc.code)

        worker = threading.Thread(target=opening)
        worker.start()
        self.assertTrue(entered.wait(2))
        try:
            self.assertEqual(self.rpc("session_close")["state"], "closed")
        finally:
            finish.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, ["work_session_closed"])
        self.assertTrue(all(t["state"] == "closed" for t in self.daemon.tasks.values()))
        for method, args in [
            ("resource_bind", dict(resourceId="r2", epoch=2, lane="other", hosts=["other.test"])),
            ("open", dict(url=URL, incognito=False, resourceHandle=resource["resourceHandle"])),
        ]:
            with self.subTest(method=method), self.assertRaises(ProtocolError) as denied:
                self.rpc(method, **args)
            self.assertEqual(denied.exception.code, "work_session_closed")
        self.assertEqual(self.rpc("session_close")["state"], "closed")

    def test_session_close_releases_its_tasks_without_restoring_unknown(self):
        opened, _ = self.open_work()
        result = self.rpc("session_close")
        self.assertEqual(result["state"], "closed")
        self.assertEqual(self.daemon.tasks[opened["taskId"]]["state"], "closed")
        with self.assertRaises(ProtocolError):
            self.work_run(opened)

    def test_core_routes_product_work_without_bundled_collaboration(self):
        from core_adapter import CoreAdapter

        d = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        d._prepare_data_dir()
        self.addCleanup(d._flush_tasks)
        d.extensions["fixture"] = {"instanceId": "fixture", "connectionGeneration": "c1"}
        extension = d.extensions["fixture"]
        self.assertTrue(d.optional_service.handles_extension("extension.assist.work.guard"))
        self.assertFalse(d.optional_service.handles_extension("extension.copilot.status"))
        bound = d._dispatch_connected_extension(
            extension,
            "extension.assist.work.resource_bind",
            dict(
                productId=PRODUCT,
                session=SESSION,
                resourceId="r",
                epoch=1,
                lane="reports",
                hosts=["fixture.test"],
            ),
        )
        self.assertIn("resourceHandle", bound)

    def test_core_bootstrap_has_no_assist_copilot_or_cli_imports(self):
        self.assertIn(
            'with_name("core_adapter.py")', (ROOT / "native-bridge/client.py").read_text()
        )
        self.assertNotIn(
            'with_name("assist_adapter.py")', (ROOT / "native-bridge/client.py").read_text()
        )

    def test_guard_checks_current_executor_url_binding_and_rejects_json_authority(self):
        opened, resource = self.open_work()
        guard = lambda **p: self.daemon._dispatch_connected_extension(
            self.extension, "extension.assist.work.guard", p
        )
        self.assertEqual(guard(taskId=opened["taskId"], url=URL), {"allowed": True})
        for params in [
            dict(taskId=opened["taskId"], url="https://evil.test/"),
            dict(taskId=opened["taskId"], url=URL, allowed=True),
            dict(taskId="unknown", url=URL),
        ]:
            with self.subTest(params=params), self.assertRaises(ProtocolError):
                guard(**params)
        with self.assertRaises(ProtocolError):
            self.daemon._dispatch_client(
                "extension.assist.work.guard", dict(taskId=opened["taskId"], url=URL)
            )
        task = self.daemon.tasks[opened["taskId"]]
        task["workResourceLane"] = "other"
        with self.assertRaises(ProtocolError):
            guard(taskId=task["id"], url=URL)
        task["workResourceLane"] = "reports"
        task["workUnknownLatched"] = True
        with self.assertRaises(ProtocolError):
            guard(taskId=task["id"], url=URL)
        task["workUnknownLatched"] = False
        self.daemon.extensions["fixture"] = dict(self.extension)
        with self.assertRaises(ProtocolError):
            guard(taskId=task["id"], url=URL)

    def test_optional_core_imports_remain_product_neutral(self):
        program = """
import builtins, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
original = builtins.__import__
def guard(name, *args, **kwargs):
    if name.startswith(('copilot', 'assist_adapter', 'fbl_cli', 'fbl_runtime')):
        raise AssertionError('product import: ' + name)
    return original(name, *args, **kwargs)
builtins.__import__ = guard
from core_adapter import CoreAdapter
from daemon import BridgeDaemon
d = BridgeDaemon(Path(sys.argv[2]), service_factory=CoreAdapter)
assert not hasattr(d, 'copilot')
assert d.optional_service.product is not None
assert d.optional_service.work is not None
d.optional_service.close()
print('core imports isolated')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", program, str(ROOT / "native-bridge"), self.temp.name],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("core imports isolated", result.stdout)

    def test_real_extension_reader_allows_native_roundtrip_without_deadlock(self):
        from core_adapter import CoreAdapter

        daemon = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        daemon._prepare_data_dir()
        self.addCleanup(daemon._flush_tasks)
        daemon._notify_tasks_changed = lambda _: None
        daemon._start_lifecycle_worker = (
            lambda target, *args: threading.Thread(target=target, args=args, daemon=True).start()
            if target.__name__ == "_service_extension_request"
            else None
        )
        server, peer = socket.socketpair()
        peer.settimeout(3)
        reader = peer.makefile("rb")
        errors = []

        def serve():
            try:
                with server, server.makefile("rb") as incoming:
                    daemon._serve_extension(server, incoming, "chrome-extension://fixture/")
            except EOFError:
                pass
            except Exception as exc:
                errors.append(repr(exc))

        worker = threading.Thread(target=serve)
        worker.start()

        def send(value):
            peer.sendall(json.dumps(value).encode() + b"\n")

        def read():
            return json.loads(reader.readline())

        def rpc(method, params, identity="rpc"):
            send(
                {
                    "id": identity,
                    "method": PREFIX + method,
                    "params": {"productId": PRODUCT, "session": SESSION, **params},
                }
            )
            return read()

        PREFIX = "extension.assist.work."
        try:
            send(
                {
                    "id": "hello",
                    "method": "extension.hello",
                    "params": {"instanceId": "wire", "browser": "chrome", "version": "test"},
                }
            )
            self.assertTrue(read()["result"]["connected"])
            resource = rpc(
                "resource_bind",
                {"resourceId": "r", "epoch": 1, "lane": "reports", "hosts": ["fixture.test"]},
            )["result"]
            opened = rpc(
                "open", {"url": URL, "incognito": False, **resource_without_epoch(resource)}
            )["result"]
            send(
                {
                    "id": "approve",
                    "method": "extension.approve",
                    "params": {
                        "taskId": opened["taskId"],
                        "generation": 1,
                        "workspaceOnly": True,
                        "tabIds": [],
                        "allowedOrigins": ["https://fixture.test"],
                    },
                }
            )
            self.assertEqual(read()["result"]["state"], "authorizing")
            send(
                {
                    "id": "mode",
                    "method": "extension.mode",
                    "params": {
                        "taskId": opened["taskId"],
                        "generation": 1,
                        "modeGeneration": 1,
                        "mode": "full",
                    },
                }
            )
            self.assertEqual(read()["result"]["state"], "ready")
            send(
                {
                    "id": "get",
                    "method": PREFIX + "get",
                    "params": {
                        "productId": PRODUCT,
                        "session": SESSION,
                        "workHandle": opened["workHandle"],
                    },
                }
            )
            command = read()
            self.assertEqual(command["method"], "browser.execute")
            self.assertEqual(command["params"]["action"], "new_tab")
            send({"id": command["id"], "result": {"tabId": 17}})
            self.assertEqual(read()["result"]["tabIds"], [17])
            send(
                {
                    "id": "run",
                    "method": PREFIX + "run",
                    "params": {
                        "productId": PRODUCT,
                        "session": SESSION,
                        "workHandle": opened["workHandle"],
                        "requestId": "reader",
                        "operation": "tables_read",
                        "arguments": {"minimumRows": 1, "headers": [], "selectors": []},
                    },
                }
            )
            command = read()
            self.assertEqual(command["params"]["action"], "js.evaluate")
            send({"id": command["id"], "result": {"data": {"tables": []}}})
            self.assertEqual(read()["result"], {"data": {"tables": []}})
        finally:
            peer.shutdown(socket.SHUT_RDWR)
            reader.close()
            peer.close()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(daemon.tasks[opened["taskId"]]["state"], "needs_sync")

    def test_close_fences_inflight_and_late_result_cannot_clear_unknown(self):
        opened, _ = self.open_work()
        entered, finish = threading.Event(), threading.Event()
        original = self.daemon._extension_call

        def pending(extension, method, params, **kwargs):
            if method == "browser.execute":
                entered.set()
                finish.wait(3)
                return {"status": "confirmed"}
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = pending
        errors = []

        def run():
            try:
                self.work_run(opened, "pending", "click", {"selector": "button"})
            except ProtocolError as exc:
                errors.append(exc.code)

        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(entered.wait(2))
        try:
            self.rpc("close", workHandle=opened["workHandle"], requestId="close")
            self.assertEqual(self.daemon.tasks[opened["taskId"]]["state"], "closed")
        finally:
            finish.set()
            worker.join(3)
        self.assertTrue(errors)
        self.assertTrue(self.daemon.tasks[opened["taskId"]]["workOutcomeUnknown"])


def resource_without_epoch(resource):
    return {"resourceHandle": resource["resourceHandle"]}


if __name__ == "__main__":
    unittest.main()
