"""中文注释：任务直接读取、跨站导航与租约和模式代次隔离回归。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-bridge"))
from daemon import BridgeDaemon, ProtocolError

SITE_A = "https://site-a.test"
SITE_B = "https://site-b.test"


class SiteReadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name))
        self.daemon._prepare_data_dir()
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon.extensions["browser"] = {"browser": "chrome"}
        self.daemon._notify_tasks_changed = lambda _: None
        created = self.daemon._dispatch_client(
            "shared.create",
            {
                "owner": "owner",
                "title": "站点读取测试",
                "instanceId": "browser",
                "allowedOrigins": [SITE_A, SITE_B],
            },
        )
        self.task = self.daemon._dispatch_extension(
            "browser",
            "extension.approve",
            {"taskId": created["id"], "tabIds": [7], "allowedOrigins": created["allowedOrigins"]},
        )
        self.origins = {7: SITE_A, 8: SITE_B}
        self.executed = []

        def extension_call(_extension, method, params, **_kwargs):
            if method == "browser.read_origin":
                return {"origin": self.origins[params["tabId"]]}
            if method == "browser.execute":
                self.executed.append((params["action"], params.get("approvedReadOrigin")))
                if params["action"] == "new_tab":
                    return {
                        "tabId": 8,
                        "url": SITE_B + "/new",
                        "ready": True,
                        "groupId": 3,
                        "windowId": 4,
                    }
                if params["action"] == "tabs":
                    return [{"id": 7}]
                return {"site": self.origins.get(params.get("tabId"), SITE_B)}
            if method == "browser.release":
                return {
                    "released": True,
                    "cleanupState": "succeeded",
                    "remainingTabIds": [],
                    "preservedTabIds": [],
                    "unknownTabIds": [],
                }
            raise AssertionError(method)

        self.daemon._extension_call = extension_call

    def run_action(self, action="snapshot", tab_id=7, request_id="read-1", **extra):
        return self.daemon._dispatch_client(
            "shared.run",
            {
                "owner": "owner",
                "taskId": self.task["id"],
                "requestId": request_id,
                "action": action,
                **({} if tab_id is None else {"tabId": tab_id}),
                **extra,
            },
        )

    def test_first_and_cross_site_reads_execute_without_approval(self):
        self.assertEqual(self.run_action("tabs", tab_id=None, request_id="tabs"), [{"id": 7}])
        self.assertEqual(self.run_action(), {"site": SITE_A})
        self.assertEqual(self.run_action(request_id="read-2"), {"site": SITE_A})
        self.origins[7] = "https://new-site.test"
        self.assertEqual(self.run_action(request_id="new-site"), {"site": self.origins[7]})
        self.assertEqual(self.daemon._dispatch_extension("browser", "extension.approvals", {}), [])

    def test_navigation_reads_and_writes_execute_directly_without_replay(self):
        self.assertEqual(
            self.run_action("new_tab", tab_id=None, request_id="open-b", url=SITE_B + "/new")[
                "tabId"
            ],
            8,
        )
        self.assertEqual(self.run_action(tab_id=8, request_id="read-b"), {"site": SITE_B})
        for request_id in ("write-1", "write-1", "write-2"):
            self.assertEqual(
                self.run_action("click", tab_id=8, request_id=request_id, selector="#save"),
                {"site": SITE_B},
            )
        self.assertEqual(sum(action == "click" for action, _ in self.executed), 2)
        self.assertEqual(self.daemon.action_approvals, {})

    def test_navigation_destination_read_needs_no_approval(self):
        self.run_action("navigate", request_id="navigate-b", url=SITE_B + "/inbox")
        self.origins[7] = SITE_B
        self.assertEqual(self.run_action(request_id="destination-read"), {"site": SITE_B})
        self.assertEqual(self.daemon.action_approvals, {})

    def test_mode_change_and_task_end_clear_site_read_grants(self):
        self.assertEqual(self.run_action(), {"site": SITE_A})
        self.assertEqual(self.run_action(request_id="same-site"), {"site": SITE_A})
        task = self.daemon.tasks[self.task["id"]]
        for mode in ("full", "smart"):
            self.daemon._dispatch_extension(
                "browser",
                "extension.mode",
                {
                    "taskId": task["id"],
                    "generation": task["generation"],
                    "modeGeneration": task["modeGeneration"],
                    "mode": mode,
                },
            )
        self.assertEqual(task["readOrigins"], [])
        with self.assertRaises(ProtocolError) as stale:
            self.run_action(request_id="same-site")
        self.assertEqual(stale.exception.code, "approval_revoked")
        self.assertEqual(self.run_action(request_id="again"), {"site": SITE_A})
        self.daemon._dispatch_client("shared.cancel", {"owner": "owner", "taskId": task["id"]})
        self.assertEqual(task["readOrigins"], [])
        with self.assertRaises(ProtocolError):
            self.run_action(request_id="after-stop")

    def test_foreign_task_cannot_read_leased_page(self):
        self.daemon.tab_leases[("browser", 7)] = "other-task"
        with self.assertRaises(ProtocolError) as foreign:
            self.run_action(request_id="foreign")
        self.assertEqual(foreign.exception.code, "foreign_tab")
        self.assertEqual(self.executed, [])

    def test_task_owned_blank_page_needs_no_site_read_grant(self):
        # 中文注释：空白工作页没有网站来源，不生成网站读取批准。
        self.origins[7] = "about:blank"
        self.assertEqual(
            self.run_action("official.ready_state", request_id="blank"), {"site": "about:blank"}
        )
        self.assertEqual(self.daemon._dispatch_extension("browser", "extension.approvals", {}), [])


if __name__ == "__main__":
    unittest.main()
