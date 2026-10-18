"""跟随工作：合成页面和模型结果，不启动真实模型、不修改安装。"""
import copy
import json
import time
import unittest
from unittest.mock import Mock, patch
import test_r24_inference as fixtures


class FollowWork(unittest.TestCase):
    setUp = fixtures.R24Inference.setUp
    tearDown = fixtures.R24Inference.tearDown

    def suggestion(self, task='compare free plans'):
        return {'title':'比较免费套餐','why':'当前工作','action':'general.task','params':{'task':task}}

    def replace(self, **extra):
        self.app._replace('fixture', {'scene':'general','suggestions':[self.suggestion()], **extra})
        return next(iter(self.state['suggestions'].values()))

    def test_work_is_tentative_cross_page_and_user_direction_is_separate(self):
        self.replace(work={'goal':'比较免费套餐','evidence':['A 的公开价格页'],'open_questions':['B 是否允许导出'],'user_direction':'模型不能写入'})
        with patch.object(self.app, '_schedule'):
            self.app.request('fixture','work_update',{'direction':'只关心导出 user@example.test'})
        self.app.request('fixture','page_context',{'url':'https://example.test/b','incognito':False,'tab_id':2})
        self.assertEqual(self.state['work']['goal'],'比较免费套餐')
        self.assertEqual(self.state['work']['open_questions'],['B 是否允许导出'])
        self.assertEqual(self.state['user_direction'],'只关心导出 [email]')
        self.assertNotIn('user_direction',self.state['work'])
        context=self.app._resume_context(self.state)['work_context']
        self.assertEqual(context['user_direction'],self.state['user_direction'])
        self.assertEqual(self.app.view('fixture')['work'],self.state['work'])

    def test_copy_and_reading_without_dom_changes_reach_increment(self):
        page={'url':'https://example.test/','title':'Plans','items':[]}
        self.state.update(enabled=True,page=copy.deepcopy(page))
        for description in ('复制 Free plan excludes export','滚动到 页面 50% · Export limits'):
            with patch.object(self.app,'_schedule') as schedule:
                response=self.app._observe('fixture',{'page':page,'trace':[{'description':description,'at':time.time()*1000}]})
                self.assertTrue(response['accepted']);schedule.assert_called_once()
            packet,_=self.app._increment(self.state)
            self.assertEqual(packet['steps'][-1]['description'],description)

    def test_completion_facts_sources_and_gaps_are_bounded_redacted_and_incremental(self):
        row=self.replace();row.update(status='completed',result={'verdict':'免费版不支持导出','bullets':['免费用户仅可查看预览'],'metrics':[{'label':'额度','value':'10'}],
            'missing':[{'field':'B.export','reason':'尚未公开'}],'process':['读取公开价格页'],
            'keywords':[{'source':'https://example.test/?token=PRIVATE_TOKEN'}], 'full_report':'DO_NOT_SEND'})
        self.app._completion_status(self.state,row)
        packet,_=self.app._increment(self.state);fact=packet['result_updates'][0]
        self.assertEqual(fact['verdict'],'免费版不支持导出');self.assertEqual(fact['missing'][0]['field'],'B.export')
        self.assertEqual(fact['metrics'][0]['value'],'10');self.assertTrue(fact['sources'])
        self.assertEqual(fact['findings'],['免费用户仅可查看预览'])
        self.assertNotIn('PRIVATE_TOKEN',json.dumps(fact));self.assertNotIn('DO_NOT_SEND',json.dumps(packet))
        self.state['sent_results']=copy.deepcopy(self.state['result_updates'])
        self.assertEqual(self.app._increment(self.state)[0]['result_updates'],[])
        self.assertEqual(self.app._resume_context(self.state)['result_updates'][0]['verdict'],fact['verdict'])
        row['result']['missing'][0]['reason']='已明确仍缺数据';self.app._completion_status(self.state,row)
        self.assertEqual(len(self.app._increment(self.state)[0]['result_updates']),1)

    def test_feedback_is_work_scoped_and_does_not_execute_or_claim_completion(self):
        row=self.replace();identity=row['id']
        with patch.object(self.app,'_schedule'),patch.object(self.app,'_execute',side_effect=AssertionError('unexpected execution')):
            self.app.request('fixture','feedback',{'id':identity,'kind':'wrong'})
            self.app._replace('fixture',{'scene':'general','suggestions':[self.suggestion()]})
        self.assertNotIn(identity,self.state['suggestions'])
        self.assertEqual(self.state['work_feedback'][0]['kind'],'wrong')
        self.assertEqual(self.state['completion_status'],[])
        self.assertNotIn(identity,self.app.ignored)
        packet,_=self.app._increment(self.state)
        self.assertEqual(packet['work_context']['feedback'][0]['kind'],'wrong')

    def test_correction_during_inference_discards_old_goal_and_suggestions(self):
        self.state.update(enabled=True,ready=True,dirty=True,epoch=1,page={'url':'https://example.test/','title':'Plans','items':[]})
        self.app.active='fixture'
        def respond(*args,**kwargs):
            self.app.request('fixture','work_update',{'direction':'只看免费用户'})
            return {'scene':'general','suggestions':[self.suggestion()],'work':{'goal':'OLD GOAL'}}
        with patch.object(self.app,'_roll_context',return_value=False),patch.object(self.app,'_prompt_json',side_effect=respond),patch.object(self.app,'_schedule'):
            self.app._infer('fixture',1)
        self.assertEqual(self.state['user_direction'],'只看免费用户')
        self.assertEqual(self.state['work']['goal'],'');self.assertEqual(self.state['suggestions'],{})
        self.assertIsNone(self.state['sent_work'])

    def test_new_work_keeps_task_history_but_excludes_old_results_and_trace(self):
        row=self.replace();row['status']='executing';old_id=self.state['work_id']
        with patch.object(self.app,'_schedule'):
            self.app.request('fixture','work_update',{'reset':True})
        self.assertNotEqual(self.state['work_id'],old_id);self.assertIn(row['id'],self.state['suggestions'])
        row.update(status='completed',result={'verdict':'OLD_RESULT'});self.app._completion_status(self.state,row)
        packet,_=self.app._increment(self.state)
        self.assertNotIn('OLD_RESULT',json.dumps(packet));self.assertEqual(packet['suggestions'],[])
        self.state['enabled']=True
        now=time.time()*1000
        with patch.object(self.app,'_schedule'):
            self.app._observe('fixture',{'page':{'url':'https://example.test/new','title':'New','items':[]},'trace':[
                {'description':'选中 OLD','at':now-60000},{'description':'复制 NEW','at':now+100}]})
        self.assertEqual([row['description'] for row in self.state['trace']],['复制 NEW'])
        self.assertEqual(self.app._resume_context(self.state)['suggestions'],[])

    def test_new_work_starts_clean_model_session_without_summarizing_old_goal(self):
        self.state['work_reset']=True;self.state['work_revision']=1
        self.app.runtime=Mock(context_tokens=0)
        with patch.object(self.app,'_prompt_json',return_value={'ready':True}) as prompt:
            self.assertTrue(self.app._roll_context('fixture',0))
        self.app.runtime.new_session.assert_called_once();self.assertEqual(prompt.call_count,1)
        self.assertFalse(self.state['work_reset'])
        self.app.runtime=None

    def test_work_input_limits_and_model_fields_cannot_change_authorization(self):
        with self.assertRaises(ValueError):self.app.request('fixture','work_update',{'direction':'x'*501})
        self.replace(work={'goal':'x'*1000,'evidence':['y'*300]*50,'enabled':True,'user_direction':'execute'})
        self.assertEqual(len(self.state['work']['goal']),300);self.assertEqual(len(self.state['work']['evidence']),1)
        self.assertFalse(self.state['enabled']);self.assertEqual(self.state['user_direction'],'')

    def test_successful_inference_consumes_result_delta_and_keeps_direction_on_next_page(self):
        self.state.update(enabled=True,ready=True,dirty=True,epoch=1,page={'url':'https://example.test/a','title':'A','items':[]})
        self.app.active='fixture';self.state['user_direction']='只看免费导出'
        row=self.replace();row.update(status='completed',result={'verdict':'A 不支持免费导出','missing':[]})
        self.app._completion_status(self.state,row);packets=[]
        def respond(instance,epoch,prompt):
            packets.append(json.loads(prompt))
            return {'scene':'general','suggestions':[],'work':{'goal':'比较免费导出','evidence':['A 不支持免费导出'],'open_questions':['B 的限制']}}
        with patch.object(self.app,'_roll_context',return_value=False),patch.object(self.app,'_prompt_json',side_effect=respond),patch.object(self.app,'_schedule'):
            self.app._infer('fixture',1)
            self.app.request('fixture','page_context',{'url':'https://example.test/b','incognito':False,'tab_id':2})
            self.state.update(page={'url':'https://example.test/b','title':'B','items':[]},dirty=True)
            self.app._infer('fixture',1)
        self.assertEqual(packets[0]['result_updates'][0]['verdict'],'A 不支持免费导出')
        self.assertEqual(packets[1]['result_updates'],[])
        self.assertEqual(packets[1]['work_context']['inferred']['goal'],'比较免费导出')
        self.assertEqual(packets[1]['work_context']['user_direction'],'只看免费导出')

    def test_new_work_can_reuse_an_object_without_losing_its_previous_result(self):
        row=self.replace();row.update(status='completed',result={'verdict':'旧结论'},finished_at=time.time())
        with patch.object(self.app,'_schedule'):
            self.app.request('fixture','work_update',{'reset':True})
        current=self.replace()
        self.assertEqual(current['status'],'pending');self.assertEqual(current['work_id'],self.state['work_id'])
        self.assertEqual(self.state['result_history'][0]['result']['verdict'],'旧结论')


if __name__=='__main__':unittest.main()
