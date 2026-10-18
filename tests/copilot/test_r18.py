"""维护时核实终态未知操作；夹具与升级全部限定在临时安装树。"""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import test_r17 as fixtures
from copilot import private_write
from fbl_update import update, task_status
from fbl_runtime import load

ROOT = Path(__file__).resolve().parents[2]


class R18(unittest.TestCase):
    setUpClass = fixtures.R17.__dict__['setUpClass']
    tearDownClass = fixtures.R17.__dict__['tearDownClass']
    setUp = fixtures.R17.setUp
    tearDown = fixtures.R17.tearDown
    install = fixtures.R17.install
    persist = fixtures.R17.persist
    run_update = fixtures.R17.run_update

    def prepare(self):
        cli = fixtures.R17.prepare(self)
        clean = {**self.rows[0], 'agentTabIds': [], 'adoptedPopupTabIds': []}
        self.rows = [{**copy.deepcopy(clean), 'id': str(i), 'title': f'Historical task {i}'} for i in range(63)]
        for row in self.rows[44:62]:
            row['state'] = ('closed', 'cancelled', 'failed')[int(row['id']) % 3]
            row['currentOperation'] = {'state': 'unknown', 'startedAt': 105, 'completedAt': 109,
                                       'errorCode': 'permission_denied', 'requestIdHash': 'a' * 64}
            row['operationTimeline'] = [dict(row['currentOperation'])]
        self.rows[-1]['cleanupState'] = 'unknown'
        self.persist()
        return cli

    def test_dry_run_matches_reported_ledger_without_writing_or_stopping(self):
        cli = self.prepare(); before = self.path.read_bytes()
        with patch.object(cli, 'stop_daemon') as stop:
            result = update(self.ctx, self.release, dry_run=True)
        self.assertEqual({key: value['count'] for key, value in result['task_check'].items()},
                         {'active': 0, 'after_daemon_stop': 44, 'needs_verification': 19})
        self.assertEqual(result['safe_to_settle'], 19)
        self.assertTrue(result['ready_after_confirmation'])
        self.assertTrue(result['source_verified']); self.assertFalse(result['download_required'])
        stop.assert_not_called(); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(list(self.ctx.data.glob('tasks.json.ack-*')))
        self.assertFalse((self.runtime / 'fbl-backups').exists())

    def test_terminal_current_and_timeline_unknown_require_epoch_verification(self):
        cli = self.prepare(); base = self.rows[44]
        for state in ('closed', 'cancelled', 'failed'):
            for kind in ('current', 'timeline', 'both'):
                for current in (False, True):
                    with self.subTest(state=state, kind=kind, current=current):
                        row = copy.deepcopy(base); row['state'] = state
                        if kind == 'current': row['operationTimeline'] = []
                        if kind == 'timeline': row['currentOperation']['state'] = 'succeeded'
                        if current: row['updatedAt'] = 300
                        self.rows = [row]; self.persist()
                        groups, eligible = task_status(self.ctx, cli)
                        self.assertFalse(groups['active']); self.assertFalse(groups['after_daemon_stop'])
                        self.assertEqual(len(groups['needs_verification']), 1)
                        self.assertEqual(groups['needs_verification'][0]['safe_to_settle'], not current)
                        self.assertEqual(bool(eligible), not current)
                        self.assertEqual(cli.task_block_reason(row, daemon_stopped=True), 'verification')

    def test_permits_pending_input_tabs_and_nonterminal_remain_active(self):
        cli = self.prepare(); base = self.rows[44]
        for change in ({'state': 'ready'}, {'state': 'needs_sync'}, {'vaultPermit': {}}, {'gatewayPermit': {}},
                       {'idlePendingHuman': True}, {'idleRecoveryState': 'pending_approval'},
                       {'requestHistory': [{'state': 'awaiting_human'}]},
                       {'requestHistory': [{'state': 'awaiting_approval'}]},
                       {'agentTabIds': [7]}, {'adoptedPopupTabIds': [8]}, {'agentTabIds': None},
                       {'cleanupState': 'pending'},
                       {'currentOperation': {'state': 'running'}}):
            with self.subTest(change=change):
                row = {**base, **change}; self.rows = [row]; self.persist(); before = self.path.read_bytes()
                groups, eligible = task_status(self.ctx, cli)
                self.assertEqual(len(groups['active']), 1); self.assertFalse(eligible)
                with patch.object(cli, 'stop_daemon') as stop:
                    with self.assertRaisesRegex(ValueError, '真正进行中：1'):
                        update(self.ctx, self.release, yes=True)
                stop.assert_not_called(); self.assertEqual(before, self.path.read_bytes())

    def test_unknown_requires_confirmation_before_maintenance(self):
        cli = self.prepare(); before = self.path.read_bytes()
        for confirm in (None, lambda _: False):
            with patch.object(cli, 'stop_daemon') as stop, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(ValueError, '尚未确认'):
                    update(self.ctx, self.release, confirm=confirm)
            stop.assert_not_called(); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse((self.runtime / 'fbl-backups').exists())

    def assert_settled(self, result, before):
        self.assertEqual(result['status'], 'updated')
        receipt, = result['acknowledged_tasks']
        self.assertEqual(Path(receipt['backup']).read_bytes(), before)
        self.assertEqual(Path(receipt['backup']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.ctx.data.glob('tasks.json.ack-*'))), 1)
        settled = json.loads(self.path.read_text())['tasks']
        self.assertEqual(settled[:44], self.rows[:44])
        self.assertEqual(len(receipt['taskIds']), 19)
        for original, row in zip(self.rows[44:62], settled[44:62]):
            self.assertEqual(row['currentOperation'], original['currentOperation'])
            self.assertEqual(row['operationTimeline'], original['operationTimeline'])
            self.assertEqual(row['requestHistory'], original['requestHistory'])
            self.assertEqual(row['userVerified']['previousCleanupState'], 'succeeded')
            self.assertEqual(row['userVerified']['operations'], [
                {'field': field, 'index': 0, 'state': 'verified_complete', 'previousState': 'unknown', 'requestIdHash': 'a' * 64}
                for field in ('currentOperation', 'operationTimeline')])
        self.cli.assert_tasks_idle(self.runtime, daemon_stopped=True)
        groups, eligible = task_status(self.ctx, self.cli)
        self.assertFalse(groups['active']); self.assertFalse(groups['needs_verification']); self.assertFalse(eligible)
        self.assertEqual(len(groups['after_daemon_stop']), 63)
        # 中文注释：人工备注只在维护停机后生效；活 daemon 的历史守卫继续拒绝。
        with self.assertRaises(self.cli.CloudGateError): self.cli.assert_tasks_idle(self.runtime)

    def test_yes_settles_unknown_after_stop_and_preserves_original_ledger(self):
        self.prepare(); before = self.path.read_bytes()
        self.assert_settled(self.run_update(yes=True), before)

    def test_interactive_confirmation_displays_count_and_preserves_results(self):
        self.prepare(); before = self.path.read_bytes(); prompts = []
        result = self.run_update(confirm=lambda prompt: prompts.append(prompt) or True)
        self.assertEqual(prompts, ['确认备份并结清上述 19 个旧浏览器纪元任务（保留原始操作结果）？[y/N] '])
        self.assert_settled(result, before)

    def test_current_epoch_cannot_settle_even_with_yes(self):
        cli = self.prepare(); self.rows[44]['updatedAt'] = 300; self.persist(); before = self.path.read_bytes()
        result = update(self.ctx, self.release, dry_run=True)
        self.assertEqual(result['safe_to_settle'], 18); self.assertFalse(result['ready_after_confirmation'])
        with patch.object(cli, 'stop_daemon') as stop:
            with self.assertRaisesRegex(ValueError, '需要核实：19'): update(self.ctx, self.release, yes=True)
        stop.assert_not_called(); self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(list(self.ctx.data.glob('tasks.json.ack-*')))

    def test_missing_epoch_or_recent_operation_never_qualifies(self):
        cli = self.prepare(); base = self.rows[44]
        for change in ({'updatedAt': None}, {'createdAt': float('nan')}, {'lastActivityAt': 200},
                       {'currentOperation': {**base['currentOperation'], 'completedAt': 300}},
                       {'operationTimeline': [{'state': 'unknown', 'startedAt': 300}]},
                       {'requestHistory': [{'state': 'dispatched', 'time': 300}]}):
            with self.subTest(change=change): self.assertFalse(cli.old_browser_task({**base, **change}, 200))
        self.assertFalse(cli.old_browser_task(base, None))

    def test_new_residual_tab_before_locked_ack_refuses_without_backup(self):
        cli = self.prepare()
        def stop(*_):
            self.rows[44]['adoptedPopupTabIds'] = [7]; self.persist()
        with patch.object(cli, 'stop_daemon', side_effect=stop), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(ValueError): update(self.ctx, self.release, yes=True)
        self.assertFalse(list(self.ctx.data.glob('tasks.json.ack-*')))
        self.assertTrue((self.ctx.data / 'host-bin/old-fixture').exists())

    def test_manual_ack_current_epoch_records_notes_without_rewriting_unknown(self):
        self.prepare(); self.rows = [self.rows[44]]; self.rows[0]['updatedAt'] = 300; self.persist()
        before = self.path.read_bytes()
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/tasks-ack.py'),
            self.rows[0]['id'], '--hermes-home', str(self.runtime), '--reason', 'Synthetic browser verification'],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(json.loads(result.stdout)['backup']).read_bytes(), before)
        row = json.loads(self.path.read_text())['tasks'][0]
        self.assertEqual(row['currentOperation'], self.rows[0]['currentOperation'])
        self.assertEqual(row['operationTimeline'], self.rows[0]['operationTimeline'])
        self.assertEqual(row['userVerified']['operations'][0]['state'], 'verified_complete')
        groups, eligible = task_status(self.ctx, self.cli)
        self.assertEqual(len(groups['after_daemon_stop']), 1)
        self.assertFalse(groups['needs_verification']); self.assertFalse(eligible)

    def test_settled_unknown_write_still_reports_unknown_and_cannot_replay(self):
        self.prepare()
        params = {'owner': 'fixture', 'taskId': '44', 'requestId': 'uncertain-write', 'action': 'click', 'tabId': 7, 'selector': '#confirm'}
        request_hash = hashlib.sha256(params['requestId'].encode()).hexdigest()
        payload = json.dumps({key: value for key, value in params.items() if key not in {'owner', 'requestId'}}, sort_keys=True, separators=(',', ':'))
        row = self.rows[44]
        row['requestHistory'] = [{'state': 'unknown', 'dispatched': True, 'time': 105, 'requestIdHash': request_hash,
                                  'payloadHash': hashlib.sha256(payload.encode()).hexdigest()}]
        row['currentOperation']['requestIdHash'] = request_hash
        row['operationTimeline'][0]['requestIdHash'] = request_hash
        self.rows = [row]; self.persist(); self.run_update(yes=True)
        module = load('r18_daemon', ROOT / 'native-bridge/daemon.py')
        daemon = module.BridgeDaemon(self.runtime); daemon._load_tasks()
        with patch.object(daemon, '_extension_call') as execute:
            status = daemon._operation_status({key: params[key] for key in ('owner', 'taskId', 'requestId')})
            self.assertEqual(status['state'], 'unknown'); self.assertTrue(status['dispatched'])
            self.assertEqual(daemon.tasks['44']['currentOperation']['state'], 'unknown')
            with self.assertRaises(module.ProtocolError) as replay: daemon._run_task(params)
            # 中文注释：failed 终态走原请求哈希账本，确认备注不能使旧写入再次派发。
            self.assertEqual(replay.exception.code, 'request_outcome_unavailable')
        execute.assert_not_called()


if __name__ == '__main__': unittest.main()
