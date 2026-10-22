"""R24 推理恢复与隐私边界：仅临时目录、合成 ACP 和内存工具配置。"""

import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, private_write, inference_prompt, suggestion_id
from copilot_setup import setup
from copilot_diagnostics import redact_page


class R24Inference(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="r24-infer-")
        self.root = Path(self.temp.name).resolve()
        setup(self.root)
        profile = self.root / "profiles/fast-copilot"
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text("synthetic")
        config = json.loads((self.root / "config.json").read_text())
        config.update(
            hermes_home=str(self.root),
            hermes_command=sys.executable,
            acp_command=[sys.executable, str(ROOT / "tests/copilot/fake-acp.py")],
            exec_transport="oneshot",
            timeout_seconds=3,
            min_interval=0,
            auto_zero=False,
        )
        private_write(self.root / "config.json", json.dumps(config))
        self.app = Copilot(self.root, debounce=0.01)
        self.state = self.app._state("fixture")

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def test_model_cannot_create_unmapped_free_tasks_or_spoof_explicit_authorization(self):
        for action in ("general.task", "unknown.task"):
            with self.subTest(action=action):
                self.app._replace(
                    "fixture",
                    {
                        "scene": "general",
                        "suggestions": [
                            {
                                "id": "invented",
                                "title": "模型自由任务",
                                "why": "猜测",
                                "action": action,
                                "params": {"task": "PRIVATE_TASK"},
                                "explicit": True,
                            }
                        ],
                    },
                )
                self.assertFalse(
                    any(row["action"] == action for row in self.state["suggestions"].values())
                )
                logs = self.app.journal.view("fixture")["entries"]
                self.assertTrue(
                    any(
                        row["details"].get("error_type") == "unmapped_task"
                        and row["details"].get("action") == action
                        for row in logs
                    )
                )
                self.assertNotIn("PRIVATE_TASK", json.dumps(logs))
        for language in ("zh", "en"):
            self.app.templates.language = language
            prompt = inference_prompt({}, self.app.templates)
            self.assertNotIn('"action": "general.task"', prompt)

    def test_model_unlisted_workflow_is_diagnosed_without_borrowing_registered_contract(self):
        with patch.object(
            self.app.packages,
            "catalog",
            return_value=[{"scene": "general", "flow": "registered", "objects": ["sample"]}],
        ):
            self.app._replace(
                "fixture",
                {
                    "scene": "general",
                    "suggestions": [
                        {
                            "title": "未知流程",
                            "why": "模型猜测",
                            "action": "workflow.run",
                            "params": {"flow": "unregistered", "object": "sample"},
                        }
                    ],
                },
            )
        self.assertFalse(
            any(row["action"] == "workflow.run" for row in self.state["suggestions"].values())
        )
        self.assertTrue(
            any(
                row["details"].get("error_type") == "unmapped_task"
                for row in self.app.journal.view("fixture")["entries"]
            )
        )

    def test_legacy_unmapped_pending_is_read_only_and_retained_across_refreshes(self):
        self.state.update(enabled=True, ready=True)
        self.app.config["auto_zero"] = True
        for action in ("general.task", "unknown.task", "workflow.run"):
            key = "legacy-" + action
            arguments = (
                {"flow": "unregistered", "object": "旧对象"}
                if action == "workflow.run"
                else {"task": "旧任务原文"}
            )
            row = {
                "id": key,
                "action": action,
                "params": arguments,
                "title": "旧任务",
                "why": "迁移前建议",
                "status": "pending",
                "page_url": "https://old.example.test/",
                "first_seen": -100,
            }
            original = copy.deepcopy(row)
            self.state["suggestions"][key] = row
            with self.assertRaisesRegex(ValueError, "unmapped_task"):
                self.app.request("fixture", "execute", {"id": key})
            with patch.object(self.app, "request") as request:
                self.app._automatic_suggestions("fixture")
                request.assert_not_called()
            for _ in range(3):
                self.app._replace("fixture", {"scene": "general", "suggestions": []})
            self.assertEqual(self.state["suggestions"][key], {**original, "status": "readonly"})
            displayed = next(r for r in self.app.view("fixture")["suggestions"] if r["id"] == key)
            self.assertTrue(displayed["legacy_unmapped"])
            self.assertEqual(displayed["params"], arguments)

    def test_legacy_read_only_content_is_not_discarded_by_active_card_limit(self):
        for i in range(12):
            key = "legacy-" + str(i)
            self.state["suggestions"][key] = {
                "id": key,
                "action": "general.task",
                "params": {"task": str(i)},
                "title": "旧建议",
                "why": "保留原文",
                "status": "pending",
            }
        for _ in range(2):
            rows = self.app.view("fixture")["suggestions"]
            self.assertEqual(sum(bool(row.get("legacy_unmapped")) for row in rows), 12)
            self.app.workbench.refresh("fixture")
            self.assertTrue(all("legacy-" + str(i) in self.state["suggestions"] for i in range(12)))
            self.app._replace("fixture", {"scene": "general", "suggestions": []})

    def test_explicit_free_task_and_started_contracts_survive_model_refresh_unchanged(self):
        self.state.update(enabled=True, ready=False)
        self.app.request(
            "fixture",
            "quick_task",
            {"action": "general.task", "params": {"task": "用户主动输入的任务"}},
        )
        row = next(
            row for row in self.state["suggestions"].values() if row["action"] == "general.task"
        )
        self.assertTrue(row["explicit"])
        self.assertTrue(row["single_judgment"])
        for status in (
            "pending",
            "queued",
            "executing",
            "stopping",
            "completed",
            "failed",
            "stopped",
        ):
            row["status"] = status
            if status != "pending":
                row.pop("explicit", None)
                row["result"] = {"verdict": "原合同结果"}
            before = copy.deepcopy(row)
            self.app._replace(
                "fixture",
                {
                    "scene": "general",
                    "suggestions": [
                        {
                            "id": row["id"],
                            "title": "模型改写",
                            "why": "模型推测",
                            "action": "general.task",
                            "params": dict(row["params"]),
                            "explicit": True,
                        }
                    ],
                },
            )
            self.assertEqual(self.state["suggestions"][row["id"]], before)
            self.assertFalse(self.app._display_row(row).get("legacy_unmapped"))

    def test_read_only_legacy_task_cannot_be_reinterpreted_by_later_template_registration(self):
        self.state["suggestions"]["old"] = {
            "id": "old",
            "action": "unknown.task",
            "params": {"task": "旧任务"},
            "title": "旧建议",
            "why": "原文",
            "status": "pending",
        }
        self.app.view("fixture")
        with patch.object(self.app.templates, "optional", return_value={"name": "New template"}):
            row = self.state["suggestions"]["old"]
            self.assertTrue(self.app._display_row(row).get("legacy_unmapped"))
            with self.assertRaisesRegex(ValueError, "unmapped_task"):
                self.app.request("fixture", "execute", {"id": "old"})

    def test_catalog_refresh_cannot_reactivate_read_only_workflow_after_installation(self):
        arguments = {"flow": "later-installed", "object": "sample"}
        key = suggestion_id("workflow.run", arguments)
        original = {
            "id": key,
            "action": "workflow.run",
            "params": arguments,
            "title": "旧标题不可改写",
            "why": "旧原因不可改写",
            "status": "pending",
        }
        self.state["suggestions"][key] = copy.deepcopy(original)
        self.app.view("fixture")
        self.assertEqual(self.state["suggestions"][key]["status"], "readonly")
        self.app.packages.flows[arguments["flow"]] = {"steps": []}
        proposal = {
            "params": arguments,
            "title": "新安装流程",
            "why": "新目录原因",
            "available": True,
            "missing_capabilities": [],
            "scene": "general",
        }
        with (
            patch.object(self.app.registry, "recommendations", return_value=[proposal]),
            patch.object(self.app.packages, "catalog", return_value=[]),
        ):
            self.app._refresh_tool_suggestions("fixture")
        self.assertEqual(self.state["suggestions"][key], {**original, "status": "readonly"})
        with patch("copilot.threading.Thread.start") as start:
            with self.assertRaisesRegex(ValueError, "unmapped_task"):
                self.app.request("fixture", "execute", {"id": key})
            start.assert_not_called()

    def test_first_mutating_request_preserves_unmigrated_legacy_text_before_cleanup(self):
        for method, params in (
            ("workbench_add", {"kind": "text", "text": "首次添加的合成材料"}),
            ("page_context", {"url": "https://new.example.test/", "incognito": False}),
            ("work_update", {"reset": True}),
        ):
            with self.subTest(method=method):
                original = {
                    f"legacy-{i}": {
                        "id": f"legacy-{i}",
                        "action": "general.task",
                        "params": {"task": f"旧任务原文{i}"},
                        "title": "旧建议",
                        "why": "不可删除",
                        "status": "pending",
                    }
                    for i in range(12)
                }
                self.state["suggestions"] = copy.deepcopy(original)
                self.app.request("fixture", method, params)
                self.assertTrue(original.keys() <= self.state["suggestions"].keys())
                for key, row in original.items():
                    retained = self.state["suggestions"][key]
                    self.assertEqual(retained["status"], "readonly")
                    for field in ("params", "title", "why"):
                        self.assertEqual(retained[field], row[field])

    def old_suggestion(self):
        return {
            "id": "old-pending",
            "title": "检查 job scheduler SEO ranking",
            "why": "恢复前建议",
            "action": "seo.keyword_check",
            "params": {"keyword": "job scheduler"},
            "status": "pending",
        }

    def test_restart_resume_replays_old_suggestion_content_in_first_inference_not_only_statuses(
        self,
    ):
        state = self.state
        old = self.old_suggestion()
        state["suggestions"] = {old["id"]: old}
        state.update(
            enabled=True,
            epoch=1,
            summary="SYNTHETIC_RESTART_SUMMARY",
            page={
                "url": "https://example.test/",
                "title": "first",
                "items": [{"role": "heading", "name": "job scheduler"}],
            },
            dirty=True,
        )
        state["sent_status"] = {old["id"]: "pending"}
        state["sent_page"] = copy.deepcopy(state["page"])
        state["sent_trace"] = []
        self.app.active = "fixture"
        with patch.object(self.app, "_schedule") as schedule:
            self.assertTrue(self.app._activate("fixture", 1, resume=True))
            schedule.assert_called_once_with("fixture")
        self.assertEqual(state["sent_status"], {})
        self.assertEqual(state["sent_page"], {})
        self.app._infer("fixture", 1)
        requests = [
            json.loads(line) for line in (self.root / "acp-requests.jsonl").read_text().splitlines()
        ]
        texts = [
            request["params"]["prompt"][0]["text"]
            for request in requests
            if request.get("method") == "session/prompt"
        ]
        self.assertTrue(
            any(
                "SYNTHETIC_RESTART_SUMMARY" in text
                and old["title"] in text
                and "job scheduler" in text
                for text in texts
            )
        )
        payloads = []
        for text in texts:
            try:
                payload = json.loads(text)
            except ValueError:
                continue
            if payload.get("type") == "infer":
                payloads.append(payload)
        self.assertEqual(len(payloads), 1)
        payload = payloads[0]
        self.assertEqual(payload["statuses"], {old["id"]: "pending"})
        self.assertEqual(
            payload["suggestions"],
            [{key: old[key] for key in ("id", "title", "why", "action", "params", "status")}],
        )
        self.assertTrue(payload["page"]["items"])
        self.assertFalse(
            any(
                row["event"] == "execute_start"
                for row in self.app.journal.view("fixture")["entries"]
            )
        )

    def test_increment_only_sends_content_for_changed_status_and_does_not_repeat_unchanged(self):
        old = self.old_suggestion()
        self.state["suggestions"] = {old["id"]: old}
        self.state["sent_status"] = {old["id"]: "pending"}
        payload, _ = self.app._increment(self.state)
        self.assertEqual(payload["statuses"], {})
        self.assertEqual(payload["suggestions"], [])
        old["status"] = "completed"
        payload, statuses = self.app._increment(self.state)
        self.assertEqual(payload["statuses"], {old["id"]: "completed"})
        self.assertEqual(payload["suggestions"][0]["params"], old["params"])
        self.assertEqual(statuses, {old["id"]: "completed"})

    def test_empty_model_output_adds_local_lookup_workflows_and_a_visible_fallback_log_without_calls(
        self,
    ):
        self.app.packages.tools.append(
            {
                "id": "fixture",
                "name": "Fixture",
                "hosts": ["fixture.example.test"],
                "pages": [
                    {
                        "id": "overview",
                        "paths": ["^/overview$"],
                        "object_param": "q",
                        "flows": ["fixture-flow"],
                    }
                ],
            }
        )
        self.app.packages.flows["fixture-flow"] = {
            "name": {"zh": "当前页工作流", "en": "Current page workflow"},
            "description": {"zh": "读取本机信息", "en": "Read local evidence"},
            "steps": [],
        }
        self.state["page_context"] = {
            "url": "https://fixture.example.test/overview?q=job+scheduler"
        }
        self.app._refresh_tool_suggestions("fixture")
        self.assertEqual(self.state["tool_context"]["current"]["object"], "job scheduler")
        before = self.state["tokens"]
        with patch.object(
            self.app.registry, "execute", side_effect=AssertionError("unexpected capability call")
        ):
            self.app._replace("fixture", {"scene": "seo", "suggestions": []})
        rows = list(self.state["suggestions"].values())
        lookup = next(row for row in rows if row["action"] == "local.lookup")
        self.assertEqual(lookup["params"], {"type": "keyword", "value": "job scheduler"})
        self.assertTrue(
            any(
                row["action"] == "workflow.run" and row["params"]["flow"] == "fixture-flow"
                for row in rows
            )
        )
        self.assertEqual(self.state["tokens"], before)
        log = next(
            row
            for row in self.app.journal.view("fixture")["entries"]
            if row["event"] == "inference_fallback"
        )
        self.assertEqual(log["summary"], "模型无建议·已用基础建议")

    def test_empty_model_output_without_explicit_object_never_guesses_a_fallback(self):
        self.app._replace("fixture", {"scene": "general", "suggestions": []})
        rows = list(self.state["suggestions"].values())
        self.assertEqual(
            {row["params"].get("task") for row in rows},
            {"page.summary", "table.clean", "links.organize"},
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
        self.assertFalse(
            any(
                row["event"] == "inference_fallback"
                for row in self.app.journal.view("fixture")["entries"]
            )
        )

    def test_titles_preserve_32_characters_and_only_truncate_above_the_boundary(self):
        for title in ("检查 job scheduler SEO ranking", "x" * 32, "x" * 33):
            with self.subTest(title=title):
                self.app._replace(
                    "fixture",
                    {
                        "scene": "general",
                        "suggestions": [
                            {
                                "title": title,
                                "why": "fixture",
                                "action": "local.lookup",
                                "params": {"value": title},
                            }
                        ],
                    },
                )
                row = next(
                    row
                    for row in self.state["suggestions"].values()
                    if row["params"].get("value") == title
                )
                self.assertEqual(row["title"], title if len(title) <= 32 else "x" * 31 + "…")
        prompt = inference_prompt({}, self.app.templates)
        self.assertIn("标题最多32字", prompt)

    def test_model_projection_redacts_tool_pool_summary_and_suggestions_without_mutating_execution(
        self,
    ):
        sensitive = "user@example.test +1 (415) 555-0108 123456789012345678 https://login:pass@example.test/report?token=PRIVATE_TOKEN&api_key=PRIVATE_KEY&session=PRIVATE_SESSION&q=user%40example.test#PRIVATE_FRAGMENT"
        old = self.old_suggestion()
        old["params"] = {"keyword": sensitive}
        old["title"] = sensitive
        self.state["suggestions"] = {old["id"]: old}
        self.state["summary"] = sensitive
        self.state["execution_memory"] = [sensitive]
        self.state["tool_context"] = {
            "current": {"object": sensitive},
            "selection": sensitive,
            "table_summary": [{"headers": [sensitive], "rows": 3}],
            "pool": {"source": sensitive, "token": "PRIVATE_POOL_TOKEN"},
        }
        self.state["page"] = {
            "url": "https://example.test/",
            "title": sensitive,
            "items": [{"role": "heading", "name": sensitive}],
        }
        self.state["trace"] = [{"description": "点击 " + sensitive, "at": 1}]
        original = copy.deepcopy(
            {
                key: self.state[key]
                for key in (
                    "suggestions",
                    "summary",
                    "execution_memory",
                    "tool_context",
                    "page",
                    "trace",
                )
            }
        )
        payload, _ = self.app._increment(self.state)
        resume = self.app._resume_context(self.state)
        for projection in (payload, resume):
            raw = json.dumps(projection)
            for value in (
                "user@example.test",
                "user%40example.test",
                "415",
                "123456789012345678",
                "PRIVATE_TOKEN",
                "PRIVATE_KEY",
                "PRIVATE_SESSION",
                "PRIVATE_POOL_TOKEN",
                "PRIVATE_FRAGMENT",
                "login:pass",
            ):
                self.assertNotIn(value, raw)
        self.assertEqual({key: self.state[key] for key in original}, original)
        self.assertEqual(payload["tool_context"]["table_summary"][0]["rows"], 3)
        self.assertEqual(
            redact_page({"public": "job scheduler", "count": 230}),
            {"public": "job scheduler", "count": 230},
        )


if __name__ == "__main__":
    unittest.main()
