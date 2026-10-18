"""Hermes 模型清单和协作配置；发现过程不发送任何 prompt。"""

import json
from pathlib import Path
import re
import time
from copilot_acp import ACP, ACPError

MODES = {"saving", "balanced", "quality", "custom"}
SETTING_KEYS = {
    "inference_model",
    "exec_model",
    "max_parallel",
    "context_limit",
    "mode",
    "turn_multiplier",
    "exec_transport",
}


def model_id(value):
    if not isinstance(value, str) or (
        value and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}", value)
    ):
        raise ValueError("invalid model id")
    return value


def parse_models(result):
    state = result.get("models") or {}
    if not isinstance(state, dict) or not isinstance(state.get("availableModels", []), list):
        raise ValueError("invalid model state")
    current = model_id(state.get("currentModelId", ""))
    rows = []
    seen = set()
    for raw in state.get("availableModels", []):
        if not isinstance(raw, dict):
            raise ValueError("invalid model entry")
        key = model_id(raw.get("modelId", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        # 中文注释：不传递 description 等任意提供商文本，只保留选择所需字段。
        rows.append({"id": key, "label": key.replace(":", " · ", 1), "default": key == current})
    if current and current not in seen:
        rows.insert(0, {"id": current, "label": current.replace(":", " · ", 1), "default": True})
    return {"current": current, "available": rows}


def settings(values):
    if (
        not isinstance(values, dict)
        or not values
        or set(values) - SETTING_KEYS - {"daily_token_budget", "cache_weight"}
    ):
        raise ValueError("invalid settings")
    checked = {key: value for key, value in values.items() if key in SETTING_KEYS}
    for key in ("inference_model", "exec_model"):
        if key in checked:
            model_id(checked[key])
    for key, lower, upper in [
        ("max_parallel", 1, 3),
        ("context_limit", 100, 1000000),
        ("turn_multiplier", 1, 2),
    ]:
        if key in checked and (type(checked[key]) is not int or not lower <= checked[key] <= upper):
            raise ValueError("invalid " + key)
    if "mode" in checked and checked["mode"] not in MODES:
        raise ValueError("invalid mode")
    if "exec_transport" in checked and checked["exec_transport"] not in {"acp", "oneshot"}:
        raise ValueError("invalid transport")
    return checked


def catalogs(config, directory, write, *, force=False, runtime=None):
    if config.get("default_agent", "hermes") == "codex":
        return codex_catalogs(config, directory, write, force=force)
    path = Path(directory) / "models.json"
    cache = {}
    if path.is_file() and not path.is_symlink():
        try:
            cache = json.loads(path.read_text())
        except (ValueError, OSError):
            pass
    if not isinstance(cache, dict):
        cache = {}
    result = {}
    updated = {}
    now = time.time()
    for role, profile in [
        ("inference", config["inference_profile"]),
        ("execution", config["exec_profile"]),
    ]:
        if profile in updated:
            result[role] = updated[profile]
            continue
        cached = cache.get(profile, {})
        if not isinstance(cached, dict):
            cached = {}
        if (
            not force
            and isinstance(cached.get("fetched_at"), (int, float))
            and 0 <= now - cached["fetched_at"] < 86400
        ):
            entry = {**cached, "cached": True}
        else:
            probe = None
            try:
                if (
                    not force
                    and role == "inference"
                    and runtime
                    and not runtime.closed
                    and runtime.model_state is not None
                ):
                    raw = runtime.model_state
                else:
                    probe = ACP({**config, "inference_profile": profile}, directory)
                    probe.start(catalog_only=True)
                    raw = probe.model_state
                entry = {
                    **parse_models({"models": raw}),
                    "profile": profile,
                    "fetched_at": now,
                    "cached": False,
                }
                if not entry["available"]:
                    entry["error"] = "此 profile 没有返回可选模型，可刷新清单或手动填写模型 ID。"
            except (ACPError, OSError, ValueError, TypeError, KeyError):
                entry = {
                    "profile": profile,
                    "current": "",
                    "available": [],
                    "error": "无法读取 Hermes 模型，请检查安装、profile 与登录状态，或手动填写模型 ID。",
                    "cached": False,
                }
            finally:
                if probe:
                    probe.close()
        result[role] = entry
        updated[profile] = entry
    saved = {key: value for key, value in updated.items() if "error" not in value}
    if saved:
        write(path, json.dumps(saved, ensure_ascii=False))
    return result


def codex_catalogs(config, directory, write, *, force=False):
    from copilot_codex import Codex

    probe = Codex(config, directory)
    try:
        probe.start(initialize_only=True)
        effective = probe.call("config/read", {"includeLayers": False}).get("config", {})
        provider = effective.get("model_provider") or "openai"
        key = json.dumps(["codex", probe.version, provider])
        path = Path(directory) / "codex-models.json"
        cache = {}
        if path.is_file() and not path.is_symlink():
            cache = json.loads(path.read_text())
        entry = cache.get(key, {})
        if not force and 0 <= time.time() - entry.get("fetched_at", 0) < 86400:
            entry = {**entry, "cached": True}
        else:
            entry = {
                **probe.list_models(),
                "agent": "codex",
                "version": probe.version,
                "provider": provider,
                "fetched_at": time.time(),
                "cached": False,
            }
            write(path, json.dumps({key: entry}, ensure_ascii=False))
        return {"inference": entry, "execution": dict(entry)}
    except (ACPError, OSError, ValueError, TypeError):
        entry = {
            "current": "",
            "available": [],
            "cached": False,
            "error": "Codex model list unavailable; check installation and run codex login in your terminal.",
        }
        return {"inference": entry, "execution": dict(entry)}
    finally:
        probe.close()
