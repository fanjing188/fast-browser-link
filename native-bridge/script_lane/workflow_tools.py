"""有界持久工作流：检查点不授予浏览器权限，不存输入正文，不重放在途写入。"""

from __future__ import annotations
from contextlib import contextmanager
import copy
import csv
import datetime as dt
import fcntl
import hashlib
import hmac
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import threading
import time
import zipfile

KEY = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
MAX_BYTES = 512 * 1024


class WorkflowError(ValueError):
    outcomeUnknown = False

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def deny(code="workflow_invalid"):
    raise WorkflowError(code)


def encoded(value):
    try:
        result = json.dumps(
            value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")
        )
    except (ValueError, TypeError):
        deny()
    if len(result.encode()) > MAX_BYTES:
        deny("workflow_capacity")
    return result


def budget_options(value):
    result = {"max_seconds": 600, "max_operations": 2000, "max_wait_seconds": 120}
    if value is not None:
        if not isinstance(value, dict) or set(value) - set(result):
            deny()
        result.update(value)
    for key, limit in [
        ("max_seconds", 3600),
        ("max_operations", 20000),
        ("max_wait_seconds", 1800),
    ]:
        x = result[key]
        if type(x) not in (int, float) or not math.isfinite(x) or not 0 < x <= limit:
            deny()
        if key == "max_operations" and type(x) is not int:
            deny()
    return result


class Store:
    """可信宿主使用；进程间 flock 保持整个运行所有权，SQLite FULL 提交在派发前完成。"""

    def __init__(self, home):
        self.root = Path(home) / "plugin-data" / "fast-browser-link-native" / "workflows"
        for p in reversed([self.root, *self.root.parents]):
            if p.exists() and p.is_symlink():
                deny("workflow_storage")
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.path = self.root / "state.sqlite3"
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        info = os.fstat(fd)
        os.close(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            deny("workflow_storage")
        self.guard = threading.RLock()
        self.active = {}
        with self.db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS records (scope TEXT, name TEXT, body TEXT, PRIMARY KEY(scope,name))"
            )
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT OR IGNORE INTO meta VALUES('hmac',?)", (secrets.token_hex(32),))
            self.secret = bytes.fromhex(
                db.execute("SELECT value FROM meta WHERE key='hmac'").fetchone()[0]
            )

    @contextmanager
    def db(self):
        c = sqlite3.connect(self.path, timeout=5)
        try:
            c.execute("PRAGMA synchronous=FULL")
            c.execute("PRAGMA max_page_count=16384")
            with c:
                yield c
        except sqlite3.Error as error:
            deny(
                "workflow_capacity"
                if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL
                else "workflow_storage"
            )
        finally:
            c.close()

    def digest(self, value):
        return hmac.new(self.secret, encoded(value).encode(), hashlib.sha256).hexdigest()

    def _load(self, db, scope, name):
        row = db.execute(
            "SELECT body FROM records WHERE scope=? AND name=?", (scope, name)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def _save(self, db, scope, name, row):
        if (
            self._load(db, scope, name) is None
            and db.execute("SELECT count(*) FROM records WHERE scope=?", (scope,)).fetchone()[0]
            >= 256
        ):
            deny("workflow_capacity")
        db.execute("INSERT OR REPLACE INTO records VALUES(?,?,?)", (scope, name, encoded(row)))

    def _lock(self, scope, name):
        path = self.root / (self.digest([scope, name]) + ".lock")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            deny("workflow_storage")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            deny("workflow_busy")
        return fd

    def _release(self, scope):
        active = self.active.pop(scope, None)
        if active:
            os.close(active["fd"])

    def close(self):
        with self.guard:
            for scope in list(self.active):
                self._release(scope)

    def _elapsed(self, row, active):
        return active["base_elapsed"] + max(0, time.monotonic() - active["started"])

    def debit(self, scope, wait=0, operation=True, write=False):
        with self.guard:
            a = self.active.get(scope)
            if not a:
                return
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self._load(db, scope, a["name"])
                elapsed = self._elapsed(row, a)
                if elapsed >= row["budget"]["max_seconds"]:
                    deny("workflow_time_budget")
                if operation and row["operations"] >= row["budget"]["max_operations"]:
                    deny("workflow_operation_budget")
                if wait and row["wait_seconds"] + wait > row["budget"]["max_wait_seconds"]:
                    deny("workflow_wait_budget")
                row["operations"] += int(operation)
                if write and row["inflight"] is not None:
                    row["may_write"] = True
                row["wait_seconds"] += wait
                row["elapsed"] = elapsed
                self._save(db, scope, a["name"], row)

    def call(self, scope, op, data):
        if not isinstance(data, dict):
            deny()
        name = data.get("name")
        if not isinstance(name, str) or not KEY.fullmatch(name):
            deny()
        allowed = {
            "get": {"name"},
            "begin": {"name", "plan", "resume", "budget"},
            "arm": {"name", "token", "index"},
            "settle": {"name", "token", "index", "entry"},
            "finish": {"name", "token", "status"},
            "resolve": {"name", "plan"},
            "abort": {"name", "token"},
            "extend": {"name", "budget"},
            "recipe_save": {"name", "value"},
        }
        if op not in allowed or set(data) - allowed[op]:
            deny()
        with self.guard:
            if op == "get":
                with self.db() as db:
                    return self._load(db, scope, name)
            if op == "begin":
                if scope in self.active:
                    deny("workflow_busy")
                if type(data.get("resume", False)) is not bool:
                    deny()
                plan = data.get("plan")
                if not isinstance(plan, list) or not 1 <= len(plan) <= 100:
                    deny()
                layout = []
                for item in plan:
                    if (
                        not isinstance(item, dict)
                        or set(item) != {"id", "steps"}
                        or not isinstance(item["id"], str)
                        or not KEY.fullmatch(item["id"])
                        or not isinstance(item["steps"], list)
                        or not 1 <= len(item["steps"]) <= 16
                    ):
                        deny()
                    layout.append({"id": item["id"], "count": len(item["steps"])})
                if len({x["id"] for x in layout}) != len(layout):
                    deny()
                digest = self.digest(plan)
                budget = budget_options(data.get("budget"))
                fd = self._lock(scope, name)
                try:
                    with self.db() as db:
                        db.execute("BEGIN IMMEDIATE")
                        row = self._load(db, scope, name)
                        if row:
                            if not data.get("resume"):
                                deny("workflow_exists")
                            if row["digest"] != digest or row["budget"] != budget:
                                deny("workflow_plan_changed")
                            if row["inflight"] is not None or row["status"] == "blocked":
                                deny("workflow_reconciliation_required")
                        else:
                            row = {
                                "name": name,
                                "digest": digest,
                                "layout": layout,
                                "entries": {},
                                "inflight": None,
                                "status": "running",
                                "operations": 0,
                                "wait_seconds": 0,
                                "elapsed": 0,
                                "budget": budget,
                                "created_at": time.time(),
                            }
                        row["status"] = "running"
                        self._save(db, scope, name, row)
                    token = secrets.token_hex(16)
                    self.active[scope] = {
                        "name": name,
                        "token": token,
                        "fd": fd,
                        "started": time.monotonic(),
                        "base_elapsed": row["elapsed"],
                    }
                    return {"token": token, "record": row}
                except BaseException:
                    os.close(fd)
                    raise
            if op == "recipe_save":
                value = data.get("value")
                if not isinstance(value, dict) or set(value) != {"steps", "surface"}:
                    deny()
                if (
                    not isinstance(value["steps"], list)
                    or not 1 <= len(value["steps"]) <= 16
                    or not isinstance(value["surface"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", value["surface"])
                ):
                    deny()
                # 中文注释：模板只保存参数键与定位描述，拒绝持久化输入值/引用/页面正文。
                for step in value["steps"]:
                    if not isinstance(step, dict) or set(step) - {
                        "action",
                        "name",
                        "role",
                        "root",
                        "value_key",
                        "key",
                        "direction",
                    }:
                        deny()
                    if any(not isinstance(v, str) or len(v) > 2000 for v in step.values()):
                        deny()
                    if step.get("action") not in {"click", "fill", "press", "scroll"}:
                        deny()
                    if step["action"] == "fill" and (
                        not isinstance(step.get("value_key"), str)
                        or not KEY.fullmatch(step["value_key"])
                    ):
                        deny()
                if not 1 <= len(value["steps"]) <= 16:
                    deny()
                with self.db() as db:
                    self._save(db, scope, name, value)
                return {"saved": True}
            if op == "extend":
                fd = self._lock(scope, name)
                try:
                    with self.db() as db:
                        db.execute("BEGIN IMMEDIATE")
                        row = self._load(db, scope, name)
                        limits = budget_options(data.get("budget"))
                        if not row or row["inflight"] is not None:
                            deny("workflow_reconciliation_required")
                        if (
                            limits["max_operations"] < row["operations"]
                            or limits["max_seconds"] < row["elapsed"]
                            or limits["max_wait_seconds"] < row["wait_seconds"]
                        ):
                            deny()
                        row["budget"] = limits
                        self._save(db, scope, name, row)
                        return row
                finally:
                    os.close(fd)
            if op == "resolve":
                fd = self._lock(scope, name)
                try:
                    with self.db() as db:
                        db.execute("BEGIN IMMEDIATE")
                        row = self._load(db, scope, name)
                        if (
                            not row
                            or row["digest"] != self.digest(data.get("plan"))
                            or row["inflight"] is None
                        ):
                            deny("workflow_plan_changed")
                        # 中文注释：证据仅澄清原已派发步骤；不重新派发、不复活授权。
                        row["entries"][row["inflight"]] = {
                            "state": "confirmed",
                            "reconciled": True,
                            "verified": True,
                            "dispatched": True,
                        }
                        row["inflight"] = None
                        row["status"] = "paused"
                        self._save(db, scope, name, row)
                        return row
                finally:
                    os.close(fd)
            a = self.active.get(scope)
            if not a or a["name"] != name or a["token"] != data.get("token"):
                deny("workflow_stale")
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self._load(db, scope, name)
                row["elapsed"] = self._elapsed(row, a)
                index = data.get("index")
                if op in {"arm", "settle"}:
                    if not isinstance(index, str) or not re.fullmatch(r"\d{1,2}:\d{1,2}", index):
                        deny()
                    i, j = map(int, index.split(":"))
                    if i >= len(row["layout"]) or j >= row["layout"][i]["count"]:
                        deny()
                if op == "arm":
                    if (
                        row["inflight"] is not None
                        or row["entries"].get(index, {}).get("state") == "confirmed"
                    ):
                        deny("workflow_stale")
                    row["inflight"] = index
                    row["may_write"] = False
                elif op == "settle":
                    if row["inflight"] != index:
                        deny("workflow_stale")
                    entry = data.get("entry")
                    if not isinstance(entry, dict) or set(entry) - {
                        "state",
                        "reason",
                        "dispatched",
                        "delivery",
                        "effect",
                        "verified",
                    }:
                        deny()
                    if entry.get("state") not in {"confirmed", "pending", "blocked"}:
                        deny()
                    if type(entry.get("verified")) is not bool or (
                        entry.get("dispatched") is not None
                        and type(entry["dispatched"]) is not bool
                    ):
                        deny()
                    if any(
                        not isinstance(entry[k], str) or len(entry[k]) > 80
                        for k in ["reason", "delivery", "effect"]
                        if entry.get(k) is not None
                    ):
                        deny()
                    row["entries"][index] = entry
                    if entry["state"] != "blocked":
                        row["inflight"] = None
                elif op == "abort":
                    if row.get("may_write") is False:
                        row["inflight"] = None
                elif op == "finish":
                    row["status"] = (
                        "blocked" if row["inflight"] is not None else data.get("status", "paused")
                    )
                    if row["status"] not in {"blocked", "paused", "completed"}:
                        deny()
                else:
                    deny()
                self._save(db, scope, name, row)
            if op == "finish":
                self._release(scope)
            return row


def summary(row):
    if not row:
        return {"found": False}
    items = []
    for i, item in enumerate(row["layout"]):
        states = [
            row["entries"].get(f"{i}:{j}", {}).get("state", "pending") for j in range(item["count"])
        ]
        state = (
            "completed"
            if all(x == "confirmed" for x in states)
            else "blocked"
            if "blocked" in states or row["inflight"] and row["inflight"].startswith(f"{i}:")
            else "failed"
            if any(row["entries"].get(f"{i}:{j}", {}).get("reason") for j in range(item["count"]))
            else "pending"
        )
        items.append(
            {
                "id": item["id"],
                "state": state,
                "confirmed": states.count("confirmed"),
                "remaining": len(states) - states.count("confirmed"),
            }
        )
    status = (
        "completed"
        if all(x["state"] == "completed" for x in items) and row["inflight"] is None
        else "blocked"
        if row["inflight"] is not None
        else row["status"]
    )
    return {
        "found": True,
        "name": row["name"],
        "status": status,
        "items": items,
        "counts": {
            key: sum(x["state"] == key for x in items)
            for key in ["completed", "failed", "blocked", "pending"]
        },
        "inflight": row["inflight"],
        "verified_steps": sum(x.get("verified") is True for x in row["entries"].values()),
        "unverified_confirmed_steps": sum(
            x.get("state") == "confirmed" and x.get("verified") is not True
            for x in row["entries"].values()
        ),
        "operations": row["operations"],
        "elapsed_seconds": round(row["elapsed"], 3),
        "wait_seconds": round(row["wait_seconds"], 3),
        "budget": row["budget"],
        "entries": row["entries"],
        "notice": "步骤完成仅表示声明的动作/后置条件满足；不代表未声明的业务结果。",
    }


def execute(api, module, name, items, resume=False, budget=None, progress=None):
    if not isinstance(name, str) or not KEY.fullmatch(name) or type(resume) is not bool:
        deny()
    items = copy.deepcopy(items)
    progress = copy.deepcopy(progress)
    budget = budget_options(copy.deepcopy(budget))
    encoded(items)
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        deny()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"id", "steps"}:
            deny()
        if not isinstance(item["id"], str) or not KEY.fullmatch(item["id"]):
            deny()
        module.validate_steps(api, item["steps"])
    if len({item["id"] for item in items}) != len(items):
        deny()
    api["ready"]()
    api["resilience_ready"]()
    if progress is not None:
        api["business_progress"](progress)
    opened = api["state"](
        "begin", {"name": name, "plan": items, "resume": resume, "budget": budget}
    )
    token = opened["token"]
    row = opened["record"]
    if api.get("limit_deadline"):
        api["limit_deadline"](max(0.001, row["budget"]["max_seconds"] - row["elapsed"]))
    skipped = 0
    stopped = None
    outcome_unknown = False
    try:
        # 中文注释：所有 CSS 先由既有可信观察接口校验，整批预检在首次写入前完成。
        selectors = set()
        for item in items:
            for step in item["steps"]:
                if "root" in step:
                    selectors.add(step["root"])
                for side in ["before", "after"]:
                    for condition in step.get(side, {}).get("conditions", []):
                        if condition["kind"] == "element":
                            selectors.add(condition["selector"])
        for selector in sorted(selectors):
            api["observe"](selector)
        for i, item in enumerate(items):
            for j, step in enumerate(item["steps"]):
                index = f"{i}:{j}"
                if row["entries"].get(index, {}).get("state") == "confirmed":
                    skipped += 1
                    continue
                row = api["state"]("arm", {"name": name, "token": token, "index": index})
                result = module.run_steps(
                    api, [step], min(60, budget_options(budget)["max_seconds"])
                )
                receipt = (result.get("steps") or [{}])[-1]
                unknown = result.get("outcome_unknown") is not False
                outcome_unknown = outcome_unknown or unknown
                sent = receipt.get("dispatched") is not False
                state = (
                    "confirmed"
                    if result.get("completed")
                    else "blocked"
                    if unknown or sent
                    else "pending"
                )
                entry = {
                    "state": state,
                    "reason": result.get("reason"),
                    "dispatched": receipt.get("dispatched", None),
                    "verified": bool(step.get("after"))
                    and receipt.get("after", {}).get("satisfied") is True,
                }
                entry.update(
                    {
                        k: receipt["receipt"][k]
                        for k in ["delivery", "effect"]
                        if k in receipt.get("receipt", {})
                    }
                )
                row = api["state"](
                    "settle", {"name": name, "token": token, "index": index, "entry": entry}
                )
                if state != "confirmed":
                    stopped = result.get("reason")
                    if state == "blocked" or stopped in {
                        "workflow_time_budget",
                        "workflow_operation_budget",
                        "workflow_wait_budget",
                        "execution_handoff",
                        "execution_circuit_open",
                        "access_cooldown",
                        "execution_no_progress",
                        "execution_progress_incomplete",
                    }:
                        raise StopIteration
                    break
    except StopIteration:
        pass
    except api["BrowserError"] as error:
        stopped = error.code or "browser_error"
        outcome_unknown = error.outcome_unknown is not False
        if not outcome_unknown:
            try:
                row = api["state"]("abort", {"name": name, "token": token})
            except api["BrowserError"]:
                pass
        # 中文注释：若异常发生在 arm 后，保留 in-flight；绝不根据异常文字猜测是否送达。
    finally:
        try:
            report = summary(
                api["state"]("finish", {"name": name, "token": token, "status": "paused"})
            )
        except api["BrowserError"]:
            report = summary(row)
            report["status"] = "blocked"
            report["checkpoint_unconfirmed"] = True
            outcome_unknown = True
    if all(x["state"] == "completed" for x in report["items"]):
        report["status"] = "completed"
    report["completed"] = report["status"] == "completed"
    report["reason"] = stopped
    report["skipped_confirmed_steps"] = skipped
    report["outcome_unknown"] = outcome_unknown
    return report


def surface(api, steps):
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        deny()
    rows = []
    for step in steps:
        if not isinstance(step, dict) or set(step) - {
            "action",
            "name",
            "role",
            "root",
            "value_key",
            "key",
            "direction",
        }:
            deny()
        if step.get("action") not in {"click", "fill", "press", "scroll"}:
            deny()
        if step["action"] == "fill" and (
            not isinstance(step.get("value_key"), str) or not KEY.fullmatch(step["value_key"])
        ):
            deny()
        if step["action"] == "scroll":
            continue
        report = api["diagnose_target"](
            step.get("name"),
            action=step["action"],
            **{k: step[k] for k in ["role", "root"] if k in step},
        )
        if report.get("complete") is not True or report.get("actionable") is not True:
            deny("workflow_recipe_stale")
        rows.append(report)
    return hashlib.sha256(encoded(rows).encode()).hexdigest()


def expected_options(expected):
    options = {
        "format": None,
        "min_bytes": 1,
        "max_bytes": 100 * 1024 * 1024,
        "min_rows": None,
        "max_rows": None,
        "required_columns": [],
        "date_column": None,
        "date_from": None,
        "date_to": None,
        "sha256": None,
    }
    if expected is not None:
        if not isinstance(expected, dict) or set(expected) - set(options):
            deny()
        options.update(expected)
    for key in ["min_bytes", "max_bytes", "min_rows", "max_rows"]:
        if options[key] is not None and (
            type(options[key]) is not int or not 0 <= options[key] <= 100 * 1024 * 1024
        ):
            deny()
    if type(options["min_bytes"]) is not int or type(options["max_bytes"]) is not int:
        deny()
    if (
        options["min_rows"] is not None
        and options["max_rows"] is not None
        and options["min_rows"] > options["max_rows"]
    ):
        deny()
    if options["min_bytes"] > options["max_bytes"]:
        deny()
    if (
        not isinstance(options["required_columns"], list)
        or len(options["required_columns"]) > 100
        or any(not isinstance(x, str) or len(x) > 200 for x in options["required_columns"])
    ):
        deny()
    bounds = {}
    for key in ["date_from", "date_to"]:
        if options[key] is not None:
            try:
                bounds[key] = dt.date.fromisoformat(options[key])
            except (ValueError, TypeError):
                deny()
    if options["date_column"] is not None and not isinstance(options["date_column"], str):
        deny()
    if bounds and not options["date_column"]:
        deny()
    if len(bounds) == 2 and bounds["date_from"] > bounds["date_to"]:
        deny()
    if options["sha256"] is not None and (
        not isinstance(options["sha256"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", options["sha256"])
    ):
        deny()
    if options["format"] is not None and not isinstance(options["format"], str):
        deny()
    if options["format"] not in {None, "csv", "json", "zip", "pdf", "png", "jpeg", "xlsx"}:
        deny()
    return options, bounds


def verify_file(path, expected=None):
    """只读取已领取的工作区文件；严格验证 CSV/JSON/ZIP/PDF/常见图片，不执行文件内容。"""
    options, bounds = expected_options(expected)
    candidate = Path(path)
    fd = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > options["max_bytes"]:
            return {"valid": False, "reason": "file_size"}
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(options["max_bytes"] + 1)
        final = os.fstat(fd)
        if (final.st_size, final.st_mtime_ns, final.st_ctime_ns) != (
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        ) or final.st_size != len(data):
            return {"valid": False, "reason": "file_changed"}
    finally:
        os.close(fd)
    digest = hashlib.sha256(data).hexdigest()
    result = {"valid": False, "size": len(data), "sha256": digest, "reason": None}
    if not options["min_bytes"] <= len(data) <= options["max_bytes"]:
        result["reason"] = "file_size"
        return result
    if options["sha256"] and digest != options["sha256"]:
        result["reason"] = "digest_mismatch"
        return result
    kind = options["format"] or {
        ".csv": "csv",
        ".json": "json",
        ".zip": "zip",
        ".pdf": "pdf",
        ".png": "png",
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".xlsx": "xlsx",
    }.get(candidate.suffix.lower())
    records = None
    try:
        if kind in {"csv", "json", "xlsx"} and len(data) > 16 * 1024 * 1024:
            return {**result, "reason": "validation_limit"}
        if kind == "xlsx":
            records, columns = xlsx_rows(data)
        elif kind == "csv":
            text = data.decode("utf-8-sig")
            if (
                text.lstrip()
                .lower()
                .startswith(("<!doctype html", "<html", "<form", "<head", "<body", "<?xml"))
            ):
                raise ValueError
            reader = csv.DictReader(io.StringIO(text), strict=True)
            if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
                raise ValueError
            records = []
            for row in reader:
                if None in row or any(x is None for x in row.values()) or len(records) >= 100000:
                    raise ValueError
                records.append(row)
            columns = set(reader.fieldnames)
        elif kind == "json":
            obj = json.loads(data.decode("utf-8-sig"))
            if (
                not isinstance(obj, list)
                or len(obj) > 100000
                or any(not isinstance(x, dict) for x in obj)
            ):
                raise ValueError
            records = obj
            columns = set.intersection(*(set(x) for x in records)) if records else set()
        elif kind == "zip":
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                rows = z.infolist()
                if (
                    len(rows) > 1000
                    or sum(x.file_size for x in rows) > 100 * 1024 * 1024
                    or any(x.flag_bits & 1 for x in rows)
                    or z.testzip() is not None
                ):
                    raise ValueError
        elif kind == "pdf":
            if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-2048:]:
                raise ValueError
        elif kind == "png":
            if not data.startswith(b"\x89PNG\r\n\x1a\n") or b"IEND" not in data[-16:]:
                raise ValueError
        elif kind == "jpeg":
            if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
                raise ValueError
        else:
            return {**result, "reason": "unsupported_format"}
        if records is not None:
            result["rows"] = len(records)
            if not set(options["required_columns"]) <= columns:
                return {**result, "reason": "missing_columns"}
            if (
                options["min_rows"] is not None
                and len(records) < options["min_rows"]
                or options["max_rows"] is not None
                and len(records) > options["max_rows"]
            ):
                return {**result, "reason": "row_count"}
            if options["date_column"]:
                if options["date_column"] not in columns:
                    return {**result, "reason": "missing_columns"}
                for row in records:
                    value = dt.date.fromisoformat(str(row[options["date_column"]]))
                    if (
                        "date_from" in bounds
                        and value < bounds["date_from"]
                        or "date_to" in bounds
                        and value > bounds["date_to"]
                    ):
                        return {**result, "reason": "date_range"}
        elif (
            any(options[k] is not None for k in ["min_rows", "max_rows", "date_column"])
            or options["required_columns"]
        ):
            return {**result, "reason": "unsupported_content_check"}
    except (
        ValueError,
        UnicodeError,
        csv.Error,
        zipfile.BadZipFile,
        RuntimeError,
        TypeError,
        KeyError,
        IndexError,
        OverflowError,
        SyntaxError,
    ):
        return {**result, "reason": "invalid_content"}
    return {
        **result,
        "valid": True,
        "format": kind,
        "validation": "structured" if records is not None or kind == "zip" else "signature_only",
    }


def xlsx_rows(data):
    """标准库有界读取首个 XLSX 工作表及缓存值；不运行公式、宏、外链或解压到磁盘。"""
    import posixpath
    import xml.etree.ElementTree as ET

    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = z.infolist()
        if (
            len(files) > 1000
            or sum(x.file_size for x in files) > 100 * 1024 * 1024
            or any(x.flag_bits & 1 for x in files)
            or len({x.filename for x in files}) != len(files)
        ):
            raise ValueError

        def xml(name):
            info = z.getinfo(name)
            if info.file_size > 8 * 1024 * 1024:
                raise ValueError
            body = z.read(name)
            if b"<!DOCTYPE" in body or b"<!ENTITY" in body:
                raise ValueError
            return ET.fromstring(body)

        book = xml("xl/workbook.xml")
        sheet = book.find("s:sheets/s:sheet", ns)
        if sheet is None:
            raise ValueError
        rid = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        rels = xml("xl/_rels/workbook.xml.rels")
        rel = next((x for x in rels if x.get("Id") == rid), None)
        if rel is None or rel.get("TargetMode") == "External":
            raise ValueError
        target = rel.get("Target", "")
        target = posixpath.normpath(
            target.lstrip("/") if target.startswith("/") else "xl/" + target
        )
        if not target.startswith("xl/worksheets/") or "\\" in target:
            raise ValueError
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            for x in xml("xl/sharedStrings.xml").findall("s:si", ns):
                strings.append("".join(t.text or "" for t in x.iter("{" + ns["s"] + "}t")))
                if len(strings) > 100000:
                    raise ValueError
        dates = set(range(14, 23)) | {45, 46, 47}
        styles = []
        if "xl/styles.xml" in z.namelist():
            style = xml("xl/styles.xml")
            for fmt in style.findall("s:numFmts/s:numFmt", ns):
                code = re.sub(r'"[^\"]*"|\\\\.', "", fmt.get("formatCode", ""))
                if re.search(r"[yd]", code, re.I):
                    dates.add(int(fmt.get("numFmtId", "-1")))
            styles = [int(x.get("numFmtId", "0")) for x in style.findall("s:cellXfs/s:xf", ns)]
        pr = book.find("s:workbookPr", ns)
        epoch = (
            dt.date(1904, 1, 1)
            if pr is not None and pr.get("date1904") in {"1", "true"}
            else dt.date(1899, 12, 30)
        )
        rows = []
        header = None
        cells = 0
        for row in xml(target).findall("s:sheetData/s:row", ns):
            values = {}
            for cell in row.findall("s:c", ns):
                cells += 1
                if cells > 500000:
                    raise ValueError
                match = re.fullmatch(r"([A-Z]{1,3})[1-9][0-9]*", cell.get("r", ""))
                if not match:
                    raise ValueError
                col = 0
                for letter in match[1]:
                    col = col * 26 + ord(letter) - 64
                if col > 256:
                    raise ValueError
                kind = cell.get("t")
                v = cell.find("s:v", ns)
                value = v.text if v is not None else None
                if cell.find("s:f", ns) is not None and value is None:
                    raise ValueError
                if kind == "s":
                    value = strings[int(value)]
                elif kind == "inlineStr":
                    value = "".join(x.text or "" for x in cell.findall("s:is//s:t", ns))
                elif kind in {None, "n"} and value is not None:
                    sid = int(cell.get("s", "0"))
                    if 0 <= sid < len(styles) and styles[sid] in dates:
                        days = float(value)
                        if not math.isfinite(days) or not 0 <= days <= 2957000:
                            raise ValueError
                        value = (epoch + dt.timedelta(days=int(days))).isoformat()
                if value is not None:
                    values[col - 1] = value
            if not values:
                continue
            if header is None:
                header = [values.get(i) for i in range(max(values) + 1)]
                if any(not isinstance(x, str) or not x for x in header) or len(set(header)) != len(
                    header
                ):
                    raise ValueError
            else:
                if max(values) >= len(header) or len(rows) >= 100000:
                    raise ValueError
                rows.append({key: values.get(i, "") for i, key in enumerate(header)})
        if header is None:
            raise ValueError
        return rows, set(header)
