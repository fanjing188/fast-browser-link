#!/usr/bin/env python3
"""Fast-browser-link 的框架无关 JSON CLI 与 MCP stdio 入口。"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fast_bridge_client', (ROOT / 'native-bridge/client.py').resolve())
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
VERSION = json.loads(next(path for path in (ROOT / 'native-extension/manifest.json', ROOT / 'extension/manifest.json', ROOT.parent / 'extension/manifest.json') if path.is_file()).read_text())['version']
HOME = Path(os.environ.get('FAST_BROWSER_LINK_HOME', Path.home() / '.fast-browser-link'))
METHODS = {'health': 'health', 'browsers': 'browser.list', 'create': 'shared.create',
           'get': 'shared.get', 'list': 'shared.list', 'run': 'shared.run',
           'close': 'shared.close', 'cancel': 'shared.cancel', 'resume': 'shared.resume',
           'downloads': 'shared.downloads', 'download_claim': 'shared.download_claim',
           'download_cancel': 'shared.download_cancel'}


class Browser:
    def __init__(self, home=HOME, owner=None, client=None):
        self.owner = owner or secrets.token_urlsafe(32)
        self.used = False
        self.client = client or bridge.BridgeClient(home, timeout=60)

    def call(self, operation, params):
        if operation not in METHODS or not isinstance(params, dict):
            raise ValueError('未知操作或参数不是对象')
        if any(key in params for key in ('owner', 'session_id', '__owner_lease')):
            raise ValueError('浏览器身份由调用入口管理')
        args = dict(params)
        if operation not in ('health', 'browsers'):
            args['owner'] = self.owner
        if operation == 'run':
            args.setdefault('requestId', uuid.uuid4().hex)
        self.used = True
        method = 'shared.handoff' if operation == 'close' and args.get('keepTabs') is True else METHODS[operation]
        return self.client.call(method, args)


def tool_schema():
    return {'name': 'fast_browser_link', 'description': '控制已连接的 Chrome/Edge。先 browsers，再 create、get、run，完成后 close。结果未知时先读取，禁止重放写入。',
            'inputSchema': {'type': 'object', 'properties': {
                'operation': {'type': 'string', 'enum': list(METHODS)},
                'params': {'type': 'object', 'description': 'Native 参数，例如 taskId、tabId、action、url；create 可用 incognito=true 开无痕任务，需扩展无痕权限；禁止指定 owner。'}},
                'required': ['operation'], 'additionalProperties': False}}


def serve(browser, source=sys.stdin, sink=sys.stdout):
    # 中文注释：每个 MCP 进程独立身份，stdout 仅输出协议帧，不接收模型指定的身份。
    for line in source:
        request = None
        try:
            if len(line.encode()) > 1024 * 1024:
                raise ValueError('请求超过 1 MiB')
            request = json.loads(line)
            if not isinstance(request, dict) or request.get('jsonrpc') != '2.0':
                raise ValueError('无效 JSON-RPC 请求')
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'fast-browser-link', 'version': VERSION}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': [tool_schema()]}
            elif method == 'tools/call':
                params = request.get('params', {})
                if params.get('name') != 'fast_browser_link':
                    raise ValueError('未知工具')
                args = params.get('arguments', {})
                try:
                    value = browser.call(args.get('operation'), args.get('params', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
                except (ValueError, bridge.BridgeError, OSError) as exc:
                    result = {'isError': True, 'content': [{'type': 'text', 'text': json.dumps(error(exc), ensure_ascii=False)}]}
            else:
                reply = {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Method not found'}}
                sink.write(json.dumps(reply) + '\n'); sink.flush()
                continue
            reply = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except (ValueError, TypeError, AttributeError) as exc:
            reply = {'jsonrpc': '2.0', 'id': request.get('id') if isinstance(request, dict) else None,
                     'error': {'code': -32600, 'message': 'Invalid request'}}
        sink.write(json.dumps(reply, ensure_ascii=False) + '\n'); sink.flush()


def error(exc):
    if isinstance(exc, bridge.BridgeError):
        return {'error': exc.code, 'message': exc.message, **exc.data}
    return {'error': 'invalid_request' if isinstance(exc, ValueError) else 'bridge_unavailable',
            'message': str(exc) if isinstance(exc, ValueError) else '请运行安装器并检查扩展连接状态'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mcp', action='store_true')
    parser.add_argument('--session', help='CLI 会话文件；首次调用自动创建，此后复用同一路径')
    parser.add_argument('operation', nargs='?', choices=list(METHODS))
    parser.add_argument('params', nargs='?', default='{}', help='JSON 对象；- 表示从 stdin 读取')
    args = parser.parse_args()
    owner = None
    if args.session and not args.mcp:
        path = Path(args.session).expanduser()
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out: out.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
        # 中文注释：复用桥接的私有文件检查，避免从链接或其他用户文件读取身份。
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        import stat
        with os.fdopen(fd) as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                parser.error('会话文件必须属于当前用户且权限为 0600')
            owner = source.read(129)
        if not owner or len(owner) > 128: parser.error('无效会话文件')
    browser = Browser(owner=owner)
    try:
        if args.mcp:
            serve(browser)
        else:
            if not args.operation: parser.error('缺少 operation')
            if args.operation not in ('health', 'browsers') and not args.session:
                parser.error('任务操作需要 --session，以便后续调用复用任务身份')
            params = json.loads(sys.stdin.read() if args.params == '-' else args.params)
            print(json.dumps(browser.call(args.operation, params), ensure_ascii=False))
    except (ValueError, bridge.BridgeError, OSError) as exc:
        print(json.dumps(error(exc), ensure_ascii=False)); return 1
    finally:
        if args.mcp and browser.used:
            try: browser.client.call('shared.session_end', {'owner': browser.owner})
            except (bridge.BridgeError, OSError): pass
        browser.client.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
