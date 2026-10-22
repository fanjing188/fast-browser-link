"""宿主派生卡不制造模型增量，轮询不使在途推理过期；全部使用临时夹具。"""

import unittest
from unittest.mock import patch

import test_workbench as fixtures


class HostInferenceContext(unittest.TestCase):
    setUp = fixtures.WorkbenchTest.setUp
    tearDown = fixtures.WorkbenchTest.tearDown
    add = fixtures.WorkbenchTest.add

    def test_initial_view_and_readiness_do_not_advance_work_context(self):
        state = self.app._state("browser")
        revision = state["context_revision"]
        first = self.app.view("browser")
        self.assertEqual(state["context_revision"], revision)
        self.assertTrue(first["suggestions"])
        state.update(enabled=True, ready=False)
        self.app.view("browser")
        state["ready"] = True
        ready = self.app.view("browser")
        self.assertEqual(state["context_revision"], revision)
        summary = next(row for row in ready["suggestions"] if row["task_type"] == "page.summary")
        self.assertEqual(summary["missing_capabilities"], [])

    def test_configuration_cards_do_not_create_model_status_or_candidate_increment(self):
        self.app.view("browser")
        state = self.app._state("browser")
        payload, statuses = self.app._increment(state)
        self.assertEqual(statuses, {})
        self.assertFalse(any(value for key, value in payload.items() if key != "type"))
        self.assertEqual(self.app._resume_context(state)["suggestions"], [])

    def test_real_material_tasks_still_enter_model_increment(self):
        self.add(kind="table", text="ID,Value\n1,0", partial=False)
        state = self.app._state("browser")
        payload, statuses = self.app._increment(state)
        self.assertTrue(statuses)
        self.assertIn("table.clean", {row["task"] for row in payload["candidates"]})
        self.assertTrue(self.app._resume_context(state)["suggestions"])

    def test_view_during_inference_does_not_discard_valid_model_reply(self):
        state = self.app._state("browser")
        state.update(
            enabled=True,
            ready=True,
            dirty=True,
            page={"url": "https://example.test/", "title": "source", "items": []},
        )
        self.app.active = "browser"
        output = {
            "scene": "general",
            "suggestions": [
                {
                    "title": "有效任务",
                    "why": "根据当前资料",
                    "action": "local.lookup",
                    "params": {"value": "整理当前资料"},
                }
            ],
        }

        def respond(*args, **kwargs):
            context_revision = state["context_revision"]
            self.app.view("browser")
            self.assertEqual(state["context_revision"], context_revision)
            return output

        with (
            patch.object(self.app, "_roll_context", return_value=False),
            patch.object(self.app, "_prompt_json", side_effect=respond),
            patch.object(self.app, "_schedule"),
        ):
            self.app._infer("browser", state["epoch"])
        self.assertTrue(
            any(row["action"] == "local.lookup" for row in state["suggestions"].values())
        )
        self.assertFalse(state["running"])

    def test_empty_page_context_clears_old_page_tools_without_capture_or_inference(self):
        state = self.app._state("browser")
        self.app.request(
            "browser",
            "page_context",
            {"url": "https://example.test/report", "incognito": False, "tab_id": 17},
        )
        before = self.app.view("browser")
        self.assertTrue(any(row.get("action") == "native.tool" for row in before["suggestions"]))
        state["page"] = {"url": "https://example.test/report", "title": "Old page", "items": []}
        with (
            patch.object(self.app, "_schedule") as schedule,
            patch.object(self.app, "_browser_fetch") as browser,
        ):
            self.assertEqual(
                self.app.request("browser", "page_context", {"url": "", "incognito": False}),
                {"accepted": True},
            )
            after = self.app.view("browser")
            revision = after["context_revision"]
            self.app.request("browser", "page_context", {"url": "", "incognito": False})
            self.assertEqual(self.app.view("browser")["context_revision"], revision)
        self.assertFalse(any(row.get("action") == "native.tool" for row in after["suggestions"]))
        self.assertEqual(self.app.workbench.context_page(state).get("url"), "")
        schedule.assert_not_called()
        browser.assert_not_called()

    def test_page_context_still_rejects_non_http_sources_and_invalid_clear_flags(self):
        for url in (
            "edge://extensions",
            "chrome-extension://fixture/panel.html",
            "file:///tmp/report.html",
            "https://name:password@example.test/report",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.app.request("browser", "page_context", {"url": url, "incognito": False})
        with self.assertRaises(ValueError):
            self.app.request("browser", "page_context", {"url": "", "incognito": "false"})
