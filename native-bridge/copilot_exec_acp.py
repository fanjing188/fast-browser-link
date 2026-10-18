"""常驻执行 ACP；新任务新会话，不重放中途失败的任务。"""
import json
import threading
import time
from copilot_acp import ACP,ACPError
from copilot_execution import ExecutionError
from copilot_usage import counts
from copilot_diagnostics import failure


def compact_memory(lines,limit=500):
    selected=[];size=0
    for line in reversed(lines):
        text=' '.join(line.split()).encode()[:100].decode(errors='ignore')
        cost=len(text.encode())+1
        if size+cost>limit:break
        selected.insert(0,text);size+=cost
    return '\n'.join(selected)


class ExecutionTransport(ACP):
    def __init__(self,config,directory,disconnected):
        super().__init__(config,directory,lambda update:disconnected(self) if update.get('sessionUpdate')=='copilot_transport_error' else None)
        self.sessions={}

    def session_update(self,session_id,update):
        with self.lock:
            job=self.sessions.get(session_id)
            if not job:return
            kind=update.get('sessionUpdate')
            if kind=='agent_message_chunk' and update.get('content',{}).get('type')=='text':
                job['text']+=update['content'].get('text','')
                if len(job['text'].encode())>131072:raise ACPError('execution result exceeds budget')
        if kind in {'tool_call','tool_call_update'}:job['progress']({'type':'tool_use','name':update.get('title','')[:160]})

    def permission(self,params):
        # 中文注释：SEO 已改为 daemon 取数，判读会话不需要危险终端或文件授权。未知请求立即拒绝，不悬挂。
        return {'outcome':'cancelled'}


class ACPExecutions:
    BACKOFF=(1,2,4)
    def __init__(self,config,directory,on_error=lambda _:None,on_process=lambda _:None):
        self.on_error=on_error;self.on_process=on_process
        self.config=config;self.directory=directory
        self.lock=threading.RLock();self.start_lock=threading.Lock()
        self.runtime=None;self.closed=False;self.restarts=0;self.stop_event=threading.Event();self.jobs={};self.cancelled=set()

    def start(self):
        with self.start_lock:
            if self.closed:raise ExecutionError('execution ACP closed')
            if self.runtime and not self.runtime.closed and self.runtime.process.poll() is None and not self.runtime.failure:return self.runtime
            while True:
                if self.runtime:
                    if self.restarts>=len(self.BACKOFF):
                        error=ExecutionError('execution ACP restart exhausted');error.failure=failure(error,self.runtime);raise error
                    delay=self.BACKOFF[self.restarts];self.restarts+=1;self.runtime.close()
                    if self.stop_event.wait(delay):raise ExecutionError('execution ACP closed')
                config={**self.config,'inference_profile':self.config['inference_profile'],'stderr_role':'execution'}
                config.pop('acp_command',None)
                if config.get('exec_acp_command'):config['acp_command']=config['exec_acp_command']
                runtime=ExecutionTransport(config,self.directory,self.disconnected)
                self.runtime=runtime
                runtime.exit_observer=self.on_process
                try:
                    runtime.start(initialize_only=True)
                    if self.closed:
                        runtime.close();raise ExecutionError('execution ACP closed')
                    return runtime
                except (ACPError,OSError) as error:
                    runtime.close()
                    if self.restarts>=len(self.BACKOFF):
                        exc=ExecutionError('execution ACP restart exhausted');exc.failure=failure(error,runtime);raise exc from None

    def disconnected(self,runtime):
        if self.closed or runtime is not self.runtime:return
        runtime.failure='disconnected'
        self.on_process({**(runtime.transport_failure or {'reason':'acp_disconnected'}),'phase':'execution'})
        # 中文注释：只重建传输给后续新任务使用；已发出的任务可能有副作用，不自动重放。
        def restart():
            try:self.start()
            except ExecutionError:
                if not self.closed:self.on_error('execution_acp_restart_exhausted')
        threading.Thread(target=restart,daemon=True).start()

    def prepare(self,key):
        with self.lock:self.cancelled.discard(key)

    def cancel(self,key):
        with self.lock:
            self.cancelled.add(key);job=self.jobs.get(key)
        if job:
            try:job['runtime']._send({'jsonrpc':'2.0','method':'session/cancel','params':{'sessionId':job['session']}})
            except ACPError:pass

    def run(self,key,brief,result_path,parse,write,progress=lambda _:None,selected_model=None):
        started=time.monotonic();runtime=self.start();session=None;metrics=None;prompt_sent=False
        with self.lock:
            if self.closed or key in self.cancelled:raise ExecutionError('execution stopped')
        try:
            created=runtime.call('session/new',{'cwd':str(result_path.parent),'mcpServers':[]})
            session=created.get('sessionId')
            if not isinstance(session,str) or not session:raise ExecutionError('execution session missing')
            job={'runtime':runtime,'session':session,'text':'','progress':progress}
            with self.lock:self.jobs[key]=job
            with runtime.lock:runtime.sessions[session]=job
            selected=self.config.get('exec_model') if selected_model is None else selected_model
            model=selected or (created.get('models') or {}).get('currentModelId','')
            if selected:runtime.call('session/set_model',{'sessionId':session,'modelId':model})
            progress({'type':'model','model':model,'source':'acp.session'})
            # 当前 Hermes ACP 不接线会话工具/轮数设置。只在可核实零工具的判读路径调用模型。
            runtime.call('session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'/tools'}]})
            if job['text'].strip()!='No tools available.':raise ExecutionError('ACP 无法按会话限制工具：判断 profile 含工具，请升级受管 copilot profile')
            if brief['action']=='general.task' and brief.get('single_judgment') is not True:raise ExecutionError('当前 Hermes ACP 缺少工具/轮数会话控制，通用任务请明确选择 oneshot 后备')
            with self.lock:
                if key in self.cancelled:raise ExecutionError('execution stopped')
            job['text']=''
            output='Do not use tools. Return strict JSON matching result_schema in English; daemon writes the result. Use supplied evidence only; never invent missing data.' if brief.get('language')=='en' else '不要使用工具。只返回符合 result_schema 的严格 JSON，由 daemon 写 result_json_path。仅判断已提供的数据，缺失数据不得编造。'
            prompt=json.dumps({**brief,'output':output},ensure_ascii=False)
            prompt_sent=True
            response=runtime.call('session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':prompt}]})
            usage=response.get('usage') or {};detailed=all(type(usage.get(k)) is int for k in ('inputTokens','cachedReadTokens','outputTokens'))
            components=counts(max(0,usage['inputTokens']-usage['cachedReadTokens']),usage['cachedReadTokens'],usage['outputTokens']) if detailed else counts(usage.get('totalTokens',(len(prompt.encode())+len(job['text'].encode())+3)//4))
            metrics={'usage':components,'tokens':sum(components.values()),'model':model or 'unknown','estimated':not detailed,'source':'acp.execution.usage' if detailed else 'estimated_execution_usage_split','seconds':time.monotonic()-started}
            with self.lock:
                if key in self.cancelled or response.get('stopReason')!='end_turn':raise ExecutionError('execution stopped')
            result=parse(job['text']);write(result_path,json.dumps(result,ensure_ascii=False));return result,metrics
        except (ACPError,ValueError,OSError,ExecutionError) as error:
            exc=ExecutionError(str(error));exc.failure=failure(error,runtime)
            if metrics:exc.metrics=metrics
            elif prompt_sent:exc.metrics={'usage':counts((len(prompt.encode())+3)//4),'tokens':(len(prompt.encode())+3)//4,'model':model or 'unknown','estimated':True,'source':'estimated_interrupted_execution_input'}
            raise exc from None
        finally:
            if session:
                # /reset 是 Hermes 已查实的本地命令，清空上下文；没有虚构 session/close API。
                if runtime.process.poll() is None and not runtime.failure:
                    try:runtime.call('session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'/reset'}]})
                    except ACPError:pass
                with runtime.lock:runtime.sessions.pop(session,None)
            with self.lock:self.jobs.pop(key,None);self.cancelled.discard(key)

    def close(self):
        self.stop_event.set()
        with self.lock:self.closed=True;keys=list(self.jobs)
        for key in keys:self.cancel(key)
        runtime=self.runtime
        if runtime:runtime.close()
        with self.start_lock:
            if self.runtime and self.runtime is not runtime:self.runtime.close()
