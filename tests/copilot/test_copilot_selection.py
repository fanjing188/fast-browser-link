"""R8：本机扩展包、划词查询、趋势与组合任务；不访问浏览器或网络。"""
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,validate,suggestion_id,inference_prompt
from copilot_setup import setup
from copilot_packages import Packages
from copilot_results import compose,decision_schema,result_schema


def wait(check):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        if check():return
        time.sleep(.01)
    raise AssertionError('fixture timed out')


class SelectionContracts(unittest.TestCase):
    def decision(self,**extra):return {'verdict':'按实际曲线判断','level':'info','process':[],'next':[],**extra}
    def module(self,root,config=None):
        setup(root);(root/'config.json').write_text(json.dumps({'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'timeout_seconds':3,**(config or {})}));return Copilot(root,debounce=.01)

    def test_quick_click_during_start_is_retained_and_executes_after_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            module=self.module(Path(directory).resolve());start=threading.Event();activate=module._activate
            try:
                with patch.object(module,'_activate',side_effect=lambda *args:(start.wait(2),activate(*args))):
                    module.request('browser','settings',{'enabled':True});module.request('browser','quick_task',{'action':'general.task','params':{'task':'Explain this selection'}})
                    state=module._state('browser');row=next(iter(state['suggestions'].values()));self.assertEqual(row['status'],'pending');module._replace('browser',{'scene':'general','suggestions':[]});self.assertIn(row['id'],state['suggestions']);start.set();wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed')
            finally:start.set();module.close()

    def test_quick_translation_oneshot_uses_inference_model_none_tools_and_one_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();fake=root/'hermes';fake.write_bytes((ROOT/'tests/copilot/fake-hermes.py').read_bytes());fake.chmod(0o700);(root/'fake_result.py').write_bytes((ROOT/'tests/copilot/fake_result.py').read_bytes())
            module=self.module(root,{'exec_transport':'oneshot','hermes_command':str(fake),'inference_model':'openai-codex:gpt-5.6-luna','exec_model':'other-execution-model'})
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','quick_task',{'action':'general.task','params':{'task':'Translate sample'}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='general.task');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed')
                args=json.loads(next((root/'tasks').glob('*/argv.json')).read_text());self.assertEqual(args[args.index('-m')+1],'openai-codex:gpt-5.6-luna');self.assertEqual(args[args.index('-t')+1],'none');self.assertEqual(args[args.index('--max-turns')+1],'1')
                brief=json.loads(next((root/'tasks').glob('*/query.txt')).read_text());self.assertIn('只返回',brief['output'])
            finally:module.close()

    def test_recent_keyword_metadata_survives_restart_without_refetch_or_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();module=self.module(root,{'fetch_commands':{name:[sys.executable,str(ROOT/'tests/copilot/fake-fetch.py'),name] for name in ('keyword_metrics','serp_top10')}})
            module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','quick_task',{'action':'seo.keyword_check','params':{'keywords':['sample','second']}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='seo.keyword_check');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed');module.close()
            restarted=Copilot(root)
            try:
                with patch.object(restarted.fetcher,'run',side_effect=AssertionError('must not fetch')):
                    info=restarted.request('browser','selection_info',{'text':'second'});self.assertIsNotNone(info['cached']);self.assertEqual(restarted.request('browser','result',{'id':info['cached']['id']})['result'],row['result']);self.assertIsNone(restarted.runtime)
            finally:restarted.close()

    def test_saving_models_does_not_flatten_local_package_commands_into_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();package=root/'extension';package.mkdir();(package/'package.json').write_text(json.dumps({'id':'example-local','version':1,'fetchers':{'domain_rating':['example-adapter']}}));module=self.module(root,{'extension_dirs':[str(package)]})
            try:
                self.assertIn('domain_rating',module.config['fetch_commands']);module.request('browser','configure',module.view('browser')['config']);persisted=json.loads((root/'config.json').read_text());self.assertNotIn('domain_rating',persisted['fetch_commands']);self.assertEqual(persisted['extension_dirs'],[str(package)])
            finally:module.close()

    def test_trends_numbers_owned_by_script_missing_data_not_invented(self):
        series=[{'keyword':'sample','region':region,'period':period,'points':[{'date':'2026-01','value':38},{'date':'2026-02','value':80}]} for region in ('US','WORLD') for period in ('12m','5y')]
        value=compose('seo.trends',{'keyword':'sample'},self.decision(pattern='seasonal',peak_months=['February']),{'data':{'google_trends':{'series':series,'source':'fixture'}},'missing':[]},validate)
        self.assertEqual(value['series'],series);self.assertFalse(value['missing']);validate(value,result_schema('seo.trends'))
        missing=compose('seo.trends',{'keyword':'sample'},self.decision(level='go',pattern='rising',peak_months=['March']),{'data':{},'missing':['source unavailable']},validate)
        self.assertEqual(missing['pattern'],'unknown');self.assertEqual(missing['level'],'info');self.assertEqual(missing['peak_months'],[]);self.assertTrue(missing['missing'])
        with self.assertRaises(ValueError):validate(self.decision(pattern='rising',peak_months=[],series=series),decision_schema('seo.trends'))
        series[0]['points'][0]['value']=101
        with self.assertRaises(ValueError):compose('seo.trends',{'keyword':'sample'},self.decision(pattern='rising',peak_months=[]),{'data':{'google_trends':{'series':series}},'missing':[]},validate)

    def test_local_packages_override_rules_fetchers_and_workflows_without_personal_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();package=root/'extension';package.mkdir();declaration={'id':'example-seo-tool','version':1,'fetchers':{'domain_rating':['python3','./metrics.py']},'pool':{'lookup_command':['./lookup']},'rules':{'min_volume':123},'workflows':{'seo.ranking_sites':{'seed_fetcher':'example_serp','site_fetcher':'example_keywords','max_sites':2}}};(package/'package.json').write_text(json.dumps(declaration));packages=Packages([str(package)]);config={'fetch_commands':{}};packages.configure(config)
            self.assertEqual(packages.rules['min_volume'],123);self.assertEqual(config['fetch_commands']['domain_rating'][1],str(package/'metrics.py'));self.assertEqual(packages.workflows['seo.ranking_sites']['max_sites'],2)
            declaration['templates']={'seo.trends':'../outside.json'};(package/'package.json').write_text(json.dumps(declaration))
            with self.assertRaises(ValueError):Packages([str(package)])

    def test_local_metadata_cache_and_pool_receipt_open_exact_result_without_query(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();module=self.module(root,{'pool_lookup_auto':{'risk':'zero','read_only':True,'local_only':True},'pool_lookup_command':[sys.executable,'-c','import json;print(json.dumps({"found":True,"tier":"test","last_checked":"2026-10-16"}))']})
            try:
                state=module._state('browser');result={'verdict':'先测一个任务','level':'test','metrics':[],'missing':[],'process':[],'next':[],'keyword':'sample','tier':'test','intent':'tool','serp':[],'reasons':[]}
                row={'id':'exact','action':'seo.keyword_check','params':{'keyword':'sample'},'title':'sample','status':'completed','finished_at':time.time(),'result':result};state['suggestions']['exact']=row
                with patch.object(module.fetcher,'run',side_effect=AssertionError('must not fetch')):
                    module._state('browser')['pool_words']=['sample'];info=module.request('browser','selection_info',{'text':'sample'});self.assertEqual(info['cached']['id'],'exact');self.assertEqual(info['pool']['tier'],'test');module.request('browser','focus_result',{'id':'exact'});self.assertEqual(module.view('browser')['focused_result'],'exact')
                row['finished_at']=time.time()-8*86400;self.assertIsNone(module.request('browser','selection_info',{'text':'sample'})['cached'])
            finally:module.close()

    def test_browser_data_handoff_is_instance_epoch_and_cancel_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            module=self.module(Path(directory).resolve());state=module._state('browser');state['enabled']=True;module.active='browser';output=[]
            try:
                worker=threading.Thread(target=lambda:output.append(module._browser_fetch('browser',0,'browser:job','serp_top10',{'keyword':'sample'},{})));worker.start();wait(lambda:bool(module.browser_fetches));identity=next(iter(module.browser_fetches))
                with self.assertRaises(ValueError):module.request('other','browser_fetch_result',{'id':identity,'data':{}})
                self.assertTrue(module.request('browser','browser_fetch_status',{'id':identity})['allowed']);module.request('browser','browser_fetch_result',{'id':identity,'data':{'source':'fixture','results':[]}});worker.join(2);self.assertEqual(output[0]['results'],[])
                self.assertFalse(module.request('browser','browser_fetch_status',{'id':identity})['allowed'])
                with self.assertRaises(ValueError):module.request('browser','browser_fetch_result',{'id':identity,'data':{}})
            finally:module.close()

    def test_quick_trends_one_execution_one_judgment_and_language_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            module=self.module(Path(directory).resolve())
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','locale',{'language':'en-US'});self.assertIn('Analyze only',inference_prompt({},module.templates));self.assertNotIn('只判断',module.templates.get('seo.trends')['prompt'])
                series=[{'keyword':'sample','region':'US','period':'12m','points':[{'date':'2026-01','value':20}]}]
                with patch.object(module,'_browser_fetch',return_value={'series':series,'source':'fixture'}) as fetch:
                    module.request('browser','quick_task',{'action':'seo.trends','params':{'keyword':'sample'},'context':{'url':'https://example.test/?sort=volume','incognito':True}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='seo.trends');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed');self.assertEqual(fetch.call_count,1);self.assertEqual(fetch.call_args.args[-1]['url'],'https://example.test/?sort=volume');self.assertTrue(fetch.call_args.args[-1]['incognito']);self.assertEqual(row['result']['series'],series)
                records=[json.loads(line) for line in (Path(directory).resolve()/'exec-acp-requests.jsonl').read_text().splitlines()];self.assertEqual(sum(record.get('method')=='session/new' for record in records),1)
                prompts=[record for record in records if record.get('method')=='session/prompt' and record['params']['prompt'][0]['text'].startswith('{')];self.assertEqual(len(prompts),1)
            finally:module.close()

    def test_ranking_pipeline_one_serp_three_competitors_one_judgment(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();script=root/'fetch.py';script.write_text('import json,sys\nfrom pathlib import Path\np=json.load(sys.stdin);kind=sys.argv[1]\nwith Path("fetch.log").open("a") as f:f.write(kind+"\\n")\nprint(json.dumps({"source":"fixture","results":[{"url":"https://"+s+".test/"} for s in ["one","two","three","four"]]} if kind=="serp" else {"source":"fixture","keywords":[{"keyword":p["url"],"vol":42,"kd":7}],"pages":[p["url"]+"/top"]}))')
            module=self.module(root,{'fetch_commands':{'serp_top10':[sys.executable,str(script),'serp'],'competitor_keywords':[sys.executable,str(script),'competitor']}})
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','quick_task',{'action':'seo.ranking_sites','params':{'keyword':'sample'}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='seo.ranking_sites');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed');self.assertEqual(len(row['result']['sites']),3);self.assertEqual(row['result']['sites'][0]['keywords'][0]['vol'],42)
                logs=''.join(path.read_text() for path in (root/'tasks').glob('*/fetch.log'));self.assertEqual(logs.count('serp\n'),1);self.assertEqual(logs.count('competitor\n'),3)
                records=[json.loads(line) for line in (root/'exec-acp-requests.jsonl').read_text().splitlines()];self.assertEqual(sum(record.get('method')=='session/new' for record in records),1)
            finally:module.close()

    def test_quick_translation_uses_inference_model_one_isolated_zero_tool_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();module=self.module(root,{'inference_model':'openai-codex:gpt-5.6-luna'})
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','quick_task',{'action':'general.task','params':{'task':'Explain selected text'}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='general.task');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed');self.assertEqual(row['requested_model'],'openai-codex:gpt-5.6-luna');self.assertEqual(row['model'],'openai-codex:gpt-5.6-luna')
                records=[json.loads(line) for line in (root/'acp-requests.jsonl').read_text().splitlines()];self.assertEqual(sum(record.get('method')=='session/prompt' and record['params']['prompt'][0]['text'].startswith('{') and json.loads(record['params']['prompt'][0]['text']).get('action')=='general.task' for record in records),0)
                executed=[json.loads(line) for line in (root/'exec-acp-requests.jsonl').read_text().splitlines()];self.assertEqual(sum(item.get('method')=='session/new' for item in executed),1);self.assertEqual(sum(item.get('method')=='session/prompt' and item['params']['prompt'][0]['text'].startswith('{') for item in executed),1)
            finally:module.close()
