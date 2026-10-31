"""受信产品通路：真实 daemon 状态与合成扩展回执，不触及个人浏览器。"""

import copy
from pathlib import Path
import sys
import json
import socket
import threading
import tempfile
import time
import unittest


BRIDGE = Path(__file__).resolve().parents[2] / "native-bridge"
sys.path.insert(0, str(BRIDGE))
from core_adapter import CoreAdapter  # noqa: E402
from daemon import BridgeDaemon, ProtocolError  # noqa: E402

URL = "https://fixture.test/form?draft=1"


class ProductAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="product-")
        self.addCleanup(self.temp.cleanup)
        self.daemon = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        self.daemon._prepare_data_dir()
        self.addCleanup(self.daemon._flush_tasks)
        self.daemon._notify_tasks_changed = lambda _: None
        self.extension = {
            "instanceId": "fixture",
            "browser": "chrome",
            "connectionGeneration": "connection-1",
        }
        self.daemon.extensions["fixture"] = self.extension
        self.calls = []
        self.daemon._extension_call = self.browser

    def browser(self, extension, method, params, **_):
        self.assertIs(extension, self.extension)
        self.calls.append((method, copy.deepcopy(params)))
        if method == "browser.select_existing_tab":
            return {
                "tabId": 17,
                "url": URL,
                "incognito": False,
                **({"documentId": "document-1"} if params.get("productFill") else {}),
            }
        if method == "browser.release":
            return {
                "released": True,
                "cleanupState": "succeeded",
                "remainingTabIds": [],
                "preservedTabIds": [17],
                "unknownTabIds": [],
            }
        return {"status": "bound"}

    def product(self, action, params, extension=None):
        return self.daemon._dispatch_connected_extension(
            extension or self.extension, "extension.product." + action, params
        )

    def attach(self):
        return self.product("attach", {"url": URL})

    def ready(self, attached):
        task = self.daemon.tasks[attached["taskId"]]
        self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.approve",
            {
                "taskId": task["id"],
                "generation": task["generation"],
                "tabIds": [17],
                "allowedOrigins": task["allowedOrigins"],
            },
        )
        ready = self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.mode",
            {
                "taskId": task["id"],
                "generation": task["generation"],
                "modeGeneration": task["modeGeneration"],
                "mode": "full",
            },
        )
        self.assertEqual(ready["executionLane"], "product_fill")
        return task

    def test_repeated_attach_reuses_pending_handle_and_get_only_projects_actual_ready(self):
        first = self.attach()
        self.assertEqual(self.attach(), first)
        self.assertEqual(len(self.daemon.tasks), 1)
        self.assertEqual(self.product("get", {"pageHandle": first["pageHandle"]}), first)
        task = self.ready(first)
        result = self.product("get", {"pageHandle": first["pageHandle"]})
        self.assertEqual(result["tabId"], 17)
        self.assertEqual(result["generation"], task["generation"])
        self.assertEqual(result["modeGeneration"], task["modeGeneration"])
        self.assertEqual(result["state"], "ready")
        self.assertNotIn("owner", result)
        self.assertEqual(len(self.calls), 1)

    def test_product_handle_requires_same_live_connection_object_and_generation(self):
        attached = self.attach()
        cloned = dict(self.extension)
        with self.assertRaises(ProtocolError):
            self.product("get", {"pageHandle": attached["pageHandle"]}, cloned)
        self.extension["connectionGeneration"] = "connection-2"
        with self.assertRaises(ProtocolError):
            self.product("get", {"pageHandle": attached["pageHandle"]})

    def test_attach_rejects_nonexact_selector_and_rechecks_connection_after_selection(self):
        for params in ({}, {"url": URL, "tabId": 17}, {"url": "file:///x"}, {"url": None}):
            with self.subTest(params=params), self.assertRaises(ProtocolError):
                self.product("attach", params)
        self.assertFalse(self.daemon.tasks)
        original = self.daemon._extension_call

        def replaced(*args, **kwargs):
            result = original(*args, **kwargs)
            self.daemon.extensions["fixture"] = dict(self.extension)
            return result

        self.daemon._extension_call = replaced
        with self.assertRaises(ProtocolError):
            self.attach()
        self.assertFalse(self.daemon.tasks)

    def test_product_attach_preserves_document_identity_through_extension_approval(self):
        original = self.daemon._extension_call

        def selected(extension, method, params, **kwargs):
            result = original(extension, method, params, **kwargs)
            if method == "browser.select_existing_tab":
                return {**result, "documentId": "document-1"}
            return result

        self.daemon._extension_call = selected
        attached = self.attach()
        self.assertEqual(self.calls[0][1], {"url": URL, "incognito": False, "productFill": True})
        task = self.daemon.tasks[attached["taskId"]]
        self.assertEqual(task["attachment"]["documentId"], "document-1")
        installed = self.daemon._dispatch_connected_extension(
            self.extension, "extension.tasks", {}
        )[0]
        self.assertEqual(installed["attachment"]["documentId"], "document-1")
        approved = self.daemon._dispatch_connected_extension(
            self.extension,
            "extension.approve",
            {
                "taskId": task["id"],
                "generation": task["generation"],
                "tabIds": [17],
                "allowedOrigins": task["allowedOrigins"],
            },
        )
        self.assertEqual(approved["attachment"]["documentId"], "document-1")
        self.daemon._flush_tasks()
        stored = json.loads(self.daemon.tasks_path.read_text())
        persisted = next(row for row in stored["tasks"] if row["id"] == task["id"])
        self.assertEqual(persisted["attachment"]["documentId"], "document-1")

    def test_product_attach_rejects_missing_or_invalid_document_identity(self):
        original = self.daemon._extension_call
        for document_id in (None, "", " ", 17, True, [], {}, "d" * 257):
            for missing in (False, True) if document_id is None else (False,):
                with self.subTest(document_id=document_id, missing=missing):

                    def selected(extension, method, params, **kwargs):
                        result = original(extension, method, params, **kwargs)
                        if method == "browser.select_existing_tab":
                            if missing:
                                result.pop("documentId", None)
                            else:
                                result["documentId"] = document_id
                        return result

                    self.daemon._extension_call = selected
                    with self.assertRaises(ProtocolError) as denied:
                        self.attach()
                    self.assertEqual(denied.exception.code, "attachment_unavailable")
                    self.assertFalse(self.daemon.tasks)
                    self.assertFalse(self.daemon.task_authorities)

    def test_default_attachment_keeps_exact_three_field_contract(self):
        params = {
            "owner": "ordinary-owner",
            "title": "ordinary task",
            "instanceId": "fixture",
            "existingTab": {"url": URL},
        }
        original = self.daemon._extension_call

        def extra(extension, method, values, **kwargs):
            result = original(extension, method, values, **kwargs)
            if method == "browser.select_existing_tab":
                result["documentId"] = "document-1"
            return result

        self.daemon._extension_call = extra
        with self.assertRaises(ProtocolError) as denied:
            self.daemon._create_task(params)
        self.assertEqual(denied.exception.code, "attachment_unavailable")
        self.assertFalse(self.daemon.tasks)
        self.daemon._extension_call = original
        created = self.daemon._create_task(params)
        self.assertEqual(
            set(self.daemon.tasks[created["id"]]["attachment"]), {"tabId", "url", "incognito"}
        )
        self.assertEqual(self.calls[-1][1], {"url": URL, "incognito": False})

    def test_attach_uses_exact_existing_page_and_private_install_lane(self):
        attached = self.attach()
        self.assertEqual(set(attached), {"pageHandle", "taskId", "state"})
        self.assertEqual(attached["state"], "pending_approval")
        task = self.daemon.tasks[attached["taskId"]]
        self.assertEqual(task["executionLane"], "product_fill")
        self.assertEqual(task["attachment"]["tabId"], 17)
        self.assertEqual(task["agentTabIds"], [])
        self.assertNotIn("owner", attached)
        self.assertNotIn("executionLane", self.daemon._public_task(task))
        installed = self.daemon._dispatch_connected_extension(
            self.extension, "extension.tasks", {}
        )[0]
        self.assertEqual(installed["executionLane"], "product_fill")
        self.assertEqual(
            self.calls,
            [
                (
                    "browser.select_existing_tab",
                    {"url": URL, "incognito": False, "productFill": True},
                )
            ],
        )
        self.assertFalse(hasattr(self.daemon, "copilot"))

    def test_run_uses_existing_browser_execute_ledger_and_never_replays_unknown(self):
        attached = self.attach()
        task = self.ready(attached)
        request = {
            "pageHandle": attached["pageHandle"],
            "requestId": "bind-1",
            "command": {
                "operation": "prepare",
                "observationHandle": "observation",
                "candidates": [{"fieldHandle": "field", "value": "canary-product-value"}],
            },
        }
        self.assertEqual(self.product("run", request), {"status": "bound"})
        self.assertEqual(self.product("run", request), {"status": "bound"})
        executed = [params for method, params in self.calls if method == "browser.execute"]
        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0]["command"], request["command"])
        self.assertEqual(executed[0]["action"], "product.fill")
        self.assertEqual(executed[0]["tabId"], 17)
        self.assertEqual(executed[0]["generation"], task["generation"])
        self.assertNotIn("owner", executed[0])
        self.assertEqual(len(task["requestHistory"]), 1)
        with self.assertRaises(ProtocolError) as conflict:
            self.product("run", {**request, "command": {"operation": "observe"}})
        self.assertEqual(conflict.exception.code, "request_id_conflict")
        original = self.daemon._extension_call

        def lost(extension, method, params, **kwargs):
            if method == "browser.execute":
                self.calls.append((method, copy.deepcopy(params)))
                raise ProtocolError("extension_timeout", "canary-private-error")
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = lost
        unknown = {**request, "requestId": "lost-1"}
        for _ in range(2):
            with self.assertRaises(ProtocolError):
                self.product("run", unknown)
        self.assertEqual(sum(method == "browser.execute" for method, _ in self.calls), 2)
        self.daemon._flush_tasks()
        for path in self.daemon.data_dir.rglob("*"):
            if path.is_file():
                content = path.read_bytes()
                self.assertNotIn(b"canary-product-value", content)
                self.assertNotIn(b"canary-private-error", content)

    def test_unknown_commit_fences_new_ids_bind_and_reattach_even_after_close(self):
        attached = self.attach()
        self.ready(attached)
        original = self.daemon._extension_call

        def lost(extension, method, params, **kwargs):
            if method == "browser.execute":
                self.calls.append((method, copy.deepcopy(params)))
                raise ProtocolError("extension_timeout", "lost")
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = lost
        request = {
            "pageHandle": attached["pageHandle"],
            "requestId": "unknown-commit",
            "command": {"operation": "commit", "grantHandle": "grant"},
        }
        with self.assertRaises(ProtocolError):
            self.product("run", request)
        self.daemon._extension_call = original
        for command in ({"operation": "commit", "grantHandle": "grant"}, {"operation": "observe"}):
            with self.assertRaises(ProtocolError):
                self.product("run", {**request, "requestId": "new-id", "command": command})
        self.product("close", {"pageHandle": attached["pageHandle"]})
        with self.assertRaises(ProtocolError):
            self.attach()
        self.assertEqual(sum(method == "browser.execute" for method, _ in self.calls), 1)

    def test_unknown_commit_survives_native_restart_before_any_new_attachment(self):
        attached = self.attach()
        self.ready(attached)

        def lost(*_args, **_kwargs):
            raise ProtocolError("extension_timeout", "lost")

        self.daemon._extension_call = lost
        with self.assertRaises(ProtocolError):
            self.product(
                "run",
                {
                    "pageHandle": attached["pageHandle"],
                    "requestId": "lost",
                    "command": {"operation": "commit", "grantHandle": "grant"},
                },
            )
        restored = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        restored._load_tasks()
        restored.extensions["fixture"] = self.extension
        self.addCleanup(restored._flush_tasks)
        with self.assertRaises(ProtocolError) as denied:
            restored._dispatch_connected_extension(
                self.extension, "extension.product.attach", {"url": URL}
            )
        self.assertEqual(denied.exception.code, "product_outcome_unknown")

    def test_explicit_predispatch_commit_refusal_does_not_poison_page(self):
        for kind in ("paused", "browser_refusal"):
            with self.subTest(kind=kind):
                attached = self.attach()
                task = self.ready(attached)
                original = self.daemon._extension_call
                if kind == "paused":
                    self.daemon._dispatch_connected_extension(
                        self.extension,
                        "extension.pause",
                        {"taskId": task["id"], "generation": task["generation"]},
                    )
                else:

                    def refused(extension, method, params, **kwargs):
                        if method == "browser.execute":
                            raise ProtocolError(
                                "execution_denied", "refused", {"outcomeUnknown": False}
                            )
                        return original(extension, method, params, **kwargs)

                    self.daemon._extension_call = refused
                with self.assertRaises(ProtocolError):
                    self.product(
                        "run",
                        {
                            "pageHandle": attached["pageHandle"],
                            "requestId": kind,
                            "command": {"operation": "commit", "grantHandle": "grant"},
                        },
                    )
                self.assertFalse(task.get("productWriteUnknown"))
                self.daemon._extension_call = original
                self.product("close", {"pageHandle": attached["pageHandle"]})

    def test_commit_persistence_failure_never_dispatches_browser(self):
        attached = self.attach()
        self.ready(attached)
        original = self.daemon._flush_tasks
        self.daemon._flush_tasks = lambda: (_ for _ in ()).throw(OSError("fixture IO failure"))
        try:
            with self.assertRaises(OSError):
                self.product(
                    "run",
                    {
                        "pageHandle": attached["pageHandle"],
                        "requestId": "disk-failed",
                        "command": {"operation": "commit", "grantHandle": "grant"},
                    },
                )
        finally:
            self.daemon._flush_tasks = original
        self.assertEqual(sum(method == "browser.execute" for method, _ in self.calls), 0)

    def test_product_tasks_reject_all_public_owner_paths_even_with_guessed_owner(self):
        attached = self.attach()
        task = self.ready(attached)
        for state in ("ready", "running", "paused", "closed", "needs_sync"):
            task["state"] = state
            for action in (
                "product.fill",
                "tabs",
                "js.evaluate",
                "cdp.send",
                "vault.authorize",
                "gateway.authorize",
            ):
                with self.subTest(state=state, action=action), self.assertRaises(ProtocolError):
                    self.daemon._run_task(
                        {
                            "owner": task["owner"],
                            "taskId": task["id"],
                            "requestId": "guessed",
                            "action": action,
                            "tabId": 17,
                            "command": {},
                        }
                    )
            with self.assertRaises(ProtocolError):
                self.daemon._owned_task({"owner": task["owner"], "taskId": task["id"]})
        self.assertEqual(len(self.calls), 1)

    def test_ordinary_tasks_cannot_guess_product_action_or_create_product_lane(self):
        for field in ("executionLane", "lane"):
            with self.assertRaises(ProtocolError):
                self.daemon._create_task(
                    {
                        "owner": "model",
                        "title": "model",
                        "instanceId": "fixture",
                        "allowedOrigins": ["https://fixture.test"],
                        field: "product_fill",
                    }
                )
        row = self.daemon._create_task(
            {
                "owner": "model",
                "title": "model",
                "instanceId": "fixture",
                "allowedOrigins": ["https://fixture.test"],
            }
        )
        with self.assertRaises(ProtocolError):
            self.daemon._run_task(
                {
                    "owner": "model",
                    "taskId": row["id"],
                    "requestId": "guess",
                    "action": "product.fill",
                    "tabId": 17,
                    "command": {},
                }
            )

    def test_close_preserves_page_and_unknown_history_without_inventing_handoff_reason(self):
        attached = self.attach()
        task = self.ready(attached)
        task["currentOperation"] = {"action": "product.fill", "state": "unknown"}
        result = self.product("close", {"pageHandle": attached["pageHandle"]})
        self.assertEqual(result["state"], "closed")
        self.assertEqual(result["cleanupState"], "succeeded")
        self.assertNotIn("handoffReason", task)
        self.assertEqual(task["currentOperation"]["state"], "unknown")
        self.assertFalse(self.calls[-1][1]["closeAgentTabs"])
        self.assertNotIn(("fixture", 17), self.daemon.tab_leases)
        count = len(self.calls)
        self.assertEqual(self.product("close", {"pageHandle": attached["pageHandle"]}), result)
        self.assertEqual(len(self.calls), count)

    def test_idle_sweep_releases_product_task_without_clearing_unknown_business_history(self):
        attached = self.attach()
        task = self.ready(attached)
        task["lastActivityAt"] = time.time() - self.daemon.task_idle_timeout_seconds - 1
        task["productWriteUnknown"] = True
        task["currentOperation"] = {"action": "product.fill", "state": "unknown"}
        task["requestHistory"] = [{"requestIdHash": "unknown-request", "state": "unknown"}]
        history = copy.deepcopy(task["requestHistory"])
        self.daemon._sweep_idle_tasks()
        self.assertEqual(task["state"], "closed")
        self.assertEqual(task["cleanupState"], "succeeded")
        self.assertTrue(task["productWriteUnknown"])
        self.assertEqual(task["currentOperation"]["state"], "unknown")
        self.assertEqual(task["requestHistory"], history)
        self.assertEqual(self.calls[-1][0], "browser.release")
        self.assertNotIn(("fixture", 17), self.daemon.tab_leases)
        for method in ("shared.close", "shared.cancel", "shared.handoff", "shared.sweep_stale"):
            with self.subTest(method=method), self.assertRaises(ProtocolError):
                self.daemon._dispatch_client(method, {"owner": task["owner"], "taskId": task["id"]})

    def test_idle_product_cleanup_does_not_require_a_restored_execution_authority(self):
        attached = self.attach()
        task = self.ready(attached)
        task["lastActivityAt"] = time.time() - self.daemon.task_idle_timeout_seconds - 1
        self.daemon._flush_tasks()
        restarted = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        restarted._load_tasks()
        self.addCleanup(restarted._flush_tasks)
        self.assertFalse(restarted.task_authorities)
        self.assertEqual(restarted.tasks[task["id"]]["state"], "needs_sync")
        restarted._notify_tasks_changed = lambda _: None
        restarted._extension_call = self.browser
        restarted.extensions["fixture"] = self.extension
        restarted._sweep_idle_tasks()
        self.assertEqual(restarted.tasks[task["id"]]["state"], "closed")
        self.assertEqual(restarted.tasks[task["id"]]["cleanupState"], "succeeded")
        self.assertFalse(restarted.task_authorities)

    def test_idle_product_cleanup_keeps_missing_release_receipt_unknown(self):
        attached = self.attach()
        task = self.ready(attached)
        task["lastActivityAt"] = time.time() - self.daemon.task_idle_timeout_seconds - 1
        original = self.daemon._extension_call

        def missing(extension, method, params, **kwargs):
            if method == "browser.release":
                raise ProtocolError("extension_timeout", "lost release receipt")
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = missing
        self.daemon._sweep_idle_tasks()
        self.assertEqual(task["state"], "closed")
        self.assertEqual(task["cleanupState"], "unknown")
        self.assertEqual(task["cleanupReason"], "extension_timeout")
        self.daemon._sweep_idle_tasks()
        self.assertEqual(task["cleanupState"], "unknown")

    def test_idle_product_cleanup_rechecks_activity_and_never_accepts_json_authority(self):
        attached = self.attach()
        task = self.ready(attached)
        task["lastActivityAt"] = time.time() - self.daemon.task_idle_timeout_seconds - 1
        original = self.daemon._release_task

        def active(*args, **kwargs):
            task["lastActivityAt"] = time.time()
            return original(*args, **kwargs)

        self.daemon._release_task = active
        self.daemon._sweep_idle_tasks()
        self.assertEqual(task["state"], "ready")
        self.assertFalse(any(method == "browser.release" for method, _ in self.calls))
        self.daemon._release_task = original
        for method in ("shared.close", "shared.cancel", "shared.handoff", "shared.cleanup_status"):
            with self.subTest(method=method), self.assertRaises(ProtocolError) as denied:
                self.daemon._dispatch_client(
                    method,
                    {
                        "owner": task["owner"],
                        "taskId": task["id"],
                        "_idle_task": task,
                        "idle_check": [task["generation"], None, task["lastActivityAt"]],
                    },
                )
            self.assertEqual(denied.exception.code, "execution_lane_denied")
        with self.assertRaises(ProtocolError):
            original(
                {"owner": task["owner"], "taskId": task["id"]},
                "closed",
                True,
                _idle_task=dict(task),
                idle_check=(task["generation"], None, task["lastActivityAt"]),
            )

    def test_all_raw_daemon_gateway_vault_and_credentials_dispatch_are_blocked(self):
        attached = self.attach()
        task = self.ready(attached)
        for method in (
            "browser.cdp",
            "browser.cdp_chunk",
            "browser.vault_inspect",
            "browser.vault_fill",
            "browser.credentials",
            "browser.execute",
        ):
            with self.subTest(method=method), self.assertRaises(ProtocolError) as denied:
                BridgeDaemon._extension_call(
                    self.daemon,
                    self.extension,
                    method,
                    {"taskId": task["id"], "generation": task["generation"], "tabId": 17},
                )
            self.assertEqual(denied.exception.code, "execution_lane_denied")
        with self.assertRaises(Exception) as denied:
            self.daemon._gateway_validate(
                {
                    "taskId": task["id"],
                    "owner": task["owner"],
                    "generation": task["generation"],
                    "modeGeneration": task["modeGeneration"],
                }
            )
        self.assertEqual(type(denied.exception).__name__, "GatewayDenied")

    def test_invalid_command_shapes_never_reach_browser(self):
        attached = self.attach()
        self.ready(attached)
        bad = (
            None,
            [],
            {},
            {"operation": "script"},
            {"operation": "observe", "script": "x"},
            {"operation": "commit", "grantHandle": "g", "requestId": "override"},
            {"operation": "bind", "binding": {}, "epoch": True, "submissionLocked": False},
            {"operation": "prepare", "observationHandle": "o", "candidates": []},
        )
        for command in bad:
            with self.subTest(command=command), self.assertRaises(ProtocolError):
                self.product(
                    "run",
                    {
                        "pageHandle": attached["pageHandle"],
                        "requestId": "invalid",
                        "command": command,
                    },
                )
        self.assertEqual(len(self.calls), 1)

    def test_untrusted_extension_error_and_target_summary_never_enter_logs(self):
        attached = self.attach()
        task = self.ready(attached)
        original = self.daemon._extension_call

        def unsafe(extension, method, params, **kwargs):
            if method == "browser.execute":
                raise ProtocolError(
                    "canary_error_code", "canary-error-text", {"text": "canary-error-data"}
                )
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = unsafe
        with self.assertRaises(ProtocolError) as denied:
            self.product(
                "run",
                {
                    "pageHandle": attached["pageHandle"],
                    "requestId": "error",
                    "command": {"operation": "observe"},
                },
            )
        self.assertNotIn("canary", str(denied.exception))
        self.assertNotIn("canary", task["currentOperation"].get("errorCode", ""))

    def test_real_extension_reader_remains_available_for_product_browser_roundtrips(self):
        daemon = BridgeDaemon(Path(self.temp.name) / "wire", service_factory=CoreAdapter)
        daemon._prepare_data_dir()
        daemon._start_lifecycle_worker = (
            lambda target, *args: threading.Thread(target=target, args=args, daemon=True).start()
            if target.__name__ == "_service_extension_request"
            else None
        )
        daemon._notify_tasks_changed = lambda _: None
        server, peer = socket.socketpair()
        peer.settimeout(2)
        reader = peer.makefile("rb")
        errors = []

        def serve():
            try:
                with server, server.makefile("rb") as incoming:
                    daemon._serve_extension(server, incoming, "chrome-extension://fixture/")
            except EOFError:
                pass
            except Exception as exc:
                errors.append(type(exc).__name__)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()

        def send(value):
            peer.sendall(json.dumps(value).encode() + b"\n")

        def read():
            return json.loads(reader.readline())

        try:
            send(
                {
                    "id": "hello",
                    "method": "extension.hello",
                    "params": {"instanceId": "wire", "browser": "chrome", "version": "test"},
                }
            )
            self.assertTrue(read()["result"]["connected"])
            send({"id": "attach", "method": "extension.product.attach", "params": {"url": URL}})
            selection = read()
            self.assertEqual(selection["method"], "browser.select_existing_tab")
            self.assertTrue(selection["params"]["productFill"])
            send(
                {
                    "id": selection["id"],
                    "result": {
                        "tabId": 17,
                        "url": URL,
                        "incognito": False,
                        "documentId": "document-1",
                    },
                }
            )
            attached = read()["result"]
            self.assertEqual(attached["state"], "pending_approval")
            task = daemon.tasks[attached["taskId"]]
            self.assertEqual(task["attachment"]["documentId"], "document-1")
            send(
                {
                    "id": "approve",
                    "method": "extension.approve",
                    "params": {
                        "taskId": task["id"],
                        "generation": 1,
                        "tabIds": [17],
                        "allowedOrigins": task["allowedOrigins"],
                    },
                }
            )
            self.assertEqual(read()["result"]["state"], "authorizing")
            send(
                {
                    "id": "mode",
                    "method": "extension.mode",
                    "params": {
                        "taskId": task["id"],
                        "generation": 1,
                        "modeGeneration": 1,
                        "mode": "full",
                    },
                }
            )
            self.assertEqual(read()["result"]["state"], "ready")
            send(
                {
                    "id": "run",
                    "method": "extension.product.run",
                    "params": {
                        "pageHandle": attached["pageHandle"],
                        "requestId": "observe-wire",
                        "command": {"operation": "observe"},
                    },
                }
            )
            execute = read()
            self.assertEqual(execute["method"], "browser.execute")
            self.assertEqual(execute["params"]["action"], "product.fill")
            send({"id": execute["id"], "result": {"fields": []}})
            self.assertEqual(read()["result"], {"fields": []})
        finally:
            peer.shutdown(socket.SHUT_RDWR)
            reader.close()
            peer.close()
            worker.join(2)
            daemon._flush_tasks()
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_close_fences_inflight_run_before_its_receipt_arrives(self):
        attached = self.attach()
        self.ready(attached)
        entered = threading.Event()
        finish = threading.Event()
        closed = threading.Event()
        original = self.daemon._extension_call

        def waiting(extension, method, params, **kwargs):
            if method == "browser.execute":
                entered.set()
                finish.wait(2)
                return {"status": "confirmed"}
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = waiting
        errors = []

        def run():
            try:
                self.product(
                    "run",
                    {
                        "pageHandle": attached["pageHandle"],
                        "requestId": "pending",
                        "command": {"operation": "commit", "grantHandle": "grant"},
                    },
                )
            except ProtocolError as exc:
                errors.append(exc.code)

        running = threading.Thread(target=run)
        closing = threading.Thread(
            target=lambda: (
                self.product("close", {"pageHandle": attached["pageHandle"]}),
                closed.set(),
            )
        )
        running.start()
        self.assertTrue(entered.wait(1))
        closing.start()
        try:
            self.assertTrue(closed.wait(0.5))
        finally:
            finish.set()
            running.join(2)
            closing.join(2)
        self.assertTrue(errors)

    def test_close_can_release_revoked_task_but_not_clear_unknown_result(self):
        attached = self.attach()
        task = self.ready(attached)
        self.daemon._revoke_task_locked(task, "needs_sync")
        self.assertEqual(
            self.product("close", {"pageHandle": attached["pageHandle"]})["state"], "closed"
        )

    def test_product_full_access_and_live_lease_are_required_before_cached_results(self):
        attached = self.attach()
        task = self.ready(attached)
        params = {
            "pageHandle": attached["pageHandle"],
            "requestId": "cached",
            "command": {"operation": "observe"},
        }
        self.product("run", params)
        task["activeMode"] = "smart"
        with self.assertRaises(ProtocolError):
            self.product("run", params)
        task["activeMode"] = "full"
        self.daemon.tab_leases.clear()
        with self.assertRaises(ProtocolError):
            self.product("run", params)

    def test_selection_errors_do_not_return_arbitrary_extension_text(self):
        def unsafe(*_a, **_kw):
            raise ProtocolError("canary_selection_code", "canary-selection-text")

        self.daemon._extension_call = unsafe
        with self.assertRaises(ProtocolError) as denied:
            self.attach()
        self.assertNotIn("canary", str(denied.exception))
        self.assertNotIn("canary", denied.exception.code)

    def test_same_object_connection_generation_change_during_selection_creates_no_authority(self):
        original = self.daemon._extension_call

        def changed(*args, **kwargs):
            result = original(*args, **kwargs)
            self.extension["connectionGeneration"] = "changed"
            return result

        self.daemon._extension_call = changed
        with self.assertRaises(ProtocolError):
            self.attach()
        self.assertFalse(self.daemon.tasks)

    def test_product_inventory_is_not_visible_through_shared_list_even_if_owner_is_known(self):
        attached = self.attach()
        task = self.daemon.tasks[attached["taskId"]]
        self.assertEqual(self.daemon._dispatch_client("shared.list", {"owner": task["owner"]}), [])

    def test_restart_does_not_restore_product_authority_or_handle(self):
        attached = self.attach()
        task = self.ready(attached)
        self.daemon._flush_tasks()
        restarted = BridgeDaemon(Path(self.temp.name), service_factory=CoreAdapter)
        restarted._load_tasks()
        self.addCleanup(restarted._flush_tasks)
        restarted.extensions["fixture"] = self.extension
        self.assertEqual(restarted.tasks[task["id"]]["executionLane"], "product_fill")
        self.assertEqual(restarted.tasks[task["id"]]["state"], "needs_sync")
        self.assertEqual(restarted.tasks[task["id"]]["attachment"]["documentId"], "document-1")
        self.assertFalse(restarted.tab_leases)
        self.assertEqual(restarted.task_authorities, {})
        with self.assertRaises(ProtocolError):
            restarted._dispatch_connected_extension(
                self.extension, "extension.product.get", {"pageHandle": attached["pageHandle"]}
            )

    def test_unknown_business_receipt_remains_unknown_in_native_ledger(self):
        attached = self.attach()
        task = self.ready(attached)
        original = self.daemon._extension_call

        def unknown(extension, method, params, **kwargs):
            return (
                {"status": "unknown", "results": []}
                if method == "browser.execute"
                else original(extension, method, params, **kwargs)
            )

        self.daemon._extension_call = unknown
        result = self.product(
            "run",
            {
                "pageHandle": attached["pageHandle"],
                "requestId": "business-unknown",
                "command": {"operation": "commit", "grantHandle": "grant"},
            },
        )
        self.assertTrue(result["outcomeUnknown"])
        self.assertEqual(task["requestHistory"][0]["state"], "unknown")
        self.assertEqual(task["currentOperation"]["state"], "unknown")

    def test_actual_vault_service_refuses_product_scope_before_inspection(self):
        attached = self.attach()
        task = self.ready(attached)
        self.daemon._extension_call = BridgeDaemon._extension_call.__get__(self.daemon)
        with self.assertRaises(ProtocolError) as denied:
            self.daemon.vault_private._dispatch(
                "inspect",
                {
                    "scope": {
                        "sessionId": "session",
                        "owner": task["owner"],
                        "taskId": task["id"],
                        "instanceId": "fixture",
                        "generation": task["generation"],
                        "modeGeneration": task["modeGeneration"],
                        "tabId": 17,
                        "allowedOrigins": task["allowedOrigins"],
                    }
                },
            )
        self.assertEqual(denied.exception.code, "execution_lane_denied")
        self.assertEqual(self.daemon.vault_private._nonces, {})

    def test_product_authority_does_not_survive_mode_change_while_queued(self):
        attached = self.attach()
        task = self.ready(attached)
        page = self.daemon.optional_service.product.pages[attached["pageHandle"]]
        request = {
            "owner": task["owner"],
            "taskId": task["id"],
            "requestId": "queued",
            "action": "product.fill",
            "tabId": 17,
            "command": {"operation": "observe"},
        }
        self.daemon._run_task(request, _authority=page)
        task["activeMode"] = "smart"
        with self.assertRaises(ProtocolError):
            self.daemon._run_task_impl(request, None, [], _authority=page)

    def test_product_native_dispatch_rechecks_full_scope_after_journal(self):
        attached = self.attach()
        task = self.ready(attached)
        page = self.daemon.optional_service.product.pages[attached["pageHandle"]]
        self.daemon._extension_call = BridgeDaemon._extension_call.__get__(self.daemon)
        params = {
            "taskId": task["id"],
            "generation": task["generation"],
            "modeGeneration": task["modeGeneration"] - 1,
            "action": "product.fill",
            "tabId": 17,
            "command": {"operation": "observe"},
        }
        with self.assertRaises(ProtocolError) as denied:
            self.daemon._extension_call(self.extension, "browser.execute", params, _authority=page)
        self.assertEqual(denied.exception.code, "execution_lane_denied")

    def test_command_schema_accepts_all_content_operations_and_preserves_outer_commit_id(self):
        attached = self.attach()
        self.ready(attached)
        commands = (
            {
                "operation": "bind",
                "binding": {
                    "product": "fixture",
                    "source": "source",
                    "item": "item",
                    "submissionUrl": URL,
                },
                "epoch": 1,
                "submissionLocked": False,
            },
            {"operation": "observe"},
            {
                "operation": "prepare",
                "observationHandle": "observation",
                "candidates": [{"fieldHandle": "field", "value": "value"}],
            },
            {"operation": "commit", "grantHandle": "grant"},
            {"operation": "status", "requestId": "commit-id"},
            {"operation": "revoke", "reason": "unpaired"},
        )
        for index, command in enumerate(commands):
            self.product(
                "run",
                {
                    "pageHandle": attached["pageHandle"],
                    "requestId": f"command-{index}",
                    "command": command,
                },
            )
        executed = [params for method, params in self.calls if method == "browser.execute"]
        self.assertEqual([params["command"] for params in executed], list(commands))
        self.assertEqual(executed[3]["requestId"], "command-3")

    def test_product_failure_after_dispatch_is_unknown_unless_explicitly_predispatch(self):
        attached = self.attach()
        task = self.ready(attached)

        def failed(*_args, **_kwargs):
            raise ProtocolError("unexpected_adapter_code", "do not log")

        self.daemon._extension_call = failed
        with self.assertRaises(ProtocolError) as result:
            self.product(
                "run",
                {
                    "pageHandle": attached["pageHandle"],
                    "requestId": "unclassified",
                    "command": {"operation": "commit", "grantHandle": "grant"},
                },
            )
        self.assertTrue(result.exception.data["outcomeUnknown"])
        self.assertEqual(task["requestHistory"][0]["state"], "unknown")

    def test_reattach_does_not_restore_a_revoked_same_url_page_without_explicit_close(self):
        attached = self.attach()
        task = self.ready(attached)
        self.daemon._revoke_task_locked(task, "needs_sync")
        self.assertEqual(self.attach()["pageHandle"], attached["pageHandle"])
        self.assertEqual(len(self.daemon.tasks), 1)

    def test_get_never_projects_ready_after_task_generation_changes(self):
        attached = self.attach()
        task = self.ready(attached)
        task["generation"] += 1
        with self.assertRaises(ProtocolError):
            self.product("get", {"pageHandle": attached["pageHandle"]})

    def test_close_reports_actual_unknown_cleanup_instead_of_success(self):
        attached = self.attach()
        self.ready(attached)
        original = self.daemon._extension_call

        def missing(extension, method, params, **kwargs):
            if method == "browser.release":
                raise ProtocolError("extension_timeout", "private")
            return original(extension, method, params, **kwargs)

        self.daemon._extension_call = missing
        result = self.product("close", {"pageHandle": attached["pageHandle"]})
        self.assertEqual(result["state"], "closed")
        self.assertEqual(result["cleanupState"], "unknown")

    def test_attach_does_not_reuse_a_handle_after_task_generation_changes(self):
        attached = self.attach()
        task = self.ready(attached)
        task["generation"] += 1
        with self.assertRaises(ProtocolError):
            self.attach()


if __name__ == "__main__":
    unittest.main()
