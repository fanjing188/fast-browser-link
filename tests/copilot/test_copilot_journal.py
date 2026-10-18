"""R11 日志与旧设置兼容：仅临时目录和合成事件，不运行真实模型/浏览器。"""
from datetime import date,timedelta
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'native-bridge'))
from copilot import Copilot,private_write
from copilot_journal import Journal
from copilot_models import settings
from copilot_setup import setup


class JournalTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.messages=[];self.journal=Journal(self.root,private_write,lambda instance,value:self.messages.append((instance,value)))
 def tearDown(self):self.journal.close();self.tmp.cleanup()
 def test_cap_persistence_scope_and_privacy(self):
  for index in range(2010):self.journal.add('one','capture',snapshot_bytes=index,kinds=['selection'],trace='PAGE_PRIVATE_CANARY',page={'Cookie':'COOKIE_PRIVATE_CANARY'},argv=['AUTH_PRIVATE_CANARY'],input_value='INPUT_PRIVATE_CANARY')
  self.journal.add('two','error',error=True)
  self.journal.flush();value=self.journal.view('one');self.assertEqual(len(value['entries']),1999);self.assertEqual(len(self.journal.rows),2000)
  path=self.root/'logs'/(date.today().isoformat()+'.events.jsonl');raw=path.read_text();self.assertNotIn('PRIVATE_CANARY',raw);self.assertEqual(path.stat().st_mode&0o777,0o600)
  self.journal.close();self.journal=Journal(self.root,private_write,lambda *_:None);self.assertEqual(len(self.journal.view('one')['entries']),1999);self.assertEqual(len(self.journal.view('two')['entries']),1)
 def test_each_event_kind_and_clear_export_are_authoritative(self):
  for event in ('capture','table','inference_send','inference_return','summary','session','execute_start','execute_step','execute_complete','execute_failed','execute_stop','configuration','connected','disconnected','capabilities'):
   self.journal.add('one',event,provider='example-adapter',page=3,tokens=14,error=event=='execute_failed')
  exported=self.journal.export('one');rows=[json.loads(line) for line in exported['jsonl'].splitlines()];self.assertEqual(len(rows),15);self.assertEqual({row['type'] for row in rows},{'capture','inference','execution','system'});self.assertEqual(rows[7]['details']['page'],3);self.assertEqual(rows[9]['error'],True)
  self.journal.add('two','connected');self.journal.clear('one');self.assertEqual(self.journal.export('one')['count'],0);self.assertEqual(len(self.journal.view('two')['entries']),1)
  self.journal.flush();self.assertTrue(any(instance=='one' and value['reset'] for instance,value in self.messages))
 def test_real_batch_window_does_not_notify_per_event(self):
  done=threading.Event();calls=[];self.journal.notify=lambda instance,value:(calls.append(value),done.set())
  started=time.monotonic()
  for index in range(20):self.journal.add('one','execute_step',batch=index)
  self.assertFalse(done.is_set());self.assertTrue(done.wait(1));self.assertGreaterEqual(time.monotonic()-started,.15);self.assertEqual(len(calls),1);self.assertEqual(len(calls[0]['entries']),20)
 def test_retention_removes_only_old_regular_log_files(self):
  self.journal.add('one','connected');self.journal.flush();directory=self.root/'logs';old=directory/((date.today()-timedelta(days=7)).isoformat()+'.jsonl');old.write_text('old')
  keep=directory/((date.today()-timedelta(days=6)).isoformat()+'.jsonl');keep.write_text('keep');self.journal.add('one','capture');self.journal.flush();self.assertFalse(old.exists());self.assertTrue(keep.exists())
 def test_loaded_rows_are_reprojected_not_trusted_as_display_text(self):
  self.journal.close();directory=self.root/'logs';directory.mkdir(exist_ok=True)
  private_write(directory/(date.today().isoformat()+'.events.jsonl'),json.dumps({'id':1,'instance':'one','event':'capture','time':time.time(),'summary':'PAGE_PRIVATE_CANARY','details':{'Authorization':'AUTH_PRIVATE_CANARY','input':4,'cookies':['COOKIE_PRIVATE_CANARY']}})+'\n')
  self.journal=Journal(self.root,private_write,lambda *_:None);raw=json.dumps(self.journal.view('one'));self.assertNotIn('PRIVATE_CANARY',raw);self.assertIn('"input": 4',raw)
 def test_new_day_replaces_view_but_keeps_previous_day_file(self):
  self.journal.add('one','capture');self.journal.flush();old_path=self.journal._path();day=date.today()+timedelta(days=1)
  class Tomorrow(date):
   @classmethod
   def today(cls):return day
  with patch('copilot_journal.date',Tomorrow):
   self.assertEqual(self.journal.view('one')['entries'],[]);self.journal.add('one','connected');self.journal.flush();self.assertTrue(self.messages[-1][1]['reset']);self.assertEqual(len(self.messages[-1][1]['entries']),1);self.assertTrue(self.journal._path().exists())
  self.assertTrue(old_path.exists())
 def test_failed_persistence_keeps_prior_file_and_does_not_acknowledge_clear(self):
  self.journal.add('one','capture');self.journal.flush();before=self.journal._path().read_text()
  def denied(*_):raise OSError('synthetic disk failure')
  self.journal.write=denied
  with self.assertRaises(OSError):self.journal.clear('one')
  self.assertEqual(self.journal._path().read_text(),before);self.assertEqual(len(self.journal.view('one')['entries']),1);self.assertEqual(self.journal.view('one')['error'],'event_log_write_failed');self.journal.write=private_write
 def test_interface_preferences_persist_without_marking_execution_settings_saved(self):
  root=self.root/'preferences';setup(root);app=Copilot(root)
  try:
   app.request('one','settings',{'show_ball':False,'selection_popup':False})
   value=json.loads((root/'config.json').read_text());self.assertFalse(value['show_ball']);self.assertFalse(value['selection_popup']);self.assertFalse(value['settings_saved'])
  finally:app.close()
  app=Copilot(root)
  try:self.assertFalse(app.view('one')['show_ball']);self.assertFalse(app.view('one')['selection_popup'])
  finally:app.close()
 def test_old_keys_are_ignored_and_removed_on_next_save(self):
  root=self.root/'app';setup(root);path=root/'config.json';config=json.loads(path.read_text());config.update(daily_token_budget='obsolete',cache_weight={'obsolete':True});path.write_text(json.dumps(config))
  seen=[];app=Copilot(root,lambda instance,event:seen.append(event))
  try:
   self.assertNotIn('daily_token_budget',app.config);self.assertNotIn('cache_weight',app.config)
   self.assertEqual(settings({'daily_token_budget':-1,'cache_weight':'obsolete'}),{})
   app.request('one','configure',{'context_limit':7000,'daily_token_budget':0,'cache_weight':99});saved=json.loads(path.read_text());self.assertEqual(saved['context_limit'],7000);self.assertNotIn('daily_token_budget',saved);self.assertNotIn('cache_weight',saved)
   with self.assertRaises(ValueError):app.request('one','configure',{'max_parallel':'INPUT_PRIVATE_CANARY'})
   self.assertNotIn('INPUT_PRIVATE_CANARY',json.dumps(app.journal.view('one')))
   app.journal.flush();deadline=time.monotonic()+1
   while not any(event['type']=='logs' for event in seen) and time.monotonic()<deadline:time.sleep(.01)
   event=next(event for event in seen if event['type']=='logs');self.assertLess(event['revision'],event['log_revision'])
   app.request('one','log_client',{'event':'table','tables':2,'rows':7});self.assertTrue(any(row['event']=='table' for row in app.request('one','logs_read',{})['entries']));self.assertEqual(app.request('two','logs_read',{})['entries'],[])
   with self.assertRaises(ValueError):app.request('one','logs_clear',{'path':'outside'})
   self.assertTrue(app.request('one','logs_export',{})['count']);app.request('one','logs_clear',{});self.assertEqual(app.request('one','logs_read',{})['entries'],[])
  finally:app.close()


if __name__=='__main__':unittest.main()
