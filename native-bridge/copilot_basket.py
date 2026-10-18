"""持久工作篮：预估固定调用集合，确认后串行分批，统一保存结果。"""

import copy
import hashlib
import json
import math
from pathlib import Path
import secrets
import threading
import time
from copilot_annotations import object_key
from copilot_risk import binding_risk, highest

OPERATIONS = {
    "check": ("keyword.metrics", "serp.top", "domain.authority", "keyword.judge"),
    "expand": ("keyword.expand",),
    "trends": ("trends.series",),
    "competitors": ("domain.keywords",),
    "save": ("pool.save",),
}
LABELS = {
    "check": "批量查词定档",
    "expand": "批量拆长尾",
    "trends": "批量查热度",
    "competitors": "批量竞品反查",
    "save": "全部存词池",
}


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


class Basket:
    def __init__(self, app, write):
        self.app = app
        self.write = write
        self.path = app.directory / "basket.json"
        self.lock = threading.RLock()
        self.items = {}
        self.revision = 0
        self.plans = {}
        self.active_path = app.directory / "basket-active.json"
        if self.active_path.is_symlink():
            raise ValueError("basket activity symlink")
        activity = (
            json.loads(self.active_path.read_text())
            if self.active_path.exists()
            else {"version": 1, "jobs": {}}
        )
        if (
            not isinstance(activity, dict)
            or activity.get("version") != 1
            or not isinstance(activity.get("jobs"), dict)
        ):
            raise ValueError("invalid basket activity; review interrupted work")
        self.active_jobs = activity["jobs"]
        if self.path.exists():
            if self.path.is_symlink():
                raise ValueError("basket symlink")
            value = json.loads(self.path.read_text())
            if (
                not isinstance(value, dict)
                or value.get("version") != 1
                or not isinstance(value.get("items"), dict)
            ):
                raise ValueError("invalid basket")
            self.items = value["items"]
            self.revision = value.get("revision", 0)

    def activity(self, row, settled=False):
        with self.lock:
            if settled:
                self.active_jobs.pop(row["id"], None)
            else:
                self.active_jobs[row["id"]] = {
                    "id": row["id"],
                    "title": row["title"],
                    "state": row["status"],
                }
            self.write(
                self.active_path,
                json.dumps({"version": 1, "jobs": self.active_jobs}, ensure_ascii=False),
            )

    def snapshot(self):
        with self.lock:
            items = copy.deepcopy(list(self.items.values()))
            return {
                "revision": self.revision,
                "items": items,
                "groups": {
                    kind: sum(item["type"] == kind for item in items)
                    for kind in ("keyword", "domain", "url", "table")
                },
            }

    def save(self):
        self.revision += 1
        self.write(
            self.path,
            json.dumps(
                {"version": 1, "revision": self.revision, "items": self.items}, ensure_ascii=False
            ),
        )

    def add(self, entries):
        if (
            not isinstance(entries, list)
            or not 1 <= len(entries) <= 1000
            or len(json.dumps(entries, ensure_ascii=False).encode()) > 200000
        ):
            raise ValueError("basket entry limit")
        clean = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) - {
                "type",
                "value",
                "source",
                "columns",
                "label",
            }:
                raise ValueError("invalid basket entry")
            kind, value = entry.get("type"), entry.get("value")
            key = object_key(kind, value)
            item = {
                "type": kind,
                "value": value.strip(),
                "source": str(entry.get("source", ""))[:4000],
                "added_at": time.time(),
            }
            if kind == "table":
                dataset = {"table": self.app.tables.confirmed_table(value)}
                columns = entry.get("columns", list(range(len(dataset["table"]["headers"]))))
                if (
                    not isinstance(columns, list)
                    or not columns
                    or any(
                        type(index) is not int or not 0 <= index < len(dataset["table"]["headers"])
                        for index in columns
                    )
                ):
                    raise ValueError("invalid basket table columns")
                item.update(
                    columns=sorted(set(columns)),
                    whole="columns" not in entry,
                    label=dataset["table"].get("name", "表格")
                    + " · "
                    + (
                        "整表"
                        if "columns" not in entry
                        else " / ".join(dataset["table"]["headers"][index] for index in columns)
                    ),
                )
                key += ":" + fingerprint([item["columns"], item["whole"]])[:12]
            item["id"] = fingerprint(key)[:24]
            clean.append(item)
        with self.lock:
            if len(set(self.items) | {item["id"] for item in clean}) > 2000:
                raise ValueError("basket capacity reached")
            updated = dict(self.items)
            for item in clean:
                updated.setdefault(item["id"], item)
            if len(json.dumps(updated, ensure_ascii=False).encode()) > 512000:
                raise ValueError("basket byte limit; export or remove items first")
            self.items = updated
            self.save()
        return self.snapshot()

    def remove(self, ids):
        if not isinstance(ids, list) or any(not isinstance(key, str) for key in ids):
            raise ValueError("invalid basket ids")
        with self.lock:
            for key in ids:
                self.items.pop(key, None)
            self.save()
        return self.snapshot()

    def chosen(self, ids):
        if (
            not isinstance(ids, list)
            or not ids
            or len(ids) > 1000
            or any(not isinstance(key, str) or key not in self.items for key in ids)
        ):
            raise ValueError("select existing basket items")
        with self.lock:
            return copy.deepcopy([self.items[key] for key in dict.fromkeys(ids)])

    def values(self, items, operation):
        kind = "domain" if operation == "competitors" else "keyword"
        found = {}
        for item in items:
            values = []
            if item["type"] == kind:
                values = [item["value"]]
            elif operation == "competitors" and item["type"] == "url":
                values = [item["value"]]
            elif item["type"] == "table":
                dataset = {"table": self.app.tables.confirmed_table(item["value"])}
                columns = item["columns"]
                if item.get("whole"):
                    aliases = (
                        ["domain", "域名", "url", "网址", "页面地址"]
                        if operation == "competitors"
                        else ["keyword", "keywords", "关键词", "搜索词", "search term"]
                    )
                    for tool in self.app.packages.tools:
                        if dataset["table"].get("site") in tool.get("hosts", []):
                            for page in tool.get("pages", []):
                                aliases += page.get("columns", {}).get(kind, [])
                    columns = [
                        index
                        for index, header in enumerate(dataset["table"]["headers"])
                        if header.casefold().strip()
                        in {name.casefold().strip() for name in aliases}
                    ]
                    if len(columns) != 1:
                        raise ValueError(
                            "choose an unambiguous keyword or domain column before batching"
                        )
                values = [
                    row[column]["text"].strip()
                    for row in dataset["table"]["rows"]
                    for column in columns
                    if row[column]["text"].strip()
                ]
            for value in values:
                key = object_key(kind, value)
                found.setdefault(
                    key, {"domain" if kind == "domain" else "keyword": key.split(":", 1)[1]}
                )
        if not found or len(found) > 1000:
            raise ValueError("batch supports 1–1000 compatible objects")
        return list(found.values())

    def estimate(self, instance, ids, operation):
        if operation not in {*OPERATIONS, "export", "copy"}:
            raise ValueError("unknown basket operation")
        items = self.chosen(ids)
        records = self.values(items, operation) if operation not in {"export", "copy"} else items
        if len(json.dumps(records, ensure_ascii=False).encode()) > 100000:
            raise ValueError("batch text budget exceeded; select fewer objects")
        context = self.app._tool_context(instance)
        tools = []
        for capability in OPERATIONS.get(operation, ()):
            candidates = [
                binding
                for binding in self.app.registry.candidates(capability, context)
                if binding["type"] != "hermes"
                and self.app.registry.structural(binding, context) == "available"
            ]
            binding = candidates[0] if candidates else None
            if (
                capability == "pool.save"
                and binding is None
                and self.app.config.get("pool_command")
            ):
                binding = {
                    "id": "configured-pool",
                    "type": "command",
                    "argv": copy.deepcopy(self.app.config["pool_command"]),
                    "cost": "unknown",
                    "risk": "metered",
                    "batch_limit": 1000,
                    "legacy_pool": True,
                }
            size = (
                min(binding.get("batch_limit", 100), 5 if capability == "trends.series" else 100)
                if binding
                else 100
            )
            if binding and (
                capability.startswith("domain.")
                and binding["type"] == "browser"
                or binding["type"] == "mcp"
                and any(
                    field in binding.get("input_fields", [])
                    and field + "s" not in binding.get("input_fields", [])
                    for field in ("keyword", "domain")
                )
                or any("{keyword}" in arg or "{domain}" in arg for arg in binding.get("argv", []))
            ):
                size = 1
            count = len(records) * (10 if capability == "domain.authority" else 1)
            # 中文注释：依赖后续返回的域名时展示调用上限；不猜测实际站点数或伪造额度价格。
            tools.append(
                {
                    "capability": capability,
                    "binding": copy.deepcopy(binding),
                    "provider": binding["id"] if binding else "未绑定",
                    "batch_limit": size,
                    "calls": math.ceil(count / size) if binding else 0,
                    "upper_bound": capability == "domain.authority",
                    "risk": binding_risk(binding) if binding else "metered",
                    "seconds": binding.get("estimated_seconds") if binding else None,
                }
            )
        model_calls = int(operation in {"check", "expand", "trends", "competitors"})
        risk = highest(
            *[tool["risk"] for tool in tools], *(["metered"] if model_calls else ["zero"])
        )
        timeout_bound = (
            sum(tool["calls"] * (tool["binding"] or {}).get("timeout", 120) for tool in tools)
            + model_calls * self.app.config["timeout_seconds"]
        )
        value = {
            "model_id": (
                self.app.config["inference_model"]
                or getattr(self.app.runtime, "active_model", "")
                or (getattr(self.app.runtime, "model_state", None) or {}).get("currentModelId", "")
            )
            if model_calls
            else None,
            "export_dir": self.app.config["table_export_dir"] if operation == "export" else None,
            "operation": operation,
            "ids": list(dict.fromkeys(ids)),
            "revision": self.revision,
            "records": records,
            "tools": tools,
            "risk": risk,
            "model_calls": model_calls,
            "estimated_tokens": math.ceil(
                (len(json.dumps(records, ensure_ascii=False).encode()) + 2000 + 300 * len(records))
                / 4
            )
            if model_calls
            else 0,
            "estimated_seconds": sum((tool["calls"] * tool["seconds"] for tool in tools))
            if not model_calls
            and all((isinstance(tool["seconds"], (int, float)) for tool in tools))
            else None,
            "timeout_upper_seconds": timeout_bound,
            "task_count": 1 if operation in OPERATIONS else 0,
            "call_upper_bound": sum((tool["calls"] for tool in tools)),
            "created_at": time.time(),
            "instance": instance,
            "epoch": self.app._state(instance)["epoch"],
        }
        token = secrets.token_urlsafe(24)
        value["signature"] = fingerprint(
            {
                key: value[key]
                for key in ("records", "tools", "revision", "operation", "export_dir", "model_id")
            }
        )
        with self.lock:
            self.plans = dict(
                list(
                    {
                        key: plan
                        for key, plan in self.plans.items()
                        if time.time() - plan["created_at"] < 300
                    }.items()
                )[-15:]
            )
            self.plans[token] = value
        return self.preview(token, value)

    def preview(self, token, value):
        return {
            key: copy.deepcopy(value[key])
            for key in (
                "operation",
                "risk",
                "task_count",
                "call_upper_bound",
                "model_calls",
                "estimated_tokens",
                "estimated_seconds",
                "timeout_upper_seconds",
            )
        } | {
            "objects": copy.deepcopy(value["records"][:20]),
            "remaining_objects": max(0, len(value["records"]) - 20),
            "model_id": value["model_id"],
            "export_dir": value["export_dir"],
            "token": token,
            "count": len(value["records"]),
            "tools": [
                {
                    key: tool[key]
                    for key in (
                        "capability",
                        "provider",
                        "batch_limit",
                        "calls",
                        "upper_bound",
                        "risk",
                    )
                }
                for tool in value["tools"]
            ],
        }

    def execute(self, instance, token, confirmation=None):
        with self.lock:
            plan = self.plans.get(token)
        if (
            not plan
            or plan["instance"] != instance
            or time.time() - plan["created_at"] > 300
            or plan["revision"] != self.revision
            or plan["epoch"] != self.app._state(instance)["epoch"]
        ):
            raise ValueError("batch estimate expired; estimate again")
        # 中文注释：配置/优先级/可用性变更需要重新估算，禁止悄悄改用更贵后备。
        fresh = self.estimate(instance, plan["ids"], plan["operation"])
        new = self.plans.pop(fresh["token"])
        if new["signature"] != plan["signature"]:
            raise ValueError("batch bindings changed; estimate again")
        if plan["risk"] == "external" and (
            not plan.get("secondary_token") or confirmation != plan["secondary_token"]
        ):
            plan["secondary_token"] = secrets.token_urlsafe(24)
            return {
                "secondary_required": True,
                "token": token,
                "confirmation": plan["secondary_token"],
                "operation": plan["operation"],
            }
        if plan["operation"] == "copy":
            with self.lock:
                self.plans.pop(token)
            return {"clipboard": self.clipboard(plan["ids"])}
        if plan["operation"] == "export":
            with self.lock:
                self.plans.pop(token)
            with self.app.lock:
                if self.app.config["table_export_dir"] != plan["export_dir"]:
                    raise ValueError("export folder changed; estimate again")
                return self.export(instance, plan["ids"])
        state = self.app._state(instance)
        if plan["model_calls"] and not plan["model_id"]:
            raise ValueError("refresh the session model before estimating a model-backed batch")
        if plan["operation"] != "save" and (not state["enabled"] or not state["ready"]):
            raise ValueError("collaboration must be ready before batch execution")
        with self.lock:
            self.plans.pop(token)
        signature = fingerprint(
            {key: plan[key] for key in ("operation", "records", "tools", "model_id")}
        )
        with self.app.lock:
            active = next(
                (
                    item
                    for item in state["suggestions"].values()
                    if item.get("basket_signature") == signature
                    and item["status"] in {"queued", "executing", "stopping"}
                ),
                None,
            )
            if active:
                return {"started": active["id"], "already_active": True}
        key = "basket-" + secrets.token_hex(12)
        row = {
            "id": key,
            "action": "seo.save_pool" if plan["operation"] == "save" else "workflow.run",
            "render_as": "workflow.run",
            "params": {
                "flow": "basket-" + plan["operation"],
                "object": f"{len(plan['records'])} 个对象",
            },
            "title": LABELS[plan["operation"]],
            "why": "已确认工作篮批量预估",
            "scene": "seo",
            "status": "queued",
            "queued_at": time.time(),
            "tokens": 0,
            "usage": {"input": 0, "cache_read": 0, "output": 0},
            "basket_plan": plan,
            "basket_batch": True,
            "basket_signature": signature,
            "secondary_confirmed": plan["risk"] == "external",
            "explicit": True,
        }
        with self.app.lock:
            state["suggestions"][key] = row
            self.activity(row)
            self.app._emit(instance, "add", suggestion=self.app._display_row(row))
        threading.Thread(
            target=self.app._execute, args=(instance, key, state["epoch"]), daemon=True
        ).start()
        return {"started": key}

    def clipboard(self, ids):
        blocks = []
        for item in self.chosen(ids):
            if item["type"] == "table":
                table = self.app.tables.confirmed_table(item["value"])
                blocks.append(
                    "\n".join(
                        "\t".join(
                            str(row[index].get("text", ""))
                            if isinstance(row[index], dict)
                            else str(row[index])
                            for index in item["columns"]
                        )
                        for row in [table["headers"], *table["rows"]]
                    )
                )
            else:
                blocks.append(item["value"])
        text = "\n".join(blocks)
        if len(text.encode()) > 1048576:
            raise ValueError("clipboard limit; export the table instead")
        return text

    def export(self, instance, ids):
        outputs = []
        rows = []
        for item in self.chosen(ids):
            if item["type"] == "table":
                table = self.app.tables.confirmed_table(item["value"])
                headers = [table["headers"][index] for index in item["columns"]]
                if len(headers) == 1:
                    headers.append("来源")
                selected = [[row[index] for index in item["columns"]] for row in table["rows"]]
                if len(item["columns"]) == 1:
                    selected = [row + [{"text": item.get("label", "表格")}] for row in selected]
                outputs.append(
                    self.app.tables.export_saved(
                        instance, item.get("label", "表格"), headers, selected
                    )
                )
            else:
                rows.append([{"text": item["type"]}, {"text": item["value"]}])
        if rows:
            outputs.append(self.app.tables.export_saved(instance, "工作篮", ["类型", "对象"], rows))
        return {
            "exports": outputs,
            "files": [file for output in outputs for file in output.get("files", [])],
        }

    def run(self, instance, row, epoch, execution_config):
        from copilot_capabilities import transform, Stopped
        from copilot_results import UNIFIED

        app = self.app
        plan = row["basket_plan"]
        stop = threading.Event()
        job_key = instance + ":" + row["id"]
        self.activity(row)
        app.registry.jobs[job_key] = {"stop": stop, "thread": threading.current_thread()}
        context = {
            **app._tool_context(instance),
            "approved_bindings": [tool["provider"] for tool in plan["tools"] if tool["binding"]],
            "secondary_confirmed": row.get("secondary_confirmed", False),
            "job_key": job_key,
            "row_id": row["id"],
            "execution_config": execution_config,
        }
        records = copy.deepcopy(plan["records"])
        missing, steps, series = [], [], []
        step_index = 0
        serp_records = []
        try:
            for tool in plan["tools"]:
                if tool["capability"] == "keyword.judge":
                    if (
                        records
                        and plan["model_calls"]
                        and any(step["status"] == "completed" for step in steps)
                    ):
                        decision = app._tool_model(
                            instance, row, {"records": records}, stop, execution_config
                        )
                        notes = {note["key"].casefold(): note for note in decision.get("notes", [])}
                        for record in records:
                            note = notes.get(record.get("keyword", "").casefold(), {})
                            record.update(
                                {
                                    key: note[key]
                                    for key in ("intent_tool", "excluded", "reason", "group")
                                    if key in note and record.get(key) is None
                                }
                            )
                        plan["model_calls"] = 0
                capability = tool["capability"]
                values = records
                if capability == "domain.authority":
                    values, _ = transform("domains", serp_records, {"limit": 10000}, {})
                if not tool["binding"]:
                    missing.append({"field": capability, "reason": "未绑定，已跳过"})
                    steps.append(
                        {
                            "label": capability + f" · 成功 0 / 跳过 {len(records)} / 失败 0",
                            "status": "skipped",
                            "source": "unbound",
                            "count": 0,
                        }
                    )
                    continue
                accumulated = []
                for offset in range(0, len(values), tool["batch_limit"]):
                    if (
                        stop.is_set()
                        or not app._valid(instance, epoch)
                        and not (
                            plan["operation"] == "save"
                            and not app.closed
                            and app._state(instance)["epoch"] == epoch
                        )
                    ):
                        raise Stopped("stopped")
                    chunk = values[offset : offset + tool["batch_limit"]]
                    fields = (
                        {"records": chunk}
                        if capability in {"keyword.judge", "pool.save"}
                        else {"domains": [item["domain"] for item in chunk]}
                        if capability in {"domain.keywords", "domain.authority"}
                        else {"keywords": [item["keyword"] for item in chunk]}
                    )
                    if len(chunk) == 1:
                        if chunk[0].get("keyword"):
                            fields["keyword"] = chunk[0]["keyword"]
                        if chunk[0].get("domain"):
                            fields["domain"] = chunk[0]["domain"]
                    if capability == "serp.top":
                        fields["n"] = 10
                    step_index += 1
                    label = f"{capability} · 第 {offset // tool['batch_limit'] + 1}/{math.ceil(len(values) / tool['batch_limit'])} 批"
                    with app.lock:
                        row.update(step=label, workflow_index=step_index)
                        app._emit(instance, "update", suggestion=app._display_row(row))
                    try:
                        result = (
                            app._pool(
                                row["id"] + "-" + str(step_index),
                                {"keywords": chunk},
                                explicit=True,
                            )
                            if tool["binding"].get("legacy_pool")
                            else app.registry.execute(
                                capability,
                                fields,
                                app.directory / "tasks" / row["id"] / str(step_index),
                                stop,
                                context,
                            )
                        )
                        if not isinstance(result, dict):
                            raise ValueError("missing source receipt")
                        self.write(
                            app.directory / "tasks" / row["id"] / str(step_index) / "receipt.json",
                            json.dumps(
                                {
                                    key: value
                                    for key, value in result.items()
                                    if key
                                    in {
                                        "records",
                                        "series",
                                        "written",
                                        "skipped",
                                        "accepted_keywords",
                                        "source",
                                        "missing",
                                        "partial",
                                        "pages",
                                    }
                                },
                                ensure_ascii=False,
                            ),
                        )
                        obtained = result.get("records", [])
                        series.extend(result.get("series", []))
                        if capability == "pool.save":
                            if type(result.get("written")) is not int or result["written"] < 0:
                                raise ValueError("pool write receipt unavailable")
                            accepted = result.get("accepted_keywords", [])
                            rejected = {
                                item.get("keyword")
                                for item in result.get("skipped", [])
                                if isinstance(item, dict)
                            }
                            if not accepted and result["written"] == len(
                                [item for item in chunk if item["keyword"] not in rejected]
                            ):
                                accepted = [
                                    item["keyword"]
                                    for item in chunk
                                    if item["keyword"] not in rejected
                                ]
                            app.annotation_memory.ingest([], pool=accepted)
                            with app.lock:
                                app._state(instance)["pool_words"] = list(
                                    set(app._state(instance)["pool_words"]) | set(accepted)
                                )
                            obtained = [
                                record for record in chunk if record.get("keyword") in accepted
                            ]
                        accumulated.extend(obtained)
                        returned = len(obtained) or len(result.get("series", []))
                        failed = (
                            len(chunk)
                            if not returned
                            and any(
                                "source_unavailable" in str(reason)
                                for reason in result.get("missing", [])
                            )
                            else 0
                        )
                        skipped = (
                            max(0, len(chunk) - len(obtained))
                            if capability in {"keyword.metrics", "pool.save"}
                            else len(chunk)
                            if not returned and not failed
                            else 0
                        )
                        label += f" · 成功返回 {returned} / 跳过 {skipped} / 失败 {failed}"
                        steps.append(
                            {
                                "label": label,
                                "status": "completed"
                                if returned
                                else "failed"
                                if failed
                                else "skipped",
                                "source": tool["provider"],
                                "count": len(obtained),
                            }
                        )
                        missing.extend(
                            {"field": capability, "reason": str(reason)[:500]}
                            for reason in result.get("missing", [])
                        )
                        app.journal.add(
                            instance,
                            "batch_complete",
                            task_id=row["id"],
                            provider=tool["provider"],
                            batch=offset // tool["batch_limit"] + 1,
                            count=returned,
                            skipped=max(0, skipped),
                            failed=failed,
                            items=len(chunk),
                            error=bool(failed),
                        )
                    except Stopped:
                        raise
                    except (ValueError, OSError, RuntimeError, KeyError, TypeError):
                        steps.append(
                            {
                                "label": label,
                                "status": "failed",
                                "source": tool["provider"],
                                "count": 0,
                            }
                        )
                        missing.append({"field": capability, "reason": label + "失败，未重放"})
                        app.journal.add(
                            instance,
                            "batch_complete",
                            error=True,
                            task_id=row["id"],
                            provider=tool["provider"],
                            batch=offset // tool["batch_limit"] + 1,
                            count=0,
                            skipped=0,
                            failed=len(chunk),
                        )
                if capability == "serp.top":
                    serp_records = accumulated
                    records, _ = transform(
                        "serp_join", accumulated, {"base": records, "authority": []}, {}
                    )
                elif capability == "domain.authority":
                    records, _ = (
                        transform(
                            "serp_join",
                            serp_records,
                            {"base": records, "authority": accumulated},
                            {},
                        )
                        if accumulated
                        else (records, [])
                    )
                elif capability in {"keyword.metrics", "keyword.judge"}:
                    records, _ = transform("merge", accumulated, {"base": records}, {})
                elif capability == "trends.series":
                    for record in records:
                        selected = next(
                            (
                                item
                                for item in series
                                if item.get("keyword", "").casefold()
                                == record.get("keyword", "").casefold()
                            ),
                            None,
                        )
                        if selected:
                            record.update(
                                trend12=[point["value"] for point in selected.get("points", [])][
                                    -400:
                                ],
                                trend_source=selected.get("region", "")
                                + " · "
                                + selected.get("period", ""),
                                source=tool["provider"],
                            )
                else:
                    records = accumulated or records
                app.annotation_memory.ingest(records, analyzed=plan["operation"] == "competitors")
            if plan["model_calls"] and (
                series or any(step["status"] == "completed" for step in steps)
            ):
                decision = app._tool_model(
                    instance, row, {"records": records, "series": series}, stop, execution_config
                )
                notes = {note["key"].casefold(): note for note in decision.get("notes", [])}
                for record in records:
                    note = notes.get(
                        (
                            record.get("keyword") or record.get("domain") or record.get("url") or ""
                        ).casefold(),
                        {},
                    )
                    record.update(
                        {
                            key: note[key]
                            for key in ("intent_tool", "excluded", "reason", "group")
                            if key in note and record.get(key) is None
                        }
                    )
            self.finish(instance, row, records, steps, missing, series, stop.is_set())
        except (Stopped, ValueError, OSError, RuntimeError, KeyError, TypeError):
            missing.append({"field": "batch", "reason": "已停止；已有结果保留，未重放未确认动作"})
            self.finish(instance, row, records, steps, missing, series, True)
        finally:
            app.registry.jobs.pop(job_key, None)
            if (
                row.get("risk") != "external"
                and row.get("basket_plan", {}).get("risk") != "external"
                or not stop.is_set()
                and row.get("completion_status") == "completed"
            ):
                self.activity(row, settled=True)
            else:
                self.activity({**row, "status": "needs_review"})
            row.pop("basket_plan", None)

    def finish(self, instance, row, records, steps, missing, series, stopped):
        from copilot_results import UNIFIED, report as result_report

        app = self.app
        records = [
            {key: value for key, value in record.items() if key in UNIFIED["properties"]}
            for record in records
        ]
        preview = []
        size = 0
        for record in records[:1000]:
            cost = len(json.dumps(record, ensure_ascii=False).encode())
            if size + cost > 200000:
                break
            preview.append(record)
            size += cost
        if len(preview) < len(records):
            missing.append(
                {"field": "preview", "reason": "结果卡预览有界；完整数据保存在批量文件中"}
            )
        result = {
            "verdict": "批量完成" if not missing else "批量部分完成，请核对缺失",
            "level": "info",
            "metrics": [],
            "missing": missing[:50],
            "process": [
                f"{step['label']} · {step['source']} · 成功 {step['count']} · {step['status']}"
                for step in steps
            ][:30],
            "next": [],
            "records": preview,
            "steps": steps[:50],
            "artifacts": [],
        }
        work = app.directory / "tasks" / row["id"]
        self.write(
            work / "batch-result.json",
            json.dumps(
                {"result": result, "series": series, "batches": steps, "evidence_records": records},
                ensure_ascii=False,
            ),
        )
        result["artifacts"] = [{"label": "完整批量数据", "path": str(work / "batch-result.json")}]
        app.annotation_memory.ingest(
            records, analyzed=row["params"]["flow"] == "basket-competitors"
        )
        row["completion_status"] = (
            "failed"
            if missing and not any(step["status"] == "completed" for step in steps)
            else "partial"
            if missing
            else "completed"
        )
        if stopped:
            report = app._report_path(row["id"])
            self.write(report, result_report(result, row["title"]))
            with app.lock:
                row.update(
                    status="stopped", result=result, report=str(report), finished_at=time.time()
                )
                app._emit(instance, "update", suggestion=app._display_row(row))
        else:
            app._complete(instance, row, result)
