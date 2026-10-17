"""独立 Hermes 执行子进程；固定 argv、stream-json 和进程组生命周期。"""
from __future__ import annotations
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import threading
import time
from copilot_acp import hermes_environment


class ExecutionError(RuntimeError):
    pass


class StreamJSON:
    def __init__(self):
        self.bytes = 0
        self.result = None

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
        return {key: event[key] for key in ('type', 'name') if key in event}

    def finish(self):
        if self.result is None:
            raise ExecutionError('missing terminal result')
        return self.result


def execution_argv(config, template, title, query):
    toolsets = template.get('toolsets')
    if not isinstance(toolsets, list) or not toolsets or any(not isinstance(item, str) or not item or ',' in item or item in {'*', 'all'} for item in toolsets):
        raise ExecutionError('explicit narrow toolsets required')
    limit = min(config['max_turns'], template.get('max_turns', config['max_turns']))
    if type(limit) is not int or limit < 1:
        raise ExecutionError('invalid turn limit')
    args = [config.get('hermes_command', 'hermes'), '-p', config['exec_profile'], 'chat', '-c', title,
            '--create-if-missing', '--query-file', str(query), '--oneshot', '-Q', '--format', 'stream-json',
            '--source', 'copilot', '-t', ','.join(toolsets), '--max-turns', str(limit)]
    if config.get('exec_model'):
        args += ['-m', config['exec_model']]
    return args


class Executions:
    def __init__(self, config):
        self.config = config
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

    def cancel(self, key):
        with self.lock:
            self.cancelled.add(key)
            job = self.jobs.get(key)
            if job and not job['cancel'].is_set():
                job['cancel'].set()
                if job['process'].poll() is None:
                    self._signal(job['process'], signal.SIGTERM)

    def run(self, key, argv, result_path, progress=lambda _: None):
        started = time.monotonic()
        done, cancelled = threading.Event(), threading.Event()
        process = None
        parser = StreamJSON()
        selector = selectors.DefaultSelector()
        try:
            with self.lock:
                if self.closed or key in self.cancelled:
                    raise ExecutionError('execution stopped')
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, start_new_session=True,
                                           env=hermes_environment(self.config))
                self.jobs[key] = {'process': process, 'cancel': cancelled, 'done': done}
            selector.register(process.stdout, selectors.EVENT_READ)
            buffer = b''
            eof = False
            while not eof:
                if cancelled.is_set() or time.monotonic() - started > self.config['timeout_seconds']:
                    raise ExecutionError('execution stopped or timed out')
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
            with path.open('rb') as handle:
                raw = handle.read(131073)
            if len(raw) > 131072:
                raise ExecutionError('result file exceeds budget')
            result = json.loads(raw)
            usage = event.get('tokens', {})
            reported = usage.get('total') if isinstance(usage, dict) else None
            metrics = {'tokens': max(0, int(reported)) if type(reported) is int else (len(raw) + 3) // 4,
                       'source': 'hermes.stream-json.tokens.total' if type(reported) is int else 'estimated_execution_result_bytes/4',
                       'seconds': time.monotonic() - started, 'input_bytes': 0, 'estimated_input_tokens': 0}
            return result, metrics
        except (ExecutionError,ValueError,OSError,subprocess.SubprocessError) as exc:
            usage=(parser.result or {}).get('tokens',{})
            total=usage.get('total') if isinstance(usage,dict) else None
            if type(total) is int:
                exc.metrics={'tokens':max(0,total),'source':'hermes.stream-json.tokens.total','seconds':time.monotonic()-started,'input_bytes':0,'estimated_input_tokens':0}
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
