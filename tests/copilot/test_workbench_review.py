"""独立审阅回归：真实队列验证任务产物、停止、材料数量和IPC边界。"""

import csv
import io
import json
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import test_workbench as fixtures
from copilot_workbench import Workbench


class WorkbenchReview(unittest.TestCase):
    setUp = fixtures.WorkbenchTest.setUp
    tearDown = fixtures.WorkbenchTest.tearDown
    add = fixtures.WorkbenchTest.add
    plan = fixtures.WorkbenchTest.plan
    finish = fixtures.WorkbenchTest.finish

    def test_required_model_products_and_each_section_have_evidence(self):
        material = self.add(
            kind="text", text="Learning source with a verifiable statement.", partial=False
        )
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        self.app.acp_executions = fixtures.FakeJudgment()
        for task in (
            "learn.quiz",
            "learn.flashcards",
            "page.extract",
            "research.compare",
            "organize.specs",
        ):
            with self.subTest(task=task):
                ids = [material]
                if task == "research.compare":
                    ids.append(
                        self.add(
                            kind="text",
                            text="Another source with a different statement.",
                            partial=False,
                        )
                    )
                result = self.finish(self.plan(task, ids))
                self.assertEqual(
                    result["status"],
                    "failed",
                    "a cited section alone cannot satisfy the requested product",
                )
        sources = [{"id": "m", "text": "verifiable source"}]
        with self.assertRaises(ValueError):
            Workbench.verify_sources(
                {
                    "sections": [
                        {
                            "title": "Evidence",
                            "text": "",
                            "sources": [{"id": "m", "quote": "source"}],
                        },
                        {"title": "Claim", "text": "Unsupported factual statement", "sources": []},
                    ]
                },
                sources,
            )

    def test_large_results_use_bounded_preview_and_preserve_full_files(self):
        ids = [
            self.add(
                kind="table",
                table={
                    "headers": ["id", "value"],
                    "records": [{"id": str(i * 150 + j), "value": "x" * 1000} for j in range(150)],
                },
                partial=False,
            )
            for i in range(8)
        ]
        finished = self.finish(self.plan("table.merge", ids))
        self.assertEqual(finished["status"], "completed", finished.get("reason"))
        response = self.app.request("browser", "result", {"id": finished["id"]})
        payload = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode()
        self.assertLess(len(payload), 256 * 1024, "native result transport must remain bounded")
        self.assertTrue(response.get("preview_truncated"))
        self.assertEqual(response.get("result_total_records"), 1200)
        artifacts = {row["label"]: Path(row["path"]) for row in response["result"]["artifacts"]}
        self.assertEqual(len(json.loads(artifacts["JSON"].read_text())["records"]), 1200)
        self.assertEqual(
            len(list(csv.reader(io.StringIO(artifacts["CSV"].read_text(encoding="utf-8-sig"))))),
            1201,
        )
        with ZipFile(artifacts["XLSX"]) as archive:
            sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            self.assertEqual(
                len(
                    sheet.findall(
                        ".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"
                    )
                ),
                1201,
            )
        continued = self.app.request("browser", "workbench_from_result", {"id": finished["id"]})
        next_id = continued["materials"][-1]["id"]
        next_material = self.app.workbench.chosen("browser", [next_id])[0]
        if len(next_material["table"]["records"]) != 1200:
            self.assertTrue(
                next_material["partial"],
                "continuing a preview must not claim to contain the full result",
            )

    def test_compare_join_reject_three_materials_before_execution(self):
        ids = [self.add(kind="table", text=f"id,value\n{i},0", partial=False) for i in range(3)]
        for task in ("table.compare", "table.join"):
            with self.subTest(task=task), self.assertRaises(ValueError):
                self.plan(task, ids, {"keys": ["id"]})
        state = self.app._state("browser")
        self.app.workbench.refresh("browser")
        for row in state["suggestions"].values():
            if row.get("task_type") in {"table.compare", "table.join"}:
                self.assertEqual(len(row["material_ids"]), 2)

    def test_stop_before_workbench_entry_never_starts_new_model_pool(self):
        entered, release = threading.Event(), threading.Event()
        fake, calls = fixtures.FakeJudgment(), []
        original_judgment = fake.run

        def judgment(*args, **kwargs):
            calls.append("provider_started")
            return original_judgment(*args, **kwargs)

        fake.run = judgment
        original_workbench = self.app.workbench.run

        def delayed(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("review synchronization timed out")
            return original_workbench(*args, **kwargs)

        self.app.workbench.run = delayed
        material = self.add(
            kind="text", text="Synthetic source for stop race verification.", partial=False
        )
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        row = self.plan("page.summary", [material])
        factory = Mock()
        factory.executions.return_value = fake
        try:
            with patch("copilot_adapters.adapter", return_value=factory):
                self.app.request("browser", "execute", {"id": row["id"]})
                self.assertTrue(entered.wait(2))
                self.assertIsNone(self.app.acp_executions)
                self.app.request("browser", "stop", {"id": row["id"]})
                release.set()
                deadline = time.monotonic() + 3
                while (
                    state["suggestions"][row["id"]]["status"] != "stopped"
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.005)
                self.assertEqual(state["suggestions"][row["id"]]["status"], "stopped")
                self.assertFalse(
                    factory.executions.called, "stop must precede creating any new model pool"
                )
                self.assertEqual(calls, [])
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
