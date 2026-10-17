"""Hermes ACP JSON-RPC over stdio；只使用已查实的标准方法。"""
from __future__ import annotations
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid


class ACPError(RuntimeError):
    pass


class ACP:
    def __init__(self, config, cwd, on_update=lambda _: None):
        self.config, self.cwd, self.on_update = config, str(Path(cwd).resolve()), on_update
        self.process = None
        self.pending = {}
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.turn_lock = threading.Lock()
        self.close_lock = threading.RLock()
        self.session = None
        self.messages = {}
        self.context_tokens = 0
        self.closed = False
        self.capabilities = {}
        self.failure = None
        self.last_usage = 0
        self.tools_verified = False

    def start(self):
        with self.lock:
            if self.process:
                return
            command = self.config.get('acp_command') or [self.config.get('hermes_command', 'hermes'), '-p', self.config['inference_profile'], 'acp']
            if not isinstance(command, list) or any(not isinstance(item, str) for item in command):
                raise ACPError('acp_command must be argv')
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, text=True, start_new_session=True, cwd=self.cwd,
                                            env={**os.environ,'HERMES_ACP_SKIP_CONFIGURED_MCP':'1'})
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            result = self.call('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'fast-browser-link-copilot', 'version': '2.2.0'},
                                            'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}})
            self.capabilities = result.get('agentCapabilities', {})
            self.new_session()
        except BaseException:
            self.close()
            raise

    def _send(self, message):
        with self.write_lock:
            if self.closed or not self.process or self.process.poll() is not None:
                raise ACPError('ACP disconnected')
            try:
                self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
                self.process.stdin.flush()
            except (OSError, ValueError) as exc:
                raise ACPError('ACP write failed') from exc

    def call(self, method, params):
        request_id = uuid.uuid4().hex
        pending = {'event': threading.Event()}
        with self.lock:
            if len(self.pending) >= 16:
                raise ACPError('ACP backlog')
            self.pending[request_id] = pending
        try:
            self._send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
            if not pending['event'].wait(self.config.get('timeout_seconds', 180)):
                self.cancel()
                raise ACPError('ACP request timed out; not replayed')
            if 'error' in pending:
                raise ACPError('ACP request failed')
            return pending.get('result', {})
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def _read(self):
        try:
            for line in iter(lambda: self.process.stdout.readline(262145), ''):
                if len(line.encode()) > 262144:
                    raise ACPError('ACP event too large')
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ACPError('ACP envelope must be an object')
                if 'method' not in message and 'id' in message:
                    with self.lock:
                        pending = self.pending.get(message['id'])
                        if pending:
                            pending.update(message)
                            pending['event'].set()
                    continue
                if message.get('method') == 'session/update':
                    params = message.get('params', {})
                    if params.get('sessionId') != self.session:
                        continue
                    update = params.get('update', {})
                    if update.get('sessionUpdate') == 'agent_message_chunk':
                        content = update.get('content', {})
                        if content.get('type') == 'text':
                            key = update.get('messageId', 'current')
                            with self.lock:
                                text = self.messages.get(key, '') + content.get('text', '')
                                if len(text.encode()) > 65536:
                                    raise ACPError('ACP message exceeds budget')
                                self.messages[key] = text
                    if update.get('sessionUpdate') == 'usage_update':
                        self.context_tokens = max(0, int(update.get('used', 0)))
                    self.on_update(update)
                elif 'id' in message:
                    # 中文注释：协作进程不能自动批准终端/编辑/其他敏感确认，也不提供文件系统旁路。
                    if message.get('method') == 'session/request_permission':
                        self._send({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'cancelled'}}})
                    else:
                        self._send({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Client operation unavailable'}})
        except (OSError, ValueError, TypeError, ACPError) as exc:
            self.failure = type(exc).__name__
            self.on_update({'sessionUpdate':'copilot_transport_error'})
        finally:
            with self.lock:
                for pending in self.pending.values():
                    pending['error'] = {'message': 'ACP disconnected'}
                    pending['event'].set()

    def new_session(self):
        result = self.call('session/new', {'cwd': self.cwd, 'mcpServers': []})
        session = result.get('sessionId')
        if not isinstance(session, str) or not session:
            raise ACPError('ACP session/new returned no sessionId')
        self.session = session
        self.context_tokens = 0
        self.last_usage = 0
        if self.config.get('inference_model'):
            self.call('session/set_model', {'sessionId': session, 'modelId': self.config['inference_model']})
        tools,_ = self.prompt('/tools')
        if tools.strip() != 'No tools available.':
            raise ACPError('inference profile must expose zero tools')
        self.tools_verified = True
        return session

    def prompt(self, text):
        with self.turn_lock:
            with self.lock:
                self.messages.clear()
            started = time.monotonic()
            result = self.call('session/prompt', {'sessionId': self.session, 'prompt': [{'type': 'text', 'text': text}]})
            if result.get('stopReason') != 'end_turn':
                raise ACPError('ACP turn did not complete')
            with self.lock:
                messages = list(self.messages.values())
            final = messages[-1] if messages else ''
            usage = result.get('usage')
            # 中文注释：Hermes usage 是本会话累计量，必须先取差值；usage_update.used 是上下文大小，不能混为累计花费。
            if isinstance(usage, dict) and isinstance(usage.get('totalTokens'), (int, float)):
                reported=max(0,int(usage['totalTokens']))
                if reported < self.last_usage:
                    raise ACPError('cumulative usage counter moved backwards')
                tokens,source=reported-self.last_usage,'acp.usage.totalTokens.delta'
                self.last_usage=reported
            else:
                tokens, source = (len(text.encode()) + len(final.encode()) + 3) // 4, 'estimated_utf8_bytes/4'
            if text.startswith('/') and not isinstance(usage,dict):tokens,source=0,'acp.local_control'
            return final, {'tokens': tokens, 'source': source, 'cumulative_tokens':self.last_usage, 'input_bytes': len(text.encode()),
                           'estimated_input_tokens': (len(text.encode()) + 3) // 4, 'seconds': time.monotonic() - started}

    def cancel(self):
        if self.session and not self.closed:
            try:
                self._send({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': self.session}})
            except ACPError:
                pass

    def close(self):
        with self.close_lock:
            self._close()

    def _close(self):
        if self.closed:
            return
        self.cancel()
        self.closed = True
        process = self.process
        if not process:
            return
        try:
            process.stdin.close()
            process.wait(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except ProcessLookupError:
                process.wait()
        process.stdout.close()
