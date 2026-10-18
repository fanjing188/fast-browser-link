"""假 CLI 验证安装命令，不访问个人 agent 配置。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mcp_install", ROOT / "native-bridge/fbl_mcp.py")
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)


class InstallTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = SimpleNamespace(runtime=Path(tmp.name))
        entry = self.ctx.runtime / "runtime/agent-link/fast_browser_link.py"
        entry.parent.mkdir(parents=True)
        entry.touch()
        self.fake = self.ctx.runtime / "fake-cli.py"
        self.fake.write_text(
            "import json,sys\nfrom pathlib import Path\nroot=Path(__file__).parent\nargs=sys.argv[1:]\nwith (root/'calls.jsonl').open('a') as out: out.write(json.dumps(args)+'\\n')\nif args[:2]==['mcp','list']:\n print(json.dumps([{'name':'fast-browser-link'}] if (root/'exists').exists() else []))\nelif args[:2]==['mcp','get']:\n if (root/'exists').exists(): print('configured')\n else:\n  print('No MCP server found with name: fast-browser-link',file=sys.stderr)\n  sys.exit(1)\n"
        )

    def run_cli(self, argv, **kwargs):
        return subprocess.run([sys.executable, str(self.fake), *argv[1:]], **kwargs)

    def calls(self):
        path = self.ctx.runtime / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_preview_and_dry_run_do_not_invoke_cli(self):
        for agent in ("codex", "claude"):
            for options in ({}, {"dry_run": True}, {"apply": True, "dry_run": True}):
                result = mcp.install(self.ctx, agent, run=self.run_cli, **options)
                self.assertEqual(result["status"], "preview")
                self.assertIn("--mcp", result["argv"])
                self.assertEqual(self.calls(), [])

    def test_apply_uses_exact_argv_and_preserves_existing(self):
        for agent in ("codex", "claude"):
            result = mcp.install(self.ctx, agent, apply=True, run=self.run_cli)
            self.assertEqual(result["status"], "installed")
            self.assertEqual(self.calls()[-1], result["argv"][1:])
            self.assertIn("FAST_BROWSER_LINK_HOME=" + str(self.ctx.runtime), result["argv"])
            if agent == "claude":
                self.assertEqual(result["argv"][3:7], ["--scope", "user", "--transport", "stdio"])
        (self.ctx.runtime / "exists").touch()
        for agent in ("codex", "claude"):
            before = len(self.calls())
            result = mcp.install(self.ctx, agent, apply=True, run=self.run_cli)
            self.assertEqual(result["status"], "already_exists")
            self.assertEqual(len(self.calls()), before + 1)

    def test_unreadable_configuration_fails_closed(self):
        def fail(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 2, "", "permission denied")

        with self.assertRaises(ValueError):
            mcp.install(self.ctx, "claude", apply=True, run=fail)


if __name__ == "__main__":
    unittest.main()
