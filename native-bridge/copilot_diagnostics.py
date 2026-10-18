"""协作进程诊断：固定错误分类、有界脱敏 stderr，不保存模型原始输出。"""
from collections import deque
from datetime import date, timedelta
import os
import json
from pathlib import Path
import re
import threading

_LOCK = threading.Lock()


def redact_page(value):
    """模型投影递归脱敏；不修改本机执行参数或压缩诊断文本。"""
    if isinstance(value,dict):
        return {key:'[redacted]' if re.search(r'(?i)token|secret|password|session|api.?key',key) else redact_page(item) for key,item in value.items()}
    if isinstance(value,list):return [redact_page(item) for item in value]
    if not isinstance(value,str):return value
    from urllib.parse import urlsplit,urlunsplit,parse_qsl,urlencode,unquote
    credential=r'(?i)(?:^|[_-])(?:token|key|session|sessionid|auth|secret|password|credential|signature|code)(?:$|[_-])|^(?:apiKey|accessToken|refreshToken|idToken|sessionId)$'
    def url_text(match):
        try:
            url=urlsplit(match.group());netloc=url.netloc.rsplit('@',1)[-1]
            query=[(key,'[redacted]' if re.search(credential,key) else redact_page(unquote(item))) for key,item in parse_qsl(url.query,keep_blank_values=True)]
            return urlunsplit((url.scheme,netloc,redact_page(unquote(url.path)),urlencode(query),''))
        except ValueError:return '[url]'
    value=re.sub(r'https?://[^\s<>"\x27]+',url_text,value)
    value=re.sub(r'(?i)([?&](?:(?:(?:access|refresh|id|api|auth)[_-]?)?(?:token|key)|session(?:_?id)?|auth|secret|password|signature|code)=)[^&\s<>"\x27]+',r'\1[redacted]',value)
    value=re.sub(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}','[email]',value)
    return re.sub(r'\+?\d[\d ().-]{7,}\d',lambda match:'[number]' if sum(char.isdigit() for char in match.group())>=9 else match.group(),value)


def redact(text):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(text))
    if re.search(r'(?i)\b(?:authorization|cookie|password|passwd|secret|token|key|client_secret|secret_key|id_token|(?:api|access|auth|refresh)[_-]?(?:key|token))\b\s*[\"\x27 :=]', text):
        return '[redacted sensitive line]'
    text = re.sub(r'(?i)\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_.-]+|\bAKIA[A-Z0-9]{16}\b', '[redacted]', text)
    text = re.sub(r'(?<![\w])[A-Za-z0-9_+/=-]{24,}(?![\w])', '[redacted]', text)
    text = re.sub(r'https?://[^\s]+', '[url]', text)
    text = re.sub(r'(?:/Users/|/home/)[^\s\"\x27:]+', '[path]', text)
    return ''.join(char for char in text if char=='\t' or ord(char)>=32)[:2048]


def info_noise(line):
    return bool(re.search(r'(?i)\bINFO\b',line) and not re.search(r'(?i)\b(?:WARNING|WARN|ERROR|CRITICAL)\b',line))


def stderr_summary(lines):
    selected=[redact(line) for line in lines if isinstance(line,str) and not info_noise(line)][-20:]
    limit=1024//max(1,len(selected))
    return [line.encode()[:limit].decode(errors='ignore') for line in selected]


class ModelOutputInvalid(ValueError):
    def __init__(self, field, detail):
        super().__init__('invalid model output: '+field+' '+detail)
        self.field, self.detail = field, detail


def failure(error, runtime=None):
    recorded = getattr(error, 'failure', None)
    if isinstance(recorded,dict):
        result=dict(recorded)
        if type(error).__name__=='ExecutionError':result.update(error_type='ExecutionError',cause_type=recorded.get('error_type',''),detail=redact(str(error))[:300])
        return result
    kind = type(error).__name__
    if kind in {'ACPTimeout','ExecutionTimeout','TimeoutExpired'} or isinstance(error, TimeoutError):reason='acp_timeout'
    elif runtime and getattr(runtime, 'transport_failure', None):return dict(runtime.transport_failure)
    elif isinstance(error, (ModelOutputInvalid, json.JSONDecodeError)):reason='model_output_invalid'
    elif kind=='ExecutionError':reason='execution_error'
    elif kind in {'ACPDisconnected','BrokenPipeError'}:reason='acp_disconnected'
    else:reason='internal_error'
    result={'reason':reason, 'error_type':kind}
    if kind=='ExecutionError':result['detail']=redact(str(error))[:300]
    if isinstance(error,ModelOutputInvalid):result.update(field=error.field,detail=error.detail)
    elif kind=='JSONDecodeError':result.update(field='json',detail='invalid_json')
    return result


def failure_message(value, language='zh'):
    zh={'model_output_invalid':'模型返回格式不对，已保留原建议','acp_disconnected':'Hermes 推理连接已断开，正在重连','acp_timeout':'Hermes 响应超时，已保留原建议','acp_process_exited':'Hermes 推理进程已退出，正在重连','internal_error':'协作处理异常，已保留原建议'}
    en={'model_output_invalid':'Invalid model output; previous suggestions retained','acp_disconnected':'Hermes disconnected; reconnecting','acp_timeout':'Hermes timed out; previous suggestions retained','acp_process_exited':'Hermes process exited; reconnecting','internal_error':'Copilot processing failed; previous suggestions retained'}
    return (en if language=='en' else zh).get(value.get('reason'), 'Copilot failed' if language=='en' else '协作处理失败')


class StderrLog:
    def __init__(self, directory, role='inference', *, limit=2*1024*1024, today=date.today):
        self.directory=Path(directory)/'logs';self.role=role if role in {'inference','execution'} else 'inference';self.limit=limit;self.today=today
        self.tail=deque(maxlen=20);self.thread=None;self.error=False

    def append(self, line):
        raw=line.decode(errors='replace') if isinstance(line,bytes) else str(line)
        if info_noise(raw):return
        clean=redact(raw).strip()
        if not clean:return
        self.tail.append(clean)
        data=(self.role+': '+clean+'\n').encode()[:self.limit]
        with _LOCK:
            path=self.directory/(self.today().isoformat()+'.hermes-stderr.log')
            archive=path.with_suffix('.log.1')
            if any(item.is_symlink() for item in (path,archive,*path.parents)):
                raise ValueError('stderr log refuses symlinks')
            self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
            if path.exists() and path.stat().st_size+len(data)>self.limit:os.replace(path,archive)
            fd=os.open(path,os.O_APPEND|os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'ab') as handle:handle.write(data)
            for old in self.directory.glob('????-??-??.hermes-stderr.log*'):
                if old.name[:10]<=(self.today()-timedelta(days=7)).isoformat() and not old.is_symlink():old.unlink()

    def start(self, stream):
        def drain():
            while True:
                try:line=stream.readline(8193)
                except (OSError,ValueError):break
                if not line:break
                try:self.append(line)
                except (OSError,ValueError):self.error=True
        self.thread=threading.Thread(target=drain,daemon=True);self.thread.start()

    def finish(self):
        if self.thread and self.thread is not threading.current_thread():self.thread.join(timeout=1)
        return stderr_summary(self.tail)
