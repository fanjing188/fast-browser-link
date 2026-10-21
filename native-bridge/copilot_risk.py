"""执行风险由受管声明和实际调用路径共同决定，未声明默认消耗额度。"""

LEVELS = {"zero": 0, "metered": 1, "external": 2}


def declared(value):
    risk = value.get("risk", "metered")
    if not isinstance(risk, str) or risk not in LEVELS:
        raise ValueError("invalid risk level")
    return risk


def highest(*risks):
    return max(risks or ("metered",), key=LEVELS.__getitem__)


def binding_risk(binding):
    risk = declared(binding)
    if binding.get("external") or binding.get("writes_outside_export_root"):
        return "external"
    if binding.get("type") == "hermes" or binding.get("cost") not in {"zero", "free", "local"}:
        risk = highest(risk, "metered")
    return risk


def automatic_binding(binding):
    if binding_risk(binding) != "zero" or binding.get("read_only") is not True:
        return False
    if binding.get("type") in {"mcp", "hermes"}:
        return False
    if binding.get("type") == "browser":
        return (
            binding.get("public") is True
            and binding.get("requires_login") is False
            and not binding.get("plan_argv")
        )
    return binding.get("local_only") is True


def authorize_binding(binding, context):
    if (
        context.get("approved_bindings") is not None
        and binding["id"] not in context["approved_bindings"]
    ):
        return False
    if context.get("automatic") and not automatic_binding(binding):
        return False
    return binding_risk(binding) != "external" or context.get("secondary_confirmed") is True


def action_risk(app, row):
    action = row["action"]
    if action == "assist.task":
        from copilot_workbench import local_task

        return "zero" if local_task(row) else "metered"
    if action == "local.lookup" or app._cached(row):
        return "zero"
    template = app.templates.get(action)
    risk = declared(template)
    if action == "workflow.run":
        flow = app.packages.flows.get(row["params"]["flow"], {})
        risks = [
            declared(flow),
            risk if risk == "external" else "zero" if flow.get("judgment") is False else risk,
        ]
        if flow.get("judgment") is not False or any(
            step.get("model") for step in flow.get("steps", [])
        ):
            risks.append("metered")
        for step in flow.get("steps", []):
            risks.append(declared(step))
            if step.get("capability"):
                bindings = app.registry.candidates(step["capability"])
                risks.extend(binding_risk(binding) for binding in bindings)
        return highest(*risks)
    # 中文注释：除已审计的本机读取和缓存命中外，原任务路径都可能调用模型。
    return highest(risk, "metered")
