"""OAuth popup adoption uses real daemon approval and request ledgers offline."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from client import BridgeError
SPEC=importlib.util.spec_from_file_location('oauth_daemon',ROOT/'native-bridge/daemon.py')
assert SPEC is not None and SPEC.loader is not None
m=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=m;SPEC.loader.exec_module(m)

class PopupTests(unittest.TestCase):
    def test_inventory_diagnostics_survive_daemon_and_client_without_exception_text(self):
        for reason in ('inventory_exception', 'inventory_type_error', 'inventory_range_error', 'inventory_reference_error', 'inventory_syntax_error', 'inventory_security_error', 'inventory_invalid_state'):
            with self.subTest(reason=reason):
                safe = m.ProtocolError('content_shield_unavailable', 'fixed', {
                    'reasonCode': reason, 'stage': 'shield_style', 'retryable': False,
                    'outcomeUnknown': False, 'stackTrace': 'PRIVATE_CANARY',
                    'description': 'PRIVATE_CANARY', 'url': 'https://private.test/?secret=value',
                }).data
                error = BridgeError('content_shield_unavailable', 'fixed', safe)
                self.assertEqual(error.data, {'reasonCode': reason, 'stage': 'shield_style',
                                             'retryable': False, 'outcomeUnknown': False})
        for reason, stage in [('inventory_type_error', 'private_canary'), ('private_canary', 'shield_style'), ('inventory_type_error', ['private_canary'])]:
            safe = m.ProtocolError('content_shield_unavailable', 'fixed', {'reasonCode': reason, 'stage': stage}).data
            error = BridgeError('content_shield_unavailable', 'fixed', safe)
            self.assertNotIn('stage', error.data)
            self.assertNotIn('private_canary', str(error.data))

    def test_r10_shield_diagnostics_survive_daemon_and_client_without_page_data(self):
        frame = {'origin': 'https://frame.test', 'x': 10, 'y': 10, 'width': 2, 'height': 2, 'body': 'PRIVATE_CANARY'}
        safe = m.ProtocolError('content_shield_uninspectable', 'fixed', {'skippedFrame': frame, 'reasonCode': 'document_not_ready'}).data
        error = BridgeError('content_shield_uninspectable', 'fixed', safe)
        self.assertEqual(error.data['skippedFrame']['origin'], 'https://frame.test')
        self.assertEqual(error.data['reasonCode'], 'document_not_ready')
        self.assertNotIn('PRIVATE_CANARY', str(error.data))
        for origin in ['https://frame.test/path?secret=value', 'https://user:secret@frame.test']:
            frame['origin'] = origin
            self.assertNotIn('skippedFrame', m.ProtocolError('content_shield_uninspectable', 'fixed', {'skippedFrame': frame}).data)
            self.assertNotIn('skippedFrame', BridgeError('content_shield_uninspectable', 'fixed', {'skippedFrame': frame}).data)

    def test_semantic_option_fields_survive_client_without_untrusted_values(self):
        error=BridgeError('invalid_params','untrusted',{'fields':['sections','PRIVATE_CANARY',{},[]],'outcomeUnknown':False})
        self.assertEqual(error.code,'invalid_params')
        self.assertEqual(error.data['fields'],['sections'])
        self.assertNotIn('PRIVATE_CANARY',str(error.data))

    def test_semantic_parse_options_return_named_contract_error_before_dispatch(self):
        with self.assertRaises(m.ProtocolError) as error:
            self.daemon._run_task(self.params('semantic_snapshot',options={'mode':'content','sections':['blocks']}))
        self.assertEqual(error.exception.code,'invalid_params')
        self.assertEqual(error.exception.data['fields'],['sections'])
        self.assertFalse(error.exception.data['outcomeUnknown'])
        self.assertEqual(self.calls,[])

    def test_full_automatic_popup_receipt_records_audit_and_preserves_source_authority(self):
        self.task['activeMode']='full'
        self.scope['candidate']['origin']='https://accounts.google.com'
        event={'taskId':'task','generation':1,'modeGeneration':2,'popupScope':self.scope}
        self.assertTrue(self.daemon._dispatch_extension('instance','extension.popup_adopted',event)['adopted'])
        self.assertTrue(self.task['requestHistory'][-1]['automatic'])
        self.assertEqual(self.task['requestHistory'][-1]['state'],'confirmed')
        self.assertEqual(self.daemon.tab_leases[('instance',1)],'task')
        self.assertEqual(self.daemon.tab_leases[('instance',2)],'task')
        self.assertEqual(self.task['agentTabIds'],[])

    def test_automatic_audit_survives_repeated_snapshot_compaction_and_restart(self):
        self.task['activeMode']='smart'
        event={'taskId':'task','generation':1,'modeGeneration':2,'popupScope':self.scope}
        self.daemon._dispatch_extension('instance','extension.popup_adopted',event)
        self.daemon.data_dir.mkdir(parents=True,exist_ok=True)
        for _ in range(2):
            self.daemon._flush_tasks()
            rows=[json.loads(line) for line in self.daemon.journal_path.read_text().splitlines()]
            self.assertEqual(len(rows),1)
            self.assertTrue(rows[0]['entry']['automatic'])
            self.assertEqual(rows[0]['entry']['state'],'confirmed')
            self.assertEqual(rows[0]['task']['id'],'task')
        self.task['state']='closed'
        self.daemon._flush_tasks()
        self.assertEqual(self.daemon.journal_path.read_bytes(),b'')
        restored=m.BridgeDaemon(Path(self.temp.name));self.addCleanup(restored._flush_tasks);restored._load_tasks()
        self.assertEqual(restored.tasks['task']['state'],'closed')
        self.assertEqual(len(restored.tasks['task']['requestHistory']),1)
        self.assertTrue(restored.tasks['task']['requestHistory'][0]['automatic'])

    def test_automatic_popup_records_authority_timeline_and_ledger_without_prompt(self):
        self.task['activeMode'] = 'smart'
        self.scope['candidate']['origin'] = 'https://accounts.google.com'
        self.scope['candidate']['windowId'] = 7
        self.scope['candidate']['windowType'] = 'normal'
        event = {'taskId': 'task', 'generation': 1, 'modeGeneration': 2, 'popupScope': self.scope}
        result = self.daemon._dispatch_extension('instance', 'extension.popup_adopted', event)
        self.assertEqual(result, {'adopted': True, 'tabId': 2})
        self.assertEqual(self.daemon.tab_leases[('instance', 2)], 'task')
        self.assertEqual(self.task['agentTabIds'], [])
        self.assertEqual(self.daemon.action_approvals, {})
        self.assertTrue(self.task['requestHistory'][-1]['automatic'])
        self.assertTrue(self.task['operationTimeline'][-1]['automatic'])
        self.assertEqual(self.task['popupSources'], {'2': 1})
        self.assertIn('https://accounts.google.com', self.task['readOrigins'])
        actions = []
        def popup_action(_extension, method, params, **kwargs):
            if method == 'browser.read_origin':
                return {'origin': 'https://accounts.google.com'}
            self.assertEqual(method, 'browser.execute')
            actions.append((params['action'], params['tabId']))
            return {'tabId': params['tabId'], 'completed': True}
        self.daemon._extension_call = popup_action
        for action, extra in (('snapshot', {}), ('fill', {'selector': '#email', 'text': 'test@example.test'}),
                              ('click', {'selector': '#account'})):
            self.assertTrue(self.daemon._run_task(self.params(action, tabId=2, requestId='popup-' + action, **extra))['completed'])
        self.assertEqual(actions, [('snapshot', 2), ('fill', 2), ('click', 2)])
        self.assertEqual(self.daemon.action_approvals, {})
        self.daemon._handle_tab_event('instance', {'taskId': 'task', 'generation': 1, 'tabId': 1,
            'event': 'navigated', 'documentGeneration': 1, 'url': 'https://example.com/logged-in'})
        self.daemon._handle_tab_event('instance', {'taskId': 'task', 'generation': 1, 'tabId': 2,
            'event': 'closed', 'documentGeneration': 1, 'popupClosed': {'returnedTo': 1}})
        self.assertEqual(self.task['popupReturns'], {'2': 1})
        self.assertEqual(self.daemon._public_task(self.task)['popupClosed'], {'returnedTo': 1})
        self.assertEqual(self.daemon.tab_leases[('instance', 1)], 'task')
        self.task['readOrigins'].append('https://example.com')
        def read_source(_extension, method, params, timeout=15):
            if method == 'browser.read_origin': return {'origin': 'https://example.com'}
            self.assertEqual(params['tabId'], 1)
            return {'tabId': 1, 'text': 'fresh source document'}
        self.daemon._extension_call = read_source
        read = self.daemon._run_task(self.params('snapshot', tabId=2))
        self.assertEqual(read['text'], 'fresh source document')
        self.assertEqual(read['popupClosed'], {'returnedTo': 1})

    def test_automatic_popup_rejects_changed_control_scope_foreign_and_duplicate_leases(self):
        for change in ('paused', 'cancelled', 'mode', 'generation', 'instance', 'source', 'target'):
            with self.subTest(change=change):
                self.task.update(state='ready', activeMode='smart')
                event = {'taskId': 'task', 'generation': 1, 'modeGeneration': 2, 'popupScope': self.scope}
                if change in {'paused', 'cancelled'}: self.task['state'] = change
                if change == 'mode': event['modeGeneration'] = 1
                if change == 'generation': event['generation'] = 0
                if change == 'instance': event['taskId'] = 'peer'
                if change == 'source': self.daemon.tab_leases[('instance', 1)] = 'peer'
                if change == 'target': self.daemon.tab_leases[('instance', 2)] = 'peer'
                with self.assertRaises(m.ProtocolError):
                    self.daemon._dispatch_extension('instance', 'extension.popup_adopted', event)
                self.assertNotIn(2, self.task['tabIds'])
                self.assertEqual(self.task.get('operationTimeline', []), [])
                self.daemon.tab_leases[('instance', 1)] = 'task'
                self.daemon.tab_leases.pop(('instance', 2), None)

    def test_smart_popup_adopts_without_approval(self):
        self.task['activeMode'] = 'smart'
        receipt = self.daemon._run_task(self.params())
        self.assertTrue(receipt['adopted'])
        self.assertEqual(self.daemon.action_approvals, {})
        self.assertEqual(self.daemon.tab_leases[('instance', 2)], 'task')
    def test_target_lease_conflict_is_rejected_before_execute(self):
        self.daemon.tab_leases[('instance',2)]='other'
        with self.assertRaises(m.ProtocolError) as error:self.daemon._run_task(self.params())
        self.assertEqual(error.exception.code,'popup_stale');self.assertEqual(len(self.calls),1)
    def test_unknown_adoption_is_not_replayed_or_given_cleanup_right(self):
        p=self.params()
        original = self.daemon._extension_call
        def lost(ext, method, params, **kwargs):
            if method == 'browser.popup_prepare': return original(ext, method, params, **kwargs)
            self.calls.append(('lost', {}))
            raise m.ProtocolError('extension_timeout', 'lost', {'outcomeUnknown': True})
        self.daemon._extension_call=lost
        with self.assertRaises(m.ProtocolError):self.daemon._run_task(p)
        calls=len(self.calls)
        with self.assertRaises(m.ProtocolError):self.daemon._run_task(p)
        self.assertEqual(len(self.calls),calls);self.assertNotIn(2,self.task['agentTabIds'])
    def test_closed_target_before_adoption_receipt_is_not_revived_or_replayed(self):
        p=self.params()
        execute=self.daemon._extension_call
        close_errors=[]
        def close_before_receipt(ext,method,params,timeout=15):
            if method=='browser.release':
                self.calls.append((method,params));return {'released':True}
            if method=='browser.execute':
                for _ in range(2):
                    try:
                        self.daemon._dispatch_extension('instance','extension.tab_event',{
                            'taskId':'task','generation':1,'tabId':2,'event':'closed','documentGeneration':0})
                    except m.ProtocolError as error:
                        close_errors.append(error.code)
                self.assertEqual(self.task.get('retiredPopupTabs'),{'1':[2]})
                self.assertEqual(self.task['tabIds'],[1])
                self.assertNotIn(('instance',2),self.daemon.tab_leases)
            return execute(ext,method,params,timeout)
        self.daemon._extension_call=close_before_receipt
        with self.assertRaises(m.ProtocolError) as error:
            self.daemon._run_task(p)
        self.assertEqual(error.exception.code,'invalid_extension_result')
        self.assertTrue(error.exception.data['outcomeUnknown'])
        self.assertEqual(close_errors,[])
        self.assertEqual(self.task['state'],'needs_sync')
        self.assertNotIn(('instance',2),self.daemon.tab_leases)
        self.assertNotIn(2,self.task['tabIds'])
        self.assertNotIn(2,self.task.get('adoptedPopupTabIds',[]))
        self.assertNotIn(2,self.task['agentTabIds'])
        self.assertEqual(self.task['allowedOrigins'],['https://example.com'])
        self.assertEqual(self.task['workTabs'],[])
        self.assertEqual(self.daemon._operation_status({'owner':'owner','taskId':'task',
            'requestId':p['requestId']})['state'],'unknown')
        self.assertEqual([params for method,params in self.calls if method=='browser.release'],[
            {'taskId':'task','generation':1,'closeAgentTabs':False}])
        calls=len(self.calls)
        with self.assertRaises(m.ProtocolError) as replay:self.daemon._run_task(p)
        self.assertEqual(replay.exception.code,'request_outcome_unavailable')
        self.assertEqual(len(self.calls),calls)
    def test_inflight_adoption_rejects_unrelated_or_stale_tab_events(self):
        cases=(
            ('peer_instance',{'instance':'peer'},'not_found'),
            ('peer_task',{'taskId':'peer-task'},'foreign_tab'),
            ('peer_lease',{'peerLease':True},'foreign_tab'),
            ('non_target',{'tabId':3},'foreign_tab'),
            ('old_generation',{'generation':0},'approval_stale'),
            ('not_closed',{'event':'navigated','url':'https://example.com'},'foreign_tab'),
            ('not_inflight',{'removeInflight':True},'foreign_tab'),
            ('old_dispatch',{'oldDispatch':True},'foreign_tab'),
        )
        self.daemon.tasks['peer-task']={**self.task,'id':'peer-task','requestHistory':[]}
        for name,changes,code in cases:
            with self.subTest(case=name):
                p=self.params(requestId=name)
                execute=self.daemon._extension_call
                def reject_event(ext,method,params,timeout=15):
                    if method=='browser.execute':
                        event={'taskId':'task','generation':1,'tabId':2,'event':'closed','documentGeneration':0}
                        event.update({k:v for k,v in changes.items() if k in event or k=='url'})
                        row=next(row for row in self.task['requestHistory'] if row['requestIdHash']==m._sha256(name))
                        key=('task',row['requestIdHash']);inflight=self.daemon.inflight_requests[key]
                        if changes.get('peerLease'):self.daemon.tab_leases[('instance',2)]='peer-task'
                        if changes.get('removeInflight'):self.daemon.inflight_requests.pop(key)
                        if changes.get('oldDispatch'):row['generation']=0
                        try:
                            with self.assertRaises(m.ProtocolError) as error:
                                self.daemon._dispatch_extension(changes.get('instance','instance'),'extension.tab_event',event)
                            self.assertEqual(error.exception.code,code)
                            self.assertEqual(self.task.get('retiredPopupTabs',{}),{})
                            self.assertNotIn(2,self.task['tabIds'])
                            if changes.get('peerLease'):
                                self.assertEqual(self.daemon.tab_leases[('instance',2)],'peer-task')
                        finally:
                            if changes.get('peerLease'):self.daemon.tab_leases.pop(('instance',2))
                            self.daemon.inflight_requests[key]=inflight;row['generation']=1
                    return execute(ext,method,params,timeout)
                self.daemon._extension_call=reject_event
                self.assertTrue(self.daemon._run_task(p)['adopted'])
                self.daemon._extension_call=execute
                self.daemon._handle_tab_event('instance',{
                    'taskId':'task','generation':1,'tabId':2,'event':'closed','documentGeneration':0})
    def test_without_dispatch_cannot_accept_target_close(self):
        with self.assertRaises(m.ProtocolError) as error:
            self.daemon._dispatch_extension('instance','extension.tab_event',{
                'taskId':'task','generation':1,'tabId':2,'event':'closed','documentGeneration':0})
        self.assertEqual(error.exception.code,'foreign_tab')
        self.assertEqual(self.task.get('retiredPopupTabs',{}),{})
        self.assertEqual(self.task['tabIds'],[1])
    def test_old_generation_tombstone_does_not_block_current_adoption(self):
        self.task['retiredPopupTabs']={'0':[2]}
        p=self.params()
        self.assertTrue(self.daemon._run_task(p)['adopted'])
        self.assertEqual(self.daemon.tab_leases[('instance',2)],'task')
        self.assertEqual(self.task['adoptedPopupTabIds'],[2])
    def test_revocation_drops_adopted_popup_authority(self):
        self.task['adoptedPopupTabIds']=[2];self.task['tabIds'].append(2);self.daemon.tab_leases[('instance',2)]='task'
        self.daemon._revoke_task_locked(self.task,'cancelled')
        self.assertEqual(self.task.get('adoptedPopupTabIds',[]),[])
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']);self.addCleanup(self.temp.cleanup)
        self.daemon=m.BridgeDaemon(Path(self.temp.name))
        self.task={'id':'task','owner':'owner','instanceId':'instance','state':'ready','generation':1,'activeMode':'full','modeGeneration':2,'allowedOrigins':['https://example.com'],'tabIds':[1],'agentTabIds':[],'workTabs':[],'requestHistory':[],'createdAt':time.time(),'updatedAt':time.time()}
        d=self.daemon;d.tasks['task']=self.task;d.task_locks['task']=threading.RLock();d.dedupe['task']={};d.tab_leases[('instance',1)]='task';d.extensions['instance']={'instanceId':'instance'}
        d._persist_tasks=lambda:None;d._persist_dispatched=lambda *a:None;d._notify_tasks_changed=lambda *a:None
        self.scope={'source':{'tabId':1,'windowId':7,'origin':'https://example.com','documentGeneration':0},'candidate':{'candidateRef':'ref-2','tabId':2,'windowId':8,'openerTabId':1,'origin':'https://accounts.example.test','windowType':'popup'}}
        self.calls=[]
        def call(ext,method,p,timeout=15):
            self.calls.append((method,p))
            if method=='browser.popup_prepare':return self.scope
            if p['action']=='popup_catalog':return {'sourceTabId':1,'observationMs':30000,'candidates':[self.scope['candidate']]}
            return {'adopted':True,**self.scope['candidate'],'sourceTabId':1,'cleanupOwned':False}
        d._extension_call=call
    def params(self,action='popup_adopt',**extra):
        return {'owner':'owner','taskId':'task','requestId':action,'action':action,'tabId':1,**({'candidateRef':'ref-2'} if action=='popup_adopt' else {}),**extra}
    def test_full_mode_directly_syncs_lease_without_cleanup_right(self):
        p=self.params()
        receipt=self.daemon._run_task(p)
        self.assertEqual(self.daemon.action_approvals,{})
        self.assertTrue(receipt['adopted']);self.assertEqual(self.daemon.tab_leases[('instance',2)],'task')
        self.assertIn(2,self.task['tabIds']);self.assertIn(2,self.task['adoptedPopupTabIds']);self.assertNotIn(2,self.task['agentTabIds']);self.assertEqual(self.task['workTabs'],[])
        self.assertIn('https://accounts.example.test',self.task['allowedOrigins'])
        self.assertEqual(self.calls[-1][1]['popupScope'],self.scope)
        calls=len(self.calls)
        with self.assertRaises(m.ProtocolError) as error:self.daemon._run_task(p)
        self.assertEqual(error.exception.code,'request_outcome_unavailable')
        self.assertEqual(len(self.calls),calls)
    def test_cached_adoption_rejected_after_generation_mode_and_lease_revocations(self):
        for change in ('generation','modeGeneration','source_lease','target_lease','target_closed'):
            with self.subTest(change=change):
                fixture=PopupTests();fixture.setUp()
                try:
                    p=fixture.params()
                    self.assertTrue(fixture.daemon._run_task(p)['adopted'])
                    if change in {'generation','modeGeneration'}:fixture.task[change]+=1
                    if change=='source_lease':fixture.daemon.tab_leases.pop(('instance',1))
                    if change=='target_lease':fixture.daemon.tab_leases[('instance',2)]='peer-task'
                    if change=='target_closed':fixture.daemon._handle_tab_event('instance',{
                        'taskId':'task','generation':1,'tabId':2,'event':'closed','documentGeneration':0})
                    calls=len(fixture.calls)
                    with self.assertRaises(m.ProtocolError) as error:fixture.daemon._run_task(p)
                    self.assertEqual(error.exception.code,'request_outcome_unavailable')
                    self.assertEqual(len(fixture.calls),calls)
                finally:fixture.doCleanups()

    def test_catalog_needs_no_page_read_or_write_approval(self):
        self.task['activeMode']='smart'
        result=self.daemon._run_task(self.params('popup_catalog'))
        self.assertEqual(len(result['candidates']),1);self.assertEqual(len(self.daemon.action_approvals),0)
        self.assertEqual(self.calls[0][0],'browser.execute')

if __name__=='__main__':unittest.main()
