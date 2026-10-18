"""R24 续跑与回执回归；仅使用临时状态和合成浏览器工作页。"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,private_write
from copilot_capabilities import Workflows
from copilot_execution import StreamJSON,ExecutionError,retain_tool_receipt
from copilot_fetch import Fetcher
from copilot_setup import setup


class ReceiptsTest(unittest.TestCase):
    def test_independent_execution_ids_never_overwrite_another_process_receipt(self):
        row={};event={'receipt':{'id':'1','name':'fixture','status':'unknown','arguments':{},'quota_consumed':None}}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            retain_tool_receipt(row,event,root/'first',private_write)
            event['receipt']['status']='succeeded';retain_tool_receipt(row,event,root/'first',private_write)
            event['receipt']['status']='unknown';retain_tool_receipt(row,event,root/'second',private_write)
        self.assertEqual([receipt['status'] for receipt in row['tool_receipts']],['succeeded','unknown'])
        self.assertNotEqual(row['tool_receipts'][0]['id'],row['tool_receipts'][1]['id'])

    def test_tool_receipts_keep_parameter_types_and_unknown_quota_without_private_values(self):
        parser=StreamJSON()
        started=parser.feed(json.dumps({'type':'tool_use','tool_call_id':'paid','name':'fixture_query','input':{'query':'PRIVATE_VALUE','count':3}}))['receipt']
        self.assertEqual(started['arguments'],{'query':'str','count':'int'})
        self.assertEqual(started['status'],'unknown');self.assertIsNone(started['quota_consumed'])
        completed=parser.feed(json.dumps({'type':'tool_result','tool_call_id':'paid','is_error':False,'output':'PRIVATE_RESULT'}))['receipt']
        self.assertEqual(completed['status'],'succeeded');self.assertIsNone(completed['quota_consumed'])
        self.assertNotIn('PRIVATE',json.dumps(parser.receipts))

    def test_missing_or_ambiguous_result_never_marks_unknown_call_successful(self):
        parser=StreamJSON()
        for key in ('one','two'):parser.feed(json.dumps({'type':'tool_use','tool_call_id':key,'name':'fixture_query'}))
        self.assertNotIn('receipt',parser.feed(json.dumps({'type':'tool_result','name':'fixture_query','is_error':False})))
        self.assertEqual([row['status'] for row in parser.receipts],['unknown','unknown'])
        parser.feed(json.dumps({'type':'tool_result','tool_call_id':'one','output':'looks successful'}))
        self.assertEqual(parser.receipts[0]['status'],'unknown')
        parser.feed(json.dumps({'type':'tool_result','tool_call_id':'two','is_error':True}))
        self.assertEqual(parser.receipts[1]['status'],'failed')


class ResumeTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();setup(self.root)
        self.events=[];self.app=Copilot(self.root,lambda instance,event:self.events.append((instance,event)))
        self.state=self.app._state('fixture');self.state.update(enabled=True,ready=True);self.app.active='fixture'

    def tearDown(self):
        self.app.close();self.tmp.cleanup()

    def failed(self,key):
        row={'id':key,'title':'合成任务','action':'general.task','params':{'task':key},'status':'failed',
             'tool_receipts':[{'id':'1','name':'fixture_paid','arguments':{},'status':'unknown','quota_consumed':None}],
             'rerun_warning':'从头重跑，可能重复第 1 步；工具回执或额度未知，确认后再执行。'}
        self.state['suggestions'][key]=row;return row

    def test_unknown_general_receipt_waits_for_explicit_rerun_and_confirmation_is_one_use(self):
        row=self.failed('uncertain')
        with patch('copilot.threading.Thread') as thread:
            question=self.app.request('fixture','retry',{'id':row['id']})
            self.assertTrue(question['secondary_required']);self.assertIn('从头重跑',question['message'])
            self.assertEqual(row['status'],'failed');self.assertEqual(row['tool_receipts'][0]['status'],'unknown');thread.assert_not_called()
            token=question['token'];self.app.request('fixture','retry',{'id':row['id'],'confirmation':token})
            self.assertEqual(row['status'],'queued');self.assertNotIn(token,self.app.external_confirmations)
            self.assertNotIn('tool_receipts',row);self.assertEqual(thread.call_count,1)
            row.update(status='failed',rerun_warning='从头重跑，可能重复第 1 步')
            self.assertTrue(self.app.request('fixture','retry',{'id':row['id'],'confirmation':token})['secondary_required'])
            self.assertEqual(thread.call_count,1)

    def test_rerun_confirmation_cannot_transfer_task_browser_epoch_or_changed_receipts(self):
        with patch('copilot.threading.Thread') as thread:
            first=self.failed('one');second=self.failed('two')
            token=self.app.request('fixture','retry',{'id':first['id']})['token']
            self.assertTrue(self.app.request('fixture','retry',{'id':second['id'],'confirmation':token})['secondary_required'])
            other=self.app._state('other');other['suggestions']['one']=copy.deepcopy(first)
            self.assertTrue(self.app.request('other','retry',{'id':'one','confirmation':token})['secondary_required'])
            self.state['epoch']+=1
            self.assertTrue(self.app.request('fixture','retry',{'id':'one','confirmation':token})['secondary_required'])
            token=self.app.request('fixture','retry',{'id':'one'})['token']
            first['tool_receipts'][0]['status']='succeeded'
            self.assertTrue(self.app.request('fixture','retry',{'id':'one','confirmation':token})['secondary_required'])
            thread.assert_not_called()

    def test_confirmed_partial_free_execution_archives_previous_receipts_only_once(self):
        row=self.failed('partial-free');row.update(status='completed',result={'missing':[{'field':'data','reason':'fixture'}]})
        with patch('copilot.threading.Thread') as thread:
            question=self.app.request('fixture','retry',{'id':row['id']})
            self.assertTrue(question['secondary_required']);self.assertEqual(self.state['result_history'],[])
            self.app.request('fixture','retry',{'id':row['id'],'confirmation':question['token']})
            self.assertEqual(row['status'],'queued');self.assertEqual(thread.call_count,1)
        self.assertEqual(len(self.state['result_history']),1)
        previous=self.state['result_history'][0]
        self.assertEqual(previous['status'],'completed');self.assertEqual(previous['tool_receipts'][0]['status'],'unknown')
        self.assertIn('rerun_warning',previous);self.assertNotIn('tool_receipts',row);self.assertNotIn('rerun_warning',row)

    def test_failed_general_execution_persists_successful_and_unknown_tool_receipts(self):
        row={'id':'general-fixture','title':'合成通用任务','action':'general.task','params':{'task':'fixture'},'status':'queued'}
        self.state['suggestions'][row['id']]=row;self.app.config['exec_transport']='oneshot'
        def run(key,argv,result_path,progress,**kwargs):
            parser=StreamJSON()
            for event in ({'type':'tool_use','tool_call_id':'paid','name':'fixture_paid','input':{'keyword':'PRIVATE_QUERY'}},
                          {'type':'tool_result','tool_call_id':'paid','is_error':False},
                          {'type':'tool_use','tool_call_id':'uncertain','name':'fixture_write'}):progress(parser.feed(json.dumps(event)))
            raise ExecutionError('synthetic transport exit')
        with patch.object(self.app.executions,'run',side_effect=run),patch.object(self.app,'_schedule'):
            self.app._execute('fixture',row['id'],self.state['epoch'])
        self.assertEqual(row['status'],'failed')
        receipts=json.loads(next((self.root/'tasks').glob('*/tool-receipts.json')).read_text())
        self.assertEqual([receipt['status'] for receipt in receipts],['succeeded','unknown'])
        self.assertNotIn('PRIVATE_QUERY',json.dumps(receipts));self.assertEqual(row['tool_receipts'],receipts)
        with patch.object(self.app.executions,'run') as replay:
            self.assertTrue(self.app.request('fixture','retry',{'id':row['id']})['secondary_required'])
            replay.assert_not_called()

    def test_sidebar_retry_reopens_reclaimed_work_page_and_restores_paid_step(self):
        flow={'judgment':False,'steps':[{'id':'paid','capability':'fixture.paid'},{'id':'browser','capability':'fixture.browser'}],'result':'$steps.browser.records'}
        self.app.packages.flows['fixture-resume']=flow
        row={'id':'workflow-fixture','title':'合成工作流','action':'workflow.run','params':{'flow':'fixture-resume','object':'sample'},'status':'queued'}
        self.state['suggestions'][row['id']]=row
        calls=[];work_pages=[];closed=[]
        def emit(instance,event):
            self.events.append((instance,event))
            if event['type']=='browser_fetch':
                work_pages.append(event['id']);closed.append(event['id'])
                data={'records':[],'source':'fixture page','blocked':'login'} if len(work_pages)==1 else {'records':[{'keyword':'sample'}],'source':'fixture page'}
                self.app.request(instance,'browser_fetch_result',{'id':event['id'],'data':data})
        self.app.notify=emit
        def execute(capability,values,work,stop,context,progress):
            calls.append(capability)
            if capability=='fixture.paid':return {'records':[{'keyword':'sample'}],'source':'paid fixture'}
            return self.app._browser_fetch('fixture',self.state['epoch'],context['job_key'],'capability',{'url':'https://example.test/report'},context)
        proposal={'params':{'flow':'fixture-resume'},'available':True}
        with patch.object(self.app.registry,'candidates',return_value=[{'id':'fixture','type':'command','cost':'metered'}]),patch.object(self.app.registry,'execute',side_effect=execute),patch.object(self.app.registry,'recommendations',return_value=[proposal]),patch.object(self.app,'_schedule'):
            self.app._execute('fixture',row['id'],self.state['epoch'])
            self.assertEqual(row['status'],'failed',row.get('reason'));self.assertEqual(row['resume_from'],2)
            self.assertFalse(self.app.browser_fetches);self.assertEqual(work_pages,closed)
            self.app.request('fixture','retry',{'id':row['id']})
            deadline=time.monotonic()+3
            while row['status'] not in {'completed','failed'} and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(row['status'],'completed',row.get('reason'))
        self.assertEqual(calls,['fixture.paid','fixture.browser','fixture.browser'])
        self.assertEqual(len(set(work_pages)),2);self.assertEqual(work_pages,closed);self.assertFalse(self.app.browser_fetches)
        self.assertNotIn('resume_from',row)

    def test_fetch_blocked_or_unavailable_is_retryable_but_successful_paid_source_is_retained(self):
        fetcher=Fetcher({});template={'fetch':[{'script':key,'params_schema':{},'output_schema':{}} for key in ('paid','browser')]}
        for blocked in ({'source':'fixture','blocked':'login'},{'source':'unavailable'}):
            with self.subTest(blocked=blocked):
                calls=[];checkpoint={}
                def fetch(name,*args):
                    calls.append(name)
                    return blocked if name=='browser' and len(calls)==2 else {'source':'paid fixture','keywords':[{'keyword':'sample'}]}
                fetcher.run('job',template,{},self.root,lambda *_:None,capability_fetch=fetch,checkpoint=checkpoint)
                self.assertEqual(set(checkpoint),{'paid'})
                fetcher.run('job',template,{},self.root,lambda *_:None,capability_fetch=fetch,checkpoint=checkpoint)
                self.assertEqual(calls,['paid','browser','browser']);self.assertEqual(set(checkpoint),{'paid','browser'})

    def test_workflow_unavailable_source_is_not_saved_as_completed(self):
        flow={'judgment':False,'steps':[{'id':'source','capability':'fixture'}]};checkpoint={}
        registry=SimpleNamespace(packages=SimpleNamespace(flows={'fixture':flow},experience=''),jobs={},candidates=lambda *_:[True],execute=lambda *_:{'records':[],'source':'unavailable','missing':['login']},write=lambda path,text:Path(path).write_text(text))
        result,_=Workflows(registry).run('job','fixture','sample',{},self.root/'flow',checkpoint=checkpoint)
        self.assertFalse(checkpoint['steps']);self.assertFalse(checkpoint['items']);self.assertTrue(result['missing'])

    def test_final_judgment_waits_for_remaining_required_steps_then_is_reused(self):
        flow={'steps':[{'id':'a','capability':'a'},{'id':'b','capability':'b'}],'result':'$steps.b.records'}
        calls=[];judgments=[];checkpoint={}
        def execute(capability,*args):
            calls.append(capability)
            if calls==['a','b']:raise ValueError('login')
            return {'records':[{'keyword':capability}],'source':'paid fixture'}
        def model(payload,*args):
            judgments.append(copy.deepcopy(payload['records']));return {'verdict':'judged '+payload['records'][0]['keyword']}
        registry=SimpleNamespace(packages=SimpleNamespace(flows={'fixture':flow},experience=''),jobs={},candidates=lambda *_:[True],execute=execute,write=lambda path,text:Path(path).write_text(text))
        runner=Workflows(registry)
        first,_=runner.run('job','fixture','sample',{},self.root/'first',model,checkpoint=checkpoint)
        self.assertTrue(first['missing']);self.assertEqual(judgments,[]);self.assertNotIn('judgment',checkpoint)
        second,_=runner.run('job','fixture','sample',{},self.root/'second',model,checkpoint=checkpoint)
        third,_=runner.run('job','fixture','sample',{},self.root/'third',model,checkpoint=checkpoint)
        self.assertEqual(calls,['a','b','b']);self.assertEqual(judgments,[[{'keyword':'b'}]])
        self.assertEqual(second['verdict'],'judged b');self.assertEqual(third['verdict'],'judged b');self.assertFalse(second['missing'])
        with self.assertRaisesRegex(ValueError,'workflow changed'):
            runner.run('job','fixture','other',{},self.root/'other',model,checkpoint=checkpoint)
        self.assertNotIn('job',registry.jobs)

    def test_required_unbound_step_does_not_trigger_final_judgment(self):
        flow={'steps':[{'id':'a','capability':'a'},{'id':'b','capability':'b'}],'result':'$steps.a.records'}
        registry=SimpleNamespace(packages=SimpleNamespace(flows={'fixture':flow},experience=''),jobs={},candidates=lambda cap,*_:[True] if cap=='a' else [],execute=lambda *_:{'records':[{'keyword':'sample'}],'source':'paid fixture'},write=lambda path,text:Path(path).write_text(text))
        with patch.object(self.app,'_tool_model') as model:
            result,_=Workflows(registry).run('job','fixture','sample',{},self.root/'unbound',model)
            model.assert_not_called();self.assertTrue(result['missing'])

    def test_capability_free_execution_persists_receipts_and_requires_confirmation_even_without_one(self):
        row={'id':'fallback','title':'合成能力','action':'workflow.run','params':{'flow':'fixture','object':'sample'},'status':'executing'}
        self.state['suggestions'][row['id']]=row;self.app.config['exec_transport']='oneshot'
        context={'instance':'fixture','epoch':self.state['epoch'],'job_key':'fixture:fallback','row_id':row['id'],'capability':'keyword.expand','language':'zh'}
        binding={'id':'fallback','type':'hermes'}
        def run(*args,**kwargs):
            self.assertIn('从头重跑',row['rerun_warning'])
            kwargs['progress']({'receipt':{'id':'1','name':'fixture_paid','arguments':{},'status':'unknown','quota_consumed':None}})
            raise ExecutionError('synthetic interrupted tool')
        with patch.object(self.app.executions,'run',side_effect=run):
            with self.assertRaises(ExecutionError):self.app._cap_hermes(binding,{'keyword':'sample'},self.root/'fallback',threading.Event(),context)
        self.assertEqual(row['tool_receipts'][0]['status'],'unknown')
        self.assertTrue((self.root/'fallback/tool-receipts.json').is_file());self.assertFalse(self.app.browser_fetches)
        row.pop('tool_receipts');row.pop('rerun_warning')
        with patch.object(self.app.executions,'run',side_effect=ExecutionError('exit before receipt')):
            with self.assertRaises(ExecutionError):self.app._cap_hermes(binding,{'keyword':'sample'},self.root/'early-exit',threading.Event(),context)
        self.assertIn('从头重跑',row['rerun_warning']);self.assertFalse(self.app.browser_fetches)


if __name__=='__main__':unittest.main()
