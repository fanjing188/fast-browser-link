"""R34 全离线合同：只启动假 app-server，不接触个人 Codex 配置或登录态。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot_acp import ACPError, ACPTimeout
from copilot_adapters import AgentAdapter, adapter
from copilot_codex import Codex, detect, supported, usage_delta, overrides
from copilot_codex_broker import BrowserBroker
from copilot_codex_execution import CodexExecutions
from copilot_contracts import private_write
from copilot_models import catalogs


class CodexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve()
        self.record = self.directory / "rpc.jsonl"
        self.runtimes = []

    def tearDown(self):
        for runtime in self.runtimes:
            runtime.close()
        self.temp.cleanup()

    def config(self, mode="normal"):
        return {
            "default_agent": "codex",
            "timeout_seconds": 1,
            "codex_app_server_command": [
                sys.executable,
                "-B",
                str(ROOT / "tests/copilot/fake-app-server.py"),
                mode,
                str(self.record),
            ],
        }

    def runtime(self, mode="normal", **kwargs):
        runtime = Codex(self.config(mode), self.directory, **kwargs)
        self.runtimes.append(runtime)
        return runtime

    def frames(self):
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def test_economy_model_from_catalog_explicit_and_execution_unchanged(self):
        for selected, execution, expected in [
            ("", False, "future-mini"),
            ("my-choice", False, "my-choice"),
            ("", True, "fixture-one"),
        ]:
            runtime = self.runtime(execution=execution)
            runtime.config["exec_model" if execution else "inference_model"] = selected
            original = runtime.call

            def call(method, params):
                if method == "model/list":
                    return {
                        "data": [
                            {"model": "future-premium", "isDefault": True},
                            {"model": "future-luna"},
                            {"model": "future-mini"},
                            {"model": "notmini"},
                        ]
                    }
                return original(method, params)

            runtime.call = call
            runtime.start()
            self.assertEqual(runtime.active_model, expected)
            runtime.close()

    def test_normal_policy_usage_model_selection_and_private_cleanup(self):
        runtime = self.runtime()
        private = Path(runtime.temporary.name)
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        runtime.start()
        self.assertFalse(runtime.tools_verified)
        self.assertEqual(runtime.verify_policy()["status"], "restricted_audited")
        runtime.select_model("fixture-two")
        for _ in range(2):
            answer, metrics = runtime.prompt("JSON please")
            self.assertEqual(json.loads(answer), {"ready": True})
            self.assertEqual(metrics["usage"], {"input": 80, "cache_read": 20, "output": 10})
            self.assertFalse(metrics["estimated"])
        created = next(v["params"] for v in self.frames() if v.get("method") == "thread/start")
        self.assertEqual(created["environments"], [])
        self.assertEqual(created["dynamicTools"], [])
        self.assertEqual(created["approvalPolicy"], "never")
        self.assertIs(created["config"]["mcp_servers"]["fixture.server"]["enabled"], False)
        self.assertTrue(
            all(
                v["params"].get("model") == "fixture-two"
                for v in self.frames()
                if v.get("method") == "turn/start"
            )
        )
        runtime.close()
        self.assertFalse(private.exists())
        self.assertIsNotNone(runtime.process.poll())

    def test_chunked_large_frames_and_model_pagination_without_prompt(self):
        runtime = self.runtime("chunks")
        runtime.start(initialize_only=True)
        catalog = runtime.list_models()
        self.assertEqual([v["id"] for v in catalog["available"]], ["fixture-one", "fixture-two"])
        self.assertNotIn("turn/start", [v.get("method") for v in self.frames()])

    def test_each_tool_or_unknown_item_discards_turn_and_interrupts(self):
        for kind in [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "webSearch",
            "dynamicToolCall",
            "collabAgentToolCall",
            "plan",
            "futureUnknown",
        ]:
            with self.subTest(kind=kind):
                runtime = self.runtime("tool:" + kind)
                runtime.start()
                with self.assertRaises(ACPError) as raised:
                    runtime.prompt("JSON please")
                self.assertEqual(raised.exception.failure["reason"], "policy_violation")
                self.assertFalse(runtime.messages)
                runtime.close()
        self.assertIn("turn/interrupt", [v.get("method") for v in self.frames()])

    def test_approval_dynamic_unknown_requests_are_rejected(self):
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/call",
            "unknown/method",
        ]:
            with self.subTest(method=method):
                runtime = self.runtime("request:" + method)
                runtime.start()
                with self.assertRaises(ACPError):
                    runtime.prompt("JSON please")
                runtime.close()
        responses = [v for v in self.frames() if v.get("id") == "server-call"]
        self.assertTrue(any(v.get("result", {}).get("decision") == "decline" for v in responses))
        self.assertTrue(any(v.get("result", {}).get("success") is False for v in responses))
        self.assertTrue(any(v.get("error", {}).get("code") == -32601 for v in responses))

    def test_unknown_tool_event_policy_mismatch_eof_and_timeout(self):
        for mode in ["unknown_event", "policy", "eof", "timeout", "logged_out"]:
            with self.subTest(mode=mode):
                runtime = self.runtime(mode)
                with self.assertRaises(ACPError):
                    runtime.start()
                    runtime.prompt("JSON please")
                runtime.close()

    def test_execution_workspace_readback_and_dynamic_tool(self):
        broker = Mock()
        broker.tools = []
        broker.call.return_value = {"result": "owned"}
        runtime = self.runtime("request:item/tool/call", execution=True, broker=broker)
        runtime.start()
        answer, _ = runtime.prompt("JSON please")
        self.assertEqual(json.loads(answer), {"ready": True})
        broker.call.assert_called_once()
        sandbox = runtime.verify_policy()["effective"]
        self.assertEqual(sandbox["writableRoots"], [str(self.directory)])
        self.assertIs(sandbox["networkAccess"], False)
        self.assertIs(sandbox["excludeSlashTmp"], True)
        self.assertIs(sandbox["excludeTmpdirEnvVar"], True)

    def test_cancellation_rejects_pending_callback_and_late_reply(self):
        entered, release = threading.Event(), threading.Event()
        broker = Mock()
        broker.tools = []
        broker.call.side_effect = lambda _: (entered.set(), release.wait(2), {"ok": True})[-1]
        runtime = self.runtime("request:item/tool/call", execution=True, broker=broker)
        runtime.start()
        errors = []

        def prompt():
            try:
                runtime.prompt("JSON please")
            except ACPError as error:
                errors.append(error)

        worker = threading.Thread(target=prompt)
        worker.start()
        self.assertTrue(entered.wait(2))
        runtime.cancel()
        release.set()
        worker.join(2)
        runtime.close()
        self.assertFalse(worker.is_alive())
        self.assertTrue(errors)
        responses = [v for v in self.frames() if v.get("id") == "server-call"]
        self.assertEqual(len(responses), 1)
        self.assertIs(responses[0]["result"]["success"], False)
        broker.revoke.assert_called()

    def test_main_general_execution_and_switch_clear_models_without_migrating_sessions(self):
        from copilot import Copilot
        from copilot_setup import setup

        setup(self.directory)
        private_write(
            self.directory / "config.json",
            json.dumps(
                {
                    **self.config("result"),
                    "inference_model": "fixture-one",
                    "exec_model": "fixture-two",
                }
            ),
        )
        app = Copilot(self.directory, debounce=0.01)

        def wait(check):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if check():
                    return
                time.sleep(0.01)
            self.fail("fixture timed out")

        try:
            app.request("instance", "settings", {"enabled": True})
            wait(lambda: app.view("instance")["ready"])
            with app.lock, patch.dict(app._state("instance"), ready=False):
                app.request(
                    "instance",
                    "quick_task",
                    {"action": "general.task", "params": {"task": "Summarize supplied evidence"}},
                )
            row = next(
                row
                for row in app._state("instance")["suggestions"].values()
                if row["action"] == "general.task"
            )
            app.request("instance", "execute", {"id": row["id"]})
            wait(lambda: row["status"] in {"completed", "failed"})
            self.assertEqual(row["status"], "completed", row.get("reason"))
            self.assertEqual(row["model_source"], "codex")
            previous = app.runtime
            previous.process.terminate()
            wait(lambda: app.runtime is not previous and app.view("instance")["ready"])
            self.assertIsNotNone(previous.process.poll())
            self.assertEqual(
                sum(
                    v.get("method") == "turn/start"
                    and v.get("params", {}).get("input", [{}])[0].get("text", "").startswith("{")
                    and json.loads(v["params"]["input"][0]["text"]).get("action") == "general.task"
                    for v in self.frames()
                ),
                1,
            )
            with self.assertRaises(ValueError):
                app.agents.request("instance", "agent_select", {"agent_id": "hermes"})
            app.request("instance", "settings", {"enabled": False})
            app.runtime.close()
            with (
                patch("copilot_agents.command", return_value="/fixture/hermes"),
                patch("copilot_agents.configured", return_value=True),
            ):
                app.agents.request("instance", "agent_select", {"agent_id": "hermes"})
            self.assertEqual(app.config["inference_model"], "")
            self.assertEqual(app.config["exec_model"], "")
            self.assertIsNone(app.runtime)
            self.assertIsNone(app.acp_executions)
        finally:
            app.close()

    def test_external_provider_account_does_not_require_chatgpt_login(self):
        runtime = self.runtime("external")
        runtime.start()
        self.assertEqual(runtime.verify_policy()["status"], "restricted_audited")

    def test_usage_validation(self):
        self.assertIsNone(usage_delta({}, {}))
        self.assertIsNone(
            usage_delta({"inputTokens": 1, "cachedInputTokens": 2, "outputTokens": 3}, {})
        )
        self.assertIsNone(
            usage_delta(
                {"inputTokens": 1, "cachedInputTokens": 0, "outputTokens": 3}, {"inputTokens": 2}
            )
        )

    def test_versions_missing_and_auth_classification_without_real_commands(self):
        self.assertFalse(supported("codex-cli 0.162.0"))
        self.assertFalse(supported("codex-cli 0.162.1-beta"))
        self.assertTrue(supported("codex-cli 0.162.1\n"))
        with patch("copilot_codex.shutil.which", return_value=None):
            self.assertEqual(detect({})["status"], "not_installed")
        for code, text, expected in [
            (0, "Logged in using ChatGPT", "authenticated"),
            (1, "Not logged in", "auth_missing"),
            (1, "credential read failed", "auth_error"),
        ]:
            with (
                patch("copilot_codex.shutil.which", return_value="fixture"),
                patch(
                    "copilot_codex.subprocess.run",
                    side_effect=[
                        subprocess.CompletedProcess([], 0, "codex-cli 0.162.1", ""),
                        subprocess.CompletedProcess([], code, text, ""),
                    ],
                ),
            ):
                self.assertEqual(detect({})["status"], expected)
        with (
            patch("copilot_codex.shutil.which", return_value="fixture"),
            patch(
                "copilot_codex.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "codex-cli 0.162.0", ""),
            ) as run,
        ):
            self.assertEqual(detect({})["status"], "unsupported_version")
            self.assertEqual(run.call_count, 1)

    def test_overrides_match_frozen_official_config_schema(self):
        contract = json.loads(
            (ROOT / "tests/copilot/fixtures/codex-0.162.1-config.json").read_text()
        )
        kinds = {"boolean": bool, "string": str, "integer": int, "array": list, "object": dict}
        for execution in (False, True):
            for key, value in overrides(execution, "TASK_DIRECTORY").items():
                self.assertIs(type(value), kinds[contract["paths"][key]], key)

    def test_agent_onboarding_uses_only_fixture_and_records_codex_check(self):
        from copilot import Copilot

        private_write(self.directory / "config.json", json.dumps(self.config()))
        app = Copilot(self.directory)
        try:
            with patch(
                "copilot_codex.detect",
                return_value={"installed": True, "configured": True, "status": "authenticated"},
            ):
                job = app.request("instance", "agent_setup_start", {"agent_id": "codex"})
                app.agents.jobs[job["id"]]["thread"].join(2)
            result = app.request("instance", "agent_setup_status", {"id": job["id"]})
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual(result["connection"]["check"], "codex_initialize")
            self.assertNotIn("turn/start", [v.get("method") for v in self.frames()])
        finally:
            app.close()

    def test_catalog_cache_key_and_adapter(self):
        result = catalogs(self.config(), self.directory, private_write)
        self.assertEqual(result["inference"]["agent"], "codex")
        cache = json.loads((self.directory / "codex-models.json").read_text())
        self.assertIn(json.dumps(["codex", "fixture-0.162.1", "fixture"]), cache)
        self.assertEqual(adapter({}).id, "hermes")
        self.assertEqual(
            AgentAdapter("codex").capabilities()["inference_policy"], "restricted_audited"
        )

    def test_general_task_runs_and_outcome_is_never_replayed(self):
        for mode in ["normal", "eof"]:
            pool = CodexExecutions(self.config(mode), self.directory)
            try:
                if mode == "normal":
                    result, metrics = pool.run(
                        "key",
                        {"action": "general.task"},
                        self.directory / "result.json",
                        json.loads,
                        private_write,
                    )
                    self.assertEqual(result, {"ready": True})
                else:
                    with self.assertRaises(RuntimeError):
                        pool.run(
                            "key",
                            {"action": "general.task"},
                            self.directory / "result.json",
                            json.loads,
                            private_write,
                        )
            finally:
                pool.close()
        self.assertEqual(sum(v.get("method") == "turn/start" for v in self.frames()), 2)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.daemon = Mock()
        self.daemon.state_lock = threading.RLock()
        self.daemon.tasks = {
            "task": {
                "id": "task",
                "owner": "",
                "instanceId": "instance",
                "generation": 1,
                "state": "ready",
                "agentTabIds": [7],
            }
        }
        self.daemon.tab_leases = {("instance", 7): "task"}
        self.daemon.extensions = {"instance": {"connectionGeneration": 1}}
        self.broker = BrowserBroker(
            self.daemon,
            "instance",
            lambda: True,
            {"url": "https://example.test"},
            {"toolsets": ["fast-browser-link"]},
            2,
        )
        self.broker.task, self.broker.task_generation, self.broker.tab, self.broker.connection = (
            "task",
            1,
            7,
            1,
        )
        self.daemon.tasks["task"]["owner"] = self.broker.owner
        self.daemon._dispatch_client.return_value = {"ok": True}

    def params(self, identity="call"):
        return {"tool": "assist_browser_snapshot", "arguments": {}, "callId": identity}

    def test_owner_injection_cross_task_old_generation_and_page_lease_denied(self):
        bad = self.params()
        bad["arguments"]["owner"] = "evil"
        with self.assertRaises(ValueError):
            self.broker.call(bad)
        for key, value in [("generation", 2), ("owner", "other"), ("instanceId", "other")]:
            original = self.daemon.tasks["task"][key]
            self.daemon.tasks["task"][key] = value
            with self.assertRaises(ValueError):
                self.broker.call(self.params(key))
            self.daemon.tasks["task"][key] = original
        self.daemon._dispatch_client.assert_not_called()

    def test_atomic_budget_duplicate_and_revoke_late_call(self):
        self.broker.call(self.params())
        with self.assertRaises(ValueError):
            self.broker.call(self.params())
        self.broker.call(self.params("second"))
        with self.assertRaises(ValueError):
            self.broker.call(self.params("third"))
        self.broker.revoke()
        with self.assertRaises(ValueError):
            self.broker.call(self.params("late"))
        self.assertTrue(self.daemon.tasks["task"]["accessRevoked"])
        self.broker.cleanup()
        self.assertEqual(self.daemon._dispatch_client.call_args.args[0], "shared.cancel")

    def test_parallel_calls_consume_exact_budget_and_lease_loss_fails(self):
        self.broker.remaining = 2
        outcomes = []

        def call(index):
            try:
                self.broker.call(self.params(str(index)))
                outcomes.append(True)
            except ValueError:
                outcomes.append(False)

        workers = [threading.Thread(target=call, args=(index,)) for index in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(2)
        self.assertEqual(outcomes.count(True), 2)
        self.assertEqual(self.broker.remaining, 0)
        self.assertEqual(self.daemon._dispatch_client.call_count, 2)
        self.broker.remaining = 1
        self.daemon.tab_leases.clear()
        with self.assertRaises(ValueError):
            self.broker.call(self.params("lost-lease"))
        self.assertEqual(self.daemon._dispatch_client.call_count, 2)

    def test_lazy_creation_uses_private_owner_and_only_owned_page(self):
        self.broker.task = self.broker.tab = None

        def dispatch(method, params):
            self.assertEqual(params["owner"], self.broker.owner)
            if method == "shared.create":
                self.assertEqual(params["instanceId"], "instance")
                return {"id": "task", "generation": 1}
            if params["action"] == "new_tab":
                return {"tabId": 7}
            self.assertEqual(params["tabId"], 7)
            return {"ok": True}

        self.daemon._dispatch_client.side_effect = dispatch
        self.assertEqual(self.broker.call(self.params()), {"ok": True})
        self.assertEqual(self.daemon._dispatch_client.call_count, 3)
        self.assertEqual(self.broker.remaining, 0)

    def test_unknown_outcome_and_lost_page_cannot_replay(self):
        self.daemon._dispatch_client.return_value = {"outcomeUnknown": True}
        with self.assertRaises(ValueError):
            self.broker.call(self.params())
        with self.assertRaises(ValueError):
            self.broker.call(self.params("new-id"))
        self.assertEqual(self.daemon._dispatch_client.call_count, 1)


if __name__ == "__main__":
    unittest.main()
