"""协作配置、模板和公共契约。"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

from copilot_results import (
    decision_schema,
)

DEFAULTS = {
    "board_name": "",
    "default_agent": "hermes",
    "agent_onboarded": False,
    "inference_profile": "fast-copilot",
    "exec_profile": "fast-copilot",
    "report_dir": "reports",
    "pool_command": [],
    "max_parallel": 3,
    "enabled": False,
    "inference_model": "",
    "context_limit": 6000,
    "min_interval": 5,
    "idle_pause_seconds": 180,
    "idle_close_seconds": 1800,
    "max_turns": 30,
    "exec_model": "",
    "mode": "balanced",
    "turn_multiplier": 1,
    "settings_saved": False,
    "exec_transport": "acp",
    "fetch_commands": {},
    "fetch_dir": "",
    "table_export_dir": str(Path.home() / "Downloads/fast-browser-link"),
    "table_max_pages": 50,
    "table_delay_min": 1.5,
    "table_delay_max": 3,
    "timeout_seconds": 180,
    "show_ball": True,
    "selection_popup": True,
    "page_annotations": True,
    "annotation_density": "compact",
    "auto_zero": True,
    "extension_dirs": [],
    "pool_lookup_command": [],
    "skill_roots": [],
}


SEO_ACTIONS = {
    "seo.keyword_check",
    "seo.competitor_keywords",
    "seo.longtail",
    "seo.serp_breakdown",
    "seo.save_pool",
    "seo.trends",
    "seo.ranking_sites",
    "seo.top_pages",
    "seo.domain_rating",
    "workflow.run",
    "local.lookup",
}


def private_write(path, text):
    path = Path(path)
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError("private path contains a symlink")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def canonical(value):
    if isinstance(value, str):
        value = unicodedata.normalize("NFKC", value).strip().casefold()
        return " ".join(value.split())
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value


def suggestion_id(action, params):
    raw = json.dumps([action, canonical(params)], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def validate(value, schema):
    """模板使用的 JSON Schema 子集；不支持的关键字在加载时拒绝。"""
    types = {
        "object": dict,
        "array": list,
        "string": str,
        "number": (int, float),
        "integer": int,
        "boolean": bool,
        "null": type(None),
    }
    expected = schema.get("type")
    if isinstance(expected, list):
        for candidate in expected:
            try:
                validate(value, {**schema, "type": candidate})
                return
            except ValueError:
                pass
        raise ValueError("schema union mismatch")
    if (
        expected not in types
        or not isinstance(value, types[expected])
        or (expected in {"number", "integer"} and isinstance(value, bool))
    ):
        raise ValueError("schema type mismatch")
    if expected == "number" and not math.isfinite(value):
        raise ValueError("non-finite number")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("schema enum mismatch")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if set(schema.get("required", [])) - value.keys():
            raise ValueError("missing required parameter")
        if schema.get("additionalProperties") is False and value.keys() - props.keys():
            raise ValueError("unexpected parameter")
        for key in value.keys() & props.keys():
            validate(value[key], props[key])
    if isinstance(value, list):
        if len(value) > schema.get("maxItems", 100):
            raise ValueError("too many items")
        for item in value:
            validate(item, schema["items"])
    if isinstance(value, str) and not schema.get("minLength", 0) <= len(value) <= schema.get(
        "maxLength", 12000
    ):
        raise ValueError("invalid string length")


def check_schema(schema):
    if not isinstance(schema, dict):
        raise ValueError("schema must be an object")
    if set(schema) - {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "maxItems",
        "minLength",
        "maxLength",
        "enum",
    }:
        raise ValueError("unsupported schema keyword")
    for child in schema.get("properties", {}).values():
        check_schema(child)
    if "items" in schema:
        check_schema(schema["items"])


def object_key(action, params):
    if "keyword" in params:
        return action + ":" + str(canonical(params["keyword"]))
    if "url" in params:
        parsed = urlsplit(params["url"] if "://" in params["url"] else "https://" + params["url"])
        return (
            action + ":" + (parsed.hostname or "").casefold()
            if action == "seo.competitor_keywords"
            else action + ":" + str(canonical(params["url"]))
        )
    return suggestion_id(action, params)


class Templates:
    def __init__(self, directory, packages=None):
        self.directory = Path(directory)
        self.packages = packages
        self.language = "zh"
        self.capabilities = {}
        self.disabled = {}
        self.on_error = lambda *_: None

    def optional(self, action):
        try:
            template = self.get(action)
            self.disabled.pop(action, None)
            return template
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            reason = type(error).__name__
            if self.disabled.get(action) != reason:
                self.disabled[action] = reason
                self.on_error(action, reason)
            return None

    def get(self, action):
        if action not in SEO_ACTIONS | {"general.task", "browser.open", "local.lookup"} and not (
            self.packages and action in self.packages.templates
        ):
            raise ValueError("unknown template")
        path = self.directory / (action + ".json")
        if (
            action in {"general.task", "workflow.run", "browser.open", "local.lookup"}
            and not path.exists()
        ):
            path = Path(__file__).parent / ("copilot-templates/" + action + ".json")
        if self.packages and action in self.packages.templates:
            template = copy.deepcopy(self.packages.templates[action])
        else:
            template = json.loads(path.read_text())
        if not isinstance(template, dict):
            raise ValueError("template must be an object")
        from copilot_risk import declared

        declared(template)
        if "decision_schema" not in template:
            template["decision_schema"] = (
                decision_schema(action)
                if action in SEO_ACTIONS | {"general.task", "browser.open"}
                else copy.deepcopy(template["result_schema"])
            )
        for field in ("prompt", "name"):
            if not isinstance(template.get(field), str) or not template[field].strip():
                raise ValueError("missing template " + field)
        if not isinstance(template.get("display_fields"), list):
            raise ValueError("missing display fields")
        if self.language == "en":
            template["prompt"] = template.get("prompt_en", template["prompt"])
        if self.packages:
            override = self.packages.prompts.get(action, {})
            if isinstance(override, dict) and isinstance(override.get(self.language), str):
                template["prompt"] = override[self.language]
        if template["id"] != action:
            raise ValueError("template identity mismatch")
        for name in ("params_schema", "result_schema", "decision_schema"):
            check_schema(template[name])
            if template[name].get("type") != "object":
                raise ValueError("template contract must be an object")
        if not isinstance(template.get("fetch", []), list):
            raise ValueError("invalid fetch steps")
        fallback = template.get("fetch_fallback", {})
        if not isinstance(fallback, dict) or type(fallback.get("enabled", False)) is not bool:
            raise ValueError("invalid fetch fallback")
        for step in template.get("fetch", []):
            if (
                not isinstance(step, dict)
                or not isinstance(step.get("script"), str)
                or type(step.get("timeout")) is not int
                or not 1 <= step["timeout"] <= 120
            ):
                raise ValueError("invalid fetch step")
            check_schema(step["params_schema"])
            check_schema(step["output_schema"])
        return template
