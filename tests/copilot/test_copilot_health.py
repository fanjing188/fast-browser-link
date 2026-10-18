"""只使用临时结构与替身；禁止启动会话或调用模型。"""
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'native-bridge'))
from copilot_health import health
from copilot import Copilot

class HealthTests(unittest.TestCase):
 def test_zero_model_health_states(self):
  with tempfile.TemporaryDirectory() as temp,patch('subprocess.Popen',side_effect=AssertionError('no process')),patch('copilot_health.shutil.which',return_value='/synthetic/hermes'):
   root=Path(temp);config={'hermes_home':temp,'exec_profile':'copilot-exec'}
   self.assertEqual(health(config,{},None)['state'],'disconnected')
   profile=root/'profiles/copilot-exec';profile.mkdir(parents=True);(profile/'config.yaml').write_text('synthetic')
   self.assertEqual(health(config,{'enabled':True},None)['state'],'connecting')
   runtime=type('Runtime',(),{'closed':False})()
   result=health(config,{'ready':True,'last_call_succeeded':True},runtime)
   self.assertEqual(result['state'],'connected');self.assertEqual(result['execution_check'],'structural_only');self.assertTrue(result['last_call_succeeded'])
   self.assertEqual(health(config,{'ready':True,'last_call_succeeded':False},runtime)['state'],'error')
   self.assertEqual(health(config,{'diagnostic':'synthetic'},runtime)['state'],'error')
   config['exec_profile']='../bad';self.assertFalse(health(config,{},None)['execution_profile_exists'])
 def test_name_and_export_preferences_persist_without_starting_models(self):
  with tempfile.TemporaryDirectory() as temp,patch('subprocess.Popen',side_effect=AssertionError('no process')):
   app=Copilot(Path(temp).resolve())
   try:
    result=app.request('fixture','preferences',{'board_name':'My Agent','table_max_pages':40})
    self.assertEqual(result['board_name'],'My Agent');self.assertEqual(result['table_config']['max_pages'],40)
    with self.assertRaises(ValueError):app.request('fixture','preferences',{'board_name':'bad\nname'})
    self.assertFalse(result['hermes_health']['acp_ready']);self.assertIsNone(result['hermes_health']['last_call_succeeded'])
   finally:app.close()
   app=Copilot(Path(temp).resolve())
   try:self.assertEqual(app.view('fixture')['board_name'],'My Agent')
   finally:app.close()
