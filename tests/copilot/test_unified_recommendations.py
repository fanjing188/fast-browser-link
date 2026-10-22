"""所有通用与插件任务共用建议卡片、冷启动配置与十条自动预算。"""

import threading
import time
import unittest
from unittest.mock import patch

import test_workbench as fixtures
from copilot_task_data import process as real_process


class UnifiedRecommendations(unittest.TestCase):
    setUp = fixtures.WorkbenchTest.setUp
    tearDown = fixtures.WorkbenchTest.tearDown
    add = fixtures.WorkbenchTest.add
    plan = fixtures.WorkbenchTest.plan

    def automatic(self, view):
        return [
            r for r in view["suggestions"] if r["status"] == "pending" and not r.get("explicit")
        ]

    def test_first_state_has_material_configuration_cards_without_agent_or_page(self):
        with (
            patch.object(self.app, "_schedule") as schedule,
            patch.object(self.app, "_browser_fetch") as browser,
        ):
            first = self.app.request("browser", "state", {})
        rows = self.automatic(first)
        self.assertEqual(
            {r["task_type"] for r in rows}, {"page.summary", "table.clean", "links.organize"}
        )
        self.assertFalse(first["enabled"])
        self.assertTrue(
            all(r["capture_required"] and r["missing_parameters"] == ["materials"] for r in rows)
        )
        for row in rows:
            self.assertEqual(row["recommendation_state"], "needs_parameters")
            self.assertEqual(
                row["missing_capabilities"], ["agent"] if row["task_type"] == "page.summary" else []
            )
        self.assertTrue(all(r["params"]["materials"] == [] and r["source_url"] == "" for r in rows))
        schedule.assert_not_called()
        browser.assert_not_called()
        self.assertFalse(self.app.workbench.rows("browser"))
        with self.assertRaises(ValueError):
            self.app.request("browser", "execute", {"id": rows[0]["id"]})

    def test_repeated_view_is_idempotent_and_never_reads_material(self):
        first = self.app.view("browser")
        originals = dict(self.app._state("browser")["suggestions"])
        with patch.object(self.app, "_emit", wraps=self.app._emit) as emit:
            second = self.app.view("browser")
            third = self.app.view("browser")
        self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(second["revision"], third["revision"])
        self.assertEqual(first["suggestions"], third["suggestions"])
        emit.assert_not_called()
        for key, original in originals.items():
            self.assertIs(self.app._state("browser")["suggestions"][key], original)

    def test_page_tools_are_local_suggestions_without_implicit_browser_or_model_actions(self):
        state = self.app._state("browser")
        state["page_context"] = {"url": "https://example.test/work", "tab_id": 7}
        with (
            patch.object(self.app, "_schedule") as schedule,
            patch.object(self.app, "_browser_fetch") as browser,
        ):
            first = self.app.view("browser")
            for _ in range(3):
                self.assertEqual(self.app.view("browser")["suggestions"], first["suggestions"])
        native = [r for r in self.automatic(first) if r["action"] == "native.tool"]
        self.assertEqual({r["params"]["tool"] for r in native}, {"tables", "collect", "annotate"})
        self.assertTrue(all(r["local_task"] and r["capture_required"] for r in native))
        self.assertTrue(all(r["recommendation_state"] == "ready" for r in native))
        self.assertTrue(all(r["source_url"] == "https://example.test/work" for r in native))
        self.assertFalse(
            any(
                r["action"] == "native.tool" for r in self.app._resume_context(state)["suggestions"]
            )
        )
        schedule.assert_not_called()
        browser.assert_not_called()

    def test_page_tool_cards_follow_navigation_and_do_not_appear_on_restricted_pages(self):
        state = self.app._state("browser")
        state["page_context"] = {"url": "https://example.test/work"}
        first = {
            r["id"]
            for r in self.automatic(self.app.view("browser"))
            if r["action"] == "native.tool"
        }
        state["page_context"] = {"url": "https://another.test/work"}
        rows = [r for r in self.automatic(self.app.view("browser")) if r["action"] == "native.tool"]
        self.assertEqual(len(rows), 3)
        self.assertTrue(first.isdisjoint(r["id"] for r in rows))
        for url in (
            "edge://extensions",
            "chrome-extension://extension/panel.html",
            "file:///tmp/report.html",
            "",
        ):
            state["page_context"] = {"url": url}
            self.assertFalse(
                any(r["action"] == "native.tool" for r in self.automatic(self.app.view("browser")))
            )

    def test_work_basket_card_only_appears_while_collected_objects_exist(self):
        self.app.basket.items["synthetic"] = {
            "id": "synthetic",
            "type": "url",
            "value": "https://example.test",
        }
        rows = self.automatic(self.app.view("browser"))
        basket = next(r for r in rows if r.get("task_type") == "native.basket")
        self.assertEqual(basket["params"], {"tool": "basket"})
        self.app.basket.items.clear()
        self.assertNotIn(basket["id"], {r["id"] for r in self.automatic(self.app.view("browser"))})

    def test_page_and_table_context_offer_capture_configuration_without_automatic_capture(self):
        state = self.app._state("browser")
        # 中文注释：此例检查对象匹配；未配置Agent的单条准备提示另有回归覆盖。
        state.update(enabled=True, ready=True)
        state["page_context"] = {"url": "https://example.test/report", "tab_id": 7}
        state["table_summary"] = [{"headers": ["ID", "Value"], "rows": 2}]
        rows = self.automatic(self.app.view("browser"))
        types = {r["task_type"] for r in rows}
        self.assertTrue(
            {
                "page.summary",
                "page.question",
                "page.extract",
                "table.clean",
                "table.filter",
                "table.stats",
            }
            <= types
        )
        self.assertFalse(self.app.workbench.rows("browser"))
        table = next(r for r in rows if r["task_type"] == "table.filter")
        self.assertEqual(table["capture_mode"], "table")
        self.assertEqual(table["source_url"], "https://example.test/report")
        self.assertEqual(table["recommendation_state"], "needs_parameters")
        self.assertEqual(table["missing_capabilities"], [])

    def test_navigation_drops_old_hints_and_uses_current_capture_source(self):
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        state["page"] = {
            "url": "https://example.test/pricing",
            "title": "Product pricing reviews",
            "items": [{"role": "heading", "name": "Reviews"}],
        }
        state["page_context"] = {
            "url": "https://example.test/pricing",
            "incognito": False,
            "tab_id": 1,
        }
        self.assertTrue(
            any(r["task_type"] == "page.product" for r in self.automatic(self.app.view("browser")))
        )
        self.app.request(
            "browser",
            "page_context",
            {"url": "https://another.test/plain", "incognito": False, "tab_id": 2},
        )
        rows = self.automatic(self.app.view("browser"))
        self.assertTrue(all(r["source_url"] == "https://another.test/plain" for r in rows))
        self.assertFalse(any(r["task_type"] in {"page.product", "page.reviews"} for r in rows))
        self.assertEqual(state["page"]["title"], "Product pricing reviews")
        state["context_dirty"] = False
        state["page"] = {
            "url": "https://another.test/plain",
            "title": "Product specifications",
            "items": [],
        }
        self.assertTrue(
            any(r["task_type"] == "page.product" for r in self.automatic(self.app.view("browser")))
        )

    def test_ten_recommendations_can_be_snoozed_without_early_feedback_eviction(self):
        state = self.app._state("browser")
        state["user_direction"] = "学习表格和透视、产品评论、版本链接、表单草稿与项目实践"
        state["page_context"] = {"url": "https://example.test/work"}
        dismissed = []
        with patch.object(self.app, "_schedule"):
            for _ in range(10):
                rows = self.automatic(self.app.view("browser"))
                candidate = next(r for r in rows if r["id"] not in dismissed)
                dismissed.append(candidate["id"])
                self.app.request("browser", "feedback", {"id": candidate["id"], "kind": "later"})
        self.assertTrue(
            set(dismissed).isdisjoint(r["id"] for r in self.automatic(self.app.view("browser")))
        )
        self.assertTrue(
            all(f["until"] > time.time() for f in state["work_feedback"] if f["id"] in dismissed)
        )

    def test_feedback_capacity_rejects_without_losing_rows_and_projects_only_eight(self):
        from copilot_state import work_context

        view = self.app.view("browser")
        state = self.app._state("browser")
        row = state["suggestions"][view["suggestions"][0]["id"]]
        state["work_feedback"] = [
            {
                "id": f"prior-{i}",
                "kind": "later",
                "work_id": state["work_id"],
                "until": time.time() + 3600,
                "object": "Previous task",
            }
            for i in range(200)
        ]
        ids = [f["id"] for f in state["work_feedback"]]
        self.assertEqual(len(self.app.view("browser")["work_feedback"]), 8)
        self.assertEqual(len(work_context(state)["feedback"]), 8)
        with (
            patch.object(self.app, "_save_work_memory") as save,
            self.assertRaisesRegex(ValueError, "200"),
        ):
            self.app.request("browser", "feedback", {"id": row["id"], "kind": "later"})
        save.assert_not_called()
        self.assertEqual([f["id"] for f in state["work_feedback"]], ids)
        self.assertIs(state["suggestions"][row["id"]], row)
        state["work_feedback"][0]["until"] = time.time() - 1
        with patch.object(self.app, "_schedule"):
            response = self.app.request("browser", "feedback", {"id": row["id"], "kind": "later"})
        self.assertEqual(len(state["work_feedback"]), 200)
        self.assertEqual(state["work_feedback"][-1]["id"], row["id"])
        self.assertNotIn(row["id"], state["suggestions"])
        self.assertEqual(len(response["work_feedback"]), 8)
        self.assertEqual(len(work_context(state)["feedback"]), 8)

    def test_local_table_tasks_are_ready_without_agent_and_unrelated_tasks_are_absent(self):
        self.add(kind="table", text="ID,Value\n1,0\n2,10", partial=False)
        rows = self.automatic(self.app.view("browser"))
        tasks = {r["task_type"]: r for r in rows}
        for task in ("table.clean", "table.filter", "table.stats"):
            self.assertEqual(tasks[task]["recommendation_state"], "ready")
            self.assertFalse(
                tasks[task]["capture_required"] if "capture_required" in tasks[task] else False
            )
            self.assertEqual(tasks[task]["missing_capabilities"], [])
        self.assertFalse(
            any(r["task_type"].startswith(("learn.", "form.", "image.")) for r in rows)
        )
        self.assertLessEqual(len(rows), 10)

    def test_learning_requires_explicit_direction_and_selection_has_its_own_capture(self):
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        state["page"] = {
            "url": "https://example.test/learn",
            "title": "Learn Python",
            "items": [{"role": "heading", "name": "Learning tutorial"}],
        }
        rows = self.automatic(self.app.view("browser"))
        self.assertFalse(any(r["task_type"].startswith("learn.") for r in rows))
        state["user_direction"] = "学习这个主题并生成自测"
        state["selection_text"] = "Selected source text"
        rows = self.automatic(self.app.view("browser"))
        self.assertTrue(any(r["task_type"] == "learn.quiz" for r in rows))
        explain = next(r for r in rows if r["task_type"] == "text.explain")
        self.assertEqual(explain["capture_mode"], "selection")
        self.assertEqual(explain["missing_parameters"], ["materials"])

    def test_plugin_and_standard_cards_share_ten_budget_with_explicit_and_results_preserved(self):
        state = self.app._state("browser")
        for index in range(30):
            # 中文注释：预算夹具是已登记流程，不是迁移后仅供查看的未知旧任务。
            self.app.packages.flows[f"flow-{index}"] = {
                "name": {"zh": "测试流程", "en": "Fixture flow"},
                "steps": [],
            }
            state["suggestions"][f"plugin-{index}"] = {
                "id": f"plugin-{index}",
                "status": "pending",
                "action": "workflow.run",
                "params": {"flow": f"flow-{index}", "object": "item"},
                "task_type": f"plugin.task{index}",
                "contextual": True,
                "title": "Plugin task",
                "work_id": state["work_id"],
            }
        explicit = {
            "id": "explicit",
            "status": "pending",
            "explicit": True,
            "action": "general.task",
            "params": {"task": "User request"},
            "title": "User request",
        }
        running = {**explicit, "id": "running", "status": "executing"}
        result = {**explicit, "id": "result", "status": "completed"}
        state["suggestions"].update({r["id"]: r for r in (explicit, running, result)})
        view = self.app.view("browser")
        self.assertEqual(len(self.automatic(view)), 10)
        self.assertTrue(all(r["recommendation_section"] == "main" for r in self.automatic(view)))
        for row in (explicit, running, result):
            self.assertIs(state["suggestions"][row["id"]], row)
        self.assertEqual(len(view["suggestions"]), 13)

    def test_hidden_and_snoozed_cards_stay_suppressed_but_explicit_task_is_preserved(self):
        first = self.app.view("browser")
        row = next(r for r in first["suggestions"] if r["task_type"] == "page.summary")
        with patch.object(self.app, "_schedule"):
            self.app.request("browser", "feedback", {"id": row["id"], "kind": "later"})
        self.assertNotIn(row["id"], {r["id"] for r in self.app.view("browser")["suggestions"]})
        state = self.app._state("browser")
        state["work_feedback"][0]["until"] = time.time() - 1
        self.assertIn(row["id"], {r["id"] for r in self.app.view("browser")["suggestions"]})
        material = self.add(kind="text", text="Explicit source", partial=False)
        explicit = self.plan("page.summary", [material])
        self.app.request(
            "browser", "workbench_preference", {"task": "page.summary", "value": "hide"}
        )
        view = self.app.view("browser")
        self.assertIn(explicit["id"], {r["id"] for r in view["suggestions"]})
        self.assertFalse(any(r["task_type"] == "page.summary" for r in self.automatic(view)))

    def test_refresh_preserves_real_execution_row_until_completion(self):
        material = self.add(kind="table", text="ID,Value\n1,0\n2,10", partial=False)
        row = self.plan("table.filter", [material])
        entered, release = threading.Event(), threading.Event()

        def process(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return real_process(*args, **kwargs)

        try:
            with (
                patch("copilot_task_execution.process", side_effect=process),
                patch.object(self.app, "_schedule"),
            ):
                self.app.request("browser", "execute", {"id": row["id"]})
                self.assertTrue(entered.wait(2))
                for _ in range(3):
                    self.app.view("browser")
                    self.assertIs(self.app._state("browser")["suggestions"][row["id"]], row)
                    self.assertEqual(row["status"], "executing")
                release.set()
                deadline = time.monotonic() + 4
                while row["status"] == "executing" and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(row["status"], "completed", row.get("reason"))
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
