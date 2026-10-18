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
client_path = next(
    path
    for path in (ROOT / "native-bridge/client.py", ROOT / "native_bridge/client.py")
    if path.is_file()
)
spec = importlib.util.spec_from_file_location("fast_bridge_client", client_path.resolve())
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
version_path = next(
    (
        path
        for path in (
            ROOT / "native-extension/manifest.json",
            ROOT / "extension/manifest.json",
            ROOT.parent / "extension/manifest.json",
            ROOT.parent / "native-extension/manifest.json",
        )
        if path.is_file()
    ),
    None,
)
if version_path:
    VERSION = json.loads(version_path.read_text())["version"]
else:
    import re

    match = (
        re.search(r"^version:\s*(\S+)", (ROOT / "plugin.yaml").read_text(), re.M)
        if (ROOT / "plugin.yaml").is_file()
        else None
    )
    VERSION = match.group(1) if match else "unknown"

HOME = Path(os.environ.get("FAST_BROWSER_LINK_HOME", Path.home() / ".fast-browser-link"))
METHODS = {
    "health": "health",
    "browsers": "browser.list",
    "create": "shared.create",
    "get": "shared.get",
    "list": "shared.list",
    "run": "shared.run",
    "close": "shared.close",
    "cancel": "shared.cancel",
    "resume": "shared.resume",
    "downloads": "shared.downloads",
    "download_claim": "shared.download_claim",
    "download_cancel": "shared.download_cancel",
    "script": None,
    "site_search": None,
    "site_run": None,
}


class Browser:
    def __init__(self, home=HOME, owner=None, client=None):
        self.home = Path(home)
        self.lane = None
        self.owner = owner or secrets.token_urlsafe(32)
        self.used = False
        self.client = client or bridge.BridgeClient(home, timeout=60)

    def call(self, operation, params):
        if operation not in METHODS or not isinstance(params, dict):
            raise ValueError("未知操作或参数不是对象")
        if any(
            key in params
            for key in ("owner", "session_id", "__owner_lease", "__browser_link_owner_lease")
        ):
            raise ValueError("浏览器身份由调用入口管理")
        if operation in {"script", "site_search", "site_run"}:
            if self.lane is None:
                spec = importlib.util.spec_from_file_location(
                    "fbl_independent_scripts", client_path.resolve().with_name("fbl_scripts.py")
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.lane = module.ScriptLane(self.client, self.home, self.owner)
            self.used = True
            return self.lane.execute(operation, params)
        args = dict(params)
        if operation not in ("health", "browsers"):
            args["owner"] = self.owner
        if operation == "run":
            args.setdefault("requestId", uuid.uuid4().hex)
        self.used = True
        method = (
            "shared.handoff"
            if operation == "close" and args.get("keepTabs") is True
            else METHODS[operation]
        )
        return self.client.call(method, args)


def tool_schema():
    return {
        "name": "fast_browser_link",
        "description": "控制 Chrome/Edge：browsers → create/get ready → run 或 script → close。多步优先 script；site_search 查已启用网站工具，site_run 运行。未知结果先读取，禁止重放写入。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": list(METHODS)},
                "params": {
                    "type": "object",
                    "description": "Native 参数；script: taskId, code(Python), timeout(1..3600 秒), 可选 tabId/resume_checkpoint。helpers: new_tab, use_tab, read_page, click_element, fill_element, semantic_snapshot, evaluate, wait_pending, reconcile；变量不延续，文件延续，检查 execution_complete。site_search: query/limit；site_run: taskId, site, name, args, timeout_s。create 可用 incognito=true，需无痕权限；禁止指定 owner。",
                },
            },
            "required": ["operation"],
            "additionalProperties": False,
        },
    }


def serve(browser, source=sys.stdin, sink=sys.stdout):
    # 中文注释：每个 MCP 进程独立身份，stdout 仅输出协议帧，不接收模型指定的身份。
    for line in source:
        request = None
        try:
            if len(line.encode()) > 1024 * 1024:
                raise ValueError("请求超过 1 MiB")
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                raise ValueError("无效 JSON-RPC 请求")
            if "id" not in request:
                continue
            method = request.get("method")
            if method == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fast-browser-link", "version": VERSION},
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": [tool_schema()]}
            elif method == "tools/call":
                params = request.get("params", {})
                if params.get("name") != "fast_browser_link":
                    raise ValueError("未知工具")
                args = params.get("arguments", {})
                try:
                    value = browser.call(args.get("operation"), args.get("params", {}))
                    result = {
                        "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
                    }
                except (ValueError, bridge.BridgeError, OSError) as exc:
                    result = {
                        "isError": True,
                        "content": [
                            {"type": "text", "text": json.dumps(error(exc), ensure_ascii=False)}
                        ],
                    }
            else:
                reply = {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                }
                sink.write(json.dumps(reply) + "\n")
                sink.flush()
                continue
            reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except (ValueError, TypeError, AttributeError) as exc:
            reply = {
                "jsonrpc": "2.0",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": {"code": -32600, "message": "Invalid request"},
            }
        sink.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sink.flush()


def error(exc):
    if isinstance(exc, bridge.BridgeError):
        return {"error": exc.code, "message": exc.message, **exc.data}
    return {
        "error": "invalid_request" if isinstance(exc, ValueError) else "bridge_unavailable",
        "message": str(exc) if isinstance(exc, ValueError) else "请运行安装器并检查扩展连接状态",
    }


def session_owner(session):
    path = Path(session).expanduser()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(secrets.token_urlsafe(32))
    except FileExistsError:
        pass
    # 中文注释：复用桥接的私有文件检查，避免从链接或其他用户文件读取身份。
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    import stat

    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise ValueError("会话文件必须属于当前用户且权限为 0600")
        owner = source.read(129)
    if not owner or len(owner) > 128:
        raise ValueError("无效会话文件")
    return owner


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp", action="store_true")
    parser.add_argument("--session", help="CLI 会话文件；首次调用自动创建，此后复用同一路径")
    parser.add_argument("operation", nargs="?", choices=list(METHODS))
    parser.add_argument("params", nargs="?", default="{}", help="JSON 对象；- 表示从 stdin 读取")
    args = parser.parse_args()
    browser = None
    try:
        owner = session_owner(args.session) if args.session and not args.mcp else None
        browser = Browser(owner=owner)
        if args.mcp:
            serve(browser)
        else:
            if not args.operation:
                parser.error("缺少 operation")
            if args.operation not in ("health", "browsers") and not args.session:
                parser.error("任务操作需要 --session，以便后续调用复用任务身份")
            params = json.loads(sys.stdin.read() if args.params == "-" else args.params)
            print(json.dumps(browser.call(args.operation, params), ensure_ascii=False))
    except (ValueError, bridge.BridgeError, OSError) as exc:
        print(json.dumps(error(exc), ensure_ascii=False))
        return 1
    finally:
        if browser is not None and browser.lane is not None:
            browser.lane.close()
        if browser is not None and args.mcp and browser.used:
            try:
                browser.client.call("shared.session_end", {"owner": browser.owner})
            except (bridge.BridgeError, OSError):
                pass
        if browser is not None:
            browser.client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
