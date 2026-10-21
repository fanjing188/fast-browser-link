"""标准推荐目录与确定性排序；不探测服务、不执行插件业务代码。"""

import copy
import hashlib
import json
import math
import time
from pathlib import Path

from copilot_capabilities import label

RULE_VERSION = 3
HEALTH_TTL = 600
METADATA_TTL = 86400


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    ).hexdigest()[:24]


def descriptor(packages, identity):
    flow = packages.flows[identity]
    package = packages.flow_packages.get(identity, "builtin")
    declaration = flow.get("recommendation", {})
    required = sorted(
        {s["capability"] for s in flow["steps"] if s.get("capability") and not s.get("optional")}
    )
    optional = sorted(
        {s["capability"] for s in flow["steps"] if s.get("capability") and s.get("optional")}
    )
    from copilot_capabilities import CAPABILITIES

    contracts = {cap: packages.schemas.get(cap, CAPABILITIES.get(cap)) for cap in required}
    # 中文注释：名字相同不代表等价；私有任务只在同包同流程内去重。
    semantic = declaration.get("task_type", package + ":" + identity)
    equivalent = declaration.get("equivalence")
    compatibility = (
        digest(
            [
                equivalent,
                declaration,
                contracts,
                flow.get("object", "keyword"),
                flow.get("risk", "zero"),
                flow.get("result"),
                [{k: v for k, v in step.items() if k != "id"} for step in flow["steps"]],
            ]
        )
        if equivalent
        else ""
    )
    return {
        "descriptor_ref": package + ":" + identity,
        "descriptor_revision": digest(flow),
        "task_type": semantic,
        "scope": declaration.get("scope", "page"),
        "subject_kinds": declaration.get("subject_kinds", ["business_object"]),
        "min_subjects": declaration.get("min_subjects", 1),
        "max_subjects": declaration.get("max_subjects", 1),
        "required_fields": declaration.get("required_fields", []),
        "intent": declaration.get("intent", []),
        "output_kind": declaration.get("output_kind", "records"),
        "completion": declaration.get("completion", {}),
        "required_capabilities": required,
        "optional_capabilities": optional,
        "compatibility_key": compatibility,
        "adapter_ready": declaration.get("scope", "page") == "page",
    }


def _snapshot(directory, name):
    path = Path(directory) / name
    try:
        if path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
            return {}, 0
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            return {}, 0
        for key in ("sources", "candidates", "mcp_tools", "errors"):
            if key in value:
                if not isinstance(value[key], list):
                    return {"errors": [{"source": "discovery", "code": "invalid_snapshot"}]}, 0
                value[key] = [
                    row
                    for row in value[key]
                    if isinstance(row, dict)
                    and (key != "candidates" or isinstance(row.get("binding", {}), dict))
                ]
        return value, path.stat().st_mtime
    except (OSError, ValueError):
        return {}, 0


def _fresh(checked, now, ttl):
    return type(checked) in (int, float) and math.isfinite(checked) and 0 <= now - checked <= ttl


def inventory(app, instance, *, clock=None):
    now = (clock or time.time)()
    context, state = app._tool_context(instance), app._state(instance)
    packages = app.packages
    capabilities = []
    for name, bindings in sorted(packages.bindings.items()):
        providers = []
        for binding in bindings:
            status = app.registry.structural(binding, context, now=now)
            health = app.registry.health.get(binding["id"], {})
            normalized = (
                "ready"
                if status in {"available", "ready"}
                else "needs_login"
                if status in {"login", "needs_login", "needs_login_or_readable_report"}
                else "disabled"
                if status == "disabled_today"
                else "needs_setup"
                if status
                in {
                    "missing_command",
                    "missing_profile",
                    "missing_local_data",
                    "needs_route_confirmation",
                    "needs_explicit_fallback",
                }
                else "temporarily_unavailable"
                if status in {"quota", "rate_limit", "captcha", "probe_unavailable"}
                else "unknown"
            )
            providers.append(
                {
                    "id": binding["id"],
                    "plugin": binding.get("_package", "builtin"),
                    "type": binding["type"],
                    "state": normalized,
                    "reason": status,
                    "implementation_revision": binding_revision(binding),
                    "checked_at": health.get("checked_at"),
                    "cost": binding.get("cost", "unknown"),
                    "batch_limit": binding.get("batch_limit", 1),
                    "serial": bool(binding.get("serial_group")),
                }
            )
        capabilities.append(
            {
                "id": name,
                "contract_digest": digest(app.registry.schemas.get(name, {})),
                "providers": providers,
            }
        )
    flows = [
        {
            "id": key,
            "plugin": packages.flow_packages.get(key, "builtin"),
            "name": label(flow.get("name", key), state.get("locale", "zh")),
            **descriptor(packages, key),
        }
        for key, flow in sorted(packages.flows.items())
    ]
    skills = [
        {
            "id": item["id"],
            "name": item.get("name", item["id"]),
            "state": "needs_setup",
            "capabilities": item.get("capabilities", []),
        }
        for item in state.get("skill_candidates", [])
    ]
    confirmed, confirmed_at = _snapshot(app.directory, "discovery-confirmed.json")
    draft, draft_at = _snapshot(app.directory, "discovery-draft.json")
    latest_sources = {}
    for snapshot in (confirmed, draft):
        for source in snapshot.get("sources", []):
            previous = latest_sources.get(source.get("source_id"), {})
            if not previous or source.get("captured_at", 0) >= previous.get("captured_at", 0):
                latest_sources[source.get("source_id")] = source
    bound = {binding["id"] for bindings in packages.bindings.values() for binding in bindings}
    discovered = []
    for snapshot, at in ((confirmed, confirmed_at), (draft, draft_at)):
        for row in snapshot.get("candidates", [])[:1000]:
            if not isinstance(row, dict) or not isinstance(row.get("binding"), dict):
                continue
            binding = row["binding"]
            identity = binding.get("id")
            if not isinstance(identity, str):
                continue
            discovered.append(
                {
                    "id": digest([row.get("source"), row.get("id"), identity]),
                    "source": row.get("source", "unknown"),
                    "capability": row.get("capability"),
                    "binding_id": identity,
                    "state": "bound" if identity in bound else "needs_setup",
                    "metadata_state": "fresh" if _fresh(at, now, METADATA_TTL) else "stale",
                }
            )
    discovered = list({r["id"]: r for r in discovered}.values())
    mcp_tools = []
    for snapshot, _ in ((confirmed, confirmed_at), (draft, draft_at)):
        for tool in snapshot.get("mcp_tools", [])[:2000]:
            source = latest_sources.get(tool.get("source_id"), {})
            metadata_state = (
                "invalidated"
                if source.get("coverage") != "complete"
                else "stale"
                if not _fresh(source.get("captured_at", 0), now, METADATA_TTL)
                or tool.get("metadata_digest", source.get("metadata_digest"))
                != source.get("metadata_digest")
                else "fresh"
            )
            mcp_tools.append(
                {
                    "id": digest([tool.get("source_id"), tool.get("name")]),
                    "name": tool.get("name"),
                    "source_id": digest(tool.get("source_id")),
                    "contract_digest": tool.get("contract_digest"),
                    "metadata_state": metadata_state,
                    "state": "needs_refresh"
                    if metadata_state != "fresh"
                    else "bound"
                    if any(
                        row.get("binding", {}).get("tool_name") == tool.get("name")
                        and row.get("source_id") == tool.get("source_id")
                        and row.get("binding", {}).get("id") in bound
                        and metadata_current(app.directory, row["binding"], now)
                        for row in confirmed.get("candidates", [])
                    )
                    else "needs_setup",
                }
            )
    mcp_tools = list({r["id"]: r for r in mcp_tools}.values())
    # 中文注释：技能候选与已确认源只在本机按身份关联，不公开源文件路径。
    bound_skills = set()
    for candidate in confirmed.get("candidates", []):
        if candidate.get("binding", {}).get("id") in bound and candidate.get("source") in {
            "manifest",
            "model_draft",
        }:
            source = Path(candidate.get("source_ref", ""))
            source = (
                source.parent / "SKILL.md" if source.name == "fbl-capabilities.json" else source
            )
            bound_skills.add(hashlib.sha256(str(source).encode()).hexdigest()[:20])
    for skill in skills:
        if skill["id"] in bound_skills:
            skill["state"] = "bound"
    plugins = copy.deepcopy(getattr(packages, "package_records", []))
    sources = []
    for source in list(latest_sources.values())[:500]:
        sources.append(
            {
                "id": digest([source.get("source_id"), source.get("kind")]),
                "kind": source.get("kind", "unknown"),
                "coverage": source.get("coverage", "unknown"),
                "revision": source.get("revision", source.get("metadata_digest")),
                "notification_scope": source.get("notification_scope", "request_session_only"),
                "metadata_state": "invalidated"
                if source.get("coverage") != "complete"
                else "fresh"
                if _fresh(source.get("captured_at", 0), now, METADATA_TTL)
                else "stale",
            }
        )
    errors = [
        {"source": row.get("source", "unknown"), "code": row.get("code", "discovery_failed")}
        for row in draft.get("errors", [])[:100]
        if isinstance(row, dict)
    ]
    failed = list(getattr(packages, "load_errors", []))
    coverage = (
        "partial"
        if failed
        or errors
        or any(s["coverage"] != "complete" or s["metadata_state"] != "fresh" for s in sources)
        else "registered_sources_only"
    )
    payload = {
        "capabilities": capabilities,
        "flows": flows,
        "skills": skills,
        "plugins": plugins,
        "discovered": discovered,
        "mcp_tools": mcp_tools,
        "sources": sources,
        "errors": [*failed, *errors],
        "coverage": coverage,
        "coverage_complete": False,
        "all_ready": False,
    }
    revision = digest(payload)
    cache = getattr(app, "_recommendation_catalog_revisions", {})
    previous = cache.get(instance, {})
    serial = previous.get("catalog_revision", 0) + int(previous.get("revision") != revision)
    cache[instance] = {"revision": revision, "catalog_revision": serial}
    app._recommendation_catalog_revisions = cache
    return {
        **payload,
        "revision": revision,
        "catalog_revision": serial,
        "rules_version": RULE_VERSION,
        "counts": {
            "known": len(plugins) + len(skills) + len(discovered),
            "registered": sum(r["state"] == "registered" for r in plugins),
            "needs_setup": len(skills) + sum(r["state"] == "needs_setup" for r in discovered),
            "load_failed": len(failed),
        },
    }


def metadata_current(directory, binding, now, *, ttl=METADATA_TTL):
    from fbl_discovery import digest as discovery_digest, file_digest, mcp_schema

    confirmed, _ = _snapshot(directory, "discovery-confirmed.json")
    source_id = discovery_digest([binding["config_path"], binding["server"]])
    source = next((r for r in confirmed.get("sources", []) if r.get("source_id") == source_id), {})
    checked = source.get("captured_at", 0)
    if source.get("coverage") != "complete" or not _fresh(checked, now, ttl):
        return False
    if source.get("config_digest") != file_digest(binding["config_path"]):
        return False
    draft, _ = _snapshot(directory, "discovery-draft.json")
    latest = next((r for r in draft.get("sources", []) if r.get("source_id") == source_id), {})
    if (
        latest
        and latest.get("captured_at", 0) >= checked
        and (
            latest.get("coverage") != "complete"
            or latest.get("metadata_digest") != source.get("metadata_digest")
        )
    ):
        return False
    tools = {
        tool.get("name"): tool
        for tool in confirmed.get("mcp_tools", [])
        if tool.get("source_id") == source_id and isinstance(tool.get("name"), str)
    }
    tool = tools.get(binding["tool_name"])
    if not tool:
        return False
    try:
        mcp_schema(tool.get("inputSchema"))
        if discovery_digest(tool["inputSchema"]) != tool.get("contract_digest"):
            return False
        if "outputSchema" in tool:
            mcp_schema(tool["outputSchema"])
            if discovery_digest(tool["outputSchema"]) != tool.get("output_contract_digest"):
                return False
    except (ValueError, TypeError, RecursionError):
        return False
    for row in confirmed.get("candidates", []):
        stored = row.get("binding", {})
        if not (
            row.get("source_id") == source_id
            and row.get("source_ref") == binding["config_path"]
            and stored.get("config_path") == binding["config_path"]
            and stored.get("id") == binding["id"]
            and stored.get("server") == binding["server"]
            and stored.get("tool_name") == binding["tool_name"]
            and stored.get("input_fields") == binding.get("input_fields")
            and row.get("contract_digest") == tool.get("contract_digest")
            and row.get("metadata_digest", source.get("metadata_digest"))
            == source.get("metadata_digest")
        ):
            continue
        if row.get("declaration"):
            from fbl_discovery import declared_mcp_bindings

            clean = {key: value for key, value in binding.items() if not key.startswith("_")}
            matched = any(
                entry["binding"] == clean
                and entry["declaration"] == row["declaration"]
                and discovery_digest(entry["schema"]["input"]) == tool.get("contract_digest")
                and (
                    tool.get("output_contract_digest") is None
                    or discovery_digest(entry["schema"]["output"]) == tool["output_contract_digest"]
                )
                for entry in declared_mcp_bindings(directory)
            )
            if not matched:
                return False
        # 中文注释：执行层用同一目录重新读取确认与失效状态；此路径不是授权凭据。
        binding["_mcp_directory"] = str(directory)
        return True
    return False


def binding_revision(binding):
    # 中文注释：只把指纹公开给推荐层，不把命令、路径、配置或凭据复制出去。
    files = []
    for key in ("argv", "plan_argv"):
        for value in binding.get(key, []):
            if not isinstance(value, str) or "{" in value:
                continue
            path = Path(value)
            try:
                if path.is_absolute() and path.is_file() and not path.is_symlink():
                    stat = path.stat()
                    fingerprint = (
                        hashlib.sha256(path.read_bytes()).hexdigest()
                        if stat.st_size <= 1024 * 1024
                        else [stat.st_size, stat.st_mtime_ns]
                    )
                    files.append([digest(value), fingerprint])
            except OSError:
                files.append([digest(value), "unreadable"])
    return digest(
        [{k: v for k, v in binding.items() if k not in {"_schema", "_mcp_directory"}}, files]
    )


def health_scope(context):
    context = context or {}
    return digest(
        {key: context.get(key) for key in ("browser", "instance", "epoch", "account_scope")}
    )


def _latency(row, state, now):
    records = [
        r
        for r in state.get("task_history", [])
        if r.get("status") == "verified"
        and r.get("task_type") == row.get("task_type")
        and r.get("provider_revision") == row.get("provider_revision")
        and r.get("subject_kind") == row.get("subject_kind")
        and 0 <= now - r.get("at", 0) <= 7 * 86400
        and isinstance(r.get("elapsed_ms"), (int, float))
        and r["elapsed_ms"] >= 0
    ][-20:]
    if not records:
        return 3
    values = sorted(r["elapsed_ms"] for r in records)
    middle = len(values) // 2
    median = values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2
    return 0 if median <= 1000 else 1 if median <= 10000 else 2


def feedback_active(item, now=None, work_id=None):
    """稍后记录按墙钟到期；旧记录仅在所属当前工作内继续抑制。"""
    if not isinstance(item, dict):
        return False
    if work_id and item.get("work_id") and item["work_id"] != work_id:
        return False
    if item.get("kind") == "later":
        until = item.get("until")
        return (
            True
            if until is None
            else isinstance(until, (int, float)) and (time.time() if now is None else now) < until
        )
    return item.get("kind") in {
        "irrelevant",
        "wrong_direction",
        "done",
        "ignore",
        "not_relevant",
        "wrong",
    }


def _identity(row, state):
    task = row.get("task_type", row.get("action", ""))
    objects = (
        row.get("material_ids")
        or row.get("subject_refs")
        or {k: v for k, v in row.get("params", {}).items() if k != "flow"}
    )
    compatible = row.get("compatibility_key")
    semantic = (
        [task, compatible]
        if compatible
        else [task, row.get("descriptor_ref", row.get("action")), row.get("params", {}).get("flow")]
    )
    return digest(
        [
            row.get("work_id", state.get("work_id")),
            semantic,
            objects,
            row.get("goal_options", row.get("params", {}).get("options", {})),
        ]
    )


def rank(rows, state, *, clock=None):
    """只过滤主动待办，显式任务和已开始任务始终保留；排序输入可离线重放。"""
    now = (clock or time.time)()
    retained, candidates = [], []
    feedback = {r.get("id"): r for r in state.get("work_feedback", []) if isinstance(r, dict)}
    for source in rows:
        row = copy.deepcopy(source)
        if row.get("status") != "pending" or row.get("explicit"):
            retained.append(row)
            continue
        response = feedback.get(row.get("id"), {})
        if row.get("work_id") and state.get("work_id") and row["work_id"] != state["work_id"]:
            continue
        if (
            row.get("preference") == "hide"
            or row.get("stale")
            or row.get("scope_valid") is False
            or row.get("evidence_valid") is False
            or row.get("adapter_ready") is False
        ):
            continue
        if feedback_active(response, now, state.get("work_id")):
            continue
        if row.get("expires_at") is not None and now >= row["expires_at"]:
            continue
        if row.get("live_reference") and row.get("document_id") != state.get(
            "page_context", {}
        ).get("document_id"):
            continue
        blocked = (
            bool(row.get("missing_capabilities")) or row.get("recommendation_state") == "blocked"
        )
        row["recommendation_section"] = "preparation" if blocked else "main"
        progress = (
            3
            if row.get("capture_required")
            else 0
            if row.get("fills_missing")
            else 1
            if row.get("from_result") and row.get("result_verified") is True
            else 2
            if row.get("subject_kind") or row.get("contextual")
            else 3
        )
        subject = (
            0
            if row.get("subject_kind") == "text_selection"
            else 1
            if row.get("material_ids")
            else 2
            if row.get("tool_aware") or row.get("contextual")
            else 3
        )
        at = row.get("evidence_at", row.get("created_at"))
        age = max(0, now - at) if isinstance(at, (int, float)) else float("inf")
        age_band = 0 if age <= 60 else 1 if age <= 600 else 2
        local = row.get("local_task") is True
        features = (
            progress,
            subject,
            int(row.get("recommendation_state") in {"needs_parameters", "needs_material"}),
            0
            if row.get("preference") == "prefer"
            else 2
            if row.get("preference") == "deprioritize"
            else 1,
            age_band,
            0 if row.get("verified_success") else 1,
            0 if local else 1,
            _latency(row, state, now),
            row.get("context_priority", 100),
            row["id"],
        )
        context = [state.get("context_revision", 0), state.get("work_revision", 0)]
        order = (
            state.get("candidate_order", [])
            if state.get("candidate_order_context") == context
            else []
        )
        features = (
            *features[:-1],
            order.index(row["id"]) if row["id"] in order else 20,
            features[-1],
        )
        row["recommendation_features"] = list(features)
        row["reason_codes"] = list(
            dict.fromkeys(
                [
                    *row.get("reason_codes", []),
                    "goal_missing"
                    if progress == 0
                    else "verified_followup"
                    if progress == 1
                    else "context_configuration"
                    if row.get("capture_required")
                    else "subject_match",
                    "capability_missing"
                    if blocked
                    else "parameters_required"
                    if row.get("recommendation_state") in {"needs_parameters", "needs_material"}
                    else "capability_ready",
                ]
            )
        )
        candidates.append((blocked, features, row))
    candidates.sort(key=lambda item: (item[0], item[1]))
    chosen, by_key = [], {}
    active = {
        _identity(row, state)
        for row in retained
        if row.get("explicit")
        or row.get("status") in {"queued", "executing", "stopping", "completed"}
    }
    preparation_added = False
    for blocked, features, row in candidates:
        # 中文注释：跨流程归并必须有相同完整合同指纹，不能只按 task_type 猜测。
        identity = _identity(row, state)
        if identity in active:
            continue
        if identity in by_key:
            existing = by_key[identity]
            existing.setdefault("providers", []).append(
                {
                    "id": row["id"],
                    "descriptor_ref": row.get("descriptor_ref"),
                    "state": row.get("recommendation_state", "ready"),
                }
            )
            continue
        if blocked and preparation_added:
            continue
        row["recommendation_identity"] = identity
        by_key[identity] = row
        chosen.append(row)
        preparation_added |= blocked
    auto, kinds = [], set()
    ready = [row for row in chosen if row["recommendation_section"] == "main"]
    for row in ready:
        kind = row.get("task_type") or (row.get("action"), row.get("params", {}).get("flow"))
        if kind not in kinds:
            auto.append(row)
            kinds.add(kind)
        if len(auto) == 10:
            break
    for row in ready:
        if len(auto) == 10:
            break
        if row not in auto:
            auto.append(row)
    if len(auto) < 10:
        auto.extend(row for row in chosen if row["recommendation_section"] == "preparation")
    input_digest = digest(
        [
            RULE_VERSION,
            state.get("work_id"),
            state.get("context_revision"),
            state.get("catalog_revision"),
            [(r["id"], r["recommendation_features"], r["recommendation_identity"]) for r in auto],
        ]
    )
    for index, row in enumerate(auto):
        row["recommendation_rank"] = index
        row["ranking_input_digest"] = input_digest
    return [*retained, *auto]
