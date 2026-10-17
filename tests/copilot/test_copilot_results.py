"""R7：结构合同、数字归源、批量/历史与标准库导出。"""
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,validate,private_write
from copilot_setup import setup
from copilot_results import compose,legacy,result_schema,words
from copilot_tables import number,expanded,xlsx_bytes,csv_bytes,export,TableStore


def wait(check):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        if check():return
        time.sleep(.01)
    raise AssertionError('fixture timed out')


class ResultContracts(unittest.TestCase):
    def decision(self,**extra):return {'verdict':'优先测一个明确任务','level':'test','process':['fixture source'],'next':[],**extra}
    def test_each_template_schema_and_deterministic_numeric_merge(self):
        fetched={'data':{'keyword_metrics':{'keywords':[{'keyword':'sample','vol':1240,'kd':18,'cpc':1.3}],'source':'fixture'},'serp_top10':{'results':[{'url':'https://small.test/tool'}],'source':'fixture'}},'missing':[]}
        cases=[('seo.keyword_check',{'keyword':'sample'},self.decision(tier='测一页',intent='工具',reasons=['意图明确'])),('seo.longtail',{'keyword':'sample'},self.decision(groups=[{'name':'用途','intent':'工具','recommended':True,'keywords':[{'keyword':'sample'}]}])),('seo.competitor_keywords',{'url':'https://sample.test'},self.decision(keywords=[{'keyword':'sample','opportunity':True}])),('seo.serp_breakdown',{'url':'https://search.test'},self.decision(judgments=[{'domain':'small.test','page_type':'tool','small_site':True}],gaps=['任务未满足'])),('general.task',{'task':'fixture'},self.decision(bullets=['要点'],links=[],artifacts=[]))]
        for action,params,decision in cases:
            result=compose(action,params,decision,fetched,validate);validate(result,result_schema(action))
            if words(result):self.assertEqual(words(result)[0]['vol'],1240)
            bad={**result,'verdict':'结'*31}
            with self.assertRaises(ValueError):validate(bad,result_schema(action))
        with self.assertRaises(ValueError):compose('seo.keyword_check',{'keyword':'sample'},self.decision(tier='测一页',intent='工具',reasons=[],vol=999999),fetched,validate)
        with self.assertRaises(ValueError):compose('seo.longtail',{'keyword':'sample'},self.decision(groups=[{'name':'假词','intent':'x','recommended':True,'keywords':[{'keyword':'invented'}]}]),fetched,validate)
        local={**self.decision(), 'metrics':[],'missing':[{'field':'written','reason':'无回执'}],'written':None,'skipped':[]};validate(local,result_schema('seo.save_pool'))

    def test_missing_data_and_legacy_group_conversion_preserve_words(self):
        old={'summary':'完成12次查询，JSON校验通过','keywords':[{'keyword':'alpha'},{'keyword':'beta'}],'details':json.dumps({'groups':[{'name':'用途','keywords':['alpha','beta']}]})}
        value=legacy('seo.longtail',old);validate(value,result_schema('seo.longtail'));self.assertEqual([word['keyword'] for word in words(value)],['alpha','beta']);self.assertTrue(value['missing']);self.assertNotIn('JSON',value['verdict'])
        broken=legacy('general.task',{'summary':'旧结果','details':'{not-json'});self.assertIn('bullets',broken)

    def test_batch_is_one_execution_parent_and_replenishment_never_judges(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();setup(root)
            config={'acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-acp.py')],'exec_acp_command':[sys.executable,str(ROOT/'tests/copilot/fake-exec-acp.py')],'fetch_commands':{name:[sys.executable,str(ROOT/'tests/copilot/fake-fetch.py'),name] for name in ['keyword_metrics','serp_top10']},'timeout_seconds':3,'table_export_dir':str(root/'exports')}
            (root/'config.json').write_text(json.dumps(config));module=Copilot(root,debounce=.01)
            try:
                module.request('browser','settings',{'enabled':True});wait(lambda:module.view('browser')['ready'])
                state=module._state('browser');parent={'id':'parent','action':'seo.longtail','params':{'keyword':'sample'},'title':'拆长尾','status':'completed','result':legacy('seo.longtail',{'summary':'候选待核对','keywords':[{'keyword':'sample'},{'keyword':'beta'}]})};state['suggestions']['parent']=parent
                module.request('browser','batch',{'id':'parent','operation':'check','keywords':['sample','beta']})
                child=next(row for row in state['suggestions'].values() if row.get('parent_id')=='parent')
                with patch.object(module,'_pool',return_value=None):wait(lambda:child['status'] in {'completed','failed'})
                self.assertEqual(child['status'],'completed');self.assertEqual(len(child['result']['checks']),2)
                records=lambda:[json.loads(line) for line in (root/'exec-acp-requests.jsonl').read_text().splitlines()]
                self.assertEqual(sum(r.get('method')=='session/new' for r in records()),1)
                before=len(records());parent['report']=str(root/'parent.md');private_write(Path(parent['report']),'fixture')
                module.request('browser','replenish',{'id':'parent'});wait(lambda:parent['result'].get('groups',[{}])[0].get('keywords',[{}])[0].get('vol')==42)
                self.assertEqual(before,len(records()))
                self.assertEqual(parent['row_states']['sample']['tier'],'测一页')
                module.request('browser','clear_read',{});self.assertTrue(state['result_history']);self.assertFalse(any(r['status']=='completed' for r in state['suggestions'].values()))
            finally:module.close()


class SilentTaskBoundaries(unittest.TestCase):
    def test_daemon_only_marks_current_copilot_capability_and_never_claims_user_tabs(self):
        from daemon import BridgeDaemon,ProtocolError
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            daemon=BridgeDaemon(Path(temporary).resolve());daemon.data_dir.mkdir(parents=True);daemon.extensions['edge']={'browser':'edge'}
            daemon.copilot=SimpleNamespace(valid_silent_token=lambda token:token=='proof',silent_token='proof')
            daemon.work_window_mode='current'
            params={'owner':'fixture','title':'fixture','instanceId':'edge','allowedOrigins':['https://example.test']}
            with patch.object(daemon,'_notify_tasks_changed'):
                normal=daemon._create_task(params);self.assertFalse(normal['silent']);self.assertEqual(normal['workWindowMode'],'current')
                quiet=daemon._create_task({**params,'copilotSilentToken':'proof'});self.assertTrue(quiet['silent']);self.assertEqual(quiet['workWindowMode'],'separate');self.assertEqual(quiet['tabIds'],[]);self.assertTrue(quiet['title'].startswith('Fast-browser-link ·'))
                with self.assertRaises(ProtocolError):daemon._create_task({**params,'copilotSilentToken':'forged'})
                with self.assertRaises(ProtocolError):daemon._dispatch_client_impl('shared.create',{**params,'copilotTableExport':True})
            daemon._flush_tasks();self.assertNotIn('copilotSilentToken',(daemon.tasks_path.read_text()))

    def test_local_pool_save_does_not_require_model_activation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();setup(root);config={'pool_command':[sys.executable,'-c','print(\'{"written":1,"skipped":[],"accepted_keywords":["sample"]}\')']}
            (root/'config.json').write_text(json.dumps(config));module=Copilot(root)
            try:
                state=module._state('local');state['suggestions']['parent']={'id':'parent','action':'seo.longtail','params':{'keyword':'sample'},'title':'fixture','status':'completed','result':legacy('seo.longtail',{'summary':'待核对','keywords':[{'keyword':'sample'}]})}
                module.request('local','batch',{'id':'parent','operation':'save','keywords':['sample']})
                child=next(r for r in state['suggestions'].values() if r.get('parent_id')=='parent');wait(lambda:child['status']=='completed');self.assertIsNone(module.runtime);self.assertEqual(child['result']['written'],1);self.assertEqual(child['tokens'],0);self.assertIn('sample',state['pool_words']);self.assertTrue(module.request('local','selection_info',{'text':'sample'})['pool'])
            finally:module.close()


class TableExports(unittest.TestCase):
    def test_number_formats_and_xlsx_csv_roundtrip(self):
        for raw,value in [('12.1K',12100),('1,240',1240),('38%',.38),('2M',2000000),('-1.2',-1.2)]:self.assertAlmostEqual(number(raw),value)
        self.assertIsNone(number('not a number'))
        table={'name':'样例','site':'example.test','headers':['词','量'],'rows':[[{'text':'sample','links':['https://example.test/tool']},{'text':'12.1K'}],[{'text':'=2+2'},{'text':'38%'}]]}
        headers,rows=expanded(table['headers'],table['rows']);book=xlsx_bytes(headers,rows)
        with ZipFile(io.BytesIO(book)) as archive:
            xml=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'));ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            self.assertEqual(xml.find('.//x:c[@r="A2"]/x:is/x:t',ns).text,'sample');self.assertEqual(xml.find('.//x:c[@r="C2"]/x:v',ns).text,'12100.0');self.assertFalse(xml.findall('.//x:f',ns));self.assertIn('xl/workbook.xml',archive.namelist())
        data=csv_bytes(headers,rows);self.assertTrue(data.startswith(b'\xef\xbb\xbf'));loaded=list(csv.reader(io.StringIO(data.decode('utf-8-sig'))));self.assertEqual(loaded[1][1],'12.1K');self.assertEqual(loaded[1][-1],'https://example.test/tool');self.assertEqual(loaded[2][0],"'=2+2")
        with tempfile.TemporaryDirectory() as temporary:self.assertEqual(len(export(table,Path(temporary).resolve())),2)

    def test_upload_ownership_file_ids_and_column_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();store=TableStore(root,{'table_export_dir':str(root/'out')},private_write)
            identity=store.request('a','table_begin',{'name':'表格','site':'site','headers':['词','量']})['id']
            with self.assertRaises(ValueError):store.request('b','table_append',{'id':identity,'rows':[]})
            store.request('a','table_append',{'id':identity,'rows':[[{'text':'sample'},{'text':'100'}]]})
            result=store.request('a','table_finish',{'id':identity,'format':'both','pages':2,'partial':True,'reason':'停止'})
            self.assertEqual(result['pages'],2);self.assertTrue(result['partial']);self.assertTrue(all(Path(file['path']).is_file() for file in result['files']))
            self.assertEqual(store.request('a','table_column',{'id':identity,'column':0})['keywords'],['sample'])
            with patch('subprocess.run') as opened:store.open('a',result['files'][0]['id'],True);self.assertEqual(opened.call_args.args[0][-1],str(root/'out'))
            with self.assertRaises(ValueError):store.open('a','/etc/passwd')

if __name__=='__main__':unittest.main()
