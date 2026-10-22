"""凭据私有端口的合成任务、代次、互斥与单次填写验证。"""

import json
import hashlib
import types
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
sys.path.insert(0, str(ROOT / "executor-plugin"))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
from vault_client import call  # noqa: E402
from vault_private import VaultPrivateService  # noqa: E402
from vault_adapter.adapter import VaultAdapter  # noqa: E402
from vault_adapter.integration import NativeVaultPrivatePort  # noqa: E402
from vault_adapter.integration import create_vault_integration, register_vault_overrides  # noqa: E402
from single_tool_adapter.integration import HostBindingCoordinator  # noqa: E402
from native_runtime import NativeOwnerAuthority, OwnerLeaseError, OWNER_LEASE_ARG  # noqa: E402
import open_tool  # noqa: E402
from tests.support import temporary_bridge_home  # noqa: E402
from client import socket_address  # noqa: E402


class FakeDaemon(BridgeDaemon):
    def __init__(self, home):
        # 中文注释：复用真实准入和退出票据，夹具只替换浏览器端和持久化。
        super().__init__(home)
        self.data_dir.mkdir(parents=True)
        self.task_locks = {"task": threading.RLock()}
        self.tasks = {
            "task": {
                "id": "task",
                "owner": "owner",
                "instanceId": "browser",
                "generation": 3,
                "modeGeneration": 2,
                "allowedOrigins": ["https://example.test"],
                "state": "ready",
                "activeMode": "full",
                "agentTabIds": [7],
                "scriptedTabs": [],
            }
        }
        self.tab_leases = {("browser", 7): "task"}
        self.extensions = {"browser": {"instanceId": "browser"}}
        self.calls = []

    def _persist_tasks(self):
        pass

    def _extension_call(self, extension, method, params, timeout=15):
        self.calls.append((method, params))
        if method == "browser.vault_inspect":
            return {
                "origin": "https://example.test",
                "documentGeneration": 4,
                "controls": [
                    {
                        "index": 0,
                        "type": "password",
                        "name": "password",
                        "label": "Password",
                        "autocomplete": "current-password",
                        "maxLength": None,
                        "formIndex": 0,
                    }
                ],
            }
        if method == "browser.vault_fill":
            return {"filled": len(params["fills"])}
        raise AssertionError("unexpected extension method")


class VaultPrivateTests(unittest.TestCase):
    def setUp(self):
        self.home = self.enterContext(temporary_bridge_home())
        self.daemon = FakeDaemon(self.home)
        self.service = VaultPrivateService(self.daemon)
        self.service.start()
        self.addCleanup(self.service.close)
        self.scope = {
            "sessionId": "session",
            "owner": "owner",
            "taskId": "task",
            "instanceId": "browser",
            "generation": 3,
            "modeGeneration": 2,
            "tabId": 7,
            "allowedOrigins": ["https://example.test"],
        }

    def test_fixture_uses_owned_tmpdir_and_bindable_private_socket(self):
        self.assertEqual(self.home.parent, Path(tempfile.gettempdir()).resolve())
        address = socket_address(self.service.socket_path)
        self.assertEqual(Path(address).resolve(), self.service.socket_path)
        self.assertLessEqual(len(address.encode()), 103)
        self.assertTrue(self.service.socket_path.is_socket())

    def test_secret_uses_private_socket_and_nonce_is_single_use(self):
        # 中文注释：普通 RPC 不提供 Vault 方法；私有填写只回传数量并一次性消耗检查 nonce。
        with self.assertRaises(ProtocolError) as ordinary:
            # 中文注释：先提供可信 owner 通过活动钩子，才能验证普通端口未注册 Vault 方法。
            BridgeDaemon._dispatch_client(
                BridgeDaemon(self.home), "shared.vault_fill", {"owner": "owner"}
            )
        self.assertEqual(ordinary.exception.code, "unknown_method")
        inspected = call(self.home, "inspect", {"scope": self.scope})
        self.assertEqual(inspected["origin"], "https://example.test")
        fill = {
            "scope": self.scope,
            "nonce": inspected["nonce"],
            "documentGeneration": 4,
            "expectedOrigin": "https://example.test",
            "kind": "login",
            "fills": [{"index": 0, "token": "current-password", "value": "SyntheticSecret!"}],
        }
        receipt = call(self.home, "fill", fill)
        self.assertEqual(receipt, {"filled": 1})
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.tasks))
        self.assertNotIn("SyntheticSecret!", json.dumps(receipt))
        self.assertEqual(self.daemon.tasks["task"]["credentialTabs"], [7])
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.calls))
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(
                self.home,
                "fill",
                {
                    **fill,
                    "fills": [{"index": 0, "token": "current-password", "value": "AnotherSecret"}],
                },
            )
        self.assertEqual(
            len([method for method, _ in self.daemon.calls if method == "browser.vault_fill"]), 1
        )

    def test_generation_and_script_conflicts_fail_before_inspection(self):
        # 中文注释：代次错误和已执行脚本的页面都不能把凭据元信息交给错误任务页。
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "inspect", {"scope": {**self.scope, "modeGeneration": 1}})
        self.daemon.tasks["task"]["scriptedTabs"] = [7]
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "inspect", {"scope": self.scope})
        self.assertEqual(self.daemon.calls, [])

    def test_smart_fill_requires_one_time_approval(self):
        # 中文注释：智能审批未获批准时秘密不会派发；同一批准只能填写一次。
        self.daemon.tasks["task"]["activeMode"] = "smart"
        inspected = call(self.home, "inspect", {"scope": self.scope})
        approval = {"requestId": "vault-smart-1", "handleDigest": "a" * 64, "vaultAction": "fill"}
        fill = {
            "scope": self.scope,
            "nonce": inspected["nonce"],
            "documentGeneration": 4,
            "expectedOrigin": "https://example.test",
            "kind": "login",
            "approval": approval,
            "fills": [{"index": 0, "token": "current-password", "value": "SyntheticSecret!"}],
        }
        with self.assertRaisesRegex(RuntimeError, "denied"):
            call(self.home, "fill", fill)
        self.assertEqual(
            len([method for method, _ in self.daemon.calls if method == "browser.vault_fill"]), 0
        )
        inspected = call(self.home, "inspect", {"scope": self.scope})
        fill["nonce"] = inspected["nonce"]
        self.daemon.tasks["task"]["vaultPermit"] = {
            "requestIdHash": hashlib.sha256(approval["requestId"].encode()).hexdigest(),
            "handleDigest": approval["handleDigest"],
            "vaultAction": "fill",
            "tabId": 7,
            "modeGeneration": 2,
            "expiresAt": time.time() + 120,
        }
        self.assertEqual(call(self.home, "fill", fill), {"filled": 1})
        self.assertNotIn("vaultPermit", self.daemon.tasks["task"])

    def adapter(self):
        # 中文注释：统一复用官方适配层、私有客户端及真实 socket 的跨模块夹具。
        scope = self.scope
        home = self.home

        class Profile:
            authority = type(
                "Authority", (), {"owner_for_session": lambda self, session: "owner"}
            )()

            def call(self, method, params):
                if method == "shared.get":
                    return {
                        **daemon.tasks["task"],
                        "tabIds": [7],
                        "workTabs": [{"tabId": 7, "groupId": 1, "windowId": 2}],
                    }
                if method == "browser.list":
                    return [{"instanceId": "browser", "connected": True}]
                raise AssertionError("secret entered ordinary RPC")

            def vault_private_call(self, operation, params):
                return call(home, operation, params)

        class Host:
            def resolve_vault_binding(self, session):
                if session != "session":
                    return None
                return {
                    "owner": scope["owner"],
                    "task_id": scope["taskId"],
                    "instance_id": scope["instanceId"],
                    "generation": scope["generation"],
                    "mode_generation": scope["modeGeneration"],
                    "tab_id": scope["tabId"],
                }

        class Source:
            def get_meta(self, handle):
                return (
                    {"kind": "login", "origin": "https://example.test"}
                    if handle == "login"
                    else None
                )

            def resolve(self, handle, kind):
                return {"password": "SyntheticSecret!"}

            def register_secret(self, value):
                pass

        daemon = self.daemon
        profile = Profile()
        return VaultAdapter(profile, Host(), Source(), NativeVaultPrivatePort(profile))

    def test_adapter_crosses_real_private_socket_without_public_secret(self):
        adapter = self.adapter()
        result = json.loads(
            adapter.invoke("browser_vault_fill", {"handle": "login"}, session_id="session")
        )
        self.assertEqual(result["success"], True)
        self.assertEqual(result["filled_fields"], 1)
        self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.tasks))
        self.assertEqual(
            [name for name, _ in self.daemon.calls], ["browser.vault_inspect", "browser.vault_fill"]
        )
        self.assertNotIn("SyntheticSecret!", json.dumps(self.daemon.calls))

    def test_unified_adapter_uses_the_real_private_socket(self):
        result = json.loads(
            self.adapter().invoke(
                "browser_vault", {"action": "fill", "handle": "login"}, session_id="session"
            )
        )
        self.assertTrue(result["success"], result)
        self.assertEqual(result["filled_fields"], 1)
        self.assertEqual(
            [name for name, _ in self.daemon.calls], ["browser.vault_inspect", "browser.vault_fill"]
        )
        self.assertNotIn(
            "SyntheticSecret!", json.dumps([result, self.daemon.calls, self.daemon.tasks])
        )

    def test_write_transport_failure_is_unknown_scrubbed_and_never_replayed(self):
        # 中文注释：扩展已收到秘密但回执超时或断线时，公开工具只返回未知，私有 nonce 已消耗。
        original = self.daemon._extension_call
        for failure in (TimeoutError, ConnectionError):
            with self.subTest(failure=failure.__name__):
                self.daemon.calls.clear()

                def extension_call(extension, method, params, timeout=15):
                    result = original(extension, method, params, timeout)
                    if method == "browser.vault_fill":
                        raise failure("SyntheticSecret!")
                    return result

                self.daemon._extension_call = extension_call
                result = json.loads(
                    self.adapter().invoke(
                        "browser_vault_fill", {"handle": "login"}, session_id="session"
                    )
                )
                self.assertEqual(result, {"success": False, "error_type": "outcome_unknown"})
                self.assertEqual(
                    [method for method, _ in self.daemon.calls],
                    ["browser.vault_inspect", "browser.vault_fill"],
                )
                self.assertEqual(self.daemon.tasks["task"]["credentialTabs"], [7])
                self.assertEqual(self.service._nonces, {})
                self.assertNotIn(
                    "SyntheticSecret!", json.dumps([result, self.daemon.tasks, self.daemon.calls])
                )

    def test_revocation_and_nonce_session_expiry_or_restart_reject_before_fill(self):
        # 中文注释：检查和填写之间的撤权、会话变化、过期以及私有服务重启均不能复用旧检查。
        for change in ("revoked", "session", "expired", "restart"):
            with self.subTest(change=change):
                self.daemon.tasks["task"]["state"] = "ready"
                inspected = call(self.home, "inspect", {"scope": self.scope})
                scope = dict(self.scope)
                if change == "revoked":
                    self.daemon.tasks["task"]["state"] = "cancelled"
                elif change == "session":
                    scope["sessionId"] = "another-session"
                elif change == "expired":
                    self.service._nonces[("session", "task", 7)]["expiresAt"] = 0
                else:
                    self.service.close()
                    self.service = VaultPrivateService(self.daemon)
                    self.service.start()
                    self.addCleanup(self.service.close)
                with self.assertRaisesRegex(RuntimeError, "denied"):
                    call(
                        self.home,
                        "fill",
                        {
                            "scope": scope,
                            "nonce": inspected["nonce"],
                            "documentGeneration": 4,
                            "expectedOrigin": "https://example.test",
                            "kind": "login",
                            "fills": [
                                {
                                    "index": 0,
                                    "token": "current-password",
                                    "value": "SyntheticSecret!",
                                }
                            ],
                        },
                    )
                self.assertEqual(
                    [method for method, _ in self.daemon.calls if method == "browser.vault_fill"],
                    [],
                )


class VaultAttachedPrivateTests(unittest.TestCase):
    def setUp(self):
        # 中文注释：真实私有准入与一次性 nonce；只替换扩展和持久化，不启动 socket/浏览器。
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.daemon = FakeDaemon(Path(directory))
        self.service = VaultPrivateService(self.daemon)
        self.scope = {
            "sessionId": "session",
            "owner": "owner",
            "taskId": "task",
            "instanceId": "browser",
            "generation": 3,
            "modeGeneration": 2,
            "tabId": 7,
            "allowedOrigins": ["https://example.test"],
        }

    def test_private_scope_requires_live_tab_ids_when_present(self):
        task = self.daemon.tasks["task"]
        for kind in ("agentTabIds", "adoptedPopupTabIds", "attachedTabIds"):
            with self.subTest(kind=kind):
                task.update(agentTabIds=[], adoptedPopupTabIds=[], attachedTabIds=[], tabIds=[])
                task[kind] = [7]
                with self.assertRaisesRegex(ValueError, "Vault task changed"):
                    self.service._dispatch("inspect", {"scope": self.scope})
        self.assertEqual(self.daemon.calls, [])

    def test_open_coordinator_vault_private_chain_and_expired_authority_never_fallback(self):
        daemon, service = self.daemon, self.service
        task = daemon.tasks["task"]
        task.update(agentTabIds=[], workTabs=[], attachedTabIds=[7], tabIds=[7])
        authority = NativeOwnerAuthority(self.daemon.home / "synthetic-authority")
        public_calls, resolved, official_calls = [], [], []

        class Profile:
            def call(self, method, params):
                public_calls.append((method, params))
                if method == "browser.list":
                    return [
                        {
                            "instanceId": "browser",
                            "connected": "browser" in daemon.extensions,
                            "consentStatus": "enabled",
                        }
                    ]
                if method == "shared.create":
                    self_test.assertEqual(params["existingTab"], {})
                    task["owner"] = params["owner"]
                    return dict(task)
                if method == "shared.get":
                    return dict(task)
                if method == "shared.run" and params["action"] == "tabs":
                    return [{"id": 7, "url": "https://example.test/login"}]
                raise AssertionError("unexpected public RPC")

            def vault_private_call(self, operation, params):
                return service._dispatch(operation, params)

        self_test = self
        profile = Profile()
        profile.authority = authority
        source = types.SimpleNamespace(
            get_meta=lambda _: {"kind": "login", "origin": "https://example.test"},
            resolve=lambda *_: resolved.append(threading.get_ident())
            or {"password": "SyntheticSecret!"},
            register_secret=lambda _: None,
        )
        registry, adapter = create_vault_integration(profile, source=source)
        coordinator = HostBindingCoordinator(registry)
        authority.lease_tools((open_tool.TOOL_NAME,))
        opening = open_tool.make_handler(profile, coordinator, lease_error=OwnerLeaseError)
        args = {"existing_tab": True, "summary": False}
        lease = authority.pre_tool_call(
            open_tool.TOOL_NAME, args, session_id="session", tool_call_id="open"
        )["args"]
        opened = json.loads(opening({**args, **lease}, session_id="session"))
        self.assertTrue(opened.get("attached"), opened)
        self.assertEqual(opened["tab_id"], 7)

        tools, cleanups = {}, []
        context = types.SimpleNamespace(
            has_capability=lambda _: True,
            on_unload=cleanups.append,
            register_tool=lambda **kwargs: tools.update({kwargs["name"]: kwargs}),
        )
        entry = types.SimpleNamespace(
            is_async=False,
            handler=lambda *_args, **_kwargs: official_calls.append(True),
            toolset="browser",
            schema={"parameters": {"type": "object", "properties": {}}},
            check_fn=None,
            requires_env=[],
            description="synthetic official",
            emoji="",
        )
        modules = {
            name: types.ModuleType(name)
            for name in (
                "tools",
                "tools.registry",
                "tools.browser_vault_tool",
            )
        }
        modules["tools.registry"].registry = types.SimpleNamespace(
            get_entry=lambda name: entry if name == "browser_vault" else None
        )
        with patch.dict(sys.modules, modules):
            register_vault_overrides(
                context,
                profile,
                registry,
                adapter,
                lease_arg=OWNER_LEASE_ARG,
                lease_error=OwnerLeaseError,
            )
        handler = tools["browser_vault"]["handler"]
        args = {"action": "fill", "handle": "login"}

        def invoke(call_id, *, session="session", lease=True):
            values = dict(args)
            if lease:
                values.update(
                    authority.pre_tool_call(
                        "browser_vault",
                        args,
                        session_id=session,
                        tool_call_id=call_id,
                    )["args"]
                )
            return values, json.loads(handler(values, session_id=session))

        values, filled = invoke("fill")
        self.assertTrue(filled["success"], filled)
        self.assertEqual(resolved, [threading.get_ident()])
        self.assertEqual(
            json.loads(handler(values, session_id="session"))["error_type"], "binding_denied"
        )
        self.assertEqual(invoke("missing", lease=False)[1]["error_type"], "binding_denied")
        wrong_session = authority.pre_tool_call(
            "browser_vault", args, session_id="other", tool_call_id="other"
        )["args"]
        self.assertEqual(
            json.loads(handler({**args, **wrong_session}, session_id="session"))["error_type"],
            "binding_denied",
        )
        for name, change in (
            ("generation", lambda: task.update(generation=4)),
            ("script", lambda: task.update(scriptedTabs=[7])),
            ("lease", lambda: daemon.tab_leases.clear()),
            ("tabIds", lambda: task.update(tabIds=[])),
            ("attachment", lambda: task.update(attachedTabIds=[])),
            ("disconnected", lambda: daemon.extensions.clear()),
            ("revoked", lambda: task.update(state="cancelled")),
        ):
            with self.subTest(name=name):
                task.update(
                    generation=3, scriptedTabs=[], tabIds=[7], attachedTabIds=[7], state="ready"
                )
                daemon.tab_leases[("browser", 7)] = "task"
                daemon.extensions["browser"] = {"instanceId": "browser"}
                change()
                result = invoke(name)[1]
                self.assertFalse(result["success"], result)
        self.assertEqual(official_calls, [])
        self.assertEqual(resolved, [threading.get_ident()])
        self.assertEqual(task["agentTabIds"], [])
        self.assertEqual(task["workTabs"], [])
        self.assertEqual(
            [name for name, _ in daemon.calls], ["browser.vault_inspect", "browser.vault_fill"]
        )
        self.assertNotIn(
            "SyntheticSecret!", json.dumps([opened, filled, public_calls, daemon.calls])
        )

    def test_attached_private_inspection_cannot_outlive_scope_or_lease(self):
        task = self.daemon.tasks["task"]
        for name, change in (
            ("lease", lambda: self.daemon.tab_leases.clear()),
            ("foreign_lease", lambda: self.daemon.tab_leases.update({("browser", 7): "other"})),
            ("generation", lambda: task.update(generation=4)),
            ("mode", lambda: task.update(modeGeneration=3)),
            ("owner", lambda: task.update(owner="other")),
            ("tabIds", lambda: task.update(tabIds=[])),
            ("attachment", lambda: task.update(attachedTabIds=[])),
            ("script", lambda: task.update(scriptedTabs=[7])),
            ("connection", lambda: self.daemon.extensions.clear()),
            ("revoked", lambda: task.update(state="cancelled")),
        ):
            with self.subTest(name=name):
                task.update(
                    agentTabIds=[],
                    tabIds=[7],
                    attachedTabIds=[7],
                    state="ready",
                    generation=3,
                    modeGeneration=2,
                    owner="owner",
                    scriptedTabs=[],
                )
                self.daemon.tab_leases[("browser", 7)] = "task"
                self.daemon.extensions["browser"] = {"instanceId": "browser"}
                inspected = self.service._dispatch("inspect", {"scope": self.scope})
                before = len(self.daemon.calls)
                change()
                with self.assertRaises(ValueError):
                    self.service._dispatch(
                        "fill",
                        {
                            "scope": self.scope,
                            "nonce": inspected["nonce"],
                            "documentGeneration": 4,
                            "expectedOrigin": "https://example.test",
                            "kind": "login",
                            "fills": [
                                {
                                    "index": 0,
                                    "token": "current-password",
                                    "value": "SyntheticSecret!",
                                }
                            ],
                        },
                    )
                self.assertEqual(len(self.daemon.calls), before)
                self.assertNotIn("credentialTabs", task)

    def test_attached_page_private_fill_uses_live_lease_and_single_use_nonce(self):
        task = self.daemon.tasks["task"]
        task.update(agentTabIds=[], attachedTabIds=[7], tabIds=[7])
        inspected = self.service._dispatch("inspect", {"scope": self.scope})
        self.assertEqual(inspected["origin"], "https://example.test")
        fill = {
            "scope": self.scope,
            "nonce": inspected["nonce"],
            "documentGeneration": 4,
            "expectedOrigin": "https://example.test",
            "kind": "login",
            "fills": [{"index": 0, "token": "current-password", "value": "SyntheticSecret!"}],
        }
        replay = {**fill, "fills": [dict(row) for row in fill["fills"]]}
        self.assertEqual(self.service._dispatch("fill", fill), {"filled": 1})
        with self.assertRaisesRegex(ValueError, "inspection expired"):
            self.service._dispatch("fill", replay)
        self.assertEqual(task["agentTabIds"], [])
        self.assertEqual(task["credentialTabs"], [7])
        self.assertNotIn("SyntheticSecret!", json.dumps([task, self.daemon.calls]))


if __name__ == "__main__":
    unittest.main()
