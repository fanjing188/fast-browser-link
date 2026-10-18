"""声明式能力、工具记忆和本机工作流；不包含个人来源或判档门槛。"""

import copy
import csv
from datetime import date
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
from urllib.parse import quote, urlsplit
from copilot_results import obj, text, array, NUMBER, BOOL

from copilot_results import UNIFIED
from copilot_diagnostics import redact

FIELDS = UNIFIED["properties"]
RECORD = UNIFIED
INPUT = obj(
    {
        "keyword": text(2000),
        "keywords": array(text(2000), 1000),
        "domain": text(300),
        "domains": array(text(300), 1000),
        "url": text(4000),
        "urls": array(text(4000), 1000),
        "records": array(RECORD, 5000),
        "n": {"type": "integer"},
        "report": text(100),
        "market": text(40),
        "language": text(40),
        "period": text(40),
        "region": text(40),
        "fields": array(text(40), 20),
    },
    [],
)
OUTPUT = obj(
    {
        "records": array(RECORD, 5000),
        "source": text(500),
        "missing": array(text(500), 50),
        "partial": BOOL,
        "pages": {"type": "integer"},
    },
    ["records", "source"],
)
CAPABILITIES = {
    name: {"input": copy.deepcopy(INPUT), "output": copy.deepcopy(OUTPUT)}
    for name in (
        "keyword.metrics",
        "keyword.expand",
        "keyword.questions",
        "serp.top",
        "domain.keywords",
        "domain.top_pages",
        "domain.authority",
        "domain.competitors",
        "site.page_family",
        "trends.series",
        "keyword.judge",
        "pool.lookup",
        "pool.save",
        "keyword.filter",
    )
}
for capability, contract in CAPABILITIES.items():
    fields = (
        ["keyword"]
        if capability.startswith("keyword.") or capability == "pool.lookup"
        else ["url", "domain", "rank"]
        if capability == "serp.top"
        else ["url"]
        if capability in {"domain.top_pages", "site.page_family"}
        else ["domain"]
    )
    contract["output"]["properties"]["records"]["items"]["required"] = fields
CAPABILITIES["trends.series"]["output"] = obj(
    {
        "series": array(
            obj(
                {
                    "keyword": text(2000),
                    "region": text(20),
                    "period": text(30),
                    "points": array(obj({"date": text(40), "value": NUMBER}), 400),
                }
            ),
            200,
        ),
        "source": text(500),
        "missing": array(text(500), 50),
    },
    ["series", "source"],
)

CAPABILITIES["pool.save"]["output"] = obj(
    {
        "written": {"type": ["integer", "null"]},
        "skipped": array(obj({"keyword": text(2000), "reason": text(300)}), 1000),
        "accepted_keywords": array(text(2000), 1000),
        "source": text(500),
    },
    ["written", "skipped", "source"],
)


def label(value, language="zh"):
    return value.get(language, value.get("en", "")) if isinstance(value, dict) else str(value)


def normalize(value):
    return " ".join(str(value).casefold().split())


def map_table(table, columns, source, schema=None):
    """只消费扩展已过滤的可见单元格；原文不作指标时不造零。"""
    from copilot_tables import number

    fields = schema.get("properties", {}) if schema is not None else FIELDS
    generic = schema is not None and schema != RECORD
    headers = [normalize(header) for header in table["headers"]]
    records = []
    indices = {
        field: next(
            (
                index
                for index, header in enumerate(headers)
                if header in {normalize(alias) for alias in aliases}
            ),
            None,
        )
        for field, aliases in columns.items()
        if field in fields
    }
    for row in table["rows"]:
        record = {} if generic else {"source": source, "field_sources": {}}
        for field, index in indices.items():
            if index is None or index >= len(row):
                continue
            cell = row[index]
            raw = cell.get("text", "").strip()
            if field in {"url", "domain"} and cell.get("links"):
                raw = cell["links"][0]
            if generic:
                kind = fields[field].get("type")
                kind = (
                    next((item for item in kind if item != "null"), "null")
                    if isinstance(kind, list)
                    else kind
                )
                if not raw:
                    continue
                if kind in {"integer", "number"}:
                    value = number(raw)
                    if value is None or kind == "integer" and value != int(value):
                        continue
                    value = int(value) if kind == "integer" else value
                elif kind in {"array", "object", "boolean"}:
                    try:
                        value = json.loads(raw)
                    except ValueError:
                        continue
                else:
                    value = raw
                from copilot_contracts import validate

                validate(value, fields[field])
            elif field in {"intent_tool", "excluded", "host_duplicate"}:
                if raw not in {"0", "1"}:
                    continue
                value = int(raw)
            elif field == "weak":
                if raw.lower() not in {"true", "false", "0", "1"}:
                    continue
                value = raw.lower() in {"true", "1"}
            elif field in {"trend12", "serp_json", "field_sources", "metric_quality"}:
                try:
                    value = json.loads(raw)
                except ValueError:
                    continue
            elif field in {"vol", "kd", "cpc", "position", "traffic", "authority", "rank"}:
                value = number(raw)
                if value is None:
                    continue
                if field in {"kd", "authority"} and not 0 <= value <= 100:
                    continue
                if field == "rank":
                    if value != int(value):
                        continue
                    value = int(value)
            else:
                value = raw
            if value == "":
                continue
            if field == "domain" and "://" in str(value):
                value = urlsplit(value).hostname or ""
            record[field] = value
            if not generic:
                record["field_sources"][field] = source
        if record and (generic or len(record) > 2):
            if generic:
                validate(record, schema)
            records.append(record)
    return records


def recognize(tools, url):
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    for tool in tools:
        if parsed.hostname not in tool["hosts"]:
            continue
        for page in tool.get("pages", []):
            if any(re.search(pattern, parsed.path) for pattern in page.get("paths", [])):
                return {
                    "tool": tool["id"],
                    "page": page["id"],
                    "name": tool.get("name", tool["id"]),
                    "columns": page.get("columns", {}),
                    "actions": page.get("actions", []),
                    "flows": page.get("flows", []),
                    "object": __import__("urllib.parse", fromlist=["parse_qs"])
                    .parse_qs(parsed.query)
                    .get(page.get("object_param", ""), [""])[0],
                }
        return {
            "tool": tool["id"],
            "page": "unknown",
            "name": tool.get("name", tool["id"]),
            "columns": {},
            "actions": [],
            "flows": [],
        }
    return None


def discover(roots):
    """仅扫描有限frontmatter；不导入技能代码，不读取正文或凭据。"""
    found = []
    hints = {
        "keyword": ("keyword.metrics", "keyword.expand"),
        "关键词": ("keyword.metrics", "keyword.expand"),
        "serp": ("serp.top",),
        "trends": ("trends.series",),
        "词池": ("pool.lookup",),
        "扩词": ("keyword.expand",),
        "反查": ("domain.keywords",),
        "判档": ("keyword.judge",),
        "sitemap": ("site.page_family",),
    }
    for root in roots:
        root = Path(root).expanduser()
        if not root.is_dir() or root.is_symlink():
            continue
        for path in root.rglob("SKILL.md"):
            if len(found) >= 200:
                return found
            if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
                continue
            with path.open() as handle:
                prefix = handle.read(16384)
            match = re.match(r"^---\s*\n(.*?)\n---", prefix, re.S)
            if not match:
                continue
            front = match.group(1)
            name = re.search(r"^name:\s*(.+)", front, re.M)
            description = re.search(r"^description:\s*(.+)", front, re.M)
            title = name.group(1).strip(" \"'") if name else path.parent.name
            declared = [
                cap
                for cap in CAPABILITIES
                if re.search(r"(?<![\w.])" + re.escape(cap) + r"(?![\w.])", front)
            ]
            if not declared:
                words = (title + " " + (description.group(1) if description else "")).lower()
                declared = list(
                    dict.fromkeys(
                        cap for term, caps in hints.items() if term in words for cap in caps
                    )
                )
            if declared:
                found.append(
                    {
                        "id": hashlib.sha256(str(path).encode()).hexdigest()[:20],
                        "name": title[:120],
                        "capabilities": declared,
                        "declared": bool(re.search(r"capabilities:", front)),
                        "status": "can_bind",
                    }
                )
    return found


def command_status(command):
    executable = command[0]
    if not (
        Path(executable).is_file() and os.access(executable, os.X_OK)
        if "/" in executable
        else shutil.which(executable)
    ):
        return "missing_command"
    if any(
        not Path(arg).is_file()
        for arg in command[1:]
        if arg.endswith((".py", ".sh", ".js", ".mjs"))
        and "{" not in arg
        and not arg.startswith("-")
        and "://" not in arg
    ):
        return "missing_script"
    return "available"


class Stopped(ValueError):
    pass


class Registry:
    def __init__(self, packages, directory, write, validate, browser=None, hermes=None):
        self.packages = packages
        self.schemas = {**CAPABILITIES, **packages.schemas}
        self.directory = Path(directory)
        self.write = write
        self.validate = validate
        self.browser = browser
        self.hermes = hermes
        self.lock = threading.RLock()
        self.jobs = {}
        self.health = {}
        self.memory = {"choices": {}, "disabled": {}}
        self.path = self.directory / "tool-memory.json"
        try:
            value = json.loads(self.path.read_text())
            if (
                isinstance(value, dict)
                and isinstance(value.get("choices"), dict)
                and isinstance(value.get("disabled"), dict)
            ):
                self.memory = value
        except (OSError, ValueError):
            pass

    def save(self):
        self.write(self.path, json.dumps(self.memory, ensure_ascii=False))

    def record(self, tool, page, flow, event):
        if event not in {"clicked", "ignored"} or flow not in self.packages.flows:
            return
        key = "|".join([tool or "unknown", page or "unknown", flow])
        with self.lock:
            counts = self.memory["choices"].setdefault(key, {"clicked": 0, "ignored": 0})
            counts[event] += 1
            self.save()

    def disabled(self, binding):
        entry = self.memory["disabled"].get(binding.get("serial_group") or binding["id"], {})
        return entry.get("day") == date.today().isoformat()

    def disable(self, binding, reason):
        with self.lock:
            self.memory["disabled"][binding.get("serial_group") or binding["id"]] = {
                "day": date.today().isoformat(),
                "reason": reason,
            }
            self.save()

    def candidates(self, capability, context=None):
        current = recognize(self.packages.tools, (context or {}).get("url", "")) or {}
        return sorted(
            self.packages.bindings.get(capability, []),
            key=lambda item: (
                bool(current.get("tool")) and item.get("tool") != current["tool"],
                item.get("priority", 100),
            ),
        )

    def structural(self, binding, context=None, recheck_page=False):
        entry = self.memory["disabled"].get(binding.get("serial_group") or binding["id"], {})
        if self.disabled(binding) and not (
            recheck_page and entry.get("reason") == "scope_or_page_unavailable"
        ):
            return "disabled_today"
        if binding.get("browser") and binding["browser"] != (context or {}).get("browser"):
            return "wrong_browser"
        if binding["type"] == "mcp":
            return "available" if Path(binding["config_path"]).is_file() else "missing_command"
        if binding["type"] == "command":
            status = command_status(binding["argv"])
            if status != "available":
                return status
            if any(
                not Path(path).expanduser().exists() for path in binding.get("required_paths", [])
            ):
                return "missing_local_data"
            return "available"
        if binding["type"] == "hermes":
            return (
                "available"
                if self.hermes and (context or {}).get("hermes")
                else "needs_explicit_fallback"
            )
        if binding.get("plan_argv"):
            status = command_status(binding["plan_argv"])
            if status != "available":
                return status
        tool = next(
            (tool for tool in self.packages.tools if tool["id"] == binding.get("tool")), None
        )
        if not tool:
            return "missing_profile"
        if binding.get("verified") is not True or not tool.get("links", {}).get(
            binding.get("link")
        ):
            return "needs_route_confirmation"
        return self.health.get(binding["id"], {}).get("status", "needs_browser_check")

    def inspect(self, context=None):
        return {
            cap: {
                "status": "available"
                if any(
                    self.structural(binding, context) == "available"
                    and (cap != "keyword.metrics" or binding.get("exact") is True)
                    for binding in self.candidates(cap)
                )
                else "missing",
                "bindings": [
                    {
                        "id": binding["id"],
                        "type": binding["type"],
                        "tool": binding.get("tool", binding["id"]),
                        "cost": binding.get("cost", "unknown"),
                        "batch_limit": binding.get("batch_limit", 1),
                        "status": self.structural(binding, context),
                        "serial": bool(binding.get("serial_group")),
                    }
                    for binding in self.candidates(cap)
                ],
            }
            for cap in self.schemas
        }

    def recommendations(self, context, selection="", language="zh"):
        current = recognize(self.packages.tools, context.get("url", "")) or {
            "tool": "unknown",
            "page": "unknown",
            "flows": [],
        }
        matched = self.packages.matching_flows(context)
        wanted = current.get("flows") or list(matched)
        # 中文注释：旧包的无页面流程保持原有划词入口；新对象只在声明的页面上提取。
        if not wanted:
            wanted = [
                identity
                for identity, flow in self.packages.flows.items()
                if flow.get("object", "keyword") in {"keyword", "domain", "url"}
                and self.packages.flow_packages.get(identity) in {None, "generic", "seo"}
            ]
        rows = []
        health = self.inspect(context)
        for identity in wanted:
            flow = self.packages.flows.get(identity)
            if not flow:
                continue
            if (
                flow.get("object", "keyword") not in {"keyword", "domain", "url"}
                and identity not in matched
            ):
                continue
            objects = self.packages.flow_objects(identity, context, selection)
            if not objects:
                continue
            object_value = objects[0]
            required = sorted(
                {
                    step["capability"]
                    for step in flow["steps"]
                    if step.get("capability") and not step.get("optional")
                }
            )
            missing = [cap for cap in required if health.get(cap, {}).get("status") != "available"]
            for step in flow["steps"]:
                fields = step.get("input", {}).get("fields")
                report = step.get("input", {}).get("report")
                if (
                    step.get("capability")
                    and report
                    and not step.get("optional")
                    and not any(
                        self.structural(binding, context) == "available"
                        and report in binding.get("reports", [])
                        for binding in self.candidates(step["capability"])
                    )
                ):
                    missing.append(step["capability"] + "[" + report + "]")
                if (
                    step.get("capability")
                    and fields
                    and not step.get("optional")
                    and not any(
                        self.structural(binding, context) == "available"
                        and set(fields) <= set(binding.get("fields", []))
                        for binding in self.candidates(step["capability"])
                    )
                ):
                    missing.append(step["capability"] + "[" + ",".join(fields) + "]")
            score = self.memory["choices"].get(
                "|".join([current["tool"], current["page"], identity]), {}
            )
            rows.append(
                {
                    "id": identity,
                    "action": "workflow.run",
                    "scene": self.packages.scenes.get(
                        self.packages.flow_packages.get(identity), {"id": "general"}
                    )["id"],
                    "flow_name": label(flow["name"], language),
                    "title": label(flow["name"], language),
                    "why": label(flow.get("description", {}), language),
                    "params": {"flow": identity, "object": object_value},
                    "missing_capabilities": missing,
                    "available": not missing,
                    "score": score.get("clicked", 0) - score.get("ignored", 0),
                    "tool": current["tool"],
                    "page": current["page"],
                    "contextual": True,
                }
            )
        rows.sort(key=lambda row: (not row["available"], -row["score"]))
        return rows

    def stop(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if job:
                job["stop"].set()

    def _lane(self, binding, stop):
        lane = binding.get("serial_group")
        if not lane:
            return None
        path = self.directory / "locks" / (hashlib.sha256(lane.encode()).hexdigest() + ".lock")
        self.write(path, "")
        handle = path.open("a")
        deadline = time.monotonic() + 300
        while True:
            if stop.is_set():
                handle.close()
                raise Stopped("stopped")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return handle
            except BlockingIOError:
                if time.monotonic() > deadline:
                    handle.close()
                    raise ValueError("serial lane busy")
                time.sleep(0.05)

    def _command(self, binding, inputs, work, stop):
        self.write(work / "input.json", json.dumps(inputs, ensure_ascii=False))
        fields = list(dict.fromkeys(key for row in inputs.get("records", []) for key in row)) or [
            "keyword"
        ]
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(
            {
                key: json.dumps(value, ensure_ascii=False)
                if isinstance(value, (dict, list))
                else value
                for key, value in row.items()
            }
            for row in inputs.get("records", [])
            or [{"keyword": word} for word in inputs.get("keywords", [])]
        )
        self.write(work / "input.csv", stream.getvalue())
        self.write(
            work / "keywords.txt", "\n".join(inputs.get("keywords") or [inputs.get("keyword", "")])
        )
        values = {
            **inputs,
            "input_json": str(work / "input.json"),
            "input_csv": str(work / "input.csv"),
            "keywords_file": str(work / "keywords.txt"),
            "output_csv": str(work / "output.csv"),
            "output_json": str(work / "output.json"),
            "work_dir": str(work),
        }
        argv = []
        for arg in binding["argv"]:
            if arg == "{keywords}":
                items = inputs.get("keywords") or [inputs.get("keyword", "")]
                if any(item.startswith("-") for item in items):
                    raise ValueError("positional value cannot be an option")
                argv += items
            elif arg == "{domains}":
                items = inputs.get("domains") or [inputs.get("domain", "")]
                if any(item.startswith("-") for item in items):
                    raise ValueError("positional value cannot be an option")
                argv += items
            else:

                def replace(match):
                    name = match.group(1)
                    if name not in values:
                        raise ValueError("unknown argument placeholder")
                    return str(values[name])

                if argv and argv[-1] in {"-c", "-e", "-Command"} and re.search(r"\{[a-z_]+\}", arg):
                    raise ValueError("code interpolation is not allowed")
                value = re.sub(r"\{([a-z_][a-z0-9_]*)\}", replace, arg)
                if "{" in arg and not arg.startswith("-") and value.startswith("-"):
                    raise ValueError("positional value cannot be an option")
                argv.append(value)
        with (
            (work / "input.json").open("rb") as input_handle,
            (work / "stdout").open("wb") as stdout,
            (work / "stderr").open("wb") as stderr,
        ):
            os.chmod(work / "stdout", 0o600)
            os.chmod(work / "stderr", 0o600)
            if stop.is_set():
                raise Stopped("stopped")
            if binding.get("_automatic"):
                sandbox = shutil.which("sandbox-exec")
                if not sandbox:
                    raise ValueError("automatic local reads require a network-denying sandbox")
                policy = (
                    "(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "
                    + json.dumps(str(work.resolve()))
                    + "))"
                )
                argv = [sandbox, "-p", policy, *argv]
            process = subprocess.Popen(
                argv,
                stdin=input_handle,
                stdout=stdout,
                stderr=stderr,
                cwd=work,
                start_new_session=True,
            )
            try:
                deadline = min(
                    time.monotonic() + binding.get("timeout", 120),
                    binding.get("_deadline", float("inf")),
                )
                while process.poll() is None:
                    if stop.wait(0.05) or time.monotonic() > deadline:
                        raise (
                            Stopped("stopped") if stop.is_set() else ValueError("command timed out")
                        )
                    if (work / "stdout").stat().st_size + (
                        work / "stderr"
                    ).stat().st_size > 2097152:
                        raise ValueError("command output too large")
            finally:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
        stderr = (work / "stderr").read_text(errors="replace")[:16384]
        stdout = (work / "stdout").read_text(errors="replace")[:1048576]
        reason = next(
            (
                reason
                for reason, patterns in binding.get("stop_text", {}).items()
                if any(re.search(pattern, stderr + "\n" + stdout, re.I) for pattern in patterns)
            ),
            None,
        )
        if process.returncode in binding.get("stop_codes", []) or reason:
            self.disable(binding, reason or "provider_exit")
            raise ValueError("provider disabled_today")
        if process.returncode and process.returncode not in binding.get("partial_codes", []):
            raise ValueError("command failed")
        output = binding.get("output", {"format": "json", "from": "stdout"})
        content = (
            stdout
            if output.get("from", "stdout") == "stdout"
            else (work / ("output.csv" if output["format"] == "csv" else "output.json")).read_text(
                encoding="utf-8-sig"
            )
        )
        if len(content.encode()) > 1048576:
            raise ValueError("command result too large")
        if output["format"] == "json":
            value = json.loads(content)
        else:
            rows = list(csv.DictReader(io.StringIO(content)))
            mapping = output.get("columns", {})
            table = {
                "headers": list(rows[0]) if rows else [],
                "rows": [[{"text": str(cell)} for cell in row.values()] for row in rows],
            }
            record = (
                binding.get("_schema", {}).get("properties", {}).get("records", {}).get("items")
            )
            value = {
                "records": map_table(table, mapping, binding["id"], record),
                "source": binding["id"],
            }
        if process.returncode:
            value["partial"] = True
            value.setdefault("missing", []).append("partial command output")
        return value

    def execute(self, capability, inputs, work, stop, context=None, progress=lambda _: None):
        if capability not in self.schemas:
            raise ValueError("unknown capability")
        self.validate(inputs, self.schemas[capability]["input"])
        context = dict(context or {})
        if context.get("automatic"):
            context.setdefault("deadline", time.monotonic() + 3)
        if capability == "serp.top" and (
            type(inputs.get("n", 10)) is not int or not 1 <= inputs.get("n", 10) <= 10
        ):
            raise ValueError("SERP result count must be 1–10")
        missing = []
        accepted = {}
        series = []
        sources = []
        required = inputs.get("fields", (["vol", "kd"] if capability == "keyword.metrics" else []))

        def complete():
            if capability == "trends.series":
                return bool(series)
            if capability == "pool.lookup":
                return bool(sources)
            if not accepted:
                return False
            if capability == "keyword.metrics" and any(
                any(
                    row.get("metric_quality", {}).get(field) != "exact"
                    for field in ("vol", "kd")
                    if field in required
                )
                for row in accepted.values()
            ):
                return False
            if any(
                any(field not in row or row[field] is None for field in required)
                for row in accepted.values()
            ):
                return False
            if capability == "serp.top":
                wanted = inputs.get("keywords") or [inputs.get("keyword", "")]
                if any(
                    sum(
                        normalize(row.get("keyword", "")) == normalize(word)
                        for row in accepted.values()
                    )
                    < inputs.get("n", 10)
                    for word in wanted
                ):
                    return False
            wanted = (
                (inputs.get("keywords") or ([inputs["keyword"]] if inputs.get("keyword") else []))
                if capability == "keyword.metrics"
                else []
            )
            return not wanted or {
                normalize(row.get("keyword", "")) for row in accepted.values()
            } >= {normalize(word) for word in wanted}

        for binding in self.candidates(capability, context):
            from copilot_risk import authorize_binding

            if not authorize_binding(binding, context or {}):
                missing.append(binding["id"] + ": risk_or_confirmation_required")
                continue
            if (context or {}).get("local_only") and binding["type"] != "command":
                continue
            if stop.is_set():
                raise Stopped("stopped")
            status = self.structural(binding, context)
            if any(
                inputs.get(field) and normalize(inputs[field]) != normalize(binding.get(field, ""))
                for field in ("market", "language")
            ):
                missing.append(binding["id"] + ": requested scope not declared")
                continue
            if inputs.get("report") and inputs["report"] not in binding.get("reports", []):
                missing.append(binding["id"] + ": requested report mode not declared")
                continue
            if inputs.get("fields") and not set(inputs["fields"]) <= set(binding.get("fields", [])):
                missing.append(binding["id"] + ": requested fields not declared")
                continue
            if status != "available":
                missing.append(binding["id"] + ": " + status)
                continue
            lane = self._lane(binding, stop)
            try:
                if self.disabled(binding):
                    missing.append(binding["id"] + ": disabled_today")
                    continue
                sequence = next(
                    (field for field in ("keywords", "domains", "records") if inputs.get(field)),
                    None,
                )
                chunks = [inputs]
                if sequence:
                    size = binding.get("batch_limit", 100)
                    chunks = [
                        {**inputs, sequence: inputs[sequence][start : start + size]}
                        for start in range(0, len(inputs[sequence]), size)
                    ]
                for chunk_no, chunk in enumerate(chunks):
                    if stop.is_set():
                        raise Stopped("stopped")
                    if context.get("deadline") and time.monotonic() > context["deadline"]:
                        missing.append("automatic read deadline reached")
                        break
                    if self.disabled(binding):
                        break
                    step = work / binding["id"] / str(chunk_no)
                    step.mkdir(parents=True, exist_ok=True, mode=0o700)
                    started = time.monotonic()
                    if binding["type"] == "command":
                        value = self._command(
                            {
                                **binding,
                                "_automatic": (context or {}).get("automatic", False),
                                "_deadline": context.get("deadline", float("inf")),
                            },
                            chunk,
                            step,
                            stop,
                        )
                    elif binding["type"] == "mcp":
                        from fbl_discovery import mcp_call

                        value = mcp_call(binding, chunk)
                    elif binding["type"] == "hermes":
                        value = self.hermes(
                            binding,
                            chunk,
                            step,
                            stop,
                            {**(context or {}), "capability": capability},
                        )
                    else:
                        value = self.browser(
                            binding,
                            chunk,
                            step,
                            stop,
                            {**(context or {}), "capability": capability},
                        )
                    blocked = value.pop("blocked", None)
                    self.validate(value, self.schemas[capability]["output"])
                    progress(
                        {
                            "provider": binding["id"],
                            "capability": capability,
                            "batch": chunk_no + 1,
                            "implementation": binding["type"],
                            "phase": "done",
                            "count": len(value.get("records", value.get("series", []))),
                            "duration_ms": (time.monotonic() - started) * 1000,
                        }
                    )
                    if capability == "pool.save":
                        return value
                    sources.append(value["source"])
                    series += value.get("series", [])
                    for row in value.get("records", []):
                        if capability not in CAPABILITIES:
                            identity = json.dumps(row, sort_keys=True, ensure_ascii=False)
                            accepted.setdefault(identity, copy.deepcopy(row))
                            continue
                        if any(
                            not isinstance(source, str) or len(source) > 500
                            for source in row.get("field_sources", {}).values()
                        ):
                            raise ValueError("invalid field provenance")
                        if inputs.get("fields"):
                            keep = set(inputs["fields"]) | {
                                "keyword",
                                "domain",
                                "url",
                                "source",
                                "field_sources",
                                "metric_quality",
                            }
                            row = {field: item for field, item in row.items() if field in keep}
                        row.setdefault("source", value["source"])
                        row.setdefault("field_sources", {}).update(
                            {
                                field: row.get("field_sources", {}).get(field, value["source"])
                                for field in row
                                if field not in {"source", "field_sources", "metric_quality"}
                            }
                        )
                        if capability == "keyword.metrics":
                            row["metric_quality"] = {
                                field: "exact"
                                if binding.get("exact") is True and binding["type"] != "hermes"
                                else "candidate"
                                for field in ("vol", "kd", "cpc")
                                if field in row
                            }
                        identity = normalize(
                            (
                                (row.get("keyword", "") + "|" + row.get("url", ""))
                                if capability == "serp.top"
                                else row.get("url")
                                if capability in {"domain.top_pages", "site.page_family"}
                                else None
                            )
                            or row.get("keyword")
                            or row.get("domain")
                            or row.get("url")
                            or json.dumps(row, sort_keys=True)
                        )
                        old = accepted.setdefault(identity, {})
                        for field, value_ in row.items():
                            if field in {"field_sources", "metric_quality"}:
                                continue
                            if (
                                field not in old
                                or old[field] is None
                                or row.get("metric_quality", {}).get(field) == "exact"
                                and old.get("metric_quality", {}).get(field) != "exact"
                            ):
                                old[field] = value_
                                old.setdefault("field_sources", {})[field] = row[
                                    "field_sources"
                                ].get(field, row["source"])
                                if field in row.get("metric_quality", {}):
                                    old.setdefault("metric_quality", {})[field] = row[
                                        "metric_quality"
                                    ][field]
                    missing += value.get("missing", [])
                    if blocked:
                        if blocked == "cleanup_unverified" or blocked in binding.get(
                            "disable_on", ["login", "captcha", "quota", "rate_limit"]
                        ):
                            self.disable(binding, blocked)
                        missing.append(binding["id"] + ": " + blocked)
                        break
                if complete():
                    break
            except Stopped:
                raise
            except (
                ValueError,
                OSError,
                KeyError,
                TypeError,
                subprocess.SubprocessError,
                RuntimeError,
            ):
                missing.append(binding["id"] + ": source_unavailable")
            finally:
                if lane:
                    fcntl.flock(lane, fcntl.LOCK_UN)
                    lane.close()
        if not complete():
            missing.append(capability + ": missing required evidence")
        output = {
            "source": ";".join(dict.fromkeys(sources)) or "unavailable",
            "missing": list(dict.fromkeys(missing))[:50],
        }
        if capability == "trends.series":
            output["series"] = series
        else:
            output["records"] = list(accepted.values())
        return output

    def probe(self, context, browser_probe=None):
        self.health.clear()
        probes = {}
        for bindings in self.packages.bindings.values():
            for binding in bindings:
                if binding["type"] != "browser" or binding["id"] in self.health:
                    continue
                status = self.structural(binding, context, recheck_page=True)
                if status != "needs_browser_check":
                    continue
                if not browser_probe:
                    continue
                stop = threading.Event()
                lane = self._lane(binding, stop)
                try:
                    key = (binding.get("tool"), binding.get("browser"))
                    if key not in probes:
                        probes[key] = browser_probe(binding, context)
                    result = probes[key]
                    if result.get("ready") is True:
                        lane_key = binding.get("serial_group") or binding["id"]
                        with self.lock:
                            if (
                                self.memory["disabled"].get(lane_key, {}).get("reason")
                                == "scope_or_page_unavailable"
                            ):
                                self.memory["disabled"].pop(lane_key)
                                self.save()
                    if result.get("blocked") == "cleanup_unverified" or result.get(
                        "blocked"
                    ) in binding.get("disable_on", ["login", "captcha", "quota", "rate_limit"]):
                        self.disable(binding, result["blocked"])
                    self.health[binding["id"]] = {
                        "status": "available"
                        if result.get("ready") is True
                        else result.get("blocked", "needs_login_or_readable_report")
                    }
                except (ValueError, OSError, KeyError, TypeError):
                    self.health[binding["id"]] = {"status": "probe_unavailable"}
                finally:
                    if lane:
                        fcntl.flock(lane, fcntl.LOCK_UN)
                        lane.close()
        return self.inspect(context)


def resolve(value, context):
    if isinstance(value, str) and value.startswith("$"):
        current = context
        for part in value[1:].split("."):
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        return copy.deepcopy(current)
    if isinstance(value, dict):
        return {key: resolve(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, context) for item in value]
    return value


def transform(name, records, options, context):
    records = copy.deepcopy(records)
    missing = []
    from copilot_pack_contracts import TRANSFORMS, local_transform

    if name in TRANSFORMS:
        return local_transform(name, records, options), missing
    if name == "domains":
        domains = []
        for row in records:
            if row.get("measurement") == "agent_unverified":
                continue
            domain = row.get("domain") or urlsplit(row.get("url", "")).hostname
            if domain and domain not in {item["domain"] for item in domains}:
                domains.append({"domain": domain, "source": row.get("source", "SERP")})
        return domains[: options.get("limit", 10)], missing
    if name == "largest":
        measured = [row for row in records if type(row.get("traffic")) in (int, float)]
        if len(measured) < options.get("minimum", 2):
            return [], ["traffic: insufficient measured sites; no largest-site claim"]
        return sorted(measured, key=lambda row: row["traffic"], reverse=True)[
            : options.get("limit", 3)
        ], missing
    if name == "weak":
        return [row for row in records if row.get("weak") is True], (
            []
            if any("weak" in row for row in records)
            else ["weak-site classification unavailable"]
        )
    if name == "keywords":
        records += resolve(options.get("extra"), context) or []
        found = {}
        for row in records:
            if row.get("keyword"):
                found.setdefault(normalize(row["keyword"]), row)
        return list(found.values())[: options.get("limit", 100)], missing if len(
            found
        ) <= options.get("limit", 100) else [
            f"候选上限 {options.get('limit', 100)}：去重后 {len(found)}，截断 {len(found) - options.get('limit', 100)}；完整上游已保留"
        ]
    if name == "intersection":
        groups = {}
        domains = set()
        for row in records:
            if row.get("domain"):
                domains.add(row["domain"])
            if row.get("keyword"):
                groups.setdefault(normalize(row["keyword"]), []).append(row)
        return [
            items[0]
            for items in groups.values()
            if domains and {row.get("domain") for row in items} >= domains
        ], missing
    if name == "merge":
        base = resolve(options["base"], context) or []
        updates = {normalize(row.get("keyword", "")): row for row in records}
        return [
            {
                **row,
                **updates.get(normalize(row.get("keyword", "")), {}),
                "field_sources": {
                    **row.get("field_sources", {}),
                    **updates.get(normalize(row.get("keyword", "")), {}).get("field_sources", {}),
                },
                "metric_quality": {
                    **row.get("metric_quality", {}),
                    **updates.get(normalize(row.get("keyword", "")), {}).get("metric_quality", {}),
                },
            }
            for row in base
        ], missing
    if name == "unseen":
        known = {
            normalize(row.get("keyword", ""))
            for row in resolve(options.get("known"), context) or []
            if row.get("already_checked") is True
        }
        return [row for row in records if normalize(row.get("keyword", "")) not in known], missing
    if name == "gap":
        known = {
            normalize(row.get("keyword", "")) for row in resolve(options["known"], context) or []
        }
        return [row for row in records if normalize(row.get("keyword", "")) not in known], missing
    if name == "serp_join":
        if any(row.get("measurement") == "agent_unverified" for row in records):
            missing.append("unverified agent SERP withheld from local grading")
        records = [row for row in records if row.get("measurement") != "agent_unverified"]
        base = resolve(options["base"], context) or []
        ratings = {
            row.get("domain"): row for row in resolve(options.get("authority"), context) or []
        }
        queries = {}
        for row in records:
            rating = ratings.get(row.get("domain"), {})
            entry = {
                field: row[field]
                for field in ("rank", "url", "domain", "title", "page_type", "is_home")
                if field in row
            }
            if rating.get("authority") is not None:
                entry["authority"] = rating["authority"]
                entry["authority_kind"] = rating.get("authority_kind", "unspecified")
            entry["field_sources"] = {
                **row.get("field_sources", {}),
                **{
                    field: rating.get("field_sources", {}).get(
                        field, rating.get("source", "unknown")
                    )
                    for field in ("authority", "reg_date")
                    if field in rating
                },
            }
            if rating.get("reg_date"):
                entry["reg_date"] = rating["reg_date"]
            queries.setdefault(normalize(row.get("keyword", "")), []).append(entry)
        return [
            {
                **row,
                "serp_json": sorted(
                    queries.get(normalize(row.get("keyword", "")), []),
                    key=lambda item: item.get("rank", 0),
                ),
                "field_sources": {
                    **row.get("field_sources", {}),
                    "serp_json": ";".join(
                        dict.fromkeys(item.get("source", "") for item in records)
                    ),
                },
            }
            for row in base
        ], missing
    if name == "family":
        return records, missing
    raise ValueError("unknown workflow transform")


class Workflows:
    def __init__(self, registry):
        self.registry = registry

    def run(
        self,
        key,
        identity,
        object_value,
        context,
        work,
        model=None,
        progress=lambda _: None,
        checkpoint=None,
        save_checkpoint=lambda _: None,
    ):
        registry = self.registry
        flow = registry.packages.flows[identity]
        from copilot_risk import declared

        if context.get("automatic") and (
            declared(flow) != "zero"
            or flow.get("judgment") is not False
            or any(declared(step) != "zero" or step.get("model") for step in flow["steps"])
        ):
            raise ValueError("automatic workflow must be explicitly zero-cost and model-free")
        if (
            declared(flow) == "external"
            or any(declared(step) == "external" for step in flow["steps"])
        ) and context.get("secondary_confirmed") is not True:
            raise ValueError("external workflow requires secondary confirmation")
        stop = threading.Event()
        job = {"stop": stop}
        steps = []
        missing = []
        artifacts = []
        state = {"input": {"object": object_value}, "steps": {}, "item": {}}
        verdict = (
            "待判断，现有数据仅供核对"
            if context.get("language", "zh") == "zh"
            else "Judgment unavailable; review evidence"
        )
        records = []
        stopped = False
        calls = 0
        decision = None
        custom_decision = "decision_schema" in flow
        failed = False
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        # 中文注释：断点绑定工作流定义与对象；只接受宿主持有的记录，定义变化时拒绝重放。
        signature = hashlib.sha256(
            json.dumps([flow, object_value], sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        checkpoint = checkpoint if checkpoint is not None else {}
        if checkpoint and checkpoint.get("signature") != signature:
            raise ValueError("workflow changed; review a new task")
        checkpoint.setdefault("signature", signature)
        checkpoint.setdefault("steps", {})
        checkpoint.setdefault("items", {})

        def persist():
            save_checkpoint(copy.deepcopy(checkpoint))

        registry.jobs[key] = job
        try:
            persist()
            for index, step in enumerate(flow["steps"]):
                if step["id"] in checkpoint["steps"]:
                    saved = checkpoint["steps"][step["id"]]
                    output = copy.deepcopy(saved["output"])
                    state["steps"][step["id"]] = output
                    records = output.get("records", records)
                    missing += output.get("missing", [])
                    steps.append(saved["summary"])
                    artifacts.append(saved["artifact"])
                    verdict = saved.get("verdict", verdict)
                    calls += int(bool(step.get("model")))
                    progress(
                        {
                            "step_index": index + 1,
                            "completed_steps": len(steps),
                            "step": saved["summary"]["label"],
                            "phase": "restored",
                        }
                    )
                    continue
                if stop.is_set():
                    raise Stopped("stopped")
                caption = label(step.get("name", step["id"]), context.get("language", "zh"))
                started = time.monotonic()
                step_status = None
                metadata = {
                    "step_index": index + 1,
                    "step_name": caption,
                    "capability": step.get("capability", ""),
                    "step": f"{index + 1}/{len(flow['steps'])} · {caption}",
                }
                progress({**metadata, "phase": "start"})
                if "capability" in step:
                    if step["capability"] == "pool.save":
                        raise ValueError("pool writes require the explicit save action")
                    values = resolve(step.get("input", {}), state)
                    values = {key: value for key, value in values.items() if value is not None}
                    foreach = resolve(step.get("foreach"), state) if step.get("foreach") else [None]
                    output = copy.deepcopy(
                        checkpoint["items"]
                        .get(step["id"], {})
                        .get("output", {"records": [], "source": "", "missing": []})
                    )
                    completed_items = checkpoint["items"].get(step["id"], {}).get("completed", 0)
                    if not registry.candidates(step["capability"], context):
                        step_status = "skipped"
                        output["missing"] = ["跳过（未绑定 " + step["capability"] + "）"]
                        foreach = []
                    elif not foreach:
                        output["missing"] = ["no evidenced upstream objects"]
                    for item_index, item in enumerate(foreach or []):
                        if item_index < completed_items:
                            continue
                        if stop.is_set():
                            raise Stopped("stopped")
                        if item is not None:
                            state["item"] = item
                            values = {
                                key: value
                                for key, value in resolve(step.get("input", {}), state).items()
                                if value is not None
                            }
                        if step["capability"] == "keyword.judge":
                            values = copy.deepcopy(values)
                            for row in values.get("records", []):
                                for field in ("vol", "kd"):
                                    if row.get("metric_quality", {}).get(field) != "exact":
                                        row.pop(field, None)
                        if step.get("domains_from"):
                            values["domains"] = list(
                                dict.fromkeys(
                                    row["domain"]
                                    for row in resolve(step["domains_from"], state) or []
                                    if row.get("domain")
                                )
                            )
                        if step.get("words_from"):
                            source = resolve(step["words_from"], state) or []
                            values["keywords"] = list(
                                dict.fromkeys(
                                    row["keyword"] for row in source if row.get("keyword")
                                )
                            )
                        if step.get("words_from") and not values.get("keywords"):
                            output["missing"].append("no evidenced upstream keywords")
                            continue
                        try:
                            result = registry.execute(
                                step["capability"],
                                values,
                                work / step["id"],
                                stop,
                                context,
                                lambda event: progress({**metadata, **event}),
                            )
                        except Stopped:
                            raise
                        except (ValueError, OSError, KeyError, TypeError, RuntimeError):
                            if not step.get("optional"):
                                raise
                            output["missing"].append(
                                "跳过（能力不可用 " + step["capability"] + "）"
                            )
                            step_status = "skipped"
                            continue
                        for row in result.get("records", []):
                            if step["capability"] in CAPABILITIES and values.get("domain"):
                                row.setdefault("domain", values["domain"])
                        if (
                            step.get("optional")
                            and not result.get("records")
                            and values.get("records")
                        ):
                            result["records"] = values["records"]
                        if result.get("blocked") or result.get("source", "").startswith(
                            "unavailable"
                        ):
                            raise ValueError(
                                "source blocked or unavailable; login or access review required"
                            )
                        output["records"] += result.get("records", [])
                        output["source"] = ";".join(
                            dict.fromkeys([output["source"], result.get("source", "")])
                        ).strip(";")
                        output["missing"] += result.get("missing", [])
                        if "series" in result:
                            output.setdefault("series", []).extend(result["series"])
                        checkpoint["items"][step["id"]] = {
                            "completed": item_index + 1,
                            "output": copy.deepcopy(output),
                        }
                        persist()
                elif "transform" in step:
                    data = resolve(step["from"], state) or []
                    values, absent = transform(
                        step["transform"], data, step.get("options", {}), state
                    )
                    output = {"records": values, "source": "local transform", "missing": absent}
                elif step.get("model"):
                    if (
                        calls
                        or not model
                        or not (
                            resolve(step.get("from"), state) or resolve(step.get("series"), state)
                        )
                    ):
                        output = {
                            "records": resolve(step.get("from"), state) or [],
                            "source": "local",
                            "missing": ["single-turn judgment unavailable"],
                        }
                    else:
                        data = resolve(step.get("from"), state) or []
                        calls += 1
                        judgment_error = False
                        try:
                            decision = model(
                                {
                                    "object": object_value,
                                    "records": data,
                                    "series": resolve(step.get("series"), state),
                                    "experience": context.get(
                                        "adapter_experience", registry.packages.experience[:800]
                                    ),
                                },
                                stop,
                            )
                            if custom_decision:
                                registry.validate(decision, flow["decision_schema"])
                        except Stopped:
                            raise
                        except (ValueError, OSError, KeyError, TypeError, RuntimeError) as error:
                            decision = {"verdict": "判断未完成，现有数据仅供核对", "notes": []}
                            judgment_error = True
                            missing.append("判断失败：" + redact(str(error))[:280])
                        if custom_decision:
                            if judgment_error:
                                decision = None
                            verdict = (
                                str(decision.get("verdict", "判断已完成"))[:30]
                                if decision is not None
                                else "判断未完成，现有数据仅供核对"
                            )
                            output = {
                                "records": data,
                                **({"decision": decision} if decision is not None else {}),
                                "source": "single model judgment",
                                "missing": ["缺少模型判断"] if judgment_error else [],
                            }
                        else:
                            known = {
                                normalize(
                                    row.get("keyword") or row.get("url") or row.get("domain") or ""
                                )
                                for row in data
                            }
                            known.update(
                                normalize(item["keyword"])
                                for item in resolve(step.get("series"), state) or []
                            )
                            annotations = {
                                normalize(item["key"]): item for item in decision.get("notes", [])
                            }
                            if set(annotations) - known:
                                decision = {"verdict": "判断未完成，现有数据仅供核对", "notes": []}
                                annotations = {}
                                judgment_error = True
                            verdict = decision["verdict"]
                            output = {
                                "records": [],
                                "source": "single model judgment",
                                "missing": ["缺少模型判断"] if judgment_error else [],
                            }
                            for row in data:
                                note = annotations.get(
                                    normalize(
                                        row.get("keyword")
                                        or row.get("url")
                                        or row.get("domain")
                                        or ""
                                    ),
                                    {},
                                )
                                added = {
                                    field: note[field]
                                    for field in ("intent_tool", "excluded", "reason", "group")
                                    if field in note
                                    and (
                                        field not in {"intent_tool", "excluded"}
                                        or row.get(field) is None
                                    )
                                }
                                output["records"].append(
                                    {
                                        **row,
                                        **added,
                                        "field_sources": {
                                            **row.get("field_sources", {}),
                                            **{field: "single model judgment" for field in added},
                                        },
                                    }
                                )
                            if step.get("series"):
                                from datetime import datetime

                                series = resolve(step["series"], state) or []
                                peaks = []
                                for item in series:
                                    if item.get("points"):
                                        point = max(
                                            item["points"], key=lambda point: point["value"]
                                        )
                                        try:
                                            month = int(point["date"].split("-")[1])
                                            today = date.today()
                                            target = date(
                                                today.year + (month < today.month), month, 1
                                            )
                                            peaks.append(
                                                f"{item['keyword']} · {item['region']} · peak month {month} · about {max(0, (target - today).days + 6) // 7} weeks; historical signal only"
                                            )
                                        except (ValueError, IndexError):
                                            continue
                                output["missing"] += [] if peaks else ["no verified peak months"]
                                output["seasonal_notes"] = peaks
                                if not data:
                                    for keyword in dict.fromkeys(
                                        item["keyword"] for item in series if item.get("points")
                                    ):
                                        notes = [
                                            note
                                            for note in peaks
                                            if note.startswith(keyword + " · ")
                                        ]
                                        output["records"].append(
                                            {
                                                "keyword": keyword,
                                                "reason": "; ".join(notes)[:500],
                                                "source": "observed trend chart tables",
                                                "trend_source": "US/world · 12m/5y; historical signals only",
                                            }
                                        )
                else:
                    raise ValueError("invalid workflow step")
                registry.write(
                    work / (step["id"] + ".json"), json.dumps(output, ensure_ascii=False)
                )
                artifacts.append({"label": caption, "path": str(work / (step["id"] + ".json"))})
                state["steps"][step["id"]] = output
                missing += output.get("missing", [])
                records = output.get("records", records)
                steps.append(
                    {
                        "label": caption,
                        "status": step_status
                        or ("partial" if output.get("missing") else "completed"),
                        "source": output.get("source", ""),
                        "count": len(output.get("records", [])),
                    }
                )
                if (
                    not step_status
                    and not output.get("blocked")
                    and not (step.get("model") and output.get("missing"))
                ):
                    checkpoint["steps"][step["id"]] = {
                        "output": copy.deepcopy(output),
                        "summary": copy.deepcopy(steps[-1]),
                        "artifact": copy.deepcopy(artifacts[-1]),
                        "verdict": verdict,
                    }
                    checkpoint["items"].pop(step["id"], None)
                    persist()
                progress(
                    {
                        **metadata,
                        "phase": "done",
                        "provider": "unbound"
                        if step_status == "skipped"
                        else output.get("source") or "local",
                        "count": len(output.get("records", [])),
                        "duration_ms": (time.monotonic() - started) * 1000,
                        "completed_steps": len(steps),
                    }
                )
                if output.get("blocked"):
                    raise ValueError("source blocked; login or access review required")
        except Stopped:
            stopped = True
            missing.append("stopped; completed steps retained")
        except (ValueError, OSError, KeyError, TypeError, RuntimeError) as error:
            stopped = stop.is_set()
            failed = True
            missing.append(
                "workflow stopped: " + redact(str(error))[:250] + "; completed steps retained"
            )
        finally:
            registry.jobs.pop(key, None)
        target = (
            resolve(flow.get("result", ""), state)
            if isinstance(flow.get("result", ""), str)
            else None
        )
        if isinstance(target, list):
            records = target
        judgment_ready = (
            not failed
            and not stopped
            and all(
                step.get("optional") or step["id"] in checkpoint["steps"] for step in flow["steps"]
            )
        )
        if judgment_ready and checkpoint.get("judgment"):
            verdict = checkpoint["judgment"]["verdict"]
            decision = checkpoint["judgment"].get("decision")
            calls += 1
        if records and model and not calls and judgment_ready and flow.get("judgment") is not False:
            calls += 1
            try:
                decision = model(
                    {
                        "object": object_value,
                        "records": records,
                        "series": [],
                        "experience": context.get(
                            "adapter_experience", registry.packages.experience[:800]
                        ),
                    },
                    stop,
                )
                if custom_decision:
                    registry.validate(decision, flow["decision_schema"])
                verdict = str(decision.get("verdict", "判断已完成"))[:30]
                checkpoint["judgment"] = {
                    "verdict": verdict,
                    **({"decision": decision} if custom_decision else {}),
                }
                persist()
            except (ValueError, OSError, KeyError, TypeError, RuntimeError) as error:
                decision = None
                missing.extend(["缺少模型判断", "判断失败：" + redact(str(error))[:280]])
                verdict = "判断未完成，现有数据仅供核对"
        if records and not calls and not stopped and flow.get("judgment") is not False:
            missing.append("缺少模型判断")
            verdict = "判断未完成，现有数据仅供核对"
        if records and flow.get("judgment") is False:
            verdict = (
                "已自动查到本机/公开证据" if context.get("automatic") else "已读取证据，无模型调用"
            )
        if not records and not stopped:
            verdict = "没有可判断的数据，请核对来源"
        completion = (
            "failed"
            if not records or any("缺少模型判断" in reason for reason in missing)
            else "partial"
            if missing
            else "completed"
        )
        preview = []
        size = 0
        for row in records[:1000]:
            size += len(json.dumps(row, ensure_ascii=False).encode())
            if size > 200000:
                break
            preview.append(row)
        if len(preview) < len(records):
            missing.append(f"结果预览截断 {len(records) - len(preview)} 行；完整步骤文件已保留")
            completion = "partial"
        result = {
            "verdict": (
                "已停止，保留已完成步骤"
                if context.get("language", "zh") == "zh"
                else "Stopped; completed steps saved"
            )
            if stopped
            else verdict[:30],
            "level": "info",
            "metrics": [
                {"label": "已保存步骤", "value": str(len(steps))},
                {"label": "记录", "value": str(len(records))},
                {"label": "判断轮次", "value": str(calls)},
            ],
            "missing": [
                {"field": "workflow", "reason": reason[:300]}
                for reason in list(dict.fromkeys(missing))[:20]
            ],
            "process": ["本机能力按优先级取数；原始数字不由模型填写"]
            + [
                note[:600]
                for output in state["steps"].values()
                for note in output.get("seasonal_notes", [])
            ][:29],
            "next": [],
            "records": preview,
            "steps": steps,
            "artifacts": artifacts,
        }
        if custom_decision:
            decision = decision or next(
                (
                    output["decision"]
                    for output in reversed(list(state["steps"].values()))
                    if "decision" in output
                ),
                None,
            )
            if decision is not None:
                result["decision"] = decision
        result["process"].append(
            "状态："
            + (
                "失败"
                if completion == "failed"
                else f"部分完成（缺 {len(result['missing'])} 项）"
                if completion == "partial"
                else "完成"
            )
        )
        registry.write(work / "result.json", json.dumps(result, ensure_ascii=False))
        return result, stopped
