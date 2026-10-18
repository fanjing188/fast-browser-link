"""R36：仅用假 Agent、合成页面和临时目录验收。"""

import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from fbl_pack_authoring import draft_pack, save_flow, structural_context, session_factory
from fbl_pack_test import static_check, test_pack as check_pack
from fbl_runtime import Context, private_write
from fbl_cli import main
from copilot import Copilot
from copilot_setup import setup


class Authoring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.ctx = Context(self.root, self.root / "hermes", self.root / "runtime", ROOT)
        self.pack = self.root / "pack"
        shutil.copytree(ROOT / "docs/examples/job-tracker", self.pack)
        self.value = json.loads((self.pack / "package.json").read_text())
        self.prompts = []
        self.sessions = []

    def tearDown(self):
        self.tmp.cleanup()

    def factory(self, responses):
        values = iter(responses)

        def create(config, directory):
            response = next(values)
            runtime = Mock()
            if isinstance(response, Exception):
                runtime.start.side_effect = response
            else:

                def prompt(value):
                    self.prompts.append(value)
                    return (
                        response if isinstance(response, str) else json.dumps({"package": response})
                    ), {}

                runtime.prompt.side_effect = prompt
            self.sessions.append(runtime)
            return runtime

        return create

    def save(self):
        (self.pack / "package.json").write_text(json.dumps(self.value))

    def test_normal_draft_skeleton_url_scope_and_no_automatic_install(self):
        self.value["capabilities"]["job.track"][0]["argv"] = ["curl", "https://network.invalid"]
        with patch("socket.socket", side_effect=AssertionError("network forbidden")):
            result = draft_pack(
                self.ctx,
                "Track jobs",
                "https://jobs.example.test/detail?token=secret#value",
                factory=self.factory([self.value]),
            )
        self.assertTrue(result["valid"], result)
        target = Path(result["path"])
        package = json.loads((target / "package.json").read_text())
        self.assertEqual(package["tools"][0]["hosts"], ["jobs.example.test"])
        self.assertEqual(package["tools"][0]["pages"][0]["paths"], ["^/detail$"])
        self.assertNotIn("secret", (target / "package.json").read_text())
        script = (target / "job-tracker-local.py").read_text()
        self.assertIn("TODO", script)
        self.assertNotIn("network.invalid", script)
        self.assertFalse((self.ctx.copilot / "config.json").exists())
        self.assertFalse((self.ctx.copilot / "extensions").exists())
        self.assertEqual(len(self.prompts), 1)
        self.sessions[0].close.assert_called_once()
        self.assertIn("packs-guide.md", self.prompts[0])

    def test_invalid_repaired_once_in_fresh_session(self):
        invalid = {**self.value, "version": 2}
        result = draft_pack(self.ctx, "Track", factory=self.factory([invalid, self.value]))
        self.assertTrue(result["valid"], result)
        self.assertEqual(len(self.sessions), 2)
        self.assertIn("Host validation errors", self.prompts[1])
        for session in self.sessions:
            session.prompt.assert_called_once()
            session.close.assert_called_once()

    def test_invalid_after_repair_preserved_including_unparseable_response(self):
        for responses in ([{**self.value, "version": 2}] * 2, ["not json"] * 2):
            result = draft_pack(self.ctx, "Track", factory=self.factory(responses))
            self.assertFalse(result["valid"])
            self.assertTrue(result["errors"])
            self.assertTrue((Path(result["path"]) / "response-2.txt").exists())
            self.assertTrue((Path(result["path"]) / "draft.json").exists())

    def test_unavailable_agent_falls_back_and_discloses_reason(self):
        result = draft_pack(self.ctx, "Track", factory=self.factory([OSError("missing")]))
        self.assertTrue(result["fallback"])
        self.assertEqual(result["reason"], "OSError")
        self.assertTrue(result["requires_confirmation"])
        static_check(result["path"])

    def test_cli_new_uses_fake_default_agent_and_never_visits_url(self):
        private_write(self.ctx.copilot / "config.json", json.dumps({"default_agent": "codex"}))
        with (
            patch(
                "fbl_pack_authoring.session_factory", side_effect=self.factory([self.value])
            ) as factory,
            patch("socket.socket", side_effect=AssertionError("network forbidden")),
            redirect_stdout(io.StringIO()) as output,
        ):
            code = main(
                [
                    "packs",
                    "new",
                    "--describe",
                    "Track jobs",
                    "--url",
                    "https://jobs.example.test/detail",
                    "--runtime",
                    str(self.ctx.runtime),
                    "--hermes-home",
                    str(self.ctx.hermes),
                ]
            )
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output.getvalue())["valid"])
        self.assertEqual(factory.call_args.args[0]["default_agent"], "codex")

    def test_selected_adapter_is_used_without_calling_real_agent(self):
        for agent in ("hermes", "codex"):
            with patch("copilot_adapters.AgentAdapter.inference", return_value="fixture") as infer:
                self.assertEqual(session_factory({"default_agent": agent}, self.root), "fixture")
                infer.assert_called_once()

    def test_static_pass_and_failures(self):
        static_check(self.pack)
        original = copy.deepcopy(self.value)
        changes = [
            lambda p: p.update(version=2),
            lambda p: p["schemas"]["job.track"]["input"].update(pattern=".*"),
            lambda p: p["flows"]["track_job"].update(object="unknown"),
            lambda p: p["flows"]["track_job"]["steps"][0].update(capability="unknown.read"),
            lambda p: p["capabilities"]["job.track"][0].pop("risk"),
            lambda p: p["flows"]["track_job"].update(risk="free"),
            lambda p: p["capabilities"]["job.track"][0].update(argv=["python3", "../escape.py"]),
            lambda p: p["tools"][0]["pages"][0].update(flows=["unknown"]),
            lambda p: p["flows"]["track_job"]["steps"][0].update(
                input={"job_id": "$steps.future.records"}
            ),
        ]
        for change in changes:
            self.value = copy.deepcopy(original)
            change(self.value)
            self.save()
            with self.subTest(change=change), self.assertRaises((ValueError, KeyError)):
                static_check(self.pack)
        self.value = original
        self.save()
        (self.pack / "escape").symlink_to(self.root)
        self.assertFalse(check_pack(self.pack)["ok"])

    def test_trigger_scenarios_and_unknown_next_reference(self):
        def run():
            return check_pack(
                self.pack,
                command_runner=lambda *args: {
                    "records": [{"case_id": "CS-1001"}],
                    "source": "synthetic",
                },
            )

        source = ROOT / "docs/examples/adapter-pack"
        shutil.rmtree(self.pack)
        shutil.copytree(source, self.pack)
        result = run()
        self.assertTrue(result["ok"], result)
        package = json.loads((self.pack / "package.json").read_text())
        package["flows"]["support_materials"]["triggers"] = [
            {"table_columns": {"all": ["Case", "Status"]}},
            {"selection": {"object": "case_id"}},
            {"dwell_seconds": 20},
        ]
        (self.pack / "package.json").write_text(json.dumps(package))
        scenarios = self.pack / "tests/scenarios.json"
        scenarios.write_text(
            json.dumps(
                [
                    {
                        "url": "https://support.example.test/cases?q=CS-1001",
                        "expect_absent": ["support_materials"],
                    },
                    {
                        "url": "https://support.example.test/cases",
                        "table_columns": ["Case", "Status"],
                        "table_rows": [["CS-1001", "open"]],
                        "expect": ["support_materials"],
                    },
                    {
                        "url": "https://support.example.test/cases",
                        "selection": "CS-1001",
                        "expect": ["support_materials"],
                    },
                    {
                        "url": "https://support.example.test/cases?q=CS-1001",
                        "dwell_seconds": 20,
                        "expect": ["support_materials"],
                    },
                    {
                        "url": "https://support.example.test/cases?q=CS-1001",
                        "table_columns": ["Case"],
                        "table_rows": [["CS-1001"]],
                        "selection": "invalid",
                        "expect_absent": ["support_materials"],
                    },
                ]
            )
        )
        result = run()
        self.assertTrue(result["ok"], result)
        package["flows"]["support_reply_draft"]["triggers"] = [
            {"after": {"flow": "support_materials", "status": "completed"}}
        ]
        package["flows"]["support_materials"]["next"] = []
        (self.pack / "package.json").write_text(json.dumps(package))
        scenarios = self.pack / "tests/scenarios.json"
        scenarios.write_text(
            json.dumps(
                [
                    {
                        "url": "https://support.example.test/cases?q=CS-1001",
                        "follow_completed": [
                            {
                                "flow": "support_materials",
                                "status": status,
                                "object": "CS-1001",
                                "records": [],
                            }
                        ],
                        "expect" if status == "completed" else "expect_absent": [
                            "support_reply_draft"
                        ],
                    }
                    for status in ("completed", "failed", "stopped", "partial")
                ]
            )
        )
        result = run()
        self.assertTrue(result["ok"], result)
        package["flows"]["support_materials"]["next"] = [
            {
                "flow": "missing_flow",
                "when": {"field": "status", "records": "all", "equals": "open"},
            }
        ]
        (self.pack / "package.json").write_text(json.dumps(package))
        with self.assertRaisesRegex(ValueError, "invalid next workflow"):
            static_check(self.pack)

    def test_scenarios_outputs_failure_and_missing_sandbox(self):
        fixture = json.loads((self.pack / "tests/fixtures/job-tracker-local.json").read_text())[0]
        runner = Mock(return_value=fixture["expect"])
        result = check_pack(self.pack, runner)
        self.assertTrue(result["ok"], result)
        runner.assert_called_once()
        runner.return_value = {"records": [{"job_id": 123}], "source": "invalid"}
        self.assertFalse(check_pack(self.pack, runner)["ok"])
        scenarios = self.pack / "tests/scenarios.json"
        scenarios.write_text(
            json.dumps(
                [
                    {
                        "url": "https://elsewhere.example.test/detail?id=JB-1001",
                        "expect": ["track_job"],
                    }
                ]
            )
        )
        self.assertFalse(check_pack(self.pack, runner)["ok"])
        with (
            patch("fbl_pack_test.shutil.which", return_value=None),
            patch("subprocess.Popen") as popen,
        ):
            result = check_pack(self.pack)
            self.assertFalse(result["ok"])
            popen.assert_not_called()

    def test_nonzero_risk_only_help_in_sandbox(self):
        self.value["capabilities"]["job.track"][0]["risk"] = "metered"
        self.save()
        with (
            patch("fbl_pack_test.shutil.which", return_value="/sandbox"),
            patch("subprocess.run", return_value=Mock(returncode=0)) as run,
        ):
            self.assertTrue(check_pack(self.pack)["ok"])
            self.assertEqual(run.call_args.args[0][-1], "--help")
            self.assertIn("(deny network*)", run.call_args.args[0][2])
            self.assertIn("(deny file-write*)", run.call_args.args[0][2])
            run.return_value.returncode = 1
            self.assertFalse(check_pack(self.pack)["ok"])

    def test_cli_json_readable_exit_codes(self):
        args = ["packs", "test", str(self.pack), "--runtime", str(self.ctx.runtime)]
        for ok in (True, False):
            result = {
                "ok": ok,
                "checks": [
                    {
                        "kind": "static",
                        "name": "fixture",
                        "ok": ok,
                        **({} if ok else {"error": "fixture failure"}),
                    }
                ],
            }
            with (
                patch("fbl_pack_test.test_pack", return_value=result),
                redirect_stdout(io.StringIO()) as output,
            ):
                self.assertEqual(main([*args, "--json"]), 0 if ok else 1)
                self.assertEqual(json.loads(output.getvalue()), result)
            with (
                patch("fbl_pack_test.test_pack", return_value=result),
                redirect_stdout(io.StringIO()) as output,
            ):
                main(args)
                self.assertIn("PASS" if ok else "FAIL", output.getvalue())

    def test_cli_real_static_failure_and_missing_fixture_are_nonzero(self):
        (self.pack / "package.json").write_text("not-json")
        with redirect_stdout(io.StringIO()) as output:
            code = main(
                ["packs", "test", str(self.pack), "--json", "--runtime", str(self.ctx.runtime)]
            )
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])
        self.save()
        (self.pack / "tests/fixtures/job-tracker-local.json").unlink()
        result = check_pack(self.pack, Mock())
        self.assertFalse(result["ok"])
        self.assertEqual(result["checks"][-1]["kind"], "capability")

    def test_save_flow_privacy_and_no_install(self):
        app = Mock()
        import threading

        app.lock = threading.RLock()
        app.config = {"hermes_home": str(self.ctx.hermes)}
        from copilot_packages import Packages

        app.packages = Packages([self.pack], include_builtin=False)
        row = {
            "id": "task",
            "status": "completed",
            "action": "workflow.run",
            "params": {"flow": "track_job", "object": "PRIVATE_OBJECT"},
            "result": {"records": [{"title": "PRIVATE_TEXT"}]},
            "title": "PRIVATE_TITLE",
        }
        state = {
            "page_context": {"url": "https://job-tracker.example.test/detail?id=PRIVATE_URL"},
            "trace": [
                {"description": "点击 PRIVATE_BUTTON"},
                {"description": "选中 PRIVATE_SELECTION"},
            ],
            "suggestions": {"task": row},
            "result_history": [],
            "page": {"title": "PRIVATE_PAGE"},
        }
        app._state.return_value = state
        structure = structural_context(app, state, row)
        self.assertEqual(structure["actions"], ["click", "selection"])
        with patch("fbl_panel.context", return_value=self.ctx):
            result = save_flow(app, "browser", {"id": "task"}, factory=self.factory([self.value]))
        self.assertTrue(result["valid"], result)
        self.assertNotIn("PRIVATE", self.prompts[-1])
        self.assertIn("track_job", self.prompts[-1])
        self.assertIn("triggers", self.prompts[-1])
        self.assertFalse((self.ctx.copilot / "config.json").exists())
        self.assertFalse((self.ctx.copilot / "extensions").exists())

    def test_synthetic_commands_preserve_history_and_deduplicate(self):
        for name, key, value in (
            ("price-watch", "product_id", "PR-1001"),
            ("job-tracker", "job_id", "JB-1001"),
        ):
            work = self.root / name
            work.mkdir()
            command = [sys.executable, str(ROOT / "docs/examples" / name / "record.py")]
            results = []
            for _ in range(2):
                result = subprocess.run(
                    command,
                    input=json.dumps({key: value}),
                    text=True,
                    capture_output=True,
                    cwd=work,
                    check=True,
                )
                results.append(json.loads(result.stdout))
            if name == "price-watch":
                self.assertEqual(results[0]["records"][0]["change"], -4)
                self.assertEqual(results[1]["records"][0]["change"], 0)
                self.assertEqual(len((work / "prices.csv").read_text().splitlines()), 4)
            else:
                self.assertEqual(len(json.loads((work / "jobs.json").read_text())), 1)
                self.assertEqual(results[0], results[1])

    def test_examples_end_to_end_match_suggest_execute_display_contract_and_local_files(self):
        for name, flow_id, object_value, output in (
            ("price-watch", "watch_price", "PR-1001", "prices.csv"),
            ("job-tracker", "track_job", "JB-1001", "jobs.json"),
        ):
            directory = self.root / name
            setup(directory)
            private_write(
                directory / "config.json",
                json.dumps(
                    {
                        "extension_dirs": [str(ROOT / "docs/examples" / name)],
                        "managed_packs": True,
                        "auto_zero": False,
                        "inference_model": "fixture",
                    }
                ),
            )
            app = Copilot(directory)
            try:
                app.active = "fixture"
                state = app._state("fixture")
                url = f"https://{name}.example.test/detail?id={object_value}"
                state.update(
                    enabled=True,
                    ready=True,
                    page={"url": url, "title": "synthetic", "items": []},
                    page_context={"url": url, "incognito": False},
                )
                app._refresh_tool_suggestions("fixture")
                row = next(
                    row
                    for row in state["suggestions"].values()
                    if row["params"].get("flow") == flow_id
                )
                row["status"] = "executing"
                app._execute_workflow("fixture", row, state["epoch"], app.config)
                self.assertEqual(row["status"], "completed", row)
                self.assertEqual(
                    row["result_view"]["primary"],
                    "product_id" if name == "price-watch" else "job_id",
                )
                self.assertEqual(
                    row["result"]["records"][0][row["result_view"]["primary"]], object_value
                )
                self.assertTrue(list(directory.rglob(output)))
            finally:
                app.close()


if __name__ == "__main__":
    unittest.main()
