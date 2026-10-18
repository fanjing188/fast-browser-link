"""Codex 离线事件解析、评分和三路对比，不调用任何模型。"""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import codex_events
import run_codex

spec = importlib.util.spec_from_file_location("codex_compare", HERE.parent / "compare.py")
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class CodexTests(unittest.TestCase):
    def test_mcp_usage_pending_failure_and_no_double_count(self):
        result = codex_events.parse_events(
            (HERE / "fixtures/codex-mcp.jsonl").read_text().splitlines(), "mcp"
        )
        metrics = result["efficiency"]
        self.assertEqual(metrics["browserToolCalls"], 1)
        self.assertEqual(metrics["scriptCalls"], 1)
        self.assertEqual(metrics["failedToolCalls"], 1)
        self.assertEqual(metrics["inputTokens"], 24763)
        self.assertEqual(metrics["cachedReadTokens"], 24448)
        self.assertEqual(metrics["outputTokens"], 122)
        self.assertEqual(metrics["modelCalls"], "未拿到")
        self.assertEqual(metrics["totalMs"], "未拿到")

    def test_skills_and_missing_fields(self):
        lines = (HERE / "fixtures/codex-skills.jsonl").read_text().splitlines()
        metrics = codex_events.parse_events(lines, "skills")["efficiency"]
        self.assertEqual(
            (metrics["browserToolCalls"], metrics["scriptCalls"], metrics["failedToolCalls"]),
            (2, 1, 1),
        )
        self.assertEqual(metrics["cachedReadTokens"], "未拿到")
        event = json.loads(lines[1])
        event["item"]["command"] = "python3 browser.py run '{}' && python3 browser.py script '{}'"
        metrics = codex_events.parse_events([json.dumps(event)], "skills")["efficiency"]
        self.assertEqual(metrics["browserToolCalls"], "未拿到")
        self.assertEqual(metrics["scriptCalls"], "未拿到")
        self.assertEqual(metrics["inputTokens"], "未拿到")

    def test_runner_preview_never_executes_and_both_routes_cover_seven_tasks(self):
        from types import SimpleNamespace

        for mode in ("mcp", "skills"):
            with (
                patch.object(run_codex.subprocess, "run") as execute,
                patch.object(run_codex, "urlopen") as request,
            ):
                result = run_codex.run(
                    SimpleNamespace(
                        runtime=Path("/tmp/fixture-runtime"),
                        run=False,
                        mode=mode,
                        model="fixture-model",
                    )
                )
            execute.assert_not_called()
            request.assert_not_called()
            self.assertEqual(len(result["tasks"]), 7)
            self.assertIn("--json", result["argv"])
            self.assertIn("--ignore-user-config", result["argv"])
            self.assertEqual(any("mcp_servers." in arg for arg in result["argv"]), mode == "mcp")

    def test_both_runners_end_to_end_with_fake_codex_and_seven_perfect_outputs(self):
        import csv
        import io
        from types import SimpleNamespace
        import score

        for mode in ("mcp", "skills"):
            current = -1

            def request(url, **kwargs):
                nonlocal current
                if not isinstance(url, str):
                    current += 1
                    return io.BytesIO(b"{}")
                logs = [
                    {
                        "submissions": [
                            {
                                "fields": score.EXPECTED_FORM,
                                "files": {
                                    key: {"name": key + ".png", "size": 1}
                                    for key in ("logo", "screenshot")
                                },
                            }
                        ]
                    },
                    {"pageRequests": [1, 2, 3, 4, 5]},
                    {"clicks": ["spa-result"], "detailRequests": 1},
                    {"clicks": ["cookie-close", "newsletter-close", "primary"]},
                    {},
                    {"catalogRequests": [row["id"] for row in score.CATALOG]},
                    {"toolQueries": [f"BENCH-{i:02d}" for i in range(1, 4)]},
                ]
                return io.BytesIO(json.dumps(logs[current]).encode())

            def execute(argv, **kwargs):
                workspace = Path(argv[argv.index("-C") + 1])
                output = workspace / "result.output"
                if current in (1, 5):
                    rows = score.expected_rows() if current == 1 else score.CATALOG
                    with output.open("w") as stream:
                        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                        writer.writeheader()
                        writer.writerows(rows)
                elif current == 2:
                    output.write_text(json.dumps(score.EXPECTED_DETAIL))
                elif current == 6:
                    output.write_text(
                        json.dumps(
                            [
                                {
                                    "round": i,
                                    "value": f"BENCH-{i:02d}",
                                    "result": f"已核对 BENCH-{i:02d}",
                                }
                                for i in range(1, 4)
                            ]
                        )
                    )
                kwargs["stdout"].write((HERE / "fixtures/codex-mcp.jsonl").read_text())
                if mode == "skills":
                    self.assertTrue(
                        (workspace / ".agents/skills/fast-browser-link/SKILL.md").is_file()
                    )
                return SimpleNamespace(returncode=0)

            with tempfile.TemporaryDirectory() as tmp:
                args = SimpleNamespace(
                    runtime=Path(tmp),
                    run=True,
                    mode=mode,
                    model=None,
                    output=Path(tmp) / "results",
                    label=mode,
                    port=8765,
                )
                with (
                    patch.object(run_codex.subprocess, "run", side_effect=execute),
                    patch.object(run_codex, "urlopen", side_effect=request),
                ):
                    result = run_codex.run(args)
                scored = json.loads(Path(result["result"]).read_text())
            self.assertEqual(len(scored["tasks"]), 7)
            self.assertTrue(all(task["correctness"]["score"] == 1 for task in scored["tasks"]))

    def test_score_reuses_existing_correctness_and_three_way_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "manifest.json").write_text(
                json.dumps(
                    {
                        "mode": "mcp",
                        "label": "fixture",
                        "tasks": [{"name": "05-login", "exitCode": 0}],
                    }
                )
            )
            (folder / "05-login.log.json").write_text("{}")
            (folder / "05-login.events.jsonl").write_text(
                (HERE / "fixtures/codex-mcp.jsonl").read_text()
            )
            result = run_codex.score_folder(folder)
        self.assertEqual(result["tasks"][0]["correctness"]["score"], 1)
        hermes = {**result, "runtime": "Hermes"}
        skills = {**result, "runtime": "codex+skills"}
        table = compare.compare_many([hermes, result, skills])
        self.assertIn("| Hermes | codex+mcp | codex+skills |", table)
        self.assertIn("未拿到", table)
        self.assertIn("05-login.correctness", table)


if __name__ == "__main__":
    unittest.main()
