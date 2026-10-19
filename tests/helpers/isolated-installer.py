"""中文注释：仅供临时安装夹具使用的解释器入口，不随发行包安装。"""

import json
import os
from pathlib import Path
import pwd
import re
import runpy
import subprocess
import sys

user_home, runtime_home = map(Path, sys.argv[1:3])
# 中文注释：忽略 TMPDIR；CI 临时根只在 Actions 中启用，且不能覆盖系统账户的真实 HOME。
temporary_roots = {Path("/tmp").resolve()}
if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_TEMP"):
    runner_temp = Path(os.environ["RUNNER_TEMP"])
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    if runner_temp.is_absolute() and not account_home.is_relative_to(runner_temp.resolve()):
        temporary_roots.add(runner_temp.resolve())
for root in (user_home, runtime_home):
    resolved = root.resolve()
    if not (
        any(resolved != root and resolved.is_relative_to(root) for root in temporary_roots)
        or re.match(r"^/private/var/folders/[^/]+/[^/]+/T/.+", str(resolved))
    ):
        sys.exit("test interpreter requires temporary roots")
if Path(os.environ["HOME"]).resolve() != user_home.resolve() or Path(
    os.environ["HERMES_HOME"]
).resolve() not in (
    runtime_home.resolve(),
    *runtime_home.resolve().glob("profiles/*"),
):
    sys.exit("test interpreter refuses non-fixture HOME/HERMES_HOME")

original_run = subprocess.run
table = json.loads(os.environ.get("FBL_TEST_PROCESSES", "{}"))


def run(argv, *args, **kwargs):
    if Path(argv[0]).name != "ps":
        return original_run(argv, *args, **kwargs)
    # 中文注释：所有 ps 形式均在这里截断；未知形式直接失败，不能回退到真实进程表。
    if argv == ["/bin/ps", "-axo", "command="]:
        output = "\n".join(table.get("applications", []))
        status = 0
    elif len(argv) == 5 and argv[1:2] == ["-p"] and argv[3:] == ["-o", "command="]:
        output = table.get("pids", {}).get(argv[2], "")
        status = 0 if output else 1
    elif argv == ["ps", "-U", str(os.getuid()), "-o", "lstart=,comm="]:
        output, status = table.get("browserEpoch", ""), 0
    else:
        raise AssertionError("unexpected process probe: " + repr(argv))
    with (user_home / "process-probes.jsonl").open("a") as log:
        log.write(json.dumps(argv) + "\n")
    return subprocess.CompletedProcess(argv, status, output, "")


subprocess.run = run
sys.argv = sys.argv[3:]
if sys.argv[0] == "-c":
    code = sys.argv[1]
    sys.argv = ["-c", *sys.argv[2:]]
    exec(compile(code, "<isolated-installer>", "exec"), {"__name__": "__main__"})
else:
    sys.path.insert(0, str(Path(sys.argv[0]).resolve().parent))
    runpy.run_path(sys.argv[0], run_name="__main__")
