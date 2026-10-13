"""恢复诊断穿过 client 与公开工具结果投影，不丢失派发状态和截图路径。"""
import importlib.util
from pathlib import Path
import unittest
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


client = load('recovery_client', 'native-bridge/client.py')
runtime = load('recovery_runtime', 'executor-plugin/runtime.py')


class RecoveryProtocolTests(unittest.TestCase):
    def test_error_diagnostics_survive_client_and_public_result(self):
        details = {'triggered': True, 'rounds': 3, 'locator': 'role+name',
                   'strategies': [{'round': 3, 'scanned': 12, 'matched': 1}],
                   'candidates': [{'role': 'button', 'name': '保存', 'rect': {'x': 10, 'y': 20}}],
                   'screenshotPath': '/tmp/fast-recovery-fixture.png'}
        error = client.BridgeError('reference_target_missing', 'missing', {'outcomeUnknown': False, 'recovery': details})
        self.assertEqual(error.data['recovery'], details)
        result = runtime._project_tool_result('fast_browser_run', {'action': 'ref_click'},
                                            {'error': 'missing', 'code': 'reference_target_missing', 'outcome_unknown': False, 'recovery': error.data['recovery']})
        self.assertEqual(result['recovery'], details)
        self.assertFalse(result['outcome_unknown'])
        self.assertEqual(result['code'], 'reference_target_missing')

    def test_raw_images_and_private_metadata_do_not_escape_projection(self):
        result = runtime._project_tool_result('fast_browser_run', {'action': 'ref_click'},
                                            {'clicked': True, 'recovery': {'rounds': 1, 'screenshot': {'data': 'RAW'},
                                                                          'selected': {'role': 'button', 'name': '保存', 'owner': 'PRIVATE'}}})
        self.assertEqual(result['recovery'], {'rounds': 1, 'selected': {'role': 'button', 'name': '保存'}})


if __name__ == '__main__':
    unittest.main()
