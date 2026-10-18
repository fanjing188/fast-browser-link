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
from copilot_usage import counts
from copilot_diagnostics import StderrLog


def hermes_environment(config, extra=None):
    # 中文注释：daemon 的 HERMES_HOME 指向 browser-link 运行时根，子进程必须回到 Hermes 自己的主目录，否则会在运行时根里重建 Hermes。
    env = {**os.environ, **(extra or {})}
    env["HERMES_YOLO_MODE"] = "false"
    if config.get("bridge_home"):
        env["FAST_BROWSER_BRIDGE_HOME"] = str(config["bridge_home"])
    if config.get("copilot_resource_token"):
        env["FAST_BROWSER_COPILOT_RESOURCE_TOKEN"] = config["copilot_resource_token"]
    if config.get("copilot_silent_token"):
        env["FAST_BROWSER_COPILOT_SILENT_TOKEN"] = config["copilot_silent_token"]
    env["HERMES_HOME"] = str(
        Path(config.get("hermes_home") or Path.home() / ".hermes").expanduser()
    )
    return env


class ACPError(RuntimeError):
    pass


class ACPTimeout(ACPError):
    pass


class ACPDisconnected(ACPError):
    pass


class ACP:
    def __init__(self, config, cwd, on_update=lambda _: None):
        self.config, self.cwd, self.on_update = config, str(Path(cwd).resolve()), on_update
        self.process = None
        self.pending = {}
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.turn_lock = threading.RLock()
        self.close_lock = threading.RLock()
        self.session = None
        self.messages = {}
        self.context_tokens = None
        self.closed = False
        self.capabilities = {}
        self.failure = None
        self.transport_failure = None
        self.exit_observer = lambda _: None
        self.stderr_log = StderrLog(cwd, config.get("stderr_role", "inference"))
        self.last_usage = 0
        self.last_components = counts()
        self.tools_verified = False
        self.model_state = None
        self.active_model = ""

    def start(self, catalog_only=False, initialize_only=False):
        with self.lock:
            if self.process:
                return
            command = self.config.get("acp_command") or [
                self.config.get("hermes_command", "hermes"),
                "-p",
                self.config["inference_profile"],
                "acp",
            ]
            if not isinstance(command, list) or any(not isinstance(item, str) for item in command):
                raise ACPError("acp_command must be argv")
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
                cwd=self.cwd,
                env=hermes_environment(self.config, {"HERMES_ACP_SKIP_CONFIGURED_MCP": "1"}),
            )
        self.stderr_log.start(self.process.stderr)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            result = self.call(
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientInfo": {"name": "fast-browser-link-copilot", "version": "2.2.0"},
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                },
            )
            self.capabilities = result.get("agentCapabilities", {})
            if not initialize_only:
                self.new_session(verify=not catalog_only)
        except BaseException:
            self.close()
            raise

    def _send(self, message):
        with self.write_lock:
            if self.closed or not self.process or self.process.poll() is not None:
                raise ACPDisconnected("ACP disconnected")
            try:
                self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
            except (OSError, ValueError) as exc:
                raise ACPDisconnected("ACP write failed") from exc

    def call(self, method, params):
        request_id = uuid.uuid4().hex
        pending = {"event": threading.Event()}
        with self.lock:
            if len(self.pending) >= 16:
                raise ACPError("ACP backlog")
            self.pending[request_id] = pending
        try:
            self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            if not pending["event"].wait(self.config.get("timeout_seconds", 180)):
                self.cancel()
                raise ACPTimeout("ACP request timed out; not replayed")
            if "error" in pending:
                if pending.get("disconnected"):
                    raise ACPDisconnected("ACP disconnected")
                raise ACPError("ACP request failed")
            return pending.get("result", {})
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def _read(self):
        try:
            for line in iter(lambda: self.process.stdout.readline(262145), ""):
                if len(line.encode()) > 262144:
                    raise ACPError("ACP event too large")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ACPError("ACP envelope must be an object")
                if "method" not in message and "id" in message:
                    with self.lock:
                        pending = self.pending.get(message["id"])
                        if pending:
                            pending.update(message)
                            pending["event"].set()
                    continue
                if message.get("method") == "session/update":
                    params = message.get("params", {})
                    self.session_update(params.get("sessionId"), params.get("update", {}))
                elif "id" in message:
                    # 中文注释：协作进程不能自动批准终端/编辑/其他敏感确认，也不提供文件系统旁路。
                    if message.get("method") == "session/request_permission":
                        self._send(
                            {
                                "jsonrpc": "2.0",
                                "id": message["id"],
                                "result": {"outcome": self.permission(message.get("params", {}))},
                            }
                        )
                    else:
                        self._send(
                            {
                                "jsonrpc": "2.0",
                                "id": message["id"],
                                "error": {
                                    "code": -32601,
                                    "message": "Client operation unavailable",
                                },
                            }
                        )
        except (OSError, ValueError, TypeError, ACPError) as exc:
            self.failure = type(exc).__name__
        finally:
            if not self.closed:
                code = self.process.poll()
                if code is None:
                    try:
                        code = self.process.wait(timeout=0.1)
                    except subprocess.TimeoutExpired:
                        pass
                self.transport_failure = {
                    "reason": "acp_process_exited" if code is not None else "acp_disconnected",
                    "error_type": self.failure or "ACPDisconnected",
                    "stderr_tail": self.stderr_log.finish(),
                }
                if code is not None:
                    self.transport_failure["exit_code"] = code
            with self.lock:
                for pending in self.pending.values():
                    pending["error"] = {"message": "ACP disconnected"}
                    pending["disconnected"] = True
                    pending["event"].set()
            if not self.closed:
                self.on_update(
                    {"sessionUpdate": "copilot_transport_error", **self.transport_failure}
                )

    def permission(self, params):
        return {"outcome": "cancelled"}

    def session_update(self, session_id, update):
        if session_id != self.session:
            return
        if update.get("sessionUpdate") == "agent_message_chunk":
            content = update.get("content", {})
            if content.get("type") == "text":
                key = update.get("messageId", "current")
                with self.lock:
                    text = self.messages.get(key, "") + content.get("text", "")
                    if len(text.encode()) > 65536:
                        raise ACPError("ACP message exceeds budget")
                    self.messages[key] = text
        if update.get("sessionUpdate") == "usage_update":
            self.context_tokens = max(0, int(update.get("used", 0)))
        self.on_update(update)

    def new_session(self, verify=True):
        result = self.call("session/new", {"cwd": self.cwd, "mcpServers": []})
        session = result.get("sessionId")
        if not isinstance(session, str) or not session:
            raise ACPError("ACP session/new returned no sessionId")
        self.session = session
        self.context_tokens = None
        self.last_usage = 0
        self.last_components = counts()
        self.model_state = result.get("models")
        self.active_model = (self.model_state or {}).get("currentModelId", "")
        if not verify:
            return session
        self.select_model(self.config.get("inference_model", ""))
        tools, _ = self.prompt("/tools")
        if tools.strip() != "No tools available.":
            raise ACPError("inference profile must expose zero tools")
        self.tools_verified = True
        return session

    def verify_policy(self):
        if not self.tools_verified:
            raise ACPError("Hermes zero-tool check missing")
        return {"status": "verified_zero_tools", "source": "hermes./tools"}

    def finish_session(self):
        self.prompt("/reset")
        return {"context_reset": True, "runtime_ended": False}

    def recover(self, saved=None):
        return self.new_session()

    def select_model(self, selected):
        target = selected or (self.model_state or {}).get("currentModelId", "")
        if target and target != self.active_model:
            self.call("session/set_model", {"sessionId": self.session, "modelId": target})
            self.active_model = target
            # 中文注释：Hermes 切模型会重建 agent，其累计用量从零开始；旧量已记入协作账本。
            self.last_usage = 0
            self.last_components = counts()

    def prompt(self, text):
        with self.turn_lock:
            with self.lock:
                self.messages.clear()
            started = time.monotonic()
            result = self.call(
                "session/prompt",
                {"sessionId": self.session, "prompt": [{"type": "text", "text": text}]},
            )
            if result.get("stopReason") != "end_turn":
                raise ACPError("ACP turn did not complete")
            with self.lock:
                messages = list(self.messages.values())
            final = messages[-1] if messages else ""
            usage = result.get("usage")
            detailed = isinstance(usage, dict) and all(
                type(usage.get(key)) is int
                for key in ("inputTokens", "cachedReadTokens", "outputTokens")
            )
            if detailed:
                current = counts(
                    usage["inputTokens"], usage["cachedReadTokens"], usage["outputTokens"]
                )
                delta = {key: max(0, current[key] - self.last_components[key]) for key in current}
                # 中文注释：ACP inputTokens 来自 prompt_tokens，包含缓存；stream-json input 则已经是不含缓存的输入。
                components = counts(
                    max(0, delta["input"] - delta["cache_read"]),
                    delta["cache_read"],
                    delta["output"],
                )
                self.last_components = current
            else:
                components = None
            if isinstance(usage, dict) and type(usage.get("totalTokens")) is int:
                reported = max(0, usage["totalTokens"])
                if reported < self.last_usage:
                    raise ACPError("cumulative usage counter moved backwards")
                tokens = reported - self.last_usage
                self.last_usage = reported
                source = "acp.usage.totalTokens.delta"
            else:
                tokens = (len(text.encode()) + len(final.encode()) + 3) // 4
                source = "estimated_utf8_bytes/4"
            if text.startswith("/") and not isinstance(usage, dict):
                tokens, source = 0, "acp.local_control"
            if detailed:
                source = "acp.usage.components.delta"
            components = components if components is not None else counts(tokens)
            return final, {
                "model": self.active_model or "unknown",
                "tokens": sum(components.values()),
                "usage": components,
                "estimated": not detailed,
                "context_tokens": self.context_tokens,
                "source": source,
                "cumulative_tokens": self.last_usage,
                "input_bytes": len(text.encode()),
                "estimated_input_tokens": (len(text.encode()) + 3) // 4,
                "seconds": time.monotonic() - started,
            }

    def cancel(self):
        if self.session and not self.closed:
            try:
                self._send(
                    {
                        "jsonrpc": "2.0",
                        "method": "session/cancel",
                        "params": {"sessionId": self.session},
                    }
                )
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
        tail = self.stderr_log.finish()
        process.stderr.close()
        if self.transport_failure is None:
            self.exit_observer(
                {
                    "reason": "acp_process_exited",
                    "exit_code": process.returncode,
                    "stderr_tail": tail,
                    "close_requested": True,
                    "phase": self.config.get("stderr_role", "inference"),
                }
            )
