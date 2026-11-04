"""审批与错误分类的纯离线协议测试。"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402


class BatchBContractTests(unittest.TestCase):
    def test_approval_pending_and_public_status(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as home:
            daemon = BridgeDaemon(Path(home))
            daemon.extensions["fixture"] = {"browser": "chrome"}
            daemon._notify_tasks_changed = lambda _: None
            task = daemon._create_task(
                {
                    "owner": "trusted",
                    "title": "fixture",
                    "instanceId": "fixture",
                    "allowedOrigins": ["https://example.test"],
                }
            )
            self.assertEqual(task["approval"]["status"], "pending")
            self.assertIsInstance(task["approval"]["requestedAt"], float)
            with self.assertRaises(ProtocolError) as caught:
                daemon._run_task(
                    {
                        "owner": "trusted",
                        "taskId": task["id"],
                        "requestId": "probe",
                        "action": "new_tab",
                        "url": "https://example.test",
                    }
                )
            self.assertEqual(caught.exception.code, "approval_pending")
            self.assertEqual(caught.exception.data["category"], "site")
            self.assertTrue(caught.exception.data["retryable"])
            self.assertFalse(caught.exception.data["outcomeUnknown"])
            # 用户批准后，工作区授权仍在安装时只能报告准备中。
            daemon.tasks[task["id"]].update(state="authorizing", approvalStatus="approved")
            preparing = daemon._public_task(daemon.tasks[task["id"]])
            self.assertEqual(preparing["approval"]["status"], "approved")
            with self.assertRaises(ProtocolError) as preparing_error:
                daemon._run_task(
                    {
                        "owner": "trusted",
                        "taskId": task["id"],
                        "requestId": "preparing-probe",
                        "action": "new_tab",
                        "url": "https://example.test",
                    }
                )
            self.assertEqual(preparing_error.exception.code, "task_preparing")
            self.assertTrue(preparing_error.exception.data["retryable"])
            daemon.tasks[task["id"]].update(state="pending_approval", approvalStatus="pending")
            denied = daemon._dispatch_extension(
                "fixture", "extension.reject", {"taskId": task["id"]}
            )
            self.assertEqual(denied["approval"]["status"], "denied")

    def test_protocol_error_categories(self):
        for code, category in (
            ("invalid_params", "usage"),
            ("captcha_required", "site"),
            ("extension_disconnected", "plugin"),
            ("bridge_execution_failed", "plugin"),
        ):
            with self.subTest(code=code):
                error = ProtocolError(code, "private page content")
                self.assertEqual(error.data["category"], category)
                self.assertIsInstance(error.data["retryable"], bool)
                self.assertIsInstance(error.data["hint"], str)


if __name__ == "__main__":
    unittest.main()
