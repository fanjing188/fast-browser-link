"""断点续跑只使用合成能力回执，所有文件写入临时目录。"""

import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot_capabilities import Workflows, Stopped
from copilot_fetch import Fetcher
from copilot import Copilot


class ResumeTest(unittest.TestCase):
    def test_failed_workflow_restores_paid_steps_and_foreach_items(self):
        flow = {
            "id": "fixture",
            "judgment": False,
            "steps": [
                {"id": "first", "name": "取数", "capability": "first"},
                {
                    "id": "second",
                    "name": "逐项查数",
                    "capability": "second",
                    "foreach": "$steps.first.records",
                    "input": {"keyword": "$item.keyword"},
                },
            ],
            "result": "$steps.second.records",
        }
        calls = []
        failed = [False]
        checkpoint = {}
        snapshots = []

        def execute(capability, values, work, stop, context, progress):
            calls.append((capability, values.get("keyword")))
            if capability == "first":
                return {
                    "records": [{"keyword": "one"}, {"keyword": "two"}],
                    "source": "paid fixture",
                }
            if values["keyword"] == "two" and not failed[0]:
                failed[0] = True
                raise ValueError("login required")
            return {
                "records": [{"keyword": values["keyword"], "vol": 100}],
                "source": "paid fixture",
            }

        registry = SimpleNamespace(
            packages=SimpleNamespace(flows={"fixture": flow}, experience=""),
            jobs={},
            candidates=lambda *args: [True],
            execute=execute,
            write=lambda path, text: Path(path).write_text(text),
        )
        with tempfile.TemporaryDirectory() as directory:
            runner = Workflows(registry)
            work = Path(directory)
            first, stopped = runner.run(
                "job",
                "fixture",
                "sample",
                {},
                work / "first",
                checkpoint=checkpoint,
                save_checkpoint=lambda value: snapshots.append(value),
            )
            self.assertFalse(stopped)
            self.assertIn("first", checkpoint["steps"])
            self.assertEqual(checkpoint["items"]["second"]["completed"], 1)
            self.assertIn("login required", json.dumps(first))
            self.assertTrue(snapshots)
            second, _ = runner.run(
                "job", "fixture", "sample", {}, work / "second", checkpoint=checkpoint
            )
            self.assertEqual(
                calls, [("first", None), ("second", "one"), ("second", "two"), ("second", "two")]
            )
            self.assertEqual([row["keyword"] for row in second["records"]], ["one", "two"])
            self.assertFalse(second["missing"])
            with self.assertRaisesRegex(ValueError, "workflow changed"):
                runner.run("job", "fixture", "other", {}, work / "third", checkpoint=checkpoint)

    def test_stop_after_success_preserves_step_and_model_judgment(self):
        flow = {
            "judgment": True,
            "steps": [{"id": "a", "capability": "first"}, {"id": "b", "capability": "second"}],
            "result": "$steps.b.records",
        }
        calls = []
        pause = [True]
        checkpoint = {}

        def execute(capability, values, work, stop, context, progress):
            calls.append(capability)
            if capability == "second" and pause[0]:
                pause[0] = False
                raise Stopped("stop")
            return {"records": [{"keyword": "one"}], "source": "metered"}

        registry = SimpleNamespace(
            packages=SimpleNamespace(flows={"fixture": flow}, experience=""),
            jobs={},
            candidates=lambda *args: [True],
            execute=execute,
            write=lambda path, text: Path(path).write_text(text),
        )
        model_calls = []

        def model(*args):
            model_calls.append(True)
            return {"verdict": "done"}

        with tempfile.TemporaryDirectory() as directory:
            runner = Workflows(registry)
            root = Path(directory)
            _, stopped = runner.run(
                "job", "fixture", "sample", {}, root / "a", model, checkpoint=checkpoint
            )
            self.assertTrue(stopped)
            runner.run("job", "fixture", "sample", {}, root / "b", model, checkpoint=checkpoint)
            runner.run("job", "fixture", "sample", {}, root / "c", model, checkpoint=checkpoint)
            self.assertEqual(calls, ["first", "second", "second"])
            self.assertEqual(len(model_calls), 1)

    def test_fetch_checkpoints_each_completed_source_before_later_stop(self):
        checkpoint = {}
        calls = []
        fetcher = Fetcher({})
        schema = {}
        template = {
            "fetch": [
                {"script": name, "params_schema": schema, "output_schema": schema}
                for name in ("paid", "later")
            ]
        }

        def fetch(name, *args):
            calls.append(name)
            if name == "later" and len(calls) == 2:
                raise ValueError("stopped")
            return {"source": "paid fixture", "keywords": [{"keyword": "sample"}]}

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                fetcher.run(
                    "job",
                    template,
                    {},
                    Path(directory),
                    lambda *args: None,
                    capability_fetch=fetch,
                    checkpoint=checkpoint,
                )
            result = fetcher.run(
                "job",
                template,
                {},
                Path(directory),
                lambda *args: None,
                capability_fetch=fetch,
                checkpoint=checkpoint,
            )
            self.assertEqual(calls, ["paid", "later", "later"])
            self.assertEqual(len(result["data"]), 2)

    def test_ranking_resume_retains_seed_and_each_paid_domain_query(self):
        calls = []
        fetcher = Fetcher({})

        def source(name, params, schema):
            calls.append((name, params))
            return {
                "source": "paid fixture",
                **(
                    {
                        "results": [
                            {"url": "https://one.example.test/a"},
                            {"url": "https://two.example.test/b"},
                        ]
                    }
                    if name == "serp_top10"
                    else {"keywords": [{"keyword": "sample", "vol": 100}]}
                ),
            }

        class FixtureFetcher:
            def run(self, key, template, params, work, validate, progress, **kwargs):
                return fetcher.run(
                    key,
                    template,
                    params,
                    work,
                    lambda *args: None,
                    progress,
                    capability_fetch=source,
                    **kwargs,
                )

        template = lambda action: {
            "fetch": [
                {
                    "script": "serp_top10"
                    if action == "seo.keyword_check"
                    else "competitor_keywords",
                    "params_schema": {},
                    "output_schema": {},
                }
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            app = SimpleNamespace(
                directory=Path(directory).resolve(),
                fetcher=FixtureFetcher(),
                templates=SimpleNamespace(get=template),
                packages=SimpleNamespace(
                    workflows={
                        "seo.ranking_sites": {
                            "seed_fetcher": "serp_top10",
                            "site_fetcher": "competitor_keywords",
                            "max_sites": 3,
                        }
                    }
                ),
            )
            row = {"id": "fixture", "params": {"keyword": "sample"}}
            first = Copilot._ranking_fetch(
                app, "fixture", 1, "job", row, Path(directory), lambda *args: None, None
            )
            second = Copilot._ranking_fetch(
                app, "fixture", 1, "job", row, Path(directory), lambda *args: None, None
            )
            self.assertEqual(first, second)
            self.assertEqual(len(calls), 3)
            self.assertTrue((Path(directory) / "tasks/ranking-checkpoint-fixture.json").is_file())


if __name__ == "__main__":
    unittest.main()
