"""通用任务终态重规划、大结果续作和本轮排序合同的集成回归。"""

import copy
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

import test_workbench as fixtures


class TaskIntegration(unittest.TestCase):
    setUp = fixtures.WorkbenchTest.setUp
    tearDown = fixtures.WorkbenchTest.tearDown
    add = fixtures.WorkbenchTest.add
    plan = fixtures.WorkbenchTest.plan

    def finish(self, row):
        self.app.request("browser", "execute", {"id": row["id"]})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            actual = self.app._state("browser")["suggestions"][row["id"]]
            if actual["status"] in {"completed", "failed", "stopped"}:
                self.assertEqual(actual["status"], "completed", actual.get("reason"))
                return actual
            time.sleep(0.01)
        self.fail("local task did not settle")

    def test_material_refresh_replans_terminal_card_and_keeps_old_artifact_owner(self):
        material = self.add(
            kind="table", table={"headers": ["value"], "records": [["original"]]}, partial=False
        )
        first = self.finish(self.plan("table.clean", [material]))
        first_path = first["full_result_file"]
        self.app.request(
            "browser",
            "workbench_update",
            {
                "id": material,
                "kind": "table",
                "table": {"headers": ["value"], "records": [["updated"]]},
                "partial": False,
            },
        )
        planned = self.plan("table.clean", [material])
        state = self.app._state("browser")
        self.assertEqual(planned["id"], first["id"])
        self.assertIs(state["suggestions"][planned["id"]], planned)
        self.assertEqual(planned["material_revisions"], [2])
        self.assertEqual(planned["status"], "pending")
        archived = next(
            r for r in state["result_history"] if r.get("full_result_file") == first_path
        )
        self.assertNotEqual(archived["id"], planned["id"])
        self.assertEqual(archived["artifact_owner_id"], first["id"])
        self.assertEqual(
            self.app.workbench.full_result(archived)["records"], [{"value": "original"}]
        )
        completed = self.finish(planned)
        self.assertNotEqual(completed["full_result_file"], first_path)
        self.assertEqual(completed["result"]["records"], [{"value": "updated"}])
        self.assertEqual(
            self.app.workbench.full_result(archived)["records"], [{"value": "original"}]
        )
        with patch("copilot_workbench.subprocess.run") as opener:
            self.app.request(
                "browser", "workbench_open_artifact", {"id": archived["id"], "index": 0}
            )
        self.assertEqual(Path(opener.call_args.args[0][-1]).parent, Path(first_path).parent)

    def test_large_generated_result_remains_readable_and_continues_all_records(self):
        headers = [f"c{i}" for i in range(50)]
        table = {
            "headers": headers,
            "records": [
                {header: "abcdefghijklmnopqrst" for header in headers} for _ in range(5000)
            ],
        }
        self.assertLess(len(json.dumps(table).encode()), 8 * 1024 * 1024)
        # 中文注释：模拟既有任务生成的宿主材料；外部230KiB上传限制仍由正常入口验收。
        added = self.app.workbench.add(
            "browser", {"kind": "table", "table": table, "partial": False}, internal=True
        )
        material = added["materials"][-1]["id"]
        completed = self.finish(self.plan("table.filter", [material]))
        self.assertTrue(completed["preview_truncated"])
        self.assertLess(len(completed["result"]["records"]), 5000)
        path = Path(completed["full_result_file"])
        self.assertLessEqual(path.stat().st_size, 8 * 1024 * 1024)
        full = self.app.workbench.full_result(completed)
        self.assertEqual(len(full["records"]), 5000)
        # 中文注释：同一合法产物若使用缩进写入会超过读取预算，覆盖原先失配的真实边界。
        self.assertGreater(
            len(json.dumps(full, ensure_ascii=False, indent=2).encode()), 8 * 1024 * 1024
        )
        result = self.app.request("browser", "workbench_from_result", {"id": completed["id"]})
        derived_id = result["materials"][-1]["id"]
        derived = self.app.workbench.chosen("browser", [derived_id])[0]
        self.assertEqual(len(derived["table"]["records"]), 5000)
        self.assertEqual(derived["table"]["records"][-1][headers[-1]], "abcdefghijklmnopqrst")
        self.assertFalse(derived["partial"])

    def test_candidate_order_only_accepts_this_round_allowlist(self):
        material = self.add(
            kind="text", text="Synthetic source for candidate ordering.", partial=False
        )
        for index in range(22):
            self.plan("page.question", [material], {"question": f"Question {index}?"})
        state = self.app._state("browser")
        payload, _ = self.app._increment(state)
        sent = {row["id"] for row in payload["candidates"]}
        self.assertEqual(len(sent), 20)
        outside = next(key for key in state["suggestions"] if key not in sent)
        inside = payload["candidates"][0]["id"]
        self.app._replace(
            "browser",
            {
                "scene": "general",
                "suggestions": [],
                "candidate_order": [outside, "invented", inside, inside],
            },
            candidate_ids=sent,
        )
        self.assertEqual(state["candidate_order"], [inside])
        self.assertIn(outside, state["suggestions"])

    def test_host_candidate_id_survives_redaction_while_description_is_private(self):
        material = self.add(
            kind="text", text="Synthetic source with private account details.", partial=False
        )
        identity = "ab123456789cd123456789ef"
        with patch("copilot_workbench.digest", return_value=identity):
            row = self.plan("page.summary", [material])
        row["why"] = "账户 123456789012 需要核对"
        state = self.app._state("browser")
        payload, _ = self.app._increment(state)
        candidate = next(r for r in payload["candidates"] if r["id"] == identity)
        self.assertEqual(candidate["id"], identity)
        self.assertEqual(candidate["why"], "账户 [number] 需要核对")
        self.assertNotIn("123456789012", candidate["why"])
        self.app._replace(
            "browser",
            {"scene": "general", "suggestions": [], "candidate_order": [candidate["id"]]},
            candidate_ids={r["id"] for r in payload["candidates"]},
        )
        self.assertEqual(state["candidate_order"], [identity])

    def test_catalog_change_during_inference_rejects_whole_old_receipt(self):
        material = self.add(
            kind="text", text="Synthetic source for stale inference.", partial=False
        )
        row = self.plan("page.summary", [material])
        state = self.app._state("browser")
        state.update(enabled=True, ready=True, dirty=True)
        self.app.active = "browser"
        previous_work = copy.deepcopy(state["work"])
        previous_revision = state["context_revision"]

        def prompt(*args, **kwargs):
            identity = next(iter(self.app.packages.flows))
            self.app.packages.flows[identity]["description"] = "Catalog changed during inference"
            return {
                "scene": "general",
                "suggestions": [],
                "candidate_order": [row["id"]],
                "work": {"goal": "Stale goal must be rejected"},
            }

        with (
            patch.object(self.app, "_roll_context", return_value=False),
            patch.object(self.app, "_prompt_json", side_effect=prompt) as inference,
            patch.object(self.app, "_replace", wraps=self.app._replace) as replace,
            patch.object(self.app, "_schedule"),
        ):
            self.app._infer("browser", state["epoch"])
        inference.assert_called_once()
        replace.assert_not_called()
        self.assertEqual(state["context_revision"], previous_revision)
        self.assertEqual(state["work"], previous_work)
        self.assertFalse(state.get("candidate_order"))

    def test_package_reload_invalidates_prior_candidate_order_and_isolates_bad_package(self):
        state = self.app._state("browser")
        state["candidate_order"] = ["prior-candidate"]
        before = state["context_revision"]
        package = self.directory / "extensions" / "broken"
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"id":"broken","version":1,"tools":"invalid"}')
        self.app._reload_tools()
        self.assertGreater(state["context_revision"], before)
        self.assertEqual(state["candidate_order"], [])
        self.assertTrue(self.app.packages.load_errors)
        self.assertTrue(self.app.packages.flows)
        self.assertIs(self.app.registry.packages, self.app.packages)


if __name__ == "__main__":
    unittest.main()
