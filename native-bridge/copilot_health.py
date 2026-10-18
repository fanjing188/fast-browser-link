"""本机结构检查：不启动进程、不探测模型、不读取凭据。"""

from copilot_diagnostics import failure_message
from pathlib import Path
import shutil


def health(config, state, runtime):
    if config.get("default_agent") == "codex":
        return codex_health(config, state, runtime)
    home = Path(config.get("hermes_home") or Path.home() / ".hermes").expanduser()
    profile = config.get("exec_profile", "fast-copilot")
    profile_exists = (
        isinstance(profile, str)
        and "/" not in profile
        and profile not in {".", ".."}
        and (home / "profiles" / profile / "config.yaml").is_file()
    )
    command = config.get("hermes_command", "hermes")
    executable = isinstance(command, str) and bool(shutil.which(command))
    ready = bool(state.get("ready") and runtime and not getattr(runtime, "closed", False))
    metrics = state.get("input_metrics", [])
    last_success = state.get("last_call_succeeded", True if metrics else None)
    process = getattr(runtime, "process", None)
    diagnostic = (
        state.get("diagnostic")
        or state.get("execution_diagnostic")
        or (
            state.get("enabled")
            and (
                getattr(runtime, "failure", None)
                or (
                    process is not None
                    and not getattr(runtime, "closed", False)
                    and process.poll() is not None
                )
            )
        )
    )
    reason = ""
    english = ""
    if state.get("bridge_lost"):
        status = "error" if state.get("bridge_recovery_blocked") else "connecting"
        reason = (
            "浏览器与本地服务连接中断，连续三次连上即断，已停止自动恢复"
            if state.get("bridge_recovery_blocked")
            else "浏览器与本地服务连接中断，正在重连"
        )
        english = (
            "Browser bridge repeatedly disconnected; automatic recovery stopped"
            if state.get("bridge_recovery_blocked")
            else "Browser connection interrupted; reconnecting"
        )
    elif state.get("recovering"):
        status = "connecting"
        reason = (state.get("inference_failure") or {}).get(
            "message", "Hermes 推理进程已退出，正在重连"
        )
        english = failure_message(state.get("inference_failure") or {}, "en")
    elif diagnostic or last_success is False and state.get("inference_failures", 3) >= 3:
        status = "error"
        reason = (
            (state.get("startup_error") or {}).get("reason")
            or (state.get("inference_failure") or {}).get("message")
            or "最近调用或会话失败"
        )
        last_success = False
        english = (state.get("startup_error") or {}).get("reason_en") or failure_message(
            state.get("inference_failure") or {}, "en"
        )
    elif ready:
        status = "connected"
    elif not profile_exists or not executable:
        status = "disconnected"
        reason = "Hermes 命令不可用" if not executable else "执行 profile 不存在"
        english = "Hermes command unavailable" if not executable else "Execution profile missing"
    elif state.get("enabled"):
        status = "connecting"
    else:
        status = "disconnected"
    if state.get("bridge_lost") and state.get("bridge_error"):
        reason += " · " + state["bridge_error"]
        english += " · " + state["bridge_error"]
    if status == "connected" and state.get("template_warning"):
        reason = f"模板版本过旧，已跳过 {state['template_warning']} 个模板"
        english = f"Outdated templates: skipped {state['template_warning']} templates"
    return {
        "state": status,
        "reason": reason,
        "reason_en": english,
        "acp_ready": ready,
        "execution_profile_exists": bool(profile_exists),
        "execution_startable": bool(profile_exists and executable),
        "execution_check": "structural_only",
        "last_call_succeeded": last_success,
    }


def startup_failure(config, error, *, execution=False):
    if config.get("default_agent") == "codex":
        return {
            "code": str(error) if str(error).startswith("codex_") else "codex_start_failed",
            "reason": "Codex 会话启动失败：请检查版本、登录状态和策略回执",
            "reason_en": "Codex session failed: check version, login and policy receipt",
        }
    command = config.get("exec_acp_command" if execution else "acp_command")
    home = Path(config.get("hermes_home") or Path.home() / ".hermes").expanduser()
    profile = config.get("exec_profile" if execution else "inference_profile", "fast-copilot")
    if isinstance(error, FileNotFoundError) or (
        not command and not shutil.which(config.get("hermes_command", "hermes"))
    ):
        code, reason, english = (
            "hermes_command_missing",
            "Hermes 命令不可用",
            "Hermes command unavailable",
        )
    elif not command and not (home / "profiles" / profile / "config.yaml").is_file():
        code, reason, english = (
            "hermes_profile_missing",
            "执行 profile 不存在" if execution else "推理 profile 不存在",
            "Execution profile missing" if execution else "Inference profile missing",
        )
    else:
        code, reason, english = (
            "execution_start_failed" if execution else "inference_start_failed",
            "执行会话启动失败" if execution else "推理会话启动失败",
            "Execution session failed to start"
            if execution
            else "Inference session failed to start",
        )
    return {"code": code, "reason": reason, "reason_en": english}


def codex_health(config, state, runtime):
    ready = bool(state.get("ready") and runtime and not runtime.closed and not runtime.failure)
    failed = (
        state.get("diagnostic")
        or state.get("startup_error")
        or state.get("inference_failures", 0) >= 3
    )
    status = (
        "error"
        if failed
        else "connected"
        if ready
        else "connecting"
        if state.get("enabled")
        else "disconnected"
    )
    return {
        "state": status,
        "acp_ready": ready,
        "execution_startable": bool(shutil.which(config.get("codex_command", "codex"))),
        "last_call_succeeded": state.get("last_call_succeeded"),
        "reason": "Codex 推理：受限模式（只读沙箱、无执行环境、宿主审计）",
        "reason_en": "Codex inference: restricted mode (read-only sandbox, no execution environment, host audit)",
        "inference_policy": "restricted_audited",
        "policy_receipt": getattr(runtime, "policy_receipt", None),
    }
