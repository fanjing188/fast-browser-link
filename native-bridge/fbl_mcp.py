"""通过 agent 官方 CLI 安装 MCP；默认只生成可审阅命令。"""

import json
from pathlib import Path
import shlex
import subprocess
import sys

NAME = "fast-browser-link"


def install(ctx, agent, *, apply=False, dry_run=False, run=subprocess.run):
    entry = Path(ctx.runtime) / "runtime/agent-link/fast_browser_link.py"
    command = [agent, "mcp", "add"]
    if agent == "claude":
        command += ["--scope", "user", "--transport", "stdio"]
    command += [
        NAME,
        "--env",
        "FAST_BROWSER_LINK_HOME=" + str(ctx.runtime),
        "--",
        sys.executable,
        "-B",
        str(entry),
        "--mcp",
    ]
    result = {"agent": agent, "argv": command, "command": shlex.join(command), "status": "preview"}
    if not apply or dry_run:
        return result
    if not entry.is_file():
        raise ValueError("MCP runtime missing; run setup or update first")
    if agent == "codex":
        probe = run([agent, "mcp", "list", "--json"], capture_output=True, text=True, check=True)
        rows = json.loads(probe.stdout)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("cannot verify existing MCP configuration")
        exists = any(row.get("name") == NAME for row in rows)
    else:
        probe = run([agent, "mcp", "get", NAME], capture_output=True, text=True)
        exists = probe.returncode == 0
        if not exists and not (
            probe.returncode == 1
            and "No MCP server found with name:" in probe.stderr + probe.stdout
        ):
            raise ValueError("cannot verify existing MCP configuration")
    if exists:
        return {**result, "status": "already_exists"}
    run(command, check=True, stdout=sys.stderr)
    return {**result, "status": "installed"}
