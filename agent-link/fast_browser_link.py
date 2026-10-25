#!/usr/bin/env python3
"""Fast-browser-link 的框架无关 JSON CLI 与 MCP stdio 入口。"""

from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
native = next(
    path
    for path in (ROOT / "native-bridge", ROOT / "native_bridge")
    if (path / "browser_sdk.py").is_file()
)
# 中文注释：同进程可有多个安装候选；只加载本入口同树SDK，不复用调用方的同名模块。
sdk_path = (native / "browser_sdk.py").resolve()
sdk_name = "fbl_browser_sdk_" + hashlib.sha256(str(sdk_path).encode()).hexdigest()[:16]
sdk = sys.modules.get(sdk_name)
if sdk is None:
    spec = importlib.util.spec_from_file_location(sdk_name, sdk_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("browser SDK is unavailable")
    sdk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sdk)
    sys.modules[sdk_name] = sdk
Browser, METHODS, session_owner, bridge = sdk.Browser, sdk.METHODS, sdk.session_owner, sdk.bridge

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
                    "description": "Native 参数；script: taskId, code(Python), timeout(1..3600 秒), 可选 tabId/resume_checkpoint。helpers: new_tab, use_tab, read_page, click_element, fill_element, semantic_snapshot, evaluate, wait_pending, reconcile；变量不延续，文件延续，检查 execution_complete。site_search: query/limit；site_run: taskId, site, name, args, timeout_s。create 可用 incognito=true，需无痕权限；existingTab={} 显式接管当前页，existingTab={url:完整网址} 接管唯一精确匹配页，无需 allowedOrigins；ready 后读取 attachedTabIds，直接 run/script，不调用 new_tab，结束保留原页；禁止指定 owner 或原页 tabId。",
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
