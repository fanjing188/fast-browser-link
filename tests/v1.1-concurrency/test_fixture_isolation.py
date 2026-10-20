"""测试桥接路径必须在宿主配置加载前固定到临时夹具。"""

import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))

from tests.support import stop_fixture_daemon, temporary_bridge_home  # noqa: E402


class FixtureIsolationTests(unittest.TestCase):
    def test_core_runner_fences_every_child_from_inherited_bridge_home(self):
        with tempfile.TemporaryDirectory() as parent:
            unrelated = Path(parent) / "must-not-be-used"
            calls = []

            def record(command, **kwargs):
                calls.append(kwargs["env"])
                return SimpleNamespace(returncode=0)

            with (
                patch.dict(
                    os.environ,
                    {"FAST_BROWSER_BRIDGE_HOME": str(unrelated), "TMPDIR": parent},
                ),
                patch("subprocess.run", side_effect=record),
            ):
                runpy.run_path(str(ROOT / "scripts/test-core.py"))
            self.assertTrue(calls)
            for env in calls:
                target = Path(env["FAST_BROWSER_BRIDGE_HOME"])
                self.assertNotEqual(target, unrelated)
                self.assertTrue(target.is_relative_to(Path(parent)))
            self.assertFalse(unrelated.exists())

    def test_inherited_bridge_home_cannot_escape_fixture(self):
        with tempfile.TemporaryDirectory() as parent:
            unrelated = Path(parent) / "must-not-be-used"
            with patch.dict(os.environ, {"FAST_BROWSER_BRIDGE_HOME": str(unrelated)}):
                with temporary_bridge_home() as home:
                    self.assertEqual(os.environ["FAST_BROWSER_BRIDGE_HOME"], str(home))
                    # 中文注释：先固定路径再导入，避免宿主默认配置污染运行时。
                    sys.path.insert(0, str(ROOT / "executor-plugin"))
                    try:
                        import native_runtime
                    finally:
                        sys.path.remove(str(ROOT / "executor-plugin"))
                    self.assertEqual(
                        Path(str(native_runtime.__file__)).resolve(),
                        ROOT / "executor-plugin/native_runtime.py",
                    )
                    profile = native_runtime.NativeProfileRuntime(home, ROOT / "executor-plugin")
                    try:
                        self.assertEqual(profile.bridge_home, home)
                        self.assertEqual(
                            profile.call("health", {}), {"ok": True, "protocolVersion": 1}
                        )
                    finally:
                        profile.close()
                        stop_fixture_daemon(home)
                    self.assertFalse(unrelated.exists())
                self.assertEqual(os.environ["FAST_BROWSER_BRIDGE_HOME"], str(unrelated))
            self.assertFalse(unrelated.exists())
