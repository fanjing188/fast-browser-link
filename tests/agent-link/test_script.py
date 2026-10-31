"""独立 CLI/MCP 的真实脚本子进程；浏览器响应全部来自离线夹具。"""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


agent = load("script_agent_entry", "agent-link/fast_browser_link.py")
fixture = load("script_agent_fixture", "tests/v1.1-script-lane/test_script_tool.py")
store_module = load("script_agent_store", "native-bridge/site_tools/store.py")
site_fixture = load("script_agent_sites", "tests/site-tools/test_sites.py")


class ScriptTests(unittest.TestCase):
    def test_script_ignores_unrelated_module_with_same_name(self):
        from types import ModuleType

        # 中文注释：调用方可先导入其他版本；SDK 必须按自身路径加载执行底座。
        with patch.dict(sys.modules, {"fbl_scripts": ModuleType("fbl_scripts")}):
            result = self.script("print('own-script-runtime')")
        self.assertTrue(result["execution_complete"], result)
        self.assertEqual(result["stdout"].strip(), "own-script-runtime")

    def test_core_only_deployment_runs_real_child_and_site_tool(self):
        # 中文注释：独立部署不复制任何 Hermes 文件；真实子进程还必须能读取导航摘要。
        core = self.home / "core-only"
        core.mkdir()
        source = ROOT / "native-bridge"
        shutil.copyfile(source / "fbl_scripts.py", core / "fbl_scripts.py")
        for name in ("script_lane", "site_tools"):
            if (source / name).is_dir():
                shutil.copytree(source / name, core / name)
        self.assertFalse((core.parent / "executor-plugin").exists())
        module = load("isolated_core_scripts", core / "fbl_scripts.py")
        try:
            lane = module.ScriptLane(self.client, self.home, "core-session")
        except ValueError as exc:
            self.fail(f"core-only script runtime unavailable: {exc}")
        self.addCleanup(lane.close)
        receipt = lane.execute(
            "script",
            {
                "taskId": "task",
                "code": "import os\nnew_tab('https://example.com')\n"
                "page = goto_url('https://example.com/next')['summary']\n"
                "print(os.getpid(), page['items'][0]['name'])",
            },
        )
        self.assertTrue(receipt["execution_complete"], receipt)
        pid, title = receipt["stdout"].strip().split()
        self.assertNotEqual(int(pid), os.getpid())
        self.assertEqual(title, "Next")
        store = module.load(core / "site_tools/store.py").Store(
            self.home / "plugin-data/fast-browser-link-native/site-tools"
        )
        draft = store.define(site_fixture.definition())["draft_id"]
        store.trial(
            draft,
            {"query": "x"},
            [{"path": "title", "equals": "Next"}],
            lambda *_: {"title": "Next"},
        )
        store.activate(draft)
        original = self.client.call

        def call(method, params):
            value = original(method, params)
            return (
                {**value, "allowedOrigins": ["https://example.com"]}
                if method == "shared.get"
                else value
            )

        self.client.call = call
        result = lane.execute(
            "site_run",
            {"taskId": "task", "site": "example", "name": "read", "args": {"query": "x"}},
        )
        self.assertEqual(result.get("result"), {"title": "Next"}, result)
        self.assertEqual(len(lane.execute("site_search", {})["tools"]), 1)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.client = fixture.FakeRuntime(self.home / "fixture")
        self.client.close = Mock()
        self.browser = agent.Browser(home=self.home, owner="trusted-session", client=self.client)
        self.addCleanup(lambda: self.browser.lane and self.browser.lane.close())

    def script(self, code, **params):
        return self.browser.call("script", {"taskId": "task", "code": code, **params})

    def test_multistep_files_persist_but_variables_do_not(self):
        result = self.script(
            "new_tab('https://example.com')\nx=42\nopen('saved','w').write('ok')\nprint(read_page()['items'][0]['name'])"
        )
        self.assertTrue(result["execution_complete"], result)
        self.assertEqual(result["stdout"].strip(), "Next")
        result = self.script("print('x' in globals(), open('saved').read())")
        self.assertEqual(result["stdout"].strip(), "False ok")
        workspace = self.browser.lane.script.workspace_for(self.home, self.browser.owner)
        other = self.browser.lane.script.workspace_for(self.home, "other-session")
        self.assertNotEqual(workspace, other)
        for path in (workspace, workspace.parent, workspace / "tmp"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertFalse((other / "saved").exists())
        self.assertTrue(all(row["owner"] == self.browser.owner for row in self.client.runs))

    def test_same_session_cross_process_lock_and_task_selection(self):
        from concurrent.futures import ThreadPoolExecutor
        import time

        other = agent.Browser(home=self.home, owner=self.browser.owner, client=self.client)
        self.addCleanup(lambda: other.lane and other.lane.close())
        workspace = self.home / "plugin-data/fast-browser-link-native/scripts"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                self.script, "open('running', 'w').close()\nimport time\ntime.sleep(0.5)"
            )
            deadline = time.monotonic() + 3
            while not list(workspace.glob("*/running")) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(list(workspace.glob("*/running")))
            with self.assertRaisesRegex(ValueError, "another script"):
                other.call("script", {"taskId": "task", "code": "print('must not run')"})
            self.assertTrue(pending.result()["execution_complete"])
        for task in ("task-a", "task-b"):
            result = self.browser.call(
                "script", {"taskId": task, "code": "new_tab('https://example.com')"}
            )
            self.assertTrue(result["execution_complete"], result)
            self.assertEqual(self.client.runs[-1]["taskId"], task)

    def test_unready_and_paused_bindings_return_bounded_errors(self):
        original = self.client.call
        for state, expected in (
            ("awaiting_approval", "binding_missing"),
            ("paused", "task_paused"),
        ):

            def call(method, params):
                result = original(method, params)
                return {**result, "state": state} if method == "shared.get" else result

            self.client.call = call
            result = self.script("raise AssertionError('must not run')")
            self.assertEqual(result["code"], expected)
            self.assertFalse(result["execution_complete"])
        self.assertEqual(self.client.runs, [])

    def test_foreign_tab_is_rejected_without_crashing_mcp_or_running_code(self):
        self.script("new_tab('https://example.com')")
        before = len(self.client.runs)
        result = self.script("print('must not run')", tabId=999)
        self.assertEqual(result["code"], "foreign_tab")
        self.assertFalse(result["execution_complete"])
        self.assertEqual(len(self.client.runs), before)
        self.assertTrue(self.script("print('still available')")["execution_complete"])

    def test_installed_runtime_uses_the_same_script_closure(self):
        installer = load("script_stage_fixture", "native-bridge/install.py")
        runtime = self.home / "installed"
        installer.stage(
            self.home / "user",
            ["chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/"],
            runtime_home=runtime,
        )
        host = runtime / "plugin-data/fast-browser-link-native/host-bin"
        installed = load("installed_script_entry", host / "fbl_scripts.py")
        lane = installed.ScriptLane(self.client, runtime, self.browser.owner)
        self.addCleanup(lane.close)
        receipt = lane.execute(
            "script",
            {
                "taskId": "task",
                "code": "new_tab('https://example.com')\nprint(read_page()['items'][0]['name'])",
            },
        )
        self.assertTrue(receipt["execution_complete"], receipt)
        self.assertEqual(receipt["stdout"].strip(), "Next")
        for relative in (
            "fbl_scripts.py",
            "script_lane/host_bridge.py",
            "script_lane/tool.py",
            "script_lane/child.py",
            "script_lane/action_session.py",
            "script_lane/page-request.js",
            "script_lane/page_export.py",
            "script_lane/page_export.js",
            "site_tools/tools.py",
            "site_tools/store.py",
        ):
            self.assertEqual(
                (host / relative).read_bytes(), (ROOT / "native-bridge" / relative).read_bytes()
            )
        sdk = ROOT / "native-bridge/browser_sdk.py"
        if sdk.is_file():
            self.assertTrue(
                (host / sdk.name).is_file(), "stage must include the public browser SDK"
            )
            self.assertEqual((host / sdk.name).read_bytes(), sdk.read_bytes())
        adapter = ROOT / "native-bridge/core_adapter.py"
        self.assertEqual((host / adapter.name).read_bytes(), adapter.read_bytes())

    def test_timeout_and_bounded_output(self):
        result = self.script("import time\ntime.sleep(5)", timeout=1)
        self.assertTrue(result["timed_out"])
        self.assertFalse(result["execution_complete"])
        self.assertTrue(result["outcome_unknown"])
        result = self.script("print('x'*100000)")
        self.assertTrue(result["stdout_truncated"])
        self.assertLessEqual(len(result["stdout"]), 20000)

    def test_caught_pending_and_unknown_are_not_success_or_replayed(self):
        for mode, state in (
            ("approval_for", "awaiting_approval"),
            ("manual_for", "awaiting_human"),
            ("uncertain_once", "unknown"),
        ):
            with self.subTest(mode=mode):
                getattr(self.client, mode).add("click")
                result = self.script(
                    "new_tab('https://example.com')\ntry:\n    click('button')\nexcept Exception:\n    pass"
                )
                self.assertEqual(result["exit_code"], 0, result)
                self.assertFalse(result["execution_complete"], result)
                self.assertEqual(result["last_operation"]["state"], state)
                self.assertEqual(result["outcome_unknown"], mode == "uncertain_once")
                clicks = [r for r in self.client.runs if r["action"] == "click"]
                self.assertEqual(len(clicks), 1)
                if mode == "uncertain_once":
                    again = self.script("try:\n    click('button')\nexcept Exception:\n    pass")
                    self.assertFalse(again["execution_complete"])
                    self.assertEqual(
                        len([r for r in self.client.runs if r["action"] == "click"]), 1
                    )
                self.browser.lane.close()
                self.browser.lane = None
                self.client.runs.clear()
                getattr(self.client, mode).clear()

    def test_identity_and_workspace_cannot_be_supplied(self):
        for field in (
            "owner",
            "session_id",
            "__owner_lease",
            "__browser_link_owner_lease",
            "workspace",
            "sessionId",
        ):
            with self.assertRaises(ValueError):
                self.script("print(1)", **{field: "forged"})
        with self.assertRaises(ValueError):
            self.browser.call("script", {"code": "print(1)"})
        for timeout in (True, 0, 3601, "1"):
            result = self.script("print(1)", timeout=timeout)
            self.assertEqual(result["code"], "invalid_fields")

    def test_both_cli_entrypoints_accept_stdin_and_share_private_identity(self):
        from types import SimpleNamespace

        sys.path.insert(0, str(ROOT / "native-bridge"))
        import browser_sdk
        import fbl_cli

        original_browser = agent.Browser

        def browser(**kwargs):
            return original_browser(home=self.home, owner=kwargs.get("owner"), client=self.client)

        session = self.home / "stdin.session"
        payload = json.dumps({"taskId": "task", "code": "print('stdin-ok')"})
        with (
            patch.object(agent, "Browser", side_effect=browser),
            patch.object(sys, "argv", ["browser.py", "--session", str(session), "script", "-"]),
            patch.object(sys, "stdin", io.StringIO(payload)),
            patch.object(sys, "stdout", io.StringIO()) as output,
        ):
            self.assertEqual(agent.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["stdout"].strip(), "stdin-ok")
        identity = agent.session_owner(session)
        ctx = SimpleNamespace(runtime=self.home, source=ROOT)
        with (
            patch.object(browser_sdk, "Browser", side_effect=browser),
            patch.object(fbl_cli.Context, "locate", return_value=ctx),
            patch.object(sys, "stdin", io.StringIO(payload)),
            patch.object(sys, "stdout", io.StringIO()) as output,
        ):
            self.assertEqual(fbl_cli.main(["browser", "--session", str(session), "script", "-"]), 0)
            self.assertEqual(json.loads(output.getvalue())["stdout"].strip(), "stdin-ok")
        self.assertEqual(agent.session_owner(session), identity)

    def test_mcp_script_and_cli_session_identity(self):
        source = io.StringIO(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "fast_browser_link",
                        "arguments": {
                            "operation": "script",
                            "params": {"taskId": "task", "code": "print(2+3)"},
                        },
                    },
                }
            )
        )
        sink = io.StringIO()
        agent.serve(self.browser, source, sink)
        receipt = json.loads(json.loads(sink.getvalue())["result"]["content"][0]["text"])
        self.assertEqual(receipt["stdout"].strip(), "5")
        session = self.home / "cli.session"
        self.assertEqual(agent.session_owner(session), agent.session_owner(session))
        os.chmod(session, 0o644)
        with self.assertRaises(ValueError):
            agent.session_owner(session)

    def test_only_active_sites_and_argument_result_contracts(self):
        store = store_module.Store(self.home / "plugin-data/fast-browser-link-native/site-tools")
        definition = site_fixture.definition()
        draft = store.define(definition)["draft_id"]
        self.assertEqual(self.browser.call("site_search", {})["tools"], [])
        missing = self.browser.call(
            "site_run",
            {"taskId": "task", "site": "example", "name": "read", "args": {"query": "x"}},
        )
        self.assertFalse(missing["ok"])
        store.trial(
            draft,
            {"query": "x"},
            [{"path": "title", "equals": "Next"}],
            lambda *_: {"title": "Next"},
        )
        store.activate(draft)
        self.assertEqual(len(self.browser.call("site_search", {})["tools"]), 1)
        self.assertNotIn("browser_site_manage", self.browser.lane.sites)
        # 中文注释：合成任务明确授权这个来源；网站声明本身不能扩大授权。
        original = self.client.call

        def call(method, params):
            result = original(method, params)
            return (
                {**result, "allowedOrigins": ["https://example.com"]}
                if method == "shared.get"
                else result
            )

        self.client.call = call
        self.script("new_tab('https://example.com')")
        params = {"taskId": "task", "site": "example", "name": "read", "args": {"query": 1}}
        self.assertEqual(self.browser.call("site_run", params)["code"], "schema_mismatch")
        params["args"]["query"] = "x"
        self.assertEqual(self.browser.call("site_run", params)["result"], {"title": "Next"})
        definition["code"] = "def run(args):\n    return {'title': 123}"
        draft = store.define(definition)["draft_id"]
        store.trial(
            draft,
            {"query": "x"},
            [{"path": "title", "equals": "Next"}],
            lambda *_: {"title": "Next"},
        )
        store.activate(draft)
        self.assertEqual(self.browser.call("site_run", params)["code"], "schema_mismatch")
        self.client.call = original
        self.assertEqual(self.browser.call("site_run", params)["code"], "binding_or_origin_denied")


if __name__ == "__main__":
    unittest.main()
