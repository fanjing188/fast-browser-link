"""R9 本机能力与编排的离线验收；全部使用虚构工具、临时文件和假命令。"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,validate,private_write
from copilot_setup import setup
from copilot_packages import Packages
from copilot_capabilities import Registry,Workflows,CAPABILITIES,recognize,map_table,discover


class CapabilitiesTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.package=self.root/'package';self.package.mkdir();self.log=self.root/'calls.jsonl'
  self.tool={'id':'example-seo-tool','name':{'zh':'虚构SEO工具','en':'Example SEO tool'},'hosts':['seo.example.test'],'links':{'report':'https://seo.example.test/report?q={keyword}'},'pages':[{'id':page,'paths':['^/'+page+'/$'],'object_param':'q','columns':{'keyword':['Keyword','关键词'],'vol':['Volume'],'kd':['KD'],'url':['URL']},'flows':['leaders','small_sites','page_family','keyword_gap','intent_split','season_window','pool_links'] if page=='magic' else ['domain_pages','domain_rising','pool_gap']} for page in ('magic','overview','positions','pages','competitors','domain','new_improved')]}
  caps={cap:[{'id':'fixture-'+cap.replace('.','-'),'type':'command','argv':[sys.executable,str(ROOT/'tests/copilot/fake-capability.py'),cap,str(self.log)],'batch_limit':100,'priority':1,'exact':cap=='keyword.metrics','fields':['traffic','weak','authority','reg_date','trend12','cpc','vol','kd']}] for cap in CAPABILITIES}
  self.declaration={'id':'example-local','version':1,'tools':[self.tool],'capabilities':caps};self.save();self.packages=Packages([str(self.package)]);self.registry=Registry(self.packages,self.root/'copilot',private_write,validate)
 def tearDown(self):self.tmp.cleanup()
 def save(self):private_write(self.package/'package.json',json.dumps(self.declaration))
 def registry_for(self,bindings):
  self.declaration['capabilities']=bindings;self.save();return Registry(Packages([str(self.package)]),self.root/'other',private_write,validate)
 def test_all_page_types_and_public_profiles_match_only_declared_host_and_path(self):
  for page in ('magic','overview','positions','pages','competitors','domain','new_improved'):self.assertEqual(recognize(self.packages.tools,'https://seo.example.test/'+page+'/?q=sample')['page'],page)
  self.assertEqual(recognize(self.packages.tools,'https://www.google.com/search?q=sample')['page'],'serp');self.assertEqual(recognize(self.packages.tools,'https://trends.google.com/trends/explore?q=sample')['page'],'explore');self.assertIsNone(recognize(self.packages.tools,'https://seo.example.test.attacker.test/magic/'))
 def test_headers_map_raw_numbers_links_and_missing_values_without_zero(self):
  table={'headers':['关键词','Volume','KD','URL'],'rows':[[{'text':'sample'},{'text':'12.1K'},{'text':'—'},{'text':'Tool','links':['https://site.example.test/tool']}]]};rows=map_table(table,self.tool['pages'][0]['columns'],'fixture')
  self.assertEqual(rows[0]['vol'],12100);self.assertNotIn('kd',rows[0]);self.assertEqual(rows[0]['url'],'https://site.example.test/tool');self.assertEqual(rows[0]['field_sources']['vol'],'fixture')
 def test_seven_contextual_workflows_and_feedback_ranking_store_no_page_content(self):
  context={'url':'https://seo.example.test/magic/?q=sample','browser':'edge'};rows=self.registry.recommendations(context,'sample tool');self.assertEqual({row['id'] for row in rows},{'leaders','small_sites','page_family','keyword_gap','intent_split','season_window','pool_links'});self.assertTrue(all(row['available'] for row in rows))
  self.registry.record('example-seo-tool','magic','pool_links','clicked');self.registry.record('example-seo-tool','magic','leaders','ignored');self.assertEqual(self.registry.recommendations(context,'different phrase')[0]['id'],'pool_links');memory=self.registry.path.read_text();self.assertNotIn('different phrase',memory);self.assertNotIn('sample tool',memory)
 def test_workflow_selects_measured_traffic_leaders_and_one_model_turn(self):
  models=[]
  def model(payload,stop):models.append(payload);return {'verdict':'按任务意图区分','notes':[{'key':row['keyword'],'intent_tool':1,'excluded':0,'group':'fixture','reason':'Synthetic intent'} for row in payload['records']]}
  result,stopped=Workflows(self.registry).run('job','leaders','sample',{'url':'https://seo.example.test/magic/','language':'zh'},self.root/'work',model)
  self.assertFalse(stopped);self.assertEqual(len(models),1);self.assertTrue(result['records']);self.assertTrue(all(row['tier']=='fixture-tier' for row in result['records']));selected=json.loads((self.root/'work/leaders.json').read_text())['records'];self.assertEqual([row['domain'] for row in selected],['site5.example.test','site4.example.test','site3.example.test'])
  calls=[json.loads(line) for line in self.log.read_text().splitlines()];self.assertEqual(sum(call['capability']=='serp.top' for call in calls),2);self.assertEqual(sum(call['capability']=='domain.keywords' for call in calls),3);self.assertEqual(sum(call['capability']=='keyword.judge' for call in calls),1)
  self.assertTrue(all(row['metric_quality']['kd']=='exact' for row in models[0]['records']));self.assertTrue(all(len(row['serp_json'])==10 for row in models[0]['records']))
 def test_stop_persists_completed_steps_and_does_not_start_more_commands(self):
  progress=[]
  def update(event):
   progress.append(event)
   if event.get('completed_steps')==1:self.registry.stop('job')
  result,stopped=Workflows(self.registry).run('job','leaders','sample',{'language':'en'},self.root/'stopped',progress=update)
  self.assertTrue(stopped);self.assertEqual(len(result['steps']),1);self.assertTrue((self.root/'stopped/serp.json').exists());self.assertTrue((self.root/'stopped/result.json').exists());self.assertEqual(len(self.log.read_text().splitlines()),1)
 def test_command_nonzero_disables_shared_source_and_falls_back_without_retry(self):
  first={'id':'empty-balance','type':'command','argv':[sys.executable,'-c','raise SystemExit(3)'],'serial_group':'one-source','stop_codes':[3],'priority':1};second={'id':'fallback','type':'command','argv':[sys.executable,str(ROOT/'tests/copilot/fake-capability.py'),'keyword.expand',str(self.log)],'priority':2}
  registry=self.registry_for({'keyword.expand':[first,second]});result=registry.execute('keyword.expand',{'keyword':'sample'},self.root/'fallback',threading.Event());self.assertTrue(result['records']);self.assertTrue(registry.disabled(first));self.assertEqual(registry.memory['disabled']['one-source']['reason'],'provider_exit');registry.execute('keyword.expand',{'keyword':'sample'},self.root/'again',threading.Event());self.assertEqual(len(self.log.read_text().splitlines()),2)
 def test_browser_stop_conditions_pause_tool_for_day_and_use_next_source(self):
  for condition in ('login','captcha','quota','rate_limit'):
   first={'id':'browser-'+condition,'type':'browser','tool':'example-seo-tool','page':'magic','link':'report','verified':True,'serial_group':'source-'+condition,'priority':1};fallback={'id':'fallback-'+condition,'type':'command','argv':[sys.executable,str(ROOT/'tests/copilot/fake-capability.py'),'keyword.expand'],'priority':2};registry=self.registry_for({'keyword.expand':[first,fallback]});registry.health[first['id']]={'status':'available'};calls=[];registry.browser=lambda *args:(calls.append(condition) or {'records':[],'source':'fixture','blocked':condition});result=registry.execute('keyword.expand',{'keyword':'sample'},self.root/condition,threading.Event());self.assertEqual(calls,[condition]);self.assertTrue(result['records']);self.assertTrue(registry.disabled(first))
 def test_file_lock_serializes_two_registry_instances(self):
  binding={'id':'lane','type':'command','argv':[sys.executable,'-c','import time,json;time.sleep(.1);print(json.dumps({"records":[{"keyword":"sample"}],"source":"fixture"}))'],'serial_group':'one-account'};one=self.registry_for({'keyword.expand':[binding]});two=Registry(one.packages,one.directory,private_write,validate);times=[]
  def work(registry,index):
   registry.execute('keyword.expand',{'keyword':'sample'},self.root/str(index),threading.Event(),progress=lambda _:times.append(time.monotonic()))
  threads=[threading.Thread(target=work,args=(registry,index)) for index,registry in enumerate((one,two))];[thread.start() for thread in threads];[thread.join() for thread in threads];self.assertEqual(len(times),2);self.assertGreaterEqual(abs(times[0]-times[1]),.09)
 def test_exact_metrics_supersede_candidates_and_batch_limit_is_enforced(self):
  candidate={'id':'candidate','type':'command','argv':[sys.executable,str(ROOT/'tests/copilot/fake-capability.py'),'keyword.metrics',str(self.log)],'priority':1,'batch_limit':2,'exact':False};exact={**candidate,'id':'exact','priority':2,'exact':True};registry=self.registry_for({'keyword.metrics':[candidate,exact]});result=registry.execute('keyword.metrics',{'keywords':['one','two','three']},self.root/'batch',threading.Event());self.assertEqual(len(result['records']),3);self.assertTrue(all(row['metric_quality']['kd']=='exact' for row in result['records']));calls=[json.loads(line) for line in self.log.read_text().splitlines()];self.assertEqual([len(call['input']['keywords']) for call in calls],[2,1,2,1])
 def test_command_placeholders_cannot_turn_input_into_options_or_code(self):
  binding={'id':'argv','type':'command','argv':[sys.executable,str(ROOT/'tests/copilot/fake-capability.py'),'keyword.expand','{keyword}']};registry=self.registry_for({'keyword.expand':[binding]});result=registry.execute('keyword.expand',{'keyword':'--output=/tmp/not-written'},self.root/'bad',threading.Event());self.assertFalse(result['records']);self.assertFalse((self.root/'bad/argv/0/stdout').exists())
 def test_discovery_reads_frontmatter_only_and_health_never_runs_commands(self):
  root=self.root/'skills/example';root.mkdir(parents=True);(root/'SKILL.md').write_text('---\nname: example\ndescription: keyword research\ncapabilities: [keyword.metrics]\n---\nBODY_SECRET_DO_NOT_READ\n');candidates=discover([root.parent]);self.assertEqual(candidates[0]['capabilities'],['keyword.metrics']);self.assertNotIn('BODY_SECRET',json.dumps(candidates));self.assertEqual(self.registry.inspect()['keyword.metrics']['status'],'available');self.assertFalse(self.log.exists())
 def test_profile_draft_is_not_saved_until_explicit_confirm_and_policies_reload(self):
  data=self.root/'app';setup(data);module=Copilot(data)
  try:
   module.request('browser','tool_learn_context',{'url':'https://new.example.test/report?q=secret','title':'New report','tables':[{'headers':['Keyword','Volume'],'rows':3}]});profile={'id':'new-tool','hosts':['new.example.test'],'name':{'zh':'新工具','en':'New tool'},'links':{},'pages':[{'id':'report','paths':['^/report$'],'columns':{'keyword':['Keyword']},'actions':[],'flows':[]}]}
   with patch.object(module,'_draft_profile',return_value=profile):draft=module.request('browser','tool_draft',{})
   self.assertFalse((data/'extensions/learned-tools/package.json').exists());module.request('browser','tool_save',{'id':draft['id'],'profile':profile});self.assertTrue((data/'extensions/learned-tools/package.json').exists());self.assertEqual(recognize(module.packages.tools,'https://new.example.test/report')['tool'],'new-tool')
   with self.assertRaises(ValueError):module.request('browser','tool_save',{'id':draft['id'],'profile':profile})
  finally:module.close()
 def test_resource_grant_is_instance_group_and_lifetime_scoped(self):
  data=self.root/'resource';setup(data);module=Copilot(data)
  try:
   module.packages.tools.append(self.tool);module.packages.bindings['keyword.metrics']=[{'id':'protected','type':'browser','tool':'example-seo-tool','page':'magic','link':'report','serial_group':'one-account'}]
   self.assertFalse(module.resource_allowed('browser','https://seo.example.test/magic/'));module.browser_fetches['nonce']={'instance':'browser','epoch':0,'resource':'one-account'};module.resource_tasks['owned']='nonce';self.assertTrue(module.resource_allowed('browser','https://seo.example.test/magic/',task_id='owned'));self.assertFalse(module.resource_allowed('other','https://seo.example.test/magic/',task_id='owned'));module.browser_fetches.clear();self.assertFalse(module.resource_allowed('browser','https://seo.example.test/magic/',task_id='owned'))
  finally:module.close()
 def test_end_to_end_workflow_and_real_fake_model_draft_use_isolated_one_turn(self):
  data=self.root/'e2e';setup(data);config={'extension_dirs':[str(self.package)],'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'skill_roots':[str(self.root/'empty-skills')],'timeout_seconds':3};private_write(data/'config.json',json.dumps(config));module=Copilot(data,debounce=.01)
  def wait(check):
   until=time.monotonic()+6
   while time.monotonic()<until:
    if check():return
    time.sleep(.01)
   self.fail('e2e timed out')
  try:
   module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready']);module.request('browser','page_context',{'url':'https://seo.example.test/magic/?q=sample','incognito':False});module.request('browser','quick_task',{'action':'workflow.run','params':{'flow':'leaders','object':'sample'}});row=next(row for row in module._state('browser')['suggestions'].values() if row['action']=='workflow.run');wait(lambda:row['status'] in {'completed','failed'});self.assertEqual(row['status'],'completed');self.assertTrue(row['result']['records']);self.assertEqual(row['result']['metrics'][2]['value'],'1');self.assertGreater(row['tokens'],0);self.assertTrue(Path(row['report']).exists())
   module.request('browser','tool_learn_context',{'url':'https://learn.example.test/report','title':'Report','tables':[{'headers':['Keyword','Volume'],'rows':3}]});draft=module.request('browser','tool_draft',{});self.assertEqual(draft['status'],'draft_not_saved');self.assertFalse((data/'extensions/learned-tools/package.json').exists());module.request('browser','tool_save',{'id':draft['id'],'profile':draft['profile']});self.assertTrue((data/'extensions/learned-tools/package.json').exists())
   prompts=[json.loads(line) for line in (data/'exec-acp-requests.jsonl').read_text().splitlines()];model_prompts=[item for item in prompts if item.get('method')=='session/prompt' and item['params']['prompt'][0]['text'].startswith('{')];self.assertEqual(len(model_prompts),2)
  finally:module.close()
 def test_chunked_browser_results_preserve_unicode_and_reject_wrong_order(self):
  data=self.root/'chunks';setup(data);module=Copilot(data);pending={'instance':'browser','epoch':0,'event':threading.Event(),'readonly':False};module.browser_fetches['fetch']=pending
  try:
   with self.assertRaises(ValueError):module.request('browser','browser_fetch_chunk',{'id':'fetch','index':1,'text':'bad'})
   payload=json.dumps({'records':[{'keyword':'工具词'}]*2000,'source':'fixture'},ensure_ascii=False)
   for index,start in enumerate(range(0,len(payload),1000)):self.assertTrue(module.request('browser','browser_fetch_chunk',{'id':'fetch','index':index,'text':payload[start:start+1000]})['accepted'])
   module.request('browser','browser_fetch_result',{'id':'fetch','data':{'chunked':True}});self.assertTrue(pending['event'].is_set());self.assertEqual(len(pending['data']['records']),2000)
  finally:module.close()
 def test_hermes_fallback_requires_oneshot_and_uses_scoped_resource_token(self):
  data=self.root/'agent';setup(data);private_write(data/'config.json',json.dumps({'exec_transport':'oneshot'}));module=Copilot(data);row={'id':'row','model':'fixture','usage':{},'tokens':0,'status':'completed'};module._state('browser')['suggestions']['row']=row
  try:
   binding={'id':'agent','type':'hermes','serial_group':'one-account','max_turns':2};self.assertEqual(module.registry.structural(binding,{'hermes':False}),'needs_explicit_fallback');captured=[]
   def run(key,args,path,*pos,**kwargs):
    token=kwargs['env_extra']['FAST_BROWSER_COPILOT_RESOURCE_TOKEN'];captured.append(token);self.assertIn(token,module.browser_fetches);module.resource_tasks['owned']=token
    return {'records':[{'keyword':'sample','vol':999,'kd':1}],'source':'claimed source'},{'model':'fixture','tokens':5,'usage':{'input':3,'cache_read':0,'output':2},'source':'fixture.usage'}
   module.resource_status=lambda _:True
   with patch.object(module.executions,'run',side_effect=run):result=module._cap_hermes(binding,{'keyword':'sample'},self.root,threading.Event(),{'instance':'browser','epoch':0,'job_key':'browser:row','row_id':'row','capability':'keyword.expand','language':'en'})
   self.assertNotIn('vol',result['records'][0]);self.assertNotIn('kd',result['records'][0]);self.assertEqual(result['records'][0]['measurement'],'agent_unverified');self.assertFalse(module.browser_fetches);self.assertFalse(module.resource_tasks);self.assertEqual(row['tokens'],5)
  finally:module.close()
 def test_initializer_copies_only_declared_assets_with_private_modes_and_no_overwrite(self):
  script=ROOT/'scripts/setup-copilot-package.py';spec=importlib.util.spec_from_file_location('setup_package_test',script);initializer=importlib.util.module_from_spec(spec);spec.loader.exec_module(initializer);source=self.root/'source';source.mkdir();private_write(source/'adapter.py','print("fixture")\n');private_write(source/'package.json',json.dumps({'id':'fixture-assets','version':1,'files':['adapter.py']}));destination=self.root/'destination'
  initializer.setup(source/'package.json',destination,False,True);self.assertFalse(destination.exists());initializer.setup(source/'package.json',destination,True,True);self.assertEqual((destination/'adapter.py').read_text(),'print("fixture")\n');self.assertEqual((destination/'adapter.py').stat().st_mode&0o777,0o600)
  with self.assertRaises(ValueError):initializer.setup(source/'package.json',destination,True,True)
 def test_grading_input_drops_nonexact_metrics_and_model_cannot_overwrite_known_exclusions(self):
  flow={'name':{'zh':'test','en':'test'},'steps':[{'id':'expand','capability':'keyword.expand','input':{'keyword':'$input.object'}},{'id':'intent','model':True,'from':'$steps.expand.records'},{'id':'judge','capability':'keyword.judge','input':{'records':'$steps.intent.records'}}],'result':'$steps.judge.records'};self.packages.flows['fixture']=flow;original=self.registry.execute;seen=[]
  def execute(capability,inputs,*args,**kwargs):
   if capability=='keyword.expand':return {'records':[{'keyword':'sample','vol':999,'kd':1,'excluded':1,'metric_quality':{'vol':'candidate','kd':'candidate'}}],'source':'fixture'}
   if capability=='keyword.judge':seen.append(inputs);return {'records':inputs['records'],'source':'fixture judge'}
   return original(capability,inputs,*args,**kwargs)
  with patch.object(self.registry,'execute',side_effect=execute):result,_=Workflows(self.registry).run('job','fixture','sample',{'language':'en'},self.root/'guarded',lambda *_:{'verdict':'intent only','notes':[{'key':'sample','excluded':0,'intent_tool':1}]})
  self.assertNotIn('vol',seen[0]['records'][0]);self.assertNotIn('kd',seen[0]['records'][0]);self.assertEqual(seen[0]['records'][0]['excluded'],1)
 def test_reviewed_pool_terms_are_not_measured_again(self):
  original=self.registry.execute
  def execute(capability,inputs,*args,**kwargs):
   if capability=='pool.lookup':return {'records':[{**row,'already_checked':True,'tier':'prior-fixture'} for row in inputs.get('records',[])],'source':'readonly fixture'}
   return original(capability,inputs,*args,**kwargs)
  models=[]
  with patch.object(self.registry,'execute',side_effect=execute):result,_=Workflows(self.registry).run('job','leaders','sample',{'language':'en'},self.root/'reused',lambda *args:models.append(args))
  calls=[json.loads(line) for line in self.log.read_text().splitlines()];self.assertFalse(any(call['capability']=='keyword.metrics' for call in calls));self.assertFalse(models);self.assertTrue((self.root/'reused/pool_seen.json').exists())
 def test_large_input_and_a_command_ignoring_stdin_can_be_stopped(self):
  marker=self.root/'started';code='import pathlib,time;pathlib.Path('+repr(str(marker))+').write_text("ready");time.sleep(30)';binding={'id':'ignores-input','type':'command','argv':[sys.executable,'-c',code]};registry=self.registry_for({'keyword.filter':[binding]});stop=threading.Event();failures=[]
  def run():
   try:registry.execute('keyword.filter',{'records':[{'keyword':'x'*1900} for _ in range(1000)]},self.root/'large',stop)
   except ValueError:failures.append('stopped')
  thread=threading.Thread(target=run);thread.start();deadline=time.monotonic()+3
  while not marker.exists() and time.monotonic()<deadline:time.sleep(.01)
  self.assertTrue(marker.exists());stop.set();thread.join(1);self.assertFalse(thread.is_alive());self.assertEqual(failures,['stopped'])
 def test_basic_template_fetches_use_the_same_local_capability_binding(self):
  data=self.root/'basic';setup(data);private_write(data/'config.json',json.dumps({'extension_dirs':[str(self.package)]}));module=Copilot(data)
  try:
   row={'id':'basic','page_context':{}};schema=module.templates.get('seo.keyword_check')['fetch'][0]['output_schema'];result=module._standard_fetch('browser',row,'keyword_metrics',{'keyword':'sample'},schema,self.root/'base',lambda _:None);validate(result,schema);self.assertEqual(result['keywords'][0]['vol'],123);self.assertEqual(result['keywords'][0]['field_sources']['kd'],'synthetic keyword.metrics')
  finally:module.close()
 def test_serial_lane_is_shared_across_independent_processes(self):
  import subprocess
  binding={'id':'process-lane','type':'command','argv':[sys.executable,'-c','import json,time;time.sleep(.15);print(json.dumps({"records":[{"keyword":"sample"}],"source":"fixture"}))'],'serial_group':'shared-account'};registry=self.registry_for({'keyword.expand':[binding]});worker=self.root/'worker.py';events=self.root/'events.txt'
  worker.write_text('import sys,time,threading\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom copilot import private_write,validate\nfrom copilot_packages import Packages\nfrom copilot_capabilities import Registry\nr=Registry(Packages([sys.argv[2]]),Path(sys.argv[3]),private_write,validate)\ndef progress(event):\n with Path(sys.argv[4]).open("a") as f:f.write(str(time.monotonic())+"\\n")\nr.execute("keyword.expand",{"keyword":"sample"},Path(sys.argv[5]),threading.Event(),progress=progress)\n')
  processes=[subprocess.Popen([sys.executable,str(worker),str(ROOT/'native-bridge'),str(self.package),str(registry.directory),str(events),str(self.root/('process-'+str(index)))],stdout=subprocess.PIPE,stderr=subprocess.PIPE) for index in range(2)]
  try:
   for process in processes:
    _,error=process.communicate(timeout=5);self.assertEqual(process.returncode,0,error.decode())
   times=[float(line) for line in events.read_text().splitlines()];self.assertEqual(len(times),2);self.assertGreaterEqual(abs(times[0]-times[1]),.13)
  finally:
   for process in processes:
    if process.poll() is None:process.kill();process.wait()
 def test_change_and_rising_modes_never_fall_through_to_plain_snapshot_sources(self):
  result=self.registry.execute('domain.keywords',{'domain':'site.example.test','report':'new_improved'},self.root/'mode',threading.Event());self.assertFalse(result['records']);self.assertFalse(self.log.exists());rows=self.registry.recommendations({'url':'https://seo.example.test/positions/?q=site.example.test'},'selected keyword');rising=next(row for row in rows if row['id']=='domain_rising');self.assertFalse(rising['available']);self.assertIn('domain.keywords[new_improved]',rising['missing_capabilities'])
