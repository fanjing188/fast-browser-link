"""框架无关的浏览器执行SDK；业务产品、CLI和MCP共用同一任务与请求合同。"""

from __future__ import annotations

import os
import hashlib
import importlib.util
from pathlib import Path
import secrets
import stat
import sys
import uuid

# 中文注释：工作插件可能已有同名client模块，按真实源码路径隔离加载，不能误连调用方客户端。
_client_path = Path(__file__).with_name("client.py").resolve()
_client_name = "fbl_sdk_client_" + hashlib.sha256(str(_client_path).encode()).hexdigest()[:16]
bridge = sys.modules.get(_client_name)
if bridge is None:
    _spec = importlib.util.spec_from_file_location(_client_name, _client_path)
    if _spec is None or _spec.loader is None:
        raise RuntimeError("browser client is unavailable")
    bridge = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(bridge)
    sys.modules[_client_name] = bridge

METHODS = {
    "health": "health",
    "browsers": "browser.list",
    "create": "shared.create",
    "get": "shared.get",
    "list": "shared.list",
    "run": "shared.run",
    "operation_status": "shared.operation_status",
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
    def __init__(self, home=None, owner=None, client=None):
        self.home = (
            Path(home)
            if home is not None
            else Path(os.environ.get("FAST_BROWSER_LINK_HOME", Path.home() / ".fast-browser-link"))
        )
        self.owner = owner or secrets.token_urlsafe(32)
        self.client = client or bridge.BridgeClient(self.home, timeout=60)
        self.lane = None
        self.used = False

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
                path = Path(__file__).with_name("fbl_scripts.py").resolve()
                name = "fbl_sdk_scripts_" + hashlib.sha256(str(path).encode()).hexdigest()[:16]
                module = sys.modules.get(name)
                if module is None:
                    spec = importlib.util.spec_from_file_location(name, path)
                    if spec is None or spec.loader is None:
                        raise RuntimeError("browser script runtime is unavailable")
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    sys.modules[name] = module
                self.lane = module.ScriptLane(self.client, self.home, self.owner)
            self.used = True
            return self.lane.execute(operation, params)
        args = dict(params)
        if operation not in {"health", "browsers"}:
            args["owner"] = self.owner
        if operation == "run":
            args.setdefault("requestId", uuid.uuid4().hex)
        self.used = True
        method = (
            "shared.handoff"
            if operation == "close" and args.get("keepTabs") is True
            else METHODS[operation]
        )
        # 中文注释：底层未知结果直接向上交付，不重试、不切换执行器。
        return self.client.call(method, args)

    def close(self):
        """只释放本机客户端资源；业务页面按显式任务close/handoff合同处理。"""
        try:
            if self.lane is not None:
                self.lane.close()
        finally:
            self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def session_owner(session):
    path = Path(session).expanduser()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as target:
            target.write(secrets.token_urlsafe(32))
    except FileExistsError:
        pass
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
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
