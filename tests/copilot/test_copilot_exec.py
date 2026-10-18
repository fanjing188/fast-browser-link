"""R6b：常驻执行、取数及受管升级，全部为临时离线替身。"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,DEFAULTS,Templates,parse_model_json,private_write,validate
from copilot_setup import setup
from copilot_exec_acp import ACPExecutions,compact_memory,ExecutionError
from copilot_fetch import Fetcher


def wait(check):
    until=time.monotonic()+5
    while time.monotonic()<until:
        if check():return
        time.sleep(.01)
    raise AssertionError('fixture timed out')


class ExecutionACPTest(unittest.TestCase):
    def setUp(self):
        backoff=patch.object(ACPExecutions,'BACKOFF',(.01,.02,.04));backoff.start();self.addCleanup(backoff.stop)
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        self.config={**DEFAULTS,'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'timeout_seconds':3}
        self.pool=ACPExecutions(self.config,self.root);self.pool.start()
    def tearDown(self):self.pool.close();self.tmp.cleanup()
    def brief(self,word):return {'action':'seo.longtail','params':{'keyword':word},'result_schema':{},'completed':''}
    def run_task(self,key,word):
        work=self.root/key;work.mkdir(exist_ok=True)
        return self.pool.run(key,self.brief(word),work/'result.json',parse_model_json,private_write)
    def records(self):return [json.loads(line) for line in (self.root/'exec-acp-requests.jsonl').read_text().splitlines()]

    def test_one_process_independent_concurrent_sessions_usage_reset_and_cancel(self):
        with ThreadPoolExecutor(max_workers=2) as workers:
            first=workers.submit(self.run_task,'one','hold');second=workers.submit(self.run_task,'two','hold')
            wait(lambda:len(self.pool.jobs)==2)
            wait(lambda:sum(r.get('method')=='session/prompt' and not r['params']['prompt'][0]['text'].startswith('/') for r in self.records())==2)
            self.assertEqual(len({job['session'] for job in self.pool.jobs.values()}),2)
            self.pool.cancel('one');(self.root/'release').touch()
            with self.assertRaises(ExecutionError):first.result(5)
            result,metrics=second.result(5)
        self.assertEqual(metrics['usage'],{'input':30,'cache_read':80,'output':5})
        self.assertEqual(sum('pid' in r for r in self.records()),1)
        self.assertEqual(sum(r.get('method')=='session/new' for r in self.records()),2)
        self.assertTrue(any(r.get('method')=='session/cancel' for r in self.records()))
        self.assertEqual(sum(r.get('method')=='session/prompt' and r['params']['prompt'][0]['text']=='/reset' for r in self.records()),2)

    def test_permission_is_denied_and_task_does_not_hang(self):
        self.run_task('permission','permission')
        replies=[r for r in self.records() if r.get('result',{}).get('outcome')]
        self.assertEqual(replies[-1]['result']['outcome'],{'outcome':'cancelled'})

    def test_crash_restarts_once_without_replaying_task(self):
        with self.assertRaises(ExecutionError):self.run_task('first','crash')
        wait(lambda:self.pool.restarts==1)
        result,_=self.run_task('next','fine');self.assertIn('verdict',result)
        self.assertEqual(sum('pid' in r for r in self.records()),2)
        self.assertEqual(sum(r.get('method')=='session/new' for r in self.records()),2)
        errors=[];self.pool.on_error=errors.append
        for attempt in (2,3):
            previous=self.pool.runtime;previous.process.kill();previous.process.wait()
            wait(lambda:self.pool.runtime is not previous and self.pool.runtime.process is not None and self.pool.runtime.process.poll() is None)
            self.assertEqual(self.pool.restarts,attempt)
        self.pool.runtime.process.kill();self.pool.runtime.process.wait()
        wait(lambda:bool(errors))
        self.assertEqual(errors[-1],'execution_acp_restart_exhausted')
        with self.assertRaisesRegex(ExecutionError,'restart exhausted'):self.run_task('third','fine')

    def test_unsupported_tool_constraints_fail_before_model_prompt(self):
        self.pool.close();self.pool=ACPExecutions({**self.config,'exec_acp_command':[*self.config['exec_acp_command'],'--has-tools']},self.root)
        with self.assertRaisesRegex(ExecutionError,'无法按会话限制工具'):self.run_task('blocked','fine')
        prompts=[r['params']['prompt'][0]['text'] for r in self.records() if r.get('method')=='session/prompt']
        self.assertTrue(all(text.startswith('/') for text in prompts))

    def test_collaboration_memory_is_utf8_bounded_and_line_safe(self):
        text=compact_memory(['已完成 关键词'+str(i)+' → '+'测一页档'*20 for i in range(30)])
        self.assertLessEqual(len(text.encode()),500);self.assertIn('关键词29',text);self.assertNotIn('关键词0 ',text)


class FetchPipelineTest(unittest.TestCase):
    def test_each_seo_template_fetches_then_one_acp_judgment_missing_data_and_local_save(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();setup(root)
            config={**DEFAULTS,'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'timeout_seconds':3,
                'fetch_commands':{name:[sys.executable,str(ROOT/'tests/copilot/fake-fetch.py'),name] for name in ['google_suggest','keyword_metrics','serp_top10','competitor_keywords']}}
            (root/'config.json').write_text(json.dumps(config));module=Copilot(root,debounce=.01)
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready'])
                state=module._state('browser');state['page']={'url':'https://example.test/serp','title':'SERP','items':[{'role':'row','name':'fixture'}]}
                for action,params in [('seo.longtail',{'keyword':'longtail'}),('seo.keyword_check',{'keyword':'check'}),('seo.competitor_keywords',{'url':'https://example.test'}),('seo.serp_breakdown',{'url':'https://example.test/serp'})]:
                    module._replace('browser',{'scene':'seo','suggestions':[{'title':'取数判读','why':'fixture','action':action,'params':params}]})
                    row=next(r for r in state['suggestions'].values() if r['action']==action)
                    with patch.object(module,'_pool'):
                        module.request('browser','execute',{'id':row['id']});wait(lambda:row['status'] in {'completed','failed'})
                    self.assertEqual(row['status'],'completed',row.get('reason'));self.assertEqual(row['usage'],{'input':30,'cache_read':80,'output':5})
                records=[json.loads(line) for line in (root/'exec-acp-requests.jsonl').read_text().splitlines()]
                prompts=[r for r in records if r.get('method')=='session/prompt' and not r['params']['prompt'][0]['text'].startswith('/')]
                self.assertEqual(len(prompts),4);self.assertEqual(len({r['params']['sessionId'] for r in prompts}),4)
                self.assertTrue(all('fetched' in json.loads(r['params']['prompt'][0]['text']) for r in prompts))
                self.assertLessEqual(len(compact_memory(state['execution_memory']).encode()),500)
                module.config['fetch_commands']['google_suggest']=['/missing/fetch']
                module._replace('browser',{'scene':'seo','suggestions':[{'title':'缺数据','why':'fixture','action':'seo.longtail','params':{'keyword':'missing'}}]})
                row=next(r for r in state['suggestions'].values() if r['params'].get('keyword')=='missing')
                module.request('browser','execute',{'id':row['id']});wait(lambda:row['status']=='completed')
                self.assertTrue(row['result']['missing'])
                before=len([r for r in records if r.get('method')=='session/new'])+1
                module._replace('browser',{'scene':'seo','suggestions':[{'title':'保存本地词池','why':'fixture','action':'seo.save_pool','params':{'keywords':[{'keyword':'local'}]}}]})
                local=next(r for r in state['suggestions'].values() if r['action']=='seo.save_pool')
                with patch.object(module,'_pool',return_value=None) as pool:
                    module.request('browser','execute',{'id':local['id']});wait(lambda:local['status']=='completed');pool.assert_called_once()
                current=[json.loads(line) for line in (root/'exec-acp-requests.jsonl').read_text().splitlines()]
                self.assertEqual(sum(r.get('method')=='session/new' for r in current),before)
                self.assertEqual(local['model_source'],'local')
                path=root/'templates/seo.keyword_check.json';template=json.loads(path.read_text());template['fetch_fallback']['enabled']=True;path.write_text(json.dumps(template))
                module.config['fetch_commands']['keyword_metrics']=['/missing/fetch'];fake=root/'hermes-oneshot';fake.write_bytes((ROOT/'tests/copilot/fake-hermes.py').read_bytes());fake.chmod(0o700);(root/'fake_result.py').write_bytes((ROOT/'tests/copilot/fake_result.py').read_bytes());module.config['hermes_command']=str(fake)
                module._replace('browser',{'scene':'seo','suggestions':[{'title':'受限浏览器后备','why':'fixture','action':'seo.keyword_check','params':{'keyword':'fallback'}}]})
                fallback=next(r for r in state['suggestions'].values() if r['params'].get('keyword')=='fallback')
                with patch.object(module,'_pool'):
                    module.request('browser','execute',{'id':fallback['id']});wait(lambda:fallback['status'] in {'completed','failed'})
                self.assertEqual(fallback['status'],'completed',fallback.get('reason'));self.assertEqual(fallback['transport'],'oneshot')
                argv=[json.loads(p.read_text()) for p in (root/'tasks').glob('*/argv.json')][0]
                self.assertEqual(argv[argv.index('--max-turns')+1],'3')

            finally:module.close()

    def test_fetch_bad_schema_and_timeout_are_explicit_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();setup(root);template=Templates(root/'templates').get('seo.longtail')
            config={'fetch_commands':{'google_suggest':[sys.executable,'-c','print("{}")']}}
            fetcher=Fetcher(config)
            result=fetcher.run('one',template,{'keyword':'fixture'},root,validate)
            self.assertTrue(result['missing']);self.assertFalse(result['data'])
            config['fetch_commands']['google_suggest']=[sys.executable,'-c','import time;time.sleep(10)'];template['fetch'][0]['timeout']=.05
            result=fetcher.run('two',template,{'keyword':'fixture'},root,validate)
            self.assertTrue(result['missing']);self.assertFalse(fetcher.jobs);fetcher.close()


class ManagedUpgradeTest(unittest.TestCase):
    def test_only_verified_managed_files_upgrade_preview_and_user_changes_refused(self):
        import contextlib,io
        spec=importlib.util.spec_from_file_location('setup_profile',ROOT/'scripts/setup-copilot-profile.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();target=root/'profiles/fast-copilot';target.mkdir(parents=True)
            old={'model':{'default':'gpt-5.6-luna','provider':'openai-codex'},'platform_toolsets':{'acp':[]}}
            files={'config.yaml':json.dumps(old,ensure_ascii=False,indent=2)+'\n','SOUL.md':'','AGENTS.md':'','workspace/AGENTS.md':'','workspace/.hermes.md':''}
            for name,text in files.items():path=target/name;path.parent.mkdir(exist_ok=True);path.write_text(text)
            marker=target/'.copilot-profile.json';marker.write_text(json.dumps({'files':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in files.items()}}))
            with contextlib.redirect_stdout(io.StringIO()):
                module.setup(root,'gpt-5.6-luna','openai-codex');self.assertEqual(json.loads((target/'config.yaml').read_text()),old)
                module.setup(root,'gpt-5.6-luna','openai-codex',True)
                config=json.loads((target/'config.yaml').read_text());self.assertFalse(config['auxiliary']['title_generation']['enabled'])
                before=(target/'config.yaml').stat().st_mtime_ns;module.setup(root,'gpt-5.6-luna','openai-codex',True);self.assertEqual(before,(target/'config.yaml').stat().st_mtime_ns)
                (target/'SOUL.md').write_text('user modification')
                with self.assertRaises(ValueError):module.setup(root,'gpt-5.6-luna','openai-codex',True)

if __name__=='__main__':unittest.main()
