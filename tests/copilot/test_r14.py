"""复现现场事件序列；所有数据、进程和页面均为合成夹具。"""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,DEFAULTS,private_write
from copilot_setup import setup
from copilot_exec_acp import ACPExecutions,ExecutionTransport
from copilot_execution import ExecutionError
from copilot_diagnostics import StderrLog,stderr_summary
from copilot_capabilities import Registry,Workflows
from copilot_packages import Packages
from copilot_acp import ACP


def wait(check):
 end=time.monotonic()+6
 while time.monotonic()<end:
  if check():return
  time.sleep(.01)
 raise AssertionError('synthetic condition timed out')


class R14Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();setup(self.root);self.now=1000.
  config={'exec_transport':'acp','acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'fetch_commands':{name:[sys.executable,str(ROOT/'tests/copilot/fake-fetch.py'),name] for name in ('keyword_metrics','serp_top10','google_suggest')},'timeout_seconds':3}
  private_write(self.root/'config.json',json.dumps(config));self.app=Copilot(self.root,clock=lambda:self.now,debounce=.01)
 def tearDown(self):self.app.close();self.tmp.cleanup()
 def start(self):self.app.request('fixture','settings',{'enabled':True});wait(lambda:self.app.view('fixture')['ready'])
 def logs(self,event):return [row for row in self.app.journal.view('fixture')['entries'] if row['event']==event]
 def test_judgment_uses_inference_profile_and_selected_execution_model(self):
  configs=[]
  def transport(config,*args):configs.append(config.copy());return ExecutionTransport(config,*args)
  with patch('copilot_exec_acp.ExecutionTransport',side_effect=transport):
   self.start();self.app.config['exec_model']='synthetic-execution-model'
   state=self.app.request('fixture','quick_task',{'action':'seo.keyword_check','params':{'keyword':'sample'}})
   row=self.app._state('fixture')['suggestions'][state['suggestions'][0]['id']];wait(lambda:row['status'] in {'completed','failed'})
  self.assertEqual(row['status'],'completed',row.get('reason'));self.assertTrue(row['result']['verdict'])
  self.assertEqual(configs[0]['inference_profile'],'fast-copilot')
  requests=[json.loads(line) for line in (self.root/'exec-acp-requests.jsonl').read_text().splitlines()]
  self.assertTrue(any(r.get('method')=='session/set_model' and r['params']['modelId']=='synthetic-execution-model' for r in requests))
 def test_failed_judgment_keeps_message_and_acquired_data_in_result_and_log(self):
  self.start();message='ACP 无法按会话限制工具：判断 profile 含工具'
  with patch.object(self.app.acp_executions,'run',side_effect=ExecutionError(message)):
   view=self.app.request('fixture','quick_task',{'action':'seo.keyword_check','params':{'keyword':'sample'}})
   row=self.app._state('fixture')['suggestions'][view['suggestions'][0]['id']];wait(lambda:row['status']=='failed' and bool(self.logs('execute_failed')))
  self.assertEqual(row['reason'],message);self.assertEqual(self.logs('execute_failed')[-1]['details']['detail'],message)
  saved=json.loads((self.root/'tasks'/('failed-'+row['id'])/'result.json').read_text())
  self.assertIn('keyword_metrics',saved['fetched']['data']);self.assertIn('serp_top10',saved['fetched']['data']);self.assertEqual(saved['result']['missing'][0]['field'],'judgment')
  self.assertTrue(Path(row['report']).exists())
  self.app.request('fixture','retry',{'id':row['id']});wait(lambda:row['status']=='completed')
  self.assertNotIn('render_as',row);self.assertTrue(row['result']['verdict'])
 def test_missing_question_step_continues_and_judges_truncated_candidates(self):
  registry=self.app.registry;calls=[];progress=[]
  def execute(cap,inputs,*args,**kwargs):return {'records':[{'keyword':f'word {i}','source':'synthetic'} for i in range(180)],'source':'synthetic'}
  def model(payload,stop):calls.append(payload);return {'verdict':'优先验证明确任务用途','notes':[]}
  with patch.object(registry,'candidates',side_effect=lambda cap,*_:[] if cap=='keyword.questions' else [{'id':'synthetic'}]),patch.object(registry,'execute',side_effect=execute):
   result,stopped=Workflows(registry).run('job','intent_split','sample',{'language':'zh'},self.root/'workflow',model,progress.append)
  self.assertFalse(stopped);self.assertEqual(len(calls),1);self.assertEqual(len(result['records']),100)
  self.assertEqual(result['steps'][1]['status'],'skipped');self.assertIn('keyword.questions',result['missing'][0]['reason'])
  self.assertTrue(any('截断 80' in row['reason'] for row in result['missing']));self.assertEqual(result['verdict'],'优先验证明确任务用途')
  self.assertTrue(any('部分完成' in line for line in result['process']));self.assertTrue(any(event.get('duration_ms') is not None for event in progress))
  self.start();row={'id':'partial-workflow','title':'扩词','action':'workflow.run','status':'executing','params':{'flow':'intent_split','object':'sample'}};state=self.app._state('fixture');state['suggestions'][row['id']]=row
  with patch.object(self.app.workflow_runner,'run',return_value=(result,False)):self.app._execute_workflow('fixture',row,state['epoch'],self.app.config)
  self.assertEqual(row['completion_status'],'partial');self.assertEqual(row['status'],'completed')
 def test_no_evidence_workflow_is_failed_and_has_no_process_verdict(self):
  with patch.object(self.app.registry,'candidates',return_value=[]):
   result,_=Workflows(self.app.registry).run('job','intent_split','sample',{},self.root/'empty',lambda *_:self.fail('no data must not fabricate a judgment'))
  self.assertIn('失败',result['process'][-1]);self.assertNotIn('流程完成',result['verdict'])
  message='ACP 无法按会话限制工具：合成错误'
  with patch.object(self.app.registry,'candidates',return_value=[{'id':'synthetic'}]),patch.object(self.app.registry,'execute',return_value={'records':[{'keyword':'sample'}],'source':'synthetic'}):
   result,_=Workflows(self.app.registry).run('failure','intent_split','sample',{},self.root/'judgment-failure',lambda *_:(_ for _ in ()).throw(ExecutionError(message)))
  self.assertTrue(any(message in item['reason'] for item in result['missing']));self.assertEqual(result['steps'][-1]['status'],'partial');self.assertIn('失败',result['process'][-1])
 def test_repeated_unchanged_capture_and_empty_increment_do_not_prompt(self):
  state=self.app._state('fixture');state.update(enabled=True,ready=True);self.app.active='fixture'
  page={'url':'https://example.test/','title':'same','items':[{'role':'text','name':'same'}]}
  with patch.object(self.app,'_schedule') as schedule:
   self.assertTrue(self.app._observe('fixture',{'trace':[],'page':page})['accepted'])
   for width in (100,101,99):self.assertFalse(self.app._observe('fixture',{'trace':[],'page':{**page,'width':width}})['accepted'])
   self.assertEqual(schedule.call_count,1)
  state.update(dirty=True,sent_page=state['page'],sent_trace=state['trace'],sent_tool_context=state['tool_context'],sent_work=self.app._resume_context(state)['work_context'])
  with patch.object(self.app,'_prompt_json') as prompt:self.app._infer('fixture',state['epoch']);prompt.assert_not_called()
  self.assertEqual(len(self.logs('capture')),1)
 def test_suggestions_survive_first_miss_and_thirty_seconds_until_second_miss(self):
  state=self.app._state('fixture');state['page']={'url':'https://example.test/a'}
  suggestion={'scene':'general','suggestions':[{'title':'保留','why':'合成','action':'general.task','params':{'task':'sample'}}]}
  self.app._replace('fixture',suggestion);key=next(iter(state['suggestions']))
  self.now+=4;self.app._replace('fixture',{'scene':'general','suggestions':[]});self.assertIn(key,state['suggestions'])
  self.now+=26;self.app.request('fixture','suggestion_hold',{'id':key,'held':True})
  self.app._replace('fixture',{'scene':'general','suggestions':[]});self.assertIn(key,state['suggestions'])
  self.app.request('fixture','suggestion_hold',{'id':key,'held':False});self.assertNotIn(key,state['suggestions'])
  self.app._replace('fixture',suggestion);state['page']={'url':'https://example.test/b'}
  self.app._replace('fixture',{'scene':'general','suggestions':[]});self.assertFalse(state['suggestions'])
 def test_step_logs_are_named_and_fold_consecutive_events(self):
  for _ in range(12):self.app.journal.add('fixture','execute_step',task_id='sample',step_index=2,capability='keyword.metrics',provider='synthetic-monthly',count=100,duration_ms=4200)
  row=self.logs('execute_step')[-1];self.assertEqual(len(self.logs('execute_step')),1);self.assertEqual(row['details']['repeats'],12)
  self.assertIn('第 2 步',row['summary']);self.assertIn('关键词指标',row['summary']);self.assertIn('100 条',row['summary']);self.assertIn('4.2s',row['summary'])
 def test_stderr_info_is_filtered_but_warning_and_errors_survive(self):
  log=StderrLog(self.root)
  log.append('WARNING synthetic important warning')
  for i in range(30):log.append(f'INFO hermes_cli.plugins: Plugin synthetic{i} registered')
  log.append('INFO api_key=synthetic-private-noise');log.append('ERROR synthetic failure despite INFO noise');self.assertEqual(len(log.finish()),2)
  raw=''.join(path.read_text() for path in (self.root/'logs').glob('*.hermes-stderr.log'))
  self.assertNotIn('registered',raw);self.assertIn('WARNING',raw);self.assertIn('ERROR',raw)
 def test_current_context_uses_usage_pressure_and_never_sums_cache_billing(self):
  state=self.app._state('fixture');self.app.runtime=SimpleNamespace(context_tokens=None)
  metrics={'tokens':9000,'usage':{'input':100,'cache_read':8800,'output':100},'source':'synthetic','estimated_input_tokens':25}
  self.app._account('fixture',metrics);self.assertEqual(state['context_tokens'],125)
  self.app.runtime.context_tokens=5100;self.app._account('fixture',metrics);self.assertEqual(state['context_tokens'],5100)
  self.app.runtime=None
 def test_seven_second_inference_is_slow_info_and_not_error(self):
  self.start();state=self.app._state('fixture');state.update(dirty=True,page={'url':'https://example.test/','title':'same','items':[]})
  usage={'tokens':1,'source':'synthetic','input_bytes':56,'estimated_input_tokens':14,'seconds':7.3}
  with patch.object(self.app.runtime,'prompt',return_value=(json.dumps({'scene':'general','suggestions':[]}),usage)):
   self.app._infer('fixture',state['epoch'])
  row=self.logs('inference_return')[-1];self.assertTrue(row['details']['slow']);self.assertFalse(row['error']);self.assertIn('慢请求',row['summary'])
