"""真实 MCP stdio 和脚本子进程；只使用合成任务，不连接个人服务。"""

import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def child(home, mode):
    agent = load("stdio_binding_agent", "agent-link/fast_browser_link.py")
    fixture = load("stdio_binding_fixture", "tests/v1.1-script-lane/test_script_tool.py")

    class Client(fixture.FakeRuntime):
        def call(self, method, params):
            owner_file = home / "synthetic-owner"
            if method == "shared.create":
                owner_file.write_text(params["owner"])
                owner_file.chmod(0o600)
                return {"id": "fixture-task", "state": "ready"}
            if method.startswith("shared.") and owner_file.read_text() != params.get("owner"):
                raise agent.bridge.BridgeError("forbidden", "task belongs to another owner")
            if method == "shared.session_end":
                (home / "session-ended").write_text("true")
                return {"accepted": True}
            if method == "shared.run":
                with (home / "actions").open("a") as out:
                    out.write(params["action"] + "\n")
            return super().call(method, params)

        def close(self):
            pass

    options = (
        {"uncertain_once" if mode == "multi" else mode: {"new_tab"}} if mode != "clean" else {}
    )
    client = Client(home / "fixture", **options)
    if mode == "multi":
        client.tab_ids = [7, 8]
    browser_type = agent.Browser
    agent.Browser = lambda **kw: browser_type(home=home, client=client, **kw)
    sys.argv = ["fixture", "--mcp"]
    raise SystemExit(agent.main())


class StdioBindingTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)

    def start(self, home, mode="uncertain_once"):
        process = subprocess.Popen(
            [sys.executable, "-B", __file__, "--child", str(home), mode],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                **os.environ,
                "PYTHONDONTWRITEBYTECODE": "1",
                "FAST_BROWSER_LINK_HOME": str(home),
                "FAST_BROWSER_BRIDGE_HOME": str(home / "unused"),
            },
        )

        def close():
            if process.poll() is None:
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        self.addCleanup(close)
        return process

    def rpc(self, process, operation=None, **params):
        request = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        if operation:
            request.update(
                method="tools/call",
                params={
                    "name": "fast_browser_link",
                    "arguments": {"operation": operation, "params": params},
                },
            )
        process.stdin.write((json.dumps(request) + "\n").encode())
        process.stdin.flush()
        self.assertTrue(select.select([process.stdout], [], [], 15)[0], "stdio response timed out")
        line = process.stdout.readline()
        self.assertTrue(line, "MCP exited without a response")
        reply = json.loads(line)
        return json.loads(reply["result"]["content"][0]["text"]) if operation else reply

    def script(self, process, code, **params):
        return self.rpc(process, "script", taskId="fixture-task", code=code, **params)

    def test_binding_failure_keeps_process_owner_and_unknown_fence(self):
        home = self.home
        process = self.start(home)
        self.rpc(process, "create")
        owner = (home / "synthetic-owner").read_bytes()
        first = self.script(process, "new_tab('https://example.com')")
        self.assertTrue(first["outcome_unknown"])
        blocked = self.script(process, "raise AssertionError('must not run')", tabId=7)
        self.assertEqual(blocked["code"], "outcome_unknown")
        self.assertFalse(blocked["execution_complete"])
        self.assertFalse(blocked["retryable"])
        self.assertTrue(blocked["outcome_unknown"])
        self.assertEqual(blocked["stage"], "task_binding")
        self.rpc(process)
        self.assertIsNone(process.poll())
        self.assertFalse((home / "session-ended").exists())
        self.assertEqual((home / "synthetic-owner").read_bytes(), owner)
        task = self.rpc(process, "get", taskId="fixture-task")
        self.assertEqual(task["tabIds"], [7])
        # 中文注释：未知写入不因拒绝而解冻；显式 tab 路径也不能建立干净子会话绕过。
        self.assertFalse(
            self.script(process, "new_tab('https://example.com')")["execution_complete"]
        )
        self.assertTrue(self.script(process, "reconcile(tab=7)")["outcome_unknown"])
        self.assertEqual((home / "actions").read_text().splitlines(), ["new_tab"])
        # 中文注释：另一个真实 MCP 进程不继承 owner；get 和绑定均保持拒绝。
        other = self.start(home, "clean")
        self.assertEqual(self.rpc(other, "get", taskId="fixture-task")["error"], "forbidden")
        self.assertFalse(self.script(other, "print('must not run')")["execution_complete"])
        self.rpc(other)
        recovered = self.script(process, "reconcile()")
        self.assertTrue(recovered["execution_complete"], recovered)
        self.assertEqual((home / "actions").read_text().splitlines(), ["new_tab", "snapshot"])
        self.assertFalse((home / "session-ended").exists())

    def test_ambiguous_work_tabs_do_not_bypass_unknown(self):
        home = self.home
        process = self.start(home, "multi")
        self.rpc(process, "create")
        self.assertTrue(self.script(process, "new_tab('https://example.com')")["outcome_unknown"])
        for code, params in (
            ("reconcile()", {}),
            ("reconcile(tab=7)", {}),
            ("reconcile(tab=7)", {"tabId": 7}),
        ):
            result = self.script(process, code, **params)
            self.assertFalse(result["execution_complete"], result)
            self.assertTrue(result["outcome_unknown"], result)
        self.rpc(process)
        self.assertEqual(self.rpc(process, "get", taskId="fixture-task")["tabIds"], [7, 8])
        self.assertEqual((home / "actions").read_text().splitlines(), ["new_tab"])
        self.assertFalse((home / "session-ended").exists())

    def test_human_pending_binding_is_not_unknown_or_approved(self):
        home = self.home
        process = self.start(home, "manual_for")
        self.rpc(process, "create")
        first = self.script(process, "new_tab('https://example.com')")
        self.assertEqual(first["last_operation"]["state"], "awaiting_human")
        blocked = self.script(process, "raise AssertionError('must not run')", tabId=7)
        self.assertEqual(blocked["code"], "pending_action")
        self.assertFalse(blocked["outcome_unknown"])
        self.assertFalse(blocked["retryable"])
        self.assertFalse(blocked["execution_complete"])
        self.assertFalse(self.script(process, "reconcile()")["execution_complete"])
        self.rpc(process)
        self.assertFalse((home / "session-ended").exists())
        self.assertEqual((home / "actions").read_text().splitlines(), ["new_tab"])


if __name__ == "__main__":
    if "--child" in sys.argv:
        child(Path(sys.argv[-2]), sys.argv[-1])
    unittest.main()
