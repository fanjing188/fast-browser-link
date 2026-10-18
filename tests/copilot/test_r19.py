"""升级双 unknown 与纪元短暂不可用回归；只使用临时安装、合成账本与进程列表。"""
import contextlib
import copy
import io
import json
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import patch
import test_r18 as fixtures
import fbl_cli
from fbl_update import task_status, update, UpdateRefused
from fbl_runtime import load


class R19(unittest.TestCase):
    setUpClass = fixtures.R18.__dict__['setUpClass']
    tearDownClass = fixtures.R18.__dict__['tearDownClass']
    setUp = fixtures.R18.setUp
    tearDown = fixtures.R18.tearDown
    install = fixtures.R18.install
    persist = fixtures.R18.persist
    run_update = fixtures.R18.run_update

    def prepare(self):
        cli = fixtures.R18.prepare(self)
        self.rows = [copy.deepcopy(self.rows[44])]
        self.rows[0]['cleanupState'] = 'unknown'
        self.rows[0]['cleanupReason'] = 'original cleanup uncertainty'
        self.persist()
        return cli

    @contextlib.contextmanager
    def epoch_sequence(self, cli, values):
        clock = [0.0]
        def sleep(seconds): clock[0] += seconds
        with patch.object(cli, 'browser_epoch', side_effect=values) as probe, \
                patch('fbl_update.time.monotonic', side_effect=lambda: clock[0]), \
                patch('fbl_update.time.sleep', side_effect=sleep):
            yield probe, clock

    def invoke(self, *options):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(fbl_cli.Context, 'locate', return_value=self.ctx), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fbl_cli.main(['update', '--source', str(self.release),
                                 '--user-home', str(self.user), '--hermes-home', str(self.hermes),
                                 '--runtime', str(self.runtime), *options])
        return code, json.loads(out.getvalue()), err.getvalue()

    def test_double_unknown_terminal_matrix_old_and_current_epochs(self):
        cli = self.prepare(); base = copy.deepcopy(self.rows[0])
        for cleanup in ('succeeded', 'unknown', 'failed'):
            for state in ('closed', 'cancelled', 'failed'):
                for old in (True, False):
                    with self.subTest(cleanup=cleanup, state=state, old=old):
                        row = {**base, 'state': state, 'cleanupState': cleanup, 'updatedAt': 110 if old else 300}
                        self.rows = [row]; self.persist()
                        groups, eligible = task_status(self.ctx, cli)
                        self.assertFalse(groups['active']); self.assertFalse(groups['after_daemon_stop'])
                        pending, = groups['needs_verification']
                        self.assertEqual(pending['safe_to_settle'], old)
                        self.assertEqual(bool(eligible), old)
                        self.assertEqual(cli.task_block_reason(row, daemon_stopped=True), 'verification')

    def test_settlement_preserves_double_unknown_and_private_backup(self):
        cli = self.prepare(); before = self.path.read_bytes()
        result = self.run_update(yes=True)
        receipt, = result['acknowledged_tasks']
        backup = Path(receipt['backup'])
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        row, = json.loads(self.path.read_text())['tasks']
        self.assertEqual(row['cleanupState'], 'succeeded')
        self.assertEqual(row['cleanupReason'], 'verified_complete')
        self.assertEqual(row['userVerified']['previousCleanupState'], 'unknown')
        self.assertEqual(row['userVerified']['previousCleanupReason'], 'original cleanup uncertainty')
        for field in ('currentOperation', 'operationTimeline', 'requestHistory'):
            self.assertEqual(row[field], self.rows[0][field])
        self.assertEqual(len(row['userVerified']['operations']), 2)
        self.assertTrue(all(note['state'] == 'verified_complete' for note in row['userVerified']['operations']))
        cli.assert_tasks_idle(self.runtime, daemon_stopped=True)
        groups, eligible = task_status(self.ctx, cli)
        self.assertFalse(eligible); self.assertEqual(len(groups['after_daemon_stop']), 1)

    def test_double_unknown_write_still_cannot_replay(self):
        def prepare():
            cli = fixtures.R18.prepare(self)
            self.rows[44]['cleanupState'] = 'unknown'; self.persist()
            return cli
        with patch.object(self, 'prepare', side_effect=prepare):
            fixtures.R18.test_settled_unknown_write_still_reports_unknown_and_cannot_replay(self)

    def test_unfinished_timeline_blocks_even_with_unknown_cleanup(self):
        cli = self.prepare()
        self.rows[0]['currentOperation']['state'] = 'succeeded'
        self.rows[0]['operationTimeline'][0]['state'] = 'running'; self.persist()
        groups, eligible = task_status(self.ctx, cli)
        self.assertEqual(len(groups['active']), 1); self.assertFalse(eligible)

    def test_transient_missing_epoch_recovers_in_dry_run_and_real_update(self):
        cli = self.prepare(); before = self.path.read_bytes()
        with self.epoch_sequence(cli, iter([None, None, 200])) as (probe, clock):
            preview = update(self.ctx, self.release, dry_run=True)
        self.assertEqual(probe.call_count, 3); self.assertEqual(clock[0], 1)
        self.assertTrue(preview['ready_after_confirmation']); self.assertEqual(preview['blocking'], [])
        self.assertEqual(before, self.path.read_bytes())
        with self.epoch_sequence(cli, iter([None, None, *([200] * 20)])):
            result = self.run_update(yes=True)
        self.assertEqual(result['status'], 'updated')

    def test_missing_epoch_retries_ten_seconds_then_refuses_without_mutation(self):
        cli = self.prepare(); before = self.path.read_bytes()
        with self.epoch_sequence(cli, iter([None] * 100)) as (probe, clock), patch.object(cli, 'stop_daemon') as stop:
            code, result, stderr = self.invoke('--yes')
        self.assertEqual(code, 1); self.assertEqual(clock[0], 10); self.assertEqual(probe.call_count, 21)
        self.assertEqual(result['status'], 'refused'); self.assertEqual(result['reason'], 'browser_epoch_unavailable')
        row, = result['blocking']
        self.assertEqual(row['title'], self.rows[0]['title']); self.assertEqual(row['group'], 'needs_verification')
        self.assertEqual(row['reason'], 'browser_epoch_unavailable')
        self.assertIn('真正进行中：0', stderr); self.assertIn('有 1 条暂不能安全结清', stderr)
        self.assertIn('先打开再关闭浏览器', stderr)
        stop.assert_not_called(); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(list(self.ctx.data.glob('tasks.json.ack-*')))
        self.assertFalse((self.runtime / 'fbl-backups').exists())
        # 中文注释：建议沿用当前源码入口、包与布局，不意外调用已安装旧 CLI 或另一个账本。
        command = shlex.split(result['retry_command'])
        self.assertEqual(command[2], str(Path(fbl_cli.__file__).resolve()))
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            code = fbl_cli.main(command[3:])
        retried = json.loads(output.getvalue())
        self.assertEqual(code, 0); self.assertEqual(retried['status'], 'updated')

    def test_unavailable_epoch_dry_run_explains_same_blocking_reason(self):
        cli = self.prepare()
        with self.epoch_sequence(cli, iter([None] * 100)):
            code, result, _ = self.invoke('--dry-run')
        self.assertEqual(code, 0); self.assertEqual(result['status'], 'dry_run')
        self.assertFalse(result['ready_after_confirmation'])
        self.assertEqual(result['reason'], 'browser_epoch_unavailable')
        self.assertEqual(result['blocking'][0]['reason'], 'browser_epoch_unavailable')

    def test_current_epoch_and_confirmation_refusals_are_structured(self):
        cli = self.prepare(); self.rows[0]['updatedAt'] = 300; self.persist()
        with patch.object(cli, 'stop_daemon') as stop:
            code, result, _ = self.invoke('--yes')
        self.assertEqual(code, 1); self.assertEqual(result['reason'], 'verification_required')
        self.assertEqual(result['blocking'][0]['reason'], 'current_epoch_or_missing_times'); stop.assert_not_called()
        self.rows[0]['updatedAt'] = 110; self.persist()
        with patch('sys.stdin.isatty', return_value=False): code, result, _ = self.invoke()
        self.assertEqual(code, 1); self.assertEqual(result['reason'], 'confirmation_required')
        self.assertEqual(result['blocking'][0]['title'], self.rows[0]['title'])
        self.assertIn('--yes', result['retry_command'])

    def test_interactive_decline_keeps_stdout_valid_json(self):
        self.prepare()
        with patch('sys.stdin.isatty', return_value=True), patch('builtins.input', return_value='n') as answer:
            code, result, stderr = self.invoke()
        self.assertEqual(code, 1); self.assertEqual(result['reason'], 'confirmation_required')
        self.assertIn('确认备份并结清上述 1 个', stderr)
        answer.assert_called_once_with()

    def test_active_and_unreadable_records_give_structured_reasons(self):
        self.prepare(); self.rows[0]['agentTabIds'] = [7]; self.persist()
        code, result, _ = self.invoke('--yes')
        self.assertEqual(code, 1); self.assertEqual(result['reason'], 'active_tasks')
        self.assertEqual(result['blocking'][0]['group'], 'active')
        self.assertIn('代理标签页/弹窗', result['blocking'][0]['message'])
        self.path.write_text('invalid fixture JSON')
        code, result, _ = self.invoke('--yes')
        self.assertEqual(code, 1); self.assertEqual(result['blocking'][0]['reason'], 'records_unreadable')

    def test_other_validation_and_installer_errors_also_return_refused_json(self):
        cli = self.prepare()
        for error in (ValueError('release file set or digest mismatch'), cli.InstallError('process unavailable', 'inspect process permissions')):
            with self.subTest(error=error), patch.object(fbl_cli, 'update', side_effect=error):
                code, result, stderr = self.invoke('--yes')
            self.assertEqual(code, 1); self.assertEqual(result['status'], 'refused')
            self.assertTrue(result['blocking']); self.assertIn('message', result['blocking'][0])
            self.assertIn(str(error), stderr)

    def test_browser_exit_empty_process_list_is_unavailable_not_restart_evidence(self):
        self.prepare(); cli = load('r19_epoch', self.ctx.support / 'install-cli.py')
        # 中文注释：本轮没有退出本机浏览器；直接验证 ps 的三个源码分支，确认无进程与查询失败都无纪元。
        for result in (subprocess.CompletedProcess([], 0, '', ''), subprocess.CompletedProcess([], 1, '', 'unavailable')):
            with patch.object(cli, 'command', return_value=result) as command:
                self.assertIsNone(cli.browser_epoch({}))
            self.assertEqual(command.call_args.kwargs['timeout'], 1)
        with patch.object(cli, 'command', side_effect=cli.InstallError('ps timeout', 'retry')):
            self.assertIsNone(cli.browser_epoch({}))

    def test_epoch_lost_during_locked_recheck_refuses_without_ack(self):
        cli = self.prepare()
        with self.epoch_sequence(cli, iter([200, 200, 200, 200, *([None] * 100)])), \
                patch.object(cli, 'stop_daemon'), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(UpdateRefused) as error: update(self.ctx, self.release, yes=True)
        self.assertEqual(error.exception.reason, 'browser_epoch_unavailable')
        self.assertFalse(list(self.ctx.data.glob('tasks.json.ack-*')))
        self.assertTrue((self.ctx.data / 'host-bin/old-fixture').exists())


if __name__ == '__main__': unittest.main()
