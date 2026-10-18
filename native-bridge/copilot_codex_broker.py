"""daemon 持有的任务工具授权；模型只能提供窄动作参数。"""

import json
import secrets
import threading
import time
import uuid
from urllib.parse import urlsplit
from copilot_diagnostics import redact_page

ACTIONS = {
    "snapshot": ("semantic_snapshot", {}),
    "navigate": ("navigate", {"url": {"type": "string", "maxLength": 2000}}),
    "click": ("click", {"selector": {"type": "string", "maxLength": 1000}}),
    "fill": (
        "fill",
        {
            "selector": {"type": "string", "maxLength": 1000},
            "text": {"type": "string", "maxLength": 4000},
        },
    ),
}


class BrowserBroker:
    def __init__(self, daemon, instance, permitted, context, template, limit):
        self.daemon, self.instance, self.permitted = daemon, instance, permitted
        self.context = context or {}
        self.owner = secrets.token_urlsafe(32)
        self.task = self.task_generation = self.tab = None
        self.connection = None
        self.lock = threading.RLock()
        self.action_lock = threading.Lock()
        self.cleanup_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.active = True
        self.remaining = limit
        self.calls = set()
        self.unknown = False
        self.cleanup_receipt = None
        self.tools = []
        if "fast-browser-link" in template.get("toolsets", []) and self.context.get("url"):
            self.tools = [
                {
                    "name": "assist_browser_" + name,
                    "description": "Assist owned work page: " + name,
                    "inputSchema": {
                        "type": "object",
                        "properties": properties,
                        "required": list(properties),
                        "additionalProperties": False,
                    },
                }
                for name, (_, properties) in ACTIONS.items()
            ]

    def _allowed(self):
        if not self.active or not self.permitted() or self.unknown:
            raise ValueError("Assist browser authorization revoked")

    def _create(self):
        parsed = urlsplit(self.context["url"])
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("invalid work page URL")
        created = self.daemon._dispatch_client(
            "shared.create",
            {
                "owner": self.owner,
                "instanceId": self.instance,
                "title": "Fast-browser-link · Assist",
                "allowedOrigins": [parsed.scheme + "://" + parsed.netloc],
                "incognito": bool(self.context.get("incognito")),
                "copilotSilentToken": self.daemon.copilot.silent_token,
            },
        )
        self.task, self.task_generation = created["id"], created["generation"]
        self.connection = self.daemon.extensions[self.instance].get("connectionGeneration")

    def _validate_task(self, *, page=True):
        task = self.daemon.tasks.get(self.task)
        if (
            not task
            or task["owner"] != self.owner
            or task["instanceId"] != self.instance
            or task["generation"] != self.task_generation
            or task.get("accessRevoked")
            or task["state"] != "ready"
            or self.daemon.extensions.get(self.instance, {}).get("connectionGeneration")
            != self.connection
        ):
            raise ValueError("stale task generation or lease")
        if page and (
            self.tab not in task.get("agentTabIds", [])
            or self.daemon.tab_leases.get((self.instance, self.tab)) != self.task
        ):
            raise ValueError("work page lease unavailable")

    def call(self, params):
        with self.action_lock:
            return self._call(params)

    def _call(self, params):
        name, args, identity = params.get("tool"), params.get("arguments"), params.get("callId")
        spec = next((tool for tool in self.tools if tool["name"] == name), None)
        if not spec or not isinstance(args, dict) or not isinstance(identity, str):
            raise ValueError("unknown Assist tool")
        from copilot_contracts import validate

        validate(args, spec["inputSchema"])
        with self.lock:
            self._allowed()
            if identity in self.calls or self.remaining <= 0:
                raise ValueError("duplicate call or action budget exhausted")
            self.calls.add(identity)
            self.remaining -= 1
            if not self.task:
                self._create()
        try:
            deadline = time.monotonic() + 120
            while True:
                with self.lock, self.daemon.state_lock:
                    self._allowed()
                    task = self.daemon.tasks.get(self.task, {})
                    if task.get("state") not in {"pending_approval", "authorizing"}:
                        self._validate_task(page=self.tab is not None)
                        break
                if time.monotonic() >= deadline or self.stop_event.wait(0.05):
                    raise ValueError("browser authorization unavailable")
            if self.tab is None:
                # 中文注释：创建工作页同样消耗动作额度，不能借隐式打开绕过上限。
                with self.lock:
                    self._allowed()
                    if self.remaining <= 0:
                        raise ValueError("action budget exhausted before opening page")
                    self.remaining -= 1
                opened = self.daemon._dispatch_client(
                    "shared.run",
                    {
                        "owner": self.owner,
                        "taskId": self.task,
                        "requestId": uuid.uuid4().hex,
                        "action": "new_tab",
                        "url": self.context["url"],
                    },
                )
                self.tab = opened.get("tabId", opened.get("id"))
            with self.lock, self.daemon.state_lock:
                self._allowed()
                self._validate_task()
            action = ACTIONS[name.removeprefix("assist_browser_")][0]
            result = self.daemon._dispatch_client(
                "shared.run",
                {
                    **args,
                    "owner": self.owner,
                    "taskId": self.task,
                    "tabId": self.tab,
                    "requestId": uuid.uuid4().hex,
                    "action": action,
                },
            )
            if isinstance(result, dict) and (
                result.get("outcomeUnknown")
                or result.get("status") == "outcome_unknown"
                or result.get("error") == "outcome_unknown"
            ):
                self.unknown = True
                raise ValueError("outcome_unknown")
            with self.lock:
                self._allowed()
            return redact_page(result)
        except Exception:
            # 中文注释：无法核实是否已派发时封住整个授权，不重试，也不退还额度。
            self.unknown = True
            raise

    def revoke(self):
        with self.lock:
            self.active = False
            self.stop_event.set()
            if self.task:
                with self.daemon.state_lock:
                    task = self.daemon.tasks.get(self.task)
                    if task and task["owner"] == self.owner:
                        task["accessRevoked"] = True

    def cleanup(self):
        self.revoke()
        with self.cleanup_lock:
            if self.task and self.cleanup_receipt is None:
                try:
                    self.cleanup_receipt = self.daemon._dispatch_client(
                        "shared.cancel", {"owner": self.owner, "taskId": self.task}
                    )
                except Exception:
                    self.cleanup_receipt = {"cleanupState": "unknown"}
            return self.cleanup_receipt or {"cleanupState": "succeeded", "no_work_page": True}
