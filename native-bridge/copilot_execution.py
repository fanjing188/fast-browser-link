"""独立 Hermes 执行子进程；固定 argv、stream-json 和进程组生命周期。"""
from __future__ import annotations
import json
import hashlib
import os
from pathlib import Path
import selectors
import signal
import subprocess
import threading
import time
from copilot_acp import hermes_environment
from copilot_usage import stream_metrics
from copilot_diagnostics import StderrLog,failure


class ExecutionError(RuntimeError):
    pass


class ExecutionTimeout(ExecutionError):
    pass


RERUN_WARNING='从头重跑，可能重复第 1 步；工具回执或额度未知，确认后再执行。'


def retain_tool_receipt(row,event,work,write):
    if not event.get('receipt'):return
    receipt=dict(event['receipt'])
    # 中文注释：每个子进程的调用编号可能从 1 重计，按执行目录隔离，避免覆盖已成功的回执。
    receipt['id']=hashlib.sha256(str(work).encode()).hexdigest()[:16]+':'+receipt['id']
    receipts=row.setdefault('tool_receipts',[])
    existing=next((item for item in receipts if item['id']==receipt['id']),None)
    if existing is None:receipts.append(receipt)
    else:existing.update(receipt)
    row['rerun_warning']=RERUN_WARNING
    write(work/'tool-receipts.json',json.dumps(receipts,ensure_ascii=False))


class StreamJSON:
    def __init__(self):
        self.bytes = 0
        self.result = None
        self.receipts = []

    def feed(self, line):
        self.bytes += len(line)
        if len(line) > 262144 or self.bytes > 2 * 1024 * 1024:
            raise ExecutionError('stream exceeds budget')
        try:
            event = json.loads(line)
        except ValueError as exc:
            raise ExecutionError('invalid stream JSON') from exc
        if not isinstance(event, dict) or self.result is not None:
            raise ExecutionError('invalid stream envelope')
        if event.get('type') == 'result':
            self.result = event
            if event.get('exit_code') != 0 or event.get('error'):
                raise ExecutionError('Hermes reported failure')
        progress={key: event[key] for key in ('type', 'name','model') if key in event}
        if event.get('type')=='tool_use':
            arguments=event.get('input',{})
            receipt={'id':str(event.get('tool_call_id') or len(self.receipts)+1)[:160],
                     'name':str(event.get('name','unknown'))[:160],
                     'arguments':{key:type(value).__name__ for key,value in arguments.items() if isinstance(key,str) and key.isidentifier()} if isinstance(arguments,dict) else {},
                     'status':'unknown','quota_consumed':None}
            self.receipts.append(receipt);progress['receipt']=dict(receipt)
        elif event.get('type')=='tool_result':
            candidates=[receipt for receipt in self.receipts if receipt['status']=='unknown' and (receipt['id']==str(event['tool_call_id']) if event.get('tool_call_id') else receipt['name']==event.get('name'))]
            if len(candidates)==1:
                receipt=candidates[0];receipt['status']='failed' if event.get('is_error') is True else 'succeeded' if event.get('is_error') is False else 'unknown'
                progress['receipt']=dict(receipt)
        return progress

    def finish(self):
        if self.result is None:
            raise ExecutionError('missing terminal result')
        return self.result


def execution_argv(config, template, title, query):
    toolsets = template.get('toolsets')
    if not isinstance(toolsets, list) or not toolsets or any(not isinstance(item, str) or not item or ',' in item or item in {'*', 'all'} for item in toolsets):
        raise ExecutionError('explicit narrow toolsets required')
    limit = min(config['max_turns'], template.get('max_turns', config['max_turns'])*config.get('turn_multiplier',1))
    if type(limit) is not int or limit < 1:
        raise ExecutionError('invalid turn limit')
    args = [config.get('hermes_command', 'hermes'), '-p', config['exec_profile'], 'chat', '-c', title,
            '--create-if-missing', '--query-file', str(query), '--oneshot', '-Q', '--format', 'stream-json',
            '--source', 'copilot', '-t', ','.join(toolsets), '--max-turns', str(limit)]
    if config.get('exec_model'):
        from copilot_models import model_id
        model_id(config['exec_model'])
        args += ['-m', config['exec_model']]
    return args


class Executions:
    def __init__(self, config, directory=None, on_process=lambda _:None):
        self.config = config
        self.directory=directory;self.on_process=on_process
        self.lock = threading.RLock()
        self.jobs = {}
        self.cancelled = set()
        self.closed = False

    @staticmethod
    def _signal(process, value):
        try:
            os.killpg(process.pid, value)
        except ProcessLookupError:
            pass

    def prepare(self,key):
        with self.lock:self.cancelled.discard(key)

    def cancel(self, key):
        with self.lock:
            self.cancelled.add(key)
            job = self.jobs.get(key)
            if job and not job['cancel'].is_set():
                job['cancel'].set()
                if job['process'].poll() is None:
                    self._signal(job['process'], signal.SIGTERM)

    def run(self, key, argv, result_path, progress=lambda _: None, inline=False, env_extra=None):
        started = time.monotonic()
        done, cancelled = threading.Event(), threading.Event()
        process = None
        parser = StreamJSON()
        stderr=StderrLog(self.directory or result_path.parent,'execution')
        selector = selectors.DefaultSelector()
        try:
            with self.lock:
                if self.closed or key in self.cancelled:
                    raise ExecutionError('execution stopped')
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, start_new_session=True,
                                           env=hermes_environment(self.config,env_extra),cwd=result_path.parent)
                self.jobs[key] = {'process': process, 'cancel': cancelled, 'done': done}
            stderr.start(process.stderr)
            selector.register(process.stdout, selectors.EVENT_READ)
            buffer = b''
            eof = False
            while not eof:
                if cancelled.is_set():raise ExecutionError('execution stopped')
                if time.monotonic()-started>self.config['timeout_seconds']:raise ExecutionTimeout('execution timed out')
                for _, _ in selector.select(.1):
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        eof = True
                        break
                    buffer += chunk
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        progress(parser.feed(line))
                    if len(buffer) > 262144:
                        raise ExecutionError('stream line exceeds budget')
            if buffer:
                progress(parser.feed(buffer))
            remaining = max(.1, self.config['timeout_seconds'] - (time.monotonic() - started))
            if process.wait(timeout=remaining) != 0 or cancelled.is_set():
                raise ExecutionError('Hermes exited unsuccessfully')
            event = parser.finish()
            path = Path(result_path)
            if any(part.is_symlink() for part in (path, *path.parents)):
                raise ExecutionError('result path contains symlink')
            if inline:raw=event.get('text','').encode()
            else:
                with path.open('rb') as handle:raw=handle.read(131073)
            if len(raw) > 131072:
                raise ExecutionError('result file exceeds budget')
            result = json.loads(raw)
            metrics=stream_metrics(event,len(raw),time.monotonic()-started)
            return result, metrics
        except (ExecutionError,ValueError,OSError,subprocess.SubprocessError) as exc:
            exc.failure=failure(exc)
            if process and process.poll() not in (None,0):
                exc.failure={'reason':'acp_process_exited','exit_code':process.returncode,'error_type':type(exc).__name__,'stderr_tail':stderr.finish()}
            if parser.result:exc.metrics=stream_metrics(parser.result,seconds=time.monotonic()-started)
            raise
        finally:
            selector.close()
            if process:
                # 中文注释：正常退出由 Hermes 完成工具清理；停止/超时针对仍存活的已创建进程组。
                if process.poll() is None:
                    if not cancelled.is_set():self._signal(process, signal.SIGTERM)
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        self._signal(process, signal.SIGKILL)
                        process.wait()
                process.stdout.close()
                tail=stderr.finish();process.stderr.close()
                self.on_process({'reason':'acp_process_exited','exit_code':process.returncode,'stderr_tail':tail,'phase':'execution'})
            with self.lock:
                self.jobs.pop(key, None)
                self.cancelled.discard(key)
                done.set()

    def close(self):
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.items())
        for key, _ in jobs:
            self.cancel(key)
        for _, job in jobs:
            if not job['done'].wait(2):
                self._signal(job['process'], signal.SIGKILL)
                job['done'].wait(2)
