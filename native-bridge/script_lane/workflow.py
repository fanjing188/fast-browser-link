"""通用有界观察和步骤组合；只组合既有 helper，不持有任务权威或另建执行器。"""

import copy
import math
import time
from urllib.parse import urlsplit


def invalid(api, field="workflow"):
    raise api["BrowserError"]("invalid " + field, code="invalid_params", outcome_unknown=False)


def duration(api, value, maximum=60):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= maximum:
        invalid(api, "timeout")
    return value


def conditions(api, values):
    # 中文注释：整组先验证；不把未知字段、代码或页面身份透传到执行器。
    if not isinstance(values, list) or not 1 <= len(values) <= 8:
        invalid(api, "conditions")
    fields = {
        "element": {"kind", "selector", "state", "text", "count"},
        "url": {"kind", "url"},
        "response": {"kind", "url", "status"},
        "download": {"kind", "state"},
        "popup": {"kind", "origin"},
    }
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get("kind"), str):
            invalid(api, "condition")
        kind = row["kind"]
        if kind not in fields or set(row) - fields[kind]:
            invalid(api, "condition")
        if kind == "element":
            state = row.get("state", "present")
            if (
                not isinstance(row.get("selector"), str)
                or not 1 <= len(row["selector"]) <= 512
                or state not in ("present", "absent", "text", "count", "stable")
                or (
                    state == "text"
                    and (not isinstance(row.get("text"), str) or len(row["text"]) > 12000)
                )
                or (
                    state == "count"
                    and (type(row.get("count")) is not int or not 0 <= row["count"] <= 2**53 - 1)
                )
                or ("text" in row and state != "text")
                or ("count" in row and state != "count")
            ):
                invalid(api, "element condition")
        if kind in ("url", "response"):
            value = row.get("url")
            if not isinstance(value, str) or not 1 <= len(value) <= 4096:
                invalid(api, "url")
            try:
                parts = urlsplit(value)
                if (
                    parts.scheme not in ("http", "https")
                    or not parts.hostname
                    or parts.username
                    or parts.password
                    or parts.port is not None
                    and not 1 <= parts.port <= 65535
                ):
                    invalid(api, "url")
            except ValueError:
                invalid(api, "url")
        if (
            kind == "response"
            and "status" in row
            and (type(row["status"]) is not int or not 100 <= row["status"] <= 599)
        ):
            invalid(api, "response status")
        if kind == "download" and row.get("state", "complete") not in ("complete", "interrupted"):
            invalid(api, "download state")
        if kind == "popup" and "origin" in row:
            value = row["origin"]
            try:
                parts = urlsplit(value) if isinstance(value, str) else None
                if (
                    parts is None
                    or parts.scheme not in ("http", "https")
                    or not parts.hostname
                    or parts.username
                    or parts.password
                    or parts.path
                    or parts.query
                    or parts.fragment
                ):
                    invalid(api, "popup origin")
            except ValueError:
                invalid(api, "popup origin")
    return copy.deepcopy(values)


class Observer:
    """监听在动作前建立；状态每轮重读，事件仅接收本次基线之后的证据。"""

    def __init__(self, api, rows, mode, deadline, interval):
        self.api, self.rows, self.mode = api, rows, mode
        self.deadline, self.interval = deadline, interval
        self.cursor = 0
        self.events = {}
        self.previous = {}
        self.stable = {}
        self.seen_downloads = set()
        self.seen_popups = set()

    def check(self):
        if time.monotonic() >= self.deadline:
            raise self.api["BrowserError"](
                "workflow deadline reached", code="workflow_timeout", outcome_unknown=False
            )

    def event_batch(self):
        self.check()
        batch = self.api["cdp_events"](max=500, cursor=self.cursor)
        if (
            not isinstance(batch, dict)
            or type(batch.get("cursor")) is not int
            or batch["cursor"] < self.cursor
            or not isinstance(batch.get("events"), list)
        ):
            raise self.api["BrowserError"](
                "invalid event receipt", code="invalid_receipt", outcome_unknown=False
            )
        if batch.get("dropped"):
            raise self.api["BrowserError"](
                "event history incomplete", code="event_overflow", outcome_unknown=False
            )
        if batch.get("hasMore") and batch["cursor"] == self.cursor:
            raise self.api["BrowserError"](
                "event cursor stalled", code="invalid_receipt", outcome_unknown=False
            )
        self.cursor = batch["cursor"]
        return batch

    def arm(self):
        kinds = {row["kind"] for row in self.rows}
        if "response" in kinds:
            self.api["cdp"]("Network.enable")
            # 中文注释：游标读取不消费其他调用者的队列；先走到当前尾部，不误认历史响应。
            for _ in range(21):
                if not self.event_batch().get("hasMore"):
                    break
            else:
                raise self.api["BrowserError"](
                    "event history busy", code="event_backlog", outcome_unknown=False
                )
        if "download" in kinds:
            self.seen_downloads = {
                row["id"] for row in self.api["downloads"]().get("downloads", [])
            }
        if "popup" in kinds:
            self.seen_popups = {
                row["candidateRef"]
                for row in (lambda x: x.get("candidates", []) + x.get("backgroundTabs", []))(
                    self.api["popup_catalog"]()
                )
            }
        self.check()

    def sample(self):
        self.check()
        api = self.api
        kinds = {row["kind"] for row in self.rows}
        if "response" in kinds:
            for _ in range(21):
                batch = self.event_batch()
                for event in batch["events"]:
                    if event.get("method") != "Network.responseReceived":
                        continue
                    params = event.get("params", {})
                    response = params.get("response", {})
                    for index, row in enumerate(self.rows):
                        if (
                            row["kind"] == "response"
                            and row["url"] == response.get("url")
                            and ("status" not in row or row["status"] == response.get("status"))
                        ):
                            self.events[index] = {
                                "request_id": params.get("requestId"),
                                "status": response.get("status"),
                                "correlation": "filter_only",
                            }
                if not batch.get("hasMore"):
                    break
            else:
                raise api["BrowserError"](
                    "event history busy", code="event_backlog", outcome_unknown=False
                )
        frame = None
        if "url" in kinds:
            frame = api["cdp"]("Page.getFrameTree").get("frameTree", {}).get("frame", {})
        downloads = api["downloads"]() if "download" in kinds else {}
        popups = api["popup_catalog"]() if "popup" in kinds else {}
        results, binding = [], None
        for index, row in enumerate(self.rows):
            self.check()
            kind, matched, evidence, complete = row["kind"], False, {}, True
            if kind == "element":
                observed = api["observe"](row["selector"])
                if (
                    not isinstance(observed, dict)
                    or type(observed.get("count")) is not int
                    or not isinstance(observed.get("text"), list)
                    or not isinstance(observed.get("binding"), dict)
                ):
                    raise api["BrowserError"](
                        "invalid observation", code="invalid_receipt", outcome_unknown=False
                    )
                if binding is not None and observed["binding"] != binding:
                    # 中文注释：同一轮不拼接不同文档的条件；由调用者重新观察，绝不执行后续写入。
                    raise api["BrowserError"](
                        "document changed during observation",
                        code="document_changed",
                        outcome_unknown=False,
                    )
                binding = observed["binding"]
                signature = (observed["binding"], observed["count"], observed["text"])
                self.stable[index] = (
                    self.stable.get(index, 0) + 1 if self.previous.get(index) == signature else 0
                )
                self.previous[index] = signature
                state = row.get("state", "present")
                complete = observed.get("complete") is True
                matched = complete and (
                    (state == "present" and observed["count"] > 0)
                    or (state == "absent" and observed["count"] == 0)
                    or (state == "count" and observed["count"] == row["count"])
                    or (
                        state == "text"
                        and any(
                            row["text"] in value
                            for value in observed["text"]
                            if isinstance(value, str)
                        )
                    )
                    or (state == "stable" and observed["count"] > 0 and self.stable[index] >= 2)
                )
                evidence = {"count": observed["count"], "complete": complete}
            elif kind == "url":
                matched = frame.get("url") == row["url"]
                evidence = {"frame_id": frame.get("id"), "loader_id": frame.get("loaderId")}
            elif kind == "response":
                evidence = self.events.get(index, {})
                matched = bool(evidence)
            elif kind == "download":
                rows = [
                    value
                    for value in downloads.get("downloads", [])
                    if value.get("id") not in self.seen_downloads
                    and value.get("state") == row.get("state", "complete")
                ]
                matched = len(rows) == 1
                complete = downloads.get("unattributed", 0) == 0
                evidence = {
                    "matches": len(rows),
                    **({"id": rows[0]["id"], "state": rows[0]["state"]} if matched else {}),
                }
            elif kind == "popup":
                rows = [
                    value
                    for value in popups.get("candidates", []) + popups.get("backgroundTabs", [])
                    if value.get("candidateRef") not in self.seen_popups
                    and ("origin" not in row or value.get("origin") == row["origin"])
                ]
                matched = len(rows) == 1
                evidence = {
                    "matches": len(rows),
                    **({"candidateRef": rows[0]["candidateRef"]} if matched else {}),
                }
            results.append(
                {
                    "index": index,
                    "kind": kind,
                    "satisfied": matched,
                    "complete": complete,
                    "evidence": evidence,
                }
            )
        if frame is not None:
            latest = api["cdp"]("Page.getFrameTree").get("frameTree", {}).get("frame", {})
            if any(latest.get(key) != frame.get(key) for key in ("id", "loaderId", "url")):
                raise api["BrowserError"](
                    "navigation during observation", code="document_changed", outcome_unknown=False
                )
        self.check()
        return results

    def wait(self):
        results = []
        while time.monotonic() < self.deadline:
            try:
                results = self.sample()
            except self.api["BrowserError"] as error:
                if error.code == "workflow_timeout" and error.outcome_unknown is False:
                    break
                raise
            matched = [row["index"] for row in results if row["satisfied"]]
            satisfied = bool(matched) if self.mode == "any" else len(matched) == len(results)
            if satisfied:
                return {
                    "satisfied": True,
                    "timed_out": False,
                    "matched": matched,
                    "conditions": results,
                    "reason": None,
                }
            self.api.get("sleep", time.sleep)(
                min(self.interval, max(0, self.deadline - time.monotonic()))
            )
        return {
            "satisfied": False,
            "timed_out": True,
            "matched": [],
            "conditions": results,
            "reason": "deadline_reached",
        }


def observer(api, values, mode, timeout, interval, deadline=None):
    rows = conditions(api, values)
    duration(api, timeout)
    if (
        mode not in ("any", "all")
        or type(interval) not in (int, float)
        or not math.isfinite(interval)
        or not 0.05 <= interval <= 2
    ):
        invalid(api, "wait options")
    return Observer(
        api, rows, mode, min(deadline or math.inf, time.monotonic() + timeout), interval
    )


def wait_until(api, values, mode="any", timeout=10, interval=0.25):
    watch = observer(api, values, mode, timeout, interval)
    api["ready"]()
    watch.arm()
    return watch.wait()


def diagnose_target(api, name, role=None, root=None, action="click"):
    # 中文注释：诊断只返回本范围实际证据，不自动扫全页、关浮层或推测框架/虚拟列表。
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 2000
        or (role is not None and (not isinstance(role, str) or not 1 <= len(role) <= 100))
        or (root is not None and (not isinstance(root, str) or not 1 <= len(root) <= 512))
        or action not in ("click", "fill", "press")
    ):
        invalid(api, "target")
    api["ready"]()
    options = {"mode": "interactive", "budget": 3000, "_no_query_recovery": True}
    if role is not None:
        options["roles"] = [role]
    if root is not None:
        options["root"] = root
    page = api["semantic_snapshot"](**options)
    if not isinstance(page, dict) or not isinstance(page.get("items"), list):
        raise api["BrowserError"]("invalid snapshot", code="invalid_receipt", outcome_unknown=False)
    rows = [
        row
        for row in page["items"]
        if isinstance(row, dict)
        and isinstance(row.get("name"), str)
        and api["normalize"](row["name"]) == api["normalize"](name)
        and (role is None or row.get("role") == role)
    ]
    eligible = [
        row
        for row in rows
        if not (row.get("disabled") or row.get("busy"))
        and not (action == "fill" and row.get("readonly"))
        and action in row.get("actions", [])
    ]
    complete = page.get("coverage", {}).get("complete") is True
    reason = (
        "incomplete_target_scope"
        if not complete
        else "target_not_found"
        if not rows
        else "ambiguous_target"
        if len(eligible) > 1
        else "target_disabled"
        if all(row.get("disabled") or row.get("busy") for row in rows)
        else "target_readonly"
        if action == "fill" and all(row.get("readonly") for row in rows)
        else "target_not_actionable"
        if not eligible
        else "target_occluded"
        if eligible[0].get("occluded") is True or eligible[0].get("blocked") == "occluded"
        else "target_hidden"
        if eligible[0].get("visible") is False
        else "ready"
    )
    suggestions = {
        "ready": "use_fresh_reference",
        "target_not_found": "change_query_or_scope",
        "ambiguous_target": "narrow_role_or_root",
        "incomplete_target_scope": "narrow_role_or_root",
        "target_occluded": "wait_or_request_user",
        "target_disabled": "wait_for_enabled",
        "target_readonly": "choose_editable_target",
        "target_hidden": "inspect_visibility",
        "target_not_actionable": "inspect_allowed_actions",
    }
    return {
        "reason": reason,
        "actionable": reason == "ready",
        "complete": complete,
        "matches": len(rows),
        "eligible": len(eligible),
        "suggestion": suggestions[reason],
        "candidates": [
            {
                key: row[key]
                for key in (
                    "role",
                    "visible",
                    "inViewport",
                    "occluded",
                    "disabled",
                    "readonly",
                    "busy",
                    "actions",
                )
                if key in row
            }
            for row in rows[:5]
        ],
    }


def validate_steps(api, values):
    if not isinstance(values, list) or not 1 <= len(values) <= 16:
        invalid(api, "steps")
    plan = copy.deepcopy(values)
    fields = {
        "click": {"name", "role", "root"},
        "fill": {"name", "text", "role", "root"},
        "press": {"name", "key", "role", "root"},
        "scroll": {"direction"},
        "navigate": {"url"},
        "wait": set(),
    }
    for step in plan:
        if (
            not isinstance(step, dict)
            or not isinstance(step.get("action"), str)
            or step["action"] not in fields
            or set(step) - fields[step["action"]] - {"action", "before", "after"}
        ):
            invalid(api, "step")
        action = step["action"]
        if action in ("click", "fill", "press"):
            if (
                not isinstance(step.get("name"), str)
                or not step["name"].strip()
                or len(step["name"]) > 2000
            ):
                invalid(api, "step target")
            for key, limit in (("role", 100), ("root", 512)):
                if key in step and (
                    not isinstance(step[key], str) or not 1 <= len(step[key]) <= limit
                ):
                    invalid(api, "step target")
        if action == "fill" and (
            not isinstance(step.get("text"), str) or len(step["text"]) > 12000
        ):
            invalid(api, "step text")
        if action == "press" and step.get("key") not in (
            "Enter",
            "Tab",
            "Escape",
            "ArrowDown",
            "ArrowUp",
        ):
            invalid(api, "step key")
        if action == "scroll" and step.get("direction", "down") not in ("up", "down"):
            invalid(api, "step direction")
        if action == "navigate":
            conditions(api, [{"kind": "url", "url": step.get("url")}])
        for key in ("before", "after"):
            if key in step:
                options = step[key]
                if not isinstance(options, dict) or set(options) - {
                    "conditions",
                    "mode",
                    "timeout",
                    "interval",
                }:
                    invalid(api, "step condition")
                observer(
                    api,
                    options.get("conditions"),
                    options.get("mode", "all"),
                    options.get("timeout", 10),
                    options.get("interval", 0.25),
                )
        if action == "wait" and "after" not in step:
            invalid(api, "wait step")
    return plan


def run_steps(api, values, timeout=60):
    duration(api, timeout)
    plan = validate_steps(api, values)
    api["ready"]()
    api["resilience_ready"]()
    initial = recover_page(api, min(timeout, 5))
    if not initial["ready"]:
        return {
            "completed": False,
            "failed_step": 0,
            "reason": initial["reason"],
            "outcome_unknown": False,
            "steps": [],
            "recovery": initial,
        }
    selectors = set()
    for step in plan:
        if "root" in step:
            selectors.add(step["root"])
        for key in ("before", "after"):
            for row in step.get(key, {}).get("conditions", []):
                if row["kind"] == "element":
                    selectors.add(row["selector"])
    for selector in sorted(selectors):
        api["observe"](selector)
    deadline, receipts = time.monotonic() + timeout, []
    for index, step in enumerate(plan):
        entry = {"index": index, "action": step["action"], "phase": "before", "dispatched": False}
        receipts.append(entry)
        health = {}
        try:
            health = api["guard"]()
            reason = guard_reason(health)
            if reason:
                # 中文注释：只在本步尚未派发时做有界恢复，绝不回到上一步补写。
                recovery = recover_page(api, min(5, max(0.001, deadline - time.monotonic())))
                entry["recovery"] = recovery
                if not recovery["ready"]:
                    return {
                        "completed": False,
                        "failed_step": index,
                        "reason": recovery["reason"],
                        "outcome_unknown": False,
                        "steps": receipts,
                    }

            def prepare(key):
                options = step[key]
                watch = observer(
                    api,
                    options["conditions"],
                    options.get("mode", "all"),
                    options.get("timeout", 10),
                    options.get("interval", 0.25),
                    deadline,
                )
                watch.arm()
                return watch

            if "before" in step:
                entry["before"] = prepare("before").wait()
                if not entry["before"]["satisfied"]:
                    return {
                        "completed": False,
                        "failed_step": index,
                        "reason": "precondition_failed",
                        "outcome_unknown": False,
                        "steps": receipts,
                    }
            # 中文注释：先建立后置事件观察，再做一次动作；未知后不等待、不继续、不换通道。
            entry["phase"] = "arm"
            watch = prepare("after") if "after" in step else None
            if time.monotonic() >= deadline:
                raise api["BrowserError"](
                    "workflow deadline reached", code="workflow_timeout", outcome_unknown=False
                )
            entry["phase"] = "action"
            action = step["action"]
            options = {key: step[key] for key in ("role", "root") if key in step}
            options["timeout"] = min(10, max(0.001, deadline - time.monotonic()))
            if action == "click":
                result = api["click_element"](step["name"], **options)
            elif action == "fill":
                result = api["fill_element"](step["name"], step["text"], **options)
            elif action == "press":
                target = api["wait_for_element"](step["name"], **options)
                result = api["step_press"](target, step["key"])
            elif action == "scroll":
                result = api["scroll"](step.get("direction", "down"))
            elif action == "navigate":
                result = api["goto_url"](step["url"], summary=False)
            else:
                result = None
            entry["dispatched"] = action != "wait"
            # 中文注释：保留真实送达/效果字段；不把整页正文、输入值和恢复快照累计到步骤回执。
            entry["receipt"] = {
                key: result[key]
                for key in ("delivery", "effect", "clicked", "filled", "verified", "outcomeUnknown")
                if isinstance(result, dict) and key in result
            }
            if isinstance(result, dict) and (
                result.get("outcomeUnknown") is True or result.get("outcome_unknown") is True
            ):
                raise api["BrowserError"]("unknown action outcome", code="outcome_unknown")
            if isinstance(result, dict) and result.get("popupPolicy", {}).get("paused") is True:
                entry["phase"] = "popup_policy"
                entry["popup_policy"] = {
                    "paused": True,
                    "reason": result["popupPolicy"].get("reason"),
                }
                return {
                    "completed": False,
                    "failed_step": index,
                    "reason": "popup_policy_paused",
                    "outcome_unknown": False,
                    "steps": receipts,
                }
            if watch:
                entry["phase"] = "after"
                entry["after"] = watch.wait()
                if not entry["after"]["satisfied"]:
                    return {
                        "completed": False,
                        "failed_step": index,
                        "reason": "postcondition_failed",
                        "outcome_unknown": False,
                        "steps": receipts,
                    }
            entry["protection"] = api["guard"]()
            if guard_reason(entry["protection"]) in {
                "execution_no_progress",
                "popup_policy_paused",
                "execution_circuit_open",
                "execution_handoff",
                "access_cooldown",
            }:
                return {
                    "completed": False,
                    "failed_step": index,
                    "reason": guard_reason(entry["protection"]),
                    "outcome_unknown": False,
                    "steps": receipts,
                }
            entry["phase"] = "complete"
        except api["BrowserError"] as error:
            unknown = error.outcome_unknown is not False
            if (
                not unknown
                and health.get("healthId")
                and error.code
                in {
                    "element_timeout",
                    "ambiguous_target",
                    "incomplete_target_scope",
                    "target_disabled",
                    "target_readonly",
                    "target_occluded",
                    "target_not_actionable",
                    "page_not_ready",
                }
            ):
                try:
                    entry["failure_protection"] = api["failure"](error.code, health["healthId"])
                except api["BrowserError"] as report_error:
                    entry["protection_error"] = report_error.code
                    unknown = report_error.outcome_unknown is not False
            entry["error"] = {"code": error.code or "browser_error", "outcome_unknown": unknown}
            if error.code == "popup_policy_unprotected" and error.reason == "unprotected_document":
                entry["error"].update(reason=error.reason, suggestion=error.suggestion)
            if entry["phase"] == "action" and unknown:
                entry["dispatched"] = None
            return {
                "completed": False,
                "failed_step": index,
                "reason": error.code or "browser_error",
                "outcome_unknown": unknown,
                "steps": receipts,
                **(
                    {"policy_reason": error.reason, "suggestion": error.suggestion}
                    if error.code == "popup_policy_unprotected"
                    and error.reason == "unprotected_document"
                    else {}
                ),
            }
    return {
        "completed": True,
        "failed_step": None,
        "reason": None,
        "outcome_unknown": False,
        "steps": receipts,
    }


def guard_reason(state):
    """中文注释：只读取固定保护状态，不把刷新成功当成业务成功。"""
    if state.get("protection", {}).get("popupPaused"):
        return "popup_policy_paused"
    if state.get("protection", {}).get("progressIncomplete"):
        return "execution_progress_incomplete"
    if state.get("protection", {}).get("stalled"):
        return "execution_no_progress"
    if state.get("protection", {}).get("circuitOpen"):
        return "execution_circuit_open"
    if state.get("reason") in ("captcha", "login", "permission", "quota"):
        return "execution_handoff"
    if state.get("access", {}).get("requiresUser"):
        return "execution_handoff"
    if state.get("access", {}).get("retryAfterMs", 0) > 5000:
        return "access_cooldown"
    if state.get("reason") == "rate_limit":
        return "access_cooldown"
    if state.get("reason") in ("loading", "transient"):
        return "page_not_ready"
    return None


def recover_page(api, timeout=15):
    duration(api, timeout)
    api["resilience_ready"]()
    deadline = time.monotonic() + timeout
    reloaded = False
    observations = 0
    while True:
        state = api["guard"]()
        observations += 1
        reason = guard_reason(state)
        if reason is None:
            return {
                "recovered": reloaded,
                "ready": True,
                "reason": None,
                "strategy": "reload" if reloaded else "reread",
                "observations": observations,
                "status": state,
            }
        if (
            reason == "page_not_ready"
            and state.get("reason") == "transient"
            and state.get("reloadAllowed")
            and not reloaded
        ):
            # 中文注释：唯一刷新在底座复核原文档、草稿/写入历史和配额；异常不补发。
            api["reload"](state["healthId"])
            reloaded = True
        elif reason != "page_not_ready" or observations >= 3 or time.monotonic() >= deadline:
            return {
                "recovered": reloaded,
                "ready": False,
                "reason": reason,
                "strategy": "pause" if reason == "execution_handoff" else "wait_or_inspect",
                "observations": observations,
                "status": state,
            }
        api.get("sleep", time.sleep)(min(0.25, max(0, deadline - time.monotonic())))


def read_resilient(api, mode="content", root=None, timeout=15):
    duration(api, timeout)
    if mode not in ("content", "interactive", "table") or (
        root is not None and (not isinstance(root, str) or not 1 <= len(root) <= 512)
    ):
        invalid(api, "resilient read")
    api["resilience_ready"]()
    attempts = 0
    reloaded = False
    deadline = time.monotonic() + timeout
    transient = {
        "document_changed",
        "stale_reference",
        "page_not_ready",
        "target_unavailable",
        "runtime_preparation_failed",
    }
    while attempts < 3 and time.monotonic() < deadline:
        attempts += 1
        try:
            recovery = recover_page(api, min(5, max(0.001, deadline - time.monotonic())))
            reloaded = reloaded or recovery["recovered"]
            if not recovery["ready"]:
                return {
                    "completed": False,
                    "reason": recovery["reason"],
                    "recovery": recovery,
                    "attempts": attempts,
                    "page": None,
                }
            page = api["read_page"](mode=mode, **({"root": root} if root is not None else {}))
            return {
                "completed": True,
                "reason": None,
                "attempts": attempts,
                "recovery": {"reloaded": reloaded},
                "page": page,
            }
        except api["BrowserError"] as error:
            if error.outcome_unknown is not False or error.code not in transient or attempts >= 3:
                raise
            api.get("sleep", time.sleep)(min(0.25, max(0, deadline - time.monotonic())))
    return {"completed": False, "reason": "workflow_timeout", "attempts": attempts, "page": None}
