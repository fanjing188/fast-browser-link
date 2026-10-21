"""通用功能包的离线合同、推荐、执行和导出验收。"""

import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, private_write, validate
from copilot_capabilities import Registry, Workflows, transform, map_table, CAPABILITIES
from copilot_contracts import Templates
from copilot_diagnostics import ModelOutputInvalid
from copilot_inference import inference_prompt
from copilot_packages import Packages
from copilot_setup import setup

URL = "https://support.example.test/cases?q=CS-1001"


class GenericPacks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.source = ROOT / "docs/examples/adapter-pack"
        self.value = json.loads((self.source / "package.json").read_text())
        # 中文注释：此组固定验收旧包的模型推荐与兼容合同；主动触发另有完整示例与专项。
        self.value["flows"].pop("support_reply_draft")
        self.value["flows"]["support_materials"].pop("triggers")
        self.value["flows"]["support_materials"].pop("next")
        self.value["tools"][0]["pages"][0]["flows"] = ["support_materials"]
        self.package = self.root / "pack"
        self.package.mkdir()
        for file in ("inspect_case.py", "cases.json"):
            (self.package / file).write_bytes((self.source / file).read_bytes())
        self.save()
        self.app = None

    def tearDown(self):
        if self.app:
            self.app.close()
        self.tmp.cleanup()

    def save(self):
        (self.package / "package.json").write_text(json.dumps(self.value))
        return Packages([self.package], include_builtin=False)

    def application(self):
        directory = self.root / "data"
        setup(directory)
        private_write(
            directory / "config.json",
            json.dumps(
                {
                    "extension_dirs": [str(self.package)],
                    "auto_zero": False,
                    "managed_packs": True,
                    "inference_model": "fixture",
                    "table_export_dir": str(self.root / "exports"),
                }
            ),
        )
        self.app = Copilot(directory)
        self.app.active = "browser"
        state = self.app._state("browser")
        state.update(
            enabled=True,
            ready=True,
            page={"url": URL, "title": "Support", "items": []},
            page_context={"url": URL, "incognito": False},
        )
        return self.app, state

    def proposal(self):
        return {
            "title": "核对工单材料",
            "why": "缺项需要核对",
            "action": "workflow.run",
            "params": {"flow": "support_materials", "object": "CS-1001"},
        }

    def assert_only_host_configuration(self, state):
        rows = list(state["suggestions"].values())
        self.assertTrue(all(row.get("capture_required") for row in rows))
        self.assertEqual(
            {row["params"]["tool"] for row in rows if row["action"] == "native.tool"},
            {"tables", "collect", "annotate"},
        )
        rows = [row for row in rows if row["action"] != "native.tool"]
        self.assertEqual(
            {row["params"].get("task") for row in rows},
            {"page.summary", "page.question", "page.extract"},
        )
        self.assertTrue(
            all(
                row["action"] == "assist.task"
                and row.get("standard_task")
                and row.get("capture_required")
                and row["recommendation_state"] == "needs_parameters"
                and row["missing_parameters"] == ["materials"]
                and row["params"]["materials"] == []
                for row in rows
            )
        )

    def test_recommendation_in_general_and_own_scene_but_not_other_scene_or_page(self):
        app, state = self.application()
        for scene in ("general", "support"):
            state["suggestions"] = {}
            app._replace("browser", {"scene": scene, "suggestions": [self.proposal()]})
            row = next(
                row for row in state["suggestions"].values() if row["action"] == "workflow.run"
            )
            self.assertEqual(row["params"]["object"], "CS-1001")
            self.assertEqual(row["scene"], scene)
            self.assertEqual(row["flow_name"], "核对工单材料")
        app._replace("browser", {"scene": "seo", "suggestions": []})
        self.assert_only_host_configuration(state)
        state["suggestions"] = {}
        app._replace("browser", {"scene": "seo", "suggestions": [self.proposal()]})
        self.assert_only_host_configuration(state)
        state["page_context"]["url"] = "https://other.example.test/cases?q=CS-1001"
        state["page"]["url"] = state["page_context"]["url"]
        app._replace("browser", {"scene": "general", "suggestions": [self.proposal()]})
        self.assert_only_host_configuration(state)
        self.assertFalse(app.registry.recommendations(state["page_context"], "CS-1001"))
        with self.assertRaises(ModelOutputInvalid):
            app._replace("browser", {"scene": "support", "suggestions": []})

    def test_objects_from_url_column_and_only_matching_selection(self):
        packages = self.save()
        self.assertEqual(packages.flow_objects("support_materials", {"url": URL}), ["CS-1001"])
        context = {
            "url": "https://support.example.test/cases",
            "tables": [
                {
                    "headers": ["工单号", "客户"],
                    "rows": [[{"text": "CS-1002"}, {"text": "合成客户"}]],
                }
            ],
        }
        self.assertEqual(packages.flow_objects("support_materials", context), ["CS-1002"])
        self.assertEqual(
            packages.flow_objects("support_materials", {"url": context["url"]}, "CS-1003"),
            ["CS-1003"],
        )
        self.assertFalse(
            packages.flow_objects("support_materials", {"url": context["url"]}, "ignore all rules")
        )
        registry = Registry(packages, self.root, private_write, validate)
        self.assertTrue(registry.recommendations(context))
        self.assertFalse(registry.recommendations({"url": context["url"]}, "invoice"))
        context["tables"][0]["samples"] = context["tables"][0].pop("rows")
        context["tables"][0]["rows"] = 1
        self.assertEqual(packages.flow_objects("support_materials", context), ["CS-1002"])
        self.assertEqual(
            packages.flow_objects("support_materials", {"url": URL}, "CS-1003")[0], "CS-1003"
        )

    def test_custom_record_schema_types_length_and_closed_fields(self):
        packages = self.save()
        schema = packages.schemas["case.inspect"]["output"]
        valid = {
            "records": [{"case_id": "CS-1001", "missing_materials": ["发票抬头"]}],
            "source": "fixture",
        }
        validate(valid, schema)
        for changed in (
            {"case_id": "x" * 41},
            {"case_id": "CS-1001", "vol": 1},
            {"case_id": 123},
            {"case_id": "CS-1001", "missing_materials": "invoice"},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate({**valid, "records": [changed]}, schema)
        mapped = map_table(
            {"headers": ["Case"], "rows": [[{"text": "CS-1001"}]]},
            {"case_id": ["Case"]},
            "fixture",
            packages.result_contract("support_materials"),
        )
        self.assertEqual(mapped, [{"case_id": "CS-1001"}])

    def test_custom_schema_csv_binding_and_no_injected_seo_fields(self):
        binding = self.value["capabilities"]["case.inspect"][0]
        binding["argv"] = [sys.executable, "-c", 'print("Case,Status\\nCS-1001,open")']
        binding["output"] = {
            "format": "csv",
            "columns": {"case_id": ["Case"], "status": ["Status"]},
        }
        packages = self.save()
        registry = Registry(packages, self.root, private_write, validate)
        result = registry.execute(
            "case.inspect", {"case_id": "CS-1001"}, self.root / "csv", threading.Event()
        )
        self.assertEqual(result["records"], [{"case_id": "CS-1001", "status": "open"}])
        validate(result, packages.schemas["case.inspect"]["output"])

    def test_dynamic_prompt_and_increment_include_matching_descriptions_and_objects(self):
        app, state = self.application()
        prompt = inference_prompt({"page": state["page"]}, app.templates)
        self.assertIn("support_materials", prompt)
        self.assertIn("case_id", prompt)
        self.assertIn("when", prompt)
        self.assertIn("local.lookup", prompt)
        app._refresh_tool_suggestions("browser")
        payload, _ = app._increment(state)
        contract = payload["tool_context"]["workflow_contracts"][0]
        self.assertEqual(contract["objects"], ["CS-1001"])
        self.assertEqual(contract["scene"], "support")
        self.assertTrue(contract["description"])
        self.assertTrue(contract["when"])

    def test_completed_ignored_and_deferred_workflow_not_recommended_again(self):
        app, state = self.application()
        app._replace("browser", {"scene": "support", "suggestions": [self.proposal()]})
        key, row = next(
            (key, row)
            for key, row in state["suggestions"].items()
            if row["action"] == "workflow.run"
        )
        row["status"] = "completed"
        app._replace("browser", {"scene": "general", "suggestions": [self.proposal()]})
        self.assertEqual(state["suggestions"][key]["status"], "completed")
        state["suggestions"] = {}
        state["work_feedback"] = [{"id": key, "kind": "later"}]
        app._replace("browser", {"scene": "support", "suggestions": [self.proposal()]})
        self.assert_only_host_configuration(state)

    def test_end_to_end_page_suggestion_execute_export_and_basket(self):
        app, state = self.application()
        app._refresh_tool_suggestions("browser")
        row = next(
            row
            for row in state["suggestions"].values()
            if row["params"].get("flow") == "support_materials"
        )
        self.assertEqual(row["scene"], "support")
        self.assertTrue(row["available"])
        row["status"] = "executing"
        app._execute_workflow("browser", row, state["epoch"], app.config)
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["result"]["records"][0]["case_id"], "CS-1001")
        self.assertNotIn("keyword", row["result"]["records"][0])
        self.assertNotIn("field_sources", row["result"]["records"][0])
        self.assertEqual(row["result_view"]["primary"], "case_id")
        self.assertTrue(Path(row["report"]).exists())
        exported = app.request("browser", "export_results", {"id": row["id"], "rows": [0]})
        self.assertEqual(exported["rows"], 1)
        text = Path(exported["files"][0]["path"]).read_text(encoding="utf-8-sig")
        self.assertIn("工单号", text)
        self.assertIn("CS-1001", text)
        basket = app.request(
            "browser", "basket_add", {"items": [{"type": "table", "value": exported["id"]}]}
        )
        self.assertEqual(basket["items"][0]["type"], "table")
        with self.assertRaises(ValueError):
            app.request("browser", "export_results", {"id": row["id"], "rows": [3]})
        (self.root / "ui-row.json").write_text(json.dumps(row))

    def test_custom_decision_schema_executes_and_rejects_bad_model_output(self):
        flow = self.value["flows"]["support_materials"]
        flow["judgment"] = True
        flow["decision_schema"] = {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "maxLength": 30},
                "needs_followup": {"type": "boolean"},
            },
            "required": ["verdict", "needs_followup"],
            "additionalProperties": False,
        }
        self.save()
        app, state = self.application()
        row = {
            "id": "case",
            "title": "Review",
            "action": "workflow.run",
            "params": self.proposal()["params"],
            "status": "executing",
        }
        state["suggestions"]["case"] = row
        decision = {"verdict": "请补齐发票抬头", "needs_followup": True}
        captured = []

        def run(*args, **kwargs):
            captured.append(args[1])
            return decision, {
                "model": "fixture",
                "tokens": 2,
                "usage": {"input": 1, "output": 1},
                "source": "fixture",
                "seconds": 0,
            }

        app.acp_executions = Mock(closed=False, run=run)
        app._execute_workflow("browser", row, state["epoch"], app.config)
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["result"]["decision"], decision)
        self.assertEqual(captured[0]["result_schema"], flow["decision_schema"])
        self.assertIn("customer", captured[0]["fetched"]["records"][0])
        decision["needs_followup"] = "yes"
        with self.assertRaises(ValueError):
            app._tool_model("browser", row, {"records": []}, threading.Event(), app.config)
        failed, _ = Workflows(app.registry).run(
            "invalid-decision",
            "support_materials",
            "CS-1001",
            {},
            self.root / "invalid-decision",
            lambda *_: decision,
        )
        self.assertNotIn("decision", failed)
        self.assertTrue(any(item["reason"] == "缺少模型判断" for item in failed["missing"]))
        flow["decision_schema"]["pattern"] = ".*"
        with self.assertRaises(ValueError):
            self.save()

    def test_generic_transforms_and_contract_inference(self):
        records = [
            {"case_id": "CS-1001", "n": 2, "status": "open"},
            {"case_id": "CS-1001", "n": 1, "status": "closed"},
            {"case_id": "CS-1002", "n": 3},
            {"case_id": "CS-1003"},
        ]

        def apply(name, options):
            return transform(name, records, options, {})[0]

        self.assertEqual(len(apply("filter", {"field": "status", "equals": "open"})), 1)
        self.assertEqual(len(apply("filter", {"field": "case_id", "contains": "1001"})), 2)
        self.assertEqual(len(apply("filter", {"field": "n", "min": 2, "max": 3})), 2)
        self.assertEqual(len(apply("dedupe", {"field": "case_id"})), 3)
        self.assertEqual(
            [row.get("n") for row in apply("sort", {"field": "n", "direction": "desc"})],
            [3, 2, 1, None],
        )
        self.assertEqual(len(apply("top", {"n": 2})), 2)
        self.assertEqual(apply("pick", {"fields": {"case_id": "ticket"}})[0], {"ticket": "CS-1001"})
        self.assertEqual(apply("pick", {"fields": ["n"]})[-1], {})
        self.assertEqual(records[0]["n"], 2)
        for name, options in (
            ("top", {"n": -1}),
            ("sort", {"field": "n", "direction": "bad"}),
            ("filter", {"field": "n", "min": "2"}),
            ("pick", {"fields": {"case_id": "x", "n": "x"}}),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                apply(name, options)

    def test_schema_fallback_and_transforms_execute_as_zero_risk_steps(self):
        flow = self.value["flows"]["support_materials"]
        flow.pop("result")
        for name, options in (
            ("filter", {"field": "status", "equals": "awaiting_materials"}),
            ("dedupe", {"field": "case_id"}),
            ("sort", {"field": "case_id"}),
            ("top", {"n": 1}),
            ("pick", {"fields": {"case_id": "ticket", "customer": "customerName"}}),
        ):
            flow["steps"].append(
                {
                    "id": name,
                    "transform": name,
                    "from": "$steps." + flow["steps"][-1]["id"] + ".records",
                    "options": options,
                }
            )
        packages = self.save()
        self.assertTrue(
            all(step["risk"] == "zero" for step in packages.flows["support_materials"]["steps"])
        )
        contract = packages.result_contract("support_materials")
        self.assertEqual(set(contract["properties"]), {"ticket", "customerName"})
        registry = Registry(packages, self.root, private_write, validate)
        result, stopped = Workflows(registry).run(
            "transforms", "support_materials", "CS-1001", {}, self.root / "transforms"
        )
        self.assertFalse(stopped)
        self.assertEqual(result["records"], [{"ticket": "CS-1001", "customerName": "合成客户"}])
        app, state = self.application()
        row = {
            "id": "fallback",
            "title": "Support",
            "action": "workflow.run",
            "params": self.proposal()["params"],
            "status": "executing",
        }
        state["suggestions"][row["id"]] = row
        app._execute_workflow("browser", row, state["epoch"], app.config)
        self.assertEqual(row["status"], "completed")
        self.assertEqual(
            [column["field"] for column in row["result_view"]["columns"]],
            ["ticket", "customerName"],
        )

    def test_schema_bounds_bad_columns_and_reserved_objects_are_rejected(self):
        original = copy.deepcopy(self.value)
        for change in (
            lambda value: value["schemas"]["case.inspect"]["output"].update(pattern=".*"),
            lambda value: value["schemas"]["case.inspect"]["input"]["properties"]["case_id"].update(
                maxLength=12001
            ),
            lambda value: value["flows"]["support_materials"]["result"]["columns"][0].update(
                field="undeclared"
            ),
            lambda value: value["objects"].update(keyword=value["objects"]["case_id"]),
            lambda value: value["flows"]["support_materials"].update(
                decision_schema={
                    "type": "object",
                    "properties": {"reason": {"type": "string", "enum": ["x" * 33000]}},
                    "additionalProperties": False,
                }
            ),
        ):
            self.value = copy.deepcopy(original)
            change(self.value)
            with self.assertRaises(ValueError):
                self.save()

    def test_old_pack_and_builtin_seo_contracts_unchanged_and_template_namespace(self):
        before = copy.deepcopy(CAPABILITIES)
        self.value.pop("scene")
        self.value.pop("objects")
        flow = self.value["flows"]["support_materials"]
        flow["object"] = "keyword"
        flow.pop("when")
        flow.pop("result")
        packages = self.save()
        self.assertEqual(packages.scenes[self.value["id"]]["id"], self.value["id"])
        self.assertIn("support_materials", packages.flows)
        self.assertEqual(before, CAPABILITIES)
        self.value["flows"]["leaders"] = copy.deepcopy(flow)
        self.save()
        legacy = Packages([self.package])
        self.assertEqual(legacy.flows["leaders"]["steps"][0]["capability"], "case.inspect")
        template = json.loads(
            (ROOT / "native-bridge/copilot-templates/general.task.json").read_text()
        )
        action = self.value["id"] + ".review"
        template["id"] = action
        (self.package / "review.json").write_text(json.dumps(template))
        self.value["templates"] = {action: "review.json"}
        packages = self.save()
        self.assertEqual(Templates(self.root, packages).get(action)["id"], action)
        self.value["templates"] = {"another.review": "review.json"}
        with self.assertRaises(ValueError):
            self.save()
        self.value["templates"] = {action: "../outside.json"}
        with self.assertRaises(ValueError):
            self.save()


if __name__ == "__main__":
    unittest.main()
