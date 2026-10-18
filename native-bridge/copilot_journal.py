"""协作事件日志：固定摘要、字段白名单、有界当天持久化及合批通知。"""
from collections import deque
from datetime import date,timedelta
import json
import os
import re
import threading
import time

MESSAGES={
 'capture':('capture','采集操作轨迹与页面摘要','Captured activity and page summary'),
 'table':('capture','识别页面表格','Recognized page tables'),
 'inference_send':('inference','发送增量推理','Sent incremental inference'),
 'inference_failed':('inference','推理未完成，保留已有建议','Inference failed; existing suggestions retained'),
 'connecting':('system','正在连接协作会话','Connecting Copilot session'),
 'inference_return':('inference','推理返回，更新建议','Inference returned; suggestions updated'),
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
 'error':('system','协作请求未完成','Copilot request did not complete')}
NUMBERS={'snapshot_bytes','increment_bytes','estimated_tokens','duration_ms','input','cache_read','output','tokens','added','updated','removed','steps','items','tables','rows','page','batch','available','missing'}
IDENTIFIERS={'task_id','action','provider','capability','phase','model'}
CHANGES={'inference_model','exec_model','max_parallel','context_limit','mode','turn_multiplier','exec_transport','show_ball','selection_popup','enabled'}
REASONS={'invalid_configuration','execution_or_persistence_failed','inference_failed','acp_start_blocked','execution_acp_start_blocked','execution_acp_restart_exhausted','event_log_write_failed'}
KINDS={'navigate','click','selection','dwell','snapshot','table'}


def safe_details(values):
    # 中文注释：不靠删除敏感键来“清洗”任意正文；仅保存主动提取的统计及标识，不递归复制来源对象。
    result={}
    if not isinstance(values,dict):return result
    for key,value in values.items():
        if key=='estimated' and type(value) is bool:result[key]=value
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
        return {'id':identity,'instance':instance,'time':stamp,'type':kind,'event':event,'summary':summary,'summary_en':english,'error':bool(error),'details':safe_details(details)}

    def _roll_day(self):
        if self.day==date.today():return
        instances={row['instance'] for row in self.rows};self.day=date.today();self.rows.clear();self.pending.clear();self._load();self.revision+=1;self.resets.update(instances)
        for instance in instances:self.pending[instance]=[]
        self.wake.set()

    def add(self,instance,event,*,error=False,**details):
        if event not in MESSAGES:raise ValueError('unknown log event')
        with self.lock:
            if self.closed:return
            self._roll_day()
            self.revision+=1;row=self._row(instance,event,self.revision,time.time(),details,error);self.rows.append(row)
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
