#!/usr/bin/env python3
"""Codex MCP / Skills 基准运行器；默认预览，--run 才调用模型。"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

from codex_events import parse_events
from score import correctness

ROOT = Path(__file__).resolve().parents[2]
TASKS = sorted((ROOT / "bench/agent/tasks").glob("*.md"))


def command(mode, workspace, runtime, model):
    argv = [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-C",
        str(workspace),
    ]
    if model:
        argv += ["--model", model]
    if mode == "mcp":
        config = {
            "command": sys.executable,
            "args": ["-B", str(runtime / "runtime/agent-link/fast_browser_link.py"), "--mcp"],
            "env": {"FAST_BROWSER_LINK_HOME": str(runtime)},
        }
        # 中文注释：只在本次进程注入 MCP，绝不安装或改写用户配置。
        toml = (
            "{command="
            + json.dumps(config["command"])
            + ",args="
            + json.dumps(config["args"])
            + ",env={FAST_BROWSER_LINK_HOME="
            + json.dumps(str(runtime))
            + "}}"
        )
        argv += ["-c", "mcp_servers.fast-browser-link=" + toml]
    return argv + ["-"]


def score_folder(folder):
    manifest = json.loads((folder / "manifest.json").read_text())
    tasks = []
    for entry in manifest["tasks"]:
        name = entry["name"]
        parsed = parse_events(
            (folder / f"{name}.events.jsonl").read_text().splitlines(), manifest["mode"]
        )
        tasks.append(
            {
                **entry,
                "efficiency": parsed["efficiency"],
                "correctness": correctness(
                    name,
                    json.loads((folder / f"{name}.log.json").read_text()),
                    folder / f"{name}.output",
                    parsed["response"],
                ),
            }
        )
    return {
        "kind": "agent",
        "version": 1,
        "label": manifest["label"],
        "runtime": "codex+" + manifest["mode"],
        "tasks": tasks,
    }


def run(args):
    runtime = args.runtime.expanduser().resolve()
    if not args.run:
        return {
            "status": "preview",
            "mode": args.mode,
            "tasks": [p.stem for p in TASKS],
            "argv": command(args.mode, Path("<temporary-workspace>"), runtime, args.model),
        }
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    manifest = {
        "label": args.label,
        "mode": args.mode,
        "tasks": [],
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for task in TASKS:
        with tempfile.TemporaryDirectory(prefix="fbl-codex-bench-") as tmp:
            workspace = Path(tmp)
            if args.mode == "skills":
                shutil.copytree(
                    ROOT / "skills/fast-browser-link",
                    workspace / ".agents/skills/fast-browser-link",
                )
                route = "先完整读取 .agents/skills/fast-browser-link/SKILL.md，只通过该技能的 scripts/browser.py 使用浏览器。"
            else:
                route = "只通过 MCP server fast-browser-link 的 fast_browser_link 使用浏览器。多步用 script；不通过 shell/HTTP/CDP 替代浏览器。"
            prompt = (
                task.read_text()
                .replace("{{ROOT}}", str(ROOT))
                .replace("{{PORT}}", str(args.port))
                .replace("{{OUTPUT}}", str(workspace / "result.output"))
            )
            prompt += (
                "\n"
                + route
                + "\n只使用此路由访问本地基准站；不得直接请求站点 API 或读取夹具源码。完成后 close 自己的任务并核对清理结果。\n"
            )
            (folder / f"{task.stem}.query.md").write_text(prompt)
            base = f"http://127.0.0.1:{args.port}"
            with urlopen(Request(base + "/__bench/reset", method="POST"), timeout=10) as response:
                response.read()
            start = time.monotonic()
            with (
                (folder / f"{task.stem}.events.jsonl").open("w") as events,
                (folder / f"{task.stem}.stderr.txt").open("w") as errors,
            ):
                result = subprocess.run(
                    command(args.mode, workspace, runtime, args.model),
                    input=prompt,
                    text=True,
                    stdout=events,
                    stderr=errors,
                    env={**os.environ, "FAST_BROWSER_LINK_HOME": str(runtime)},
                )
            elapsed = round((time.monotonic() - start) * 1000)
            output = workspace / "result.output"
            if output.is_file():
                shutil.copyfile(output, folder / f"{task.stem}.output")
            with urlopen(base + "/__bench/log", timeout=10) as response:
                (folder / f"{task.stem}.log.json").write_bytes(response.read())
            manifest["tasks"].append(
                {"name": task.stem, "exitCode": result.returncode, "harnessElapsedMs": elapsed}
            )
            (folder / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
            )
    result = score_folder(folder)
    (folder / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return {"status": "finished", "result": str(folder / "result.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["mcp", "skills"], required=True)
    parser.add_argument("--runtime", type=Path, default=Path.home() / ".fast-browser-link")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model")
    parser.add_argument("--label", default="codex")
    parser.add_argument("--output", type=Path, default=Path("bench/results/codex-run"))
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--score", type=Path, help="仅对已有事件与站点日志离线评分")
    args = parser.parse_args()
    result = score_folder(args.score) if args.score else run(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
