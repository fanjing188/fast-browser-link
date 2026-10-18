"""只解析 Codex exec JSONL 已暴露的指标；不把用户 turn 数当模型请求数。"""

import json
import shlex

MISSING = "未拿到"


def body(value):
    if isinstance(value, dict) and "content" in value:
        value = value["content"]
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        value = value["text"]
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def shell_operation(command):
    """中文注释：只计数可确定的一次直接 CLI 调用，复合 shell 不推算内部调用数。"""
    try:
        words = shlex.split(command)
        if (
            len(words) == 3
            and words[1] == "-lc"
            and words[0].split("/")[-1] in {"bash", "zsh", "sh"}
        ):
            words = shlex.split(words[2])
        if any(word in {"&&", ";", "|", "||"} or "\n" in word for word in words):
            return None
        index = next(i for i, word in enumerate(words) if word.split("/")[-1] == "browser.py")
        if index not in (1, 2) or words[0].split("/")[-1] not in {"python", "python3"}:
            return None
        if index == 2 and words[1] != "-B":
            return None
        args = words[index + 1 :]
        if args[:1] == ["--session"]:
            args = args[2:]
        if not 1 <= len(args) <= 2:
            return None
        if len(args) == 2 and args[1] != "-":
            json.loads(args[1])
        return args[0]
    except (ValueError, StopIteration):
        return None


def parse_events(lines, mode):
    usage = []
    items = {}
    response = []
    finished = False
    for line in lines:
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("type") in {"turn.completed", "turn.failed"}:
            finished = True
        if event.get("type") == "turn.completed":
            usage.append(event.get("usage", {}))
        if event.get("type") == "item.completed":
            item = event.get("item", {})
            if not isinstance(item.get("id"), str):
                continue
            items[item["id"]] = item
    calls, scripts, failed = 0, 0, 0
    uncertain = False
    for item in items.values():
        kind = item.get("type")
        if kind == "agent_message":
            response.append(item.get("text", ""))
        elif kind == "mcp_tool_call":
            raw_result = item.get("result")
            receipt = body(raw_result)
            failed += bool(
                item.get("error")
                or item.get("status") == "failed"
                or (isinstance(raw_result, dict) and raw_result.get("isError") is True)
                or receipt.get("error")
                or receipt.get("ok") is False
                or receipt.get("execution_complete") is False
            )
            if (
                item.get("server") == "fast-browser-link"
                and item.get("tool") == "fast_browser_link"
            ):
                args = body(item.get("arguments"))
                calls += 1
                scripts += args.get("operation") == "script"
        elif kind == "command_execution":
            receipt = body(item.get("aggregated_output"))
            failed += bool(
                item.get("status") == "failed"
                or item.get("exit_code", 0) != 0
                or receipt.get("error")
                or receipt.get("ok") is False
                or receipt.get("execution_complete") is False
            )
            if mode == "skills":
                command = item.get("command", "")
                operation = shell_operation(command)
                if operation:
                    calls += 1
                    scripts += operation == "script"
                elif "browser.py" in command:
                    uncertain = True
    metrics = {
        "modelCalls": MISSING,
        "browserToolCalls": MISSING if uncertain or not finished else calls,
        "scriptCalls": MISSING if uncertain or not finished else scripts,
        "failedToolCalls": failed if finished else MISSING,
        "totalMs": MISSING,
        "browserToolMs": MISSING,
        "modelThinkingMs": MISSING,
    }
    for target, source in (
        ("inputTokens", "input_tokens"),
        ("cachedReadTokens", "cached_input_tokens"),
        ("outputTokens", "output_tokens"),
    ):
        metrics[target] = (
            sum(row[source] for row in usage)
            if usage and all(type(row.get(source)) is int for row in usage)
            else MISSING
        )
    return {"efficiency": metrics, "response": "\n".join(response)}
