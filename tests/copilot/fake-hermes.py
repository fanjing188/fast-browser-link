#!/usr/bin/env python3
"""Hermes chat 替身：读取宿主任务文件，只写临时结果。"""

import json
from fake_result import judgment
from pathlib import Path
import signal
import subprocess
import sys
import time

args = sys.argv[1:]
query = Path(args[args.index("--query-file") + 1])
brief = json.loads(query.read_text())
dest = Path(brief["result_json_path"])
(query.parent / "argv.json").write_text(json.dumps(args))
print(
    json.dumps(
        {
            "type": "system",
            "subtype": "init",
            "model": args[args.index("-m") + 1] if "-m" in args else "fixture-default",
        }
    ),
    flush=True,
)
print(json.dumps({"type": "tool_use", "name": "fixture_browser_read"}), flush=True)
mode = brief["params"].get("task", brief["params"].get("keyword", ""))
if mode.startswith("sleep"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    (query.parent / "child.pid").write_text(str(child.pid))

    def stop(*_):
        child.wait(timeout=2)
        raise SystemExit(1)

    signal.signal(signal.SIGTERM, stop)
    time.sleep(30)
if mode == "bad_stream":
    print("not-json", flush=True)
    time.sleep(30)
if mode == "huge_stream":
    print("x" * 300000, flush=True)
    time.sleep(30)
time.sleep(0.05)
result = judgment(brief)
if mode == "bad_schema":
    result = {"verdict": 42}
if mode == "huge_result":
    result["process"] = ["x" * 150000]
dest.write_text(json.dumps(result))
print(
    json.dumps({"type": "tool_result", "name": "fixture_browser_read", "output": "synthetic"}),
    flush=True,
)
print(
    json.dumps(
        {"type": "result", "exit_code": 0, "text": json.dumps(result), "tokens": {"total": 23}}
    ),
    flush=True,
)
