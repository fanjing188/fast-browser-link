"""通用任务的真实队列、材料隔离、产物及来源校验回归；不调用模型服务。"""

from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot  # noqa: E402
from copilot_setup import setup  # noqa: E402
from copilot_workbench import Workbench  # noqa: E402


class FakeJudgment:
    closed = False
    runtime = None

    def prepare(self, key):
        pass

    def cancel(self, key):
        pass

    def close(self):
        self.closed = True

    def run(self, key, brief, path, parse, write, **kwargs):
        self.brief = brief
        source = brief["fetched"][0]
        result = {
            "verdict": "材料说明",
            "level": "info",
            "metrics": [],
            "missing": [],
            "process": [],
            "next": [],
            "sections": [
                {
                    "title": "说明",
                    "text": "依据原文整理",
                    "sources": [{"id": source["id"], "evidence_id": source["evidence"][0]["id"]}],
                }
            ],
        }
        return result, {
            "input_tokens": 100,
            "output_tokens": 20,
            "tokens": 120,
            "source": "synthetic_fixture",
        }


class WorkbenchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="assist-workbench-")
        self.directory = Path(self.tmp.name).resolve()
        setup(self.directory)
        self.app = Copilot(self.directory)

    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()

    def add(self, **params):
        return self.app.request("browser", "workbench_add", params)["materials"][-1]["id"]

    def plan(self, task, ids, options=None):
        return self.app.request(
            "browser", "workbench_plan", {"task": task, "materials": ids, "options": options or {}}
        )["card"]

    def finish(self, row):
        self.app.request("browser", "execute", {"id": row["id"]})
        deadline = time.monotonic() + 4
        state = self.app._state("browser")
        while time.monotonic() < deadline:
            actual = state["suggestions"][row["id"]]
            if actual["status"] in {"completed", "failed", "stopped"}:
                return actual
            time.sleep(0.01)
        self.fail("task did not settle")

    def test_local_processing_uses_real_queue_without_agent(self):
        material = self.add(
            kind="table", title="收入", text="Team,Revenue\nA,0\nA,10\nB,\n", partial=False
        )
        row = self.plan(
            "table.stats",
            [material],
            {"group_by": ["Team"], "value": "Revenue", "aggregate": "sum"},
        )
        result = self.finish(row)
        self.assertEqual(result["status"], "completed", result.get("reason"))
        self.assertEqual(result["result"]["records"][0]["aggregate"], 10)
        self.assertIsNone(result["result"]["records"][1]["aggregate"])
        self.assertEqual(result["model_source"], "local")
        for artifact in result["result"]["artifacts"]:
            path = Path(artifact["path"])
            self.assertTrue(path.is_file())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.app.view("browser")["enabled"])

    def test_task_csv_artifact_protects_formula_headers_and_cells(self):
        material = self.add(kind="table", text="=1+1,normal\n=2+2,ok", partial=False)
        row = self.finish(self.plan("table.clean", [material]))
        self.assertEqual(row["status"], "completed", row.get("reason"))
        artifact = next(
            Path(item["path"])
            for item in row["result"]["artifacts"]
            if Path(item["path"]).suffix == ".csv"
        )
        self.assertEqual(
            artifact.read_text(encoding="utf-8-sig").splitlines(), ["'=1+1,normal", "'=2+2,ok"]
        )

    def test_material_owner_and_unknown_task_are_rejected(self):
        material = self.add(kind="text", text="仅此浏览器可用的资料")
        with self.assertRaises(ValueError):
            self.app.request(
                "other", "workbench_plan", {"task": "page.summary", "materials": [material]}
            )
        with self.assertRaises(ValueError):
            self.plan("invented.run", [material])

    def test_compare_requires_explicit_key_and_distinguishes_changes(self):
        a = self.add(kind="table", text="ID,Value\n1,0\n2,2", partial=False)
        b = self.add(kind="table", text="ID,Value\n1,1\n3,3", partial=False)
        plan = self.plan("table.compare", [a, b])
        self.assertEqual(plan["recommendation_state"], "needs_parameters")
        with self.assertRaises(ValueError):
            self.app.request("browser", "execute", {"id": plan["id"]})
        result = self.finish(self.plan("table.compare", [a, b], {"keys": ["ID"]}))
        self.assertEqual(result["status"], "completed", result.get("reason"))
        self.assertEqual(
            [r["status"] for r in result["result"]["records"]], ["changed", "removed", "added"]
        )

    def test_navigation_keeps_collected_snapshot_and_removal_blocks_execution(self):
        material = self.add(
            kind="table", text="ID\n1", source="https://example.test/one", partial=True
        )
        state = self.app._state("browser")
        state["page"] = {"url": "https://example.test/two", "items": []}
        self.app.workbench.refresh("browser")
        self.assertEqual(
            self.app.workbench.chosen("browser", [material])[0]["table"]["records"], [{"ID": "1"}]
        )
        row = self.plan("table.clean", [material])
        self.app.request("browser", "workbench_remove", {"ids": [material]})
        with self.assertRaises(ValueError):
            self.app.request("browser", "execute", {"id": row["id"]})

    def test_partial_input_is_never_full_success(self):
        material = self.add(kind="table", text="ID\n1", partial=True)
        result = self.finish(self.plan("table.clean", [material]))
        self.assertEqual(result["completion_status"], "partial")
        self.assertTrue(result["result"]["missing"])

    def test_single_judgment_has_sources_and_does_not_trust_model_paths(self):
        material = self.add(kind="text", text="此材料用于验证来源，原文有明确内容。", partial=False)
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        fake = FakeJudgment()
        self.app.acp_executions = fake
        row = self.finish(self.plan("page.summary", [material]))
        self.assertEqual(row["status"], "completed", row.get("reason"))
        self.assertTrue(fake.brief["single_judgment"])
        self.assertEqual(fake.brief["action"], "assist.task")
        self.assertEqual(row["verification"]["semantic_accuracy"], "not_independently_verified")
        self.assertEqual(row["result"]["sections"][0]["sources"][0]["id"], material)

    def test_optional_empty_model_table_does_not_fail_page_result_artifacts(self):
        material = self.add(
            kind="text", text="用于验证可选空表格的真实队列合成资料。", partial=False
        )
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        fake = FakeJudgment()
        original = fake.run

        def empty_table(*args, **kwargs):
            result, metrics = original(*args, **kwargs)
            result.update(columns=[], records=[])
            return result, metrics

        fake.run = empty_table
        self.app.acp_executions = fake
        row = self.finish(self.plan("page.summary", [material]))
        self.assertEqual(row["status"], "completed", row.get("reason"))
        self.assertNotIn("records", row["result"])
        self.assertNotIn("columns", row["result"])
        self.assertEqual({r["label"] for r in row["result"]["artifacts"]}, {"JSON", "Markdown"})

    def test_invalid_or_missing_quotes_fail_validation(self):
        material = {"id": "m", "text": "真实原文"}
        for sections in [
            [],
            [{"sources": [{"id": "m", "quote": "编造原文"}]}],
            [{"sources": [{"id": "other", "quote": "真实原文"}]}],
        ]:
            with self.assertRaises(ValueError):
                Workbench.verify_sources({"sections": sections}, [material])

    def test_feedback_suppresses_recommendation_and_learning_is_not_inferred(self):
        self.add(kind="text", text="这是普通材料，无明确学习目标")
        state = self.app._state("browser")
        self.assertFalse(
            any(
                r["task_type"].startswith("learn.")
                for r in state["suggestions"].values()
                if r.get("standard_task")
            )
        )
        row = next(r for r in state["suggestions"].values() if r.get("standard_task"))
        self.app.request("browser", "feedback", {"id": row["id"], "kind": "later"})
        self.app.workbench.refresh("browser")
        self.assertNotIn(row["id"], state["suggestions"])

    def test_study_answer_is_not_automatic_grading_and_memory_clear_removes_it(self):
        state = self.app._state("browser")
        state["suggestions"]["study"] = {
            "id": "study",
            "status": "completed",
            "result": {
                "questions": [
                    {
                        "id": "q",
                        "question": "问题",
                        "answer": "参考",
                        "source_id": "m",
                        "source_quote": "原文",
                    }
                ]
            },
        }
        response = self.app.request(
            "browser",
            "workbench_answer",
            {
                "id": "study",
                "question_id": "q",
                "answer": "我的答案",
                "self_rating": "review",
                "save": True,
            },
        )
        self.assertIsNone(response["feedback"]["correct"])
        self.assertEqual(response["record"]["stage"], "answered")
        self.assertTrue(list((self.directory / "memory").glob("study-*.json")))
        self.app.request("browser", "workbench_clear", {"history": True})
        self.assertFalse(list((self.directory / "memory").glob("study-*.json")))

    def test_materials_are_not_persisted_in_preference_history(self):
        secret = "private synthetic lesson text"
        self.add(kind="text", text=secret)
        self.app.request(
            "browser", "workbench_preference", {"task": "page.summary", "value": "prefer"}
        )
        saved = self.app.workbench.path.read_text()
        self.assertNotIn(secret, saved)
        self.assertIn("page.summary", saved)

    def test_natural_language_returns_validated_preview_without_running_task(self):
        material = self.add(kind="table", text="Revenue\n0\n200", partial=False)
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        fake = FakeJudgment()

        def plan(*args, **kwargs):
            self.assertEqual(args[1]["fetched"][0]["columns"], ["Revenue"])
            self.assertNotIn("records", args[1]["fetched"][0])
            return {
                "options": {"filters": [{"field": "Revenue", "op": "gte", "value": 100}]},
                "explanation": "保留收入至少100的记录",
            }, {
                "tokens": 20,
                "source": "synthetic_fixture",
                "input_tokens": 10,
                "output_tokens": 10,
            }

        fake.run = plan
        self.app.acp_executions = fake
        result = self.app.request(
            "browser",
            "workbench_interpret",
            {"task": "table.filter", "materials": [material], "instruction": "收入至少100"},
        )
        self.assertTrue(result["preview_only"])
        self.assertEqual(result["options"]["filters"][0]["value"], 100)
        self.assertFalse(
            any(r["status"] in {"executing", "completed"} for r in state["suggestions"].values())
        )

    def test_updated_material_invalidates_old_plan_and_preserves_identity(self):
        material = self.add(kind="table", text="ID\n1", partial=False)
        old = self.plan("table.clean", [material])
        snapshot = self.app.request(
            "browser",
            "workbench_update",
            {"id": material, "kind": "table", "text": "ID\n2", "partial": False},
        )
        self.assertEqual(snapshot["materials"][0]["id"], material)
        self.assertEqual(snapshot["materials"][0]["revision"], 2)
        with self.assertRaises(ValueError):
            self.app.request("browser", "execute", {"id": old["id"]})
        new = self.plan("table.clean", [material])
        result = self.finish(new)
        self.assertEqual(result["result"]["records"], [{"ID": "2"}])

    def test_saved_study_is_owner_bound_and_readable_after_reopen(self):
        state = self.app._state("browser")
        state["suggestions"]["study"] = {
            "id": "study",
            "status": "completed",
            "result": {
                "questions": [
                    {
                        "id": "q",
                        "question": "问题",
                        "answer": "参考",
                        "source_id": "m",
                        "source_quote": "原文",
                    }
                ]
            },
        }
        self.app.request(
            "browser",
            "workbench_answer",
            {"id": "study", "question_id": "q", "answer": "答案", "save": True},
        )
        identity = self.app.workbench.snapshot("browser")["study_records"][0]["id"]
        record = self.app.request("browser", "workbench_study_read", {"id": identity})
        self.assertEqual(record["question"], "问题")
        self.assertEqual(record["answer"], "答案")
        with self.assertRaises(ValueError):
            self.app.request("other", "workbench_study_read", {"id": identity})


if __name__ == "__main__":
    unittest.main()
