"""R16：纯临时数据、合成能力回执，不访问真实浏览器或供应商。"""

import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, private_write
from copilot_setup import setup
from copilot_annotations import AnnotationMemory, object_key
from copilot_risk import declared, binding_risk, automatic_binding, authorize_binding, action_risk


def wait(check):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError("synthetic batch timed out")


class R16(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fbl-r16-")
        self.root = Path(self.temp.name).resolve()
        setup(self.root)
        self.app = Copilot(self.root)
        self.app.config.update(
            table_export_dir=str(self.root / "exports"), pool_command=[], pool_lookup_command=[]
        )
        self.state = self.app._state("fixture")
        self.app.active = "fixture"
        self.state.update(enabled=True, ready=True)
        self.app.runtime = SimpleNamespace(
            active_model="fixture",
            model_state={"currentModelId": "fixture"},
            closed=False,
            close=lambda: None,
            cancel=lambda: None,
        )
        self.app.packages.bindings = {}
        self.app.packages.flows = {}
        self.requests = []

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def add(self, n=20, kind="keyword"):
        return self.app.request(
            "fixture",
            "basket_add",
            {
                "items": [
                    {
                        "type": kind,
                        "value": f"sample {i}" if kind == "keyword" else f"site{i}.example.test",
                    }
                    for i in range(n)
                ]
            },
        )

    def binding(self, capability, identity, limit=100, **kwargs):
        binding = {
            "id": identity,
            "type": "command",
            "argv": [sys.executable],
            "batch_limit": limit,
            "cost": "paid",
            "risk": "metered",
            "exact": True,
            **kwargs,
        }
        self.app.packages.bindings.setdefault(capability, []).append(binding)
        return binding

    def command(self, binding, inputs, work, stop):
        self.requests.append((binding["id"], copy.deepcopy(inputs)))
        words = inputs.get("keywords") or [
            record["keyword"] for record in inputs.get("records", [])
        ]
        if binding["id"] == "serp":
            return {
                "records": [
                    {
                        "keyword": word,
                        "domain": "site.example.test",
                        "url": "https://site.example.test/a",
                        "rank": 1,
                        "title": "Synthetic result",
                    }
                    for word in words
                ],
                "source": "serp",
            }
        if binding["id"] == "judge":
            return {
                "records": [{**record, "tier": "test"} for record in inputs["records"]],
                "source": "judge",
            }
        return {
            "records": [{"keyword": word, "vol": 12, "kd": 3} for word in words],
            "source": binding["id"],
        }

    def model(self, *args):
        return {"verdict": "fixture judgment", "notes": []}

    def test_persistence_dedup_groups_remove_and_invalid_objects(self):
        first = self.add()
        self.assertEqual(len(first["items"]), 20)
        self.add()
        self.assertEqual(len(self.app.basket.items), 20)
        self.app.request(
            "fixture",
            "basket_add",
            {
                "items": [
                    {"type": "domain", "value": "EXAMPLE.test"},
                    {"type": "url", "value": "https://example.test/path"},
                ]
            },
        )
        from copilot_basket import Basket

        basket = Basket(self.app, private_write)
        self.assertEqual(
            basket.snapshot()["groups"], {"keyword": 20, "domain": 1, "url": 1, "table": 0}
        )
        removed = self.app.request("fixture", "basket_remove", {"ids": [first["items"][0]["id"]]})
        self.assertEqual(len(removed["items"]), 21)
        with self.assertRaises(ValueError):
            self.app.request(
                "fixture",
                "basket_add",
                {"items": [{"type": "url", "value": "file:///private.txt"}]},
            )
        self.app.request("fixture", "basket_clear", {})
        self.assertFalse(self.app.basket.items)

    def test_annotation_sources_are_local_and_unclassified_lookup_never_runs(self):
        self.app.annotation_memory.ingest(
            [
                {"keyword": "sample", "tier": "test", "vol": 0, "kd": 2},
                {"domain": "example.test", "authority": 8, "weak": True},
            ],
            pool=["sample"],
            analyzed=True,
            at=1700000000,
        )
        self.app.config["pool_lookup_command"] = ["/should/not/run"]
        with (
            patch("subprocess.run", side_effect=AssertionError("no automatic commands")),
            patch.object(self.app.registry, "execute", side_effect=AssertionError("no providers")),
        ):
            value = self.app.request(
                "fixture",
                "annotation_lookup",
                {
                    "objects": [
                        {"type": "keyword", "value": "SAMPLE"},
                        {"type": "domain", "value": "example.test"},
                    ]
                },
            )
        self.assertEqual(value["items"][0]["info"]["vol"], 0)
        self.assertTrue(value["items"][0]["info"]["pool"])
        self.assertTrue(value["items"][1]["info"]["analyzed"])
        self.assertEqual(value["items"][0]["info"]["checked_at"], 1700000000)
        loaded = AnnotationMemory(self.root, private_write)
        self.assertEqual(
            loaded.lookup([{"type": "keyword", "value": "sample"}])["keyword:sample"]["tier"],
            "test",
        )
        with self.assertRaises(ValueError):
            self.app.request(
                "fixture",
                "annotation_lookup",
                {"objects": [{"type": "keyword", "value": "x"}] * 301},
            )

    def test_risk_defaults_and_auto_never_paid_login_agent_external_or_unknown(self):
        self.assertEqual(declared({}), "metered")
        for binding in [
            {"type": "command", "cost": "paid", "risk": "zero"},
            {"type": "hermes", "cost": "zero", "risk": "zero"},
            {"type": "mcp", "cost": "zero", "risk": "zero"},
            {
                "type": "browser",
                "cost": "zero",
                "risk": "zero",
                "requires_login": True,
                "public": True,
                "read_only": True,
            },
            {
                "type": "command",
                "risk": "external",
                "cost": "zero",
                "read_only": True,
                "local_only": True,
            },
            {},
        ]:
            self.assertFalse(automatic_binding(binding))
        binding = {
            "id": "safe",
            "type": "command",
            "risk": "zero",
            "cost": "local",
            "read_only": True,
            "local_only": True,
        }
        self.assertTrue(automatic_binding(binding))
        self.assertTrue(authorize_binding(binding, {"automatic": True}))
        self.assertFalse(authorize_binding(binding, {"approved_bindings": ["other"]}))
        self.assertEqual(
            binding_risk({"risk": "zero", "cost": "zero", "external": True}), "external"
        )

    def test_registry_guards_enforced_inside_execute_and_pins_no_unquoted_fallback(self):
        self.binding("keyword.metrics", "paid", risk="zero")
        self.binding("keyword.metrics", "other")
        with patch.object(self.app.registry, "_command", side_effect=self.command):
            result = self.app.registry.execute(
                "keyword.metrics",
                {"keywords": ["sample"]},
                self.root / "auto",
                threading.Event(),
                {"automatic": True},
            )
            self.assertFalse(result["records"])
            self.assertFalse(self.requests)
            result = self.app.registry.execute(
                "keyword.metrics",
                {"keywords": ["sample"]},
                self.root / "manual",
                threading.Event(),
                {"approved_bindings": ["paid"]},
            )
            self.assertEqual([name for name, _ in self.requests], ["paid"])
            self.assertTrue(result["records"])

    def test_batch_20_objects_splits_by_limit_one_model_and_merges_one_card(self):
        basket = self.add()
        self.binding("keyword.metrics", "metrics", 7)
        self.binding("serp.top", "serp", 8)
        self.binding(
            "keyword.judge",
            "judge",
            100,
            cost="local",
            risk="zero",
            read_only=True,
            local_only=True,
        )
        plan = self.app.request(
            "fixture",
            "basket_plan",
            {"ids": [item["id"] for item in basket["items"]], "operation": "check"},
        )
        self.assertEqual(plan["task_count"], 1)
        self.assertEqual(plan["model_calls"], 1)
        self.assertEqual(plan["tools"][0]["calls"], 3)
        self.assertGreater(plan["estimated_tokens"], 0)
        self.assertIsNone(plan["estimated_seconds"])
        with (
            patch.object(self.app.registry, "_command", side_effect=self.command),
            patch.object(self.app, "_tool_model", side_effect=self.model) as model,
        ):
            result = self.app.request("fixture", "basket_execute", {"token": plan["token"]})
            key = result["started"]
            wait(
                lambda: self.state["suggestions"][key]["status"]
                in {"completed", "failed", "stopped"}
            )
        row = self.state["suggestions"][key]
        self.assertEqual(row["status"], "completed", row.get("reason"))
        self.assertEqual(len(row["result"]["records"]), 20)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(
            [len(inputs["keywords"]) for name, inputs in self.requests if name == "metrics"],
            [7, 7, 6],
        )
        self.assertEqual(
            [len(inputs["keywords"]) for name, inputs in self.requests if name == "serp"], [8, 8, 4]
        )
        self.assertEqual(len(self.state["suggestions"]), 1)
        info = self.app.request(
            "fixture", "annotation_lookup", {"objects": [{"type": "keyword", "value": "sample 0"}]}
        )
        self.assertEqual(info["items"][0]["info"]["tier"], "test")
        logs = [
            event
            for event in self.app.journal.view("fixture")["entries"]
            if event["event"] == "batch_complete"
        ]
        self.assertEqual(len(logs), 7)
        self.assertTrue(
            all(
                "provider" in event["details"]
                and "failed" in event["details"]
                and "skipped" in event["details"]
                for event in logs
            )
        )

    def test_plan_is_single_use_and_rejects_stale_basket_binding_and_secondary_bypass(self):
        value = self.add(2)
        binding = self.binding("keyword.metrics", "metrics")
        ids = [item["id"] for item in value["items"]]
        plan = self.app.basket.estimate("fixture", ids, "check")
        binding["batch_limit"] = 1
        with self.assertRaisesRegex(ValueError, "bindings changed"):
            self.app.basket.execute("fixture", plan["token"])
        plan = self.app.basket.estimate("fixture", ids, "copy")
        self.add(3)
        with self.assertRaisesRegex(ValueError, "estimate expired"):
            self.app.basket.execute("fixture", plan["token"])
        self.binding("pool.save", "save", risk="external", external=True)
        plan = self.app.basket.estimate("fixture", ids, "save")
        first = self.app.basket.execute("fixture", plan["token"], plan["token"])
        self.assertTrue(first["secondary_required"])
        self.assertNotEqual(first["confirmation"], plan["token"])
        self.assertFalse(self.requests)

    def test_batch_failure_retains_records_no_replay_and_reports_each_provider(self):
        items = self.add(10)
        self.binding("keyword.metrics", "metrics", 4)
        self.binding("keyword.metrics", "expensive-fallback", 4)
        plan = self.app.basket.estimate("fixture", [item["id"] for item in items["items"]], "check")

        def command(binding, inputs, *args):
            if inputs.get("keywords", [""])[0] == "sample 4":
                self.requests.append((binding["id"], inputs))
                raise RuntimeError("unknown response")
            return self.command(binding, inputs, *args)

        with (
            patch.object(self.app.registry, "_command", side_effect=command),
            patch.object(self.app, "_tool_model", side_effect=self.model),
        ):
            result = self.app.basket.execute("fixture", plan["token"])
            wait(
                lambda: self.state["suggestions"][result["started"]]["status"]
                in {"completed", "failed", "stopped"}
            )
        row = self.state["suggestions"][result["started"]]
        self.assertEqual(len([name for name, _ in self.requests if name == "metrics"]), 3)
        self.assertFalse(any(name == "expensive-fallback" for name, _ in self.requests))
        self.assertTrue(row["result"]["missing"])
        self.assertEqual(row["completion_status"], "partial")

    def test_auto_local_suggestion_uses_no_model_provider_or_pool_write_and_toggle(self):
        with (
            patch.object(self.app, "_tool_model", side_effect=AssertionError("no model")),
            patch.object(self.app.registry, "execute", side_effect=AssertionError("no provider")),
            patch.object(self.app, "_pool", side_effect=AssertionError("no writes")),
        ):
            self.app._replace(
                "fixture",
                {
                    "scene": "general",
                    "suggestions": [
                        {
                            "action": "local.lookup",
                            "params": {"value": "sample"},
                            "title": "Local",
                            "why": "existing data",
                        }
                    ],
                },
            )
            wait(
                lambda: any(
                    row["status"] == "completed" for row in self.state["suggestions"].values()
                )
            )
        row = next(iter(self.state["suggestions"].values()))
        self.assertTrue(row["automatic"])
        self.assertIn("已自动查到", row["result"]["verdict"])
        self.assertEqual(row["tokens"], 0)
        self.app.config["auto_zero"] = False
        self.app._replace(
            "fixture",
            {
                "scene": "general",
                "suggestions": [
                    {
                        "action": "local.lookup",
                        "params": {"value": "other"},
                        "title": "Local",
                        "why": "existing data",
                    }
                ],
            },
        )
        self.assertTrue(
            any(
                row["status"] == "pending"
                for row in self.state["suggestions"].values()
                if row["params"].get("value") == "other"
            )
        )

    def test_explicit_zero_flow_never_uses_even_a_supplied_model_callback(self):
        self.binding(
            "keyword.metrics", "metrics", risk="zero", cost="local", read_only=True, local_only=True
        )
        self.app.packages.flows["read"] = {
            "risk": "zero",
            "judgment": False,
            "steps": [
                {
                    "id": "read",
                    "risk": "zero",
                    "capability": "keyword.metrics",
                    "input": {"keywords": ["sample"]},
                }
            ],
        }
        with (
            patch.object(self.app.registry, "_command", side_effect=self.command),
            patch.object(self.app, "_tool_model", side_effect=AssertionError("no model")) as model,
        ):
            result, stopped = self.app.workflow_runner.run(
                "zero", "read", "sample", {"automatic": True}, self.root / "zero", model
            )
        self.assertFalse(stopped)
        model.assert_not_called()
        self.assertEqual(result["records"][0]["keyword"], "sample")
        self.assertFalse(result["missing"])

    def test_automatic_local_command_has_network_and_outside_write_fences(self):
        captured = []

        class Process:
            returncode = 0

            def poll(inner):
                return 0

        def start(argv, **kwargs):
            captured.append(argv)
            kwargs["stdout"].write(
                json.dumps(
                    {"records": [{"keyword": "sample", "vol": 1, "kd": 2}], "source": "fixture"}
                ).encode()
            )
            kwargs["stdout"].flush()
            return Process()

        self.binding(
            "keyword.metrics", "metrics", risk="zero", cost="local", read_only=True, local_only=True
        )
        with (
            patch("copilot_capabilities.shutil.which", return_value="/fixture/sandbox-exec"),
            patch("copilot_capabilities.subprocess.Popen", side_effect=start),
        ):
            result = self.app.registry.execute(
                "keyword.metrics",
                {"keywords": ["sample"]},
                self.root / "fenced",
                threading.Event(),
                {"automatic": True},
            )
        self.assertTrue(result["records"])
        self.assertIn("(deny network*)", captured[0][2])
        self.assertIn("(deny file-write*)", captured[0][2])
        self.assertIn(str(self.root / "fenced"), captured[0][2])

    def test_external_action_requires_backend_issued_second_receipt(self):
        with self.app.lock, patch.dict(self.state, ready=False):
            self.app.request(
                "fixture",
                "quick_task",
                {"action": "general.task", "params": {"task": "synthetic external operation"}},
            )
        row = next(
            row for row in self.state["suggestions"].values() if row["action"] == "general.task"
        )
        original = self.app.templates.get

        def template(action):
            return (
                {**original(action), "risk": "external"}
                if action == "general.task"
                else original(action)
            )

        with (
            patch.object(self.app.templates, "get", side_effect=template),
            patch.object(self.app, "_execute") as execute,
        ):
            first = self.app.request("fixture", "execute", {"id": row["id"]})
            self.assertTrue(first["secondary_required"])
            execute.assert_not_called()
            rejected = self.app.request(
                "fixture", "execute", {"id": row["id"], "confirmation": "forged"}
            )
            self.assertTrue(rejected["secondary_required"])
            execute.assert_not_called()
            self.app.request(
                "fixture", "execute", {"id": row["id"], "confirmation": first["token"]}
            )
            wait(lambda: execute.called)
        self.assertTrue(row["secondary_confirmed"])

    def test_direct_automatic_workflow_cannot_bypass_risk_or_leave_jobs(self):
        self.app.packages.flows["unknown"] = {
            "risk": "zero",
            "judgment": False,
            "steps": [{"id": "paid", "capability": "keyword.metrics"}],
        }
        with self.assertRaises(ValueError):
            self.app.workflow_runner.run(
                "fake", "unknown", "sample", {"automatic": True}, self.root / "blocked"
            )
        self.assertFalse(self.app.registry.jobs)
        self.assertFalse((self.root / "blocked").exists())

    def test_auto_cache_retains_original_date_and_never_schedules_an_extra_model(self):
        result = {
            "verdict": "已查",
            "keyword": "sample",
            "tier": "test",
            "intent": "fixture",
            "serp": [],
            "reasons": [],
            "level": "info",
            "metrics": [],
            "missing": [],
            "process": [],
            "next": [],
        }
        path = self.app._cache_path(
            {"action": "seo.keyword_check", "params": {"keyword": "sample"}}
        )
        private_write(
            path, json.dumps({"at": time.time() - 3600, "result": result, "model": "fixture"})
        )
        before = path.read_bytes()
        with (
            patch.object(self.app, "_pool", side_effect=AssertionError("no auto write")),
            patch.object(self.app, "_schedule", side_effect=AssertionError("no extra inference")),
        ):
            self.app._replace(
                "fixture",
                {
                    "scene": "seo",
                    "suggestions": [
                        {
                            "action": "seo.keyword_check",
                            "params": {"keyword": "sample"},
                            "title": "Cached",
                            "why": "existing",
                        }
                    ],
                },
            )
            wait(
                lambda: any(
                    row["status"] == "completed" for row in self.state["suggestions"].values()
                )
            )
        self.assertEqual(path.read_bytes(), before)
        self.assertLess(
            self.app.annotation_memory.records["keyword:sample"]["checked_at"], time.time() - 3500
        )

    def test_new_batch_activity_blocks_upgrade_idle_gate_and_settles_without_ledger_reset(self):
        from fbl_runtime import Context, load
        from fbl_update import idle

        home = self.root / "runtime"
        data = home / "plugin-data/fast-browser-link-native"
        (data / "host-bin").mkdir(parents=True)
        self.app.basket.active_path = data / "copilot/basket-active.json"
        cli = load("r16_activity_cli", ROOT / "scripts/install-cli.py")
        cli.EXECUTOR = load("r16_activity_verifier", ROOT / "scripts/install-executor.py")
        context = Context(self.root, self.root / ".hermes", home, ROOT)
        row = {"id": "synthetic-batch", "title": "Synthetic batch", "status": "queued"}
        self.app.basket.activity(row)
        with self.assertRaises(cli.CloudGateError):
            cli.assert_tasks_idle(home)
        with self.assertRaisesRegex(ValueError, "synthetic-batch"):
            idle(context, cli)
        self.app.basket.activity(row, settled=True)
        cli.assert_tasks_idle(home)
        idle(context, cli)
        self.app.basket.activity({**row, "status": "needs_review"})
        with self.assertRaises(cli.CloudGateError):
            cli.assert_tasks_idle(home)
        self.assertTrue(json.loads(self.app.basket.active_path.read_text())["jobs"])

    def test_reviewed_model_change_requires_new_plan(self):
        values = self.add(2)
        ids = [item["id"] for item in values["items"]]
        plan = self.app.basket.estimate("fixture", ids, "check")
        self.assertEqual(plan["model_id"], "fixture")
        self.app.config["inference_model"] = "other-model"
        with self.assertRaisesRegex(ValueError, "bindings changed"):
            self.app.basket.execute("fixture", plan["token"])
        self.assertFalse(self.requests)

    def test_scalar_binding_limit_and_full_model_cost_are_shown_before_calls(self):
        self.binding(
            "keyword.metrics", "scalar", 100, argv=[sys.executable, "-c", "noop", "{keyword}"]
        )
        items = self.add(20)
        plan = self.app.basket.estimate("fixture", [item["id"] for item in items["items"]], "check")
        self.assertEqual(plan["tools"][0]["batch_limit"], 1)
        self.assertEqual(plan["tools"][0]["calls"], 20)
        self.assertFalse(self.requests)

    def test_whole_table_uses_only_unambiguous_object_column(self):
        table = self.app.tables.export_saved(
            "fixture",
            "Synthetic",
            ["Keyword", "Volume", "KD"],
            [[{"text": "sample"}, {"text": "120"}, {"text": "8"}]],
        )
        basket = self.app.basket.add([{"type": "table", "value": table["id"]}])
        items = self.app.basket.chosen([basket["items"][0]["id"]])
        self.assertEqual(self.app.basket.values(items, "check"), [{"keyword": "sample"}])
        unknown = self.app.tables.export_saved(
            "fixture", "Unknown", ["Column A", "Column B"], [[{"text": "one"}, {"text": "two"}]]
        )
        basket = self.app.basket.add([{"type": "table", "value": unknown["id"]}])
        item = next(item for item in basket["items"] if item["value"] == unknown["id"])
        with self.assertRaisesRegex(ValueError, "unambiguous"):
            self.app.basket.values([item], "check")

    def test_table_whole_and_selected_column_persist_copy_export_without_model(self):
        table = self.app.tables.export_saved(
            "fixture",
            "Synthetic",
            ["Keyword", "Domain"],
            [[{"text": "sample"}, {"text": "example.test"}]],
        )
        basket = self.app.basket.add([{"type": "table", "value": table["id"], "columns": [0]}])
        ids = [basket["items"][0]["id"]]
        self.assertEqual(
            self.app.basket.values(self.app.basket.chosen(ids), "check"), [{"keyword": "sample"}]
        )
        self.assertIn("sample", self.app.basket.clipboard(ids))
        self.assertNotIn("example.test", self.app.basket.clipboard(ids))
        self.app.close()
        self.app = Copilot(self.root)
        self.app.config["table_export_dir"] = str(self.root / "exports")
        self.state = self.app._state("fixture")
        self.assertEqual(len(self.app.basket.snapshot()["items"]), 1)
        result = self.app.basket.export("fixture", ids)
        self.assertEqual(len(result["files"]), 2)
        self.assertTrue(
            all(
                Path(file["path"]).is_relative_to(self.root / "exports") for file in result["files"]
            )
        )
        with self.assertRaises(ValueError):
            self.app.basket.add([{"type": "table", "value": "../outside"}])


if __name__ == "__main__":
    unittest.main()
