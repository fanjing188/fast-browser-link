"""功能包的数据合同与对象提取；只处理声明和已取得的数据。"""

import copy
import json
import re
from urllib.parse import parse_qs, urlsplit

BUILTIN_OBJECTS = {"keyword", "domain", "url"}
FIELD = r"[a-z][a-z0-9_]{0,63}"
DATA_FIELD = r"[A-Za-z_][A-Za-z0-9_.-]{0,99}"
TRANSFORMS = {"filter", "dedupe", "sort", "top", "pick"}


def localized(value, limit):
    if (
        not isinstance(value, dict)
        or set(value) != {"zh", "en"}
        or any(
            not isinstance(text, str) or not text.strip() or len(text) > limit
            for text in value.values()
        )
    ):
        raise ValueError("invalid localized package text")


def bounded_schema(schema):
    from copilot_contracts import check_schema

    if len(json.dumps(schema).encode()) > 32768:
        raise ValueError("package schema too large")

    def check(node, depth=0):
        if not isinstance(node, dict):
            raise ValueError("package schema must be an object")
        if depth > 8:
            raise ValueError("package schema too deep")
        kinds = node.get("type")
        kinds = kinds if isinstance(kinds, list) else [kinds]
        if (
            not kinds
            or any(not isinstance(kind, str) for kind in kinds)
            or set(kinds)
            - {
                "object",
                "array",
                "string",
                "number",
                "integer",
                "boolean",
                "null",
            }
        ):
            raise ValueError("invalid package schema type")
        if "object" in kinds:
            props = node.get("properties", {})
            if (
                not isinstance(props, dict)
                or len(props) > 100
                or any(not re.fullmatch(DATA_FIELD, key) for key in props)
            ):
                raise ValueError("invalid package schema fields")
            if (
                not isinstance(node.get("required", []), list)
                or any(not isinstance(key, str) for key in node.get("required", []))
                or set(node.get("required", [])) - props.keys()
            ):
                raise ValueError("invalid required fields")
            for child in props.values():
                check(child, depth + 1)
        if "additionalProperties" in node and type(node["additionalProperties"]) is not bool:
            raise ValueError("invalid additional properties contract")
        for key, maximum in (("maxLength", 12000), ("maxItems", 5000), ("minLength", 12000)):
            if key in node and (type(node[key]) is not int or not 0 <= node[key] <= maximum):
                raise ValueError("invalid package schema bound")
        if "array" in kinds:
            check(node.get("items", {}), depth + 1)

    check(schema)
    check_schema(schema)
    if schema.get("type") != "object":
        raise ValueError("package contract must be an object")


def declarations(value):
    scene = value.get("scene", {"id": value["id"]})
    if (
        not isinstance(scene, dict)
        or set(scene) - {"id", "name"}
        or not isinstance(scene.get("id"), str)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", scene["id"])
    ):
        raise ValueError("invalid package scene")
    if "scene" in value:
        localized(scene.get("name"), 100)
    objects = value.get("objects", {})
    if not isinstance(objects, dict) or len(objects) > 30:
        raise ValueError("invalid package objects")
    for identity, spec in objects.items():
        if (
            not re.fullmatch(FIELD, identity)
            or identity in BUILTIN_OBJECTS
            or not isinstance(spec, dict)
            or set(spec) != {"name", "from"}
        ):
            raise ValueError("invalid package object")
        localized(spec["name"], 100)
        if not isinstance(spec["from"], list) or not 1 <= len(spec["from"]) <= 10:
            raise ValueError("invalid object sources")
        for source in spec["from"]:
            if not isinstance(source, dict) or len(source) != 1:
                raise ValueError("invalid object source")
            kind, rule = next(iter(source.items()))
            if kind == "column":
                if (
                    not isinstance(rule, list)
                    or not 1 <= len(rule) <= 20
                    or any(
                        not isinstance(alias, str) or not 1 <= len(alias) <= 100 for alias in rule
                    )
                ):
                    raise ValueError("invalid object column")
            elif kind in {"url_param", "selection"}:
                if not isinstance(rule, str) or not 1 <= len(rule) <= 200:
                    raise ValueError("invalid object rule")
                if kind == "selection":
                    re.compile(rule)
            else:
                raise ValueError("unknown object source")
    return copy.deepcopy(scene), copy.deepcopy(objects)


def extracted(spec, context, selection):
    values = (
        [selection]
        if selection
        and any(
            "selection" in source and re.fullmatch(source["selection"], selection)
            for source in spec["from"]
        )
        else []
    )
    for source in spec["from"]:
        if "url_param" in source:
            values += parse_qs(urlsplit(context.get("url", "")).query).get(source["url_param"], [])
        if "column" in source:
            aliases = {alias.strip().casefold() for alias in source["column"]}
            for table in context.get("tables", []):
                indices = [
                    i
                    for i, header in enumerate(table.get("headers", []))
                    if str(header).strip().casefold() in aliases
                ]
                samples = table.get("samples", table.get("rows", []))
                for row in samples if isinstance(samples, list) else []:
                    for index in indices:
                        if index < len(row):
                            cell = row[index]
                            values.append(cell.get("text", "") if isinstance(cell, dict) else cell)
    return list(
        dict.fromkeys(
            value.strip()
            for value in values
            if isinstance(value, str) and 0 < len(value.strip()) <= 2000
        )
    )[:100]


def record_schema(flow, schemas):
    """按最终步骤推导表格合同，旧流程的字符串 result 引用继续有效。"""
    steps = {step["id"]: step for step in flow["steps"]}
    target = flow.get("result")
    last = (
        target.split(".")[1]
        if isinstance(target, str) and target.startswith("$steps.")
        else flow["steps"][-1]["id"]
    )

    def schema_for(identity, seen):
        if identity in seen or identity not in steps:
            return None
        step = steps[identity]
        if step.get("capability"):
            return copy.deepcopy(
                schemas.get(step["capability"], {})
                .get("output", {})
                .get("properties", {})
                .get("records", {})
                .get("items")
            )
        source = step.get("from", "")
        schema = (
            schema_for(source.split(".")[1], seen | {identity})
            if isinstance(source, str) and source.startswith("$steps.")
            else None
        )
        if schema and step.get("transform") == "pick":
            fields = step.get("options", {}).get("fields", [])
            fields = {field: field for field in fields} if isinstance(fields, list) else fields
            props = schema.get("properties", {})
            schema = {
                "type": "object",
                "properties": {
                    alias: props[field] for field, alias in fields.items() if field in props
                },
                "required": [],
                "additionalProperties": False,
            }
        return schema

    return schema_for(last, set())


def validate_flow(flow, objects, schemas):
    validate_recommendation(flow.get("recommendation"))
    if flow.get("object", "keyword") not in BUILTIN_OBJECTS | objects.keys():
        raise ValueError("unknown workflow object")
    for name, limit in (("description", 500), ("when", 500)):
        if name in flow:
            if name == "description" and isinstance(flow[name], str):
                if not flow[name].strip() or len(flow[name]) > limit:
                    raise ValueError("invalid workflow description")
            else:
                localized(flow[name], limit)
    if "decision_schema" in flow:
        bounded_schema(flow["decision_schema"])
    result = flow.get("result")
    if isinstance(result, dict):
        if (
            set(result) - {"columns", "primary"}
            or not isinstance(result.get("columns"), list)
            or not 1 <= len(result["columns"]) <= 100
        ):
            raise ValueError("invalid workflow result")
        fields = (record_schema(flow, schemas) or {}).get("properties", {})
        seen = set()
        for column in result["columns"]:
            if (
                not isinstance(column, dict)
                or set(column) != {"field", "label"}
                or column.get("field") not in fields
                or column["field"] in seen
            ):
                raise ValueError("invalid workflow result column")
            localized(column["label"], 100)
            seen.add(column["field"])
        if result.get("primary") not in seen:
            raise ValueError("invalid workflow result primary")
    elif result is not None and not isinstance(result, str):
        raise ValueError("invalid workflow result")
    for step in flow["steps"]:
        if step.get("transform") in TRANSFORMS:
            validate_transform(step["transform"], step.get("options", {}))
            if step.get("risk", "zero") != "zero":
                raise ValueError("local transforms have zero risk")
            step["risk"] = "zero"


def validate_transform(name, options):
    allowed = {
        "filter": {"field", "equals", "contains", "min", "max"},
        "dedupe": {"field"},
        "sort": {"field", "direction"},
        "top": {"n"},
        "pick": {"fields"},
    }
    if not isinstance(options, dict) or set(options) - allowed[name]:
        raise ValueError("invalid local transform options")
    if name in {"filter", "dedupe", "sort"} and (
        not isinstance(options.get("field"), str) or not re.fullmatch(DATA_FIELD, options["field"])
    ):
        raise ValueError("invalid transform field")
    if name == "filter":
        if (
            len(options) < 2
            or ("contains" in options and not isinstance(options["contains"], str))
            or any(
                type(options[key]) not in (int, float) for key in ("min", "max") if key in options
            )
        ):
            raise ValueError("invalid filter predicate")
    if name == "sort" and options.get("direction", "asc") not in {"asc", "desc"}:
        raise ValueError("invalid sort direction")
    if name == "top" and (type(options.get("n")) is not int or not 0 <= options["n"] <= 5000):
        raise ValueError("invalid top count")
    if name == "pick":
        fields = options.get("fields")
        if (
            not isinstance(fields, (list, dict))
            or not 1 <= len(fields) <= 100
            or any(
                not isinstance(field, str) or not re.fullmatch(DATA_FIELD, field)
                for field in (
                    list(fields) + list(fields.values()) if isinstance(fields, dict) else fields
                )
            )
            or isinstance(fields, dict)
            and len(set(fields.values())) != len(fields)
        ):
            raise ValueError("invalid pick fields")


def local_transform(name, records, options):
    validate_transform(name, options)
    field = options.get("field")
    if name == "filter":

        def matches(row):
            if field not in row or row[field] is None:
                return False
            value = row[field]
            return (
                (
                    "equals" not in options
                    or type(value) is type(options["equals"])
                    and value == options["equals"]
                )
                and (
                    "contains" not in options
                    or isinstance(value, (str, list))
                    and options["contains"] in value
                )
                and all(
                    type(value) in (int, float)
                    and (value >= options[key] if key == "min" else value <= options[key])
                    for key in ("min", "max")
                    if key in options
                )
            )

        return [row for row in records if matches(row)]
    if name == "dedupe":
        seen = set()
        result = []
        for row in records:
            key = (
                json.dumps(row[field], sort_keys=True, ensure_ascii=False) if field in row else None
            )
            if key is None or key not in seen:
                result.append(row)
            seen.add(key)
        return result
    if name == "sort":
        present = [row for row in records if row.get(field) is not None]

        def key(row):
            value = row[field]
            return (0, value) if type(value) in (int, float) else (1, str(value))

        return sorted(present, key=key, reverse=options.get("direction") == "desc") + [
            row for row in records if row.get(field) is None
        ]
    if name == "top":
        return records[: options["n"]]
    fields = options["fields"]
    fields = {field: field for field in fields} if isinstance(fields, list) else fields
    return [
        {alias: row[field] for field, alias in fields.items() if field in row} for row in records
    ]


RECOMMENDATION_KINDS = {
    "page",
    "text_selection",
    "table",
    "record_set",
    "page_set",
    "artifact",
    "business_object",
}
RECOMMENDATION_INTENTS = {
    "summarize",
    "compare",
    "extract",
    "clean",
    "analyze",
    "learn",
    "verify",
    "execute",
    "organize",
}


def validate_recommendation(value):
    if value is None:
        return
    if not isinstance(value, dict) or set(value) - {
        "recommendation_contract",
        "task_type",
        "intent",
        "scope",
        "subject_kinds",
        "min_subjects",
        "max_subjects",
        "required_fields",
        "output_kind",
        "completion",
        "equivalence",
    }:
        raise ValueError("invalid recommendation declaration")
    if (
        type(value.get("recommendation_contract")) is not int
        or value["recommendation_contract"] != 1
    ):
        raise ValueError("unsupported recommendation contract")
    for key in ("task_type", "output_kind", "equivalence"):
        if key in value and (
            not isinstance(value[key], str)
            or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,79}", value[key])
        ):
            raise ValueError("invalid recommendation identity")
    if not isinstance(value.get("scope", "page"), str) or value.get("scope", "page") not in {
        "page",
        "general",
    }:
        raise ValueError("invalid recommendation scope")
    for key, choices in (
        ("subject_kinds", RECOMMENDATION_KINDS),
        ("intent", RECOMMENDATION_INTENTS),
    ):
        if key in value and (
            not isinstance(value[key], list)
            or not value[key]
            or len(value[key]) > len(choices)
            or any(not isinstance(v, str) or v not in choices for v in value[key])
            or len(set(value[key])) != len(value[key])
        ):
            raise ValueError("invalid recommendation kinds")
    if value.get("scope") == "general" and not value.get("subject_kinds"):
        raise ValueError("general recommendation requires explicit subjects")
    low, high = value.get("min_subjects", 1), value.get("max_subjects", 1)
    if type(low) is not int or type(high) is not int or not 1 <= low <= high <= 30:
        raise ValueError("invalid recommendation subject count")
    fields = value.get("required_fields", [])
    if (
        not isinstance(fields, list)
        or len(fields) > 100
        or any(not isinstance(v, str) or not re.fullmatch(DATA_FIELD, v) for v in fields)
        or len(set(fields)) != len(fields)
    ):
        raise ValueError("invalid recommendation required fields")
    if "completion" in value:
        localized(value["completion"], 500)
