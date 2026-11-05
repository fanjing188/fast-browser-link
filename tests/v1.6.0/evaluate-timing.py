"""中文注释：真实 script 子进程与 host bridge，使用合成 daemon 的离线计时。"""

import importlib.util
import json
from pathlib import Path
import statistics
import tempfile
import time
import sys

path = Path(__file__).resolve().parents[1] / "v1.1-script-lane" / "test_script_tool.py"
spec = importlib.util.spec_from_file_location("evaluate_timing_fixture", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = module.ScriptToolTests(methodName="test_semantic_helpers_batch_through_real_child_and_host")
case.setUp()
try:
    case.bind()
    case.runtime.tab_ids = [7]
    original_call = case.runtime.call
    original_helper = module.host_bridge.HostBridge._helper_reply
    host_times = []
    daemon_times = []

    def call(method, params):
        start = time.perf_counter()
        try:
            if method == "shared.run" and params.get("action") == "js.evaluate":
                return {"ok": True, "value": 1}
            return original_call(method, params)
        finally:
            if method == "shared.run" and params.get("action") == "js.evaluate":
                daemon_times.append((time.perf_counter() - start) * 1000)

    def helper(request, *args):
        start = time.perf_counter()
        try:
            return original_helper(request, *args)
        finally:
            if request.get("op") == "run" and request.get("args", [None])[0] == "js.evaluate":
                host_times.append((time.perf_counter() - start) * 1000)

    case.runtime.call = call
    module.host_bridge.HostBridge._helper_reply = staticmethod(helper)
    result = case.run_script(
        "import time, json\n"
        "samples=[]\n"
        "for i in range(50):\n"
        " start=time.perf_counter()\n"
        " evaluate('()=>1')\n"
        " samples.append((time.perf_counter()-start)*1000)\n"
        "print(json.dumps(samples))\n"
    )
    if result.get("exit_code") != 0:
        raise RuntimeError(
            "synthetic script failed: " + str(result.get("error") or result.get("stderr"))
        )
    child_times = json.loads(result["stdout"])
    for name, values in (
        ("child_roundtrip", child_times),
        ("host_inclusive", host_times),
        ("synthetic_daemon", daemon_times),
    ):
        print(f"{name} count={len(values)} median_ms={statistics.median(values):.4f}")
finally:
    case.doCleanups()

# 中文注释：单独测真实守护进程的派发账本 fsync，数据全部是临时合成记录。
sys.path.insert(0, str(path.parents[1] / "native-bridge"))
from daemon import BridgeDaemon  # noqa: E402

with tempfile.TemporaryDirectory(prefix="fbl-timing-") as directory:
    daemon = BridgeDaemon(Path(directory))
    daemon.data_dir.mkdir(parents=True, mode=0o700)
    task = {"id": "synthetic", "state": "running", "requestHistory": []}
    timings = []
    for i in range(50):
        start = time.perf_counter()
        daemon._persist_dispatched(task, {"sequence": i, "state": "dispatched"})
        timings.append((time.perf_counter() - start) * 1000)
    print(f"daemon_journal_fsync count={len(timings)} median_ms={statistics.median(timings):.4f}")
