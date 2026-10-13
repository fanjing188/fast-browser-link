"""用真实 Hermes 插件管理器验证注册、未绑定回退、卸载和旧插件冲突保护。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class HermesRegistryTests(unittest.TestCase):
    def test_real_registry_preserves_existing_tools_in_all_permission_modes(self):
        source = os.environ.get('HERMES_SOURCE', str(Path.home() / '.hermes/hermes-agent'))
        self.assertTrue((Path(source) / 'hermes_cli/plugins.py').is_file(), '需要真实 Hermes 测试源码')
        for mode in ('no-override', 'override', 'vault', 'legacy'):
            with self.subTest(mode=mode):
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('hermes_registry_probe.py')), mode],
                    env={**os.environ, 'HERMES_SOURCE': source, 'PYTHONDONTWRITEBYTECODE': '1'},
                    text=True, capture_output=True, timeout=45)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                report = json.loads(result.stdout.splitlines()[-1])
                self.assertTrue(report['unload_restored'])
                self.assertGreater(report['original_tools'], report['browser_tools'])
                if mode in ('override', 'vault'):
                    self.assertEqual(report['unbound_calls'], report['browser_tools'])
                else:
                    self.assertEqual(report['changed'], [])


if __name__ == '__main__': unittest.main()
