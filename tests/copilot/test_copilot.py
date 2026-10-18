"""R3 协作离线测试；真实 stdio ACP 与执行子进程，全部使用临时夹具。"""
import copy
from datetime import date,timedelta
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,suggestion_id,validate,private_write,parse_model_json,model_json_prompt
from copilot_acp import ACP,ACPError,hermes_environment
from copilot_execution import StreamJSON,ExecutionError,execution_argv
from copilot_setup import setup


def wait_for(check,timeout=5):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if check():return
        time.sleep(.01)
    raise AssertionError('fixture condition timed out')


def alive(pid):
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False


class CopilotTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='copilot-')
        self.directory=Path(self.tmp.name).resolve();setup(self.directory)
        self.fake=self.directory/'hermes';self.fake.write_bytes((ROOT/'tests/copilot/fake-hermes.py').read_bytes());self.fake.chmod(0o700);(self.directory/'fake_result.py').write_bytes((ROOT/'tests/copilot/fake_result.py').read_bytes())
        self.pool=self.directory/'pool-command'
        self.pool.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\npayload=json.load(sys.stdin);p=Path(payload["csv_path"]);p.with_suffix(".receipt").write_text(json.dumps({"payload":payload,"args":sys.argv[1:],"csv":p.read_text()}))\n');self.pool.chmod(0o700)
        self.config=json.loads((self.directory/'config.json').read_text())
        self.config.update(acp_command=[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],hermes_command=str(self.fake),pool_command=[str(self.pool)],exec_model='fixture-small',exec_transport='oneshot',fetch_commands={name:[sys.executable,str(ROOT/'tests/copilot/fake-fetch.py'),name] for name in ('google_suggest','keyword_metrics','serp_top10','competitor_keywords')},timeout_seconds=3)
        (self.directory/'config.json').write_text(json.dumps(self.config))
        self.now=[1000.];self.messages=[]
        self.module=Copilot(self.directory,lambda i,p:self.messages.append((i,p)),debounce=.02,clock=lambda:self.now[0])
        self.module.request('browser','settings',{'enabled':True});wait_for(lambda:self.module.view('browser')['ready'])
        self.state=self.module._state('browser')

    def tearDown(self):
        self.module.close()
        if self.module.runtime.process:self.assertIsNotNone(self.module.runtime.process.poll())
        self.assertFalse(self.module.executions.jobs)
        self.tmp.cleanup()

    def observe(self,title,description='点击 表格行 合成行',items=None):
        self.now[0]+=5
        return self.module.request('browser','observe',{'trace':[{'description':description,'at':self.now[0]}],
              'page':{'url':'https://example.test/','title':title,'items':items or []}})

    def infer(self,title):
        self.observe(title);wait_for(lambda:not self.state['dirty'] and not self.state['running'])

    def general(self,task):
        self.module._replace('browser',{'scene':'general','suggestions':[{'title':'测试执行','why':'fixture','action':'general.task','params':{'task':task}}]})
        return next(row for row in self.state['suggestions'].values() if row['action']=='general.task' and row['params']['task']==task)

    def test_end_to_end_argv_progress_report_pool_and_incremental_status(self):
        process=self.module.runtime.process;self.assertTrue(self.module.runtime.tools_verified)
        self.assertNotIn('workspace',self.module.view('browser'))
        self.infer('first');first=next(iter(self.state['suggestions'].values()))
        self.infer('second');self.assertEqual(len(self.state['suggestions']),2);first=self.state['suggestions'][first['id']]
        self.module.request('browser','execute',{'id':first['id']});wait_for(lambda:first['status']=='completed')
        self.assertIn('Synthetic execution result',Path(first['report']).read_text())
        receipt=json.loads(next((self.directory/'pool').glob('*.receipt')).read_text())
        self.assertIn('copilot',receipt['csv']);self.assertEqual(receipt['args'],[]);self.assertEqual(receipt['payload']['date'],date.today().isoformat());self.assertEqual(receipt['payload']['keywords'][0]['keyword'],'sample keyword')
        argv=json.loads(next((self.directory/'tasks').glob('*/argv.json')).read_text())
        for flag,value in [('-p','copilot-exec'),('--source','copilot'),('--max-turns','1'),('-m','fixture-small'),('--format','stream-json')]:self.assertEqual(argv[argv.index(flag)+1],value)
        self.assertEqual(argv[argv.index('-t')+1],'none')
        self.assertTrue(argv[argv.index('-c')+1].startswith('协作·关键词检查·'))
        brief=json.loads(next((self.directory/'tasks').glob('*/query.txt')).read_text());self.assertIn('Fast-browser-link ·',brief['browser'])
        self.assertNotIn('trace',brief);self.assertNotIn('suggestions',brief)
        self.infer('third');self.assertEqual(len(self.state['suggestions']),1)
        requests=[json.loads(line) for line in (self.directory/'acp-requests.jsonl').read_text().splitlines()]
        prompts=[entry['params']['prompt'][0]['text'] for entry in requests if entry['method']=='session/prompt']
        payload=json.loads(prompts[-1]);self.assertTrue(payload['completed']);self.assertTrue(all(len(line.encode())<=100 for line in payload['completed']))
        self.assertNotIn('Synthetic execution result',prompts[-1]);self.assertFalse(any('delegate_task' in text for text in prompts))
        self.assertIs(process,self.module.runtime.process);wait_for(lambda:any(event['type']=='progress' for _,event in self.messages))
        self.assertEqual(first['tokens'],23)

    def test_usage_channels_result_actions_and_completed_suppression(self):
        from copilot_usage import stream_metrics
        usage={'input':100,'cache_read':1000,'output':20}
        metrics=stream_metrics({'tokens':usage})
        self.assertEqual(metrics['tokens'],1120);self.assertFalse(metrics['estimated'])
        before=self.module.daily['usage'].copy()
        self.module._account('browser',metrics)
        for key in usage:self.assertEqual(self.module.view('browser')['daily_usage'][key],before[key]+usage[key])
        self.assertTrue(stream_metrics({'tokens':{'total':77}})['estimated'])
        self.infer('first');row=next(iter(self.state['suggestions'].values()))
        self.module.request('browser','execute',{'id':row['id']});wait_for(lambda:row['status']=='completed')
        with patch('copilot.subprocess.run') as opened:
            self.module.request('browser','open_report',{'id':row['id']})
            self.assertEqual(opened.call_args.args[0][-1],row['report'])
        with self.assertRaises(ValueError):self.module.request('browser','open_report',{'id':row['id'],'path':'/tmp/foreign'})
        with patch.object(self.module,'_pool') as pool:
            self.module.request('browser','save_result',{'id':row['id']});pool.assert_not_called()
            row['pool_saved']=False
            self.module.request('browser','save_result',{'id':row['id']})
            self.module.request('browser','save_result',{'id':row['id']});pool.assert_called_once()
        self.module._replace('browser',{'scene':'seo','suggestions':[{'title':'重复','why':'fixture','action':row['action'],'params':row['params']}]})
        self.assertFalse(any(r['status']=='pending' and r['action']==row['action'] for r in self.state['suggestions'].values()))
        self.module.request('browser','followup',{'id':row['id'],'action':'seo.longtail'})
        self.assertTrue(any(r['action']=='seo.longtail' and r['status']=='pending' for r in self.state['suggestions'].values()))
    def test_configure_persist_next_turn_model_and_execution_usage(self):
        self.infer('first')
        row=next(iter(self.state['suggestions'].values()))
        selected='openai-codex:gpt-6.1-sol';execution='openai-codex:gpt-5.6-luna'
        saved=self.module.request('browser','configure',{'inference_model':selected,'exec_model':execution,'mode':'custom','max_parallel':1,'context_limit':7000,'turn_multiplier':2})
        self.assertTrue(saved['settings_saved']);self.assertEqual(saved['config']['inference_model'],selected)
        self.assertEqual(json.loads((self.directory/'config.json').read_text())['exec_model'],execution)
        self.infer('second')
        requests=[json.loads(line) for line in (self.directory/'acp-requests.jsonl').read_text().splitlines()]
        self.assertTrue(any(r['method']=='session/set_model' and r['params']['modelId']==selected for r in requests))
        self.assertGreater(self.module.view('browser')['model_usage'][selected]['input'],0)
        row=self.state['suggestions'][row['id']]
        prior_input=self.module.view('browser')['daily_model_usage'].get(execution,{}).get('input',0)
        self.module.request('browser','execute',{'id':row['id']});wait_for(lambda:row['status']=='completed')
        self.assertEqual(row['model'],execution);self.assertEqual(row['model_source'],'hermes')
        self.assertEqual(self.module.view('browser')['daily_model_usage'][execution]['input'],prior_input+23)
        argv=json.loads(next((self.directory/'tasks').glob('*/argv.json')).read_text())
        self.assertEqual(argv[argv.index('-m')+1],execution);self.assertEqual(argv[argv.index('--max-turns')+1],'1')
        for values in ({'exec_model':'--help'},{'exec_model':'x; echo bad'},{'max_parallel':4},{'mode':'invalid'},{'enabled':True}):
            before=(self.directory/'config.json').read_bytes()
            with self.assertRaises(ValueError):self.module.request('browser','configure',values)
            self.assertEqual(before,(self.directory/'config.json').read_bytes())

    def test_prefilter_increment_snapshot_and_limits(self):
        self.infer('first');before=len(self.state['input_metrics'])
        self.assertFalse(self.observe('first','滚动到 页面 60%')['accepted']);self.assertFalse(self.observe('first','悬停 链接')['accepted'])
        self.assertEqual(len(self.state['input_metrics']),before)
        self.now[0]+=5
        self.module.request('browser','observe',{'trace':[{'at':self.now[0],'description':'选中 keyword'}], 'page':{'url':'https://example.test/','title':'first','items':[{'role':'heading','name':'new'}]}})
        with self.module.lock:payload,_=self.module._increment(self.state)
        self.assertNotIn('page',payload);self.assertIn('page_delta',payload);self.assertEqual(len(payload['steps']),1)
        large={'url':'https://example.test/','title':'x','items':[{'role':'row','name':'词'*180} for _ in range(80)]}
        self.assertLessEqual(len(json.dumps(self.module._bounded_page(large),ensure_ascii=False,separators=(',',':')).encode()),3072)

    def test_debounce_minimum_interval_and_single_flight(self):
        started=threading.Event();release=threading.Event();calls=[];original=self.module.runtime.prompt
        def prompt(text):
            calls.append(self.now[0]);started.set();release.wait(1)
            return json.dumps({'scene':'general','suggestions':[]}),{'tokens':1,'source':'fixture','input_bytes':len(text),'estimated_input_tokens':1,'seconds':0}
        self.module.runtime.prompt=prompt
        self.observe('a');self.observe('b');self.observe('c');self.assertTrue(started.wait(1));self.assertEqual(len(calls),1)
        self.module.request('browser','observe',{'trace':[{'at':1,'description':'选中 next'}],'page':{'url':'https://example.test/','title':'d','items':[]}})
        self.assertTrue(self.state['dirty']);release.set();wait_for(lambda:not self.state['running']);self.assertEqual(len(calls),1)
        self.now[0]+=5;self.module._infer('browser',self.state['epoch']);self.assertEqual(len(calls),2);self.assertGreaterEqual(calls[1]-calls[0],5)
        self.module.runtime.prompt=original

    def test_context_rollover_cumulative_usage_and_fallback(self):
        self.infer('first');old=self.module.runtime.session
        self.assertEqual(self.state['tokens'],22)
        row=next(iter(self.state['suggestions'].values()));row.update(status='completed',result={'summary':'FULL_RESULT_NOT_FOR_INFERENCE'})
        self.state['context_tokens']=40000;self.infer('second');self.assertNotEqual(old,self.module.runtime.session)
        requests=(self.directory/'acp-requests.jsonl').read_text();self.assertNotIn('FULL_RESULT_NOT_FOR_INFERENCE',requests)
        self.assertTrue(all('input_bytes' in row for row in self.state['input_metrics']))
        _,metrics=self.module.runtime.prompt('NO_USAGE');self.assertEqual(metrics['source'],'estimated_utf8_bytes/4')
        self.assertGreater(metrics['tokens'],0)

    def test_default_context_limit_and_exact_rollover_boundary(self):
        self.assertEqual(self.config['context_limit'],6000)
        original=self.module.runtime.session
        self.state['context_tokens']=5999;self.infer('first')
        self.assertEqual(original,self.module.runtime.session)
        self.state['context_tokens']=6000;self.infer('second')
        self.assertNotEqual(original,self.module.runtime.session)
        current=self.module.runtime.session
        self.module.config['context_limit']=5000
        self.state['context_tokens']=5000;self.infer('third')
        self.assertNotEqual(current,self.module.runtime.session)

    def test_opening_and_inference_fences_and_single_retry(self):
        original=ACP.prompt
        calls=[]
        def opening(runtime,text):
            output,metrics=original(runtime,text)
            if text!='/tools':
                calls.append(text)
                if len(calls)==1:return 'invalid opening',metrics
                return '  ```json\n'+output+'\n```  ',metrics
            return output,metrics
        self.module.request('browser','settings',{'enabled':False})
        wait_for(lambda:self.module.runtime.process.poll() is not None)
        with patch.object(ACP,'prompt',opening):
            self.module.request('browser','settings',{'enabled':True})
            wait_for(lambda:self.state['ready'])
        self.assertEqual(len(calls),2)
        metric={'tokens':2,'source':'fixture','input_bytes':1,'estimated_input_tokens':1,'seconds':0}
        billed=self.state['tokens']
        with patch.object(self.module.runtime,'prompt',side_effect=[('bad',metric),('```json\n{"scene":"general","suggestions":[]}\n```',metric)]) as prompt:
            self.infer('first')
            self.assertEqual(prompt.call_count,2)
        self.assertEqual(self.state['tokens'],billed+4)
        self.assertIsNone(self.state['diagnostic'])

    def test_opening_remains_unready_after_two_bad_responses(self):
        self.module.request('browser','settings',{'enabled':False})
        wait_for(lambda:self.module.runtime.process.poll() is not None)
        original=ACP.prompt
        calls=[]
        def broken(runtime,text):
            result,metrics=original(runtime,text)
            if text=='/tools':return result,metrics
            calls.append(text)
            return 'still not JSON',metrics
        with patch.object(ACP,'prompt',broken):
            self.module.request('browser','settings',{'enabled':True})
            wait_for(lambda:not self.state['enabled'] and self.module.runtime.process.poll() is not None)
        self.assertEqual(len(calls),2)
        self.assertFalse(self.state['ready'])
        self.assertEqual(self.state['diagnostic'],'acp_start_blocked')

    def test_idle_pause_and_auto_close(self):
        self.now[0]+=180;self.module.tick();self.assertTrue(self.state['idle_paused'])
        self.observe('first');self.assertFalse(self.state['idle_paused']);wait_for(lambda:not self.state['running'])
        self.now[0]+=1800;process=self.module.runtime.process;self.module.tick();self.assertFalse(self.state['enabled']);wait_for(lambda:process.poll() is not None)

    def test_configuration_keeps_running_execution_snapshot_and_process(self):
        self.infer('before-config');row=next(iter(self.state['suggestions'].values()));entered=threading.Event();release=threading.Event();captured=[]
        original=self.module.executions.run;process=self.module.runtime.process
        def held(*args,**kwargs):
            captured.append(args[1]);entered.set();self.assertTrue(release.wait(3));return original(*args,**kwargs)
        with patch.object(self.module.executions,'run',side_effect=held):
            self.module.request('browser','execute',{'id':row['id']});self.assertTrue(entered.wait(3))
            self.module.request('browser','configure',{'exec_model':'example:new-model','max_parallel':1,'turn_multiplier':2})
            self.assertEqual(row['status'],'executing');self.assertIs(self.module.runtime.process,process);self.assertIn('fixture-small',captured[0]);self.assertNotIn('example:new-model',captured[0])
            release.set();wait_for(lambda:row['status']=='completed')
        self.assertEqual(self.module.config['exec_model'],'example:new-model');self.assertIs(self.module.runtime.process,process)

    def test_large_usage_never_pauses_inference_or_execution(self):
        self.module.daily['usage']={'input':10**9,'cache_read':10**9,'output':10**9}
        self.module.daily['tokens']=3*10**9
        count=len(self.state['input_metrics']);self.infer('large-usage')
        self.assertGreater(len(self.state['input_metrics']),count)
        row=next(iter(self.state['suggestions'].values()))
        self.module.request('browser','execute',{'id':row['id']});wait_for(lambda:row['status']=='completed')
        view=self.module.view('browser');self.assertTrue(view['enabled']);self.assertIsNone(view['diagnostic'])
        self.assertFalse(hasattr(self.module,'_budget_available'))
        for key in ('daily_budget','daily_spend','cache_weight'):self.assertNotIn(key,view)

    def test_cache_and_save_pool_never_spawn_execution(self):
        self.infer('first');row=next(iter(self.state['suggestions'].values()));result={'summary':'cached','keywords':[{'keyword':'sample keyword'}]}
        private_write(self.module._cache_path(row),json.dumps({'at':time.time(),'result':result}))
        with patch.object(self.module.executions,'run',side_effect=AssertionError('must not spawn')):
            self.module.request('browser','execute',{'id':row['id']});wait_for(lambda:row['status']=='completed')
        self.assertTrue(row['cache_hit']);private_write(self.module._cache_path(row),json.dumps({'at':time.time()-8*86400,'result':result}));self.assertIsNone(self.module._cached(row))
        self.module._replace('browser',{'scene':'seo','suggestions':[{'title':'存词池','why':'本地写入','action':'seo.save_pool','params':{'keywords':[{'keyword':'new'}]}}]})
        local=next(row for row in self.state['suggestions'].values() if row['action']=='seo.save_pool')
        with patch.object(self.module.executions,'run',side_effect=AssertionError('must not spawn')):
            self.module.request('browser','execute',{'id':local['id']});wait_for(lambda:local['status']=='completed')
        self.assertEqual(local['tokens'],0)

    def test_parallel_limit_and_queue(self):
        self.module.config['max_parallel']=1
        self.module._replace('browser',{'scene':'seo','suggestions':[{'title':'检查 '+str(i),'why':'fixture','action':'seo.keyword_check','params':{'keyword':'word '+str(i)}} for i in range(3)]})
        rows=list(self.state['suggestions'].values())
        for row in rows:self.module.request('browser','execute',{'id':row['id']})
        deadline=time.monotonic()+4
        while time.monotonic()<deadline and any(row['status']!='completed' for row in rows):
            self.assertLessEqual(sum(row['status']=='executing' for row in rows),1);time.sleep(.01)
        self.assertTrue(all(row['status']=='completed' for row in rows))

    def test_stop_and_close_reap_process_tree(self):
        row=self.general('sleep');self.module.request('browser','execute',{'id':row['id']})
        wait_for(lambda:bool(list((self.directory/'tasks').glob('*/child.pid'))));child=int(next((self.directory/'tasks').glob('*/child.pid')).read_text())
        self.module.request('browser','stop',{'id':row['id']});wait_for(lambda:not self.module.executions.jobs);wait_for(lambda:not alive(child));self.assertEqual(row['status'],'stopped')
        row=self.general('sleep again')
        # 中文注释：第二个正在执行的任务通过关闭协作统一回收，不能影响原浏览器授权。
        self.module.request('browser','execute',{'id':row['id']})
        wait_for(lambda:bool(self.module.executions.jobs));process=self.module.runtime.process
        self.module.request('browser','settings',{'enabled':False})
        wait_for(lambda:not self.module.executions.jobs and process.poll() is not None)
        wait_for(lambda:row['status']=='stopped')

    def test_stream_result_schema_and_oversize_rejection(self):
        for mode in ('bad_schema','huge_result','bad_stream','huge_stream'):
            row=self.general(mode);self.module.request('browser','execute',{'id':row['id']});wait_for(lambda:row['status']=='failed');self.assertNotIn('report',row)
            if mode=='bad_schema':self.assertEqual(row['tokens'],23,'已发生调用即使结构校验失败也必须计费')
        parser=StreamJSON()
        for bad in (b'oops',b'[]',b'{"type":"result","exit_code":1}'):
            with self.assertRaises(ExecutionError):StreamJSON().feed(bad)
        with self.assertRaises(ExecutionError):parser.finish()
        with self.assertRaises(ExecutionError):StreamJSON().feed(b'x'*262145)

    def test_ignore_atomic_invalid_output_and_bad_output_billing(self):
        self.infer('first');row=next(iter(self.state['suggestions'].values()));self.module.request('browser','ignore',{'id':row['id']});self.infer('second');self.assertNotIn(row['id'],self.state['suggestions'])
        before=copy.deepcopy(self.state['suggestions'])
        with self.assertRaises(ValueError):self.module._replace('browser',{'scene':'general','suggestions':{}})
        self.assertEqual(before,self.state['suggestions']);billed=self.state['tokens']
        with patch.object(self.module.runtime,'prompt',return_value=('broken JSON',{'tokens':2,'source':'fixture','input_bytes':1,'estimated_input_tokens':1,'seconds':0})):
            self.observe('bad');wait_for(lambda:self.state['inference_failures']==1)
            self.assertIsNone(self.state['diagnostic'])
        self.assertEqual(self.state['tokens'],billed+4)
        self.assertEqual(before,self.state['suggestions'])
        self.assertEqual(suggestion_id('x',{'keyword':' Ｔｅｓｔ  WORD '}),suggestion_id('x',{'keyword':'test word'}))

    def test_templates_install_logs_and_scope(self):
        with self.assertRaises(ValueError):validate({'keyword':'x','command':'bad'},self.module.templates.get('seo.keyword_check')['params_schema'])
        config=(self.directory/'config.json').read_text();setup(self.directory);self.assertEqual(config,(self.directory/'config.json').read_text())
        self.assertEqual(os.stat(self.directory/'templates/seo.keyword_check.json').st_mode&0o777,0o600)
        self.observe('first');self.module.journal.flush();logs=self.directory/'logs';old=logs/((date.today()-timedelta(days=7)).isoformat()+'.jsonl');old.write_text('fixture');self.observe('next');self.module.journal.flush();self.assertFalse(old.exists())
        from daemon import BridgeDaemon,ProtocolError
        daemon=BridgeDaemon(self.directory/'home');extension={'instanceId':'fixture'};daemon.extensions['fixture']=extension
        self.assertFalse(daemon._dispatch_connected_extension(extension,'extension.copilot.state',{})['enabled'])
        with self.assertRaises(ProtocolError):daemon._dispatch_connected_extension({'instanceId':'fixture'},'extension.copilot.state',{})
        with self.assertRaises(ACPError):self.module.runtime.call('unsupported',{})
        daemon.copilot.close()


class ModelCatalogTest(unittest.TestCase):
    def test_parse_empty_dedup_current_and_manual_format(self):
        from copilot_models import parse_models,model_id
        self.assertEqual(parse_models({}),{'current':'','available':[]})
        value=parse_models({'models':{'currentModelId':'custom:local:gpt-5.6-luna','availableModels':[{'modelId':'custom:local:gpt-5.6-luna'},{'modelId':'custom:local:gpt-5.6-luna'}]}})
        self.assertEqual(len(value['available']),1);self.assertTrue(value['available'][0]['default'])
        self.assertEqual(model_id('custom:local:vendor/model-v1'), 'custom:local:vendor/model-v1')
        for bad in ['--provider','model id','x\n--help','x;echo','$(pwd)']:
            with self.assertRaises(ValueError):model_id(bad)
        with self.assertRaises(ValueError):parse_models({'models':{'availableModels':[None]}})

    def test_discovery_never_prompts_cache_refresh_expiry_and_profile_reuse(self):
        from copilot import DEFAULTS
        from copilot_models import catalogs
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary).resolve()
            config={**DEFAULTS,'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'timeout_seconds':2}
            def requests():return [json.loads(line) for line in (directory/'acp-requests.jsonl').read_text().splitlines()]
            value=catalogs(config,directory,private_write)
            self.assertEqual(value['inference']['current'],'openai-codex:gpt-5.6-luna')
            self.assertEqual(sum(r['method']=='session/new' for r in requests()),2)
            self.assertFalse(any(r['method'] in {'session/prompt','session/set_model'} for r in requests()))
            self.assertTrue(catalogs(config,directory,private_write)['execution']['cached'])
            self.assertEqual(sum(r['method']=='session/new' for r in requests()),2)
            catalogs(config,directory,private_write,force=True)
            self.assertEqual(sum(r['method']=='session/new' for r in requests()),4)
            with patch('copilot_models.time.time',return_value=time.time()+86401):catalogs(config,directory,private_write)
            self.assertEqual(sum(r['method']=='session/new' for r in requests()),6)
            config['exec_profile']=config['inference_profile']
            catalogs(config,directory,private_write,force=True)
            self.assertEqual(sum(r['method']=='session/new' for r in requests()),7)

    def test_catalog_failure_returns_chinese_manual_fallback(self):
        from copilot import DEFAULTS
        from copilot_models import catalogs
        with tempfile.TemporaryDirectory() as temporary:
            value=catalogs({**DEFAULTS,'acp_command':['/missing/hermes']},Path(temporary),private_write)
            self.assertIn('手动填写',value['inference']['error'])
            self.assertEqual(value['execution']['available'],[])
            self.assertFalse((Path(temporary)/'models.json').exists())


class ModelJSONTest(unittest.TestCase):
    def test_only_fences_and_whitespace_are_removed(self):
        for text in ('  {"ready":true} \n','```json\n{"ready":true}\n```',' \n```\n{"ready":true}\n```\n '):
            self.assertEqual(parse_model_json(text),{'ready':True})
        for text in ('prefix {"ready":true}','{"ready":true} trailing','```python\n{}\n```','[]','{"value":NaN}'):
            with self.assertRaises(ValueError):parse_model_json(text)

    def test_failure_is_retried_once_and_both_attempts_are_billed(self):
        usage={'tokens':3,'source':'fixture','input_bytes':5,'estimated_input_tokens':2,'seconds':.1}
        runtime=type('Runtime',(),{})()
        billed=[]
        with patch.object(runtime,'prompt',create=True,side_effect=[('bad',usage),('also bad',usage)]) as prompt:
            with self.assertRaises(ValueError):model_json_prompt(runtime,'input',billed.append)
            self.assertEqual(prompt.call_count,2)
        self.assertEqual(sum(row['tokens'] for row in billed),6)
        with patch.object(runtime,'prompt',create=True,side_effect=ACPError('transport failure')) as prompt:
            with self.assertRaises(ACPError):model_json_prompt(runtime,'input')
            self.assertEqual(prompt.call_count,1)


class ProfileSetupTest(unittest.TestCase):
    def test_preview_create_idempotence_and_existing_profile_refusal(self):
        import contextlib,io
        spec=importlib.util.spec_from_file_location('profile_setup',ROOT/'scripts/setup-copilot-profile.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve()
            existing=root/'profiles/existing-profile';existing.mkdir(parents=True);sentinel=existing/'config.yaml';sentinel.write_text('user-owned')
            fake=root/'hermes'
            fake.write_text('#!/usr/bin/env python3\nimport os,sys\nfrom pathlib import Path\nassert sys.argv[1:]==["profile","create","copilot","--no-alias","--no-skills"]\n(Path(os.environ["HERMES_HOME"])/"profiles/copilot").mkdir()\n')
            fake.chmod(0o700)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                module.setup(root,'fixture-fast')
                self.assertFalse((root/'profiles/copilot').exists())
                module.setup(root,'fixture-fast',apply=True,command=str(fake))
                config_path=root/'profiles/copilot/config.yaml';before=config_path.read_bytes();modified=config_path.stat().st_mtime_ns
                module.setup(root,'fixture-fast',apply=True,command=str(fake))
                self.assertEqual(config_path.stat().st_mtime_ns,modified)
                self.assertEqual(config_path.read_bytes(),before)
                with self.assertRaises(ValueError):module.setup(root,'different',apply=True,command=str(fake))
            config=json.loads(before);self.assertEqual(config['_config_version'],50);self.assertEqual(config['platform_toolsets']['acp'],[])
            self.assertEqual(config['plugins']['enabled'],[]);self.assertEqual(config['mcp_servers'],{})
            self.assertFalse(config['memory']['memory_enabled']);self.assertFalse(config['memory']['user_profile_enabled'])
            self.assertEqual((root/'profiles/copilot/SOUL.md').read_text(),'')
            self.assertEqual(sentinel.read_text(),'user-owned');self.assertIn('Plan: create only',output.getvalue())

    def test_exec_profile_and_template_caps(self):
        import contextlib,io
        spec=importlib.util.spec_from_file_location('profile_setup',ROOT/'scripts/setup-copilot-profile.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();(root/'plugins/fast-browser-link').mkdir(parents=True)
            fake=root/'hermes'
            fake.write_text('#!/usr/bin/env python3\nimport os\nfrom pathlib import Path\n(Path(os.environ["HERMES_HOME"])/"profiles/copilot-exec").mkdir(parents=True)\n');fake.chmod(0o700)
            with contextlib.redirect_stdout(io.StringIO()):
                module.setup(root,'gpt-5.6-luna','openai-codex',True,str(fake),'copilot-exec')
                config_path=root/'profiles/copilot-exec/config.yaml';before=config_path.stat().st_mtime_ns
                module.setup(root,'gpt-5.6-luna','openai-codex',True,str(fake),'copilot-exec')
            config=json.loads(config_path.read_text());self.assertEqual(config['_config_version'],50)
            self.assertEqual(config_path.stat().st_mtime_ns,before)
            self.assertEqual(config['plugins']['enabled'],['fast-browser-link'])
            self.assertEqual(config['platform_toolsets']['cli'],['fast-browser-link','web','terminal','file'])
            self.assertEqual(config['platform_toolsets']['acp'],[])
            self.assertEqual(config['command_allowlist'],[])
            self.assertEqual(config['approvals']['mode'],'manual')
            self.assertFalse(config['auxiliary']['title_generation']['enabled'])
            self.assertFalse(config['memory']['memory_enabled']);self.assertEqual(config['mcp_servers'],{})
            self.assertEqual((config_path.parent/'plugins/fast-browser-link').resolve(),root/'plugins/fast-browser-link')
        from copilot import DEFAULTS
        for name,cap in [('keyword_check',15),('longtail',12),('competitor_keywords',15),('serp_breakdown',6)]:
            template=json.loads((ROOT/f'native-bridge/copilot-templates/seo/seo.{name}.json').read_text())
            for global_cap in (5,30):
                argv=execution_argv({**DEFAULTS,'max_turns':global_cap},template,'测试',Path('/tmp/query'))
                self.assertEqual(int(argv[argv.index('--max-turns')+1]),min(cap,global_cap))

    def test_execution_measurement_reports_prompt_envelope_not_system_estimate(self):
        spec=importlib.util.spec_from_file_location('measure_exec',ROOT/'scripts/measure-copilot-exec.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            fake=Path(temporary)/'hermes'
            fake.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"type":"result","exit_code":0,"tokens":{"input":1000,"cache_read":5000,"output":2}}))\n');fake.chmod(0o700)
            result=module.measure(str(fake),root=temporary)
            self.assertEqual(result['prompt_envelope_tokens'],6000);self.assertTrue(result['within_8000'])
            self.assertIn('upper bound',result['scope'])

    def test_acp_channel_deltas_exclude_cached_input(self):
        from copilot import DEFAULTS
        with tempfile.TemporaryDirectory() as temporary:
            runtime=ACP(DEFAULTS,Path(temporary))
            runtime.session='fixture'
            with patch.object(runtime,'call',side_effect=[
                {'stopReason':'end_turn','usage':{'inputTokens':1100,'cachedReadTokens':1000,'outputTokens':20,'totalTokens':1120}},
                {'stopReason':'end_turn','usage':{'inputTokens':2300,'cachedReadTokens':2100,'outputTokens':50,'totalTokens':2350}}]):
                self.assertEqual(runtime.prompt('first')[1]['usage'],{'input':100,'cache_read':1000,'output':20})
                self.assertEqual(runtime.prompt('second')[1]['usage'],{'input':100,'cache_read':1100,'output':30})

    def test_acp_rejects_tools_in_inference_profile(self):
        from copilot import DEFAULTS
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary).resolve()
            runtime=ACP({**DEFAULTS,'timeout_seconds':2,'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py'),'--has-tools']},directory)
            with self.assertRaises(ACPError):runtime.start()
            runtime.close();self.assertIsNotNone(runtime.process.poll())

    def test_execution_argv_rejects_broad_toolsets(self):
        from copilot import DEFAULTS
        for toolsets in ([],['all'],['*'],['web,terminal']):
            with self.assertRaises(ExecutionError):execution_argv(DEFAULTS,{'toolsets':toolsets},'协作·test',Path('/tmp/query'))

    def test_hermes_children_use_hermes_home_not_runtime_root(self):
        old=os.environ.get('HERMES_HOME')
        os.environ['HERMES_HOME']='/tmp/runtime-root'
        try:
            env=hermes_environment({},{'HERMES_ACP_SKIP_CONFIGURED_MCP':'1'})
            self.assertEqual(env['HERMES_HOME'],str(Path.home()/'.hermes'))
            self.assertEqual(env['HERMES_ACP_SKIP_CONFIGURED_MCP'],'1')
            self.assertEqual(env['HERMES_YOLO_MODE'],'false')
            self.assertEqual(hermes_environment({'hermes_home':'/tmp/custom-hermes'})['HERMES_HOME'],'/tmp/custom-hermes')
        finally:
            if old is None:os.environ.pop('HERMES_HOME',None)
            else:os.environ['HERMES_HOME']=old

if __name__=='__main__':unittest.main()
