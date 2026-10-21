"""主动跟随离线验收；只使用临时目录和合成工单。"""

import copy
import json
import os
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import test_generic_packs as fixtures
from copilot import Copilot, suggestion_id
from copilot_follow import condition_matches
from copilot_memory import WorkMemory
from copilot_state import work_state

URL = fixtures.URL


class ActiveFollow(unittest.TestCase):
    setUp = fixtures.GenericPacks.setUp
    tearDown = fixtures.GenericPacks.tearDown
    save = fixtures.GenericPacks.save
    proposal = fixtures.GenericPacks.proposal
    assert_only_host_configuration = fixtures.GenericPacks.assert_only_host_configuration

    def application(self):
        app, state = fixtures.GenericPacks.application(self)
        app._tool_model = Mock(
            side_effect=AssertionError("active-follow fixtures must not call a model")
        )
        return app, state

    def trigger(self, triggers):
        self.value["flows"]["support_materials"]["triggers"] = triggers
        return self.save()

    def context(self):
        return {
            "url": URL,
            "tables": [{"headers": ["Case", "Status"], "rows": 1}],
            "dwell_seconds": 20,
            "follow_completed": [
                {
                    "flow": "support_materials",
                    "object": "CS-1001",
                    "status": "completed",
                    "records": [],
                }
            ],
        }

    def matches(self, clause, context=None, selection=""):
        from copilot_capabilities import recognize
        from copilot_follow import follow_matches

        packages = self.trigger(clause)
        context = self.context() if context is None else context
        return follow_matches(
            packages,
            "support_materials",
            context,
            selection,
            recognize(packages.tools, context["url"]) or {},
            "zh",
        )

    def test_five_triggers_hits_misses_and_combinations(self):
        rules = [
            (
                {"page": {"tool": "support-triage-example", "page": "case"}},
                {"page": {"tool": "other", "page": "case"}},
            ),
            (
                {"table_columns": {"all": ["case", "Status"]}},
                {"table_columns": {"all": ["Case", "Absent"]}},
            ),
            ({"selection": {"object": "case_id"}}, {"selection": {"object": "keyword"}}),
            ({"after": {"flow": "support_materials", "status": "completed"}}, None),
            ({"dwell_seconds": 20}, {"dwell_seconds": 21}),
        ]
        for hit, miss in rules:
            with self.subTest(hit=hit):
                self.assertTrue(self.matches([hit], selection="CS-1001"))
                if miss:
                    self.assertFalse(self.matches([miss], selection="CS-1001"))
                else:
                    self.assertFalse(
                        self.matches([hit], {**self.context(), "follow_completed": []})
                    )
        self.assertFalse(
            self.matches([{"selection": {"object": "case_id"}}], selection="not-a-case")
        )
        self.assertTrue(self.matches([{"dwell_seconds": 21}, {"table_columns": {"all": ["Case"]}}]))
        self.assertFalse(self.matches([{"dwell_seconds": 21, "table_columns": {"all": ["Case"]}}]))
        self.assertTrue(self.matches([{"dwell_seconds": 20, "table_columns": {"all": ["Case"]}}]))
        self.assertFalse(
            self.matches(
                [{"table_columns": {"all": ["Case", "Status"]}}],
                {**self.context(), "tables": [{"headers": ["Case"]}, {"headers": ["Status"]}]},
            )
        )

    def test_invalid_contracts_are_rejected(self):
        for triggers in (
            [{}],
            [{"value": "secret"}],
            [{"dwell_seconds": True}],
            [{"dwell_seconds": float("nan")}],
            [{"selection": {"object": 1}}],
            [{"after": {"flow": "absent", "status": "completed"}}],
        ):
            with self.subTest(triggers=triggers), self.assertRaises(ValueError):
                self.trigger(triggers)
        self.trigger([])
        for rule in (
            {"field": "status", "empty": True},
            {"field": "status", "records": "all"},
            {"field": "status", "records": "any", "empty": True, "equals": "open"},
            {"field": "status", "records": "any", "min": 3, "max": 1},
        ):
            self.value["flows"]["support_materials"]["next"] = [
                {"flow": "support_materials", "when": rule}
            ]
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                self.save()

    def test_and_order_cannot_mix_different_selected_and_completed_objects(self):
        after = {"after": {"flow": "support_materials", "status": "completed"}}
        selection = {"selection": {"object": "case_id"}}
        for rule in ({**after, **selection}, {**selection, **after}):
            self.assertFalse(self.matches([rule], selection="CS-1002"))

    def test_dwell_monitor_emits_without_an_observation_or_model_call_and_resets_on_tab(self):
        self.trigger([{"dwell_seconds": 20}])
        app, state = self.application()
        state["page_since"] = app.clock() - 21
        with patch.object(app, "_schedule") as schedule:
            app.tick()
        schedule.assert_not_called()
        self.assertTrue(
            any(row["action"] == "workflow.run" for row in state["suggestions"].values())
        )
        app.request("browser", "page_context", {"url": URL, "incognito": False, "tab_id": 2})
        app._refresh_tool_suggestions("browser")
        self.assertFalse(
            any(row["action"] == "workflow.run" for row in state["suggestions"].values())
        )
        self.assertTrue(all(row.get("capture_required") for row in state["suggestions"].values()))

    def test_host_snapshot_budget_prioritizes_structure_and_caps_heading_levels(self):
        app, _ = self.application()
        page = {
            "url": URL,
            "title": "Summary",
            "items": [
                *[{"role": "form-label", "name": "字段" * 90} for _ in range(30)],
                *[
                    {"role": "heading", "level": level, "name": f"Heading {level}.{i}"}
                    for level in (1, 2, 3)
                    for i in range(8)
                ],
                {"role": "table", "name": "Case / Status"},
                {"role": "selection", "name": "CS-1001"},
            ],
        }
        bounded = app._bounded_page(page)
        self.assertLessEqual(len(json.dumps(bounded, ensure_ascii=False).encode()), 3072)
        self.assertEqual(bounded["items"][0]["role"], "table")
        for level in (1, 2, 3):
            self.assertEqual(sum(item.get("level") == level for item in bounded["items"]), 5)
        self.assertTrue(any(item["role"] == "selection" for item in bounded["items"]))

    def test_deterministic_observation_no_model_and_reason(self):
        self.trigger([{"table_columns": {"all": ["Case", "Status"]}}])
        app, state = self.application()
        state["table_summary"] = self.context()["tables"]
        with patch.object(app, "_schedule") as schedule:
            app.request(
                "browser",
                "observe",
                {
                    "trace": [],
                    "page": {
                        "url": URL,
                        "title": "Updated support",
                        "items": [{"role": "heading", "name": "Case"}],
                    },
                },
            )
        schedule.assert_not_called()
        row = next(iter(state["suggestions"].values()))
        self.assertIn("表格含 Case, Status", row["why"])
        self.assertEqual(row["status"], "pending")

    def test_feedback_completed_ignore_and_model_cannot_bypass(self):
        self.trigger([{"dwell_seconds": 20}])
        app, state = self.application()
        app._replace("browser", {"scene": "support", "suggestions": [self.proposal()]})
        self.assert_only_host_configuration(state)
        state["page_since"] = app.clock() - 21
        app._refresh_tool_suggestions("browser")
        key = next(
            key
            for key, row in state["suggestions"].items()
            if row["action"] == "workflow.run" and row["params"]["flow"] == "support_materials"
        )
        for kind in ("wrong", "later", "done"):
            state["work_feedback"] = []
            app._refresh_tool_suggestions("browser")
            with patch.object(app, "_schedule"):
                app.request("browser", "feedback", {"id": key, "kind": kind})
            app._refresh_tool_suggestions("browser")
            app._replace("browser", {"scene": "support", "suggestions": [self.proposal()]})
            self.assertNotIn(key, state["suggestions"])
        state["work_feedback"] = []
        app._refresh_tool_suggestions("browser")
        state["suggestions"][key]["status"] = "completed"
        app._refresh_tool_suggestions("browser")
        self.assertEqual(state["suggestions"][key]["status"], "completed")
        state["suggestions"] = {}
        app._refresh_tool_suggestions("browser")
        with patch.object(app, "_schedule"):
            app.request("browser", "ignore", {"id": key})
        app._refresh_tool_suggestions("browser")
        self.assertNotIn(key, state["suggestions"])

    def test_merge_dedupe_limit_and_habits_do_not_create_out_of_scene_rows(self):
        flow = self.value["flows"]["support_materials"]
        flow["triggers"] = [{"page": {"tool": "support-triage-example", "page": "case"}}]
        for i in range(14):
            self.value["flows"][f"support_{i}"] = copy.deepcopy(flow)
        self.value["tools"][0]["pages"][0]["flows"] = list(self.value["flows"])
        self.save()
        app, state = self.application()
        app._refresh_tool_suggestions("browser")
        neutral = [row["params"]["flow"] for row in state["suggestions"].values()]
        app.work_memory.record(
            "support-triage-example", "case", "support_13", "case_id", "accepted"
        )
        app._refresh_tool_suggestions("browser")
        rows = list(state["suggestions"].values())
        self.assertEqual(len(rows), 10)
        # 中文注释：点击只表示愿意尝试，不能代替宿主核实的成功证据。
        self.assertEqual([row["params"]["flow"] for row in rows], neutral)
        verified = rows[-1]
        verified["verified_success"] = True
        app._limit_suggestions("browser")
        self.assertEqual(next(iter(state["suggestions"].values()))["id"], verified["id"])
        app._replace("browser", {"scene": "support", "suggestions": [self.proposal()] * 10})
        self.assertEqual(len(state["suggestions"]), 10)
        self.assertTrue(all(row.get("trigger_reason") for row in state["suggestions"].values()))
        state["page_context"]["url"] = "https://other.example.test/cases?q=CS-1001"
        app._refresh_tool_suggestions("browser")
        self.assert_only_host_configuration(state)
        self.assertTrue(
            all(
                row["source_url"] == state["page_context"]["url"]
                for row in state["suggestions"].values()
            )
        )
        payload, _ = app._increment(state)
        self.assertLessEqual(len(payload["habits"]["items"]), 5)
        self.assertIn("不是当前证据", payload["habits"]["notice"])

    def test_next_conditions_any_all_and_missing(self):
        cases = [
            ({"empty": True}, []),
            ({"empty": False}, ["invoice"]),
            ({"equals": "open"}, "open"),
            ({"contains": "voice"}, "invoice"),
            ({"contains": "invoice"}, ["invoice"]),
            ({"min": 2, "max": 4}, 3),
            ({"min": 0}, 0),
            ({"max": 2}, 1),
        ]
        for operator, value in cases:
            rule = {"field": "f", "records": "any", **operator}
            with self.subTest(operator=operator):
                self.assertTrue(condition_matches(rule, [{"f": value}, {}]))
                self.assertFalse(condition_matches({**rule, "records": "all"}, [{"f": value}, {}]))
                self.assertTrue(condition_matches({**rule, "records": "all"}, [{"f": value}]))
                self.assertFalse(condition_matches(rule, []))
                self.assertFalse(condition_matches(rule, [{}]))
        self.assertFalse(
            condition_matches(
                {"field": "n", "records": "any", "min": 0}, [{"n": False}, {"n": "1"}]
            )
        )

    def test_actual_completion_recommends_next_same_object_without_execution(self):
        original = self.value["flows"]["support_materials"]
        original["next"] = [
            {
                "flow": "support_reply_draft",
                "when": {"field": "missing_materials", "records": "all", "empty": False},
            }
        ]
        self.value["flows"]["support_reply_draft"] = {**copy.deepcopy(original), "triggers": []}
        self.value["flows"]["support_reply_draft"].pop("next")
        self.value["tools"][0]["pages"][0]["flows"].append("support_reply_draft")
        self.save()
        app, state = self.application()
        app._refresh_tool_suggestions("browser")
        row = next(iter(state["suggestions"].values()))
        row["status"] = "executing"
        app._execute_workflow("browser", row, state["epoch"], app.config)
        key = suggestion_id("workflow.run", {"flow": "support_reply_draft", "object": "CS-1001"})
        next_row = state["suggestions"][key]
        self.assertTrue(next_row["recommendation_only"])
        self.assertEqual(next_row["status"], "pending")
        app.config["auto_zero"] = True
        with patch.object(app, "request") as request:
            app._automatic_suggestions("browser")
        request.assert_not_called()
        app._record_habit("browser", next_row, "accepted")
        self.assertTrue(
            any(
                h["after"] == "support_materials" and h["flow"] == "support_reply_draft"
                for h in app.work_memory.habits()
            )
        )

    def test_documented_support_overlay_loads_and_chains_after_empty_materials(self):
        document = (fixtures.ROOT / "docs/design/adapter-packs.zh-CN.md").read_text()
        overlay = json.loads(re.findall(r"```json\n(.*?)\n```", document, re.S)[-1])
        self.value["flows"].update(overlay["flows"])
        self.value["tools"][0]["pages"][0]["flows"].append("support_reply_draft")
        cases = json.loads((self.package / "cases.json").read_text())
        cases["CS-1001"]["missing_materials"] = []
        (self.package / "cases.json").write_text(json.dumps(cases))
        self.save()
        app, state = self.application()
        app._refresh_tool_suggestions("browser")
        row = next(iter(state["suggestions"].values()))
        row["status"] = "executing"
        app._execute_workflow("browser", row, state["epoch"], app.config)
        self.assertEqual(row["status"], "completed")
        self.assertTrue(
            any(
                proposal["params"].get("flow") == "support_reply_draft"
                and proposal["status"] == "pending"
                for proposal in state["suggestions"].values()
            )
        )

    def test_memory_privacy_restart_management_and_permissions(self):
        app, state = self.application()
        state["work"] = work_state(
            {
                "goal": "核对材料 CS-1001",
                "evidence": ["RAW_PAGE_TEXT", URL],
                "next_step": "优先整理",
            }
        )
        state["user_direction"] = "优先核对材料"
        state["page"]["items"] = [{"role": "heading", "name": "RAW_PAGE_TEXT"}]
        app._save_work_memory("browser")
        app.work_memory.record(
            "support-triage-example", "case", "support_materials", "case_id", "accepted"
        )
        path = app.directory / "memory/work.json"
        text = path.read_text()
        for secret in ("CS-1001", "RAW_PAGE_TEXT", "?q=", "support.example.test"):
            self.assertNotIn(secret, text)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(path.parent).st_mode & 0o777, 0o700)
        restored = Copilot(app.directory)
        try:
            fresh = restored._state("new-browser")
            self.assertTrue(fresh["work_restored"])
            self.assertEqual(fresh["user_direction"], "优先核对材料")
            self.assertIn("核对材料", fresh["work"]["goal"])
            current = restored.request("new-browser", "memory", {})
            habit = current["habits"][0]["id"]
            restored.request("new-browser", "memory", {"delete": habit})
            self.assertFalse(restored.work_memory.habits())
            restored.request("new-browser", "memory", {"delete": "current"})
            self.assertFalse(fresh["work"]["goal"])
            restored.request("new-browser", "memory", {"clear": True})
            self.assertIsNone(restored.work_memory.restore())
        finally:
            restored.close()


class MemoryStorage(unittest.TestCase):
    def test_expiry_corruption_off_retention_and_no_reads_or_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp).resolve()
            memory = WorkMemory(directory, clock=lambda: 100000)
            state = {"work": work_state({"goal": "核对材料"}), "user_direction": "", "page": {}}
            from copilot_packages import Packages

            packages = Packages(include_builtin=False)
            memory.save_work(state, {}, packages)
            memory.record("tool", "page", "flow", "case_id", "accepted")
            expired = WorkMemory(directory, clock=lambda: 186401)
            self.assertIsNone(expired.restore())
            self.assertEqual(len(expired.snapshot()["history"]), 1)
            expired.manage({"delete": "history:0"})
            self.assertFalse(expired.snapshot()["history"])
            memory.manage({"enabled": False})
            before = (directory / "memory/work.json").read_bytes()
            with patch.object(
                WorkMemory, "_load", side_effect=AssertionError("must not read saved records")
            ):
                off = WorkMemory(directory)
                self.assertIsNone(off.restore())
                off.record("tool", "page", "flow", "case_id", "accepted")
                off.save_work(state, {}, packages)
                self.assertFalse(off.habits())
                self.assertEqual(off.score("tool", "page", "flow"), 0)
            self.assertEqual((directory / "memory/work.json").read_bytes(), before)
            off.manage({"enabled": True})
            self.assertTrue(off.habits())
            off.manage({"enabled": False})
            off.manage({"clear": True})
            off.manage({"enabled": True})
            self.assertFalse(off.habits())
            for content in (
                "{broken",
                "[]",
                '{"habits":[{"tool":"bad"}]}',
                '{"current":{"work":{},"user_direction":"x","at":"y"}}',
            ):
                (directory / "memory/work.json").write_text(content)
                corrupt = WorkMemory(directory)
                self.assertIsNone(corrupt.restore())
                self.assertFalse(corrupt.habits())

    def test_symlink_never_read_or_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            outside = root / "outside"
            outside.write_text("not memory")
            directory = root / "memory"
            directory.mkdir()
            (directory / "work.json").symlink_to(outside)
            memory = WorkMemory(root)
            self.assertIsNone(memory.restore())
            with self.assertRaises(ValueError):
                memory.manage({"clear": True})
            self.assertEqual(outside.read_text(), "not memory")


if __name__ == "__main__":
    unittest.main()
