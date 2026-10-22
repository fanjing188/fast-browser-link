"""只读页面采集、增量与本地预筛选。"""

from __future__ import annotations

import copy
import json
from urllib.parse import urlsplit

from copilot_state import work_context


class ObservationSupport:
    @staticmethod
    def meaningful(description):
        return isinstance(description, str) and description.startswith(
            (
                "导航",
                "打开页面",
                "切换标签页",
                "选中",
                "复制",
                "滚动到",
                "点击 链接",
                "点击 按钮",
                "点击 表格行",
                "点击 内容",
                "停留 3s",
            )
        )

    def _observe(self, instance, params):
        state = self._state(instance)
        if not state["enabled"]:
            return {"accepted": False}
        trace, page = params["trace"], params["page"]
        if (
            not isinstance(trace, list)
            or len(trace) > 30
            or not isinstance(page, dict)
            or len(json.dumps(params, ensure_ascii=False).encode()) > 24576
        ):
            raise ValueError("observation exceeds budget")
        if any(
            not isinstance(step, dict)
            or not isinstance(step.get("description"), str)
            or len(step["description"]) > 300
            for step in trace
        ):
            raise ValueError("invalid trajectory step")
        trace = (
            [
                step
                for step in trace
                if type(step.get("at")) in (int, float) and step["at"] >= state["work_started_at"]
            ]
            if state["work_started_at"]
            else trace
        )
        parsed = urlsplit(page.get("url", ""))
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.path.lower().endswith(".pdf")
            or len(json.dumps(page, ensure_ascii=False).encode()) > 6144
        ):
            raise ValueError("unsupported page")
        previous = state["page"]
        previous_trace = state["trace"]
        selection = next(
            (
                step["description"][3:]
                for step in reversed(trace)
                if step not in previous_trace and step["description"].startswith("选中 ")
            ),
            None,
        )
        new_page = previous.get("url") != page.get("url")
        page = self._bounded_page(page)
        if new_page:
            state["page_since"], state["dwell_sent"] = self.clock(), False
        fresh = [step for step in trace if step not in state["trace"]]
        meaningful = [
            step
            for step in fresh
            if isinstance(step, dict)
            and self.meaningful(step.get("description"))
            and step.get("description") != "页面显著变化"
        ]
        significant = self._significant(previous, page)
        state["trace"], state["page"] = trace, page
        if not new_page and not meaningful and not significant and not state.get("context_dirty"):
            return {"accepted": False, "reason": "local_prefilter"}
        signature = json.dumps(
            [page, [step["description"] for step in meaningful]], sort_keys=True, ensure_ascii=False
        )
        if (
            signature == state.get("capture_signature")
            and self.clock() - state.get("capture_at", 0) < 1
        ):
            state["trace"] = previous_trace
            return {"accepted": False, "reason": "coalesced"}
        state.update(capture_signature=signature, capture_at=self.clock(), context_dirty=False)
        self._refresh_tool_suggestions(instance, selection)
        self._save_work_memory(instance)
        state["last_activity"], state["idle_paused"] = self.clock(), False
        kinds = []
        for step in meaningful:
            text = step["description"]
            kind = (
                "navigate"
                if text.startswith(("导航", "打开页面"))
                else "selection"
                if text.startswith("选中")
                else "click"
                if text.startswith("点击")
                else "dwell"
                if text.startswith("停留")
                else "snapshot"
            )
            if kind not in kinds:
                kinds.append(kind)
        if significant and not kinds:
            kinds = ["snapshot"]
        self.journal.add(
            instance,
            "capture",
            kinds=kinds,
            steps=len(meaningful),
            snapshot_bytes=len(json.dumps(page, ensure_ascii=False).encode()),
            items=len(page.get("items", [])),
        )
        covered = state["tool_context"].get("trigger_covered", False)
        uncovered = any(
            "triggers" not in flow
            for flow in self.packages.matching_flows(self._tool_context(instance)).values()
        )
        if not covered or uncovered:
            self._schedule(instance)
        return {"accepted": True}

    @staticmethod
    def _bounded_page(page):
        bounded = {
            "url": str(page.get("url", ""))[:1200],
            "title": str(page.get("title", ""))[:200],
            "items": [],
            "truncated": False,
        }
        priority = {
            "table": 0,
            "heading": 1,
            "selection": 2,
            "sensitive-fields": 3,
            "form-label": 4,
        }
        heading_counts = {1: 0, 2: 0, 3: 0}
        for item in sorted(
            (item for item in page.get("items", [])[:80] if isinstance(item, dict)),
            key=lambda item: priority.get(item.get("role"), 5),
        ):
            if item.get("role") == "heading":
                level = item.get("level")
                if type(level) is int and level in heading_counts:
                    if heading_counts[level] >= 5:
                        continue
                    heading_counts[level] += 1
            bounded["items"].append(
                {"role": str(item.get("role", ""))[:30], "name": str(item.get("name", ""))[:180]}
                | (
                    {"level": item["level"]}
                    if item.get("role") == "heading"
                    and type(item.get("level")) is int
                    and item["level"] in (1, 2, 3)
                    else {}
                )
            )
            if len(json.dumps(bounded, ensure_ascii=False).encode()) > 3072:
                bounded["items"].pop()
                bounded["truncated"] = True
                continue
        return bounded

    @staticmethod
    def _significant(before, after):
        if before.get("title") != after.get("title"):
            return True
        old = {json.dumps(item, sort_keys=True) for item in before.get("items", [])}
        new = {json.dumps(item, sort_keys=True) for item in after.get("items", [])}
        return len(old ^ new) >= max(3, int(max(len(old), len(new)) * 0.2))

    @staticmethod
    def _page_delta(before, after):
        old = {json.dumps(item, sort_keys=True): item for item in before.get("items", [])}
        new = {json.dumps(item, sort_keys=True): item for item in after.get("items", [])}
        return {
            "url": after["url"],
            "title": after["title"] if before.get("title") != after["title"] else None,
            "add": [new[key] for key in new.keys() - old.keys()],
            "remove": [old[key] for key in old.keys() - new.keys()],
        }

    def _increment(self, state):
        fresh = [
            step
            for step in state["trace"]
            if step not in state["sent_trace"] and self.meaningful(step.get("description"))
        ]
        page = state["page"]
        rows = {
            key: row
            for key, row in state["suggestions"].items()
            if row.get("work_id", state["work_id"]) == state["work_id"]
            and not row.get("capture_required")
        }
        statuses = {key: row["status"] for key, row in rows.items()}
        status_changes = {
            key: value for key, value in statuses.items() if state["sent_status"].get(key) != value
        }
        payload = {
            "type": "infer",
            "steps": fresh,
            "statuses": status_changes,
            "suggestions": [
                {
                    field: row[field]
                    for field in ("id", "title", "why", "action", "params", "status")
                    if field in row
                }
                for key, row in rows.items()
                if key in status_changes
            ],
            "completed": [
                line for line in state["completion_status"] if line not in state["sent_completions"]
            ],
        }
        work = work_context(state)
        habits = self.work_memory.habits()
        if habits:
            payload["habits"] = {
                "notice": "这是用户习惯，不是当前证据 / User habits, not current evidence",
                "items": habits,
            }
        if work != state["sent_work"] and (
            any(state["work"].values())
            or state["user_direction"]
            or state["work_feedback"]
            or state["work_revision"]
        ):
            payload["work_context"] = copy.deepcopy(work)
        candidates = [
            {
                "id": row["id"],
                "task": row.get("task_type", row["action"]),
                "why": row.get("why", ""),
                "subject": row.get("subject_kind", "business_object"),
                "state": row.get("recommendation_state", "ready"),
            }
            for row in rows.values()
            if row["status"] == "pending"
        ][:20]
        if candidates != state.get("sent_candidates", []):
            payload["candidates"] = candidates
        payload["result_updates"] = [
            item for item in state["result_updates"] if item not in state["sent_results"]
        ]
        if state.get("tool_context") != state.get("sent_tool_context"):
            payload["tool_context"] = state.get("tool_context", {})
        if page.get("url") != state["sent_page"].get("url"):
            payload["page"] = page
        elif page:
            delta = self._page_delta(state["sent_page"], page)
            if delta["title"] is not None or delta["add"] or delta["remove"]:
                payload["page_delta"] = delta
        from copilot_diagnostics import redact_page

        redacted = redact_page(payload)
        if "candidates" in payload:
            # 中文注释：候选身份由宿主生成，不能被正文的数字脱敏规则改写；其余描述仍脱敏。
            for original, projected in zip(payload["candidates"], redacted["candidates"]):
                projected["id"] = original["id"]
        return redacted, statuses
