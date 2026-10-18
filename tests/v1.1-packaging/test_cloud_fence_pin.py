"""安装器固定的云端宿主摘要必须与源码字节一致，避免格式化或编辑悄悄破坏升级守卫。"""

import ast
import hashlib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class CloudFencePinTest(unittest.TestCase):
    def test_declared_host_digest_matches_source(self):
        installer = (ROOT / "scripts/install-cli.py").read_text()
        declared = [
            node.value.value
            for node in ast.parse(installer).body
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and any(getattr(t, "id", None) == "CLOUD_FENCE_HOST_SHA256" for t in node.targets)
        ]
        digest = hashlib.sha256((ROOT / "cloud-link/native_host.py").read_bytes()).hexdigest()
        self.assertEqual(declared, [digest])

    def test_host_is_excluded_from_formatter(self):
        self.assertIn('"cloud-link/native_host.py"', (ROOT / "ruff.toml").read_text())


if __name__ == "__main__":
    unittest.main()
