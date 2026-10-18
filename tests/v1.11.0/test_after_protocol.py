"""动作后回读与富文本未知送达的公开 Python 协议；不监听 socket、不启动浏览器。"""

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


child = load("after_child", "executor-plugin/script_lane/child.py")
daemon = load("after_daemon", "native-bridge/daemon.py")
tools = load("after_native_tools", "executor-plugin/native_tools.py")
runtime = load("after_runtime", "executor-plugin/runtime.py")
adapter = load("after_action_session", "executor-plugin/script_lane/action_session.py")


class AfterProtocolTests(unittest.TestCase):
    def test_child_helpers_forward_after_and_keep_default_payload(self):
        snapshot = {
            "binding": {"taskId": "task", "documentId": "doc", "leaseId": "lease"},
            "snapshotId": "snapshot",
        }
        after = {"root": "#result", "mode": "content", "budget": 1800}
        with patch.object(child, "_call", return_value={"filled": True}) as call:
            child.ref_fill(snapshot, "ref", "text")
            self.assertNotIn("after", call.call_args.args[1][1])
            child.ref_fill(snapshot, "ref", "text", after=after)
            self.assertEqual(call.call_args.args[1][1]["after"], after)
            child.click("#button", after=after)
            self.assertEqual(
                call.call_args.args[1], ["click", {"selector": "#button", "after": after}]
            )

    def test_public_tool_and_daemon_accept_only_bounded_after(self):
        after = {"root": "#result", "mode": "interactive", "budget": 1800}
        public = {
            "task_id": "task",
            "tab_id": 7,
            "action": "click",
            "selector": "#button",
            "after": after,
        }
        tools._validate("fast_browser_run", public)
        native = {
            "owner": "owner",
            "taskId": "task",
            "requestId": "request",
            "tabId": 7,
            "selector": "#button",
            "after": after,
        }
        daemon.BridgeDaemon._validate_run_params("click", native)
        for invalid in (
            True,
            [],
            {"budget": 511},
            {"budget": 6001},
            {"mode": {}},
            {"root": ""},
            {"baselineId": "old"},
        ):
            with self.assertRaises(tools.ArgumentFieldsError):
                tools._validate("fast_browser_run", {**public, "after": invalid})
            with self.assertRaises(daemon.ProtocolError):
                daemon.BridgeDaemon._validate_run_params("click", {**native, "after": invalid})
        with self.assertRaises(tools.ArgumentFieldsError):
            tools._validate(
                "fast_browser_run",
                {"task_id": "task", "tab_id": 7, "action": "snapshot", "after": {}},
            )

    def test_projection_preserves_observation_blocked_and_unknown_without_values(self):
        observation = {
            "kind": "full",
            "binding": {"taskId": "task"},
            "snapshotId": "fresh",
            "items": [
                {
                    "ref": "ref",
                    "name": "保存",
                    "blocked": "occluded",
                    "actionable": False,
                    "value": "PRIVATE_VALUE",
                }
            ],
        }
        projected = runtime._project_tool_result(
            "fast_browser_run",
            {"action": "ref_fill"},
            {
                "filled": False,
                "verified": False,
                "delivery": "unconfirmed",
                "outcomeUnknown": True,
                "observation": observation,
            },
        )
        self.assertEqual(projected["delivery"], "unconfirmed")
        self.assertTrue(projected["outcomeUnknown"])
        self.assertEqual(projected["observation"]["items"][0]["blocked"], "occluded")
        self.assertFalse(projected["observation"]["items"][0]["actionable"])
        self.assertNotIn("value", projected["observation"]["items"][0])
        failed = runtime._project_tool_result(
            "fast_browser_run",
            {"action": "ref_click"},
            {
                "delivery": "confirmed",
                "effect": "unverified",
                "observation": {"error": "INVALID_ROOT"},
            },
        )
        self.assertEqual(set(failed["observation"]), {"error"})
        self.assertIsInstance(failed["observation"]["error"], str)
        self.assertNotIn("error", failed)
        self.assertEqual(failed["delivery"], "confirmed")
        self.assertEqual(failed["effect"], "unverified")

    def test_rich_unknown_receipt_fences_later_writes_and_never_replays(self):
        class Runtime:
            calls = []

            def call(self, method, params):
                self.calls.append((method, params))
                return {
                    "filled": False,
                    "kind": "trusted-input",
                    "delivery": "unconfirmed",
                    "outcomeUnknown": True,
                }

        transport = Runtime()
        session = adapter.ActionSession(transport, owner="owner", task_id="task")
        session.install_scope("instance", 1)
        session.tab_id = 7
        receipt = session.run(
            "ref_fill",
            {"binding": {}, "snapshotId": "snapshot", "ref": "ref", "text": "text", "after": {}},
        )
        self.assertEqual(receipt["delivery"], "unconfirmed")
        with self.assertRaises(adapter.OutcomeUnknown):
            session.run(
                "ref_fill", {"binding": {}, "snapshotId": "snapshot", "ref": "ref", "text": "text"}
            )
        self.assertEqual(len(transport.calls), 1)


if __name__ == "__main__":
    unittest.main()
