"""真实临时 daemon 的负向入口探测；不派发成功的写操作、不改账本或运行时。"""

import importlib.util
import json
from pathlib import Path
import sys


def main():
    plugin, home, task_id, tab_id, work = sys.argv[1:]
    home = Path(home).resolve()
    # 中文注释：owner 仅从本次临时账本读取，用猜中身份的最强条件验证产品任务拒绝普通入口。
    ledger = json.loads((home / "plugin-data/fast-browser-link-native/tasks.json").read_text())
    task = next(row for row in ledger["tasks"] if row["id"] == task_id)
    if task.get("executionLane") != "product_fill":
        raise RuntimeError("expected an actual product_fill task")
    module_path = Path(plugin).resolve() / "native_bridge/client.py"
    if not module_path.is_relative_to(home) and not module_path.is_relative_to(
        Path(work).resolve()
    ):
        raise RuntimeError("client must be staged under the fixture home or work directory")
    spec = importlib.util.spec_from_file_location("product_fill_denial_client", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.BridgeClient(home, timeout=10, autostart=False)
    owner = task["owner"]
    scope = {"owner": owner, "taskId": task_id}
    probes = [
        (
            "js",
            "shared.run",
            {
                **scope,
                "requestId": "denied-js",
                "tabId": int(tab_id),
                "action": "js.evaluate",
                "expression": "document.title",
            },
        ),
        (
            "cdp",
            "shared.run",
            {
                **scope,
                "requestId": "denied-cdp",
                "tabId": int(tab_id),
                "action": "cdp.send",
                "method": "Runtime.evaluate",
                "params": {"expression": "document.title"},
            },
        ),
        ("gateway", "shared.cdp_gateway", scope),
    ]
    receipts = []
    try:
        for label, method, params in probes:
            try:
                client.call(method, params)
            except module.BridgeError as error:
                if error.code != "execution_lane_denied":
                    raise RuntimeError(f"{label}: unexpected denial {error.code}") from error
                receipts.append({"entry": label, "code": error.code})
            else:
                raise RuntimeError(f"{label}: product task unexpectedly accepted a public entry")
    finally:
        client.close()
    print(json.dumps(receipts))


if __name__ == "__main__":
    main()
