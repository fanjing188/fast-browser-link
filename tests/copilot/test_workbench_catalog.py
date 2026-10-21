"""36任务真实队列覆盖：模型与OCR使用明确回执fixture，本地表格运行真实计算。"""

import base64
import json
import struct
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-bridge"))
import test_workbench as fixtures
from copilot_task_catalog import CATALOG


class CatalogJudgment(fixtures.FakeJudgment):
    def __init__(self):
        self.calls = []

    def run(self, key, brief, path, parse, write, **kwargs):
        task = brief["params"]["task"]
        self.calls.append(task)
        refs = []
        for material in brief["fetched"]:
            refs.append({"id": material["id"], "evidence_id": material["evidence"][0]["id"]})
        result = {
            "verdict": "合成回执已校验",
            "level": "info",
            "metrics": [],
            "missing": [],
            "process": [],
            "next": [],
            "sections": [
                {"title": "来源", "text": "仅根据合成材料整理的测试回执。", "sources": refs}
            ],
        }
        if task in {"learn.quiz", "learn.flashcards"}:
            result["questions"] = [
                {
                    "id": "question-1",
                    "question": "材料包含什么？",
                    "answer": "合成材料内容。",
                    "source_id": refs[0]["id"],
                    "source_evidence_id": refs[0]["evidence_id"],
                }
            ]
        if task in {"page.extract", "organize.specs", "research.compare", "form.preview"}:
            result.update(
                columns=["material", "value"],
                records=[{"material": ref["id"], "value": ref["evidence_id"]} for ref in refs],
            )
        return result, {
            "input_tokens": 100,
            "output_tokens": 20,
            "tokens": 120,
            "source": "synthetic_fixture",
        }


def white_png():
    """生成有效空白PNG；文字和bbox由测试mock提供，绝不作为真实OCR证据。"""

    def chunk(kind, value):
        return (
            struct.pack(">I", len(value))
            + kind
            + value
            + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        )

    width, height = 1000, 400
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\x00" + b"\xff" * (3 * width)) * height))
        + chunk(b"IEND", b"")
    )


class CatalogQueue(unittest.TestCase):
    setUp = fixtures.WorkbenchTest.setUp
    tearDown = fixtures.WorkbenchTest.tearDown
    add = fixtures.WorkbenchTest.add
    plan = fixtures.WorkbenchTest.plan
    finish = fixtures.WorkbenchTest.finish

    def test_every_registered_task_prepares_and_runs_through_execution_queue(self):
        # 中文注释：本例只覆盖任务执行队列，后台推荐推理不应启动真实Agent。
        self.app._schedule = Mock()
        text = self.add(
            kind="text",
            text="A synthetic lesson with supported evidence and https://example.test/path",
            partial=False,
        )
        other = self.add(
            kind="text",
            text="Another synthetic lesson with a different supported statement.",
            partial=False,
        )
        table = self.add(kind="table", text="id,value\n1,0\n2,10", partial=False)
        second_table = self.add(kind="table", text="id,value\n1,2\n3,4", partial=False)
        image = self.add(kind="image", image=base64.b64encode(white_png()).decode(), partial=False)
        state = self.app._state("browser")
        state.update(enabled=True, ready=True)
        self.app.active = "browser"
        judgment = CatalogJudgment()
        self.app.acp_executions = judgment
        observations = [
            {"text": value, "confidence": 1, "x": x, "y": y, "width": 0.1, "height": 0.05}
            for value, x, y in (
                ("Item", 0.05, 0.1),
                ("Qty", 0.65, 0.1),
                ("Alpha", 0.05, 0.3),
                ("12", 0.65, 0.3),
                ("Beta", 0.05, 0.5),
                ("0.00", 0.65, 0.5),
            )
        ]
        completed = []
        for task, spec in CATALOG.items():
            with self.subTest(task=task):
                ids = {
                    "table": [table],
                    "tables": [table, second_table],
                    "text": [text],
                    "texts": [text, other],
                    "image": [image],
                }[spec["subject"]]
                options = (
                    {"keys": ["id"]}
                    if task in {"table.compare", "table.join"}
                    else {"pivot": "id"}
                    if task == "table.pivot"
                    else {"value": "value", "aggregate": "sum"}
                    if task == "table.stats"
                    else {"question": "What does the source support?"}
                    if task == "page.question"
                    else {"answers": "A synthetic answer."}
                    if task == "learn.feedback"
                    else {"headers": ["Item", "Qty"], "cuts": [0, 0.5, 1], "skip_rows": 1}
                    if task == "image.table"
                    else {}
                )
                if spec["subject"] == "image":
                    response = subprocess.CompletedProcess(
                        ["fixture-ocr"], 0, json.dumps(observations), ""
                    )
                    with (
                        patch("copilot_workbench.sys.platform", "darwin"),
                        patch(
                            "copilot_task_execution.subprocess.run", return_value=response
                        ) as ocr,
                    ):
                        planned = self.plan(task, ids, options)
                        self.assertEqual(planned["recommendation_state"], "ready")
                        actual = self.finish(planned)
                        self.assertEqual(ocr.call_count, 1)
                else:
                    planned = self.plan(task, ids, options)
                    self.assertEqual(planned["recommendation_state"], "ready")
                    actual = self.finish(planned)
                self.assertEqual(actual["status"], "completed", actual.get("reason"))
                self.assertGreaterEqual(actual["finished_at"], actual["started_at"])
                self.assertTrue(actual["result"]["artifacts"])
                self.assertEqual(actual["model_source"], "acp" if spec["model"] else "local")
                for artifact in actual["result"]["artifacts"]:
                    self.assertTrue(Path(artifact["path"]).is_file())
                if spec["model"]:
                    self.assertEqual(
                        actual["verification"]["semantic_accuracy"], "not_independently_verified"
                    )
                if task == "table.stats":
                    self.assertEqual(actual["result"]["records"][0]["aggregate"], 10)
                if task == "table.merge":
                    self.assertEqual(len(actual["result"]["records"]), 4)
                if task == "image.table":
                    self.assertEqual(
                        actual["result"]["records"],
                        [{"Item": "Alpha", "Qty": "12"}, {"Item": "Beta", "Qty": "0.00"}],
                    )
                completed.append(task)
        self.assertEqual(len(CATALOG), 36)
        self.assertEqual(set(completed), set(CATALOG))
        self.assertEqual(
            set(judgment.calls), {task for task, spec in CATALOG.items() if spec["model"]}
        )
        self.assertEqual(len(judgment.calls), sum(spec["model"] for spec in CATALOG.values()))


if __name__ == "__main__":
    unittest.main()
