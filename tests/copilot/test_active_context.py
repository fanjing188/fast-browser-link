"""当前页面切换与过期推理回包回归，全程使用临时夹具。"""
import copy
import unittest
from unittest.mock import patch
import test_r24_inference as fixtures


class ActiveContext(unittest.TestCase):
    setUp = fixtures.R24Inference.setUp
    tearDown = fixtures.R24Inference.tearDown

    def row(self, identity, status='pending', **extra):
        return {'id':identity,'title':identity,'why':'fixture','action':'general.task','params':{'task':identity},'status':status,**extra}

    def context(self, url, tab=1):
        return self.app.request('fixture','page_context',{'url':url,'incognito':False,'tab_id':tab})

    def test_raw_query_and_tab_switch_remove_old_suggestions_even_when_held(self):
        self.context('https://example.test/report?q=A')
        self.state['suggestions']={row['id']:row for row in [self.row('automatic'),self.row('tool',tool_aware=True),self.row('manual',explicit=True),self.row('running','executing'),self.row('done','completed',automatic=True)]}
        self.state['held_suggestions']={'automatic','tool'};self.state['selected_object']='A';self.state['selection_text']='A'
        self.context('https://example.test/report?q=B')
        self.assertEqual(set(self.state['suggestions']),{'manual','running','done'})
        self.assertFalse(self.state['suggestions']['done']['automatic'])
        self.assertEqual(self.state['held_suggestions'],set());self.assertEqual(self.state['selected_object'],'');self.assertEqual(self.state['selection_text'],'')
        revision=self.state['context_revision'];self.context('https://example.test/report?q=B');self.assertEqual(self.state['context_revision'],revision)
        self.state['suggestions']['new']=self.row('new');self.context('https://example.test/report?q=B',tab=2)
        self.assertNotIn('new',self.state['suggestions']);self.assertEqual(self.app.view('fixture')['context_revision'],revision+1)

    def test_same_sanitized_url_and_same_dom_still_schedule_the_new_query(self):
        self.context('https://example.test/report?q=A');self.state['enabled']=True
        page={'url':'https://example.test/report','title':'report','items':[]};self.state['page']=copy.deepcopy(page)
        self.context('https://example.test/report?q=B')
        with patch.object(self.app,'_schedule') as schedule:
            self.assertTrue(self.app._observe('fixture',{'trace':[],'page':page})['accepted']);schedule.assert_called_once_with('fixture')

    def test_late_A_inference_cannot_repopulate_B_suggestions(self):
        self.context('https://example.test/a');self.state.update(enabled=True,ready=True,dirty=True,epoch=1,page={'url':'https://example.test/a','title':'A','items':[]});self.app.active='fixture'
        def respond(*args, **kwargs):
            self.context('https://example.test/b')
            self.state['dirty']=True
            return {'scene':'general','suggestions':[{'title':'A','why':'old','action':'general.task','params':{'task':'A'}}]}
        with patch.object(self.app,'_roll_context',return_value=False),patch.object(self.app,'_prompt_json',side_effect=respond),patch.object(self.app,'_schedule') as schedule:
            self.app._infer('fixture',1)
            schedule.assert_called_once_with('fixture')
        self.assertEqual(self.state['suggestions'],{});self.assertEqual(self.state['sent_page'],{});self.assertFalse(self.state['running'])


if __name__=='__main__':unittest.main()
