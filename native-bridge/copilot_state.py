"""协作工作假设及结果上下文投影。"""

from __future__ import annotations


def work_state(value=None):
    """只保留可修正的工作假设；用户方向和授权不由模型填写。"""
    value = value if isinstance(value, dict) else {}
    from copilot_diagnostics import redact_page

    result = {
        key: value.get(key, "")[:300] if isinstance(value.get(key, ""), str) else ""
        for key in ("goal", "next_step")
    }
    for key in ("evidence", "constraints", "open_questions"):
        items = value.get(key, [])
        result[key] = (
            list(
                dict.fromkeys(
                    item[:200] for item in items if isinstance(item, str) and item.strip()
                )
            )[:5]
            if isinstance(items, list)
            else []
        )
    return redact_page(result)


def work_context(state):
    return {
        "inferred": state["work"],
        "user_direction": state["user_direction"],
        "feedback": state["work_feedback"][-8:],
    }


def result_context(row):
    """结果事实单独投影，不把完整报告、原始表格或执行参数回灌模型。"""
    from copilot_diagnostics import redact_page

    result = row.get("result") or {}
    return redact_page(
        {
            "id": row["id"],
            "action": row["action"],
            "status": row["status"],
            "verdict": str(result.get("verdict", ""))[:300],
            "findings": [str(item)[:200] for item in result.get("bullets", [])[:3]],
            "metrics": [
                {key: str(metric[key])[:160] for key in ("label", "value") if key in metric}
                for metric in result.get("metrics", [])[:3]
                if isinstance(metric, dict)
            ],
            "missing": [
                {key: str(item[key])[:200] for key in ("field", "reason") if key in item}
                for item in result.get("missing", [])[:5]
                if isinstance(item, dict)
            ],
            "process": [str(item)[:200] for item in result.get("process", [])[:3]],
            "sources": list(
                dict.fromkeys(
                    str(item["source"])[:200]
                    for item in [
                        result,
                        *result.get("checks", []),
                        *result.get("records", []),
                        *result.get("keywords", []),
                        *result.get("steps", []),
                    ]
                    if isinstance(item, dict) and item.get("source")
                )
            )[:3],
            "completion_status": row.get("completion_status", row["status"]),
        }
    )
