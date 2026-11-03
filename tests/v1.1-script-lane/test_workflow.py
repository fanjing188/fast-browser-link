"""通用工作流真实 helper 组合；回执合成，不连接个人浏览器。"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "workflow_child", ROOT / "native-bridge/script_lane/child.py"
)
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)


def observed(count=1, complete=True, document="d"):
    return {
        "count": count,
        "text": ["ready"] * count,
        "complete": complete,
        "binding": {"documentId": document},
    }


def button(**kw):
    return {"name": "Continue", "role": "button", "ref": "r", "actions": ["click", "press"], **kw}


def page(rows, complete=True):
    return {
        "kind": "full",
        "snapshotId": "s",
        "documentEpoch": "epoch",
        "binding": {"documentId": "d"},
        "coverage": {"complete": complete},
        "items": rows,
    }


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

    def call(self, op, args):
        self.calls.append((op, args, child._tab_scope.get()))
        if op in {"workflow_ready", "resilience_ready"}:
            return {"supported": True}
        if op == "downloads":
            return {"downloads": []}
        if op == "run":
            if args[0] == "execution.guard":
                return {
                    "reason": "ready",
                    "reloadAllowed": False,
                    "healthId": "h",
                    "access": {},
                    "protection": {},
                }
            if args[0] == "page.observe":
                return observed()
            if args[0] == "semantic_snapshot":
                return page([button()])
            if args[0] == "ref_click":
                return {"clicked": True, "delivery": "confirmed", "effect": "observed"}
        raise AssertionError((op, args))

    def test_recovery_reload_once_then_read(self):
        operations = []

        def call(op, args):
            if op == "run" and args[0] == "execution.guard":
                operation = args[1]["options"]["operation"]
                operations.append(operation)
                if operation == "recover":
                    return {"reloaded": True}
                return {
                    "reason": "transient" if len(operations) == 1 else "ready",
                    "reloadAllowed": len(operations) == 1,
                    "healthId": "h",
                    "access": {},
                    "protection": {},
                }
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            result = child.read_resilient()
        self.assertTrue(result["completed"])
        self.assertTrue(result["recovery"]["reloaded"])
        self.assertEqual(operations.count("recover"), 1)

    def test_malformed_health_never_permits_write(self):
        def call(op, args):
            if op == "run" and args[0] == "execution.guard":
                return {}
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            with self.assertRaises(child.BrowserError):
                child.run_steps([{"action": "click", "name": "Continue"}])
        self.assertFalse(any(args[0] == "ref_click" for op, args, _ in self.calls if op == "run"))

    def test_unknown_reload_never_retries_or_reads(self):
        def call(op, args):
            if op == "run" and args[0] == "execution.guard":
                if args[1]["options"]["operation"] == "recover":
                    raise child.BrowserError(
                        "lost receipt", code="recovery_outcome_unknown", outcome_unknown=True
                    )
                return {
                    "reason": "transient",
                    "reloadAllowed": True,
                    "healthId": "h",
                    "access": {},
                    "protection": {},
                }
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call) as mock:
            with self.assertRaises(child.BrowserError) as caught:
                child.read_resilient()
        self.assertTrue(caught.exception.outcome_unknown)
        self.assertEqual(
            sum(
                1
                for c in mock.call_args_list
                if c.args[0] == "run"
                and c.args[1][0] == "execution.guard"
                and c.args[1][1]["options"]["operation"] == "recover"
            ),
            1,
        )
        self.assertFalse(
            any(args[0] == "semantic_snapshot" for op, args, _ in self.calls if op == "run")
        )

    def test_any_all_and_explicit_tab_scope(self):
        for mode in ("any", "all"):
            with self.subTest(mode=mode), patch.object(child, "_call", side_effect=self.call):
                result = child.wait_until(
                    [{"kind": "element", "selector": "#result"}], mode=mode, tab=23
                )
                self.assertTrue(result["satisfied"])
                self.assertEqual(result["matched"], [0])
                self.assertTrue(all(row[2] == 23 for row in self.calls))
        self.assertIsNone(child._tab_scope.get())

    def test_all_needs_every_condition_in_same_round(self):
        def call(op, args):
            if (
                op == "run"
                and args[0] == "page.observe"
                and args[1]["options"]["selector"] == "#missing"
            ):
                return observed(0)
            return self.call(op, args)

        rows = [
            {"kind": "element", "selector": "#ready"},
            {"kind": "element", "selector": "#missing"},
        ]
        with patch.object(child, "_call", side_effect=call):
            self.assertTrue(child.wait_until(rows, mode="any", timeout=0.06)["satisfied"])
            result = child.wait_until(rows, mode="all", timeout=0.06)
        self.assertFalse(result["satisfied"])
        self.assertTrue(result["timed_out"])

    def test_absence_is_not_proven_by_partial_read(self):
        def call(op, args):
            return observed(0, False) if op == "run" else self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            result = child.wait_until(
                [{"kind": "element", "selector": "#missing", "state": "absent"}], timeout=0.06
            )
        self.assertFalse(result["satisfied"])
        self.assertFalse(result["conditions"][0]["complete"])

    def test_stable_requires_three_observations(self):
        with patch.object(child, "_call", side_effect=self.call):
            self.assertTrue(
                child.wait_until(
                    [{"kind": "element", "selector": "#result", "state": "stable"}], interval=0.05
                )["satisfied"]
            )
        self.assertEqual(
            sum(args[0] == "page.observe" for op, args, _ in self.calls if op == "run"), 3
        )

    def test_invalid_conditions_make_no_calls(self):
        for rows in (
            [],
            [{"kind": "script", "code": "bad"}],
            [{"kind": "element", "selector": "#x", "state": "count", "count": True}],
            [{"kind": "url", "url": "javascript:bad"}],
            [{"kind": "popup", "origin": "https://a.test/path"}],
            [{"kind": "response", "url": "https://a.test", "status": True}],
            [{"kind": "download", "state": "other"}],
            [{"kind": "element", "selector": "#x", "state": []}],
        ):
            with self.subTest(rows=rows), patch.object(child, "_call") as call:
                with self.assertRaises(child.BrowserError):
                    child.wait_until(rows)
                call.assert_not_called()

    def test_different_documents_cannot_satisfy_all(self):
        def call(op, args):
            return (
                observed(document=args[1]["options"]["selector"])
                if op == "run"
                else self.call(op, args)
            )

        with (
            patch.object(child, "_call", side_effect=call),
            self.assertRaises(child.BrowserError) as error,
        ):
            child.wait_until(
                [{"kind": "element", "selector": "#a"}, {"kind": "element", "selector": "#b"}],
                mode="all",
            )
        self.assertEqual(error.exception.code, "document_changed")

    def test_entire_plan_validated_before_first_write(self):
        for bad in (
            {"action": "press", "name": "Next", "key": "arbitrary"},
            {"action": "click", "name": ""},
            {"action": "fill", "name": "Field", "text": 7},
            {"action": "wait"},
            {
                "action": "click",
                "name": "Next",
                "after": {"conditions": [{"kind": "url", "url": "bad"}]},
            },
        ):
            with self.subTest(bad=bad), patch.object(child, "_call") as call:
                with self.assertRaises(child.BrowserError):
                    child.run_steps([{"action": "click", "name": "Continue"}, bad])
                call.assert_not_called()

    def test_click_then_condition_dispatches_once(self):
        with patch.object(child, "_call", side_effect=self.call):
            result = child.run_steps(
                [
                    {
                        "action": "click",
                        "name": "Continue",
                        "after": {"conditions": [{"kind": "element", "selector": "#result"}]},
                    }
                ]
            )
        self.assertTrue(result["completed"])
        self.assertEqual(result["steps"][0]["receipt"]["delivery"], "confirmed")
        self.assertEqual(
            sum(args[0] == "ref_click" for op, args, _ in self.calls if op == "run"), 1
        )
        self.assertIsNone(child._workflow_deadline.get())

    def test_postcondition_failure_preserves_delivery_and_stops(self):
        def call(op, args):
            return observed(0) if op == "run" and args[0] == "page.observe" else self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            result = child.run_steps(
                [
                    {
                        "action": "click",
                        "name": "Continue",
                        "after": {
                            "conditions": [{"kind": "element", "selector": "#missing"}],
                            "timeout": 0.06,
                        },
                    },
                    {"action": "click", "name": "Continue"},
                ]
            )
        self.assertEqual(result["reason"], "postcondition_failed")
        self.assertTrue(result["steps"][0]["dispatched"])
        self.assertEqual(result["steps"][0]["receipt"]["delivery"], "confirmed")
        self.assertEqual(len(result["steps"]), 1)

    def test_precondition_failure_does_not_dispatch(self):
        with patch.object(child, "_call", side_effect=self.call):
            result = child.run_steps(
                [
                    {
                        "action": "click",
                        "name": "Continue",
                        "before": {
                            "conditions": [
                                {"kind": "element", "selector": "#result", "state": "absent"}
                            ],
                            "timeout": 0.06,
                        },
                    }
                ]
            )
        self.assertEqual(result["reason"], "precondition_failed")
        self.assertFalse(result["steps"][0]["dispatched"])
        self.assertFalse(any(args[0] == "ref_click" for op, args, _ in self.calls if op == "run"))

    def test_unknown_action_aborts_without_observation_or_second_write(self):
        for receipt in (False, True):
            self.calls.clear()

            def call(op, args):
                if op == "run" and args[0] == "ref_click":
                    self.calls.append((op, args, None))
                    if receipt:
                        return {"outcomeUnknown": True, "delivery": "partial"}
                    raise child.BrowserError("partial", code="outcome_unknown")
                return self.call(op, args)

            with self.subTest(receipt=receipt), patch.object(child, "_call", side_effect=call):
                result = child.run_steps(
                    [
                        {
                            "action": "click",
                            "name": "Continue",
                            "after": {"conditions": [{"kind": "element", "selector": "#result"}]},
                        },
                        {"action": "click", "name": "Continue"},
                    ]
                )
            self.assertTrue(result["outcome_unknown"])
            self.assertEqual(self.calls[-1][1][0], "ref_click")
            self.assertEqual(len(result["steps"]), 1)

    def test_download_baseline_and_failed_download(self):
        for state in ("complete", "interrupted"):
            replies = iter(
                [
                    {"downloads": [{"id": 1, "state": "complete"}]},
                    {"downloads": [{"id": 1, "state": "complete"}, {"id": 2, "state": state}]},
                ]
            )

            def call(op, args):
                return next(replies) if op == "downloads" else self.call(op, args)

            with patch.object(child, "_call", side_effect=call):
                result = child.wait_until([{"kind": "download", "state": state}])
            self.assertEqual(result["conditions"][0]["evidence"]["id"], 2)

    def test_response_baseline_armed_before_action_and_old_events_ignored(self):
        sequence = []

        def call(op, args):
            sequence.append((op, args))
            if op == "run" and args[0] == "cdp.send":
                return {}
            if op == "run" and args[0] == "cdp.events":
                after = args[1]["cursor"]
                return {
                    "cursor": 10 if after == 0 else 11,
                    "hasMore": False,
                    "events": [
                        {
                            "method": "Network.responseReceived",
                            "params": {
                                "requestId": "new" if after else "old",
                                "response": {"url": "https://a.test/result", "status": 200},
                            },
                        }
                    ],
                }
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            result = child.run_steps(
                [
                    {
                        "action": "click",
                        "name": "Continue",
                        "after": {
                            "conditions": [
                                {"kind": "response", "url": "https://a.test/result", "status": 200}
                            ]
                        },
                    }
                ]
            )
        self.assertTrue(result["completed"])
        self.assertEqual(
            result["steps"][0]["after"]["conditions"][0]["evidence"]["request_id"], "new"
        )
        actions = [args[0] for op, args in sequence if op == "run"]
        self.assertLess(actions.index("cdp.events"), actions.index("ref_click"))
        self.assertEqual(actions.count("ref_click"), 1)

    def test_event_gap_refuses_success(self):
        with (
            patch.object(child, "_call", side_effect=self.call),
            patch.object(child, "cdp"),
            patch.object(
                child, "cdp_events", return_value={"cursor": 1, "events": [], "dropped": 1}
            ),
        ):
            with self.assertRaises(child.BrowserError) as error:
                child.wait_until([{"kind": "response", "url": "https://a.test/"}])
        self.assertEqual(error.exception.code, "event_overflow")

    def test_popup_is_observed_without_adoption(self):
        count = 0

        def call(op, args):
            nonlocal count
            if op == "run" and args[0] == "popup_catalog":
                count += 1
                return {
                    "candidates": []
                    if count == 1
                    else [{"candidateRef": "new", "origin": "https://id.test"}]
                }
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            result = child.run_steps(
                [
                    {
                        "action": "click",
                        "name": "Continue",
                        "after": {"conditions": [{"kind": "popup", "origin": "https://id.test"}]},
                    }
                ]
            )
        self.assertTrue(result["completed"])
        self.assertEqual(
            result["steps"][0]["after"]["conditions"][0]["evidence"]["candidateRef"], "new"
        )

    def test_url_rechecked_before_return(self):
        frame = {"id": "f", "loaderId": "l", "url": "https://a.test/"}
        with (
            patch.object(child, "_call", side_effect=self.call),
            patch.object(
                child,
                "cdp",
                side_effect=[
                    {"frameTree": {"frame": frame}},
                    {"frameTree": {"frame": {**frame, "url": "https://a.test/changed"}}},
                ],
            ),
        ):
            with self.assertRaises(child.BrowserError) as error:
                child.wait_until([{"kind": "url", "url": "https://a.test/"}])
        self.assertEqual(error.exception.code, "document_changed")

    def test_diagnostics_bounded_no_page_text_or_write_refs(self):
        for snapshot, reason in (
            (page([]), "target_not_found"),
            (page([button(), button(ref="r2")]), "ambiguous_target"),
            (page([button(disabled=True)]), "target_disabled"),
            (page([button(occluded=True)]), "target_occluded"),
            (page([button()], False), "incomplete_target_scope"),
            (page([button()]), "ready"),
        ):

            def call(op, args):
                return snapshot if op == "run" else self.call(op, args)

            with self.subTest(reason=reason), patch.object(child, "_call", side_effect=call):
                result = child.diagnose_target("Continue")
            self.assertEqual(result["reason"], reason)
            self.assertNotIn("Continue", json.dumps(result))
            self.assertNotIn("snapshotId", result)

    def test_unsupported_runtime_refuses_before_action(self):
        with patch.object(
            child,
            "_call",
            side_effect=child.BrowserError(
                "old", code="workflow_unsupported", outcome_unknown=False
            ),
        ) as call:
            with self.assertRaises(child.BrowserError):
                child.run_steps([{"action": "click", "name": "Continue"}])
            self.assertEqual(call.call_count, 1)

    def test_invalid_later_css_is_checked_before_first_write(self):
        def call(op, args):
            if op == "run" and args[0] == "page.observe":
                raise child.BrowserError(
                    "invalid selector", code="invalid_params", outcome_unknown=False
                )
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            with self.assertRaises(child.BrowserError):
                child.run_steps(
                    [
                        {"action": "click", "name": "Continue"},
                        {
                            "action": "click",
                            "name": "Continue",
                            "after": {"conditions": [{"kind": "element", "selector": "["}]},
                        },
                    ]
                )
        self.assertFalse(any(args[0] == "ref_click" for op, args, _ in self.calls if op == "run"))

    def test_press_uses_fresh_epoch_and_disables_automatic_recovery(self):
        def call(op, args):
            if op == "run" and args[0] == "ref_press":
                self.assertIs(args[1]["noAutoRecovery"], True)
                self.assertEqual(args[1]["documentEpoch"], "epoch")
                return {"pressed": True}
            return self.call(op, args)

        with patch.object(child, "_call", side_effect=call):
            self.assertTrue(
                child.run_steps([{"action": "press", "name": "Continue", "key": "Enter"}])[
                    "completed"
                ]
            )

    def test_real_transport_deadline_fences_later_writes_until_reconciliation(self):
        parent, peer = socket.socketpair()
        requests = []

        def serve():
            with parent, parent.makefile("rb") as stream:
                for line in stream:
                    requests.append(json.loads(line))

        worker = threading.Thread(target=serve)
        worker.start()
        code = """import time
token = _workflow_deadline.set(time.monotonic() + .05)
try:
    _call('run', ['ref_click', {}])
except BrowserError as error:
    print(error.code, error.outcome_unknown)
finally:
    _workflow_deadline.reset(token)
try:
    _call('run', ['ref_click', {}])
except BrowserError as error:
    print(error.code)
"""
        bootstrap = (
            "import runpy; n=runpy.run_path("
            + repr(str(ROOT / "native-bridge/script_lane/child.py"))
            + "); exec("
            + repr(code)
            + ",n)"
        )
        try:
            result = subprocess.run(
                [sys.executable, "-I", "-c", bootstrap],
                capture_output=True,
                text=True,
                pass_fds=[peer.fileno()],
                env={**os.environ, "FAST_BROWSER_FD": str(peer.fileno())},
                timeout=3,
            )
        finally:
            peer.close()
            worker.join(timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(), ["workflow_timeout True", "workflow_reconcile_required"]
        )
        self.assertEqual(len(requests), 1)


# 中文注释：真正的SQLite提交、宿主边界及helper组合；不启动个人浏览器。
import tempfile
import hashlib
import io
import zipfile

_tools_spec = importlib.util.spec_from_file_location(
    "workflow_tools_test", ROOT / "native-bridge/script_lane/workflow_tools.py"
)
_tools = importlib.util.module_from_spec(_tools_spec)
_tools_spec.loader.exec_module(_tools)


class DurableWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = _tools.Store(Path(self.temp.name))
        self.base = WorkflowTests()
        self.base.setUp()
        self.writes = 0
        self.unknown = False
        self.ambiguous = False
        self.surface_changed = False
        self.plan = [{"id": "one", "steps": [{"action": "click", "name": "Continue"}]}]

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def call(self, op, args):
        if op == "workflow_tools_ready":
            return {"supported": True}
        if op == "workflow_state":
            operation, data = args
            try:
                if operation == "wait":
                    self.store.debit("scope", wait=data["seconds"], operation=False)
                    return {"reserved": True}
                scope = "recipe" if operation.startswith("recipe_") else "scope"
                return self.store.call(
                    scope, "get" if operation == "recipe_get" else operation, data
                )
            except _tools.WorkflowError as e:
                raise child.BrowserError("denied", code=e.code, outcome_unknown=False)
        if op == "run":
            self.store.debit("scope", write=args[0] == "ref_click")
            if args[0] == "semantic_snapshot" and self.ambiguous:
                return page([button(), button(ref="r2")])
            if args[0] == "semantic_snapshot" and self.surface_changed:
                return page([button(name="Other")])
            if args[0] == "ref_click":
                self.writes += 1
                if self.unknown:
                    raise child.BrowserError(
                        "lost", code="extension_disconnected", outcome_unknown=True
                    )
        return self.base.call(op, args)

    def run_flow(self, *args, **kwargs):
        def call(op, args):
            try:
                return self.call(op, args)
            except _tools.WorkflowError as e:
                raise child.BrowserError("denied", code=e.code, outcome_unknown=False)

        with (
            patch.object(child, "_call", side_effect=call),
            patch.object(child, "_save_workflow_report", side_effect=lambda x: x),
        ):
            return child.run_batch(*args, **kwargs)

    def test_host_cleanup_and_debit_require_own_launch_token(self):
        from types import SimpleNamespace

        spec = importlib.util.spec_from_file_location(
            "workflow_ownership_host", ROOT / "native-bridge/script_lane/host_bridge.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        host = object.__new__(module.HostBridge)
        host._workflow_store = self.store
        selected = SimpleNamespace(
            _owner="owner", _task_id="task", _instance_id="instance", _generation=1, tab_id=1
        )
        scope = host._workflow_scope(selected)
        data = {"name": "ownership", "plan": self.plan}
        first = self.store.call(scope, "begin", data)
        host._workflow_finish({"workflow_tokens": {}})
        self.assertIn(scope, self.store.active)
        with self.assertRaises(module.WorkflowConditionError) as e:
            host._workflow_debit(selected, "run", ["semantic_snapshot", {}], {})
        self.assertEqual(e.exception.code, "workflow_busy")
        host._workflow_debit(selected, "workflow_state", ["get", {"name": "ownership"}], {})
        self.assertEqual(self.store.call(scope, "get", {"name": "ownership"})["operations"], 0)
        old = {"workflow_tokens": {scope: first["token"]}}
        host._workflow_finish(old)
        second = self.store.call(scope, "begin", {**data, "resume": True})
        host._workflow_finish(old)
        self.assertEqual(self.store.active[scope]["token"], second["token"])
        with self.assertRaises(module.WorkflowConditionError):
            host._workflow_debit(selected, "run", ["semantic_snapshot", {}], old["workflow_tokens"])
        host._workflow_debit(selected, "run", ["semantic_snapshot", {}], {scope: second["token"]})
        self.assertEqual(self.store.call(scope, "get", {"name": "ownership"})["operations"], 1)
        host._workflow_finish({"workflow_tokens": {scope: second["token"]}})
        self.assertNotIn(scope, self.store.active)

    def test_completed_steps_survive_new_store_and_are_never_replayed(self):
        self.assertTrue(self.run_flow("flow", self.plan)["completed"])
        self.store.close()
        self.store = _tools.Store(Path(self.temp.name))
        result = self.run_flow("flow", self.plan, resume=True)
        self.assertTrue(result["completed"])
        self.assertEqual(result["skipped_confirmed_steps"], 1)
        self.assertEqual(self.writes, 1)
        with self.assertRaises(child.BrowserError):
            self.run_flow(
                "flow",
                [{"id": "one", "steps": [{"action": "click", "name": "Different"}]}],
                resume=True,
            )

    def test_confirmed_without_after_does_not_claim_business_verification(self):
        r = self.run_flow("unverified", self.plan)
        self.assertEqual(r["verified_steps"], 0)
        self.assertEqual(r["unverified_confirmed_steps"], 1)

    def test_elapsed_is_cumulative_and_not_double_counted(self):
        with patch.object(_tools.time, "monotonic", return_value=100):
            r = self.store.call(
                "scope",
                "begin",
                {"name": "elapsed", "plan": self.plan, "budget": {"max_seconds": 10}},
            )
        for now in [101, 102, 103]:
            with patch.object(_tools.time, "monotonic", return_value=now):
                self.store.debit("scope")
        self.assertEqual(self.store.call("scope", "get", {"name": "elapsed"})["elapsed"], 3)
        with patch.object(_tools.time, "monotonic", return_value=111):
            with self.assertRaises(_tools.WorkflowError) as e:
                self.store.debit("scope", write=True)
        self.assertEqual(e.exception.code, "workflow_time_budget")

    def test_unknown_write_freezes_resume_and_report_retains_delivery_uncertainty(self):
        self.unknown = True
        r = self.run_flow("unknown", self.plan)
        self.assertEqual(r["status"], "blocked")
        self.assertTrue(r["outcome_unknown"])
        self.assertEqual(self.writes, 1)
        with self.assertRaises(child.BrowserError) as e:
            self.run_flow("unknown", self.plan, resume=True)
        self.assertEqual(e.exception.code, "workflow_reconciliation_required")
        self.assertEqual(self.writes, 1)

    def test_flock_excludes_second_process_and_crash_does_not_clear_inflight(self):
        data = {"name": "crash", "plan": self.plan}
        opened = self.store.call("scope", "begin", data)
        second = _tools.Store(Path(self.temp.name))
        try:
            with self.assertRaises(_tools.WorkflowError):
                second.call("scope", "begin", {**data, "resume": True})
            self.store.call(
                "scope", "arm", {"name": "crash", "token": opened["token"], "index": "0:0"}
            )
            self.store.close()
            with self.assertRaises(_tools.WorkflowError):
                second.call("scope", "begin", {**data, "resume": True})
            self.assertEqual(second.call("scope", "get", {"name": "crash"})["inflight"], "0:0")
        finally:
            second.close()

    def test_real_process_exit_keeps_durable_inflight(self):
        code = """import importlib.util,os
from pathlib import Path
s=importlib.util.spec_from_file_location('tools',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
w=m.Store(Path(%r));r=w.call('process','begin',{'name':'crash','plan':%r});w.call('process','arm',{'name':'crash','token':r['token'],'index':'0:0'});os._exit(0)
""" % (str(ROOT / "native-bridge/script_lane/workflow_tools.py"), self.temp.name, self.plan)
        subprocess.run([sys.executable, "-I", "-c", code], check=True, timeout=5)
        with self.assertRaises(_tools.WorkflowError):
            self.store.call(
                "process", "begin", {"name": "crash", "plan": self.plan, "resume": True}
            )

    def test_budget_persists_then_explicit_extension_resumes_without_reset(self):
        limits = {"max_operations": 1}
        result = self.run_flow("limited", self.plan, budget=limits)
        self.assertFalse(result["completed"])
        self.assertEqual(result["operations"], 1)
        self.assertEqual(self.writes, 0)
        row = self.store.call("scope", "get", {"name": "limited"})
        self.assertIsNone(row["inflight"])
        updated = {"max_operations": 100}
        self.store.call("scope", "extend", {"name": "limited", "budget": updated})
        self.assertTrue(
            self.run_flow("limited", self.plan, budget=updated, resume=True)["completed"]
        )
        self.assertEqual(self.writes, 1)

    def test_wait_budget_stops_before_sleep_or_write(self):
        items = [
            {
                "id": "wait",
                "steps": [
                    {
                        "action": "wait",
                        "after": {
                            "conditions": [
                                {
                                    "kind": "element",
                                    "selector": "#x",
                                    "state": "text",
                                    "text": "missing",
                                }
                            ]
                        },
                    }
                ],
            }
        ]
        r = self.run_flow("wait", items, budget={"max_wait_seconds": 0.01})
        self.assertFalse(r["completed"])
        self.assertEqual(r["reason"], "workflow_wait_budget")
        self.assertEqual(self.writes, 0)

    def test_batch_prevalidates_all_items_and_css_before_any_write(self):
        with self.assertRaises(child.BrowserError):
            self.run_flow(
                "invalid",
                self.plan
                + [{"id": "bad", "steps": [{"action": "fill", "name": "Search", "text": False}]}],
            )
        self.assertEqual(self.writes, 0)

        def broken(op, args):
            if op == "run" and args[0] == "page.observe" and args[1]["options"]["selector"] == "[":
                raise child.BrowserError("bad CSS", code="invalid_params", outcome_unknown=False)
            return self.call(op, args)

        with (
            patch.object(child, "_call", side_effect=broken),
            patch.object(child, "_save_workflow_report", side_effect=lambda x: x),
        ):
            r = child.run_batch(
                "css",
                self.plan
                + [{"id": "bad", "steps": [{"action": "click", "name": "Continue", "root": "["}]}],
            )
        self.assertFalse(r["completed"])
        self.assertEqual(self.writes, 0)

    def test_plan_inputs_are_hmac_only_not_persisted_in_database(self):
        plan = [
            {
                "id": "private",
                "steps": [{"action": "fill", "name": "Search", "text": "PRIVATE_INPUT_489"}],
            }
        ]
        r = self.store.call("scope", "begin", {"name": "private", "plan": plan})
        self.store.call("scope", "finish", {"name": "private", "token": r["token"]})
        self.assertNotIn(b"PRIVATE_INPUT_489", self.store.path.read_bytes())

    def test_cross_scope_cannot_read_or_resume_another_task(self):
        r = self.store.call("scope", "begin", {"name": "isolation", "plan": self.plan})
        self.assertIsNone(self.store.call("other", "get", {"name": "isolation"}))
        with self.assertRaises(_tools.WorkflowError):
            self.store.call("other", "finish", {"name": "isolation", "token": r["token"]})

    def test_recipe_revalidates_surface_and_never_saves_text_values(self):
        with (
            patch.object(child, "_call", side_effect=self.call),
            patch.object(child, "_save_workflow_report", side_effect=lambda x: x),
        ):
            self.assertTrue(
                child.save_site_recipe("recipe", [{"action": "click", "name": "Continue"}])["saved"]
            )
            self.assertTrue(child.run_site_recipe("recipe", workflow_name="first")["completed"])
            self.surface_changed = True
            with self.assertRaises(child.BrowserError) as e:
                child.run_site_recipe("recipe", workflow_name="second")
            self.assertEqual(e.exception.code, "workflow_recipe_stale")
            with self.assertRaises(child.BrowserError):
                child.save_site_recipe(
                    "bad", [{"action": "fill", "name": "Search", "text": "PRIVATE"}]
                )
        self.assertEqual(self.writes, 1)

    def test_report_aggregates_failed_unstarted_confirmed_and_blocked(self):
        row = {
            "name": "r",
            "layout": [
                {"id": "done", "count": 1},
                {"id": "failed", "count": 1},
                {"id": "unknown", "count": 1},
                {"id": "later", "count": 1},
            ],
            "entries": {
                "0:0": {"state": "confirmed"},
                "1:0": {"state": "pending", "reason": "ambiguous_target"},
            },
            "inflight": "2:0",
            "status": "blocked",
            "elapsed": 1,
            "operations": 3,
            "wait_seconds": 0,
            "budget": {},
        }
        result = _tools.summary(row)
        self.assertEqual(
            result["counts"], {"completed": 1, "failed": 1, "blocked": 1, "pending": 1}
        )

    def test_download_csv_dates_headers_digest_and_html_masquerade(self):
        p = Path(self.temp.name) / "rows.csv"
        p.write_text("id,date\n1,2026-11-03\n")
        expected = {
            "required_columns": ["id", "date"],
            "min_rows": 1,
            "max_rows": 1,
            "date_column": "date",
            "date_from": "2026-11-01",
            "date_to": "2026-11-30",
        }
        self.assertTrue(_tools.verify_file(p, expected)["valid"])
        self.assertFalse(_tools.verify_file(p, {**expected, "date_to": "2026-11-02"})["valid"])
        self.assertEqual(_tools.verify_file(p, {"sha256": "0" * 64})["reason"], "digest_mismatch")
        p.write_text("<html>Login expired</html>")
        self.assertFalse(_tools.verify_file(p)["valid"])

    def test_xlsx_cached_values_dates_and_record_counts(self):
        p = Path(self.temp.name) / "rows.xlsx"
        with zipfile.ZipFile(p, "w") as z:
            z.writestr(
                "xl/workbook.xml",
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
            )
            z.writestr(
                "xl/_rels/workbook.xml.rels",
                '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            )
            z.writestr(
                "xl/worksheets/sheet1.xml",
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>date</t></is></c></row><row><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>2026-11-03</t></is></c></row></sheetData></worksheet>',
            )
        r = _tools.verify_file(
            p,
            {
                "min_rows": 1,
                "required_columns": ["id", "date"],
                "date_column": "date",
                "date_from": "2026-11-01",
            },
        )
        self.assertTrue(r["valid"])
        self.assertEqual(r["rows"], 1)

    def test_file_rejects_empty_truncated_and_symlink(self):
        p = Path(self.temp.name) / "rows.json"
        p.write_bytes(b"")
        self.assertFalse(_tools.verify_file(p)["valid"])
        p.write_bytes(b'[{"id":')
        self.assertFalse(_tools.verify_file(p)["valid"])
        link = p.with_name("link.json")
        link.symlink_to(p)
        with self.assertRaises(OSError):
            _tools.verify_file(link)


if __name__ == "__main__":
    unittest.main()
