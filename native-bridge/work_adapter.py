"""受信扩展工作通路：私有任务、冻结资源、固定操作；只复用 Native 请求账本。"""

import copy
import hashlib
import json
import re
import secrets
import threading
from urllib.parse import urlsplit

PREFIX = "extension.assist.work."
TERMINAL = {"closed", "cancelled", "failed"}
MODULE_ROOT = "chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/"
FIELD_MATCH = "argument=>{const nodes=document.querySelectorAll(argument.selector);if(nodes.length!==1)return {matches:false};const e=nodes[0];return {matches:e.isConnected&&['INPUT','TEXTAREA'].includes(e.tagName)&&!['password','file','hidden'].includes(e.type)&&!e.disabled&&!e.readOnly&&e.value===argument.text}}"
READERS = {
    "tables_read": f"async argument=>{{const m=await import('{MODULE_ROOT}product-tables.mjs');return m.captureTables(document,argument)}}",
    "search_read": f"async argument=>{{const m=await import('{MODULE_ROOT}product-browser-data.mjs');return m.readSearch(document)}}",
    "trends_read": f"async argument=>{{const m=await import('{MODULE_ROOT}product-browser-data.mjs');return m.readTrends({{keywords:argument.keywords,report:argument.report}},argument.region,argument.period,document)}}",
    "report_inspect": f"async argument=>{{const m=await import('{MODULE_ROOT}product-tool-reports.mjs');return m.inspectToolPage(argument,document)}}",
    "table_advance": f"async argument=>{{const m=await import('{MODULE_ROOT}product-tables.mjs');return m.advanceTable(argument,document)}}",
}


def text(value, limit=256):
    return (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and bool(value.strip())
        and all(ord(c) >= 32 and ord(c) != 127 for c in value)
    )


def strings(value, count=32, limit=256):
    return isinstance(value, list) and len(value) <= count and all(text(v, limit) for v in value)


def snapshot_options(value):
    # 中文注释：仅公开有界局部读取参数，分页/frame/文档绑定由后续受信句柄协议承接。
    fields = {"root", "mode", "query", "roles", "viewport", "composed", "accessibility", "budget"}
    if not isinstance(value, dict) or set(value) - fields:
        return False
    if "root" in value and not text(value["root"], 4096):
        return False
    if "query" in value and (
        not isinstance(value["query"], str)
        or len(value["query"]) > 1000
        or any(ord(c) < 32 or ord(c) == 127 for c in value["query"])
    ):
        return False
    if "mode" in value and (
        not isinstance(value["mode"], str)
        or value["mode"] not in {"interactive", "content", "table"}
    ):
        return False
    if "roles" in value and not strings(value["roles"], 32, 80):
        return False
    if any(
        all(char.isspace() or char == "\ufeff" for char in item)
        for item in [value.get("root", "body"), *value.get("roles", [])]
    ):
        return False
    # 中文注释：预算沿扩展和页面引擎的 UTF-16 单元计数。
    if any(
        key in value and len(value[key].encode("utf-16-le", errors="surrogatepass")) // 2 > limit
        for key, limit in (("root", 4096), ("query", 1000))
    ) or any(
        len(role.encode("utf-16-le", errors="surrogatepass")) // 2 > 80
        for role in value.get("roles", [])
    ):
        return False
    if any(
        key in value and type(value[key]) is not bool
        for key in ("viewport", "composed", "accessibility")
    ):
        return False
    if "budget" in value and (
        type(value["budget"]) is not int or not 512 <= value["budget"] <= 6000
    ):
        return False
    return (
        not value.get("accessibility")
        or bool(value.get("root"))
        and value.get("mode", "interactive") == "interactive"
    )


class WorkAdapter:
    def __init__(self, daemon):
        self.daemon = daemon
        self.works = {}
        self.resources = {}
        self.closed_sessions = set()
        self.lock = threading.RLock()

    def denied(self, code="work_request_denied", *, unknown=False):
        return self.daemon.protocol_error(
            code, "work request denied", {"outcomeUnknown": unknown, "retryable": False}
        )

    def _connection(self, extension):
        if self.daemon.extensions.get(extension["instanceId"]) is not extension:
            raise self.denied("connection_replaced")

    def _identity(self, extension, params):
        self._connection(extension)
        if (
            not isinstance(params, dict)
            or not isinstance(params.get("productId"), str)
            or re.fullmatch("[a-p]{32}", params["productId"]) is None
            or not text(params.get("session"), 512)
        ):
            raise self.denied("invalid_params")
        return params["productId"], params["session"]

    @staticmethod
    def _matches(record, extension, identity):
        return (
            record["extension"] is extension
            and record["connectionGeneration"] == extension.get("connectionGeneration")
            and (record["productId"], record["session"]) == identity
        )

    def _session_key(self, extension, identity):
        return (id(extension), extension.get("connectionGeneration"), *identity)

    def _admit(self, extension, identity):
        self._connection(extension)
        if self._session_key(extension, identity) in self.closed_sessions:
            raise self.denied("work_session_closed")

    def _resource(self, extension, identity, handle):
        resource = self.resources.get(handle) if isinstance(handle, str) else None
        if (
            resource is None
            or resource.get("revoked")
            or not self._matches(resource, extension, identity)
        ):
            raise self.denied("work_resource_stale")
        return resource

    def _work(self, extension, identity, handle):
        work = self.works.get(handle) if isinstance(handle, str) else None
        if work is None or not self._matches(work, extension, identity):
            raise self.denied("work_handle_stale")
        task = self.daemon.tasks.get(work["taskId"])
        if (
            task is None
            or task["generation"] != work["generation"]
            or task.get("workProductId") != identity[0]
            or task.get("workSession") != identity[1]
        ):
            raise self.denied("work_handle_stale")
        return work, task

    @staticmethod
    def _overlap(lane, hosts, other_lane, other_hosts):
        return lane == other_lane or bool(set(hosts) & set(other_hosts))

    def _blocked_tasks(self, instance, lane, hosts, *, exclude=None):
        for task in self.daemon.tasks.values():
            if (
                task.get("executionLane") != "product_work"
                or task["instanceId"] != instance
                or task["id"] == exclude
                or not self._overlap(
                    lane, hosts, task.get("workResourceLane"), task.get("workResourceHosts", [])
                )
            ):
                continue
            # 中文注释：旧端口、重启、未知清理均不成为释放资源的证据。
            if (
                task.get("workOutcomeUnknown")
                or task["state"] not in TERMINAL
                or task.get("cleanupState") != "succeeded"
            ):
                return True
        return False

    def _view(self, handle, task, request_id=None):
        result = {
            "workHandle": handle,
            "taskId": task["id"],
            "state": task["state"],
            "generation": task["generation"],
            "modeGeneration": task["modeGeneration"],
            "tabIds": list(task["tabIds"]),
            "outcomeUnknown": task.get("workOutcomeUnknown", False),
            "cleanupState": task.get("cleanupState", "pending"),
        }
        if request_id is not None:
            internal_id = "work-op-" + hashlib.sha256(request_id.encode()).hexdigest()
            digests = {
                hashlib.sha256(item.encode()).hexdigest()
                for item in (
                    internal_id,
                    internal_id + ":fill",
                    internal_id + ":verify",
                    internal_id + ":inspect",
                    internal_id + ":submit",
                )
            }
            entry = next(
                (
                    row
                    for row in reversed(task["requestHistory"])
                    if row.get("requestIdHash") in digests
                ),
                None,
            )
            result["operation"] = (
                {key: entry[key] for key in ("state", "action", "dispatched") if key in entry}
                if entry
                else {"state": "not_found"}
            )
        return result

    def _bind(self, extension, identity, params):
        self._admit(extension, identity)
        if set(params) != {"productId", "session", "resourceId", "epoch", "lane", "hosts"}:
            raise self.denied("invalid_params")
        hosts = params["hosts"]
        if (
            not text(params["resourceId"])
            or not text(params["lane"])
            or type(params["epoch"]) is not int
            or not 0 < params["epoch"] <= 2**53 - 1
            or not isinstance(hosts, list)
            or not 1 <= len(hosts) <= 64
            or any(
                not isinstance(host, str)
                or re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host) is None
                or ".." in host
                for host in hosts
            )
            or len(set(hosts)) != len(hosts)
        ):
            raise self.denied("invalid_params")
        instance, lane = extension["instanceId"], params["lane"]
        for handle, resource in self.resources.items():
            if resource["extension"]["instanceId"] != instance:
                continue
            if (
                self._matches(resource, extension, identity)
                and resource["resourceId"] == params["resourceId"]
            ):
                if (
                    resource["epoch"] != params["epoch"]
                    or resource["lane"] != lane
                    or resource["hosts"] != tuple(hosts)
                    or resource.get("revoked")
                ):
                    raise self.denied("work_resource_stale")
                return {"resourceHandle": handle, "epoch": resource["epoch"]}
            if not resource.get("revoked") and self._overlap(
                lane, hosts, resource["lane"], resource["hosts"]
            ):
                raise self.denied("work_resource_busy")
        if self._blocked_tasks(instance, lane, hosts):
            raise self.denied("work_resource_busy")
        handle = secrets.token_urlsafe(32)
        self.resources[handle] = {
            "extension": extension,
            "connectionGeneration": extension.get("connectionGeneration"),
            "productId": identity[0],
            "session": identity[1],
            "resourceId": params["resourceId"],
            "epoch": params["epoch"],
            "lane": lane,
            "hosts": tuple(hosts),
        }
        return {"resourceHandle": handle, "epoch": params["epoch"]}

    def _open(self, extension, identity, params):
        if (
            set(params) - {"productId", "session", "url", "incognito", "resourceHandle"}
            or not {"url", "incognito"} <= set(params)
            or type(params["incognito"]) is not bool
        ):
            raise self.denied("invalid_params")
        if "resourceHandle" not in params:
            raise self.denied("work_resource_required")
        with self.daemon.state_lock:
            self._admit(extension, identity)
            resource = self._resource(extension, identity, params["resourceHandle"])
            self._url(params["url"], resource)
            for handle, work in self.works.items():
                task = self.daemon.tasks[work["taskId"]]
                if work["resource"] is resource and task["state"] not in TERMINAL:
                    if task.get("workOutcomeUnknown"):
                        raise self.denied("work_outcome_unknown", unknown=True)
                    if work["url"] == params["url"] and task["incognito"] == params["incognito"]:
                        return self._view(handle, task)
                    raise self.denied("work_resource_busy")
            if self._blocked_tasks(extension["instanceId"], resource["lane"], resource["hosts"]):
                raise self.denied("work_resource_busy")
        parsed = urlsplit(params["url"])
        # 中文注释：不持 state_lock 等待无痕权限回执；创建后再次核对连接对象及代次。
        created = self.daemon._create_task(
            {
                "owner": "product-work-" + secrets.token_urlsafe(24),
                "title": "Fast-browser-link · 工作",
                "instanceId": extension["instanceId"],
                "allowedOrigins": [f"{parsed.scheme}://{parsed.netloc}"],
                "incognito": params["incognito"],
            },
            _execution_lane="product_work",
            _silent=True,
        )
        with self.daemon.state_lock:
            task = self.daemon.tasks[created["id"]]
            task.update(
                workProductId=identity[0],
                workSession=identity[1],
                workResourceId=resource["resourceId"],
                workResourceEpoch=resource["epoch"],
                workResourceLane=resource["lane"],
                workResourceHosts=list(resource["hosts"]),
            )
            if self._session_key(extension, identity) in self.closed_sessions:
                self.daemon._revoke_task_locked(task, "closed")
                task.update(cleanupState="succeeded", cleanupReason="never_dispatched")
                self.daemon._persist_tasks()
                raise self.denied("work_session_closed")
            if (
                self.daemon.extensions.get(extension["instanceId"]) is not extension
                or resource["connectionGeneration"] != extension.get("connectionGeneration")
                or resource.get("revoked")
            ):
                self.daemon._revoke_task_locked(task, "needs_sync")
                task.update(cleanupState="unknown", cleanupReason="connection_changed")
                self.daemon._persist_tasks()
                raise self.denied("connection_replaced")
            handle = secrets.token_urlsafe(32)
            work = {
                **resource,
                "resource": resource,
                "resourceHandle": params["resourceHandle"],
                "taskId": task["id"],
                "generation": task["generation"],
                "url": params["url"],
                "initialRequestId": "work-open-" + secrets.token_urlsafe(24),
                "io": threading.Lock(),
            }
            self.works[handle] = work
            self.daemon.task_authorities[task["id"]] = work
            self.daemon._persist_tasks()
            return self._view(handle, task)

    def _url(self, url, resource):
        self.daemon._validate_action_url(url, [])
        parsed = urlsplit(url)
        if parsed.hostname not in resource["hosts"] or parsed.username or parsed.password:
            raise self.denied("work_resource_denied")

    def _reader_arguments(self, reader, args, *, internal=False):
        valid = isinstance(args, dict)
        if reader == "tables_read":
            valid = (
                valid
                and set(args) == {"minimumRows", "headers", "selectors"}
                and type(args["minimumRows"]) is int
                and 1 <= args["minimumRows"] <= 3
                and strings(args["headers"])
                and strings(args["selectors"], 16, 1024)
            )
        elif reader == "field_match" and internal:
            valid = (
                valid
                and set(args) == {"selector", "text"}
                and text(args["selector"], 4096)
                and isinstance(args["text"], str)
                and len(args["text"]) <= 100000
            )
        elif reader == "search_read":
            valid = valid and args == {}
        elif reader == "trends_read":
            valid = (
                valid
                and set(args)
                in ({"keywords", "region", "period"}, {"keywords", "region", "period", "report"})
                and args.get("report", "series") in {"series", "rising"}
                and strings(args["keywords"], 5)
                and bool(args["keywords"])
                and isinstance(args["region"], str)
                and args["region"] in {"US", "WORLD"}
                and isinstance(args["period"], str)
                and args["period"] in {"12m", "5y"}
            )
        elif reader == "report_inspect":
            valid = (
                valid
                and set(args) in ({"ready_selectors"}, {"ready_selectors", "stop_text"})
                and strings(args["ready_selectors"], 16, 1024)
            )
        elif reader == "table_advance":
            valid = (
                valid
                and set(args)
                == ({"headers", "kind", "inspect"} if internal else {"headers", "kind"})
                and strings(args["headers"])
                and isinstance(args["kind"], str)
                and args["kind"] in {"button", "scroll"}
                and (not internal or args["inspect"] is False)
            )
        else:
            valid = False
        if not valid:
            raise self.denied("invalid_params")

    def validate_request(self, task, params, authority, *, dispatch=False):
        # 中文注释：准入、排队后、账本落盘后的实际派发前都重核，不能用私有任务打开通用 JS/CDP。
        with self.daemon.state_lock:
            self.daemon._owned_task(
                {"owner": task["owner"], "taskId": task["id"]}, _authority=authority
            )
            self._admit(authority["extension"], (authority["productId"], authority["session"]))
            self._resource(
                authority["extension"],
                (authority["productId"], authority["session"]),
                authority["resourceHandle"],
            )
            if task.get("workUnknownLatched"):
                raise self.denied("work_outcome_unknown", unknown=True)
            action = params.get("action")
            if action == "js.evaluate":
                reader = (
                    "field_match"
                    if params.get("expression") == FIELD_MATCH
                    else next(
                        (
                            name
                            for name, expression in READERS.items()
                            if expression == params.get("expression")
                        ),
                        None,
                    )
                )
                self._reader_arguments(reader, params.get("arguments"), internal=True)
                if (
                    params.get("world") != "isolated"
                    or params.get("awaitPromise") is not True
                    or params.get("timeoutMs") != 30000
                ):
                    raise self.denied("execution_lane_denied")
            elif action not in {
                "new_tab",
                "navigate",
                "semantic_snapshot",
                "ref_click",
                "click",
                "fill",
            }:
                raise self.denied("execution_lane_denied")
            if (
                action == "semantic_snapshot"
                and "options" in params
                and not (
                    snapshot_options(params["options"])
                    or authority.get("snapshotCommand")
                    == {
                        key: params[key]
                        for key in ("action", "tabId", "options", "binding")
                        if key in params
                    }
                )
            ):
                raise self.denied("invalid_params")
            if task.get("activeMode") != "full":
                raise self.denied("execution_lane_denied")
            if "url" in params:
                self._url(params["url"], authority)
            if action != "new_tab" and (
                type(params.get("tabId")) is not int
                or params["tabId"] not in task["tabIds"]
                or self.daemon.tab_leases.get((task["instanceId"], params["tabId"])) != task["id"]
            ):
                raise self.denied("foreign_tab")
            if dispatch and (
                task["state"] not in {"ready", "running"}
                or params.get("generation") != task["generation"]
                or params.get("modeGeneration") != task["modeGeneration"]
            ):
                raise self.denied("execution_lane_denied")

    def _execute(self, work, task, request_id, command):
        request = {"owner": task["owner"], "taskId": task["id"], "requestId": request_id, **command}
        return self.daemon._run_task(request, _authority=work)

    def _tab(self, task):
        if len(task["tabIds"]) != 1:
            raise self.denied("work_page_unavailable")
        return task["tabIds"][0]

    def _snapshot_current(self, work, task, control):
        identity = (work["productId"], work["session"])
        self._admit(work["extension"], identity)
        self._resource(work["extension"], identity, work["resourceHandle"])
        self.daemon._owned_task({"owner": task["owner"], "taskId": task["id"]}, _authority=work)
        if (
            task["generation"] != work["generation"]
            or task["state"] not in {"ready", "running"}
            or task.get("accessRevoked")
            or task.get("activeMode") != "full"
            or (task["modeGeneration"], task.get("controlEpoch", 0)) != control
        ):
            work.pop("snapshotContinuation", None)
            work.pop("snapshotReply", None)
            work.pop("snapshotBaseline", None)
            raise self.denied("work_resource_stale")
        if task.get("workOutcomeUnknown") or task.get("workUnknownLatched"):
            raise self.denied("work_outcome_unknown", unknown=True)

    def _snapshot_unknown(self, task, internal_id):
        request_hash = hashlib.sha256(internal_id.encode()).hexdigest()
        with self.daemon.state_lock:
            task["workOutcomeUnknown"] = task["workUnknownLatched"] = True
            entry = next(
                row for row in task["requestHistory"] if row["requestIdHash"] == request_hash
            )
            entry["state"] = "unknown"
            self.daemon.dedupe[task["id"]][request_hash] = (entry["payloadHash"], None, None)
            cache_size = self.daemon.result_cache.pop((task["id"], request_hash), 0)
            self.daemon.result_cache_bytes -= cache_size
            self.daemon.pending_journal.append(self.daemon._ledger_record(task, entry))
            self.daemon._persist_tasks()
        # 中文注释：确认回执后的畸形结果仍须同步封账；IO 不持全局状态锁。
        self.daemon._flush_tasks()
        raise self.denied("work_outcome_unknown", unknown=True)

    def _snapshot(self, work, task, request_id, internal_id, args):
        if set(args) not in (set(), {"options"}, {"continuation"}, {"baseline"}):
            raise self.denied("invalid_params")
        if "options" in args and not snapshot_options(args["options"]):
            raise self.denied("invalid_params")
        with self.daemon.state_lock:
            control = (task["modeGeneration"], task.get("controlEpoch", 0))
            self._snapshot_current(work, task, control)
        previous = work.get("snapshotReply")
        if previous and previous[0] == request_id:
            control = previous[3]
            work["snapshotCommand"] = copy.deepcopy(previous[2])
            try:
                # 中文注释：缓存回执也经过原账本的实时撤权检查，不凭产品句柄续权。
                self._execute(work, task, internal_id, copy.deepcopy(previous[2]))
            finally:
                work.pop("snapshotCommand", None)
            with self.daemon.state_lock:
                self._snapshot_current(work, task, control)
                return copy.deepcopy(previous[1])
        continuation = work.get("snapshotContinuation")
        if "baseline" in args:
            baseline = work.get("snapshotBaseline")
            if (
                not text(args["baseline"], 4096)
                or not baseline
                or args["baseline"] != baseline["id"]
            ):
                raise self.denied("work_snapshot_stale")
            options = copy.deepcopy(baseline["options"])
            control = baseline["control"]
            with self.daemon.state_lock:
                self._snapshot_current(work, task, control)
            command = {
                "action": "semantic_snapshot",
                "tabId": self._tab(task),
                "options": {**options, "baselineId": baseline["id"]},
                "binding": copy.deepcopy(baseline["binding"]),
            }
        elif "continuation" in args:
            if (
                not text(args["continuation"])
                or not continuation
                or args["continuation"] != continuation["id"]
            ):
                raise self.denied("work_snapshot_stale")
            options = copy.deepcopy(continuation["options"])
            control = continuation["control"]
            with self.daemon.state_lock:
                self._snapshot_current(work, task, control)
            command = {
                "action": "semantic_snapshot",
                "tabId": self._tab(task),
                "options": {**options, "cursor": continuation["cursor"]},
                "binding": copy.deepcopy(continuation["binding"]),
            }
        else:
            options = copy.deepcopy(args.get("options", {}))
            command = {"action": "semantic_snapshot", "tabId": self._tab(task), **args}
        # 中文注释：每工作页仅一个内存续读；派发前消费，未知结果不恢复资格。
        work.pop("snapshotContinuation", None)
        work.pop("snapshotReply", None)
        work.pop("snapshotBaseline", None)
        work["snapshotCommand"] = copy.deepcopy(command)
        try:
            result = self._execute(work, task, internal_id, command)
        finally:
            work.pop("snapshotCommand", None)
        if not isinstance(result, dict) or result.get("outcomeUnknown"):
            return result
        result = copy.deepcopy(result)
        cursor = result.get("nextCursor")
        next_record = None
        if cursor is not None:
            binding = result.get("binding")
            # 中文注释：增量 items 只含变化项；空补丁仍可有已物化顺序和合法后续页。
            delta_progress = (
                "baseline" in args
                and result.get("kind") == "delta"
                and result.get("baselineId") == args["baseline"]
                and strings(result.get("order"), 12000, 4096)
                and bool(result["order"])
                and strings(result.get("removed"), 12000, 4096)
            )
            if (
                not text(cursor, 4096)
                or not isinstance(binding, dict)
                or set(binding) != {"taskId", "documentId", "leaseId"}
                or not all(text(value, 128) for value in binding.values())
                or binding["taskId"] != task["id"]
                or not isinstance(result.get("items"), list)
                or (not result["items"] and not delta_progress)
                or any(
                    not isinstance(item, dict) or not text(item.get("ref"), 4096)
                    for item in result["items"]
                )
            ):
                self._snapshot_unknown(task, internal_id)
            if result.get("resync"):
                result["nextCursor"] = None
            elif options.get("accessibility"):
                # 中文注释：原生局部 AX 读取不接受 cursor；保留不完整覆盖，不发无法使用的续读。
                result["nextCursor"] = None
                result["resync"] = {"reason": "accessibility_pagination_unavailable"}
            else:
                token = secrets.token_urlsafe(32)
                next_record = {
                    "id": token,
                    "cursor": cursor,
                    "options": options,
                    "binding": copy.deepcopy(binding),
                    "control": control,
                }
                result["nextCursor"] = token
        with self.daemon.state_lock:
            self._snapshot_current(work, task, control)
            if next_record is not None:
                work["snapshotContinuation"] = next_record
            # 中文注释：公开快照编号只索引当前工作页的原参数与绑定，不授予调用方原生资格。
            # 原生基线属于一个有界片段；续页和局部 AX 不沿用首段基线。
            binding = result.get("binding")
            if (
                "continuation" not in args
                and not options.get("accessibility")
                and text(result.get("snapshotId"), 4096)
                and isinstance(binding, dict)
                and set(binding) == {"taskId", "documentId", "leaseId"}
                and all(text(value, 128) for value in binding.values())
                and binding["taskId"] == task["id"]
            ):
                work["snapshotBaseline"] = {
                    "id": result["snapshotId"],
                    "options": options,
                    "binding": copy.deepcopy(binding),
                    "control": control,
                }
            work["snapshotReply"] = (
                request_id,
                copy.deepcopy(result),
                copy.deepcopy(command),
                control,
            )
            return result

    def _operation(self, work, task, request_id, operation, args):
        if not isinstance(operation, str) or not isinstance(args, dict):
            raise self.denied("invalid_params")
        # 中文注释：逻辑编号先绑定整个固定操作，复合动作不能复用单步编号或派生子编号。
        digest = hashlib.sha256(
            json.dumps([operation, args], sort_keys=True, allow_nan=False).encode()
        ).hexdigest()
        previous = work.setdefault("operations", {}).get(request_id)
        if previous is not None and previous != digest:
            raise self.denied("request_id_conflict")
        if (
            operation == "snapshot"
            and previous is not None
            and (not work.get("snapshotReply") or work["snapshotReply"][0] != request_id)
        ):
            raise self.denied("work_snapshot_stale")
        work["operations"][request_id] = digest
        internal_id = "work-op-" + hashlib.sha256(request_id.encode()).hexdigest()
        shapes = {
            "navigate": {"url"},
            "click": {"selector"},
            "fill": {"selector", "text"},
            "query_submit": {"selector", "text", "submitSelector"},
        }
        tab = self._tab(task)
        if operation == "snapshot":
            return self._snapshot(work, task, request_id, internal_id, args)
        work.pop("snapshotContinuation", None)
        work.pop("snapshotReply", None)
        work.pop("snapshotBaseline", None)
        if operation in READERS:
            self._reader_arguments(operation, args)
            argument = copy.deepcopy(args)
            if operation == "table_advance":
                argument["inspect"] = False
            command = {
                "action": "js.evaluate",
                "tabId": tab,
                "expression": READERS[operation],
                "arguments": argument,
                "world": "isolated",
                "awaitPromise": True,
                "timeoutMs": 30000,
            }

        elif operation == "query_submit" and set(args) == {"root", "names"}:
            if not text(args["root"], 4096) or not strings(args["names"], 32) or not args["names"]:
                raise self.denied("invalid_params")
            snapshot = self._execute(
                work,
                task,
                internal_id + ":inspect",
                {
                    "action": "semantic_snapshot",
                    "tabId": tab,
                    "options": {
                        "mode": "interactive",
                        "root": args["root"],
                        "roles": ["button"],
                        "budget": 4000,
                    },
                },
            )
            if not isinstance(snapshot, dict) or snapshot.get("outcomeUnknown"):
                return snapshot
            choices = [
                item
                for item in snapshot.get("items", [])
                if item.get("role") == "button"
                and str(item.get("name", "")).strip() in args["names"]
            ]
            if len(choices) != 1:
                raise self.denied("query_control_unavailable")
            return self._execute(
                work,
                task,
                internal_id + ":submit",
                {
                    "action": "ref_click",
                    "tabId": tab,
                    "binding": snapshot["binding"],
                    "snapshotId": snapshot["snapshotId"],
                    "ref": choices[0]["ref"],
                },
            )
        elif operation in shapes and set(args) == shapes[operation]:
            if operation == "query_submit":
                if (
                    not text(args["selector"], 4096)
                    or not text(args["submitSelector"], 4096)
                    or not isinstance(args["text"], str)
                    or len(args["text"]) > 100000
                ):
                    raise self.denied("invalid_params")
                fill = self._execute(
                    work,
                    task,
                    internal_id + ":fill",
                    {
                        "action": "fill",
                        "tabId": tab,
                        "selector": args["selector"],
                        "text": args["text"],
                    },
                )
                if (
                    not isinstance(fill, dict)
                    or fill.get("outcomeUnknown")
                    or not (
                        fill.get("filled") is True
                        or fill.get("status") == "confirmed"
                        or fill == {"ok": True}
                    )
                ):
                    return fill
                # 中文注释：普通 fill 的 ok 只证明派发回执；固定只读函数核对字段值后才可点击。
                verified = self._execute(
                    work,
                    task,
                    internal_id + ":verify",
                    {
                        "action": "js.evaluate",
                        "tabId": tab,
                        "expression": FIELD_MATCH,
                        "arguments": {"selector": args["selector"], "text": args["text"]},
                        "world": "isolated",
                        "awaitPromise": True,
                        "timeoutMs": 30000,
                    },
                )
                if (
                    not isinstance(verified, dict)
                    or verified.get("outcomeUnknown")
                    or verified.get("data") != {"matches": True}
                ):
                    raise self.denied("query_field_unconfirmed")
                return self._execute(
                    work,
                    task,
                    internal_id + ":submit",
                    {"action": "click", "tabId": tab, "selector": args["submitSelector"]},
                )
            command = {
                "action": "semantic_snapshot" if operation == "snapshot" else operation,
                "tabId": tab,
                **args,
            }
        else:
            raise self.denied("invalid_params")
        return self._execute(work, task, internal_id, command)

    def _close_work(self, work, task):
        if task["state"] not in TERMINAL:
            self.daemon._release_task(
                {"owner": task["owner"], "taskId": task["id"]}, "closed", True, _authority=work
            )

    def _revoke(self, resources):
        with self.daemon.state_lock:
            for resource in resources:
                resource["revoked"] = True
            closing = [
                (work, self.daemon.tasks[work["taskId"]])
                for work in self.works.values()
                if any(work["resource"] is resource for resource in resources)
            ]
        for work, task in closing:
            self._close_work(work, task)
        return (
            "unknown"
            if any(
                task.get("cleanupState") != "succeeded" or task.get("workOutcomeUnknown")
                for _, task in closing
            )
            else "succeeded"
        )

    def _guard(self, extension, params):
        # 中文注释：只供真实扩展的 Executor 用实时 URL 回查，JSON 不携带任何授权。
        with self.daemon.state_lock:
            self._connection(extension)
            if (
                not isinstance(params, dict)
                or set(params) != {"taskId", "url"}
                or not text(params.get("taskId"))
            ):
                raise self.denied("invalid_params")
            task = self.daemon.tasks.get(params["taskId"])
            work = self.daemon.task_authorities.get(params["taskId"])
            if (
                not task
                or task.get("executionLane") != "product_work"
                or not work
                or not any(record is work for record in self.works.values())
            ):
                raise self.denied("work_handle_stale")
            identity = (work["productId"], work["session"])
            self._admit(extension, identity)
            self.daemon._owned_task({"owner": task["owner"], "taskId": task["id"]}, _authority=work)
            resource = self._resource(extension, identity, work["resourceHandle"])
            if (
                not self._matches(work, extension, identity)
                or work["resource"] is not resource
                or task["instanceId"] != extension["instanceId"]
                or task.get("workProductId") != identity[0]
                or task.get("workSession") != identity[1]
                or any(
                    task.get(key) != resource[field]
                    for key, field in (
                        ("workResourceId", "resourceId"),
                        ("workResourceEpoch", "epoch"),
                        ("workResourceLane", "lane"),
                    )
                )
                or task.get("workResourceHosts") != list(resource["hosts"])
                or task["state"] not in {"ready", "running"}
                or task.get("activeMode") != "full"
            ):
                raise self.denied("work_resource_stale")
            if task.get("workUnknownLatched") or (
                task.get("workOutcomeUnknown") and task["state"] != "running"
            ):
                raise self.denied("work_outcome_unknown", unknown=True)
            self._url(params["url"], resource)
            return {"allowed": True}

    def dispatch_extension(self, extension, method, params):
        if method == PREFIX + "guard":
            return self._guard(extension, params)
        with self.daemon.state_lock:
            identity = self._identity(extension, params)
        if method == PREFIX + "resource_bind":
            with self.lock, self.daemon.state_lock:
                self._identity(extension, params)
                return self._bind(extension, identity, params)
        if method == PREFIX + "open":
            with self.lock:
                return self._open(extension, identity, params)
        if method == PREFIX + "session_close" and set(params) == {"productId", "session"}:
            with self.daemon.state_lock:
                # 中文注释：首个等待前封准入；在途 open 必须在创建返回后再次核实。
                self.closed_sessions.add(self._session_key(extension, identity))
                resources = [
                    r for r in self.resources.values() if self._matches(r, extension, identity)
                ]
            return {"state": "closed", "cleanupState": self._revoke(resources)}
        if method == PREFIX + "resource_revoke" and set(params) == {
            "productId",
            "session",
            "resourceHandle",
        }:
            with self.daemon.state_lock:
                resource = self._resource(extension, identity, params["resourceHandle"])
            return {"state": "revoked", "cleanupState": self._revoke([resource])}
        keys = {"productId", "session", "workHandle"}
        get = method == PREFIX + "get" and set(params) in (keys, keys | {"requestId"})
        run = method == PREFIX + "run" and set(params) == keys | {
            "requestId",
            "operation",
            "arguments",
        }
        close = method == PREFIX + "close" and set(params) == keys | {"requestId"}
        if not (get or run or close) or ("requestId" in params and not text(params["requestId"])):
            raise self.denied("invalid_params")
        with self.daemon.state_lock:
            work, task = self._work(extension, identity, params["workHandle"])
        if close:
            self._close_work(work, task)
            return self._view(params["workHandle"], task)
        if get and (task["state"] != "ready" or task["tabIds"] or task.get("workOutcomeUnknown")):
            return self._view(params["workHandle"], task, params.get("requestId"))
        if not work["io"].acquire(blocking=False):
            raise self.denied("work_busy")
        try:
            with self.daemon.state_lock:
                self._admit(extension, identity)
                self._work(extension, identity, params["workHandle"])
                if task.get("workOutcomeUnknown"):
                    raise self.denied("work_outcome_unknown", unknown=True)
            if get:
                self._execute(
                    work, task, work["initialRequestId"], {"action": "new_tab", "url": work["url"]}
                )
                return self._view(params["workHandle"], task, params.get("requestId"))
            return self._operation(
                work,
                task,
                params["requestId"],
                params["operation"],
                copy.deepcopy(params["arguments"]),
            )
        except self.daemon.protocol_error as exc:
            # 中文注释：外部错误原文可能含页面正文，不返回产品或写入适配器日志。
            safe = {
                "invalid_params",
                "work_resource_stale",
                "work_resource_denied",
                "work_outcome_unknown",
                "work_page_unavailable",
                "execution_lane_denied",
                "foreign_tab",
                "task_preparing",
                "task_closed",
                "task_paused",
                "request_id_conflict",
                "request_outcome_unavailable",
                "work_session_closed",
                "query_field_unconfirmed",
                "query_control_unavailable",
            }
            raise self.denied(
                exc.code if exc.code in safe else "work_execution_failed",
                unknown=task.get("workOutcomeUnknown", False),
            ) from None
        finally:
            work["io"].release()

    def connection_changed(self, instance, connected):
        # 中文注释：daemon 已先撤旧代任务；资源只做内存撤销，不能等待失联扩展回执。
        with self.daemon.state_lock:
            current = self.daemon.extensions.get(instance)
            for resource in self.resources.values():
                if resource["extension"]["instanceId"] == instance and (
                    not connected or resource["extension"] is not current
                ):
                    resource["revoked"] = True

    def close(self):
        with self.daemon.state_lock:
            for resource in self.resources.values():
                resource["revoked"] = True
