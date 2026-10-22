"""真实 Native 管道、daemon 和合成 ACP 的隔离重放；不接触个人安装。"""

import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
import tempfile
import contextlib
import io
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot, private_write
from copilot_setup import setup
from daemon import BridgeDaemon, ProtocolError, _extension_frames, _encode_line
from host import record_exit
from tests.support import temporary_bridge_home
from client import socket_address

ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
R20B_OBSERVATION = {
    "trace": [],
    "page": {"url": "https://example.test/" + "f" * 72, "title": "third", "items": []},
}


def assert_first_empty_inference(case, entries):
    requests = [
        json.loads(line)
        for line in (case.app.directory / "acp-requests.jsonl").read_text().splitlines()
    ]
    inference = []
    for request in requests:
        if request.get("method") != "session/prompt":
            continue
        text = request["params"]["prompt"][0]["text"]
        try:
            payload = json.loads(text)
        except ValueError:
            continue
        if payload.get("type") == "infer":
            inference.append((text, payload))
    case.assertEqual(len(inference), 1)
    text, payload = inference[0]
    case.assertTrue(all(value == "pending" for value in payload["statuses"].values()))
    case.assertTrue(
        all(
            row["action"] == "assist.task" and not row["params"]["materials"]
            for row in payload["suggestions"]
        )
    )
    case.assertEqual(len(payload["statuses"]), len(payload["suggestions"]))
    case.assertEqual(payload["page"], {**R20B_OBSERVATION["page"], "truncated": False})
    sent = next(
        row
        for row in entries
        if row["event"] == "inference_send" and row["details"].get("phase") == "inference"
    )
    case.assertEqual(sent["details"]["increment_bytes"], len(text.encode("utf-8")))


class Replay(unittest.TestCase):
    def setUp(self):
        self.home = self.enterContext(temporary_bridge_home())
        self.daemon = BridgeDaemon(self.home)
        self.data = self.daemon.data_dir
        self.data.mkdir(parents=True)
        (self.data / "token").write_text("fixture-token")
        (self.data / "host-config.json").write_text(json.dumps({"allowedOrigins": [ORIGIN]}))
        directory = self.data / "copilot"
        setup(directory)
        config = json.loads((directory / "config.json").read_text())
        config.update(
            acp_command=[sys.executable, str(ROOT / "tests/copilot/fake-acp.py")],
            exec_transport="oneshot",
            timeout_seconds=3,
        )
        private_write(directory / "config.json", json.dumps(config))
        self.app = Copilot(
            directory,
            lambda target, event: self.daemon._send_extension(
                self.daemon.extensions[target], {"method": "copilot.changed", "params": event}
            )
            if target in self.daemon.extensions
            else None,
        )
        self.daemon.copilot = self.app
        self.addCleanup(self.app.close)
        self.server = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.server.close)
        self.server.bind(socket_address(self.data / "bridge.sock"))
        self.server.listen(4)
        self.frames = []
        self.workers = []
        self.processes = []
        self.addCleanup(self.cleanup)
        self.connect()

    def cleanup(self):
        for process in self.processes:
            if process.poll() is None:
                process.stdin.close()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
        for worker in self.workers:
            worker.join(timeout=2)

    def connect(self):
        script = "import sys; sys.path.insert(0,sys.argv.pop(1)); import host; host.ensure_service=lambda _:None; raise SystemExit(host.main())"
        self.process = subprocess.Popen(
            [sys.executable, "-B", "-c", script, str(ROOT / "native-bridge"), ORIGIN],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "HERMES_HOME": str(self.home)},
        )
        self.processes.append(self.process)
        self.server.settimeout(3)
        conn, _ = self.server.accept()
        worker = threading.Thread(
            target=self.daemon._serve_connection, args=(conn, "fixture-token"), daemon=True
        )
        worker.start()
        self.workers.append(worker)
        self.request(
            "extension.hello", {"instanceId": "fixture", "browser": "edge", "version": "fixture"}
        )

    def read(self):
        def exact(size):
            value = bytearray()
            deadline = time.monotonic() + 5
            while len(value) < size:
                self.assertTrue(
                    select.select(
                        [self.process.stdout], [], [], max(0, deadline - time.monotonic())
                    )[0],
                    "native read timeout",
                )
                chunk = os.read(self.process.stdout.fileno(), size - len(value))
                self.assertTrue(chunk, "native host closed")
                value.extend(chunk)
            return value

        size = struct.unpack("<I", exact(4))[0]
        value = json.loads(exact(size))
        self.frames.append(
            {
                "type": value.get("params", {}).get("type", value.get("method", "response")),
                "bytes": size,
            }
        )
        if hasattr(self, "inference_frames"):
            self.inference_frames.append(value)
        return value

    def request(self, method, params):
        identity = str(len(self.frames)) + str(time.monotonic_ns())
        payload = json.dumps({"id": identity, "method": method, "params": params}).encode()
        self.process.stdin.write(struct.pack("<I", len(payload)) + payload)
        self.process.stdin.flush()
        while True:
            value = self.read()
            if value.get("id") == identity:
                self.assertNotIn("error", value)
                return value["result"]

    def test_00_inference_return_after_thirty_seconds(self):
        self.inference_frames = []
        self.app.config["acp_command"].append("--empty-inference-delay")
        self.app.config["timeout_seconds"] = 5
        self.request("extension.copilot.settings", {"enabled": True})
        deadline = time.monotonic() + 6
        while not self.app.view("fixture")["ready"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.app.view("fixture")["ready"])
        connected = time.monotonic()
        # 中文注释：真实静默30秒，不用轮询/心跳改变现场的空闲条件；随后才触发首轮推理。
        while time.monotonic() - connected < 30:
            self.assertIsNone(self.process.poll())
            time.sleep(0.25)
        self.assertGreaterEqual(time.monotonic() - connected, 30)
        before = len(self.inference_frames)
        self.request("extension.copilot.observe", R20B_OBSERVATION)
        deadline = time.monotonic() + 6
        while self.app.view("fixture")["last_refresh"] is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(self.app.view("fixture")["last_refresh"])
        time.sleep(0.3)
        state = self.request("extension.copilot.state", {})
        self.assertTrue(state["enabled"])
        self.assertTrue(state["ready"])
        # 中文注释：空模型建议仍可保留本地有证据的采集入口，不能自动读页或执行。
        self.assertTrue(
            all(
                row.get("capture_required")
                and row["recommendation_state"]
                == ("ready" if row["action"] == "native.tool" else "needs_parameters")
                for row in state["suggestions"]
            )
        )
        logs = self.request("extension.copilot.logs_read", {})["entries"]
        receipt = next(
            row for row in logs if row["event"] == "inference_return" and "added" in row["details"]
        )
        self.assertEqual(
            [receipt["details"][key] for key in ("added", "removed", "updated")], [0, 0, 0]
        )
        self.assertGreaterEqual(receipt["details"]["duration_ms"], 2500)
        assert_first_empty_inference(self, logs)
        self.assertTrue(all(row["bytes"] <= 512 * 1024 for row in self.frames))
        self.assertIsNone(self.process.poll())
        events = [
            message["params"]
            for message in self.inference_frames[before:]
            if message.get("method") == "copilot.changed"
        ]
        self.assertTrue(
            any(event["type"] == "inference" and event.get("succeeded") for event in events)
        )
        print("R20B_NATIVE_FRAME_SIZES=" + json.dumps(self.frames))

    def test_replay_all_pushes(self):
        self.request("extension.copilot.settings", {"enabled": True})
        deadline = time.monotonic() + 6
        while not self.app.view("fixture")["ready"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.app.view("fixture")["ready"])
        # 中文注释：由生产事件入口推送各类合成数据，记录每一帧，未知事件由真实 JS Bridge 另行重放。
        for event, values in (
            ("capabilities", {}),
            ("basket", {"basket": self.app.basket.snapshot()}),
            ("progress", {"id": "fixture-task", "progress": {"type": "tool_use", "name": "scan"}}),
            (
                "update",
                {
                    "suggestion": {
                        "id": "fixture-task",
                        "action": "workflow.run",
                        "status": "executing",
                        "workflow_index": 1,
                        "step": "读取表格",
                    }
                },
            ),
        ):
            self.app._emit("fixture", event, **values)
        for index in range(30):
            self.app.journal.add("fixture", "table", rows=index)
        self.request("extension.copilot.capability_state", {})
        self.request(
            "extension.copilot.annotation_lookup",
            {"objects": [{"type": "keyword", "value": "synthetic"}]},
        )
        time.sleep(0.3)
        for _ in range(15):
            self.request("extension.copilot.state", {})
            time.sleep(1)
        self.assertIsNone(self.process.poll())
        print("R20_FRAME_SIZES=" + json.dumps(self.frames))

    def test_large_push_reconnect_and_diagnostics(self):
        self.request("extension.copilot.settings", {"enabled": True})
        deadline = time.monotonic() + 5
        while not self.app.view("fixture")["ready"] and time.monotonic() < deadline:
            time.sleep(0.01)
        old = self.app.runtime
        with self.app.lock:
            self.app._state("fixture")["summary"] = "synthetic-resume-summary"
        payload = {
            "method": "copilot.changed",
            "params": {"type": "logs", "entries": [{"summary": "合成" * 200000}]},
        }
        sender = threading.Thread(
            target=self.daemon._send_extension, args=(self.daemon.extensions["fixture"], payload)
        )
        sender.start()
        chunks = []
        while not chunks or len(chunks) < chunks[0]["total"]:
            value = self.read()
            if value.get("method") == "bridge.chunk":
                chunks.append(value["params"])
        sender.join(timeout=2)
        self.assertEqual(json.loads("".join(row["text"] for row in chunks)), payload)
        self.assertTrue(all(row["bytes"] <= 512 * 1024 for row in self.frames))
        self.process.stdin.close()
        self.process.wait(timeout=2)
        deadline = time.monotonic() + 3
        while "fixture" in self.daemon.extensions and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.app.view("fixture")["enabled"])
        self.connect()
        deadline = time.monotonic() + 5
        while not self.app.view("fixture")["ready"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.app.view("fixture")["ready"])
        self.assertIsNot(self.app.runtime, old)
        self.assertEqual(self.app._state("fixture")["summary"], "synthetic-resume-summary")
        self.request(
            "extension.copilot.bridge_error",
            {"message": "Native host has exited.", "disconnected_at": 123456},
        )
        logs = self.app.journal.view("fixture")["entries"]
        self.assertTrue(any(row["event"] == "bridge_restored" for row in logs))
        self.assertTrue(
            any(row["details"].get("bridge_error") == "Native host has exited." for row in logs)
        )
        self.assertTrue((self.data / "diagnostics/host-exits.jsonl").is_file())
        for index in range(2):
            self.process.stdin.close()
            self.process.wait(timeout=2)
            deadline = time.monotonic() + 3
            while "fixture" in self.daemon.extensions and time.monotonic() < deadline:
                time.sleep(0.01)
            self.connect()
            deadline = time.monotonic() + 5
            while (
                not self.app.view("fixture")["ready"]
                and not self.app.view("fixture")["bridge_recovery_blocked"]
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            self.assertTrue(self.app.view("fixture")["enabled"])
            self.assertEqual(self.app.view("fixture")["bridge_recovery_blocked"], index == 1)


class Local(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp).resolve()
        setup(self.root / "copilot")
        self.app = Copilot(self.root / "copilot")
        self.addCleanup(self.app.close)
        self.daemon = BridgeDaemon(self.root)
        self.daemon.data_dir.mkdir(parents=True)
        self.daemon.extensions["fixture"] = {"instanceId": "fixture", "browser": "edge"}
        self.daemon._notify_tasks_changed = lambda _: None
        self.addCleanup(self.daemon._flush_tasks)

    def task(self):
        value = self.daemon._create_task(
            {
                "owner": "fixture-owner",
                "title": "synthetic",
                "instanceId": "fixture",
                "allowedOrigins": ["https://example.test"],
            }
        )
        task = self.daemon.tasks[value["id"]]
        task.update(state="ready", activeMode="full", silent=True)
        return task

    def test_pagination_sizes_and_baseline_limit_evidence(self):
        from host import write_native_message
        import io

        value = {
            "method": "copilot.changed",
            "params": {"type": "logs", "entries": [{"summary": "合成" * 200000}]},
        }
        with self.assertRaisesRegex(ValueError, "payload too large"):
            _encode_line(value)
        with self.assertRaisesRegex(ValueError, "exceeds limit"):
            write_native_message(io.BytesIO(), value, threading.Lock())
        frames = list(_extension_frames(value))
        self.assertGreater(len(frames), 1)
        self.assertTrue(all(len(_encode_line(frame)) <= 512 * 1024 for frame in frames))
        self.assertEqual(json.loads("".join(frame["params"]["text"] for frame in frames)), value)
        sent = []
        sink = type("Socket", (), {"sendall": lambda _self, data: sent.append(data)})()
        extension = {"instanceId": "fixture", "socket": sink, "sendLock": threading.RLock()}
        self.daemon.copilot = self.app
        self.daemon._send_extension(extension, value)
        self.daemon._send_extension(extension, {"id": "large", "result": "x" * (17 * 1024 * 1024)})
        self.assertTrue(all(len(frame) < 512 * 1024 for frame in sent))
        diagnostic = (self.daemon.data_dir / "diagnostics/events.jsonl").read_text()
        self.assertIn("message_chunked", diagnostic)
        self.assertIn("message_too_large", diagnostic)
        self.assertTrue(
            any(
                row["event"] == "bridge_warning"
                for row in self.app.journal.view("fixture")["entries"]
            )
        )
        print(
            "R20_OVERSIZE="
            + json.dumps(
                {
                    "original": len(
                        json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
                    ),
                    "frames": [len(_encode_line(frame)) - 1 for frame in frames],
                }
            )
        )

    def test_bridge_breaker_preserves_summary_and_does_not_replay(self):
        state = self.app._state("fixture")
        self.app.active = "fixture"
        state.update(
            enabled=True,
            ready=True,
            summary="resume summary",
            execution_memory=[{"verdict": "done"}],
        )
        state["suggestions"] = {
            "in-flight": {"id": "in-flight", "action": "general.task", "status": "executing"},
            "queued": {"id": "queued", "action": "general.task", "status": "queued"},
        }
        with (
            patch.object(self.app, "_activate") as activate,
            patch.object(self.app, "_execute") as execute,
        ):
            for index in range(3):
                self.app.bridge_connection("fixture", False)
                self.assertTrue(state["enabled"])
                self.assertFalse(state["ready"])
                self.app.bridge_connection("fixture", True)
                deadline = time.monotonic() + 1
                while activate.call_count < min(index + 1, 2) and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.assertEqual(activate.call_count, 2)
            self.assertTrue(state["bridge_recovery_blocked"])
            self.assertEqual(state["summary"], "resume summary")
            self.assertEqual(state["suggestions"]["in-flight"]["status"], "stopping")
            self.assertEqual(state["suggestions"]["queued"]["status"], "stopped")
            execute.assert_not_called()
            self.app.request("fixture", "settings", {"enabled": False})
            self.assertFalse(state["enabled"])
        logs = self.app.journal.view("fixture")["entries"]
        self.assertEqual(sum(row["event"] == "bridge_recovery_stopped" for row in logs), 1)

    def test_real_acp_resume_and_execution_push_sizes(self):
        messages = []
        self.app.notify = lambda _instance, event: messages.append(
            {"method": "copilot.changed", "params": event}
        )
        fake = self.root / "hermes"
        fake.write_bytes((ROOT / "tests/copilot/fake-hermes.py").read_bytes())
        fake.chmod(0o700)
        (self.root / "fake_result.py").write_bytes(
            (ROOT / "tests/copilot/fake_result.py").read_bytes()
        )
        self.app.config.update(
            acp_command=[sys.executable, str(ROOT / "tests/copilot/fake-acp.py")],
            hermes_command=str(fake),
            exec_transport="oneshot",
            timeout_seconds=3,
        )

        def wait(check):
            end = time.monotonic() + 5
            while not check() and time.monotonic() < end:
                time.sleep(0.01)
            self.assertTrue(check())

        self.app.request("fixture", "settings", {"enabled": True})
        wait(lambda: self.app.view("fixture")["ready"])
        self.assertEqual(self.app.view("fixture")["hermes_health"]["state"], "connected")
        with self.app.lock:
            self.app._state("fixture")["summary"] = "synthetic resume summary"
        self.app.bridge_connection("fixture", False)
        self.app.bridge_connection("fixture", True)
        wait(lambda: self.app.view("fixture")["ready"])
        self.assertTrue(self.app.view("fixture")["bridge_restored"])
        requests = [
            json.loads(line)
            for line in (self.app.directory / "acp-requests.jsonl").read_text().splitlines()
        ]
        self.assertTrue(any("synthetic resume summary" in json.dumps(row) for row in requests))
        with patch.dict(self.app._state("fixture"), ready=False):
            self.app.request(
                "fixture", "quick_task", {"action": "general.task", "params": {"task": "fixture"}}
            )
        row = next(
            row
            for row in self.app._state("fixture")["suggestions"].values()
            if row["action"] == "general.task" and row["params"].get("task") == "fixture"
        )
        self.app.request("fixture", "execute", {"id": row["id"]})
        wait(lambda: row["status"] in {"completed", "failed"})
        self.assertEqual(row["status"], "completed", row)
        self.app._emit("fixture", "capabilities")
        self.app.request(
            "fixture",
            "basket_add",
            {"items": [{"type": "keyword", "value": "synthetic", "source": "fixture"}]},
        )
        responses = {
            name: self.app.request("fixture", name, params)
            for name, params in (
                ("state", {}),
                ("capability_state", {}),
                ("annotation_lookup", {"objects": [{"type": "keyword", "value": "synthetic"}]}),
                ("basket_state", {}),
            )
        }
        time.sleep(0.3)
        measurements = [
            {"type": m["params"]["type"], "bytes": len(_encode_line(m)) - 1} for m in messages
        ]
        measurements += [
            {
                "type": "response." + name,
                "bytes": len(_encode_line({"id": "fixture", "result": value})) - 1,
            }
            for name, value in responses.items()
        ]
        self.assertTrue(any(row["type"] == "progress" for row in measurements))
        self.assertTrue(all(row["bytes"] <= 512 * 1024 for row in measurements))
        print("R20_PRODUCTION_PAYLOAD_SIZES=" + json.dumps(measurements))

    def test_empty_first_inference_notifications_and_state_readback(self):
        self.r20b_messages = []

        def notify(_instance, event):
            with self.app.lock:
                if self.app.closed:
                    return
                self.r20b_messages.append(
                    {
                        "method": "copilot.changed",
                        "params": json.loads(json.dumps(event, allow_nan=False)),
                    }
                )
                # 中文注释：模拟扩展/侧栏收到事件后回读state，保留真实生产view而非手写状态。
                self.r20b_messages.append(
                    {"id": "state-readback", "result": self.app.request("fixture", "state", {})}
                )

        self.app.notify = notify
        self.app.config.update(
            acp_command=[
                sys.executable,
                str(ROOT / "tests/copilot/fake-acp.py"),
                "--empty-inference-delay",
            ],
            exec_transport="oneshot",
            timeout_seconds=5,
            min_interval=0,
            auto_zero=False,
        )

        def wait(check):
            until = time.monotonic() + 6
            while not check() and time.monotonic() < until:
                time.sleep(0.01)
            self.assertTrue(check())

        self.app.request("fixture", "settings", {"enabled": True})
        wait(lambda: self.app.view("fixture")["ready"])
        # 中文注释：本地用例只推进业务时钟；真实30秒管道用例单独保留，不能混称。
        clock = time.monotonic
        self.app.clock = lambda: clock() + 30
        self.app.request("fixture", "observe", R20B_OBSERVATION)
        wait(lambda: self.app.view("fixture")["last_refresh"] is not None)
        wait(lambda: any(row.get("params", {}).get("succeeded") for row in self.r20b_messages))
        time.sleep(0.3)
        state = self.app.view("fixture")
        self.assertTrue(state["enabled"])
        self.assertTrue(state["ready"])
        # 中文注释：空模型建议仍可保留本地有证据的采集入口，不能自动读页或执行。
        self.assertTrue(
            all(
                row.get("capture_required")
                and row["recommendation_state"]
                == ("ready" if row["action"] == "native.tool" else "needs_parameters")
                for row in state["suggestions"]
            )
        )
        entries = self.app.journal.view("fixture")["entries"]
        receipt = next(
            row
            for row in entries
            if row["event"] == "inference_return" and "added" in row["details"]
        )
        self.assertEqual(
            [receipt["details"][key] for key in ("added", "removed", "updated")], [0, 0, 0]
        )
        self.assertGreaterEqual(receipt["details"]["duration_ms"], 2500)
        assert_first_empty_inference(self, entries)
        self.assertTrue(
            any(row["event"] == "capture" and row["details"].get("steps") == 0 for row in entries)
        )
        for message in self.r20b_messages:
            encoded = json.dumps(
                message, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ).encode()
            self.assertLess(len(encoded), 512 * 1024)
        print(
            "R20B_INFERENCE_PAYLOAD_SIZES="
            + json.dumps(
                [
                    {
                        "type": row.get("params", {}).get("type", "response.state"),
                        "bytes": len(
                            json.dumps(
                                row, separators=(",", ":"), ensure_ascii=False, allow_nan=False
                            ).encode()
                        ),
                    }
                    for row in self.r20b_messages
                ]
            )
        )

    def test_host_exit_diagnostics_and_bridge_error_redaction(self):
        for error in (
            EOFError(),
            ValueError("native message exceeds limit"),
            json.JSONDecodeError("bad", "", 0),
            OSError(),
        ):
            record_exit(self.root, "browser_to_daemon", error)
        path = self.root / "diagnostics/host-exits.jsonl"
        self.assertEqual(
            [json.loads(row)["reason"] for row in path.read_text().splitlines()],
            ["peer_closed", "message_too_large", "parse_failed", "transport_error"],
        )
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.app.request(
            "fixture",
            "bridge_error",
            {"message": "token=synthetic-private-value", "disconnected_at": 123},
        )
        self.assertNotIn("synthetic-private-value", json.dumps(self.app.journal.view("fixture")))

    def test_direct_collector_step_scope_limit_and_failure(self):
        task = self.task()
        scope = {
            "taskId": task["id"],
            "generation": 1,
            "stepId": "12345678-1234-1234-1234-123456789012",
            "action": "table.read",
        }
        dispatch = lambda p: self.daemon._dispatch_extension("fixture", "extension.task_step", p)
        dispatch({**scope, "phase": "start"})
        rows = self.daemon._dispatch_extension(
            "fixture", "extension.task_log", {"taskId": task["id"], "generation": 1, "limit": 100}
        )
        self.assertEqual(rows[-1]["result"], "pending")
        dispatch({**scope, "phase": "failed", "durationMs": 125, "errorCode": "element_timeout"})
        rows = self.daemon._dispatch_extension(
            "fixture", "extension.task_log", {"taskId": task["id"], "generation": 1, "limit": 100}
        )
        self.assertEqual(rows[-1]["errorCode"], "element_timeout")
        with self.assertRaises(ProtocolError):
            dispatch({**scope, "generation": 2, "phase": "start"})
        with self.assertRaises(ProtocolError):
            dispatch({**scope, "action": "arbitrary", "phase": "start"})
        with self.assertRaises(ProtocolError):
            dispatch({**scope, "phase": "succeeded"})
        self.assertNotIn("currentOperation", task)

    def browser_logs(self):
        task = self.task()

        def browser(_extension, method, params, **_):
            if params.get("action") == "new_tab":
                return {"tabId": 7, "url": "https://example.test/"}
            return {"ok": True, "_targetSummary": {"role": "button", "name": "Next"}}

        with patch.object(self.daemon, "_extension_call", side_effect=browser):
            for index, (action, extra) in enumerate(
                (
                    ("new_tab", {"url": "https://example.test/"}),
                    ("snapshot", {"tabId": 7}),
                    ("click", {"tabId": 7, "selector": "button"}),
                    ("page.parse", {"tabId": 7}),
                )
            ):
                self.daemon._run_task(
                    {
                        "taskId": task["id"],
                        "owner": "fixture-owner",
                        "requestId": str(index),
                        "action": action,
                        **extra,
                    }
                )
        return self.daemon._dispatch_extension(
            "fixture", "extension.task_log", {"taskId": task["id"], "generation": 1, "limit": 100}
        )

    def test_browser_dispatch_produces_each_overlay_action(self):
        self.assertEqual(
            [row["action"] for row in self.browser_logs()],
            ["new_tab", "snapshot", "click", "page.parse"],
        )


if __name__ == "__main__":
    if "--inference-fixture" in sys.argv:
        case = Local()
        case.setUp()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                case.test_empty_first_inference_notifications_and_state_readback()
            print(json.dumps(case.r20b_messages, ensure_ascii=False, allow_nan=False))
        finally:
            case.doCleanups()
    elif "--emoji-frames" in sys.argv:
        print(
            json.dumps(
                list(
                    _extension_frames(
                        {
                            "method": "copilot.changed",
                            "params": {"type": "logs", "text": "😀" * 150000},
                        }
                    )
                ),
                ensure_ascii=False,
            )
        )
    elif "--workflow-fixture" in sys.argv or "--execution-fixture" in sys.argv:
        from test_copilot_capabilities import CapabilitiesTest

        workflow = "--workflow-fixture" in sys.argv
        name = (
            "test_end_to_end_workflow_and_real_fake_model_draft_use_isolated_one_turn"
            if workflow
            else "test_real_acp_resume_and_execution_push_sizes"
        )
        case = CapabilitiesTest(name) if workflow else Local(name)
        events = []
        emit = Copilot._emit
        initialize = Copilot.__init__

        def capture(app, instance, kind, **values):
            emit(app, instance, kind, **values)
            if kind in {"add", "update", "progress"}:
                events.append(
                    json.loads(
                        json.dumps(
                            {"method": "copilot.changed", "params": {"type": kind, **values}}
                        )
                    )
                )

        def initialize_observed(app, directory, notify=lambda *_: None, **kwargs):
            def observed(instance, event):
                events.append(
                    json.loads(json.dumps({"method": "copilot.changed", "params": event}))
                )
                notify(instance, event)

            initialize(app, directory, observed, **kwargs)

        case.setUp()
        try:
            with (
                patch.object(
                    Copilot,
                    "__init__" if workflow else "_emit",
                    initialize_observed if workflow else capture,
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                getattr(case, name)()
        finally:
            if workflow:
                case.tearDown()
            case.doCleanups()
        print(json.dumps(events, ensure_ascii=False))
    elif "--collector-fixture" in sys.argv:
        case = Local()
        case.setUp()
        try:
            task = case.task()
            for value in json.load(sys.stdin):
                case.daemon._dispatch_extension(
                    "fixture", "extension.task_step", {**value, "taskId": task["id"]}
                )
            print(
                json.dumps(
                    case.daemon._dispatch_extension(
                        "fixture",
                        "extension.task_log",
                        {"taskId": task["id"], "generation": 1, "limit": 100},
                    ),
                    ensure_ascii=False,
                )
            )
        finally:
            case.doCleanups()
    elif "--fixture" in sys.argv:
        case = Local()
        case.setUp()
        try:
            print(json.dumps(case.browser_logs(), ensure_ascii=False))
        finally:
            case.doCleanups()
    else:
        unittest.main()
