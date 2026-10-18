"""只维护有归属标记的专用 profile；保留模型迁移和非受管设置。"""

import hashlib
import json
import os
from pathlib import Path
import subprocess

OWNED = (
    "known_plugin_toolsets",
    "platform_toolsets",
    "mcp_servers",
    "plugins",
    "memory",
    "command_allowlist",
    "approvals",
    "skills",
    "auxiliary",
    "agent",
    "reasoning_effort",
)


def read_config(path, home=None, *, allow_subprocess=True):
    text = Path(path).read_text()
    try:
        return json.loads(text)
    except ValueError:
        pass
    try:
        import yaml

        return yaml.safe_load(text) or {}
    except ImportError:
        if not allow_subprocess:
            raise ValueError("profile YAML reader unavailable")
        python = next(
            (
                root / "hermes-agent/venv/bin/python"
                for root in (Path(home or path.parent), *Path(path).parents)
                if (root / "hermes-agent/venv/bin/python").is_file()
            ),
            None,
        )
        if python is None:
            raise ValueError("YAML reader unavailable; install Hermes before repairing profiles")
        code = "import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))"
        result = subprocess.run(
            [str(python), "-c", code, str(path)],
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if result.returncode:
            raise ValueError("profile YAML could not be parsed")
        return json.loads(result.stdout)


def desired(model, provider):
    return {
        "_config_version": 50,
        "model": {"default": model, "provider": provider},
        "known_plugin_toolsets": {"acp": ["fast-browser-link"], "cli": ["fast-browser-link"]},
        "platform_toolsets": {"acp": [], "cli": []},
        "plugins": {"enabled": ["fast-browser-link"]},
        "mcp_servers": {},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "provider": ""},
        "command_allowlist": [],
        "approvals": {"mode": "manual"},
        "skills": {"auto_load": []},
        "reasoning_effort": "low",
        "auxiliary": {
            "background_review": {"enabled": False},
            "title_generation": {"enabled": False, "model_upgrade_enabled": False},
        },
        "agent": {
            "max_turns": 1,
            "tool_use_enforcement": False,
            "execution_guidance": False,
            "task_completion_guidance": False,
            "parallel_tool_call_guidance": False,
        },
    }


def merge_owned(current, wanted):
    result = dict(current)
    for key, value in wanted.items():
        if key == "model":
            continue
        if key == "_config_version":
            result[key] = max(current.get(key, 0), value)
            continue
        if value == {}:
            result[key] = {}
            continue
        if isinstance(value, dict) and isinstance(current.get(key), dict):
            result[key] = merge_owned(current[key], value)
        else:
            result[key] = value
    return result


def profile_plan(home, profile, model="", provider="auto", *, allow_subprocess=True):
    if profile != "fast-copilot":
        raise ValueError("dedicated profiles only")
    target = Path(home) / "profiles" / profile
    path = target / "config.yaml"
    marker = target / ".copilot-profile.json"
    for item in (path, marker):
        if any(part.is_symlink() for part in (item, *item.parents)):
            raise ValueError("profile path contains symlink")
    current = read_config(path, home, allow_subprocess=allow_subprocess) if path.exists() else {}
    if not isinstance(current, dict):
        raise ValueError("invalid profile configuration")
    if target.exists() and not marker.is_file():
        return {"profile": profile, "state": "unmanaged", "changes": []}
    if marker.is_file():
        record = json.loads(marker.read_text())
        if record.get("version") not in (1, 2, 3) or not isinstance(record.get("files"), dict):
            raise ValueError("invalid profile marker")
        # 中文注释：只修配置的受管键；人格/工作区由用户修改时不覆盖，也不刷新其摘要。
        if "config.yaml" not in record.get("files", {}):
            raise ValueError("profile ownership cannot be confirmed")
    if not target.exists():
        # 中文注释：只沿用有归属标记的旧配置参数，不复制认证、会话或用户文件。
        for name in ("copilot", "copilot-exec"):
            legacy = Path(home) / "profiles" / name
            config_path = legacy / "config.yaml"
            ownership = legacy / ".copilot-profile.json"
            if not ownership.is_file() or not config_path.is_file():
                continue
            if any(
                part.is_symlink()
                for item in (config_path, ownership)
                for part in (item, *item.parents)
            ):
                raise ValueError("legacy profile path contains symlink")
            record = json.loads(ownership.read_text())
            if (
                record.get("version") not in (1, 2, 3)
                or not isinstance(record.get("files"), dict)
                or "config.yaml" not in record["files"]
            ):
                raise ValueError("legacy profile ownership cannot be confirmed")
            current = read_config(config_path, home, allow_subprocess=allow_subprocess)
            if not isinstance(current, dict):
                raise ValueError("invalid legacy profile configuration")
            break
    wanted = desired(model, provider)
    if current:
        wanted = merge_owned(current, wanted)
    elif not model:
        raise ValueError("available model selection required")
    changes = []
    details = []

    def diff(before, after, prefix=""):
        for key, value in after.items():
            name = prefix + key
            if isinstance(value, dict) and isinstance(before.get(key), dict):
                diff(before[key], value, name + ".")
            elif before.get(key) != value:
                changes.append(name)
                if name in {"reasoning_effort", "_config_version", "agent.max_turns"}:
                    details.append(f"{name}: {before.get(key)} → {value}")

    diff(current, wanted)
    current_model = current.get("model", {})
    current_model = (
        current_model.get("default", "") if isinstance(current_model, dict) else str(current_model)
    )
    previous_model = (record.get("model") if marker.is_file() else None) or model
    if previous_model and previous_model != current_model:
        details.insert(0, f"模型已变化（可能由 Hermes 迁移）：{previous_model} → {current_model}")
    details.append(
        f"当前模型：{current_model or '未登记'}；推理强度：{current.get('reasoning_effort', '未设置')}"
    )
    return {
        "details": details,
        "fix_policy": "保留当前模型、提供商、较新的 _config_version 和非受管设置；恢复 reasoning_effort=low、ACP 空工具、MCP 空配置及其他专用 profile 受管约束。",
        "profile": profile,
        "state": "drift" if changes or not path.is_file() else "ready",
        "changes": changes,
        "config": wanted,
        "target": target,
        "marker": marker,
    }


def repair(home, profile, write, model="", provider="auto", dry_run=False):
    plan = profile_plan(home, profile, model, provider)
    if plan["state"] == "unmanaged":
        return plan
    if dry_run:
        return {
            key: value for key, value in plan.items() if key not in {"config", "target", "marker"}
        }
    target = plan["target"]
    marker = plan["marker"]
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    existing = json.loads(marker.read_text()) if marker.exists() else {"version": 3, "files": {}}
    if not (target / "config.yaml").exists():
        for name in ("SOUL.md", "AGENTS.md", "workspace/AGENTS.md", "workspace/.hermes.md"):
            write(target / name, "")
            existing["files"][name] = hashlib.sha256(b"").hexdigest()
    text = json.dumps(plan["config"], ensure_ascii=False, indent=2) + "\n"
    if plan["changes"] or not (target / "config.yaml").exists():
        write(target / "config.yaml", text)
    else:
        text = (target / "config.yaml").read_text()
    if "model" not in existing:
        value = plan["config"].get("model", {})
        existing["model"] = value.get("default", "") if isinstance(value, dict) else str(value)
    existing.update(version=3)
    existing["files"]["config.yaml"] = hashlib.sha256(text.encode()).hexdigest()
    existing["owned_keys"] = list(OWNED)
    write(marker, json.dumps(existing, indent=2) + "\n")
    return {"profile": profile, "state": "ready", "changes": plan["changes"]}
