"""安装器固定的云端宿主摘要必须与源码字节一致，避免格式化或编辑悄悄破坏升级守卫。"""

import ast
import hashlib
import unittest
from pathlib import Path
import sys
import tempfile
import subprocess
import os

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-bridge"))

ROOT = Path(__file__).resolve().parents[2]


class CloudFencePinTest(unittest.TestCase):
    def test_doctor_reports_retired_cloud_without_ready_or_fix(self):
        from fbl_runtime import Context, doctor

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cloud = root / "runtime/plugin-data/fast-browser-link-cloud"
            cloud.mkdir(parents=True)
            token = cloud / "pairing.json"
            token.write_bytes(b"opaque fixture")
            result = doctor(
                Context(root / "user", root / "hermes", root / "runtime"), probe=lambda _: {}
            )
            check = next(row for row in result["checks"] if row["component"] == "cloud")
            self.assertFalse(check["ok"])
            self.assertEqual(check["code"], "retired_data_preserved")
            self.assertIn("preserved", check["command"])
            self.assertEqual(token.read_bytes(), b"opaque fixture")

    def test_declared_host_digest_matches_source(self):
        installer = (ROOT / "scripts/install-cli.py").read_text()
        declared = [
            node.value.value
            for node in ast.parse(installer).body
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and any(getattr(t, "id", None) == "CLOUD_FENCE_HOST_SHA256" for t in node.targets)
        ]
        source = subprocess.check_output(
            ["git", "show", "bd42da8138ffb94717325db0b01ae100f41266f1:cloud-link/native_host.py"],
            cwd=os.environ.get("BROWSER_LINK_RELEASE_HISTORY", ROOT),
        )
        digest = hashlib.sha256(source).hexdigest()
        self.assertEqual(declared, [digest])

    def test_retired_marker_does_not_bypass_legacy_instance_lock(self):
        import fcntl
        import importlib.util
        import json

        spec = importlib.util.spec_from_file_location(
            "retired_cli", ROOT / "scripts/install-cli.py"
        )
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        cli.EXECUTOR = cli.load_module("retired_executor", ROOT / "scripts/install-executor.py")
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "runtime"
            state = home / "plugin-data/fast-browser-link-native/install-state.json"
            state.parent.mkdir(parents=True)
            state.write_text(json.dumps({"cloudRetired": {"version": 1}}))
            state.chmod(0o600)
            cloud = home / "plugin-data/fast-browser-link-cloud"
            cloud.mkdir(mode=0o700)
            lock = cloud / "native.lock"
            lock.touch(mode=0o600)
            with lock.open("r+") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(cli.CloudGateError):
                    with cli.cloud_gate(home, installed=True, user_home=Path(directory) / "user"):
                        self.fail("retired marker bypassed a live legacy host")


if __name__ == "__main__":
    unittest.main()
