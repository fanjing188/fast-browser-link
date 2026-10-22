"""通用任务材料与执行；复用协作任务队列、模型适配器和结果回流。"""

import base64
import copy
import json
import re
import subprocess
import struct
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from copilot_task_catalog import CATALOG, SCHEMA
from copilot_task_execution import TaskExecution
from copilot_task_data import parse_table
from copilot_recommendations import digest, inventory, rank
from copilot_contracts import private_write, validate
from copilot_diagnostics import redact_page


def local_task(row):
    return (
        row.get("action") == "assist.task"
        and row.get("params", {}).get("task") in CATALOG
        and not CATALOG[row["params"]["task"]]["model"]
    )


class Workbench(TaskExecution):
    def __init__(self, app):
        self.app = app
        self.materials = {}
        self.revision = 0
        self.history = []
        self.preferences = {}
        self.responses = {}
        self.interpret_jobs = {}
        self.task_revision = digest(
            [
                Path(__file__).read_text(),
                Path(__file__).with_name("copilot_task_data.py").read_text(),
                Path(__file__).with_name("copilot_task_execution.py").read_text(),
                CATALOG,
            ]
        )
        self.path = app.directory / "memory" / "task-outcomes.json"
        if (
            app.work_memory.enabled
            and self.path.is_file()
            and not self.path.is_symlink()
            and self.path.stat().st_size < 1024 * 1024
        ):
            try:
                saved = json.loads(self.path.read_text())
                self.history = [
                    r
                    for r in saved.get("history", [])
                    if isinstance(r, dict)
                    and set(r)
                    <= {"task", "status", "elapsed_ms", "at", "kind", "provider_revision"}
                ][-200:]
                self.preferences = {
                    k: v
                    for k, v in saved.get("preferences", {}).items()
                    if k in CATALOG and v in {"prefer", "hide"}
                }
            except (ValueError, TypeError, AttributeError):
                pass

    def rows(self, instance):
        return [r for r in self.materials.values() if r["owner"] == instance]

    def snapshot(self, instance):
        state = self.app._state(instance)
        return {
            "revision": self.revision,
            "materials": [
                {
                    k: r[k]
                    for k in (
                        "id",
                        "kind",
                        "title",
                        "revision",
                        "partial",
                        "captured_at",
                        "source",
                        "work_id",
                    )
                }
                | {
                    "columns": r.get("table", {}).get("headers", []),
                    "rows": len(r.get("table", {}).get("records", [])),
                }
                for r in self.rows(instance)
            ],
            "tasks": list(CATALOG.values()),
            "history": self.history[-20:] if self.app.work_memory.enabled else [],
            "preferences": self.preferences,
            "model_ready": state["enabled"] and state["ready"],
            "metrics": self.metrics(),
            "study_records": self.study_records(instance),
        }

    def chosen(self, instance, ids):
        if not isinstance(ids, list) or not 1 <= len(ids) <= 10 or len(set(ids)) != len(ids):
            raise ValueError("请选择1–10份材料")
        rows = [self.materials.get(key) for key in ids]
        if any(not row or row["owner"] != instance for row in rows):
            raise ValueError("材料不存在或不属于当前浏览器")
        return rows

    def add(self, instance, params, *, replace_id=None, internal=False):
        if set(params) - {
            "kind",
            "title",
            "text",
            "table",
            "source",
            "partial",
            "image",
            "document_id",
        }:
            raise ValueError("未知材料字段")
        if len(json.dumps(params, ensure_ascii=False).encode()) > (
            8 * 1024 * 1024 if internal else 230000
        ):
            raise ValueError("材料超过单次传输上限")
        kind = params.get("kind", "text")
        if kind not in {"page", "text", "text_selection", "table", "image"}:
            raise ValueError("不支持的材料类型")
        source = str(params.get("source", ""))
        parsed = urlsplit(source)
        if source and (
            parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
        ):
            raise ValueError("来源地址无效")
        state = self.app._state(instance)
        material = {
            "id": uuid.uuid4().hex,
            "owner": instance,
            "kind": kind,
            "title": str(params.get("title", "材料"))[:120],
            "source": source,
            "partial": params.get("partial", True) is not False,
            "captured_at": time.time(),
            "revision": 1,
            "work_id": state["work_id"],
            "document_id": str(params.get("document_id", ""))[:120],
        }
        if kind == "table":
            material["table"] = parse_table(params.get("table", params.get("text", "")))
        elif kind == "image":
            raw = base64.b64decode(params.get("image", ""), validate=True)
            if not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) < 24 or len(raw) > 150000:
                raise ValueError("仅支持150KiB以内的PNG图片")
            width, height = struct.unpack(">II", raw[16:24])
            if not width or not height or width * height > 16000000:
                raise ValueError("图片尺寸超过1600万像素")
            material["image"] = params["image"]
        else:
            text = params.get("text")
            if not isinstance(text, str) or not text.strip() or len(text.encode()) > 100000:
                raise ValueError("需要非空文字材料，最多100KiB")
            material["text"] = redact_page(text)
        if replace_id:
            previous = self.chosen(instance, [replace_id])[0]
            material.update(
                id=replace_id, revision=previous["revision"] + 1, work_id=previous["work_id"]
            )
        if not replace_id and len(self.rows(instance)) >= 30:
            raise ValueError("材料最多30份，请先清理")
        if (
            sum(
                len(json.dumps(r, ensure_ascii=False).encode())
                for r in self.rows(instance)
                if r["id"] != replace_id
            )
            + len(json.dumps(material, ensure_ascii=False).encode())
            > 16 * 1024 * 1024
        ):
            raise ValueError("材料总量超过16MiB，请先清理或缩小范围")
        # 中文注释：正文只留内存；用户生成的任务产物由现有私有报告路径保存。
        self.materials[material["id"]] = material
        if replace_id:
            for row in state["suggestions"].values():
                if (
                    row.get("standard_task")
                    and row["status"] == "pending"
                    and replace_id in row.get("material_ids", [])
                ):
                    row["recommendation_state"] = "stale"
        self.revision += 1
        self.refresh(instance)
        return self.snapshot(instance)

    def suitable(self, task, materials):
        kind = CATALOG[task]["subject"]
        if task in {"table.compare", "table.join"} and len(materials) != 2:
            return False
        if kind in {"table", "tables"}:
            return all(r["kind"] == "table" for r in materials) and (
                len(materials) >= 2 if kind == "tables" else len(materials) == 1
            )
        if kind == "image":
            return len(materials) == 1 and materials[0]["kind"] == "image"
        return all(r["kind"] != "image" for r in materials) and (
            len(materials) >= 2 if kind == "texts" else len(materials) == 1
        )

    def prepare(self, instance, task, ids, options=None, explicit=False):
        if task not in CATALOG:
            raise ValueError("未知任务")
        materials = self.chosen(instance, ids)
        if not self.suitable(task, materials):
            raise ValueError("材料类型或数量不适合此任务")
        options = options or {}
        if not isinstance(options, dict) or len(json.dumps(options).encode()) > 8000:
            raise ValueError("任务参数超出限制")
        from copilot_task_catalog import validate_options, required_parameters

        options = validate_options(task, options, materials)
        state, spec = self.app._state(instance), CATALOG[task]
        identity = digest([state["work_id"], task, ids, options])
        missing = []
        if spec["model"] and not (state["enabled"] and state["ready"]):
            missing = ["agent"]
        if task.startswith("image.") and sys.platform != "darwin":
            missing = ["macos_vision"]
        needs = required_parameters(task, options)
        return {
            "id": identity,
            "title": spec["name"].get(state["locale"], spec["name"]["en"]),
            "why": "所选材料与任务匹配" if explicit else "当前工作已有适合的材料",
            "action": "assist.task",
            "params": {"task": task, "materials": ids, "options": copy.deepcopy(options)},
            "status": "pending",
            "scene": "general",
            "standard_task": True,
            "task_type": task,
            "material_ids": ids,
            "material_count": len(ids),
            "subject_kind": materials[0]["kind"],
            "material_revisions": [r["revision"] for r in materials],
            "work_id": state["work_id"],
            "local_task": not spec["model"],
            "explicit": explicit,
            "recommendation_only": True,
            "missing_capabilities": missing,
            "missing_parameters": needs,
            "recommendation_state": "blocked"
            if missing
            else "needs_parameters"
            if needs
            else "ready",
            "output_kind": "table"
            if task.startswith("table.")
            else "study"
            if task.startswith("learn.")
            else "analysis",
            "preference": self.preferences.get(task),
            "provider_revision": self.task_revision,
            "verified_success": any(
                r.get("task") == task
                and r.get("status") == "verified"
                and r.get("kind") == materials[0]["kind"]
                and r.get("provider_revision") == self.task_revision
                for r in self.history
            ),
        }

    @staticmethod
    def context_page(state):
        # 中文注释：导航后先丢弃旧观察线索；新观察允许安全URL归一化，不能只按URL字符串判旧。
        page = {} if state.get("context_dirty") else dict(state.get("page", {}))
        page["url"] = state.get("page_context", {}).get("url") or page.get("url", "")
        return page

    def context_tasks(self, state, materials):
        """只按当前对象和明确方向挑选少量任务，完整目录仍供用户显式配置。"""
        direction = state.get("user_direction", "")
        page = self.context_page(state)
        hints = " ".join(
            [
                direction,
                page.get("title", ""),
                *[str(item.get("name", "")) for item in page.get("items", [])[:20]],
                *[m.get("title", "") + " " + m.get("text", "")[:2000] for m in materials[-3:]],
            ]
        )
        selected = bool(state.get("selection_text")) or any(
            item.get("role") == "selection" for item in page.get("items", [])
        )
        tables = bool(state.get("table_summary")) or any(
            item.get("role") in {"table", "grid"} for item in page.get("items", [])
        )
        if (
            not materials
            and not (page.get("url") or state.get("page_context", {}).get("url"))
            and not direction
            and not selected
            and not tables
        ):
            return ["page.summary", "table.clean", "links.organize"]
        tasks = ["page.summary", "page.question", "page.extract"]
        if selected:
            tasks = ["text.explain", "text.translate", *tasks]
        if (
            tables
            or any(m["kind"] == "table" for m in materials)
            or re.search(r"表格|table|spreadsheet", direction, re.I)
        ):
            tasks += ["table.clean", "table.filter", "table.stats", "table.explain"]
            if re.search(r"交叉|透视|pivot", direction, re.I):
                tasks.append("table.pivot")
        if sum(m["kind"] == "table" for m in materials) >= 2:
            tasks += ["table.compare", "table.merge", "table.join"]
        if sum(m["kind"] not in {"table", "image"} for m in materials) >= 2:
            tasks += ["research.compare", "research.synthesize", "research.gaps"]
        if any(m["kind"] == "image" for m in materials):
            tasks += ["image.ocr", "image.table"]
        for pattern, extra in (
            (r"产品|套餐|价格|product|pricing|features", ["page.product", "organize.specs"]),
            (r"评论|评价|reviews|comments", ["page.reviews"]),
            (r"论证|观点|argument", ["page.argument"]),
            (r"矛盾|检查内容|check content", ["page.check"]),
            (r"教程|操作步骤|tutorial|how to|guide", ["organize.tutorial"]),
            (r"行动清单|待办|action|checklist", ["organize.actions"]),
            (r"版本|更新日志|changelog|release notes", ["organize.changes"]),
            (r"提纲|草稿|outline|draft", ["organize.draft"]),
            (r"链接|links", ["links.organize"]),
            (r"表单|填表|form", ["form.preview", "form.check"]),
        ):
            if re.search(pattern, hints, re.I):
                tasks += extra
        if re.search(r"学习|理解|复习|练习|learn|study|practice", direction, re.I):
            tasks = ["learn.notes", "learn.concepts", "learn.quiz", "learn.flashcards", *tasks]
            if re.search(r"答案|answer", direction, re.I):
                tasks.append("learn.feedback")
            if re.search(r"实践|项目|project|practice", direction, re.I):
                tasks.append("learn.practice")
        return list(dict.fromkeys(tasks))

    def page_tools(self, state):
        page = self.context_page(state)
        source = page.get("url", "")
        tools = []
        if urlsplit(source).scheme in {"http", "https"}:
            tools = [
                (
                    "tables",
                    "识别并导出表格",
                    "Detect and export tables",
                    "识别本页表格后选择范围与导出格式",
                    "Detect tables, then choose a range and export format",
                ),
                (
                    "collect",
                    "多页采集",
                    "Collect multiple pages",
                    "先识别表格，再确认分页范围与采集设置",
                    "Detect tables, then confirm pagination and collection settings",
                ),
                (
                    "annotate",
                    "页面标注",
                    "Annotate page",
                    "标注当前页中的工作对象，可再次点击停止",
                    "Annotate work objects on this page; click again to stop",
                ),
            ]
        if self.app.basket.snapshot()["items"]:
            tools.append(
                (
                    "basket",
                    "工作篮",
                    "Work basket",
                    "查看已收集的对象并选择后续任务",
                    "Review collected objects and choose the next task",
                )
            )
        en = state["locale"] == "en"
        return [
            {
                "id": digest(
                    [state["work_id"], "native.tool", tool, "" if tool == "basket" else source]
                ),
                "action": "native.tool",
                "task_type": "native." + tool,
                "params": {"tool": tool},
                "title": english if en else chinese,
                "why": english_reason if en else chinese_reason,
                "status": "pending",
                "local_task": True,
                "risk": "zero",
                "capture_required": True,
                "recommendation_only": True,
                "recommendation_state": "ready",
                "source_url": "" if tool == "basket" else source,
                "subject_kind": "basket" if tool == "basket" else "page",
                "work_id": state["work_id"],
                "context_priority": priority + 50,
            }
            for priority, (tool, chinese, english, chinese_reason, english_reason) in enumerate(
                tools
            )
        ]

    def refresh(self, instance):
        from copilot_recommendations import feedback_active

        app, state = self.app, self.app._state(instance)
        app._migrate_suggestions(state)
        materials = [r for r in self.rows(instance) if r["work_id"] == state["work_id"]]
        page = self.context_page(state)
        signature = digest(
            [
                state["work_id"],
                [(m["id"], m["revision"]) for m in materials],
                page,
                state.get("selection_text"),
                state.get("table_summary", []),
                state.get("user_direction", ""),
                self.preferences,
            ]
        )
        previous_signature = state.get("task_context_signature")
        if signature != previous_signature:
            state["task_context_signature"] = signature
            # 中文注释：首次展示只建立基线；会话就绪只改卡片状态，不使在途工作推理过期。
            if previous_signature is not None:
                state["context_revision"] += 1
        incoming = {row["id"]: row for row in self.page_tools(state)}
        for priority, task in enumerate(self.context_tasks(state, materials)):
            if self.preferences.get(task) == "hide":
                continue
            subject = CATALOG[task]["subject"]
            if subject in {"table", "tables"}:
                candidates = [m for m in materials if m["kind"] == "table"][-10:]
            elif subject == "image":
                candidates = [m for m in materials if m["kind"] == "image"][-3:]
            else:
                candidates = [m for m in materials if m["kind"] not in {"table", "image"}][-10:]
            if subject in {"tables", "texts"}:
                groups = (
                    [candidates[-2:] if task in {"table.compare", "table.join"} else candidates]
                    if len(candidates) >= 2
                    else []
                )
            else:
                groups = [[m] for m in candidates[-3:]]
            if (
                not groups
                and subject not in {"tables", "texts", "image"}
                and (not materials or page.get("url") or state.get("table_summary"))
            ):
                mode = (
                    "table"
                    if subject == "table"
                    else "selection"
                    if task.startswith("text.")
                    else "page"
                )
                key = digest(
                    [state["work_id"], task, page.get("url", ""), state.get("selection_text", "")]
                )
                row = {
                    "id": key,
                    "action": "assist.task",
                    "params": {"task": task, "materials": [], "options": {}},
                    "title": CATALOG[task]["name"].get(
                        state["locale"], CATALOG[task]["name"]["en"]
                    ),
                    "why": "先选择、粘贴或读取材料，再配置此任务",
                    "source_url": page.get("url", ""),
                    "status": "pending",
                    "standard_task": True,
                    "local_task": not CATALOG[task]["model"],
                    "capture_required": True,
                    "capture_mode": mode,
                    "recommendation_only": True,
                    "recommendation_state": "needs_parameters",
                    "missing_parameters": ["materials"],
                    "missing_capabilities": ["agent"]
                    if CATALOG[task]["model"] and not (state["enabled"] and state["ready"])
                    else [],
                    "subject_kind": "table"
                    if subject == "table"
                    else "text_selection"
                    if mode == "selection"
                    else "page",
                    "task_type": task,
                    "scene": "general",
                    "work_id": state["work_id"],
                    "material_ids": [],
                    "context_priority": priority,
                }
                old = state["suggestions"].get(key)
                if not old or old["status"] == "pending" and not old.get("explicit"):
                    incoming[key] = row
            for group in groups:
                if not self.suitable(task, group):
                    continue
                row = self.prepare(instance, task, [m["id"] for m in group])
                row["context_priority"] = priority
                old = state["suggestions"].get(row["id"])
                if not old or old["status"] == "pending" and not old.get("explicit"):
                    incoming[row["id"]] = row
        incoming = {
            key: row
            for key, row in incoming.items()
            if not any(
                f["id"] == key and feedback_active(f, work_id=state["work_id"])
                for f in state["work_feedback"]
            )
            and app.ignored.get(key) != time.strftime("%Y-%m-%d")
        }
        retained = [
            row
            for row in state["suggestions"].values()
            if not (
                (row.get("standard_task") or row.get("action") == "native.tool")
                and row["status"] == "pending"
                and not row.get("explicit")
            )
        ]
        ranked = rank([*retained, *incoming.values()], state)
        kept = {}
        for row in ranked:
            old = state["suggestions"].get(row["id"])
            if old is None:
                old = row
                app._emit(instance, "update", suggestion=row)
            elif old["status"] == "pending" and not old.get("explicit") and old != row:
                old.clear()
                old.update(row)
                app._emit(instance, "update", suggestion=dict(old))
            kept[row["id"]] = old
        for key in state["suggestions"].keys() - kept.keys():
            app._emit(instance, "remove", id=key)
        state["suggestions"] = kept

    def request(self, instance, method, params):
        app = self.app
        if method == "workbench_interpret":
            return self.interpret(instance, params)
        if method == "workbench_open_artifact":
            return self.open_artifact(instance, params)
        with app.lock:
            if method == "workbench_state":
                return self.snapshot(instance)
            if method == "workbench_catalog":
                return inventory(app, instance)
            if method == "workbench_metrics":
                return self.metrics()
            if method == "workbench_study_read":
                return self.read_study(instance, params.get("id"))
            if method == "workbench_add":
                return self.add(instance, params)
            if method == "workbench_update":
                return self.add(
                    instance,
                    {k: v for k, v in params.items() if k != "id"},
                    replace_id=params.get("id"),
                )
            if method == "workbench_from_result":
                row = self.result_row(instance, params.get("id"))
                result = self.full_result(row)
                value = {
                    "title": row["title"],
                    "partial": row.get("completion_status") == "partial",
                }
                if result.get("columns"):
                    value.update(
                        kind="table",
                        table={"headers": result["columns"], "records": result.get("records", [])},
                    )
                else:
                    body = (
                        result["verdict"]
                        + "\n\n"
                        + "\n\n".join(
                            s["title"] + "\n" + s["text"] for s in result.get("sections", [])
                        )
                    )
                    body += "\n\n" + "\n\n".join(
                        q["question"] + "\n" + q["answer"] for q in result.get("questions", [])
                    )
                    value.update(kind="text", text=body)
                return self.add(instance, value, internal=True)
            if method == "workbench_answer":
                row = self.result_row(instance, params.get("id"))
                question = next(
                    (
                        q
                        for q in row["result"].get("questions", [])
                        if q["id"] == params.get("question_id")
                    ),
                    None,
                )
                if (
                    not question
                    or not isinstance(params.get("answer"), str)
                    or len(params["answer"]) > 3000
                    or params.get("self_rating") not in {None, "understood", "review"}
                ):
                    raise ValueError("题目、答案或自评无效")
                record = {
                    "question_id": question["id"],
                    "answer": redact_page(params["answer"]),
                    "stage": "answered",
                    "self_rating": params.get("self_rating"),
                    "at": time.time(),
                }
                self.responses[(instance, row["id"], question["id"])] = record
                if params.get("save") is True:
                    if not app.work_memory.enabled:
                        raise ValueError("工作记忆已关闭，不能保存学习记录")
                    identity = digest(
                        [
                            instance,
                            row["id"],
                            row.get("full_result_file", row.get("finished_at")),
                            question["id"],
                        ]
                    )
                    private_write(
                        app.directory / "memory" / ("study-" + identity + ".json"),
                        json.dumps(
                            {
                                **record,
                                "id": identity,
                                "owner_digest": digest(instance),
                                "question": question["question"],
                                "reference_answer": question["answer"],
                                "source_quote": question.get("source_quote", ""),
                            },
                            ensure_ascii=False,
                        ),
                    )
                    self.revision += 1
                return {
                    "record": record,
                    "feedback": {
                        "correct": None,
                        "explanation": "已记录作答，请对照参考答案自评；逐题讲解可建立讲解任务。",
                        "reference_answer": question["answer"],
                        "source_id": question["source_id"],
                        "source_quote": question.get("source_quote", ""),
                    },
                }
            if method == "workbench_remove":
                rows = self.chosen(instance, params["ids"])
                for row in rows:
                    del self.materials[row["id"]]
                self.revision += 1
                self.refresh(instance)
                return self.snapshot(instance)
            if method == "workbench_clear":
                self.materials = {k: r for k, r in self.materials.items() if r["owner"] != instance}
                if params.get("history") is True:
                    self.forget()
                self.revision += 1
                self.refresh(instance)
                return self.snapshot(instance)
            if method == "workbench_preference":
                if params.get("task") not in CATALOG or params.get("value") not in {
                    "prefer",
                    "hide",
                    "neutral",
                }:
                    raise ValueError("偏好参数无效")
                self.preferences[params["task"]] = params["value"]
                self.save()
                self.refresh(instance)
                return self.snapshot(instance)
            if method == "workbench_plan":
                row = self.prepare(
                    instance, params["task"], params["materials"], params.get("options"), True
                )
                old = app._state(instance)["suggestions"].get(row["id"])
                if old and old["status"] in {"completed", "failed", "stopped"}:
                    app._archive(app._state(instance), old)
                    del app._state(instance)["suggestions"][row["id"]]
                    old = None
                if not old or old["status"] == "pending":
                    app._state(instance)["suggestions"][row["id"]] = row
                    app._emit(instance, "add", suggestion=row)
                return {
                    "card": app._state(instance)["suggestions"][row["id"]],
                    "state": app.view(instance),
                }
            if method == "workbench_restore":
                state = app._state(instance)
                state["work_feedback"] = [
                    f for f in state["work_feedback"] if f["id"] != params.get("id")
                ]
                app.ignored.pop(params.get("id"), None)
                private_write(app.ignored_path, json.dumps(app.ignored))
                self.refresh(instance)
                return self.snapshot(instance)
        raise ValueError("未知通用任务命令")

    def result_row(self, instance, identity):
        state = self.app._state(instance)
        row = state["suggestions"].get(identity) or next(
            (r for r in state["result_history"] if r["id"] == identity), None
        )
        if not row or row["status"] != "completed" or not row.get("result"):
            raise ValueError("结果尚未完成或已清理")
        return row

    def open_artifact(self, instance, params):
        with self.app.lock:
            row = self.result_row(instance, params.get("id"))
            index = params.get("index")
            artifacts = row["result"].get("artifacts", [])
            if (
                not row.get("standard_task")
                or type(index) is not int
                or not 0 <= index < len(artifacts)
                or not row.get("full_result_file")
            ):
                raise ValueError("任务产物不可用")
            self.full_result(row)
            root = Path(row["full_result_file"]).parent
            path = Path(artifacts[index]["path"])
            if (
                path.parent != root
                or path.suffix not in {".json", ".csv", ".xlsx", ".md", ".svg"}
                or any(p.is_symlink() for p in (path, *path.parents))
                or not path.is_file()
            ):
                raise ValueError("只能打开此任务生成的文件")
        subprocess.run(
            ["open" if sys.platform == "darwin" else "xdg-open", str(path)],
            check=True,
            timeout=5,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"opened": True}

    def full_result(self, row):
        if not row.get("full_result_file"):
            return row["result"]
        path = Path(row["full_result_file"])
        root = (self.app.directory / "tasks").resolve()
        if (
            not path.is_relative_to(root)
            or path.name != "result.json"
            or not path.parent.name.startswith(
                "assist-" + row.get("artifact_owner_id", row["id"]) + "-"
            )
            or any(p.is_symlink() for p in (path, *path.parents))
            or not path.is_file()
            or path.stat().st_size > 8 * 1024 * 1024
        ):
            raise ValueError("完整结果文件不可用，请核对任务产物")
        result = json.loads(path.read_text())
        validate(result, SCHEMA)
        return result

    def forget(self):
        self.history, self.preferences, self.responses = [], {}, {}
        for path in [self.path, *self.path.parent.glob("study-*.json")]:
            if path.is_file() and not path.is_symlink():
                path.unlink()

    def read_study(self, instance, identity):
        if (
            not self.app.work_memory.enabled
            or not isinstance(identity, str)
            or not re.fullmatch(r"[a-f0-9]{24}", identity)
        ):
            raise ValueError("学习记录不可用")
        path = self.path.parent / ("study-" + identity + ".json")
        if (
            any(p.is_symlink() for p in (path, *path.parents))
            or not path.is_file()
            or path.stat().st_size > 32000
        ):
            raise ValueError("学习记录不可用")
        value = json.loads(path.read_text())
        if (
            not isinstance(value, dict)
            or value.get("owner_digest") != digest(instance)
            or value.get("id") != identity
        ):
            raise ValueError("学习记录不属于当前浏览器")
        return {k: v for k, v in value.items() if k != "owner_digest"}

    def study_records(self, instance):
        if not self.app.work_memory.enabled:
            return []
        records = []
        for path in sorted(self.path.parent.glob("study-*.json"), reverse=True)[:100]:
            try:
                value = self.read_study(instance, path.stem[6:])
                records.append(
                    {k: value.get(k) for k in ("id", "question_id", "stage", "self_rating", "at")}
                    | {"title": str(value.get("question", ""))[:100]}
                )
            except (OSError, ValueError):
                continue
        return sorted(records, key=lambda r: r.get("at", 0), reverse=True)[:30]

    def cancel(self, instance):
        if self.app.acp_executions:
            for key, owner in list(self.interpret_jobs.items()):
                if owner == instance:
                    self.app.acp_executions.cancel(key)

    def metrics(self):
        history = self.history if self.app.work_memory.enabled else []
        return {
            "attempts": len(history),
            "verified": sum(r.get("status") == "verified" for r in history),
            "source_checked": sum(r.get("status") == "source_checked" for r in history),
            "partial": sum(r.get("status") == "partial" for r in history),
            "elapsed_ms": sum(r.get("elapsed_ms", 0) for r in history),
            "model_accuracy": "not_independently_verified",
        }

    def save(self):
        if self.app.work_memory.enabled:
            private_write(
                self.path,
                json.dumps(
                    {"history": self.history[-200:], "preferences": self.preferences},
                    ensure_ascii=False,
                ),
            )

    def settled(self, instance, row):
        if (
            not row.get("standard_task")
            or row.get("capture_required")
            or not self.app.work_memory.enabled
        ):
            return
        attempt = [row["id"], row.get("started_at"), row["status"]]
        if row.get("outcome_attempt") == attempt:
            return
        row["outcome_attempt"] = attempt
        task = row["params"]["task"]
        status = row["status"]
        if status == "completed":
            status = (
                "partial"
                if row.get("completion_status") == "partial"
                else "source_checked"
                if CATALOG[task]["model"] or task.startswith("image.")
                else "verified"
            )
        self.history = (
            self.history
            + [
                {
                    "task": task,
                    "status": status,
                    "elapsed_ms": round(
                        max(0, time.time() - row.get("started_at", time.time())) * 1000
                    ),
                    "at": time.time(),
                    "kind": row.get("subject_kind", "unknown"),
                    "provider_revision": self.task_revision,
                }
            ]
        )[-200:]
        self.save()
