"""由用户运行：一次模型调用测量执行 profile 的提示包络，不修改 profile。"""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile


def measure(command="hermes", profile="fast-copilot", root=None, timeout=180):
    env = {**os.environ, "HERMES_HOME": str(Path(root or Path.home() / ".hermes").expanduser())}
    argv = [
        command,
        "-p",
        profile,
        "chat",
        "--oneshot",
        "-Q",
        "--format",
        "stream-json",
        "-t",
        "fast-browser-link,web,terminal,file",
        "--max-turns",
        "1",
        "-q",
        "不要调用任何工具，只回复 OK。",
    ]
    with tempfile.TemporaryDirectory(prefix="copilot-measure-") as directory:
        process = subprocess.Popen(
            argv,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=directory,
        )
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise RuntimeError("measurement timed out")
        if process.returncode:
            raise RuntimeError(
                "Hermes exited with code " + str(process.returncode) + "; no measurement obtained"
            )
        result = None
        for line in output.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "tool_use":
                raise RuntimeError("model called a tool; this is not a single prompt measurement")
            if event.get("type") == "result":
                result = event
        if not result or result.get("error") or result.get("exit_code") != 0:
            raise RuntimeError("successful stream-json result unavailable")
        tokens = result.get("tokens", {})
        if not all(type(tokens.get(key)) is int for key in ("input", "cache_read", "output")):
            raise RuntimeError("detailed token counters unavailable; do not claim measured size")
        envelope = tokens["input"] + tokens["cache_read"]
        return {
            "profile": profile,
            "usage": tokens,
            "prompt_envelope_tokens": envelope,
            "within_8000": envelope <= 8000,
            "scope": "One-turn prompt envelope includes system, tool schemas and tiny query; upper bound for system alone.",
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", default="hermes")
    parser.add_argument("--profile", default="fast-copilot")
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    print(json.dumps(measure(args.command, args.profile, args.root), ensure_ascii=False, indent=2))
