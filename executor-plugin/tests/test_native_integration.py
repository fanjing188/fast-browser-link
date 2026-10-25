"""Real Hermes dispatcher and native UDS smoke; no personal profile activation."""

import json
import os
from pathlib import Path

import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

from test_native_tools import ROOT, load

sys.path.insert(0, str(ROOT.parent / "native-bridge"))
from tests.support import (  # noqa: E402
    fixture_daemon_path,
    stop_fixture_daemon,
    temporary_bridge_home,
)


def _is_fixture_daemon(command, home):
    # 中文注释：复用真实夹具的完整入口和末尾 home 核验，不按文件名猜测待停止的进程。
    candidates = [
        ROOT.parent / "native-bridge" / entry for entry in ("assist_adapter.py", "daemon.py")
    ]
    return fixture_daemon_path(Path(home), command, candidates) is not None


class NativeIntegrationTests(unittest.TestCase):
    def test_fixture_identity_accepts_only_exact_bootstrap_and_home(self):
        home = Path("/fixture/runtime")
        core = ROOT.parent / "native-bridge"
        for entry in ("assist_adapter.py", "daemon.py"):
            self.assertTrue(
                _is_fixture_daemon(f"{sys.executable} {core / entry} --home {home}", home)
            )
            self.assertFalse(
                _is_fixture_daemon(f"{sys.executable} /foreign/{entry} --home {home}", home)
            )
            self.assertFalse(
                _is_fixture_daemon(f"{sys.executable} {core / entry} --home {home}-other", home)
            )
            self.assertFalse(
                _is_fixture_daemon(f"{sys.executable} {core / entry} --home {home} --extra", home)
            )

    def test_real_hermes_bounded_hook_to_real_client(self):
        hermes_root = Path(
            os.environ.get("HERMES_SOURCE", str(Path.home() / ".hermes/hermes-agent"))
        )
        if not (hermes_root / "hermes_cli/plugins.py").exists():
            self.skipTest("Hermes source unavailable; set HERMES_SOURCE")
        client_path = ROOT.parent / "native-bridge/client.py"
        if not client_path.exists():
            self.skipTest("native bridge backend not yet available")
        with temporary_bridge_home() as home:
            tmp = str(home)
            env = {"HERMES_HOME": tmp, "HOME": tmp}
            with patch.dict(os.environ, env):
                sys.path.insert(0, str(hermes_root))
                try:
                    from hermes_cli import plugins
                except ImportError as exc:
                    self.skipTest("Run with Hermes interpreter: " + str(exc))
                finally:
                    sys.path.remove(str(hermes_root))
                tools = load("native_tools")
                runtime = tools.runtime_module()
                profile = runtime.NativeProfileRuntime(Path(tmp), ROOT)
                manager = plugins.PluginManager()
                threads = []

                def hook(**kwargs):
                    threads.append(threading.get_ident())
                    return profile.authority.pre_tool_call(**kwargs)

                manager._hooks.setdefault("pre_tool_call", []).append(hook)
                processes = []
                real_popen = subprocess.Popen

                def tracked_popen(*args, **kwargs):
                    proc = real_popen(*args, **kwargs)
                    processes.append(proc)
                    return proc

                try:
                    with (
                        patch.object(plugins, "_delivery_manager", return_value=manager),
                        patch("subprocess.Popen", side_effect=tracked_popen),
                    ):
                        name = "fast_browser_health"
                        block, args = plugins._dispatch_pre_tool_call_hooks(
                            name, {}, session_id="fixture-session", tool_call_id="fixture-call"
                        )
                        self.assertIsNone(block)
                        self.assertIsInstance(args, dict)
                        result = json.loads(
                            tools.make_tool_handler(name, profile)(
                                args, session_id="fixture-session"
                            )
                        )
                        self.assertEqual(result, {"ok": True, "protocolVersion": 1})
                        pid_path = Path(tmp) / "plugin-data/fast-browser-link-native/daemon.pid"
                        self.assertTrue(
                            pid_path.is_file(), "Real daemon must publish its process identity"
                        )
                        daemon_pid = int(pid_path.read_text())
                        command = subprocess.check_output(
                            ["ps", "-p", str(daemon_pid), "-o", "command="], text=True
                        )
                        self.assertIn(str(client_path.with_name("assist_adapter.py")), command)
                        self.assertTrue(_is_fixture_daemon(command, tmp), command)
                        self.assertTrue((pid_path.parent / "bridge.sock").is_socket())
                        self.assertNotEqual(threads[0], threading.get_ident())
                        # Another session cannot consume this hook-issued lease.
                        block, args = plugins._dispatch_pre_tool_call_hooks(
                            "fast_browser_browsers",
                            {},
                            session_id="fixture-session",
                            tool_call_id="fixture-call-2",
                        )
                        result = json.loads(
                            tools.make_tool_handler("fast_browser_browsers", profile)(
                                args, session_id="foreign-session"
                            )
                        )
                        self.assertEqual(result["code"], "owner_denied")
                        block, args = plugins._dispatch_pre_tool_call_hooks(
                            "fast_browser_browsers",
                            {},
                            session_id="fixture-session",
                            tool_call_id="fixture-call-3",
                        )
                        result = json.loads(
                            tools.make_tool_handler("fast_browser_browsers", profile)(
                                args, session_id="fixture-session"
                            )
                        )
                        self.assertEqual(result, [])
                finally:
                    if profile._client is not None:
                        profile._client.close()
                    profile.close()
                    # Reap the exact daemon in this isolated home, regardless of launcher implementation.
                    pid_path = Path(tmp) / "plugin-data/fast-browser-link-native/daemon.pid"
                    if pid_path.is_file():
                        pid = int(pid_path.read_text())
                        check = subprocess.run(
                            ["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True
                        )
                        if check.returncode == 0 and _is_fixture_daemon(check.stdout, tmp):
                            stop_fixture_daemon(Path(tmp))
                            self.assertFalse(pid_path.exists(), "fixture daemon did not shut down")
                        else:
                            raise RuntimeError("refusing to stop non-fixture PID")
                    # Only processes launched by THIS isolated fixture are reaped.
                    for proc in processes:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
