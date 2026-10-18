"""声明式主动建议；只消费现有上下文与结果，不执行流程。"""

import math
import re


def identifier(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[a-z][a-z0-9_.-]{0,79}", value))


def validate_follow(flow, flows):
    triggers = flow.get("triggers", [])
    if not isinstance(triggers, list) or len(triggers) > 20:
        raise ValueError("invalid workflow triggers")
    for clause in triggers:
        if (
            not isinstance(clause, dict)
            or not clause
            or set(clause) - {"page", "table_columns", "selection", "after", "dwell_seconds"}
        ):
            raise ValueError("invalid trigger clause")
        for key, rule in clause.items():
            if key == "dwell_seconds":
                valid = type(rule) in (int, float) and math.isfinite(rule) and 0 <= rule <= 86400
            elif key == "table_columns":
                valid = (
                    isinstance(rule, dict)
                    and set(rule) == {"all"}
                    and isinstance(rule["all"], list)
                    and 1 <= len(rule["all"]) <= 30
                    and all(isinstance(v, str) and 0 < len(v) <= 100 for v in rule["all"])
                )
            else:
                fields = {
                    "page": {"tool", "page"},
                    "selection": {"object"},
                    "after": {"flow", "status"},
                }[key]
                valid = isinstance(rule, dict) and set(rule) == fields
                if valid:
                    valid = all(identifier(v) for v in rule.values())
                if valid and key == "after":
                    valid = rule["flow"] in flows and rule["status"] == "completed"
            if not valid:
                raise ValueError("invalid trigger rule")
    links = flow.get("next", [])
    if not isinstance(links, list) or len(links) > 20:
        raise ValueError("invalid workflow next")
    for link in links:
        if (
            not isinstance(link, dict)
            or set(link) != {"flow", "when"}
            or not identifier(link["flow"])
            or link["flow"] not in flows
            or not isinstance(flows[link["flow"]], dict)
        ):
            raise ValueError("invalid next workflow")
        if flows[link["flow"]].get("object", "keyword") != flow.get("object", "keyword"):
            raise ValueError("next workflow must retain object type")
        rule = link["when"]
        if (
            not isinstance(rule, dict)
            or not {"field", "records"} <= rule.keys()
            or set(rule) - {"field", "records", "empty", "equals", "contains", "min", "max"}
            or not isinstance(rule["field"], str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,99}", rule["field"])
            or not isinstance(rule["records"], str)
            or rule["records"] not in {"any", "all"}
        ):
            raise ValueError("invalid next condition")
        operators = set(rule) - {"field", "records"}
        if not operators or (len(operators) > 1 and not operators <= {"min", "max"}):
            raise ValueError("ambiguous next condition")
        if "empty" in rule and type(rule["empty"]) is not bool:
            raise ValueError("invalid empty condition")
        for key in operators & {"min", "max"}:
            if type(rule[key]) not in (int, float) or not math.isfinite(rule[key]):
                raise ValueError("invalid numeric condition")
        if "min" in rule and "max" in rule and rule["min"] > rule["max"]:
            raise ValueError("invalid numeric interval")
        for key in operators & {"equals", "contains"}:
            value = rule[key]
            if (
                not (value is None or type(value) in (str, bool, int, float))
                or type(value) is float
                and not math.isfinite(value)
                or len(str(value)) > 1000
            ):
                raise ValueError("invalid comparison value")


def condition_matches(rule, records):
    def match(row):
        if not isinstance(row, dict) or rule["field"] not in row:
            return False
        value = row[rule["field"]]
        if "empty" in rule:
            return (value in (None, "", [], {})) == rule["empty"]
        if "equals" in rule:
            return value == rule["equals"] and type(value) is type(rule["equals"])
        if "contains" in rule:
            return isinstance(value, (str, list)) and (
                rule["contains"] in value
                if isinstance(value, list) or isinstance(rule["contains"], str)
                else False
            )
        return (
            type(value) in (int, float)
            and math.isfinite(value)
            and ("min" not in rule or value >= rule["min"])
            and ("max" not in rule or value <= rule["max"])
        )

    return bool(records) and (all if rule["records"] == "all" else any)(
        match(row) for row in records
    )


def follow_matches(packages, identity, context, selection, current, language):
    """返回对象与原因；触发不能把流程带出其声明页面。"""
    flow = packages.flows[identity]
    objects = packages.flow_objects(identity, context, selection)
    completions = context.get("follow_completed", [])
    reasons = {}
    for clause in flow.get("triggers", []):
        parts = []
        candidates = objects
        for key, rule in clause.items():
            if key == "page":
                hit = all(current.get(field) == value for field, value in rule.items())
                reason = "页面匹配" if language == "zh" else "Page matches"
            elif key == "table_columns":
                required = {v.strip().casefold() for v in rule["all"]}
                hit = any(
                    required <= {str(h).strip().casefold() for h in table.get("headers", [])}
                    for table in context.get("tables", [])
                )
                reason = ("表格含 " if language == "zh" else "Table columns: ") + ", ".join(
                    rule["all"]
                )
            elif key == "selection":
                hit = (
                    rule["object"] == flow.get("object", "keyword")
                    and bool(selection)
                    and selection in objects
                )
                spec = packages.objects.get(packages.flow_packages.get(identity), {}).get(
                    rule["object"]
                )
                if spec:
                    hit = hit and any(
                        "selection" in source and re.fullmatch(source["selection"], selection)
                        for source in spec["from"]
                    )
                candidates = [obj for obj in candidates if obj == selection] if hit else []
                hit = bool(candidates)
                reason = "选中对象匹配" if language == "zh" else "Selected object matches"
            elif key == "after":
                completed = [
                    row
                    for row in completions
                    if row["flow"] == rule["flow"] and row["status"] == rule["status"]
                ]
                candidates = [
                    obj for obj in candidates if any(row["object"] == obj for row in completed)
                ]
                hit = bool(candidates)
                reason = ("流程已完成：" if language == "zh" else "Completed: ") + rule["flow"]
            else:
                hit = context.get("dwell_seconds", 0) >= rule
                reason = f"停留 {rule} 秒" if language == "zh" else f"Dwell {rule}s"
            if not hit:
                break
            parts.append(reason)
        else:
            for obj in candidates:
                reasons.setdefault(obj, " · ".join(parts))
    for row in completions:
        source = packages.flows.get(row["flow"], {})
        for link in source.get("next", []):
            if (
                link["flow"] == identity
                and row["status"] == "completed"
                and source.get("object", "keyword") == flow.get("object", "keyword")
                and condition_matches(link["when"], row.get("records", []))
            ):
                reasons.setdefault(
                    row["object"],
                    ("接续流程：" if language == "zh" else "Next after: ") + row["flow"],
                )
    if "triggers" not in flow:
        for obj in objects[:1]:
            reasons.setdefault(obj, "")
    return reasons


def limit_pending(rows, limit=10):
    """保留执行与结果状态，建议总数统一有界。"""
    kept = {}
    pending = 0
    for key, row in rows.items():
        if row["status"] == "pending" and not row.get("explicit"):
            if pending >= limit:
                continue
            pending += 1
        kept[key] = row
    return kept
