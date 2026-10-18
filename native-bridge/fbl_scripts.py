"""独立入口只注入可信会话，执行与网站工具复用现有适配器。"""

import fcntl
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import uuid


def load(path):
    spec = importlib.util.spec_from_file_location("fbl_shared_" + path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IdentityError(ValueError):
    pass


class ScriptLane:
    def __init__(self, client, home, owner):
        here = Path(__file__).resolve().parent
        root = next(
            (
                p
                for p in (here, here.parent / "executor-plugin", here.parent)
                if (p / "script_lane/host_bridge.py").is_file()
            ),
            None,
        )
        if root is None:
            raise ValueError("script runtime missing; update the installed runtime")
        self.owner = owner
        self.home = Path(home)
        self.client = client
        self.session = uuid.uuid4().hex
        self.script = load(root / "script_lane/tool.py")
        host = load(root / "script_lane/host_bridge.py")
        # 中文注释：身份来自入口的私有会话文件或 MCP 进程，不接受模型参数。
        self.authority = self
        self.tools = {self.script.TOOL_NAME}
        self.bridge_denied = host.BridgeDenied
        self.host = host.HostBridge(self, root, owner_for_session=self.owner_for_session)
        self.handler = self.script.make_handler(
            self.host, self, self.home, lease_error=IdentityError, bridge_denied=host.BridgeDenied
        )
        self.sites = {}
        load(root / "site_tools/tools.py").register(
            SimpleNamespace(
                register_tool=lambda **kw: self.sites.update({kw["name"]: kw["handler"]})
            ),
            self.host,
            self,
            self.home,
            lease_error=IdentityError,
            bridge_denied=host.BridgeDenied,
            enabled_tools=("browser_site_search", "browser_site_run"),
        )

    def owner_for_session(self, session):
        if session != self.session:
            raise IdentityError("untrusted session")
        return self.owner

    def lease_tools(self, names):
        self.tools.update(names)

    def consume(self, name, args, *, session_id):
        if name not in self.tools:
            raise IdentityError("unregistered tool")
        return SimpleNamespace(
            owner=self.owner_for_session(session_id), tool_call_id=uuid.uuid4().hex
        )

    def call(self, method, params):
        return self.client.call(method, params)

    def execute(self, operation, params):
        values = dict(params)
        task = values.pop("taskId", None)
        tab = values.pop("tabId", None)
        if operation == "script":
            if set(values) - {"code", "timeout", "resume_checkpoint"}:
                raise ValueError("invalid script fields")
            if "timeout" in values:
                values["timeout_s"] = values.pop("timeout")
        elif operation == "site_search" and (task is not None or tab is not None):
            raise ValueError("site_search does not take taskId or tabId")
        if operation != "site_search" and (not isinstance(task, str) or not task):
            raise ValueError("taskId is required")
        if tab is not None and type(tab) is not int:
            raise ValueError("invalid tabId")
        workspace = self.script.workspace_for(self.home, self.owner)
        # 中文注释：CLI 每次另起进程，文件锁使同一可信会话仍只有一批脚本在途。
        with (workspace / ".host.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ValueError("another script owns this session") from exc
            if operation != "site_search":
                try:
                    self.host.bind(
                        self.session, owner=self.owner, task_id=task, tab_id=tab, select=True
                    )
                except RuntimeError as exc:
                    if (
                        not isinstance(exc, self.bridge_denied)
                        and getattr(exc, "outcomeUnknown", None) is not False
                    ):
                        raise
                    return {
                        "error": "task binding unavailable",
                        "code": getattr(exc, "code", "binding_missing"),
                        "execution_complete": False,
                        "outcome_unknown": False,
                        "retryable": False,
                    }
            handler = self.handler if operation == "script" else self.sites["browser_" + operation]
            return json.loads(handler(values, session_id=self.session))

    def close(self):
        self.host.close()
