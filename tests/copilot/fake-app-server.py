"""离线 app-server；禁止网络和模型调用，仅模拟固定版协议。"""

import json
import os
from pathlib import Path
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
record = Path(sys.argv[2]) if len(sys.argv) > 2 else None
thread_id = "thread-fixture"
turn_id = 0
final_text = '{"ready": true}'


def send(message):
    line = json.dumps(message, ensure_ascii=False) + "\n"
    if mode == "chunks":
        for offset in range(0, len(line), 117):
            sys.stdout.write(line[offset : offset + 117])
            sys.stdout.flush()
    else:
        print(line, end="", flush=True)


def event(method, **params):
    send({"method": method, "params": {"threadId": thread_id, **params}})


def complete():
    event(
        "item/completed",
        turnId=str(turn_id),
        item={"type": "agentMessage", "id": "answer", "text": final_text},
    )
    event(
        "thread/tokenUsage/updated",
        turnId=str(turn_id),
        tokenUsage={
            "total": {
                "inputTokens": 100 * turn_id,
                "cachedInputTokens": 20 * turn_id,
                "outputTokens": 10 * turn_id,
            },
            "last": {"totalTokens": 110},
        },
    )
    event("turn/completed", turn={"id": str(turn_id), "status": "completed"})


for line in sys.stdin:
    request = json.loads(line)
    if "jsonrpc" in request:
        raise RuntimeError("app-server frames must not contain jsonrpc")
    if record:
        with record.open("a") as out:
            out.write(json.dumps(request) + "\n")
    method, params = request.get("method"), request.get("params", {})
    result = {}
    if method == "initialize":
        result = {"userAgent": "fixture", "large": "x" * (400000 if mode == "chunks" else 0)}
    elif method == "account/read":
        result = {
            "account": None
            if mode in {"logged_out", "external"}
            else {"type": "chatgpt", "email": "not-returned@example.test"},
            "requiresOpenaiAuth": mode != "external",
        }
    elif method == "config/read":
        result = {
            "config": {
                "model_provider": "fixture",
                "mcp_servers": {"fixture.server": {"enabled": True}},
            }
        }
    elif method == "model/list":
        result = {
            "data": [
                {
                    "id": "two" if params.get("cursor") else "one",
                    "model": "fixture-two" if params.get("cursor") else "fixture-one",
                    "isDefault": not params.get("cursor"),
                }
            ],
            "nextCursor": None if params.get("cursor") else "page2",
        }
    elif method == "thread/start":
        sandbox = {
            "type": "workspaceWrite" if params["sandbox"] == "workspace-write" else "readOnly"
        }
        if params["sandbox"] == "workspace-write":
            sandbox.update(
                writableRoots=[params["cwd"]],
                networkAccess=False,
                excludeSlashTmp=True,
                excludeTmpdirEnvVar=True,
            )
        if mode == "policy":
            sandbox = {"type": "externalSandbox"}
        result = {
            "thread": {"id": thread_id},
            "model": params.get("model") or "fixture-one",
            "modelProvider": "fixture",
            "approvalPolicy": "never",
            "sandbox": sandbox,
            "cwd": params["cwd"],
        }
    elif method == "turn/start":
        if mode == "eof":
            os._exit(0)
        turn_id += 1
        if mode == "result":
            try:
                brief = json.loads(params["input"][0]["text"])
            except ValueError:
                brief = {}
            if brief.get("result_schema"):
                values = {
                    "verdict": "Fixture complete",
                    "level": "info",
                    "metrics": [],
                    "missing": [],
                    "process": [],
                    "next": [],
                    "bullets": [],
                    "links": [],
                    "artifacts": [],
                }
                final_text = json.dumps(
                    {
                        key: value
                        for key, value in values.items()
                        if key in brief["result_schema"]["properties"]
                    }
                )
        send({"id": request["id"], "result": {"turn": {"id": str(turn_id)}}})
        event("turn/started", turn={"id": str(turn_id)})
        event(
            "item/agentMessage/delta",
            turnId=str(turn_id),
            itemId="answer",
            delta='{"untrusted": true}',
        )
        if mode.startswith("tool:"):
            event(
                "item/started",
                turnId=str(turn_id),
                item={"type": mode.split(":", 1)[1], "id": "tool"},
            )
        elif mode.startswith("request:"):
            send(
                {
                    "id": "server-call",
                    "method": mode.split(":", 1)[1],
                    "params": {
                        "threadId": thread_id,
                        "turnId": str(turn_id),
                        "callId": "call1",
                        "tool": "assist_browser_snapshot",
                        "arguments": {},
                    },
                }
            )
            continue
        elif mode == "unknown_event":
            event("item/newTool/delta", turnId=str(turn_id))
        elif mode == "timeout":
            continue
        complete()
        continue
    elif method == "turn/interrupt":
        event("turn/completed", turn={"id": str(turn_id), "status": "interrupted"})
    elif method is None:
        complete()
        continue
    elif method in {"initialized"}:
        continue
    if "id" in request:
        send({"id": request["id"], "result": result})
