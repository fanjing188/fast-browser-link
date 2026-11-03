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
        if op == "workflow_ready":
            return {"supported": True}
        if op == "downloads":
            return {"downloads": []}
        if op == "run":
            if args[0] == "page.observe":
                return observed()
            if args[0] == "semantic_snapshot":
                return page([button()])
            if args[0] == "ref_click":
                return {"clicked": True, "delivery": "confirmed", "effect": "observed"}
        raise AssertionError((op, args))

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


if __name__ == "__main__":
    unittest.main()
