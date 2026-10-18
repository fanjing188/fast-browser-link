"""任务日志使用现有进度事件，仅合成数据及临时持久化目录。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,private_write
from copilot_journal import Journal


class TaskProgressLogsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.journal=Journal(Path(self.tmp.name).resolve(),private_write,lambda *_:None)
        self.app=Copilot.__new__(Copilot)
        self.app.journal=self.journal

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def test_regular_tool_progress_is_task_scoped_and_excludes_arguments_and_results(self):
        self.app._journal_event('browser-one','progress',{'id':'one','progress':{
            'type':'tool_use','name':'browser_read','step_index':2,'count':4,'duration_ms':750,
            'argv':['PRIVATE_ARGV'],'arguments':{'value':'PRIVATE_VALUE'},'result':'PRIVATE_BODY',
            'receipt':{'arguments':{'cookie':'PRIVATE_COOKIE'}}}})
        self.app._journal_event('browser-two','progress',{'id':'two','progress':{'type':'model','name':'model'}})
        rows=self.journal.view('browser-one')['entries']
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['event'],'execute_step')
        self.assertEqual(rows[0]['details']['task_id'],'one')
        self.assertEqual(rows[0]['details']['step_name'],'browser_read')
        self.assertEqual(rows[0]['details']['count'],4)
        self.assertEqual(rows[0]['details']['duration_ms'],750)
        self.assertNotIn('PRIVATE_',json.dumps(rows))
        self.journal.flush()
        self.assertNotIn('PRIVATE_',self.journal._path().read_text())

    def test_progress_batch_replaces_repeated_step_but_keeps_different_tasks(self):
        for task,count in [('one',1),('one',8),('two',3)]:
            self.app._journal_event('browser-one','progress',{'id':task,'progress':{'type':'tool_use','name':'browser_read','count':count}})
        rows=self.journal.view('browser-one')['entries']
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['details']['task_id'],'one')
        self.assertEqual(rows[0]['details']['count'],8)
        self.assertEqual(rows[0]['details']['repeats'],2)
        self.assertEqual(rows[1]['details']['task_id'],'two')

    def test_different_tools_and_phases_remain_separate_log_records(self):
        for phase,name in [('tool_use','browser_read'),('tool_use','browser_click'),('model','browser_click')]:
            self.app._journal_event('browser-one','progress',{'id':'one','progress':{'type':phase,'name':name}})
        rows=self.journal.view('browser-one')['entries']
        self.assertEqual(len(rows),3)
        self.assertEqual([row['details']['step_name'] for row in rows],['browser_read','browser_click','browser_click'])


if __name__=='__main__':unittest.main()
