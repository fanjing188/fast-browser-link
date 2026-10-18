"""只读协作采集、建议调度和 Hermes 子进程；不授予任何浏览器执行权限。"""

from __future__ import annotations

from copilot_acp import ACP, ACPError
from copilot_adapters import adapter
from copilot_diagnostics import ModelOutputInvalid, failure, failure_message
from copilot_journal import Journal
from copilot_health import health
from copilot_usage import counts, from_metrics, add
from copilot_exec_acp import compact_memory
from copilot_fetch import Fetcher
from copilot_tables import TableStore
from copilot_directories import Directories, METHODS as DIRECTORY_METHODS, export_directory
from copilot_agents import Agents, METHODS as AGENT_METHODS
from copilot_packages import Packages
from copilot_tools import ToolSupport
from copilot_results import (
    compose,
    legacy,
    export_rows,
    words as result_words,
    report as result_report,
    COMMON,
    decision_schema,
)
from copilot_models import catalogs, settings as validate_settings, SETTING_KEYS
from copilot_execution import (
    Executions,
    ExecutionError,
    execution_argv,
    retain_tool_receipt,
    RERUN_WARNING,
)

import csv
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid
import sys
import unicodedata
from datetime import date, timedelta
from urllib.parse import urlsplit


from copilot_contracts import (
    DEFAULTS,
    SEO_ACTIONS,
    private_write,
    canonical,
    suggestion_id,
    validate,
    check_schema,
    object_key,
    Templates,
)
from copilot_state import work_state, work_context, result_context
from copilot_observation import ObservationSupport
from copilot_inference import (
    inference_prompt,
    parse_model_json,
    model_json_prompt,
    inference_session_prompt,
    InferenceSupport,
)
from copilot_result_actions import ResultSupport


class Copilot(ObservationSupport, InferenceSupport, ResultSupport, ToolSupport):
    RECOVERY_BACKOFF = (1, 2, 4)

    def __init__(self, directory, notify=lambda *_: None, debounce=1.5, clock=time.monotonic):
        self.directory = Path(directory)
        path = self.directory / "config.json"
        self.config = {**DEFAULTS, **(json.loads(path.read_text()) if path.exists() else {})}
        self.silent_token = uuid.uuid4().hex
        self.config["copilot_silent_token"] = self.silent_token
        for key in ("daily_token_budget", "cache_weight"):
            self.config.pop(key, None)
        for key, lower, upper in [("max_turns", 1, 1000)]:
            if type(self.config[key]) is not int or not lower <= self.config[key] <= upper:
                raise ValueError("invalid Assist config: " + key)
        validate_settings({key: self.config[key] for key in SETTING_KEYS})
        if not isinstance(self.config["fetch_commands"], dict) or not isinstance(
            self.config["fetch_dir"], str
        ):
            raise ValueError("invalid fetch configuration")
        self.tables = TableStore(self.directory, self.config, private_write)
        self.directories = Directories(self.directory)
        if (
            type(self.config["table_max_pages"]) is not int
            or not 1 <= self.config["table_max_pages"] <= 200
        ):
            raise ValueError("invalid table page limit")
        if (
            any(
                type(self.config[k]) not in (int, float)
                or not math.isfinite(self.config[k])
                or not 0.1 <= self.config[k] <= 60
                for k in ("table_delay_min", "table_delay_max")
            )
            or self.config["table_delay_min"] > self.config["table_delay_max"]
        ):
            raise ValueError("invalid table pacing")
        if any(
            type(self.config[key]) is not bool for key in ("page_annotations", "auto_zero")
        ) or self.config["annotation_density"] not in {"compact", "full"}:
            raise ValueError("invalid annotation or automatic preferences")
        if not isinstance(self.config["extension_dirs"], list) or any(
            not isinstance(path, str) for path in self.config["extension_dirs"]
        ):
            raise ValueError("invalid extension directories")
        self.adapter_config = {
            key: copy.deepcopy(self.config[key])
            for key in ("fetch_commands", "pool_command", "pool_lookup_command")
        }
        local_extensions = (
            [
                str(path.parent)
                for path in sorted((self.directory / "extensions").glob("*/package.json"))
            ]
            if (self.directory / "extensions").is_dir()
            else []
        )
        self.packages = Packages(
            list(dict.fromkeys([*self.config["extension_dirs"], *local_extensions])),
            include_builtin=not self.config.get("managed_packs", False),
        )
        self.packages.configure(self.config)
        self.templates = Templates(self.directory / "templates", self.packages)
        self.templates.capabilities = {
            "domain_rating": bool(self.config["fetch_commands"].get("domain_rating"))
        }
        self.browser_fetches = {}
        self.recent_path = self.directory / "recent-results.json"
        self.recent = []
        try:
            if (
                not self.recent_path.is_symlink()
                and self.recent_path.stat().st_size <= 16 * 1024 * 1024
            ):
                recent = json.loads(self.recent_path.read_text())
                if isinstance(recent, list):
                    self.recent = [
                        item
                        for item in recent[-100:]
                        if isinstance(item, dict)
                        and type(item.get("finished_at")) in (int, float)
                        and 0 <= time.time() - item["finished_at"] <= 7 * 86400
                    ]
        except (OSError, ValueError, TypeError):
            pass
        self.lock = threading.RLock()
        self.catalog_lock = threading.Lock()
        self.clock, self.debounce, self.notify = clock, debounce, notify
        self.states = {}
        self.active = None
        self._initialize_tools()
        from copilot_basket import Basket
        from copilot_annotations import AnnotationMemory
        from fbl_runtime import private_write as atomic_write

        self.annotation_memory = AnnotationMemory(self.directory, atomic_write)
        if not self.annotation_memory.records:
            for record in self.recent:
                try:
                    validate(
                        record["result"], self.templates.get(record["action"])["result_schema"]
                    )
                    self.annotation_memory.result(record)
                except (ValueError, KeyError, TypeError):
                    continue
        self.basket = Basket(self, atomic_write)
        self.external_confirmations = {}
        self.closed = False
        self.agents = Agents(self)
        self.discovery_worker = None
        self.runtime = None
        self.executions = Executions(
            self.config,
            self.directory,
            lambda detail: self.journal.add(self.active, "process_exit", **detail),
        )
        self.acp_executions = None
        self.fetcher = Fetcher(self.config)
        self.inference_lock = threading.Lock()
        self.ignored_path = self.directory / "ignored.json"
        self.ignored = (
            json.loads(self.ignored_path.read_text()) if self.ignored_path.exists() else {}
        )
        self.usage_path = self.directory / "usage.json"
        self.daily = (
            json.loads(self.usage_path.read_text())
            if self.usage_path.exists()
            else {"date": date.today().isoformat(), "tokens": 0, "usage": counts()}
        )
        if "usage" not in self.daily:
            self.daily["usage"] = counts(self.daily.get("tokens", 0))
            self.daily["estimated_tokens"] = self.daily.get("tokens", 0)
        if "models" not in self.daily:
            self.daily["models"] = (
                {"unknown": dict(self.daily["usage"])} if sum(self.daily["usage"].values()) else {}
            )
        self.notifications = queue.Queue(maxsize=256)
        self.worker = threading.Thread(target=self._notify_loop, daemon=True)
        self.housekeeping = threading.Event()
        self.monitor = threading.Thread(target=self._monitor, daemon=True)
        self.log_tasks = {}
        self.log_connections = {}
        self.journal = Journal(self.directory, private_write, self._journal_batch)
        self.templates.on_error = lambda action, reason: self.journal.add(
            self.active,
            "template_disabled",
            error=True,
            action=action,
            reason="invalid_template",
            error_type=reason,
        )
        self.worker.start()
        self.monitor.start()

    def _state(self, instance):
        if instance not in self.states:
            self.states[instance] = {
                "enabled": False,
                "show_ball": self.config["show_ball"],
                "selection_popup": self.config["selection_popup"],
                "locale": "zh",
                "page_context": {},
                "selection_text": "",
                "selected_object": "",
                "tool_context": {},
                "focused_result": None,
                "ready": False,
                "trace": [],
                "page": {},
                "sent_tool_context": {},
                "sent_trace": [],
                "sent_page": {},
                "sent_status": {},
                "suggestions": {},
                "timer": None,
                "work": work_state(),
                "user_direction": "",
                "work_feedback": [],
                "work_revision": 0,
                "sent_work": None,
                "work_id": uuid.uuid4().hex,
                "work_started_at": 0,
                "work_reset": False,
                "result_updates": [],
                "sent_results": [],
                "running": False,
                "dirty": False,
                "last_refresh": None,
                "last_inference": float("-inf"),
                "last_work_activity": None,
                "last_activity": self.clock(),
                "page_since": self.clock(),
                "dwell_sent": False,
                "idle_paused": False,
                "model_usage": {},
                "usage": counts(),
                "revision": 0,
                "diagnostic": None,
                "startup_error": None,
                "inference_failure": None,
                "inference_failures": 0,
                "inference_restarts": 0,
                "recovering": False,
                "summary": "",
                "execution_diagnostic": None,
                "tokens": 0,
                "estimated_tokens": 0,
                "token_source": "estimated_utf8_bytes/4",
                "context_tokens": 0,
                "input_metrics": [],
                "result_history": [],
                "pool_words": [],
                "execution_memory": [],
                "completion_status": [],
                "sent_completions": [],
                "held_suggestions": set(),
                "epoch": 0,
                "context_revision": 0,
            }
        return self.states[instance]

    def _notify_loop(self):
        while True:
            item = self.notifications.get()
            if item is None:
                return
            try:
                self.notify(*item)
            except (OSError, KeyError, RuntimeError):
                pass

    def _journal_batch(self, instance, value):
        with self.lock:
            if instance is not None:
                self._emit(
                    instance,
                    "logs",
                    log_revision=value["revision"],
                    **{key: item for key, item in value.items() if key != "revision"},
                )
            else:
                for identity in self.states:
                    self._emit(identity, "logs", error="event_log_write_failed")

    def _journal_event(self, instance, event, values):
        if not hasattr(self, "journal"):
            return
        if event == "configuration":
            self.journal.add(instance, "configuration", changes=values.get("changes", []))
        elif event == "ready":
            self.journal.add(instance, "connected")
        elif event == "settings":
            enabled = values.get("enabled", self._state(instance)["enabled"])
            if self.log_connections.get(instance, False) != enabled:
                self.log_connections[instance] = enabled
                self.journal.add(
                    instance,
                    "connecting" if enabled else "disconnected",
                    reason=values.get("reason", "transport_error"),
                )
            if values.get("reason") == "idle_closed":
                self.journal.add(instance, "idle")
        elif event == "idle":
            self.journal.add(instance, "idle")
        elif event == "diagnostic":
            self.journal.add(
                instance, "error", error=True, reason=values.get("message", "").split(";", 1)[0]
            )
        elif event == "capabilities":
            capabilities = self.registry.inspect(self._tool_context(instance))
            statuses = {}
            for capability, info in capabilities.items():
                waiting = any(
                    row["status"]
                    in {
                        "needs_browser_check",
                        "needs_login_or_readable_report",
                        "needs_route_confirmation",
                        "wrong_browser",
                    }
                    for row in info["bindings"]
                )
                statuses[capability] = (
                    "available"
                    if info["status"] == "available"
                    else "waiting"
                    if waiting
                    else "missing"
                )
            totals = list(statuses.values())
            self.journal.add(
                instance,
                "capabilities",
                total=len(totals),
                available=totals.count("available"),
                waiting=totals.count("waiting"),
                missing=totals.count("missing"),
                capability_statuses=statuses,
            )
        elif event == "progress":
            progress = values.get("progress", {})
            phase = progress.get("type")
            self.journal.add(
                instance,
                "execute_step",
                task_id=values.get("id", ""),
                provider=progress.get("provider")
                or (progress.get("name", "") if phase == "fetch" else ""),
                phase=phase
                if phase in {"tool_use", "model", "fetch", "fetch_start", "fetch_done"}
                else "step",
                step_name=progress.get("name", ""),
                step_index=progress.get("step_index", 1),
                count=progress.get("count", 0),
                capability=progress.get("capability", ""),
                duration_ms=progress.get("duration_ms", 0),
            )
        elif event == "update" and values.get("suggestion"):
            row = values["suggestion"]
            identity = (instance, row["id"])
            status = row["status"]
            signature = (status, row.get("step"))
            previous = self.log_tasks.get(identity)
            self.log_tasks[identity] = signature
            if len(self.log_tasks) > 2000:
                self.log_tasks.pop(next(iter(self.log_tasks)))
            if previous == signature:
                return
            event_name = {
                "executing": "execute_start",
                "completed": "execute_complete",
                "failed": "execute_failed",
                "stopped": "execute_stop",
            }.get(status)
            if previous and previous[0] == status:
                event_name = None
            if event_name:
                terminal = status in {"completed", "failed", "stopped"}
                metrics = {}
                if status in {"completed", "failed"} and row.get("model_source") != "local":
                    self._state(instance)["last_call_succeeded"] = status == "completed"
                if terminal:
                    metrics.update(
                        tokens=row.get("tokens", 0), estimated=bool(row.get("estimated_tokens"))
                    )
                    if row.get("started_at"):
                        metrics["duration_ms"] = max(
                            0, (row.get("finished_at", time.time()) - row["started_at"]) * 1000
                        )
                result = row.get("result")
                self.journal.add(
                    instance,
                    event_name,
                    error=status == "failed",
                    task_id=row["id"],
                    action=row["action"],
                    completion_status=row.get("completion_status", "completed"),
                    missing=len(result.get("missing", [])) if isinstance(result, dict) else 0,
                    phase="workflow" if row["action"] == "workflow.run" else "task",
                    automatic=row.get("automatic", False),
                    **row.get("failure", {}),
                    **metrics,
                )

    def _display_row(self, row):
        row = {
            key: value
            for key, value in row.items()
            if key
            not in {"basket_plan", "workflow_checkpoint", "fetch_checkpoint", "ranking_checkpoint"}
        }
        if row.get("action") != "workflow.run" or not row.get("result"):
            return row
        result = row["result"]
        return {
            **row,
            "result_deferred": True,
            "result_token": hashlib.sha256(
                json.dumps(result, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()[:20],
            "result": {
                key: result[key]
                for key in ("verdict", "level", "metrics", "missing")
                if key in result
            },
        }

    def _emit(self, instance, event_type, **values):
        state = self._state(instance)
        state["revision"] += 1
        self._journal_event(instance, event_type, values)
        if values.get("suggestion"):
            values["suggestion"] = self._display_row(values["suggestion"])
        try:
            self.notifications.put_nowait(
                (instance, {"type": event_type, "revision": state["revision"], **values})
            )
        except queue.Full:
            state["diagnostic"] = "notification_backlog; refresh dashboard"

    def view(self, instance):
        with self.lock:
            state = self._state(instance)
            self._refresh_daily()
            keys = (
                "enabled",
                "show_ball",
                "selection_popup",
                "locale",
                "selection_text",
                "focused_result",
                "ready",
                "running",
                "last_refresh",
                "revision",
                "diagnostic",
                "tokens",
                "estimated_tokens",
                "token_source",
                "context_tokens",
                "idle_paused",
                "input_metrics",
                "usage",
                "model_usage",
                "result_history",
                "pool_words",
                "context_revision",
                "work",
                "user_direction",
                "work_feedback",
                "work_revision",
            )
            return json.loads(
                json.dumps(
                    {key: state[key] for key in keys}
                    | {
                        "suggestions": [
                            self._display_row(row) for row in state["suggestions"].values()
                        ],
                        "daily_tokens": self.daily["tokens"],
                        "daily_usage": self.daily["usage"],
                        "daily_estimated_tokens": self.daily.get("estimated_tokens", 0),
                        "diagnostic": state["diagnostic"] or state.get("execution_diagnostic"),
                        "result_history": [
                            {
                                key: item[key]
                                for key in ("id", "title", "action", "finished_at", "status")
                                if key in item
                            }
                            | {
                                "result": {
                                    "verdict": item.get("result", {}).get("verdict", "历史结果")
                                }
                            }
                            for item in state["result_history"]
                        ],
                        "daily_model_usage": self.daily.get("models", {}),
                        "capability_focus": state.get("capability_focus", 0),
                        "tool_context": state.get("tool_context", {}),
                        "protected_hosts": list(self._resource_policy()),
                        "config": {key: self.config[key] for key in SETTING_KEYS},
                        "settings_saved": self.config["settings_saved"],
                        "capabilities": {
                            "domain_rating": bool(
                                self.config["fetch_commands"].get("domain_rating")
                            ),
                            "pool": bool(self.config["pool_command"]),
                        },
                        "basket": self.basket.snapshot(),
                        "page_annotations": self.config["page_annotations"],
                        "annotation_density": self.config["annotation_density"],
                        "auto_zero": self.config["auto_zero"],
                        "board_name": self.config["board_name"],
                        "startup_error": state.get("startup_error"),
                        "inference_failure": state.get("inference_failure"),
                        "inference_failures": state["inference_failures"],
                        "recovering": state["recovering"],
                        "discovery_changed": state.get("discovery_changed", False),
                        "daemon_recovery": True,
                        "bridge_restored": state.get("bridge_restored", False),
                        "bridge_recovery_blocked": state.get("bridge_recovery_blocked", False),
                        "execution_health": {
                            "state": "connected"
                            if self.acp_executions
                            and self.acp_executions.runtime
                            and not self.acp_executions.runtime.closed
                            and not self.acp_executions.runtime.failure
                            else "disconnected"
                        },
                        "template_warning": len(self.templates.disabled),
                        "hermes_health": health(
                            self.config,
                            {**state, "template_warning": len(self.templates.disabled)},
                            self.runtime,
                        ),
                        "agent": self.agents.summary(
                            health(
                                self.config,
                                {**state, "template_warning": len(self.templates.disabled)},
                                self.runtime,
                            )
                        ),
                        "table_export_dir": self.config["table_export_dir"],
                        "table_config": {
                            "max_pages": self.config["table_max_pages"],
                            "delay_min": self.config["table_delay_min"],
                            "delay_max": self.config["table_delay_max"],
                        },
                    }
                )
            )

    def _refresh_daily(self):
        if self.daily["date"] != date.today().isoformat():
            self.daily = {
                "date": date.today().isoformat(),
                "tokens": 0,
                "usage": counts(),
                "models": {},
            }

    def _account(self, instance, metrics, task=None):
        state = self._state(instance)
        today = date.today().isoformat()
        if self.daily["date"] != today:
            self.daily = {"date": today, "tokens": 0, "usage": counts()}
        usage = from_metrics(metrics)
        add(state["usage"], usage)
        add(self.daily["usage"], usage)
        model = metrics.get("model") or (task or {}).get("model") or "unknown"
        add(state["model_usage"].setdefault(model, counts()), usage)
        add(self.daily.setdefault("models", {}).setdefault(model, counts()), usage)
        state["tokens"] += sum(usage.values())
        if metrics.get("estimated") or metrics["source"].startswith("estimated"):
            state["estimated_tokens"] += metrics["tokens"]
            self.daily["estimated_tokens"] = (
                self.daily.get("estimated_tokens", 0) + metrics["tokens"]
            )
        state["token_source"] = metrics["source"]
        self.daily["tokens"] += metrics["tokens"]
        if task is None:
            current = getattr(self.runtime, "context_tokens", None)
            state["context_tokens"] = (
                current
                if current is not None
                else state["context_tokens"]
                + metrics.get("estimated_input_tokens", 0)
                + usage["output"]
            )
        state["input_metrics"] = (state["input_metrics"] + [metrics])[-30:]
        if task:
            if "usage" not in task:
                task["usage"] = counts()
            add(task["usage"], usage)
            task["tokens"] = sum(task["usage"].values())
            if metrics.get("estimated") or metrics["source"].startswith("estimated"):
                task["estimated_tokens"] = task.get("estimated_tokens", 0) + metrics["tokens"]
        private_write(self.usage_path, json.dumps(self.daily))
        self._emit(instance, "usage", tokens=state["tokens"], source=state["token_source"])

    def _save_configuration(self, values):
        from fbl_runtime import private_write as atomic_write

        updated = {**self.config, **values}
        atomic_write(
            self.directory / "config.json",
            json.dumps(
                {
                    **{
                        key: value
                        for key, value in updated.items()
                        if key != "copilot_silent_token"
                    },
                    **self.adapter_config,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
        self.config.update(values)

    def request(self, instance, method, params):
        if method in AGENT_METHODS:
            return self.agents.request(instance, method, params)
        if method in DIRECTORY_METHODS:
            return self.directories.request(instance, method, params)
        if method.startswith("basket_") or method == "annotation_lookup":
            return self._basket_request(instance, method, params)
        if method == "fbl_save_flow" and isinstance(params, dict):
            from fbl_pack_authoring import save_flow

            return save_flow(self, instance, params)
        if method.startswith("fbl_") and isinstance(params, dict):
            from fbl_panel import request

            return request(self, method, params)
        if (
            method == "models"
            and isinstance(params, dict)
            and not set(params) - {"refresh"}
            and type(params.get("refresh", False)) is bool
        ):
            with self.lock:
                if self.closed:
                    raise ValueError("Assist closed")
                config = dict(self.config)
                runtime = self.runtime
            with self.catalog_lock:
                return catalogs(
                    config,
                    self.directory,
                    private_write,
                    force=params.get("refresh", False),
                    runtime=runtime,
                )
        if not isinstance(params, dict):
            raise ValueError("invalid Assist request")
        with self.lock:
            if self.closed:
                raise ValueError("Assist closed")
            state = self._state(instance)
            if method == "work_update":
                if (
                    set(params) == {"direction"}
                    and isinstance(params["direction"], str)
                    and len(params["direction"]) <= 500
                ):
                    from copilot_diagnostics import redact_page

                    state["user_direction"] = redact_page(params["direction"].strip())
                elif set(params) == {"reset"} and params["reset"] is True:
                    for row in list(state["suggestions"].values()):
                        row.setdefault("work_id", state["work_id"])
                        if row["status"] == "pending" and not row.get("explicit"):
                            del state["suggestions"][row["id"]]
                            state["held_suggestions"].discard(row["id"])
                            self._emit(instance, "remove", id=row["id"])
                    state.update(
                        work=work_state(),
                        user_direction="",
                        work_feedback=[],
                        work_id=uuid.uuid4().hex,
                        work_started_at=time.time() * 1000,
                        work_reset=True,
                        summary="",
                        trace=[],
                        execution_memory=[],
                        completion_status=[],
                        result_updates=[],
                        sent_results=[],
                        sent_work=None,
                    )
                else:
                    raise ValueError("invalid work update")
                state["work_revision"] += 1
                self._emit(instance, "work")
                self._schedule(instance)
                return self.view(instance)
            if (
                method == "feedback"
                and set(params) == {"id", "kind"}
                and isinstance(params["id"], str)
                and isinstance(params["kind"], str)
                and params["kind"] in {"wrong", "later", "done"}
            ):
                row = state["suggestions"].get(params["id"])
                if not row or row["status"] != "pending":
                    raise ValueError("suggestion unavailable")
                from copilot_diagnostics import redact_page

                feedback = redact_page(
                    {
                        "id": row["id"],
                        "kind": params["kind"],
                        "action": row["action"],
                        "object": str(
                            row["params"].get("keyword")
                            or row["params"].get("url")
                            or row["params"].get("object")
                            or row["title"]
                        )[:300],
                    }
                )
                state["work_feedback"] = (state["work_feedback"] + [feedback])[-8:]
                state["work_revision"] += 1
                del state["suggestions"][row["id"]]
                state["held_suggestions"].discard(row["id"])
                self._emit(instance, "remove", id=row["id"])
                self._schedule(instance)
                return self.view(instance)
            if method in {"logs_read", "logs_clear", "logs_export"} and not params:
                return {
                    "logs_read": self.journal.view,
                    "logs_clear": self.journal.clear,
                    "logs_export": self.journal.export,
                }[method](instance)
            if (
                method == "log_client"
                and not set(params) - {"event", "tables", "rows"}
                and params.get("event") in {"disconnected", "reconnected", "table"}
            ):
                self.journal.add(
                    instance,
                    params["event"],
                    phase="bridge",
                    **{key: params[key] for key in ("tables", "rows") if key in params},
                )
                return {"accepted": True}
            if (
                method == "bridge_error"
                and set(params) == {"message", "disconnected_at"}
                and isinstance(params["message"], str)
                and len(params["message"]) <= 2048
                and type(params["disconnected_at"]) in (int, float)
            ):
                from copilot_diagnostics import redact

                state["bridge_error"] = redact(params["message"])[:300]
                self.journal.add(
                    instance,
                    "bridge_disconnect",
                    error=True,
                    bridge_error=state["bridge_error"],
                    disconnected_at=params["disconnected_at"],
                )
                return {"accepted": True}
            if method.startswith("capability_") or method in {
                "tool_draft",
                "tool_learn_context",
                "tool_save",
            }:
                return self._tool_request(instance, method, params)
            if method == "resource_check":
                return {
                    "allowed": self.resource_allowed(
                        instance, params["url"], task_id=params.get("taskId")
                    )
                }
            if method == "locale" and set(params) == {"language"}:
                state["locale"] = "zh" if str(params["language"]).lower().startswith("zh") else "en"
                self.templates.language = state["locale"]
                return self.view(instance)
            if (
                method == "page_context"
                and {"url", "incognito"} <= params.keys()
                and not params.keys() - {"url", "incognito", "tab_id"}
            ):
                parsed = urlsplit(params["url"])
                if (
                    parsed.scheme not in {"https", "http"}
                    or not parsed.hostname
                    or parsed.username
                    or parsed.password
                    or len(params["url"]) > 8192
                    or type(params["incognito"]) is not bool
                ):
                    raise ValueError("invalid page context")
                if "tab_id" in params and type(params["tab_id"]) is not int:
                    raise ValueError("invalid page context")
                if any(state.get("page_context", {}).get(key) != params[key] for key in params):
                    state["selected_object"] = ""
                    state["selection_text"] = ""
                    state["table_summary"] = []
                    state["context_revision"] = state.get("context_revision", 0) + 1
                    state["context_dirty"] = True
                    for identity, row in list(state["suggestions"].items()):
                        if row.get("automatic"):
                            row["automatic"] = False
                            self._emit(instance, "update", suggestion=dict(row))
                        if row["status"] == "pending" and not row.get("explicit"):
                            del state["suggestions"][identity]
                            state["held_suggestions"].discard(identity)
                            self._emit(instance, "remove", id=identity)
                    self._emit(instance, "context")
                state["page_context"] = {**state.get("page_context", {}), **params}
                return {"accepted": True}
            if (
                method == "selection_context"
                and set(params) == {"text"}
                and isinstance(params["text"], str)
                and len(params["text"]) <= 12000
            ):
                state["selection_text"] = params["text"]
                self._emit(instance, "selection")
                return self.view(instance)
            if method == "focus_result" and set(params) == {"id"}:
                self.request(instance, "result", params)
                state["focused_result"] = params["id"]
                self._emit(instance, "focus_result", id=params["id"])
                return self.view(instance)
            if method == "selection_info":
                return self._selection_info(instance, params)
            if method == "quick_task":
                return self._quick_task(instance, params)
            if method == "browser_fetch_status" and set(params) == {"id"}:
                pending = self.browser_fetches.get(params["id"])
                return {
                    "allowed": bool(
                        pending
                        and pending["instance"] == instance
                        and pending["epoch"] == state["epoch"]
                        and (self._valid(instance, pending["epoch"]) or pending.get("readonly"))
                        and pending["job_key"] not in self.fetcher.cancelled
                    )
                }
            if method == "browser_fetch_chunk":
                pending = self.browser_fetches.get(params.get("id"))
                if (
                    not pending
                    or pending["instance"] != instance
                    or pending["epoch"] != state["epoch"]
                    or pending.get("readonly")
                    or set(params) != {"id", "index", "text"}
                    or not isinstance(params["text"], str)
                    or len(params["text"].encode()) > 200000
                    or params["index"] != len(pending.setdefault("chunks", []))
                ):
                    raise ValueError("invalid browser chunk")
                total = pending.get("chunk_bytes", 0) + len(params["text"].encode())
                if total > 4194304:
                    pending["data"] = {"error": "browser_data_too_large"}
                    pending["event"].set()
                    return {"accepted": False}
                pending["chunks"].append(params["text"])
                pending["chunk_bytes"] = total
                return {"accepted": True}
            if method == "browser_fetch_result":
                pending = self.browser_fetches.get(params.get("id"))
                if (
                    not pending
                    or pending["instance"] != instance
                    or pending["epoch"] != state["epoch"]
                    or pending["event"].is_set()
                    or set(params) != {"id", "data"}
                ):
                    raise ValueError("stale browser fetch")
                if params["data"] == {"chunked": True}:
                    if not pending.get("chunks"):
                        raise ValueError("missing browser chunks")
                    pending["data"] = json.loads("".join(pending.pop("chunks")))
                    pending["event"].set()
                    return {"accepted": True}
                if len(json.dumps(params["data"]).encode()) > 131072:
                    pending["data"] = {"error": "browser_data_too_large"}
                    pending["event"].set()
                    return {"accepted": False, "reason": "browser_data_too_large"}
                pending["data"] = params["data"]
                pending["event"].set()
                return {"accepted": True}
            if method == "table_activity" and not params:
                state["last_work_activity"] = self.clock()
                return {"accepted": True}
            if method.startswith("table_"):
                if method == "table_open":
                    if (
                        set(params) - {"id", "folder"}
                        or type(params.get("folder", False)) is not bool
                    ):
                        raise ValueError("invalid file open")
                    self.tables.open(instance, params["id"], params.get("folder", False))
                    return self.view(instance)
                if method == "table_column_action":
                    selected = self.tables.request(
                        instance, "table_column", {"id": params["id"], "column": params["column"]}
                    )["keywords"]
                    key = "table-" + params["id"]
                    if key not in state["suggestions"]:
                        state["suggestions"][key] = {
                            "id": key,
                            "status": "completed",
                            "action": "table.export",
                            "params": {},
                            "title": "表格导出",
                            "result": {
                                "verdict": "本机已保存的表格",
                                "level": "info",
                                "metrics": [],
                                "missing": [],
                                "process": [],
                                "next": [],
                            },
                        }
                    return self._result_action(
                        instance,
                        "batch",
                        {"id": key, "operation": params["operation"], "keywords": selected},
                        known_override=selected,
                    )
                output = self.tables.request(instance, method, params)
                if method == "table_finish":
                    key = "table-" + output["id"]
                    state["suggestions"][key] = {
                        "id": key,
                        "action": "table.export",
                        "params": {},
                        "title": "表格已保存",
                        "status": "failed" if output.get("error") else "completed",
                        "reason": output.get("reason", ""),
                        "finished_at": time.time(),
                        "result": {
                            "verdict": "已保存部分内容"
                            if output["partial"]
                            else "表格已保存到本机",
                            "level": "info",
                            "metrics": [
                                {"label": "行数", "value": str(output["rows"])},
                                {
                                    "label": "滚动批次" if output.get("unit") == "批" else "页数",
                                    "value": str(output["pages"]),
                                },
                            ],
                            "missing": [{"field": "rows", "reason": output["reason"]}]
                            if output["reason"]
                            else [],
                            "process": [],
                            "next": [],
                            "export": output,
                        },
                    }
                    self._emit(instance, "update", suggestion=dict(state["suggestions"][key]))
                return output
            if method == "export_results":
                row = state["suggestions"].get(params.get("id"))
                if row and row.get("result_view") and row.get("result"):
                    return self._export_generic_result(instance, row, params)
                if not row or set(params) - {"id", "keywords"}:
                    raise ValueError("result unavailable")
                selected = params.get("keywords")
                entries = export_rows(row["result"])
                if selected is not None:
                    if not isinstance(selected, list) or set(selected) - {
                        word["keyword"] for word in entries
                    }:
                        raise ValueError("invalid keyword filter")
                    positions = {word: i for i, word in enumerate(selected)}
                    entries = sorted(
                        [word for word in entries if word["keyword"] in positions],
                        key=lambda word: positions[word["keyword"]],
                    )
                begin = self.tables.request(
                    instance,
                    "table_begin",
                    {
                        "name": row["title"],
                        "site": "copilot",
                        "headers": ["关键词", "量", "KD", "分组", "来源", "缺数据原因"],
                    },
                )
                rows = [
                    [
                        {"text": str(word.get(field, ""))}
                        for field in ("keyword", "vol", "kd", "group", "source")
                    ]
                    + [
                        {
                            "text": (
                                ";".join(
                                    item["reason"] for item in row["result"].get("missing", [])
                                )
                                or "未提供指标"
                            )
                            if word.get("vol") is None and word.get("kd") is None
                            else ""
                        }
                    ]
                    for word in entries
                ]
                for index in range(0, len(rows), 100):
                    self.tables.request(
                        instance,
                        "table_append",
                        {"id": begin["id"], "rows": rows[index : index + 100]},
                    )
                return self.tables.request(
                    instance, "table_finish", {"id": begin["id"], "format": "csv"}
                )
            if method == "result" and set(params) == {"id"}:
                row = state["suggestions"].get(params["id"]) or next(
                    (r for r in state["result_history"] if r["id"] == params["id"]), None
                )
                if not row:
                    raise ValueError("result unavailable")
                return json.loads(json.dumps(row))
            if method == "clear_read" and not params:
                for key in list(state["suggestions"]):
                    if state["suggestions"][key]["status"] in {"completed", "failed", "stopped"}:
                        self._archive(state, state["suggestions"].pop(key))
                state["result_history"] = state["result_history"][-100:]
                self._emit(instance, "results_cleared")
                return self.view(instance)
            if method in {"batch", "replenish", "next_action"}:
                return self._result_action(instance, method, params)
            if (
                method == "preferences"
                and params
                and not set(params)
                - {
                    "board_name",
                    "table_export_dir",
                    "table_max_pages",
                    "table_delay_min",
                    "table_delay_max",
                    "page_annotations",
                    "annotation_density",
                    "auto_zero",
                }
            ):
                values = dict(params)
                for flag in ("page_annotations", "auto_zero"):
                    if flag in values and type(values[flag]) is not bool:
                        raise ValueError("invalid interface flag")
                if "annotation_density" in values and values["annotation_density"] not in {
                    "compact",
                    "full",
                }:
                    raise ValueError("invalid annotation density")
                for key in ("board_name", "table_export_dir"):
                    if key in values and (
                        not isinstance(values[key], str)
                        or len(values[key]) > (80 if key == "board_name" else 4096)
                        or any(ord(c) < 32 for c in values[key])
                    ):
                        raise ValueError("invalid preference")
                if "board_name" in values:
                    values["board_name"] = values["board_name"].strip()
                if "table_export_dir" in values:
                    values["table_export_dir"] = export_directory(values["table_export_dir"])
                if "table_max_pages" in values and (
                    type(values["table_max_pages"]) is not int
                    or not 1 <= values["table_max_pages"] <= 200
                ):
                    raise ValueError("invalid page limit")
                for key in ("table_delay_min", "table_delay_max"):
                    if key in values and (
                        type(values[key]) not in (int, float) or not 0.5 <= values[key] <= 60
                    ):
                        raise ValueError("invalid delay")
                if values.get("table_delay_min", self.config["table_delay_min"]) > values.get(
                    "table_delay_max", self.config["table_delay_max"]
                ):
                    raise ValueError("invalid delay range")
                self._save_configuration(values)
                self._emit(instance, "configuration", changes=list(values))
                return self.view(instance)
            if method == "configure":
                try:
                    values = {**validate_settings(params), "settings_saved": True}
                except ValueError:
                    self.journal.add(instance, "error", error=True, reason="invalid_configuration")
                    raise
                self._save_configuration(values)
                self._emit(instance, "configuration", changes=list(params))
                return self.view(instance)
            if (
                method == "suggestion_hold"
                and set(params) == {"id", "held"}
                and isinstance(params["id"], str)
                and type(params["held"]) is bool
            ):
                identity = params["id"]
                row = state["suggestions"].get(identity)
                if (
                    params["held"]
                    and row
                    and row["status"] == "pending"
                    and len(state["held_suggestions"]) < 10
                ):
                    state["held_suggestions"].add(identity)
                elif not params["held"]:
                    if identity:
                        state["held_suggestions"].discard(identity)
                    else:
                        state["held_suggestions"].clear()
                    if (
                        row
                        and row["status"] == "pending"
                        and row.get("misses", 0) >= 2
                        and self.clock() - row.get("first_seen", self.clock()) >= 30
                    ):
                        del state["suggestions"][identity]
                        self._emit(instance, "remove", id=identity)
                return self.view(instance)
            if method == "retry_inference" and not params:
                if state["enabled"] and state["ready"]:
                    self._schedule(instance)
                return self.view(instance)
            if method == "state" and not params:
                return self.view(instance)
            if (
                method == "settings"
                and params
                and not set(params) - {"enabled", "show_ball", "selection_popup"}
                and all(type(v) is bool for v in params.values())
            ):
                if params.get("enabled") and self.agents.busy():
                    raise ValueError("agent setup is running")
                interface = {
                    key: value
                    for key, value in params.items()
                    if key in {"show_ball", "selection_popup"}
                }
                if interface:
                    self._save_configuration(interface)
                    self.journal.add(instance, "configuration", changes=list(interface))
                if "show_ball" in params:
                    state["show_ball"] = params["show_ball"]
                if "selection_popup" in params:
                    state["selection_popup"] = params["selection_popup"]
                if params.get("enabled") is True and not state["enabled"]:
                    if self.active is not None:
                        raise ValueError("one collaboration session at a time")
                    self.silent_token = uuid.uuid4().hex
                    self.config["copilot_silent_token"] = self.silent_token
                    state.update(
                        bridge_lost=False,
                        bridge_connected_at=self.clock(),
                        bridge_restored=False,
                        bridge_recovery_blocked=False,
                        bridge_failures=0,
                        enabled=True,
                        selection_popup=params.get("selection_popup", True),
                        ready=False,
                        diagnostic=None,
                        startup_error=None,
                        inference_failure=None,
                        inference_failures=0,
                        inference_restarts=0,
                        recovering=False,
                        execution_diagnostic=None,
                        execution_memory=[],
                        last_activity=self.clock(),
                        activated_at=time.time(),
                        epoch=state["epoch"] + 1,
                    )
                    self.active = instance
                    threading.Thread(
                        target=self._activate, args=(instance, state["epoch"]), daemon=True
                    ).start()
                elif params.get("enabled") is True and state.get("bridge_recovery_blocked"):
                    state.update(bridge_recovery_blocked=False, bridge_failures=0)
                    self.bridge_connection(instance, True)
                elif params.get("enabled") is False:
                    self._deactivate(instance)
                    state.update(
                        diagnostic=None,
                        startup_error=None,
                        inference_failure=None,
                        execution_diagnostic=None,
                        last_call_succeeded=None,
                        bridge_lost=False,
                        bridge_failures=0,
                        bridge_recovery_blocked=False,
                        bridge_restored=False,
                    )
                self._emit(
                    instance,
                    "settings",
                    enabled=state["enabled"],
                    show_ball=state["show_ball"],
                    selection_popup=state["selection_popup"],
                    reason="user_closed" if params.get("enabled") is False else "transport_error",
                )
                return self.view(instance)
            if method == "observe" and set(params) == {"trace", "page"}:
                return self._observe(instance, params)
            if method in {"open_report", "save_result", "retry", "followup"}:
                if (
                    set(params)
                    - ({"id", "confirmation"} if method == "retry" else {"id", "action"})
                    or "id" not in params
                ):
                    raise ValueError("invalid result action")
                row = state["suggestions"].get(params["id"]) or next(
                    (item for item in state["result_history"] if item["id"] == params["id"]), None
                )
                if not row:
                    raise ValueError("result unavailable")
                if method == "open_report":
                    path = Path(row.get("report", ""))
                    if (
                        not path.is_file()
                        or any(part.is_symlink() for part in (path, *path.parents))
                        or path.parent != self._report_path(row["id"]).parent
                        or not path.name.endswith("-" + row["id"] + ".md")
                    ):
                        raise ValueError("report unavailable")
                    subprocess.run(
                        ["open" if sys.platform == "darwin" else "xdg-open", str(path)],
                        check=True,
                        timeout=5,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                elif method == "save_result":
                    if row.get("pool_saved") is True:
                        return self.view(instance)
                    return self._result_action(
                        instance,
                        "batch",
                        {
                            "id": row["id"],
                            "operation": "save",
                            "keywords": [word["keyword"] for word in result_words(row["result"])],
                        },
                    )
                elif method == "retry":
                    if row["action"] == "table.export":
                        dataset = row["result"]["export"]["id"]
                        record = self.tables.datasets[dataset]
                        output = self.tables.request(
                            instance,
                            "table_finish",
                            {
                                "id": dataset,
                                "format": record.get("format", "both"),
                                "pages": record["table"].get("pages", 1),
                                "partial": record["table"].get("partial", False),
                                "reason": record["table"].get("reason", ""),
                            },
                        )
                        row["result"]["export"] = output
                        row["status"] = "failed" if output.get("error") else "completed"
                        row["reason"] = output.get("reason", "")
                        self._emit(instance, "update", suggestion=dict(row))
                        return self.view(instance)
                    if row["status"] not in {"failed", "stopped"} and not (
                        row["status"] == "completed" and row.get("result", {}).get("missing")
                    ):
                        raise ValueError("task cannot be retried")
                    if row.get("rerun_warning"):
                        token = params.get("confirmation")
                        receipt = self.external_confirmations.get(token, {})
                        signature = hashlib.sha256(
                            json.dumps(
                                [row["params"], row.get("tool_receipts", [])], sort_keys=True
                            ).encode()
                        ).hexdigest()
                        if not (
                            receipt.get("purpose") == "rerun"
                            and receipt.get("instance") == instance
                            and receipt.get("id") == row["id"]
                            and receipt.get("epoch") == state["epoch"]
                            and receipt.get("signature") == signature
                            and time.time() - receipt["at"] < 120
                        ):
                            token = uuid.uuid4().hex
                            self.external_confirmations[token] = {
                                "purpose": "rerun",
                                "instance": instance,
                                "id": row["id"],
                                "epoch": state["epoch"],
                                "signature": signature,
                                "at": time.time(),
                            }
                            return {
                                "secondary_required": True,
                                "id": row["id"],
                                "token": token,
                                "command": "retry",
                                "message": row["rerun_warning"],
                            }
                        self.external_confirmations.pop(token)
                        self._archive(state, row)
                        row.pop("tool_receipts", None)
                        row.pop("rerun_warning", None)
                    elif row["status"] == "completed":
                        self._archive(state, row)
                    for field in (
                        "render_as",
                        "result",
                        "report",
                        "failure",
                        "judgment_failure",
                        "reason",
                        "completion_status",
                    ):
                        row.pop(field, None)
                    row.update(status="pending", error=None)
                    return self.request(instance, "execute", {"id": row["id"]})
                else:
                    action = params.get("action")
                    if action not in {"seo.longtail", "seo.keyword_check"}:
                        raise ValueError("unknown followup")
                    words = result_words(row.get("result", {}))
                    keyword = row["params"].get("keyword") or (
                        words[0].get("keyword") if words else None
                    )
                    if not keyword:
                        raise ValueError("keyword unavailable")
                    arguments = {"keyword": keyword}
                    key = suggestion_id(action, arguments)
                    if state["suggestions"].get(key, {}).get("status") in {
                        "pending",
                        "queued",
                        "executing",
                        "stopping",
                    }:
                        return self.view(instance)
                    state["suggestions"][key] = {
                        "id": key,
                        "title": ("拆长尾 " if action == "seo.longtail" else "检查 ")
                        + keyword[:15],
                        "why": "根据已有结果继续",
                        "action": action,
                        "params": arguments,
                        "scene": "seo",
                        "status": "pending",
                    }
                    self._emit(instance, "add", suggestion=dict(state["suggestions"][key]))
                return self.view(instance)
            if (
                method in {"execute", "ignore", "stop"}
                and not set(params) - {"id", "confirmation"}
                and "id" in params
            ):
                row = state["suggestions"].get(params["id"])
                if not row:
                    raise ValueError("suggestion unavailable")
                if method == "ignore" and row["status"] == "pending":
                    if row.get("tool_aware"):
                        self.registry.record(
                            row.get("tool"), row.get("page"), row["params"]["flow"], "ignored"
                        )
                    self.ignored[row["id"]] = date.today().isoformat()
                    private_write(self.ignored_path, json.dumps(self.ignored))
                    del state["suggestions"][row["id"]]
                    self._emit(instance, "remove", id=row["id"])
                    self._schedule(instance)
                elif method == "execute" and row["status"] == "pending":
                    from copilot_risk import action_risk

                    risk = action_risk(self, row)
                    row["risk"] = risk
                    if risk == "external":
                        receipt = self.external_confirmations.get(params.get("confirmation"))
                        if (
                            not receipt
                            or receipt["instance"] != instance
                            or receipt["id"] != row["id"]
                            or receipt["epoch"] != state["epoch"]
                            or receipt["signature"] != suggestion_id(row["action"], row["params"])
                            or time.time() - receipt["at"] > 120
                        ):
                            self.external_confirmations = dict(
                                list(
                                    {
                                        key: receipt
                                        for key, receipt in self.external_confirmations.items()
                                        if time.time() - receipt["at"] < 120
                                    }.items()
                                )[-63:]
                            )
                            token = uuid.uuid4().hex
                            self.external_confirmations[token] = {
                                "instance": instance,
                                "id": row["id"],
                                "epoch": state["epoch"],
                                "signature": suggestion_id(row["action"], row["params"]),
                                "at": time.time(),
                            }
                            return {
                                "secondary_required": True,
                                "token": token,
                                "id": row["id"],
                                "action": row["action"],
                            }
                        self.external_confirmations.pop(params["confirmation"])
                        row["secondary_confirmed"] = True
                    if row["action"] not in {"seo.save_pool", "local.lookup"} and (
                        not state["enabled"] or not state["ready"]
                    ):
                        raise ValueError("collaboration not ready; suggestion retained")
                    job_key = instance + ":" + row["id"]
                    if row["action"] == "workflow.run":
                        available = self.registry.recommendations(
                            {**self._tool_context(instance), **row.get("page_context", {})},
                            row["params"]["object"],
                            state["locale"],
                        )
                        proposal = next(
                            (
                                item
                                for item in available
                                if item["params"]["flow"] == row["params"]["flow"]
                            ),
                            None,
                        )
                        if not proposal or not proposal["available"]:
                            row["why"] = "需要先绑定能力"
                            row["missing_capabilities"] = (
                                proposal["missing_capabilities"] if proposal else ["workflow"]
                            )
                            self._emit(instance, "update", suggestion=dict(row))
                            return self.view(instance)
                    if row.get("tool_aware"):
                        self.registry.record(
                            row.get("tool"), row.get("page"), row["params"]["flow"], "clicked"
                        )
                    self.executions.prepare(job_key)
                    self.fetcher.prepare(job_key)
                    if self.acp_executions:
                        self.acp_executions.prepare(job_key)
                    row.update(
                        status="queued",
                        tokens=row.get("tokens", 0)
                        if row.get("workflow_checkpoint")
                        or row.get("fetch_checkpoint")
                        or row.get("ranking_checkpoint")
                        else 0,
                        usage=row.get("usage", counts())
                        if row.get("workflow_checkpoint")
                        or row.get("fetch_checkpoint")
                        or row.get("ranking_checkpoint")
                        else counts(),
                        fallback=False,
                        error=None,
                        reason=None,
                        queued_at=time.time(),
                    )
                    self._emit(instance, "update", suggestion=dict(row))
                    threading.Thread(
                        target=self._execute,
                        args=(instance, row["id"], state["epoch"]),
                        daemon=True,
                    ).start()
                elif method == "stop" and row["status"] in {"queued", "executing"}:
                    row["status"] = "stopped" if row["status"] == "queued" else "stopping"
                    self._cancel_execution(instance + ":" + row["id"])
                    self._emit(instance, "update", suggestion=dict(row))
                    self._completion_status(state, row)
                    self._drain_queue(instance, state["epoch"])
                else:
                    raise ValueError("invalid suggestion transition")
                return self.view(instance)
            raise ValueError("unknown Assist method")

    def _basket_request(self, instance, method, params):
        if not isinstance(params, dict):
            raise ValueError("invalid basket request")
        if method == "annotation_lookup" and set(params) == {"objects"}:
            from copilot_annotations import local_lookup

            with self.lock:
                records = local_lookup(self, instance, params["objects"])
                from copilot_annotations import object_key

                return {
                    "items": [
                        {**obj, "info": records.get(object_key(obj["type"], obj["value"]), {})}
                        for obj in params["objects"]
                    ]
                }
        if method == "basket_state" and not params:
            return self.basket.snapshot()
        if method == "basket_add" and set(params) == {"items"}:
            value = self.basket.add(params["items"])
            self._emit(instance, "basket")
            return value
        if method == "basket_remove" and set(params) == {"ids"}:
            value = self.basket.remove(params["ids"])
            self._emit(instance, "basket")
            return value
        if method == "basket_clear" and not params:
            value = self.basket.remove(list(self.basket.items))
            self._emit(instance, "basket")
            return value
        if method == "basket_plan" and set(params) == {"ids", "operation"}:
            return self.basket.estimate(instance, params["ids"], params["operation"])
        if (
            method == "basket_execute"
            and not set(params) - {"token", "confirmation"}
            and "token" in params
        ):
            return self.basket.execute(instance, params["token"], params.get("confirmation"))
        raise ValueError("unknown basket request")

    def _automatic_suggestions(self, instance):
        from copilot_risk import action_risk

        state = self._state(instance)
        if not self.config["auto_zero"] or not state["enabled"] or not state["ready"]:
            return
        for row in list(state["suggestions"].values()):
            if row["status"] != "pending" or row.get("automatic_attempted"):
                continue
            if action_risk(self, row) != "zero":
                continue
            row.update(automatic=True, automatic_attempted=True, why="已自动查到：正在读取本机信息")
            self.request(instance, "execute", {"id": row["id"]})

    def _selection_info(self, instance, params):
        if (
            set(params) != {"text"}
            or not isinstance(params["text"], str)
            or not 1 <= len(params["text"]) <= 12000
        ):
            raise ValueError("invalid selection")
        state = self._state(instance)
        target = canonical(params["text"])
        hit = None
        for row in [*state["suggestions"].values(), *state["result_history"]]:
            if (
                row.get("status") == "completed"
                and row["action"] == "seo.keyword_check"
                and time.time() - row.get("finished_at", 0) <= 7 * 86400
            ):
                check = next(
                    (
                        word
                        for word in result_words(row.get("result", {}))
                        if canonical(word["keyword"]) == target
                    ),
                    None,
                )
                if check:
                    hit = {
                        "id": row["id"],
                        "tier": check.get("tier", row["result"].get("tier", "")),
                        "at": row.get("finished_at"),
                    }
                    break
        if hit is None:
            for record in reversed(self.recent):
                if (
                    record.get("action") != "seo.keyword_check"
                    or not 0 <= time.time() - record["finished_at"] <= 7 * 86400
                ):
                    continue
                check = next(
                    (
                        word
                        for word in result_words(record.get("result", {}))
                        if canonical(word.get("keyword", "")) == target
                    ),
                    None,
                )
                if not check:
                    continue
                try:
                    validate(
                        record["result"], self.templates.get("seo.keyword_check")["result_schema"]
                    )
                except (ValueError, KeyError, TypeError):
                    continue
                identity = (
                    "recent-" + str(record["id"]) + "-" + str(int(record["finished_at"] * 1000))
                )
                state["suggestions"].setdefault(
                    identity, {**copy.deepcopy(record), "id": identity, "status": "completed"}
                )
                hit = {
                    "id": identity,
                    "tier": check.get("tier", record["result"].get("tier", "")),
                    "at": record["finished_at"],
                }
                break
        if hit is None and len(params["text"]) <= 2000:
            path = self._cache_path(
                {"action": "seo.keyword_check", "params": {"keyword": params["text"]}}
            )
            try:
                record = json.loads(path.read_text())
                if time.time() - record["at"] <= 7 * 86400:
                    result = legacy(
                        "seo.keyword_check", record["result"], {"keyword": params["text"]}
                    )
                    identity = "cache-" + suggestion_id(
                        "seo.keyword_check", {"keyword": params["text"]}
                    )
                    state["suggestions"].setdefault(
                        identity,
                        {
                            "id": identity,
                            "title": params["text"][:20],
                            "action": "seo.keyword_check",
                            "params": {"keyword": params["text"]},
                            "status": "completed",
                            "finished_at": record["at"],
                            "result": result,
                        },
                    )
                    hit = {"id": identity, "tier": result["tier"], "at": record["at"]}
            except (OSError, ValueError, KeyError, TypeError):
                pass
        pool = next(
            (
                {"keyword": word, "tier": "", "last_checked": None}
                for word in state["pool_words"]
                if canonical(word) == target
            ),
            None,
        )
        from copilot_annotations import object_key

        known = (
            self.annotation_memory.lookup([{"type": "keyword", "value": params["text"]}]).get(
                object_key("keyword", params["text"]), {}
            )
            if len(params["text"]) <= 4000
            else {}
        )
        if not pool and known.get("pool"):
            pool = {
                "tier": known.get("tier", ""),
                "last_checked": time.strftime("%Y-%m-%d", time.localtime(known["checked_at"]))
                if known.get("checked_at")
                else None,
            }
        if pool and hit:
            pool["tier"] = pool.get("tier") or hit["tier"]
            pool["last_checked"] = pool.get("last_checked") or time.strftime(
                "%Y-%m-%d", time.localtime(hit["at"])
            )
        if len(params["text"]) <= 300:
            self._refresh_tool_suggestions(instance, params["text"])
        local = [
            item
            for item in self.registry.recommendations(
                self._tool_context(instance), params["text"], state["locale"]
            )
            if self.ignored.get(suggestion_id("workflow.run", item["params"]))
            != date.today().isoformat()
        ]
        return {
            "workflows": local,
            "cached": hit,
            "pool": pool,
            "has_trends": any(
                row.get("status") == "completed"
                and row["action"] == "seo.trends"
                and any(
                    canonical(series["keyword"]) == target
                    for series in row.get("result", {}).get("series", [])
                )
                for row in [*state["suggestions"].values(), *self.recent]
            ),
            "capabilities": {
                "domain_rating": bool(self.config["fetch_commands"].get("domain_rating")),
                "pool": bool(self.config["pool_command"]),
            },
        }

    def _quick_task(self, instance, params):
        if (
            set(params) - {"action", "params", "context", "single_judgment"}
            or not {"action", "params"} <= params.keys()
        ):
            raise ValueError("invalid quick task")
        state = self._state(instance)
        action = params["action"]
        arguments = params["params"]
        if not state["enabled"]:
            raise ValueError("collaboration disabled")
        template = self.templates.get(action)
        validate(arguments, template["params_schema"])
        if action == "workflow.run" and arguments["flow"] not in self.packages.flows:
            raise ValueError("unknown workflow")
        if action == "seo.domain_rating" and not self.config["fetch_commands"].get("domain_rating"):
            raise ValueError("rating fetcher unavailable")
        if (
            action == "seo.trends"
            and not arguments.get("keyword")
            and not arguments.get("keywords")
        ):
            raise ValueError("trend object required")
        context = params.get("context", state.get("page_context", {}))
        if (
            set(context) - {"url", "incognito", "browser"}
            or context
            and (
                urlsplit(context.get("url", "")).scheme not in {"https", "http"}
                or type(context.get("incognito", False)) is not bool
            )
        ):
            raise ValueError("invalid quick context")
        key = suggestion_id(action, arguments)
        old = state["suggestions"].get(key)
        if old and old["status"] in {"queued", "executing", "stopping"}:
            return self.view(instance)
        if old:
            self._archive(state, old)
        state["suggestions"][key] = {
            "id": key,
            "action": action,
            "params": arguments,
            "title": template["name"],
            "why": "划词快捷任务",
            "status": "pending",
            "scene": "seo" if action.startswith("seo.") else "general",
            "page_context": context,
            "single_judgment": action == "general.task",
            "explicit": True,
        }
        if action == "workflow.run":
            proposal = next(
                (
                    item
                    for item in self.registry.recommendations(
                        {**self._tool_context(instance), **context},
                        arguments["object"],
                        state["locale"],
                    )
                    if item["params"]["flow"] == arguments["flow"]
                ),
                None,
            )
            if proposal:
                state["suggestions"][key].update(
                    tool_aware=True,
                    tool=proposal["tool"],
                    page=proposal["page"],
                    missing_capabilities=proposal["missing_capabilities"],
                )
        self._emit(instance, "add", suggestion=dict(state["suggestions"][key]))
        if not state["ready"]:
            state["suggestions"][key]["why"] = "等待协作会话就绪"
            return self.view(instance)
        return self.request(instance, "execute", {"id": key})

    def _browser_fetch(self, instance, epoch, job_key, kind, params, context):
        identity = uuid.uuid4().hex
        pending = {
            "instance": instance,
            "epoch": epoch,
            "job_key": job_key,
            "resource": context.get("resource"),
            "row_id": context.get("row_id"),
            "readonly": kind == "capability_probe",
            "event": threading.Event(),
            "data": None,
        }
        with self.lock:
            if not self._valid(instance, epoch) and not pending["readonly"]:
                raise ValueError("browser fetch stopped")
            self.browser_fetches[identity] = pending
            self._emit(
                instance,
                "browser_fetch",
                id=identity,
                kind=kind,
                params=params,
                incognito=bool(context.get("incognito")),
                source_url=context.get("url"),
            )
        try:
            deadline = time.monotonic() + (
                600
                if kind in {"google_trends", "capability"}
                or kind == "serp_top10"
                and len(params.get("keywords", [])) > 1
                else 120
            )
            while not pending["event"].wait(0.2):
                with self.lock:
                    if (
                        (not self._valid(instance, epoch) and not pending["readonly"])
                        or pending["epoch"] != self._state(instance)["epoch"]
                        or job_key in self.fetcher.cancelled
                        or time.monotonic() > deadline
                    ):
                        raise ValueError("browser fetch stopped or timed out")
                    self._state(instance)["last_work_activity"] = self.clock()
            with self.lock:
                if (
                    (not self._valid(instance, epoch) and not pending["readonly"])
                    or pending["epoch"] != self._state(instance)["epoch"]
                    or job_key in self.fetcher.cancelled
                ):
                    raise ValueError("browser fetch stopped")
            value = pending["data"]
            if not isinstance(value, dict) or value.get("error"):
                raise ValueError("browser data unavailable")
            return value
        finally:
            with self.lock:
                self.browser_fetches.pop(identity, None)
                self.resource_tasks = {
                    task: key for task, key in self.resource_tasks.items() if key != identity
                }

    def _ranking_fetch(self, instance, epoch, job_key, row, work, progress, browser_fetch):
        flow = self.packages.workflows["seo.ranking_sites"]
        keyword = row["params"]["keyword"]
        check = self.templates.get("seo.keyword_check")
        template = {
            **check,
            "fetch": [
                {**step, "script": flow["seed_fetcher"]}
                for step in check["fetch"]
                if step["script"] == "serp_top10"
            ],
        }
        checkpoint = row.setdefault("ranking_checkpoint", {})

        def persist(scope, value):
            checkpoint[scope] = value
            private_write(
                self.directory / "tasks" / ("ranking-checkpoint-" + row["id"] + ".json"),
                json.dumps(checkpoint, ensure_ascii=False),
            )

        fetched = self.fetcher.run(
            job_key,
            template,
            {"keyword": keyword},
            work,
            validate,
            progress,
            browser_fetch=browser_fetch,
            checkpoint=checkpoint.setdefault("seed", {}),
            save_checkpoint=lambda value: persist("seed", value),
        )
        fetched["data"]["serp_top10"] = fetched["data"].pop(flow["seed_fetcher"], {})
        domains = []
        for item in fetched["data"].get("serp_top10", {}).get("results", []):
            domain = urlsplit(item["url"]).hostname
            if domain and domain not in domains:
                domains.append(domain)
            if len(domains) == flow["max_sites"]:
                break
        sites = []
        from copilot_results import source_words

        for domain in domains:
            site_template = self.templates.get("seo.competitor_keywords")
            site_template = {
                **site_template,
                "fetch": [
                    {**step, "script": flow["site_fetcher"]} for step in site_template["fetch"]
                ],
            }
            part = self.fetcher.run(
                job_key,
                site_template,
                {"url": "https://" + domain},
                work,
                validate,
                progress,
                browser_fetch=browser_fetch,
                checkpoint=checkpoint.setdefault(domain, {}),
                save_checkpoint=lambda value: persist(domain, value),
            )
            fetched["missing"] += [domain + ": " + reason for reason in part["missing"]]
            source = part["data"].get(flow["site_fetcher"], {})
            sites.append(
                {
                    "domain": domain,
                    "keywords": list(source_words(part).values()),
                    "top_pages": [
                        {"url": url} if isinstance(url, str) else url
                        for url in source.get("pages", [])
                    ],
                }
            )
        fetched["data"]["ranking_sites"] = {"sites": sites}
        if not domains:
            fetched["missing"].append("SERP没有可核实的前三个站点")
        return fetched

    def valid_silent_token(self, token):
        import hmac

        return (
            isinstance(token, str)
            and bool(self.active)
            and hmac.compare_digest(token, self.silent_token)
        )

    def _cancel_execution(self, key):
        self.registry.stop(key)
        self.registry.stop(key + ":standard")
        self.executions.cancel(key + ":fallback")
        if self.acp_executions:
            self.acp_executions.cancel(key + ":judgment")
        self.executions.cancel(key)
        self.fetcher.cancel(key)
        if self.acp_executions:
            self.acp_executions.cancel(key)

    def _valid(self, instance, epoch):
        state = self._state(instance)
        return (
            not self.closed
            and state["enabled"]
            and not state.get("bridge_lost")
            and state["epoch"] == epoch
            and self.active == instance
        )

    def _prompt_json(self, instance, epoch, prompt, phase="inference"):
        def permitted():
            with self.lock:
                return self._valid(instance, epoch)

        def account(usage):
            with self.lock:
                if not self._valid(instance, epoch):
                    raise ACPError("inference stopped")
                self._account(instance, usage)

        runtime = self.runtime
        with runtime.turn_lock:
            if not permitted():
                raise ACPError("inference stopped")
            runtime.select_model(self.config["inference_model"])
            size = len(prompt.encode())
            self.journal.add(
                instance,
                "inference_send",
                phase=phase,
                increment_bytes=size,
                estimated_tokens=(size + 3) // 4,
            )
            try:
                result, metrics = model_json_prompt(runtime, prompt, account, permitted)
            except Exception as error:
                if getattr(error, "metrics", None):
                    account(error.metrics)
                with self.lock:
                    self._state(instance)["last_call_succeeded"] = False
                raise
            with self.lock:
                self._state(instance)["last_call_succeeded"] = True
            with self.lock:
                self._state(instance)["last_prompt_metrics"] = metrics
            if phase != "inference":
                self.journal.add(
                    instance,
                    "inference_return",
                    phase=phase,
                    model=metrics.get("model", ""),
                    duration_ms=metrics.get("seconds", 0) * 1000,
                    slow=metrics.get("seconds", 0) > 5,
                    estimated=bool(metrics.get("estimated")),
                    **from_metrics(metrics),
                )
            return result

    def _execution_failure(self, instance, epoch, reason):
        with self.lock:
            if not self._valid(instance, epoch):
                return
            self._state(instance)["execution_diagnostic"] = reason
            self._state(instance)["diagnostic"] = reason
            self._emit(instance, "diagnostic", message=reason)

    def bridge_connection(self, instance, connected):
        """中文注释：桥断开只暂停会话；保留用户开关和摘要，禁止重放在途任务。"""
        with self.lock:
            state = self._state(instance)
            if not state["enabled"]:
                return
            if not connected:
                if state.get("bridge_lost"):
                    return
                short = self.clock() - state.get("bridge_connected_at", self.clock()) <= 15
                failures = state.get("bridge_failures", 0) + 1 if short else 0
                self._deactivate(instance)
                state.update(
                    enabled=True,
                    bridge_lost=True,
                    bridge_failures=failures,
                    bridge_recovery_blocked=failures >= 3,
                    bridge_restored=False,
                )
                self.active = instance
                self.journal.add(instance, "bridge_disconnect", phase="bridge")
                if failures >= 3:
                    self.journal.add(instance, "bridge_recovery_stopped", error=True)
            elif state.get("bridge_lost") and not state.get("bridge_recovery_blocked"):
                state.update(bridge_lost=False, bridge_connected_at=self.clock(), recovering=True)
                threading.Thread(
                    target=self._activate,
                    args=(instance, state["epoch"]),
                    kwargs={"resume": True, "restart_execution": True},
                    daemon=True,
                ).start()
            elif not state.get("bridge_lost"):
                state["bridge_connected_at"] = self.clock()

    def _activate(self, instance, epoch, resume=False, restart_execution=False):
        runtime = adapter(self.config).inference(
            self.config,
            self.directory,
            lambda update: self._update(instance, epoch, update, runtime),
        )
        runtime.exit_observer = lambda detail: self.journal.add(instance, "process_exit", **detail)
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.lock:
                if not self._valid(instance, epoch):
                    return
                self.runtime = runtime
                self._state(instance)["context_tokens"] = 0
            runtime.start()
            if self.config["exec_transport"] == "acp" and (not resume or restart_execution):
                with self.lock:
                    if not self._valid(instance, epoch):
                        return
                    self.acp_executions = adapter(self.config).executions(
                        self.config,
                        self.directory,
                        lambda reason: self._execution_failure(instance, epoch, reason),
                        lambda detail: self.journal.add(
                            instance, "process_exit", error=True, **detail
                        ),
                    )
                self.acp_executions.start()
            from fbl_panel import context as fbl_context
            from fbl_discovery import changes

            changed = (
                changes(fbl_context(self))
                if (self.directory / "discovery-confirmed.json").is_file()
                else []
            )
            if (self.directory / "discovery-confirmed.json").is_file() and not (
                self.discovery_worker and self.discovery_worker.is_alive()
            ):
                self.discovery_worker = threading.Thread(
                    target=self._check_discovery, args=(instance, epoch), daemon=True
                )
                self.discovery_worker.start()
            with self.lock:
                self._state(instance)["discovery_changed"] = bool(changed)
            state = self._state(instance)
            context = self._resume_context(state)
            result = self._prompt_json(
                instance, epoch, inference_session_prompt(self.templates, context), phase="session"
            )
            with self.lock:
                if not self._valid(instance, epoch):
                    return
                if result.get("ready") is not True:
                    raise ModelOutputInvalid("ready", "not_ready")
                state = self._state(instance)
                state.update(
                    ready=True,
                    recovering=False,
                    diagnostic=None,
                    inference_failure=None,
                    inference_failures=0,
                )
                if restart_execution:
                    state["bridge_restored"] = True
                    self.journal.add(instance, "bridge_restored")
                if resume:
                    state.update(
                        sent_page={},
                        sent_trace=[],
                        sent_status={},
                        sent_tool_context={},
                        sent_completions=[],
                        sent_results=[],
                        sent_work=None,
                    )
                self._emit(instance, "ready", ready=True)
                if state["dirty"]:
                    self._schedule(instance)
                for row in list(state["suggestions"].values()):
                    if row["status"] == "pending" and row.get("explicit"):
                        self.request(instance, "execute", {"id": row["id"]})
                return True
        except (ACPError, ExecutionError, ValueError, OSError, KeyError, TypeError) as error:
            with self.lock:
                if self._valid(instance, epoch):
                    state = self._state(instance)
                    if resume and state["inference_restarts"] < len(self.RECOVERY_BACKOFF):
                        runtime.close()
                        return False
                    state["diagnostic"] = (
                        "execution_acp_start_blocked"
                        if isinstance(error, ExecutionError)
                        else "acp_start_blocked"
                    )
                    from copilot_health import startup_failure

                    state["startup_error"] = startup_failure(
                        self.config, error, execution=isinstance(error, ExecutionError)
                    )
                    if resume:
                        state["startup_error"]["recovery_exhausted"] = True
                    self.journal.add(
                        instance,
                        "startup_failed",
                        error=True,
                        **failure(error, runtime),
                        phase=state["startup_error"]["code"],
                    )
                    self._deactivate(instance)
                    self._emit(
                        instance,
                        "settings",
                        enabled=False,
                        reason=failure(error, runtime)["reason"],
                        startup_error=state["startup_error"],
                    )
            runtime.close()

    def _deactivate(self, instance):
        for key in list(self.registry.jobs):
            if key.startswith(instance + ":"):
                self.registry.stop(key)
        state = self._state(instance)
        state.update(
            enabled=False,
            ready=False,
            recovering=False,
            dirty=False,
            held_suggestions=set(),
            epoch=state["epoch"] + 1,
        )
        if state["timer"]:
            state["timer"].cancel()
            state["timer"] = None
        for row in state["suggestions"].values():
            if row["status"] in {"queued", "executing", "stopping"}:
                row["status"] = "stopped" if row["status"] == "queued" else "stopping"
                if row.get("basket_batch") and row["status"] == "stopped":
                    self.basket.activity(row, settled=True)
                self._cancel_execution(instance + ":" + row["id"])
                self._emit(instance, "update", suggestion=dict(row))
        state["trace"], state["page"], state["sent_trace"], state["sent_page"] = [], {}, [], {}
        state["sent_tool_context"] = {}
        state["tool_context"] = {}
        state["selected_object"] = ""
        if self.active == instance:
            runtime = self.runtime
            self.active = None
            if self.acp_executions:
                pool = self.acp_executions
                threading.Thread(target=pool.close, daemon=True).start()
            # 中文注释：立即取消整个 ACP 会话（执行进程独立取消），回收不阻塞 Native 读循环。
            if runtime:
                runtime.cancel()
                threading.Thread(target=runtime.close, daemon=True).start()

    def _archive(self, state, row):
        archived = copy.deepcopy(row)
        archived["id"] = row["id"] + "-" + uuid.uuid4().hex[:8]
        if row.get("result") and row.get("report"):
            result = legacy(row["action"], row["result"], row.get("params", {}))
            path = self._report_path(archived["id"])
            private_write(path, result_report(result, row["title"]))
            archived["report"] = str(path)
        state["result_history"].append(archived)
        state["result_history"] = state["result_history"][-100:]
        return archived

    @staticmethod
    def _resume_context(state):
        from copilot_diagnostics import redact_page

        return redact_page(
            {
                "summary": state.get("summary", ""),
                "completed": compact_memory(state["execution_memory"]),
                "work_context": work_context(state),
                "result_updates": state["result_updates"],
                "suggestions": [
                    {
                        key: row[key]
                        for key in ("id", "title", "why", "action", "params", "status")
                        if key in row
                    }
                    for row in state["suggestions"].values()
                    if row.get("work_id", state["work_id"]) == state["work_id"]
                ],
            }
        )

    def _check_discovery(self, instance, epoch):
        from fbl_panel import context
        from fbl_discovery import changes, mcp_rpc

        def stopped():
            with self.lock:
                return not self._valid(instance, epoch)

        try:
            changed = changes(
                context(self),
                deep=True,
                stop=stopped,
                mcp_probe=lambda server, method: mcp_rpc(server, method, timeout=2),
            )
        except (OSError, ValueError, RuntimeError):
            changed = ["metadata_unavailable"]
        with self.lock:
            if self._valid(instance, epoch) and changed:
                self._state(instance)["discovery_changed"] = True
                self._emit(instance, "capabilities")

    def _recover_inference(self, instance, epoch, previous):
        with self.inference_lock:
            previous.close()
            while True:
                with self.lock:
                    if not self._valid(instance, epoch):
                        return
                    state = self._state(instance)
                    attempt = state["inference_restarts"]
                    if attempt >= len(self.RECOVERY_BACKOFF):
                        return
                    state["inference_restarts"] += 1
                # 中文注释：分片等待使关闭/切换能中断；只有传输重建，执行中的写操作不重放。
                deadline = time.monotonic() + self.RECOVERY_BACKOFF[attempt]
                while time.monotonic() < deadline:
                    time.sleep(min(0.1, deadline - time.monotonic()))
                    with self.lock:
                        if not self._valid(instance, epoch):
                            return
                if self._activate(instance, epoch, resume=True):
                    return

    def _update(self, instance, epoch, update, runtime=None):
        if update.get("sessionUpdate") == "policy_violation":
            self.journal.add(
                instance,
                "policy_violation",
                error=True,
                item_type=update.get("item_type", "unknown"),
            )
            return
        if update.get("sessionUpdate") != "copilot_transport_error":
            return
        with self.lock:
            if (
                not self._valid(instance, epoch)
                or runtime is not None
                and runtime is not self.runtime
            ):
                return
            state = self._state(instance)
            if not state["ready"]:
                return
            detail = {
                key: update[key]
                for key in ("reason", "exit_code", "stderr_tail", "error_type")
                if key in update
            }
            detail.setdefault("reason", "acp_disconnected")
            if "exit_code" in detail:
                self.journal.add(instance, "process_exit", error=True, **detail)
            state["ready"] = False
            if state["inference_restarts"] < len(self.RECOVERY_BACKOFF):
                state.update(recovering=True, dirty=True)
                state["inference_failure"] = {
                    **detail,
                    "message": failure_message(detail, state["locale"]),
                }
                self.journal.add(instance, "disconnected", **detail)
                self.journal.add(instance, "inference_recovering", **detail)
                self._emit(instance, "inference_recovering")
                threading.Thread(
                    target=self._recover_inference,
                    args=(instance, epoch, self.runtime),
                    daemon=True,
                ).start()
            else:
                state["diagnostic"] = detail["reason"]
                state["startup_error"] = {
                    "code": detail["reason"],
                    "reason": "Hermes 推理重连失败，请重试",
                    "reason_en": "Hermes inference reconnection failed; retry",
                    "recovery_exhausted": True,
                }
                self._deactivate(instance)
                self._emit(
                    instance,
                    "settings",
                    enabled=False,
                    reason=detail["reason"],
                    startup_error=state["startup_error"],
                )

    def tick(self):
        with self.lock:
            for instance, state in self.states.items():
                if not state["enabled"]:
                    continue
                idle = self.clock() - state["last_activity"]
                work_recent = (
                    state.get("last_work_activity") is not None
                    and self.clock() - state["last_work_activity"]
                    < self.config["idle_close_seconds"]
                )
                if idle >= self.config["idle_close_seconds"] and not work_recent:
                    self._deactivate(instance)
                    self._emit(instance, "settings", enabled=False, reason="idle_closed")
                elif idle >= self.config["idle_pause_seconds"] and not state["idle_paused"]:
                    state["idle_paused"] = True
                    if state["timer"]:
                        state["timer"].cancel()
                        state["timer"] = None
                    self._emit(instance, "idle", paused=True)

    def _monitor(self):
        while not self.housekeeping.wait(5):
            self.tick()

    def close(self):
        self.agents.close()
        self.directories.close()
        with self.lock:
            self.closed = True
            context_threads = [
                job["thread"] for job in self.registry.jobs.values() if job.get("thread")
            ]
            for instance in self.states:
                if self._state(instance)["enabled"]:
                    self.journal.add(instance, "disconnected", reason="daemon_closed")
                self._deactivate(instance)
            self.housekeeping.set()
        if self.discovery_worker:
            self.discovery_worker.join(timeout=7)
        for thread in context_threads:
            thread.join(timeout=0.5)
        self.executions.close()
        self.fetcher.close()
        if self.acp_executions:
            self.acp_executions.close()
        with self.lock:
            for state in self.states.values():
                for row in state["suggestions"].values():
                    if row["status"] == "stopping":
                        row["status"] = "stopped"
        if self.runtime:
            self.runtime.close()
        self.journal.close()
        try:
            self.notifications.put_nowait(None)
        except queue.Full:
            pass
