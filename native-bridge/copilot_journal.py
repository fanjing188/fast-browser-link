"""协作事件日志：固定摘要、字段白名单、有界当天持久化及合批通知。"""
from collections import deque
from datetime import date,timedelta
import json
import os
import re
import threading
import time
from copilot_diagnostics import redact
from copilot_diagnostics import stderr_summary

MESSAGES={
 'bridge_warning':('system','浏览器消息过大，已分页发送','Large browser message paginated'),
 'bridge_rejected':('system','浏览器消息超出预算，已拒绝本次交付','Browser message exceeds budget; delivery rejected'),
 'bridge_disconnect':('system','浏览器连接中断','Browser bridge disconnected'),
 'bridge_restored':('system','已自动恢复','Automatically restored'),
 'bridge_recovery_stopped':('system','连续三次连上即断，已停止自动恢复','Automatic recovery stopped after three short connections'),
 'batch_complete':('execution','批量执行回执','Batch receipt'),
 'capture':('capture','采集操作轨迹与页面摘要','Captured activity and page summary'),
 'table':('capture','识别页面表格','Recognized page tables'),
 'inference_send':('inference','发送增量推理','Sent incremental inference'),
 'output_repaired':('inference','模型建议已规范化','Model suggestions normalized'),
 'process_exit':('system','Hermes 进程已退出','Hermes process exited'),
 'inference_recovering':('system','Hermes 推理连接已断开，正在重连','Hermes inference disconnected; reconnecting'),
 'inference_failed':('inference','推理未完成，保留已有建议','Inference failed; existing suggestions retained'),
 'connecting':('system','正在连接协作会话','Connecting Copilot session'),
 'inference_return':('inference','推理返回，更新建议','Inference returned; suggestions updated'),
 'inference_fallback':('inference','模型无建议·已用基础建议','No model suggestions; using basic suggestions'),
 'summary':('inference','摘要上下文','Summarized context'),
 'session':('inference','建立新的推理会话','Started a new inference session'),
 'execute_start':('execution','任务开始','Task started'),
 'execute_step':('execution','执行步骤推进','Execution step progressed'),
 'execute_complete':('execution','任务完成','Task completed'),
 'execute_failed':('execution','任务失败，请查看任务结果','Task failed; inspect its result'),
 'execute_stop':('execution','任务停止','Task stopped'),
 'connected':('system','协作会话已连接','Copilot session connected'),
 'disconnected':('system','协作会话已断开','Copilot session disconnected'),
 'reconnected':('system','协作会话已重新连接','Copilot session reconnected'),
 'configuration':('system','设置已更新，后续调用生效','Settings updated for subsequent calls'),
 'capabilities':('system','本机能力体检完成','Local capability check completed'),
 'idle':('system','空闲已暂停，继续浏览可恢复','Paused while idle; browse to resume'),
 'template_disabled':('system','模板无效，已跳过','Invalid template skipped'),
 'startup_failed':('system','协作会话启动失败','Copilot session failed to start'),
 'error':('system','协作请求未完成','Copilot request did not complete')}
NUMBERS={'snapshot_bytes','increment_bytes','estimated_tokens','duration_ms','input','cache_read','output','tokens','added','updated','removed','steps','items','tables','rows','page','batch','available','missing','total','waiting','repairs','step_index','count','repeats','context_tokens','skipped','failed','batch'}
IDENTIFIERS={'task_id','action','provider','capability','phase','model','error_type','cause_type'}
CHANGES={'inference_model','exec_model','max_parallel','context_limit','mode','turn_multiplier','exec_transport','show_ball','selection_popup','enabled'}
REASONS={'model_output_invalid','acp_disconnected','acp_timeout','acp_process_exited','internal_error','execution_error','user_closed','idle_closed','daemon_closed','transport_error','invalid_template','hermes_command_missing','hermes_profile_missing','inference_start_failed','execution_start_failed','invalid_configuration','execution_or_persistence_failed','inference_failed','acp_start_blocked','execution_acp_start_blocked','execution_acp_restart_exhausted','event_log_write_failed'}
KINDS={'navigate','click','selection','dwell','snapshot','table'}


def safe_details(values):
    # 中文注释：不靠删除敏感键来“清洗”任意正文；仅保存主动提取的统计及标识，不递归复制来源对象。
    result={}
    if not isinstance(values,dict):return result
    for key,value in values.items():
        if key=='bridge_error' and isinstance(value,str):result[key]=redact(value)[:300]
        elif key=='disconnected_at' and type(value) in (int,float) and 0<=value<=10**15:result[key]=value
        elif key=='completion_status' and isinstance(value,str) and value in {'completed','partial','failed'}:result[key]=value
        elif key=='exit_code' and type(value) is int and -65536<=value<=65536:result[key]=value
        elif key=='stderr_tail' and isinstance(value,list):result[key]=stderr_summary(value)
        elif key=='field' and isinstance(value,str) and value in {'json','suggestions','summary','params','result','ready'}:result[key]=value
        elif key=='detail' and (values.get('reason')=='execution_error' or values.get('error_type')=='ExecutionError') and isinstance(value,str):result[key]=redact(value)[:300]
        elif key=='step_name' and isinstance(value,str):result[key]=redact(value)[:80]
        elif key=='detail' and isinstance(value,str) and value in {'invalid_json','non_finite_number','object_required','scene_and_array_required','invalid_text','schema_mismatch','not_ready'}:result[key]=value
        elif key=='fields' and isinstance(value,list):result[key]=[field for field in value if field in {'title','why','id','suggestions','extra_fields','params','action','row'}]
        elif key=='capability_statuses' and isinstance(value,dict):result[key]={name:status for name,status in value.items() if re.fullmatch(r'[a-z][a-z0-9._]{0,80}',name) and status in {'available','waiting','missing'}}
        elif key in {'estimated','close_requested','slow','automatic'} and type(value) is bool:result[key]=value
        elif key=='reason' and isinstance(value,str) and value in REASONS:result[key]=value
        elif key in NUMBERS and type(value) in (int,float) and 0<=value<=10**18:result[key]=value
        elif key in IDENTIFIERS and isinstance(value,str) and len(value)<=256 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+~ -]*',value) and '://' not in value and not re.search(r'(?i)(?:bearer|cookie|secret|sk[-_])',value):result[key]=value
        elif key=='changes' and isinstance(value,list):result[key]=[item for item in value if isinstance(item,str) and item in CHANGES]
        elif key=='kinds' and isinstance(value,list):result[key]=[item for item in value if isinstance(item,str) and item in KINDS]
    return result


class Journal:
    def __init__(self,directory,write,notify,*,interval=.2,limit=2000):
        self.directory=directory/'logs';self.write=write;self.notify=notify;self.interval=interval;self.limit=limit
        self.lock=threading.RLock();self.rows=deque(maxlen=limit);self.revision=int(time.time()*1000000);self.error=None;self.pending={};self.resets=set();self.closed=False;self.wake=threading.Event();self.day=date.today()
        self._load();self.worker=threading.Thread(target=self._run,daemon=True);self.worker.start()

    def _path(self):return self.directory/(self.day.isoformat()+'.events.jsonl')

    def _load(self):
        path=self._path()
        if any(part.is_symlink() for part in (path,*path.parents)):raise ValueError('log path contains symlink')
        if path.exists():
            if path.stat().st_size>4*1024*1024:raise ValueError('event log exceeds file limit')
            for line in path.read_text().splitlines()[-self.limit:]:
                try:
                    row=json.loads(line)
                    if not isinstance(row,dict):continue
                    if row.get('event') not in MESSAGES or not isinstance(row.get('instance'),str) or type(row.get('id')) is not int:continue
                    row=self._row(row['instance'],row['event'],row['id'],row.get('time',time.time()),row.get('details',{}),row.get('error') is True)
                    self.rows.append(row);self.revision=max(self.revision,row['id'])
                except (ValueError,TypeError,KeyError):continue

    def _row(self,instance,event,identity,stamp,details,error):
        kind,summary,english=MESSAGES[event]
        if type(stamp) not in (int,float) or not 0<=stamp<=time.time()+86400:stamp=time.time()
        clean=safe_details(details)
        if event=='execute_step':
            names={'keyword.expand':'扩词','keyword.questions':'问题词','keyword.metrics':'关键词指标','keyword.judge':'关键词判断','serp.top':'搜索结果','pool.lookup':'词池查询'}
            operation=names.get(clean.get('capability'),clean.get('step_name') or clean.get('phase') or '执行')
            provider={'unbound':'未绑定','local':'本机','local transform':'本机变换','single model judgment':'模型判断','model':'模型'}.get(clean.get('provider'),clean.get('provider') or '本机')
            summary=f"第 {clean.get('step_index',1)} 步 · {operation} · {provider} · {clean.get('count',0)} 条 / {clean.get('duration_ms',0)/1000:.1f}s"
            english=f"Step {clean.get('step_index',1)} · {clean.get('capability') or clean.get('step_name','execution')} · {clean.get('provider','local')} · {clean.get('count',0)} rows"
        if event=='execute_complete' and clean.get('completion_status')=='partial':summary=f"任务部分完成（缺 {clean.get('missing',0)} 项）";english=f"Task partially completed ({clean.get('missing',0)} gaps)"
        if clean.get('automatic'):summary='自动 · '+summary;english='Automatic · '+english
        if clean.get('repeats',1)>1:summary+=f" ×{clean['repeats']}";english+=f" ×{clean['repeats']}"
        if clean.get('slow'):summary+=' · 慢请求 >5s';english+=' · slow >5s'
        if event=='disconnected':
            reason=safe_details(details).get('reason','transport_error')
            summary+=' · '+{'user_closed':'用户关闭','idle_closed':'空闲关闭','daemon_closed':'服务关闭','acp_process_exited':'进程退出','acp_timeout':'响应超时','transport_error':'传输错误','acp_disconnected':'传输错误'}.get(reason,'启动失败')
            english+=' · '+reason
        if event=='capabilities':
            clean=safe_details(details)
            summary=f"能力 {clean.get('total',0)} 项：可用 {clean.get('available',0)}、需登录/待浏览器确认 {clean.get('waiting',0)}、未绑定 {clean.get('missing',0)}"
            english=f"Capabilities {clean.get('total',0)}: available {clean.get('available',0)}, awaiting login/browser {clean.get('waiting',0)}, unbound {clean.get('missing',0)}"
        return {'id':identity,'instance':instance,'time':stamp,'type':kind,'event':event,'summary':summary,'summary_en':english,'error':bool(error),'details':safe_details(details)}

    def _roll_day(self):
        if self.day==date.today():return
        instances={row['instance'] for row in self.rows};self.day=date.today();self.rows.clear();self.pending.clear();self._load();self.revision+=1;self.resets.update(instances)
        for instance in instances:self.pending[instance]=[]
        self.wake.set()

    def add(self,instance,event,*,error=False,**details):
        if event not in MESSAGES:raise ValueError('unknown log event')
        details=safe_details(details)
        with self.lock:
            if self.closed:return
            self._roll_day()
            self.revision+=1;previous=self.rows[-1] if self.rows else None
            folded=event=='execute_step' and previous and previous['instance']==instance and previous['event']==event and all(previous['details'].get(key)==details.get(key) for key in ('task_id','step_index','capability','provider','step_name','phase'))
            if folded:details={**previous['details'],**details,'repeats':previous['details'].get('repeats',1)+1}
            row=self._row(instance,event,previous['id'] if folded else self.revision,time.time(),details,error)
            if folded:self.rows[-1]=row
            else:self.rows.append(row)
            self.pending.setdefault(instance,[]).append(row)
            self.pending[instance]=self.pending[instance][-self.limit:];self.wake.set()

    def view(self,instance):
        with self.lock:
            self._roll_day()
            return {'entries':[{key:value for key,value in row.items() if key!='instance'} for row in self.rows if row['instance']==instance],'revision':self.revision,'error':self.error}

    def clear(self,instance):
        with self.lock:
            self._roll_day();before=(self.rows,self.revision,dict(self.pending),set(self.resets))
            self.rows=deque((row for row in self.rows if row['instance']!=instance),maxlen=self.limit);self.revision+=1
            self.pending[instance]=[];self.resets.add(instance)
            try:self._persist()
            except (OSError,ValueError):
                self.rows,self.revision,self.pending,self.resets=before;self.error='event_log_write_failed';raise
            self.wake.set();return self.view(instance)

    def export(self,instance):
        value=self.view(instance);return {'jsonl':''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in value['entries']),'count':len(value['entries'])}

    def _persist(self):
        path=self._path()
        if any(part.is_symlink() for part in (path,*path.parents)):raise ValueError('log path contains symlink')
        temporary=path.with_name('.'+path.name+'.tmp')
        self.write(temporary,''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in self.rows));os.replace(temporary,path)
        self.error=None
        for path in self.directory.glob('????-??-??*.jsonl'):
            if path.name[:10]<=(self.day-timedelta(days=7)).isoformat() and not path.is_symlink():path.unlink()

    def flush(self):
        with self.lock:
            if not self.pending:return
            self._persist();pending=self.pending;self.pending={};revision=self.revision;resets=self.resets;self.resets=set()
        for instance,rows in pending.items():
            self.notify(instance,{'entries':[{key:value for key,value in row.items() if key!='instance'} for row in rows],'revision':revision,'reset':instance in resets})

    def _run(self):
        while True:
            self.wake.wait();self.wake.clear()
            if self.closed:break
            # 中文注释：第一条事件后聚合200ms；后续事件不延长窗口，持续流量也能及时显示。
            time.sleep(self.interval)
            try:self.flush()
            except (OSError,ValueError):
                self.error='event_log_write_failed'
                self.notify(None,{'error':'event_log_write_failed'})
        try:self.flush()
        except (OSError,ValueError):self.error='event_log_write_failed'

    def close(self):
        with self.lock:self.closed=True;self.wake.set()
        self.worker.join(timeout=2)
