"""确定性取数接口：命令接收 stdin JSON、输出 stdout JSON，不经 shell。"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from copilot_acp import hermes_environment
from urllib.parse import urlencode
from urllib.request import urlopen


class Fetcher:
    def __init__(self,config):
        self.config=config;self.lock=threading.RLock();self.jobs={};self.cancelled=set();self.closed=False

    def prepare(self,key):
        with self.lock:self.cancelled.discard(key)

    def cancel(self,key):
        with self.lock:
            self.cancelled.add(key);process=self.jobs.get(key)
            if process and process.poll() is None:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass

    def run(self,key,template,params,work,validate,progress=lambda _:None,browser_fetch=None,capability_fetch=None,checkpoint=None,save_checkpoint=lambda _:None):
        checkpoint=checkpoint if checkpoint is not None else {}
        data=dict(checkpoint);missing=[]
        def retain(name,value):
            data[name]=value
            # 中文注释：成功调用的回执保留，即使结果缺字段，也不再次消耗同一查询额度。
            if not value.get('blocked') and not value.get('source','').startswith('unavailable'):
                checkpoint[name]=value;save_checkpoint(dict(checkpoint))
        for step in template.get('fetch',[]):
            with self.lock:
                if self.closed or key in self.cancelled:raise ValueError('fetch stopped')
            name=step['script']
            if name in checkpoint:continue
            progress({'type':'fetch','name':name})
            validate(params,step['params_schema'])
            if capability_fetch:
                value=capability_fetch(name,params,step['output_schema'])
                if value is not None:
                    validate(value,step['output_schema']);retain(name,value)
                    if value.get('source','').startswith('unavailable'):missing.append(name+'：本机能力当前不可用')
                    continue
            command=self.config.get('fetch_commands',{}).get(name)
            if command is None and name=='google_suggest':command=[sys.executable,str(Path(__file__).resolve()),'--google-suggest']
            if not command and browser_fetch and name in {'google_trends','serp_top10'}:
                try:
                    value=browser_fetch(name,params);validate(value,step['output_schema']);retain(name,value)
                except (ValueError,OSError,KeyError,TypeError):missing.append(name+'：后台页面未取得数据（遇阻、超时或超出128KiB预算）')
                continue
            if not command:
                missing.append(name+'：未配置数据源');continue
            if not isinstance(command,list) or not command or any(not isinstance(arg,str) or not arg for arg in command):raise ValueError('fetch command must be argv')
            command=list(command)
            if not Path(command[0]).is_absolute() and self.config.get('fetch_dir'):command[0]=str(Path(self.config['fetch_dir']).expanduser()/command[0])
            process=None
            try:
                with self.lock:
                    if self.closed or key in self.cancelled:raise ValueError('fetch stopped')
                    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=work,start_new_session=True,env=hermes_environment(self.config))
                    self.jobs[key]=process
                output,_=process.communicate(json.dumps(params,ensure_ascii=False).encode(),timeout=step['timeout'])
                if process.returncode or len(output)>131072:raise ValueError('fetch failed')
                value=json.loads(output);validate(value,step['output_schema']);retain(name,value)
                if value.get('failed_queries'):missing.append(name+'：部分查询失败（'+str(value['failed_queries'])+'项）')
            except (ValueError,OSError,subprocess.SubprocessError):missing.append(name+'：取数失败或格式不符')
            finally:
                if process and process.poll() is None:
                    try:os.killpg(process.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    process.communicate()
                with self.lock:self.jobs.pop(key,None)
        with self.lock:
            stopped=self.closed or key in self.cancelled;self.cancelled.discard(key)
        if stopped:raise ValueError('fetch stopped')
        if len(json.dumps(data,ensure_ascii=False).encode())>131072:raise ValueError('fetch context exceeds budget')
        return {'data':data,'missing':missing}

    def close(self):
        with self.lock:self.closed=True;keys=list(self.jobs)
        for key in keys:self.cancel(key)


def google_suggest(params):
    seed=params['keyword'].strip();queries=[seed]+[seed+' '+letter for letter in 'abcdefghijklmnopqrstuvwxyz']+[word+' '+seed for word in ['how','what','why','which','best']]
    def fetch(query):
        url='https://suggestqueries.google.com/complete/search?'+urlencode({'client':'firefox','hl':'en','q':query})
        try:
            with urlopen(url,timeout=6) as response:value=json.loads(response.read(131073))
            return [word[:200] for word in value[1] if isinstance(word,str)]
        except (OSError,ValueError,IndexError,TypeError):return None
    with ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(fetch,queries))
    words=list(dict.fromkeys(word for row in rows if row is not None for word in row))[:100]
    if not words:raise ValueError('suggest unavailable')
    return {'keywords':[{'keyword':word} for word in words],'source':'Google Suggest · en','queries':len(queries),'failed_queries':sum(row is None for row in rows)}


if __name__=='__main__':
    if sys.argv[1:]!=['--google-suggest']:raise SystemExit('unsupported fetch entry')
    params=json.loads(sys.stdin.buffer.read(16385))
    print(json.dumps(google_suggest(params),ensure_ascii=False))
