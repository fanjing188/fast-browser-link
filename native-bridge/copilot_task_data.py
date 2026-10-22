"""有界本地表格处理；模型不参与算术、主键比较或文件生成。"""

import copy
import csv
import io
import json
import math
import re
from collections import Counter
from datetime import datetime
from html import escape

from copilot_tables import number

MAX_BYTES = 8 * 1024 * 1024
LOCAL_TASKS = {
    "table.clean",
    "table.filter",
    "table.stats",
    "table.pivot",
    "table.compare",
    "table.merge",
    "table.join",
}
STAT_FIELDS = ["aggregate", "count", "share", "missing"]


def encoded(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, OverflowError, RecursionError) as error:
        raise ValueError("数据必须为有限的JSON值") from error


def parse_table(value):
    if len(encoded(value).encode()) > MAX_BYTES:
        raise ValueError("表格数据超过8MiB，请缩小范围")
    if isinstance(value, str):
        if len(value.encode()) > 200000:
            raise ValueError("表格文本超过200KiB，请缩小范围")
        source = value.lstrip("\ufeff")
        try:
            dialect = csv.Sniffer().sniff(source[:8192], delimiters=",\t")
        except csv.Error:
            dialect = csv.excel
        try:
            rows = list(csv.reader(io.StringIO(source, newline=""), dialect, strict=True))
        except csv.Error as error:
            raise ValueError("CSV/TSV格式无效，请检查引号和分隔符") from error
        if not rows:
            raise ValueError("表格为空")
        headers, records = rows[0], rows[1:]
    elif isinstance(value, dict):
        headers = value.get("headers", value.get("columns", []))
        records = value.get("records", value.get("rows", []))
    else:
        raise ValueError("需要CSV、TSV或表格数据")
    if (
        not isinstance(headers, list)
        or not 1 <= len(headers) <= 100
        or any(not isinstance(h, str) or not h.strip() or len(h) > 100 for h in headers)
        or len({h.strip() for h in headers}) != len(headers)
    ):
        raise ValueError("表头须非空、唯一，最多100列")
    if not isinstance(records, list) or len(records) > 5000:
        raise ValueError("表格记录无效或超过5000行")
    normalized = []
    for row in records:
        if isinstance(row, list):
            if len(row) != len(headers):
                raise ValueError("列数不一致，请检查分隔符和表头")
            if any(isinstance(cell, dict) and "text" not in cell for cell in row):
                raise ValueError("表格单元格对象缺少text字段")
            row = dict(
                zip(headers, [cell["text"] if isinstance(cell, dict) else cell for cell in row])
            )
        if not isinstance(row, dict) or row.keys() - set(headers):
            raise ValueError("表格记录字段与表头不一致")
        for cell in row.values():
            if cell is not None and type(cell) not in {str, int, float, bool}:
                raise ValueError("单元格仅支持文本、数字、布尔值和空值")
            if (
                isinstance(cell, str)
                and len(cell) > 12000
                or type(cell) in {int, float}
                and numeric(cell) is None
            ):
                raise ValueError("单元格超出限制")
        normalized.append({h: row.get(h) for h in headers})
    return {"headers": list(headers), "records": normalized}


def numeric(value):
    if type(value) in {int, float}:
        try:
            return float(value) if math.isfinite(value) else None
        except (ValueError, OverflowError):
            return None
    if not isinstance(value, str):
        return None
    result = number(value)
    if result is None and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+", value.strip()):
        result = float(value)
    return result if result is None or math.isfinite(result) else None


def field(headers, name):
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 100
        or headers is not None
        and name not in headers
    ):
        raise ValueError("请先选择有效字段：" + str(name))
    return name


def fields(headers, names, required=False):
    if not isinstance(names, list) or len(names) > 100 or required and not names:
        raise ValueError("字段须为列表且不能为空")
    for name in names:
        field(headers, name)
    if len(set(names)) != len(names):
        raise ValueError("字段不能重复")
    return names


def empty(value):
    return value is None or value == ""


def key_for(row, keys):
    # 中文注释：JSON编码保留字符串、布尔和数值差异，避免Python把False与0分成同组。
    return encoded([row.get(key) for key in keys])


def validate_options(task, headers, options, partial=False):
    allowed = {
        "table.clean": {
            "trim",
            "numeric_fields",
            "date_fields",
            "date_format",
            "unit_multipliers",
            "split",
            "combine",
            "dedupe",
            "keys",
        },
        "table.filter": {"filters", "sort", "descending", "fields"},
        "table.stats": {"group_by", "value", "aggregate"},
        "table.pivot": {"group_by", "value", "aggregate", "pivot"},
        "table.compare": {"keys", "include_unchanged"},
        "table.merge": set(),
        "table.join": {"keys", "join"},
    }
    if task not in allowed or not isinstance(options, dict) or options.keys() - allowed[task]:
        raise ValueError("任务选项无效或包含未知字段")
    if len(encoded(options).encode()) > 8000:
        raise ValueError("任务选项超过8KiB")
    for name in {"trim", "dedupe", "descending", "include_unchanged"} & options.keys():
        if type(options[name]) is not bool:
            raise ValueError(name + "必须是布尔值")
    for name in {"keys", "fields", "numeric_fields", "date_fields", "group_by"} & options.keys():
        fields(headers, options[name], name in {"keys", "fields"})
    for name in {"sort", "value", "pivot"} & options.keys():
        field(headers, options[name])
    if task in {"table.compare", "table.join"} and not options.get("keys") and not partial:
        raise ValueError("请先选择主键")
    if task == "table.join" and (
        not isinstance(options.get("join", "left"), str)
        or options.get("join", "left") not in {"left", "inner", "outer"}
    ):
        raise ValueError("不支持的关联方式")
    if task in {"table.stats", "table.pivot"}:
        operation = options.get("aggregate", "count")
        if not isinstance(operation, str) or operation not in {
            "count",
            "sum",
            "mean",
            "min",
            "max",
        }:
            raise ValueError("不支持的统计方式")
        if operation != "count" and (not partial or "value" in options):
            field(headers, options.get("value"))
        groups = options.get("group_by", [])
        pivot = (
            field(headers, options.get("pivot"))
            if task == "table.pivot" and (not partial or "pivot" in options)
            else None
        )
        if pivot in groups or set(groups + ([pivot] if pivot else [])) & set(STAT_FIELDS):
            raise ValueError("分组和交叉字段须互不重复且不能使用统计保留字段")
    if task == "table.filter":
        rules = options.get("filters", [])
        if not isinstance(rules, list) or len(rules) > 30:
            raise ValueError("筛选条件最多30项")
        for rule in rules:
            if not isinstance(rule, dict) or rule.keys() - {"field", "op", "value"}:
                raise ValueError("筛选条件无效")
            field(headers, rule.get("field"))
            op = rule.get("op", "equals")
            if not isinstance(op, str) or op not in {
                "empty",
                "not_empty",
                "equals",
                "contains",
                "gt",
                "gte",
                "lt",
                "lte",
            }:
                raise ValueError("不支持的筛选条件")
            if op not in {"empty", "not_empty"} and "value" not in rule:
                raise ValueError("筛选条件缺少比较值")
            value = rule.get("value")
            if op == "contains" and not isinstance(value, str):
                raise ValueError("包含筛选需要文本比较值")
            if value is not None and type(value) not in {str, bool, int, float}:
                raise ValueError("筛选值必须为单元格值")
            if op in {"gt", "gte", "lt", "lte"} and numeric(value) is None:
                raise ValueError("大小比较需要有效数值")
    if task == "table.clean":
        clean_columns(headers, options)
    return options


def clean_columns(original, options):
    headers = list(original or [])
    multipliers = options.get("unit_multipliers", {})
    splits, combines = options.get("split", []), options.get("combine", {})
    if (
        not isinstance(multipliers, dict)
        or not isinstance(splits, list)
        or not isinstance(combines, dict)
    ):
        raise ValueError("单位、拆列或合列配置无效")
    for name, multiplier in multipliers.items():
        field(original, name)
        if type(multiplier) not in {int, float} or numeric(multiplier) is None:
            raise ValueError("单位倍率必须为有限数字")
    for spec in splits:
        if not isinstance(spec, dict) or spec.keys() - {"field", "separator", "into"}:
            raise ValueError("拆列配置无效")
        field(original, spec.get("field"))
        names = spec.get("into")
        if not isinstance(names, list) or not names:
            raise ValueError("拆列需要目标字段")
        headers.extend(names)
        separator = spec.get("separator", ",")
        if not isinstance(separator, str) or not separator:
            raise ValueError("拆列分隔符不能为空")
    for name, spec in combines.items():
        if not isinstance(spec, dict) or spec.keys() - {"separator", "fields"}:
            raise ValueError("合列配置无效")
        fields(original, spec.get("fields"), True)
        if not isinstance(spec.get("separator", " "), str):
            raise ValueError("合列分隔符必须为文本")
        headers.append(name)
    if headers:
        parse_table({"headers": headers, "records": []})
    date_format = options.get("date_format", "%Y-%m-%d")
    if not isinstance(date_format, str) or not 1 <= len(date_format) <= 100:
        raise ValueError("日期格式无效")
    return headers, multipliers, date_format


def clean(table, options):
    original = table["headers"]
    headers, rows, changes = list(original), copy.deepcopy(table["records"]), Counter()
    validate_options("table.clean", headers, options)
    headers, multipliers, date_format = clean_columns(original, options)
    for row in rows:
        for key in original:
            value = row.get(key)
            if isinstance(value, str) and options.get("trim", True):
                row[key] = value.strip()
                changes["trimmed"] += row[key] != value
            changes["empty_cells"] += empty(row.get(key))
        for key in options.get("numeric_fields", []):
            value = numeric(row.get(key))
            if value is not None:
                row[key] = value
            elif not empty(row.get(key)):
                changes["unparsed_numbers"] += 1
        for key in options.get("date_fields", []):
            if not empty(row.get(key)):
                try:
                    row[key] = datetime.strptime(str(row[key]), date_format).date().isoformat()
                except ValueError:
                    changes["unparsed_dates"] += 1
        for key, multiplier in multipliers.items():
            value = numeric(row.get(key))
            if value is not None:
                row[key] = value * multiplier
                if numeric(row[key]) is None:
                    raise ValueError("单位换算结果超出有限数值范围")
            elif not empty(row.get(key)):
                changes["unparsed_units"] += 1
        for spec in options.get("split", []):
            value = row.get(spec["field"])
            parts = (
                str(value).split(spec.get("separator", ","), len(spec["into"]) - 1)
                if value is not None
                else []
            )
            row.update(
                {name: parts[i] if i < len(parts) else None for i, name in enumerate(spec["into"])}
            )
        for name, spec in options.get("combine", {}).items():
            row[name] = spec.get("separator", " ").join(
                "" if row.get(key) is None else str(row[key]) for key in spec["fields"]
            )
    if options.get("dedupe", True):
        seen, unique = set(), []
        keys = options.get("keys", original)
        for row in rows:
            key = key_for(row, keys)
            # 中文注释：指定主键的空值不能被当成同一条记录；整行去重则可比较完整行。
            if options.get("keys") and any(empty(row.get(k)) for k in keys) or key not in seen:
                unique.append(row)
                seen.add(key)
            else:
                changes["duplicates_removed"] += 1
        rows = unique
    checked = parse_table({"headers": headers, "records": rows})
    return checked["headers"], checked["records"], dict(changes)


def matches(row, rule, headers):
    value = row.get(field(headers, rule["field"]))
    op, expected = rule.get("op", "equals"), rule.get("value")
    if op == "empty":
        return empty(value)
    if op == "not_empty":
        return not empty(value)
    if op == "equals":
        return type(value) is type(expected) and value == expected
    if op == "contains":
        return value is not None and str(expected).casefold() in str(value).casefold()
    left, right = numeric(value), numeric(expected)
    if left is None or right is None:
        return False
    return {"gt": left > right, "gte": left >= right, "lt": left < right, "lte": left <= right}[op]


def indexed(table, keys):
    fields(table["headers"], keys, True)
    index = {}
    for row in table["records"]:
        if any(
            empty(row.get(key)) or isinstance(row.get(key), str) and not row[key].strip()
            for key in keys
        ):
            raise ValueError("主键存在空值，请先整理或选择其他主键")
        key = key_for(row, keys)
        if key in index:
            raise ValueError("主键不唯一，请先处理重复记录")
        index[key] = row
    return index


def statistics(table, options, pivot):
    groups = [*options.get("group_by", []), *([options["pivot"]] if pivot else [])]
    metric, operation = options.get("value"), options.get("aggregate", "count")
    buckets = {}
    for row in table["records"]:
        buckets.setdefault(key_for(row, groups), []).append(row)
    if not groups and not buckets:
        buckets["[]"] = []
    rows, total = [], len(table["records"])
    for bucket in buckets.values():
        values = (
            [v for row in bucket if (v := numeric(row.get(metric))) is not None] if metric else []
        )
        result = len(bucket) if operation == "count" else None
        if values and operation != "count":
            try:
                result = {
                    "sum": math.fsum,
                    "mean": lambda v: math.fsum(x / len(v) for x in v),
                    "min": min,
                    "max": max,
                }[operation](values)
            except OverflowError as error:
                raise ValueError("统计结果超出有限数值范围") from error
        rows.append(
            {
                **{key: bucket[0].get(key) for key in groups},
                "aggregate": result,
                "count": len(bucket),
                "share": len(bucket) / total if total else None,
                "missing": len(bucket) - len(values) if metric else 0,
            }
        )
    return (
        [*groups, *STAT_FIELDS],
        rows,
        {
            "layout": "long",
            "aggregate": operation,
            "value": metric,
            "missing_policy": "excluded",
            "share_basis": "row_count",
        },
    )


def process(task, tables, options):
    if task not in LOCAL_TASKS or not isinstance(tables, list) or not 1 <= len(tables) <= 10:
        raise ValueError("本地表格任务及材料数量无效")
    if task not in {"table.merge", "table.compare", "table.join"} and len(tables) != 1:
        raise ValueError("此任务需要恰好一张表")
    if (
        task in {"table.compare", "table.join"}
        and len(tables) != 2
        or task == "table.merge"
        and len(tables) < 2
    ):
        raise ValueError("比较或关联需要两张表，追加需要至少两张表")
    tables = [parse_table(table) for table in tables]
    table = tables[0]
    headers, rows, details = table["headers"], table["records"], {}
    if task == "table.clean":
        return clean(table, options)
    validate_options(task, headers, options)
    if task == "table.filter":
        rows = [
            row
            for row in rows
            if all(matches(row, rule, headers) for rule in options.get("filters", []))
        ]
        if options.get("sort"):
            key = options["sort"]
            known = [r for r in rows if not empty(r.get(key))]
            unknown = [r for r in rows if empty(r.get(key))]
            numeric_sort = bool(known) and all(numeric(r[key]) is not None for r in known)
            known.sort(
                key=lambda r: numeric(r[key]) if numeric_sort else str(r[key]).casefold(),
                reverse=options.get("descending", False),
            )
            rows = known + unknown
            details["sort_mode"] = "numeric" if numeric_sort else "text"
        if options.get("fields"):
            headers = options["fields"]
            rows = [{key: row.get(key) for key in headers} for row in rows]
    elif task in {"table.stats", "table.pivot"}:
        headers, rows, details = statistics(table, options, task == "table.pivot")
    elif task == "table.merge":
        headers = list(dict.fromkeys(key for t in tables for key in t["headers"]))
        rows = [{key: row.get(key) for key in headers} for t in tables for row in t["records"]]
        details["sources"] = len(tables)
    else:
        keys = options["keys"]
        left, right = [indexed(t, keys) for t in tables]
        all_headers = list(dict.fromkeys(k for t in tables for k in t["headers"]))
        rows = []
        if task == "table.join":
            headers = [
                *table["headers"],
                *("right." + h for h in tables[1]["headers"] if h not in keys),
            ]
            parse_table({"headers": headers, "records": []})
        else:
            headers = ["status", "key", "fields", "before", "after"]
        for key in dict.fromkeys([*left, *right]):
            a, b = left.get(key), right.get(key)
            if task == "table.compare":
                changed = [
                    h
                    for h in all_headers
                    if a is not None
                    and b is not None
                    and (a.get(h) != b.get(h) or type(a.get(h)) is not type(b.get(h)))
                ]
                status = (
                    "added"
                    if a is None
                    else "removed"
                    if b is None
                    else "changed"
                    if changed
                    else "unchanged"
                )
                if status != "unchanged" or options.get("include_unchanged"):
                    rows.append(
                        {
                            "status": status,
                            "key": key,
                            "fields": ", ".join(changed),
                            "before": encoded(a),
                            "after": encoded(b),
                        }
                    )
            else:
                mode = options.get("join", "left")
                if mode == "left" and a is None or mode == "inner" and (a is None or b is None):
                    continue
                rows.append(
                    {
                        **(a if a is not None else {k: b[k] for k in keys}),
                        **{
                            "right." + h: b.get(h) if b is not None else None
                            for h in tables[1]["headers"]
                            if h not in keys
                        },
                    }
                )
    checked = parse_table({"headers": headers, "records": rows})
    return checked["headers"], checked["records"], details


def chart_svg(headers, rows):
    if "aggregate" not in headers or not rows:
        return None
    groups = [h for h in headers if h not in STAT_FIELDS]
    values = [
        (
            " / ".join("(missing)" if row.get(h) is None else str(row[h]) for h in groups)
            or "Total",
            numeric(row.get("aggregate")),
        )
        for row in rows[:30]
    ]
    values = [(label, value) for label, value in values if value is not None]
    if not values:
        return None
    maximum = max((abs(v) for _, v in values), default=0) or 1
    bars = []
    for i, (label, value) in enumerate(values):
        y, width = 38 + i * 28, abs(value) / maximum * 170
        x = 380 - width if value < 0 else 380
        bars.append(
            f'<text x="8" y="{y + 15}" font-size="12">{escape(label[:24])}</text><rect x="{x:.2f}" y="{y}" width="{width:.2f}" height="20" fill="#537563"/><text x="560" y="{y + 15}" font-size="12">{value:g}</text>'
        )
    height = 65 + 28 * len(values)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="{height}" viewBox="0 0 700 {height}"><title>Aggregate by group; first 30 groups</title><rect width="100%" height="100%" fill="white"/><text x="8" y="20">aggregate · first 30 groups</text><path d="M380 32V{height - 10}" stroke="#999"/>'
        + "".join(bars)
        + "</svg>"
    )


def ocr_options(options, partial=False):
    """图片表格只能使用用户明确指定的列名与归一化边界。"""
    if not isinstance(options, dict) or options.keys() - {
        "headers",
        "cuts",
        "row_tolerance",
        "min_confidence",
        "skip_rows",
    }:
        raise ValueError("图片表格选项无效")
    if len(encoded(options).encode()) > 8000:
        raise ValueError("图片表格选项超过8KiB")
    if not partial or "headers" in options:
        parse_table({"headers": options.get("headers"), "records": []})
    if not partial or "cuts" in options:
        cuts = options.get("cuts")
        if (
            not isinstance(cuts, list)
            or not 2 <= len(cuts) <= 101
            or any(
                type(c) not in {int, float} or numeric(c) is None or not 0 <= c <= 1 for c in cuts
            )
            or any(a >= b for a, b in zip(cuts, cuts[1:]))
        ):
            raise ValueError("列边界须为0至1之间严格递增的数值列表")
        if "headers" in options and len(cuts) != len(options["headers"]) + 1:
            raise ValueError("列边界数量须为列名数量加一")
    for name, default, lower, upper in (
        ("row_tolerance", 0.015, 0.0001, 0.1),
        ("min_confidence", 0.6, 0, 1),
    ):
        value = options.get(name, default)
        if type(value) not in {int, float} or numeric(value) is None or not lower <= value <= upper:
            raise ValueError(name + "超出允许范围")
    skip = options.get("skip_rows", 0)
    if type(skip) is not int or not 0 <= skip <= 1000:
        raise ValueError("跳过行数须为0至1000的整数")
    return options


def ocr_table(records, options):
    """按明确列边界重建OCR表格；保留未归属文字和所有不确定项。"""
    ocr_options(options)
    if (
        not isinstance(records, list)
        or len(records) > 1000
        or len(encoded(records).encode()) > 1024 * 1024
    ):
        raise ValueError("OCR记录超过1000行或1MiB")
    observations, text_size = [], 0
    for index, record in enumerate(records):
        if not isinstance(record, dict) or set(record) - {
            "text",
            "confidence",
            "x",
            "y",
            "width",
            "height",
        }:
            raise ValueError("OCR记录字段无效")
        text = record.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 12000:
            raise ValueError("OCR记录需要非空文字，最多12000字符")
        text_size += len(text)
        geometry = [record.get(k) for k in ("x", "y", "width", "height")]
        confidence = record.get("confidence")
        if (
            any(
                type(v) not in {int, float} or numeric(v) is None or not 0 <= v <= 1
                for v in [*geometry, confidence]
            )
            or geometry[2] <= 0
            or geometry[3] <= 0
            or geometry[0] + geometry[2] > 1.000001
            or geometry[1] + geometry[3] > 1.000001
        ):
            raise ValueError("OCR需要有限的0至1坐标、尺寸和置信度")
        observations.append(
            {**record, "index": index, "center_y": record["y"] + record["height"] / 2}
        )
    if text_size > 100000:
        raise ValueError("OCR文字超过100000字符")
    headers, cuts = list(options["headers"]), options["cuts"]
    tolerance, threshold, skip = (
        options.get("row_tolerance", 0.015),
        options.get("min_confidence", 0.6),
        options.get("skip_rows", 0),
    )
    clusters = []
    for observation in sorted(observations, key=lambda r: (r["center_y"], r["x"], r["index"])):
        # 中文注释：以首个中心点为锚，避免邻近文字串联后把两行逐步合并。
        if not clusters or observation["center_y"] - clusters[-1][0]["center_y"] > tolerance:
            clusters.append([])
        clusters[-1].append(observation)
    details = {
        "coordinate_system": "normalized_top_left",
        "source_count": len(records),
        "assigned_count": 0,
        "unassigned": [],
        "low_confidence": [],
        "multiple_observations": [],
        "skipped": [],
        "cells": [],
    }
    rows = []
    for cluster_index, cluster in enumerate(clusters):
        if cluster_index < skip:
            details["skipped"].extend({"index": r["index"], "text": r["text"]} for r in cluster)
            continue
        row_index, cells = len(rows), [[] for _ in headers]
        for observation in sorted(cluster, key=lambda r: (r["x"], r["index"])):
            left, right = observation["x"], observation["x"] + observation["width"]
            column = next(
                (
                    i
                    for i, (a, b) in enumerate(zip(cuts, cuts[1:]))
                    if left >= a - 1e-6 and right <= b + 1e-6
                ),
                None,
            )
            if column is None:
                details["unassigned"].append(
                    {
                        "index": observation["index"],
                        "row": row_index,
                        "text": observation["text"],
                        "reason": "outside_columns"
                        if left < cuts[0] - 1e-6 or right > cuts[-1] + 1e-6
                        else "crosses_columns",
                    }
                )
                continue
            cells[column].append(observation)
            details["assigned_count"] += 1
            if observation["confidence"] < threshold:
                details["low_confidence"].append(
                    {
                        "index": observation["index"],
                        "row": row_index,
                        "column": headers[column],
                        "confidence": observation["confidence"],
                        "text": observation["text"],
                    }
                )
        row = {}
        for column, cell in enumerate(cells):
            row[headers[column]] = "\n".join(r["text"] for r in cell) if cell else None
            if cell:
                refs = {
                    "row": row_index,
                    "column": headers[column],
                    "source_indices": [r["index"] for r in cell],
                }
                details["cells"].append(refs)
                if len(cell) > 1:
                    details["multiple_observations"].append(refs)
        rows.append(row)
    details["skipped_count"] = len(details["skipped"])
    details["missing_cells"] = sum(value is None for row in rows for value in row.values())
    details["requires_review"] = not rows or bool(
        details["unassigned"]
        or details["low_confidence"]
        or details["multiple_observations"]
        or details["missing_cells"]
    )
    details["structure_accuracy"] = "not_independently_verified"
    checked = parse_table({"headers": headers, "records": rows})
    return checked["headers"], checked["records"], details
