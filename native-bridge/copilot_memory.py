"""私有工作记忆：工作摘要与结构习惯分开，不保存浏览器原始数据。"""

import copy
import hashlib
import json
import re
import time
from urllib.parse import parse_qs, urlsplit

from copilot_follow import identifier
from copilot_state import work_state
from fbl_runtime import private_write, safe


class WorkMemory:
    def __init__(self, directory, clock=time.time):
        self.directory = directory / "memory"
        self.clock = clock
        self.enabled = self._read("settings.json", {}).get("enabled") is not False
        self.data = {"current": None, "history": [], "habits": []}
        if self.enabled:
            self._load()

    def _read(self, name, default):
        try:
            path = safe(self.directory / name)
            if path.stat().st_size > 2 * 1024 * 1024:
                return copy.deepcopy(default)
            value = json.loads(path.read_text())
            return value if isinstance(value, type(default)) else copy.deepcopy(default)
        except (OSError, ValueError, TypeError):
            return copy.deepcopy(default)

    def _load(self):
        self.data = {"current": None, "history": [], "habits": []}
        value = self._read("work.json", {})
        try:
            current = value.get("current")
            history = value.get("history", [])
            habits = value.get("habits", [])

            def valid_work(row):
                return (
                    isinstance(row, dict)
                    and set(row) == {"work", "user_direction", "at"}
                    and isinstance(row["work"], dict)
                    and work_state(row["work"]) == row["work"]
                    and isinstance(row["user_direction"], str)
                    and len(row["user_direction"]) <= 500
                    and type(row["at"]) in (int, float)
                    and 0 <= row["at"] <= self.clock()
                )

            if (
                (current is not None and not valid_work(current))
                or not isinstance(history, list)
                or len(history) > 20
                or not all(valid_work(row) for row in history)
                or not isinstance(habits, list)
                or len(habits) > 500
            ):
                return
            for habit in habits:
                if (
                    not isinstance(habit, dict)
                    or set(habit)
                    != {"id", "tool", "page", "flow", "object_type", "after", "accepted", "ignored"}
                    or not all(
                        identifier(habit[k]) for k in ("tool", "page", "flow", "object_type")
                    )
                    or (habit["after"] and not identifier(habit["after"]))
                    or any(
                        type(habit[k]) is not int or not 0 <= habit[k] <= 1000000
                        for k in ("accepted", "ignored")
                    )
                    or habit["id"] != self._id(habit)
                ):
                    return
            self.data = {"current": current, "history": history, "habits": habits}
            if current and self.clock() - current["at"] > 86400:
                self.data["history"] = (history + [current])[-20:]
                self.data["current"] = None
                self._save()
        except (KeyError, TypeError, ValueError, OSError):
            self.data = {"current": None, "history": [], "habits": []}

    def _write(self, name, value):
        safe(self.directory).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        private_write(self.directory / name, json.dumps(value, ensure_ascii=False))

    def _save(self):
        if self.enabled:
            self._write("work.json", self.data)

    def snapshot(self):
        return {
            "enabled": self.enabled,
            **copy.deepcopy(
                self.data if self.enabled else {"current": None, "history": [], "habits": []}
            ),
        }

    def restore(self):
        current = self.data["current"] if self.enabled else None
        return copy.deepcopy(current) if current and self.clock() - current["at"] <= 86400 else None

    def save_work(self, state, context, packages):
        if not self.enabled:
            return
        # 中文注释：只落理解摘要；已采集的原文、对象及全部查询参数不能混入摘要。
        forbidden = [
            context.get("url", ""),
            state.get("selected_object", ""),
            state.get("selection_text", ""),
            state.get("page", {}).get("title", ""),
        ]
        forbidden += [item.get("name", "") for item in state.get("page", {}).get("items", [])]
        forbidden += [
            v
            for values in parse_qs(urlsplit(context.get("url", "")).query).values()
            for v in values
        ]
        for identity in packages.matching_flows(context):
            forbidden += packages.flow_objects(identity, context, state.get("selected_object", ""))
        for table in context.get("tables", []):
            for row in table.get("samples", []):
                forbidden += [
                    cell.get("text", "") if isinstance(cell, dict) else str(cell) for cell in row
                ]
        forbidden += state.get("memory_exclusions", [])
        state["memory_exclusions"] = list(
            dict.fromkeys(v for v in forbidden if isinstance(v, str) and v)
        )[-1000:]
        pattern = "|".join(
            re.escape(text)
            for text in sorted(set(state["memory_exclusions"]), key=len, reverse=True)
        )
        exclusions = re.compile(pattern) if pattern else None

        def clean(value):
            if isinstance(value, str):
                value = re.sub(r"https?://\S+", "[url]", value)
                return exclusions.sub("[redacted]", value) if exclusions else value
            if isinstance(value, list):
                return [clean(item) for item in value]
            return {key: clean(item) for key, item in value.items()}

        work = work_state(clean(state["work"]))
        direction = clean(state["user_direction"])[:500]
        self.data["current"] = (
            {"work": work, "user_direction": direction, "at": self.clock()}
            if any(work.values()) or direction
            else None
        )
        self._save()

    @staticmethod
    def _id(row):
        return hashlib.sha256(
            json.dumps([row[k] for k in ("tool", "page", "flow", "object_type", "after")]).encode()
        ).hexdigest()[:24]

    def record(self, tool, page, flow, object_type, event, after=""):
        if (
            not self.enabled
            or event not in {"accepted", "ignored"}
            or not all(identifier(v) for v in (tool, page, flow, object_type))
            or (after and not identifier(after))
        ):
            return
        row = dict(
            tool=tool,
            page=page,
            flow=flow,
            object_type=object_type,
            after=after,
            accepted=0,
            ignored=0,
        )
        row["id"] = self._id(row)
        old = next((h for h in self.data["habits"] if h["id"] == row["id"]), None)
        if old is None:
            self.data["habits"] = (self.data["habits"] + [row])[-500:]
            old = row
        old[event] = min(old[event] + 1, 1000000)
        self._save()

    def habits(self):
        return (
            sorted(
                copy.deepcopy(self.data["habits"]),
                key=lambda row: (
                    row["accepted"] + row["ignored"],
                    row["accepted"] - row["ignored"],
                ),
                reverse=True,
            )[:5]
            if self.enabled
            else []
        )

    def score(self, tool, page, flow):
        return (
            sum(
                row["accepted"] - row["ignored"]
                for row in self.data["habits"]
                if (row["tool"], row["page"], row["flow"]) == (tool, page, flow)
            )
            if self.enabled
            else 0
        )

    def manage(self, params):
        if set(params) == {"enabled"} and type(params["enabled"]) is bool:
            self._write("settings.json", {"enabled": params["enabled"]})
            self.enabled = params["enabled"]
            if self.enabled:
                self._load()
        elif set(params) == {"delete"} and isinstance(params["delete"], str):
            if not self.enabled:
                raise ValueError(
                    "enable memory to delete individual records; clear all is available while off"
                )
            key = params["delete"]
            if key == "current":
                self.data["current"] = None
            elif key.startswith("history:") and key[8:].isdigit():
                self.data["history"] = [
                    row for i, row in enumerate(self.data["history"]) if i != int(key[8:])
                ]
            else:
                self.data["habits"] = [row for row in self.data["habits"] if row["id"] != key]
            self._write("work.json", self.data)
        elif params == {"clear": True}:
            self.data = {"current": None, "history": [], "habits": []}
            self._write("work.json", self.data)
        elif params:
            raise ValueError("invalid memory request")
        return self.snapshot()
