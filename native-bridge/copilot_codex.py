"""Codex app-server stdio；受限推理必须经策略回读和宿主事件审计。"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

from copilot_acp import ACP, ACPError, ACPDisconnected, ACPTimeout
from copilot_usage import counts

MIN_VERSION = (0, 162, 1)
SAFE_ITEMS = {"userMessage", "agentMessage", "reasoning", "contextCompaction"}
DISABLED_FEATURES = (
    "shell_tool",
    "unified_exec",
    "stable_environment_tools",
    "apply_patch_freeform",
    "web_search",
    "web_search_cached",
    "web_search_request",
    "standalone_web_search",
    "plugins",
    "remote_plugin",
    "plugin_hooks",
    "hooks",
    "codex_hooks",
    "apps",
    "connectors",
    "skill_search",
    "skill_mcp_dependency_install",
    "multi_agent",
    "multi_agent_v2",
    "collab",
    "agent_message_board",
    "js_repl",
    "code_mode",
    "computer_use",
    "browser_use",
    "image_generation",
    "memory_tool",
    "memories",
    "tool_search",
    "search_tool",
    "request_permissions_tool",
    "request_rule",
    "request_permissions",
    "view_image",
    "sleep_tool",
    "token_budget",
    "current_time_reminder",
    "send_message_to_user_async",
    "send_async_message",
    "deferred_executor",
    "tool_suggest",
    "default_mode_request_user_input",
)


def supported(value):
    match = re.fullmatch(r"codex-cli (\d+)\.(\d+)\.(\d+)\s*", value)
    return bool(match and tuple(map(int, match.groups())) >= MIN_VERSION)


def codex_environment():
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("FAST_BROWSER_", "HERMES_"))
    }


def detect(config):
    binary = shutil.which(config.get("codex_command", "codex"))
    result = {"installed": bool(binary), "configured": False, "status": "not_installed"}
    if not binary:
        return result
    try:
        version = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            env=codex_environment(),
        )
        if version.returncode or not supported(version.stdout):
            return {**result, "status": "unsupported_version"}
        auth = subprocess.run(
            [binary, "login", "status"],
            capture_output=True,
            text=True,
            timeout=5,
            env=codex_environment(),
        )
        text = (auth.stdout + auth.stderr).lower()
        state = (
            "authenticated"
            if auth.returncode == 0
            else ("auth_missing" if "not logged in" in text else "auth_error")
        )
        return {
            **result,
            "version": version.stdout.strip().removeprefix("codex-cli "),
            "auth": state,
            "configured": state == "authenticated",
            "status": state,
        }
    except (OSError, subprocess.SubprocessError):
        return {**result, "status": "unstartable"}


def overrides(execution=False, cwd=None):
    values = {"features." + key: False for key in DISABLED_FEATURES}
    values.update(
        {
            "features.skip_host_skill_discovery": True,
            "skills.bundled.enabled": False,
            "skills.include_instructions": False,
            "tools.update_plan.enabled": False,
            "tools.experimental_request_user_input.enabled": False,
            "web_search": "disabled",
            "notify": [],
            "project_doc_max_bytes": 0,
            "check_for_update_on_startup": False,
        }
    )
    if execution:
        values.update(
            {
                "features.shell_tool": True,
                "features.unified_exec": True,
                "features.stable_environment_tools": True,
                "sandbox_workspace_write.writable_roots": [str(cwd)],
                "sandbox_workspace_write.network_access": False,
                "sandbox_workspace_write.exclude_slash_tmp": True,
                "sandbox_workspace_write.exclude_tmpdir_env_var": True,
            }
        )
    return values


def usage_delta(current, previous):
    keys = ("inputTokens", "cachedInputTokens", "outputTokens")
    if not isinstance(current, dict) or any(type(current.get(k)) is not int for k in keys):
        return None
    delta = {k: current[k] - previous.get(k, 0) for k in keys}
    if any(v < 0 for v in delta.values()) or delta["cachedInputTokens"] > delta["inputTokens"]:
        return None
    return counts(
        delta["inputTokens"] - delta["cachedInputTokens"],
        delta["cachedInputTokens"],
        delta["outputTokens"],
    )


class Codex(ACP):
    """沿用宿主的小型 runtime 合同，不沿用 Hermes 的帧、环境或控制命令。"""

    def __init__(self, config, cwd, on_update=lambda _: None, *, execution=False, broker=None):
        super().__init__(config, cwd, on_update)
        self.execution, self.broker = execution, broker
        self.temporary = tempfile.TemporaryDirectory(prefix="fbl-assist-codex-")
        os.chmod(self.temporary.name, 0o700)
        self.thread_cwd = self.cwd if execution else self.temporary.name
        self.version = ""
        self.provider = ""
        self.policy_receipt = None
        self.turn_id = None
        self.done = threading.Event()
        self.turn_status = None
        self.violation = None
        self.total_usage = {}
        self.usage_baseline_known = True
        self.turn_usage = None
        self.in_prompt = False
        self.audit_active = False
        self.cancel_requested = False
        self.server_requests = {}
        self.server_lock = threading.Lock()
        self.request_timeout = config.get("timeout_seconds", 180)
        self.deadline = None

    def _send(self, message):
        super()._send({key: value for key, value in message.items() if key != "jsonrpc"})

    def start(self, catalog_only=False, initialize_only=False):
        if self.process:
            return
        try:
            command = self.config.get("codex_app_server_command")
            if command is None:
                binary = shutil.which(self.config.get("codex_command", "codex"))
                if not binary:
                    raise ACPError("codex_not_installed")
                version = subprocess.run(
                    [binary, "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    env=codex_environment(),
                )
                if version.returncode or not supported(version.stdout):
                    raise ACPError("codex_unsupported_version")
                self.version = version.stdout.strip().removeprefix("codex-cli ")
                command = [binary, "app-server", "--listen", "stdio://"]
                for key, value in overrides().items():
                    command += ["-c", key + "=" + json.dumps(value, ensure_ascii=False)]
            else:
                # 中文注释：仅供离线替身注入；不把 ACP 命令当 Codex 协议。
                self.version = "fixture-0.162.1"
            if (
                not isinstance(command, list)
                or not command
                or any(not isinstance(v, str) for v in command)
            ):
                raise ACPError("codex command must be argv")
            env = codex_environment()
            with self.close_lock:
                if self.closed:
                    raise ACPDisconnected("Assist runtime closed")
                self.process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=self.temporary.name,
                    env=env,
                    start_new_session=True,
                )
            self.stderr_log.start(self.process.stderr)
            self.reader = threading.Thread(target=self._read, daemon=True)
            self.reader.start()
            self.call(
                "initialize",
                {
                    "clientInfo": {"name": "fast-browser-link-assist", "version": "2.2.0"},
                    "capabilities": {"experimentalApi": True},
                },
            )
            self._send({"method": "initialized"})
            account = self.call("account/read", {"refreshToken": False})
            if account.get("account") is None and account.get("requiresOpenaiAuth") is not False:
                raise ACPError("codex_auth_required")
            if not initialize_only:
                if catalog_only:
                    self.list_models()
                else:
                    self.new_session()
        except BaseException:
            self.close()
            raise

    def call(self, method, params):
        remaining = (
            self.request_timeout if self.deadline is None else self.deadline - time.monotonic()
        )
        if remaining <= 0:
            self.cancel()
            raise ACPTimeout("Assist task deadline exceeded; not replayed")
        self.config["timeout_seconds"] = remaining
        return super().call(method, params)

    def _read(self):
        try:
            for line in iter(lambda: self.process.stdout.readline(8 * 1024 * 1024 + 1), ""):
                if not line.endswith("\n") or len(line.encode()) > 8 * 1024 * 1024:
                    raise ACPError("Codex frame exceeds budget or is incomplete")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ACPError("Codex envelope must be an object")
                if "method" not in message and "id" in message:
                    with self.lock:
                        pending = self.pending.get(message["id"])
                        if pending:
                            pending.update(message)
                            pending["event"].set()
                elif "id" in message:
                    self._request(message)
                else:
                    self._event(message.get("method", ""), message.get("params") or {})
        except (OSError, ValueError, TypeError, ACPError) as error:
            self.failure = type(error).__name__
        finally:
            if not self.closed:
                self.transport_failure = {
                    "reason": "codex_disconnected",
                    "error_type": self.failure or "ACPDisconnected",
                }
                self.failure = self.failure or "ACPDisconnected"
            with self.lock:
                for pending in self.pending.values():
                    pending.update(error={}, disconnected=True)
                    pending["event"].set()
            self.done.set()
            if not self.closed:
                self.on_update(
                    {"sessionUpdate": "copilot_transport_error", **self.transport_failure}
                )

    def _interrupt(self):
        if self.session and self.turn_id and not self.closed:
            try:
                self._send(
                    {
                        "id": uuid.uuid4().hex,
                        "method": "turn/interrupt",
                        "params": {"threadId": self.session, "turnId": self.turn_id},
                    }
                )
            except ACPError:
                pass

    def _violate(self, kind):
        with self.lock:
            self.violation = {"reason": "policy_violation", "item_type": kind[:100]}
            self.messages.clear()
        self._interrupt()
        self.done.set()
        self.on_update({"sessionUpdate": "policy_violation", **self.violation})
        if not self.in_prompt:
            threading.Thread(target=self.close, daemon=True).start()

    def _request(self, message):
        method, params, identity = message["method"], message.get("params") or {}, message["id"]
        if method == "item/tool/call" and self.execution and self.broker:
            with self.server_lock:
                if len(self.server_requests) >= 16:
                    self._send(
                        {"id": identity, "error": {"code": -32000, "message": "Tool backlog"}}
                    )
                    return
                self.server_requests[identity] = True

            def run():
                try:
                    if (
                        params.get("threadId") != self.session
                        or params.get("turnId") != self.turn_id
                    ):
                        raise ValueError("stale tool session")
                    value = self.broker.call(params)
                    result = {
                        "success": True,
                        "contentItems": [
                            {"type": "inputText", "text": json.dumps(value, ensure_ascii=False)}
                        ],
                    }
                except Exception:
                    result = {
                        "success": False,
                        "contentItems": [
                            {
                                "type": "inputText",
                                "text": "Assist tool denied or outcome_unknown; do not replay",
                            }
                        ],
                    }
                with self.server_lock:
                    if self.server_requests.pop(identity, None):
                        try:
                            self._send({"id": identity, "result": result})
                        except ACPError:
                            pass

            threading.Thread(target=run, daemon=True).start()
            return
        violate = not self.execution and (self.in_prompt or self.audit_active)
        if method.endswith("requestApproval"):
            result = (
                {"permissions": {}, "scope": "turn"}
                if method == "item/permissions/requestApproval"
                else {"decision": "decline"}
            )
            self._send({"id": identity, "result": result})
        elif method == "item/tool/call":
            self._send(
                {
                    "id": identity,
                    "result": {
                        "success": False,
                        "contentItems": [{"type": "inputText", "text": "Assist tool unavailable"}],
                    },
                }
            )
        else:
            self._send(
                {
                    "id": identity,
                    "error": {"code": -32601, "message": "Client operation unavailable"},
                }
            )
        if violate:
            self._violate(method)

    def _event(self, method, params):
        if self.closed or not (self.in_prompt or self.audit_active):
            return
        identity = params.get("threadId")
        if self.session and identity and identity != self.session:
            return
        if self.execution and not self.in_prompt:
            return
        event_turn = params.get("turnId") or (params.get("turn") or {}).get("id")
        if self.turn_id and event_turn and event_turn != self.turn_id:
            return
        if method == "turn/started":
            self.turn_id = params.get("turn", {}).get("id")
            if self.violation:
                self._interrupt()
        elif method in {"item/started", "item/completed"}:
            item = params.get("item") or {}
            kind = item.get("type", "unknown")
            if not self.execution and kind not in SAFE_ITEMS:
                self._violate(kind)
            elif kind == "agentMessage" and method == "item/completed" and not self.violation:
                self.messages[item["id"]] = item.get("text", "")
        elif method == "item/agentMessage/delta" and not self.violation:
            key = params.get("itemId", "current")
            self.messages[key] = self.messages.get(key, "") + params.get("delta", "")
            if sum(len(v.encode()) for v in self.messages.values()) > 262144:
                raise ACPError("Codex output exceeds budget")
        elif method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage") or {}
            self.turn_usage = usage.get("total")
            self.context_tokens = (usage.get("last") or {}).get("totalTokens")
        elif method == "model/rerouted":
            self.active_model = params.get("toModel") or self.active_model
        elif method == "turn/completed":
            if not self.turn_id:
                return
            self.turn_status = params.get("turn", {}).get("status")
            self.done.set()
        elif not self.execution and (
            method.startswith("item/")
            and not method.startswith(("item/reasoning/", "item/agentMessage/"))
            or any(
                word in method.lower()
                for word in (
                    "tool",
                    "commandexecution",
                    "filechange",
                    "websearch",
                    "mcp",
                    "collab",
                    "hook",
                )
            )
        ):
            self._violate(method)

    def new_session(self, verify=True):
        with self.turn_lock:
            if self.session:
                self.finish_session()
            values = overrides(self.execution, self.thread_cwd)
            # 中文注释：空表会递归合并，不能清掉继承的 MCP；只读取有效配置中的名称，再逐项禁用。
            effective = self.call(
                "config/read", {"includeLayers": False, "cwd": self.thread_cwd}
            ).get("config", {})
            values["mcp_servers"] = {
                name: {"enabled": False} for name in effective.get("mcp_servers", {})
            }
            self.provider = effective.get("model_provider") or "openai"
            params = {
                "cwd": self.thread_cwd,
                "sandbox": "workspace-write" if self.execution else "read-only",
                "approvalPolicy": "never",
                "ephemeral": True,
                "environments": None if self.execution else [],
                "dynamicTools": self.broker.tools if self.broker else [],
                "config": values,
            }
            if self.execution:
                params["runtimeWorkspaceRoots"] = [self.thread_cwd]
            selected = self.config.get("exec_model" if self.execution else "inference_model")
            if not selected and not self.execution:
                # 中文注释：仅从目录按名称段优先 nano、mini、luna；同档沿用目录顺序。
                # 名称只是低成本启发式，不代表实时报价；未匹配则保留服务端默认。
                models = self.list_models()["available"]
                selected = next(
                    (
                        row["id"]
                        for tier in ("nano", "mini", "luna")
                        for row in models
                        if tier in re.split(r"[-_.]", row["id"].lower())
                    ),
                    None,
                )
            if selected:
                params["model"] = selected
            self.audit_active = not self.execution
            result = self.call("thread/start", params)
            if self.violation:
                error = ACPError("policy_violation")
                error.failure = dict(self.violation)
                raise error
            self.session = result.get("thread", {}).get("id")
            sandbox = result.get("sandbox") or {}
            expected = "workspaceWrite" if self.execution else "readOnly"
            valid = sandbox.get("type") == expected and result.get("approvalPolicy") == "never"
            valid = valid and result.get("cwd") == self.thread_cwd and bool(self.session)
            if self.execution:
                valid = (
                    valid
                    and sandbox.get("networkAccess") is False
                    and sandbox.get("excludeSlashTmp") is True
                    and sandbox.get("excludeTmpdirEnvVar") is True
                )
                valid = valid and set(sandbox.get("writableRoots", [])) <= {self.thread_cwd}
            if not valid:
                self.close()
                raise ACPError("codex_policy_mismatch")
            self.policy_receipt = {
                "status": "sandboxed_execution" if self.execution else "restricted_audited",
                "requested": params["sandbox"],
                "effective": sandbox,
                "approvalPolicy": "never",
                "version": self.version,
            }
            self.active_model = result.get("model", "")
            self.provider = result.get("modelProvider") or self.provider
            self.model_state = {"currentModelId": self.active_model}
            self.total_usage = {}
            self.usage_baseline_known = True
            self.tools_verified = False
            return self.session

    def verify_policy(self):
        if not self.policy_receipt:
            raise ACPError("Codex policy not verified")
        return dict(self.policy_receipt)

    def select_model(self, selected):
        if selected:
            self.active_model = selected

    def list_models(self):
        cursor, seen, models = None, set(), []
        for _ in range(100):
            result = self.call(
                "model/list", {"cursor": cursor, "limit": 100, "includeHidden": False}
            )
            for row in result.get("data", []):
                identity = row.get("model") or row.get("id")
                if identity and identity not in {v["id"] for v in models}:
                    models.append(
                        {"id": identity, "label": identity, "default": row.get("isDefault") is True}
                    )
            cursor = result.get("nextCursor")
            if not cursor:
                return {
                    "current": self.active_model
                    or next((v["id"] for v in models if v["default"]), ""),
                    "available": models,
                }
            if cursor in seen:
                break
            seen.add(cursor)
        raise ACPError("Codex model pagination invalid")

    def prompt(self, text):
        with self.turn_lock:
            if self.violation:
                error = ACPError("policy_violation")
                error.failure = dict(self.violation)
                raise error
            if self.cancel_requested or self.closed:
                raise ACPError("Assist turn cancelled")
            self.verify_policy()
            self.messages.clear()
            self.done.clear()
            self.violation = self.turn_status = self.turn_id = self.turn_usage = None
            self.in_prompt = True
            started = time.monotonic()
            try:
                result = self.call(
                    "turn/start",
                    {
                        "threadId": self.session,
                        "model": self.active_model or None,
                        "input": [{"type": "text", "text": text}],
                    },
                )
                returned_id = result.get("turn", {}).get("id")
                if not returned_id or self.turn_id and returned_id != self.turn_id:
                    raise ACPError("Codex turn identity mismatch")
                self.turn_id = returned_id
                if self.violation:
                    self._interrupt()
                remaining = (
                    max(0, self.deadline - time.monotonic())
                    if self.deadline
                    else max(0, self.request_timeout - (time.monotonic() - started))
                )
                if not self.done.wait(remaining):
                    self.cancel()
                    raise ACPTimeout("Codex turn timed out; not replayed")
                if self.cancel_requested:
                    raise ACPError("Assist turn cancelled")
                if self.violation:
                    error = ACPError("policy_violation")
                    error.failure = dict(self.violation)
                    raise error
                if self.failure:
                    raise ACPDisconnected("Codex disconnected; not replayed")
                if self.turn_status != "completed":
                    raise ACPError("Codex turn did not complete")
                final = list(self.messages.values())[-1] if self.messages else ""
                components = (
                    usage_delta(self.turn_usage, self.total_usage)
                    if self.usage_baseline_known
                    else None
                )
                self.usage_baseline_known = usage_delta(self.turn_usage, {}) is not None
                estimated = components is None
                if estimated:
                    components = counts(
                        (len(text.encode()) + 3) // 4, 0, (len(final.encode()) + 3) // 4
                    )
                if isinstance(self.turn_usage, dict):
                    self.total_usage = self.turn_usage
                return final, {
                    "model": self.active_model or "unknown",
                    "usage": components,
                    "tokens": sum(components.values()),
                    "estimated": estimated,
                    "source": "estimated_utf8_bytes/4"
                    if estimated
                    else "codex.thread.tokenUsage.total.delta",
                    "context_tokens": self.context_tokens,
                    "seconds": time.monotonic() - started,
                    "input_bytes": len(text.encode()),
                    "estimated_input_tokens": (len(text.encode()) + 3) // 4,
                    "policy": self.policy_receipt["status"],
                }
            except (ACPError, OSError, ValueError) as error:
                components = (
                    usage_delta(self.turn_usage, self.total_usage)
                    if self.usage_baseline_known
                    else None
                )
                error.metrics = {
                    "model": self.active_model or "unknown",
                    "usage": components
                    if components is not None
                    else counts((len(text.encode()) + 3) // 4),
                    "estimated": True,
                    "complete": False,
                    "source": "codex.partial_usage.total.delta"
                    if components is not None
                    else "estimated_interrupted_codex_input",
                    "seconds": time.monotonic() - started,
                }
                error.metrics["tokens"] = sum(error.metrics["usage"].values())
                raise
            finally:
                self.in_prompt = False
                if not self.execution and (
                    self.violation or self.failure or self.turn_status != "completed"
                ):
                    self.close()

    def cancel(self):
        self.cancel_requested = True
        if self.broker:
            self.broker.revoke()
        with self.server_lock:
            identities = list(self.server_requests)
            self.server_requests.clear()
        for identity in identities:
            try:
                self._send({"id": identity, "result": {"success": False, "contentItems": []}})
            except ACPError:
                pass
        self._interrupt()
        self.done.set()

    def finish_session(self):
        identity = self.session
        if identity and not self.closed:
            self.call("thread/unsubscribe", {"threadId": identity})
            self.session = None
        return {"thread": identity, "runtime_ended": self.closed, "unsubscribed": bool(identity)}

    def recover(self, saved=None):
        # 中文注释：ephemeral 会话只允许新建；恢复上下文由宿主摘要承担，旧任务不重放。
        return self.new_session()

    def _close(self):
        if self.closed:
            return
        try:
            super()._close()
        finally:
            # 中文注释：主进程可能先退出；仍须清理它创建的进程组，不能遗留后台命令。
            if self.process:
                for value in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(self.process.pid, value)
                    except ProcessLookupError:
                        pass

    def close(self):
        try:
            super().close()
        finally:
            self.temporary.cleanup()
