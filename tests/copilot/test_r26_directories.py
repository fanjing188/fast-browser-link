"""目录设置仅使用临时目录与子进程替身，不打开真实选择器或文件目录。"""
import ast
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-bridge'))
from copilot import Copilot
from copilot_directories import CHOOSE_SCRIPT, Directories, export_directory


class DirectoriesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.service = Directories(self.root / 'copilot')

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def choose(self, process):
        with patch('copilot_directories.sys.platform', 'darwin'), patch('copilot_directories.subprocess.Popen', return_value=process) as launch:
            job = self.service.request('one', 'directory_choose_start', {})
            self.service.jobs[job['id']]['thread'].join(timeout=2)
            self.assertFalse(self.service.jobs[job['id']]['thread'].is_alive())
            return self.service.request('one', 'directory_choose_status', {'id': job['id']}), launch

    def test_default_paths_are_derived_at_runtime(self):
        with patch('copilot_directories.Path.home', return_value=self.root):
            self.assertEqual(self.service.request('one', 'directory_defaults', {}), {
                'export_dir': str(self.root / 'Downloads' / 'fast-browser-link'),
                'logs_dir': str(self.root / 'copilot' / 'logs')})

    def test_selected_directory_uses_fixed_argv_without_shell_or_path_interpolation(self):
        selected = self.root / '目录 " $(unsafe) `literal`'
        selected.mkdir()
        process = Mock(returncode=0)
        process.communicate.return_value = (str(selected) + '/\n', None)
        result, launch = self.choose(process)
        self.assertEqual(result['status'], 'selected')
        self.assertEqual(result['path'], str(selected))
        launch.assert_called_once_with(['/usr/bin/osascript', '-e', CHOOSE_SCRIPT],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        process.communicate.assert_called_once_with(timeout=120)
        self.assertFalse((self.root / 'copilot' / 'config.json').exists())

    def test_picker_cancelled_without_path(self):
        process = Mock(returncode=0)
        process.communicate.return_value = ('\n', None)
        result, _ = self.choose(process)
        self.assertEqual(set(result), {'id', 'status'})
        self.assertEqual(result['status'], 'cancelled')

    def test_timeout_kills_and_reaps_picker(self):
        process = Mock(returncode=None)
        process.communicate.side_effect = subprocess.TimeoutExpired('fixture', 120)
        result, _ = self.choose(process)
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['error'], 'picker_timeout')
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        process.stdout.close.assert_called_once()

    def test_communicate_error_kills_reaps_and_closes_picker(self):
        process = Mock(returncode=None)
        process.communicate.side_effect = OSError('PRIVATE read failure')
        result, _ = self.choose(process)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['error'], 'picker_failed')
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        process.stdout.close.assert_called_once()
        self.assertIsNone(self.service.jobs[result['id']]['process'])

    def test_reap_error_still_clears_job_process_and_closes_pipes(self):
        process = Mock(returncode=None)
        process.communicate.side_effect = OSError('PRIVATE read failure')
        process.wait.side_effect = OSError('PRIVATE wait failure')
        result, _ = self.choose(process)
        self.assertEqual(result['status'], 'error')
        self.assertNotIn('PRIVATE', json.dumps(result))
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()
        self.assertIsNone(self.service.jobs[result['id']]['process'])

    def test_failed_or_invalid_picker_output_stays_fixed_error(self):
        for returncode, output in [(1, 'PRIVATE_ERROR'), (0, 'https://example.test/'), (0, str(self.root / 'missing')), (0, str(self.root) + '\nPRIVATE')]:
            with self.subTest(output=output):
                process = Mock(returncode=returncode)
                process.communicate.return_value = (output + '\n', None)
                result, _ = self.choose(process)
                self.assertEqual(result['status'], 'error')
                self.assertEqual(result['error'], 'picker_failed')
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_request_does_not_wait_for_user_and_same_instance_reuses_active_job(self):
        entered = threading.Event()
        release = threading.Event()
        process = Mock(returncode=0)
        def communicate(**_):
            entered.set()
            release.wait(timeout=2)
            return ('\n', None)
        process.communicate.side_effect = communicate
        process.kill.side_effect = release.set
        with patch('copilot_directories.sys.platform', 'darwin'), patch('copilot_directories.subprocess.Popen', return_value=process) as launch:
            job = self.service.request('one', 'directory_choose_start', {})
            self.assertTrue(entered.wait(timeout=1))
            self.assertEqual(self.service.request('one', 'directory_choose_start', {}), job)
            self.assertEqual(self.service.request('one', 'directory_choose_status', {'id': job['id']})['status'], 'pending')
            self.service.request('one', 'directory_choose_cancel', {'id': job['id']})
            self.service.jobs[job['id']]['thread'].join(timeout=2)
            self.assertEqual(self.service.request('one', 'directory_choose_status', {'id': job['id']})['status'], 'cancelled')
            launch.assert_called_once()
            process.kill.assert_called_once()

    def test_job_is_instance_bound_and_accepts_only_exact_parameters(self):
        process = Mock(returncode=0)
        process.communicate.return_value = ('\n', None)
        job, _ = self.choose(process)
        for method, params in [('directory_choose_status', {'id': job['id']}), ('directory_choose_cancel', {'id': job['id']})]:
            with self.assertRaises(ValueError):
                self.service.request('two', method, params)
        for method, params in [('directory_defaults', {'path': '/private'}), ('directory_open_logs', {'url': 'https://example.test'}),
                               ('directory_choose_start', {'path': str(self.root)}), ('directory_choose_status', {}),
                               ('directory_choose_status', {'id': []}), ('directory_choose_cancel', {'id': job['id'], 'path': str(self.root)})]:
            with self.assertRaises(ValueError):
                self.service.request('one', method, params)

    def test_logs_only_opens_fixed_instance_directory(self):
        with patch('copilot_directories.sys.platform', 'darwin'), patch('copilot_directories.subprocess.run') as launch:
            self.assertEqual(self.service.request('one', 'directory_open_logs', {}), {'opened': True})
            launch.assert_called_once_with(['/usr/bin/open', str(self.root / 'copilot' / 'logs')],
                                           check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertTrue((self.root / 'copilot' / 'logs').is_dir())

    def test_logs_symlink_is_rejected_before_opening(self):
        self.service.logs.parent.mkdir()
        self.service.logs.symlink_to(self.root, target_is_directory=True)
        with patch('copilot_directories.subprocess.run') as launch:
            with self.assertRaises(ValueError):
                self.service.request('one', 'directory_open_logs', {})
            launch.assert_not_called()

    def test_close_kills_own_picker_and_does_not_overwrite_cancelled_state(self):
        entered = threading.Event()
        release = threading.Event()
        process = Mock(returncode=-9)
        def communicate(**_):
            entered.set()
            release.wait(timeout=2)
            return ('', None)
        process.communicate.side_effect = communicate
        process.kill.side_effect = release.set
        with patch('copilot_directories.sys.platform', 'darwin'), patch('copilot_directories.subprocess.Popen', return_value=process):
            job = self.service.request('one', 'directory_choose_start', {})
            self.assertTrue(entered.wait(timeout=1))
            self.service.close()
            self.assertEqual(self.service.jobs[job['id']]['status'], 'cancelled')
            self.assertFalse(self.service.jobs[job['id']]['thread'].is_alive())
            process.kill.assert_called_once()
            with self.assertRaises(ValueError):
                self.service.request('one', 'directory_defaults', {})

    def test_unsupported_picker_and_launch_failure_are_clear(self):
        with patch('copilot_directories.sys.platform', 'linux'), patch('copilot_directories.subprocess.Popen') as launch:
            job = self.service.request('one', 'directory_choose_start', {})
            self.service.jobs[job['id']]['thread'].join(timeout=1)
            self.assertEqual(self.service.request('one', 'directory_choose_status', {'id': job['id']})['error'], 'unsupported_platform')
            launch.assert_not_called()
        with patch('copilot_directories.sys.platform', 'darwin'), patch('copilot_directories.subprocess.Popen', side_effect=OSError('PRIVATE')):
            job = self.service.request('one', 'directory_choose_start', {})
            self.service.jobs[job['id']]['thread'].join(timeout=1)
            self.assertEqual(self.service.request('one', 'directory_choose_status', {'id': job['id']})['error'], 'picker_failed')

    def test_export_preference_validation_rejects_relative_files_and_symlinks(self):
        file = self.root / 'file'
        file.write_text('fixture')
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        for value in ['', 'relative/path', 'https://example.test/', str(file), str(link / 'child'), str(self.root) + '\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                export_directory(value)
        self.assertEqual(export_directory(str(self.root / 'new-directory')), str(self.root / 'new-directory'))

    def test_active_and_retained_jobs_are_bounded(self):
        for index in range(16):
            self.service.jobs[str(index)] = {'id': str(index), 'owner': str(index), 'status': 'pending', 'process': None, 'thread': Mock()}
        with self.assertRaises(ValueError):
            self.service.request('one', 'directory_choose_start', {})
        self.service.jobs.clear()
        process = Mock(returncode=0)
        process.communicate.return_value = ('\n', None)
        for _ in range(35):
            self.choose(process)
        self.assertEqual(len(self.service.jobs), 32)

    def test_copilot_dispatch_avoids_copilot_lock_and_preferences_persist_atomically(self):
        app = Copilot(self.root / 'app')
        try:
            class ForbiddenLock:
                def __enter__(self): raise AssertionError('directory request must not acquire Copilot.lock')
                def __exit__(self, *_): pass
            original = app.lock
            app.lock = ForbiddenLock()
            try:
                self.assertIn('logs_dir', app.request('one', 'directory_defaults', {}))
            finally:
                app.lock = original
            destination = self.root / 'exports'
            with patch('fbl_runtime.os.replace', wraps=__import__('os').replace) as replace:
                app.request('one', 'preferences', {'table_export_dir': str(destination)})
                replace.assert_called_once()
            self.assertEqual(json.loads((self.root / 'app' / 'config.json').read_text())['table_export_dir'], str(destination))
            self.assertEqual(app.config['table_export_dir'], str(destination))
            previous = (self.root / 'app' / 'config.json').read_bytes()
            with patch('fbl_runtime.os.replace', side_effect=OSError('fixture atomic write failure')):
                with self.assertRaises(OSError):
                    app.request('one', 'preferences', {'table_export_dir': str(self.root / 'other')})
            self.assertEqual((self.root / 'app' / 'config.json').read_bytes(), previous)
            self.assertEqual(app.config['table_export_dir'], str(destination))
            with self.assertRaises(ValueError):
                app.request('one', 'preferences', {'table_export_dir': 'relative'})
            self.assertEqual(app.config['table_export_dir'], str(destination))
        finally:
            app.close()

    def test_installation_file_list_contains_new_import_closure(self):
        tree = ast.parse((ROOT / 'native-bridge' / 'install.py').read_text())
        assignment = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'native_files' for target in node.targets))
        files = ast.literal_eval(assignment.value)
        self.assertIn('copilot_directories.py', files)
        host = self.root / 'synthetic-host'
        host.mkdir()
        for name in files:
            shutil.copyfile(ROOT / 'native-bridge' / name, host / name)
        # 中文注释：只在隔离模块目录导入，验证安装清单闭包，不运行安装或宿主服务。
        result = subprocess.run([sys.executable, '-I', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import copilot;assert copilot.Directories', str(host)],
                                check=True, capture_output=True, text=True)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
