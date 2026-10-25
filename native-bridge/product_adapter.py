"""FBL 扩展专用的产品填表任务；不建立第二条浏览器执行链。"""

import secrets
import threading
from contextlib import nullcontext
from urllib.parse import urlsplit


class ProductAdapter:
    def __init__(self, daemon):
        self.daemon = daemon
        self.pages = {}
        self.lock = threading.RLock()

    def _connection(self, extension):
        if self.daemon.extensions.get(extension["instanceId"]) is not extension:
            raise self.daemon.protocol_error("connection_replaced", "product request denied")

    def _page(self, extension, handle):
        self._connection(extension)
        page = self.pages.get(handle) if isinstance(handle, str) else None
        if (
            page is None
            or page["extension"] is not extension
            or page["connectionGeneration"] != extension.get("connectionGeneration")
            or page["generation"] != self.daemon.tasks[page["taskId"]]["generation"]
        ):
            raise self.daemon.protocol_error("product_handle_stale", "product request denied")
        return page

    def _view(self, handle, page):
        task = self.daemon.tasks[page["taskId"]]
        result = {"pageHandle": handle, "taskId": task["id"], "state": task["state"]}
        if task["state"] in {"closed", "cancelled", "failed"}:
            result["cleanupState"] = task.get("cleanupState", "unknown")
        if task["state"] == "ready" and task.get("activeMode") == "full":
            tab_id = task["attachment"]["tabId"]
            if (
                task.get("attachedTabIds") == [tab_id]
                and tab_id in task["tabIds"]
                and self.daemon.tab_leases.get((task["instanceId"], tab_id)) == task["id"]
            ):
                result.update(
                    tabId=tab_id,
                    generation=task["generation"],
                    modeGeneration=task["modeGeneration"],
                )
        return result

    def _command(self, command, page):
        # 中文注释：与 FBL content 世界保持同一封闭结构；提交编号只由外层 ledger 注入。
        shapes = {
            "bind": {"operation", "binding", "epoch", "submissionLocked"},
            "observe": {"operation"},
            "prepare": {"operation", "observationHandle", "candidates"},
            "commit": {"operation", "grantHandle"},
            "status": {"operation", "requestId"},
            "revoke": {"operation", "reason"},
        }

        def text(value, limit=256):
            return (
                isinstance(value, str)
                and bool(value.strip())
                and len(value) <= limit
                and all(ord(c) >= 32 and ord(c) != 127 or c in "\t\n\r" for c in value)
            )

        valid = isinstance(command, dict) and isinstance(command.get("operation"), str)
        operation = command.get("operation") if valid else None
        valid = valid and operation in shapes and set(command) == shapes[operation]
        if valid and operation == "bind":
            binding = command["binding"]
            valid = (
                isinstance(binding, dict)
                and set(binding) == {"product", "source", "item", "submissionUrl"}
                and all(text(value, 2048) for value in binding.values())
                and binding["submissionUrl"] == page["url"]
                and type(command["epoch"]) is int
                and 0 < command["epoch"] <= 9007199254740991
                and type(command["submissionLocked"]) is bool
            )
        if valid and operation == "prepare":
            candidates = command["candidates"]
            valid = (
                text(command["observationHandle"])
                and isinstance(candidates, list)
                and 1 <= len(candidates) <= 64
                and all(
                    isinstance(row, dict)
                    and set(row) == {"fieldHandle", "value"}
                    and text(row["fieldHandle"])
                    and text(row["value"], 8192)
                    for row in candidates
                )
            )
            if valid:
                valid = (
                    len({row["fieldHandle"] for row in candidates}) == len(candidates)
                    and sum(len(row["value"]) for row in candidates) <= 32768
                )
        if valid and operation in {"commit", "status", "revoke"}:
            valid = text(
                command[
                    {"commit": "grantHandle", "status": "requestId", "revoke": "reason"}[operation]
                ]
            )
        if not valid:
            raise self.daemon.protocol_error("invalid_params", "product request denied")

    def dispatch_extension(self, extension, method, params):
        try:
            return self._dispatch(extension, method, params)
        except self.daemon.protocol_error as exc:
            allowed = {
                "invalid_params",
                "connection_replaced",
                "product_handle_stale",
                "execution_lane_denied",
                "task_preparing",
                "task_paused",
                "task_closed",
                "foreign_tab",
                "lease_conflict",
                "attachment_unavailable",
                "instance_unavailable",
                "invalid_url",
                "invalid_state",
                "request_id_conflict",
                "request_outcome_unavailable",
                "product_execution_denied",
                "product_outcome_unknown",
                "browser_access_revoked",
                "needs_sync",
            }
            raise self.daemon.protocol_error(
                exc.code if exc.code in allowed else "product_request_denied",
                "product request failed",
                {
                    key: value
                    for key, value in exc.data.items()
                    if key in {"outcomeUnknown", "retryable", "inFlight"} and type(value) is bool
                },
            ) from None

    def _dispatch(self, extension, method, params):
        daemon = self.daemon
        if not isinstance(params, dict):
            raise daemon.protocol_error("invalid_params", "product request denied")
        # 中文注释：只串行创建；停止不能排在在途写入的消息回执后面。
        with self.lock if method == "extension.product.attach" else nullcontext():
            with daemon.state_lock:
                self._connection(extension)
            if method == "extension.product.attach" and set(params) == {"url"}:
                url = params["url"]
                daemon._validate_action_url(url, [])
                with daemon.state_lock:
                    if any(
                        task.get("instanceId") == extension["instanceId"]
                        and task.get("attachment", {}).get("url") == url
                        and task.get("productWriteUnknown")
                        for task in daemon.tasks.values()
                    ):
                        raise daemon.protocol_error(
                            "product_outcome_unknown", "product request denied"
                        )
                for handle, page in self.pages.items():
                    if (
                        page["extension"] is extension
                        and page["connectionGeneration"] == extension.get("connectionGeneration")
                        and page["url"] == url
                        and daemon.tasks[page["taskId"]]["state"]
                        not in {"closed", "cancelled", "failed"}
                    ):
                        with daemon.state_lock:
                            self._page(extension, handle)
                            return self._view(handle, page)
                parsed = urlsplit(url)
                created = daemon._create_task(
                    {
                        "owner": "product-fill-" + secrets.token_urlsafe(24),
                        "title": "Fast-browser-link · 填表",
                        "instanceId": extension["instanceId"],
                        "allowedOrigins": [f"{parsed.scheme}://{parsed.netloc}"],
                        "existingTab": {"url": url},
                    },
                    _execution_lane="product_fill",
                )
                handle = secrets.token_urlsafe(32)
                page = {
                    "taskId": created["id"],
                    "extension": extension,
                    "url": url,
                    "connectionGeneration": extension.get("connectionGeneration"),
                    "generation": daemon.tasks[created["id"]]["generation"],
                }
                with daemon.state_lock:
                    self._connection(extension)
                    self.pages[handle] = page
                    daemon.task_authorities[created["id"]] = page
                    return self._view(handle, page)
            if method == "extension.product.get" and set(params) == {"pageHandle"}:
                with daemon.state_lock:
                    page = self._page(extension, params["pageHandle"])
                    return self._view(params["pageHandle"], page)
            if method == "extension.product.run" and set(params) == {
                "pageHandle",
                "requestId",
                "command",
            }:
                with daemon.state_lock:
                    page = self._page(extension, params["pageHandle"])
                    self._command(params["command"], page)
                    task = daemon.tasks[page["taskId"]]
                    operation = params["command"]["operation"]
                    if task.get("productWriteUnknown") and operation not in {"status", "revoke"}:
                        raise daemon.protocol_error(
                            "product_outcome_unknown", "product request denied"
                        )
                    if operation == "commit":
                        # 中文注释：先落未知墓碑，回执丢失、重启或换编号都不能重获填写资格。
                        task["productWriteUnknown"] = True
                        daemon._persist_tasks()
                    request = {
                        "owner": task["owner"],
                        "taskId": task["id"],
                        "requestId": params["requestId"],
                        "action": "product.fill",
                        "tabId": task["attachment"]["tabId"],
                        "command": params["command"],
                    }
                if operation == "commit":
                    # 中文注释：按宿主既有 persist_lock→state_lock 顺序落盘，不持状态锁等待IO。
                    daemon._flush_tasks()
                try:
                    result = daemon._run_task(request, _authority=page)
                except daemon.protocol_error as exc:
                    # 中文注释：仅明确未派发的拒绝撤回本次临时墓碑，真正未知永不清除。
                    if operation == "commit" and (
                        exc.data.get("outcomeUnknown") is False
                        or exc.code
                        in {
                            "invalid_params",
                            "execution_lane_denied",
                            "request_id_conflict",
                            "task_closed",
                            "task_preparing",
                            "foreign_tab",
                        }
                    ):
                        with daemon.state_lock:
                            task["productWriteUnknown"] = False
                            daemon._persist_tasks()
                    raise
                if (
                    operation == "commit"
                    and isinstance(result, dict)
                    and result.get("status") in {"confirmed", "refused"}
                ):
                    with daemon.state_lock:
                        task["productWriteUnknown"] = False
                        daemon._persist_tasks()
                return result
            if method == "extension.product.close" and set(params) == {"pageHandle"}:
                with daemon.state_lock:
                    page = self._page(extension, params["pageHandle"])
                    task = daemon.tasks[page["taskId"]]
                    terminal = task["state"] in {"closed", "cancelled", "failed"}
                if not terminal:
                    daemon._release_task(
                        {"owner": task["owner"], "taskId": task["id"]},
                        "closed",
                        False,
                        _authority=page,
                    )
                with daemon.state_lock:
                    return self._view(params["pageHandle"], page)
            raise daemon.protocol_error("invalid_params", "product request denied")
