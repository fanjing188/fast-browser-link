"""插件安装、上下文策略和查询规划器的隔离验收。"""
import copy
import fcntl
import os
import time
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import test_r15 as fixtures
from copilot import Copilot,validate,private_write
from copilot_setup import setup
from copilot_packages import Packages
from copilot_capabilities import Registry,Workflows
from fbl_cli import install_pack,pack_state,init_pack
import fbl_panel
ROOT=Path(__file__).resolve().parents[2]


class PluginLifecycle(unittest.TestCase):
    setUpClass=fixtures.R15.__dict__['setUpClass']
    tearDownClass=fixtures.R15.__dict__['tearDownClass']
    setUp=fixtures.R15.setUp
    tearDown=fixtures.R15.tearDown
    install=fixtures.R15.install

    def test_install_list_execute_scope_remove_and_modified_protection(self):
        self.install();result=install_pack(self.ctx,str(ROOT/'docs/examples/adapter-pack'));target=Path(result['path'])
        packages=Packages([target],include_builtin=False);self.assertIn('材料',packages.experience_for('https://support.example.test/cases?q=invoice'))
        self.assertEqual(packages.experience_for('https://support.example.test/unrelated'),'');self.assertEqual(packages.experience_for('https://other.example.test/cases'),'')
        registry=Registry(packages,self.ctx.copilot,private_write,validate);runner=Workflows(registry)
        output,stopped=runner.run('fixture','support_materials','invoice',{'language':'zh'},self.user/'work')
        self.assertFalse(stopped);self.assertEqual(len(output['records']),1)
        row=next(row for row in pack_state(self.ctx)['plugins'] if row['id']==result['pack']);self.assertTrue(row['can_remove']);self.assertEqual(row['release'],'1.0.0')
        (target/'cases.json').write_text('{}');self.assertFalse(next(row for row in pack_state(self.ctx)['plugins'] if row['id']==result['pack'])['can_remove'])
        with self.assertRaisesRegex(ValueError,'modified'):install_pack(self.ctx,result['pack'],remove=True)
        self.assertTrue(target.exists())

    def test_seasonal_workflow_returns_evidence_rows_instead_of_failing_on_empty_input_records(self):
        packages=Packages();registry=Registry(packages,self.ctx.copilot,private_write,validate)
        series=[{'keyword':'sample','region':region,'period':period,'points':[{'date':'2026-03-01','value':100}]} for region in ('US','WORLD') for period in ('12m','5y')]
        model=lambda *_:{'verdict':'核对历史季节窗口','notes':[{'key':'sample','reason':'seasonal fixture'}]}
        with patch.object(registry,'execute',return_value={'series':series,'source':'synthetic chart tables','missing':[]}):
            result,stopped=Workflows(registry).run('season','season_window','sample',{'language':'zh'},self.user/'season',model)
        self.assertFalse(stopped);self.assertEqual(result['records'][0]['keyword'],'sample');self.assertEqual(result['missing'],[])
        self.assertIn('peak month 3',result['records'][0]['reason']);self.assertEqual(result['process'][-1],'状态：完成')

    def test_stop_waits_for_lifecycle_lock_after_pid_disappears(self):
        self.install()
        from fbl_update import legacy_cli
        cli=legacy_cli(self.ctx);lock=self.ctx.data/'daemon.lock';private_write(lock,'')
        with lock.open('rb') as holder:
            fcntl.flock(holder,fcntl.LOCK_EX|fcntl.LOCK_NB)
            timer=threading.Timer(.25,lambda:fcntl.flock(holder,fcntl.LOCK_UN));timer.start()
            calls=[0]
            def pid(*_):
                calls[0]+=1
                return 123 if calls[0]==1 else None
            started=time.monotonic()
            try:
                with patch.object(cli,'verified_daemon_pid',side_effect=pid),patch.object(cli.os,'kill') as kill:
                    self.assertTrue(cli.stop_daemon(self.ctx.runtime,{},timeout=2));kill.assert_called_once()
                self.assertGreaterEqual(time.monotonic()-started,.2)
            finally:timer.join()

    def test_generated_draft_is_not_loaded_until_explicit_install(self):
        self.install();draft=init_pack(self.ctx,'draft-example',[sys.executable],capability='keyword.expand')
        self.assertEqual(Path(draft['path']).parent,self.ctx.copilot/'drafts')
        self.assertFalse(any(row['id']=='draft-example' for row in pack_state(self.ctx)['plugins']))
        installed=install_pack(self.ctx,draft['path']);self.assertEqual(installed['status'],'installed')
        self.assertTrue(any(row['id']=='draft-example' and row['loaded'] for row in pack_state(self.ctx)['plugins']))

    def test_panel_rejects_active_collaboration_before_installing(self):
        from types import SimpleNamespace
        app=SimpleNamespace(lock=threading.RLock(),states={'fixture':{'enabled':True}},registry=SimpleNamespace(jobs={}),tool_health_running=False)
        with patch.object(fbl_panel,'context',return_value=self.ctx):
            with self.assertRaisesRegex(ValueError,'close collaboration'):fbl_panel.request(app,'fbl_pack_install',{'name':'seo'})
        self.assertFalse((self.ctx.copilot/'packs/seo').exists())

    def test_uninstall_updates_registry_without_removing_unrelated_files(self):
        self.install();result=install_pack(self.ctx,str(ROOT/'docs/examples/adapter-pack'));sentinel=self.ctx.copilot/'keep.txt';sentinel.write_text('user')
        self.assertEqual(install_pack(self.ctx,result['pack'],remove=True)['status'],'removed');self.assertFalse(Path(result['path']).exists());self.assertEqual(sentinel.read_text(),'user')


class URLPlanner(unittest.TestCase):
    def test_health_rechecks_technical_page_failure_but_preserves_quota_stop(self):
        with tempfile.TemporaryDirectory() as temp:
            registry=Registry(Packages(),Path(temp).resolve(),private_write,validate)
            binding=registry.packages.bindings['trends.series'][0]
            registry.disable(binding,'scope_or_page_unavailable');self.assertEqual(registry.structural(binding),'disabled_today')
            registry.probe({},lambda *_:{'ready':True});self.assertFalse(registry.disabled(binding));self.assertEqual(registry.structural(binding),'available')
            registry.disable(binding,'quota')
            def probe(candidate,_):
                self.assertNotEqual(candidate.get('serial_group'),binding.get('serial_group'));return {'ready':True}
            registry.probe({},probe)
            self.assertTrue(registry.disabled(binding));self.assertEqual(registry.structural(binding),'disabled_today')

    def test_query_control_only_accepts_scoped_report_queries(self):
        from copilot_packages import validate_binding
        binding={'id':'query','type':'browser','tool':'fixture','page':'report','link':'report','query_submit':{'root':'#report','names':['分析','Analyze']}}
        validate_binding(binding)
        for query in ({'root':'#report','names':['Export']},{'root':'#report','names':['付款']},{'names':['Search']},{'root':'#report','names':['Search'],'repeat':True}):
            with self.assertRaises(ValueError):validate_binding({**binding,'query_submit':query})

    def test_planner_cannot_change_origin_or_embed_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();setup(root);app=Copilot(root)
            self.addCleanup(app.close)
            script=root/'plan.py';work=root/'work';work.mkdir()
            tool={'id':'planner-fixture','hosts':['report.example.test'],'links':{'report':'https://report.example.test/report?q={keyword}'},'pages':[{'id':'report','paths':['^/report$'],'columns':{}}]};app.packages.tools.append(tool)
            binding={'id':'fixture-plan','type':'browser','tool':'planner-fixture','page':'report','link':'report','plan_argv':[sys.executable,str(script)]}
            context={'instance':'fixture','epoch':0,'url':'https://report.example.test/report'}
            for url in ['https://other.example.test/report','https://user:pass@report.example.test/report','https://report.example.test/report#secret']:
                script.write_text('import json;print(json.dumps({"url":'+repr(url)+'}))')
                with patch.object(app,'_browser_fetch',side_effect=AssertionError('unsafe request')):
                    with self.assertRaisesRegex(ValueError,'origin mismatch'):app._cap_browser(binding,{'keyword':'sample'},work,threading.Event(),context)
