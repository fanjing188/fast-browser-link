#!/usr/bin/env python3
"""纯推理 ACP 替身，无工具、无委派、无浏览器。"""

from fake_result import judgment
import json
import os
import sys
import time
import uuid
from pathlib import Path

if "--stderr-fixture" in sys.argv:
    print("synthetic Hermes warning", file=sys.stderr, flush=True)
    print("api_key=" + ("fixture-" + "x" * 30), file=sys.stderr, flush=True)
session = ""
counter = 0
usage = 0


def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def update(text):
    mid = str(uuid.uuid4())
    cut = len(text) // 2
    for part in (text[:cut], text[cut:]):
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": mid,
                        "content": {"type": "text", "text": part},
                    },
                },
            }
        )


for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    params = request.get("params", {})
    result = {}
    with Path("acp-requests.jsonl").open("a") as log:
        log.write(json.dumps(request, ensure_ascii=False) + "\n")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
    elif method == "session/new":
        counter += 1
        session = "session-" + str(counter)
        usage = 0
        result = {
            "sessionId": session,
            "models": {
                "currentModelId": "openai-codex:gpt-5.6-luna",
                "availableModels": [
                    {"modelId": "openai-codex:gpt-5.6-luna", "name": "Luna"},
                    {"modelId": "openai-codex:gpt-6.1-sol", "name": "Sol"},
                ],
            },
        }
    elif method == "session/set_model":
        usage = 0
        result = {}
    elif method == "session/cancel":
        continue
    elif method == "session/prompt":
        text = params["prompt"][0]["text"]
        try:
            data = json.loads(text)
        except ValueError:
            data = {}
        if text == "/tools":
            output = (
                "Available tools (1): terminal"
                if "--has-tools" in sys.argv
                else "No tools available."
            )
        elif data.get("action") == "general.task":
            output = json.dumps(judgment(data))
        elif data.get("type") == "infer":
            if "--empty-inference-delay" in sys.argv:
                time.sleep(2.5)
            if "--crash-first-infer" in sys.argv and not Path("inference-crashed-once").exists():
                Path("inference-crashed-once").touch()
                os._exit(4)
            page = data.get("page", data.get("page_delta", {}))
            title = page.get("title", "first")
            rows = [
                {
                    "title": "检查词 " + str(title or ""),
                    "why": "合成关键词表",
                    "action": "seo.keyword_check",
                    "params": {"keyword": "sample keyword"},
                }
            ]
            if title == "second":
                rows.append(
                    {
                        "title": "拆长尾",
                        "why": "合成补充",
                        "action": "seo.longtail",
                        "params": {"keyword": "other"},
                    }
                )
            if title == "third":
                rows = []
            output = json.dumps({"scene": "seo", "suggestions": rows})
        elif "总结当前协作上下文" in text:
            output = json.dumps({"summary": "合成摘要"})
        else:
            output = json.dumps({"ready": True})
        update(output)
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session,
                    "update": {"sessionUpdate": "usage_update", "used": 200, "size": 40000},
                },
            }
        )
        result = {"stopReason": "end_turn"}
        if text != "/tools" and "NO_USAGE" not in text:
            usage += 11
            result["usage"] = {"totalTokens": usage, "inputTokens": usage - 3, "outputTokens": 3}
    else:
        send(
            {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32601, "message": "unknown"},
            }
        )
        continue
    if "id" in request:
        send({"jsonrpc": "2.0", "id": request["id"], "result": result})
