"""官方 Vault 登录工具到私有填写端口的合成适配验证。"""

from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import sys

import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "executor-plugin"))
from vault_adapter.adapter import VaultAdapter  # noqa: E402
from vault_adapter.integration import VAULT_TOOL_NAMES, register_vault_overrides  # noqa: E402


class Runtime:
    def __init__(self):
        self.authority = type(
            "Authority", (), {"owner_for_session": lambda self, session: "owner"}
        )()
        self.task = {
            "id": "task",
            "state": "ready",
            "instanceId": "browser",
            "generation": 3,
            "modeGeneration": 2,
            "activeMode": "full",
            "tabIds": [7],
            "workTabs": [{"tabId": 7, "groupId": 1, "windowId": 2}],
            "allowedOrigins": ["https://example.test"],
        }
        self.permit = {"status": "approval_required"}
        self.approvals = []

    def call(self, method, params):
        if method == "shared.get":
            return dict(self.task)
        if method == "browser.list":
            return [{"instanceId": "browser", "connected": True}]
        if method == "shared.run":
            self.approvals.append(params)
            return dict(self.permit)
        raise AssertionError("unexpected ordinary RPC")


class Host:
    def resolve_vault_binding(self, session_id):
        if session_id != "session":
            return None
        return {
            "owner": "owner",
            "task_id": "task",
            "instance_id": "browser",
            "generation": 3,
            "mode_generation": 2,
            "tab_id": 7,
        }


class Source:
    def __init__(self):
        self.registered = []

    def list(self):
        return {
            "success": True,
            "items": [
                {
                    "handle": "login",
                    "kind": "login",
                    "origin": "https://example.test",
                    "label": "Test",
                },
                {
                    "handle": "card",
                    "kind": "payment",
                    "origin": "https://example.test",
                    "label": "Card",
                },
            ],
        }

    def get_meta(self, handle):
        return {
            "kind": "login" if handle == "login" else "payment",
            "origin": "https://example.test",
        }

    def resolve(self, handle, kind):
        assert handle == "login" and kind == "login"
        return {"password": "SyntheticSecret!"}

    def register_secret(self, value):
        self.registered.append(value)


class Port:
    def __init__(self):
        self.fills = []

    def inspect(self, scope):
        return {
            "taskId": scope.task_id,
            "instanceId": scope.instance_id,
            "generation": scope.generation,
            "modeGeneration": scope.mode_generation,
            "tabId": scope.tab_id,
            "origin": "https://example.test",
            "nonce": "a" * 48,
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

    def fill(self, scope, **kwargs):
        self.fills.append(kwargs)
        return {"filled": 1}


class VaultAdapterTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.source = Source()
        self.port = Port()
        self.adapter = VaultAdapter(self.runtime, Host(), self.source, self.port)

    def invoke(self, name, args):
        return json.loads(self.adapter.invoke(name, args, session_id="session"))

    def test_login_secret_is_blind_to_tool_result(self):
        # 中文注释：列表只给登录句柄，私有填写接收密码，普通工具结果不含密码。
        listed = self.invoke("browser_vault_list", {})
        self.assertEqual([item["handle"] for item in listed["items"]], ["login"])
        result = self.invoke("browser_vault_fill", {"handle": "login"})
        self.assertEqual(result["filled_fields"], 1)
        self.assertEqual(self.port.fills[0]["fills"][0]["value"], "SyntheticSecret!")
        self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertEqual(self.source.registered, ["SyntheticSecret!"])

    def test_attached_page_fill_keeps_creation_ownership_separate(self):
        self.runtime.task.update(workTabs=[], attachedTabIds=[7])
        for name, args in (
            ("browser_vault_fill", {"handle": "login"}),
            ("browser_vault", {"action": "fill", "handle": "login"}),
        ):
            with self.subTest(name=name):
                result = self.invoke(name, args)
                self.assertTrue(result["success"], result)
                self.assertEqual(result["filled_fields"], 1)
                self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertEqual(self.runtime.task["workTabs"], [])
        self.assertNotIn("agentTabIds", self.runtime.task)
        self.runtime.task["tabIds"] = []
        self.assertEqual(
            self.invoke("browser_vault_fill", {"handle": "login"})["error_type"],
            "binding_denied",
        )
        self.assertEqual(len(self.port.fills), 2)

    def test_unified_actions_use_the_same_private_login_path(self):
        listed = self.invoke("browser_vault", {"action": "list"})
        self.assertTrue(listed["success"], listed)
        self.assertEqual([item["handle"] for item in listed["items"]], ["login"])
        filled = self.invoke("browser_vault", {"action": "fill", "handle": "login"})
        self.assertEqual(filled["filled_fields"], 1)
        self.assertEqual(self.port.fills[0]["nonce"], "a" * 48)
        self.assertEqual(self.port.fills[0]["document_generation"], 4)
        self.assertNotIn("SyntheticSecret!", json.dumps([listed, filled]))

    def test_unified_list_returns_safe_metadata_and_current_unlock_hint(self):
        self.source.list = lambda: {
            "success": True,
            "items": [{"handle": "login", "kind": "login", "password": "SyntheticSecret!"}],
            "locked": [
                {
                    "backend": "bitwarden",
                    "unlock": "browser_vault_unlock",
                    "password": "SyntheticSecret!",
                }
            ],
            "errors": [{"backend": {"password": "SyntheticSecret!"}, "error": "SyntheticSecret!"}],
        }
        result = self.invoke("browser_vault", {"action": "list"})
        self.assertNotIn("SyntheticSecret!", json.dumps(result))
        self.assertEqual(result["locked"][0]["unlock"], "browser_vault action=unlock")

    def test_scope_change_and_payment_are_refused(self):
        self.runtime.task["modeGeneration"] = 4
        self.assertEqual(
            self.invoke("browser_vault_fill", {"handle": "login"})["error_type"], "binding_denied"
        )
        self.runtime.task["modeGeneration"] = 2
        self.assertEqual(
            self.invoke("browser_vault_fill", {"handle": "card"})["error_type"],
            "vault_item_unavailable",
        )
        self.assertEqual(self.port.fills, [])

    def test_smart_fill_waits_for_approval_then_uses_private_port(self):
        # 中文注释：拒绝或等待期间不解析秘密，批准后只向私有端口传摘要凭证。
        self.runtime.task["activeMode"] = "smart"
        pending = self.invoke("browser_vault_fill", {"handle": "login"})
        self.assertEqual(pending["error_type"], "approval_required")
        self.assertEqual(self.source.registered, [])
        self.assertEqual(self.port.fills, [])
        self.runtime.permit = {"authorized": True}
        filled = self.invoke("browser_vault_fill", {"handle": "login"})
        self.assertTrue(filled["success"])
        approval = self.port.fills[0]["approval"]
        self.assertEqual(approval["vaultAction"], "fill")
        self.assertEqual(self.runtime.approvals[0]["handleDigest"], approval["handleDigest"])
        self.assertNotIn("SyntheticSecret!", json.dumps(self.runtime.approvals))

    def test_override_keeps_unbound_official_handler(self):
        # 中文注释：已绑定任务使用私有适配器；未绑定会话仍调用 Hermes 原 Vault 工具。
        entries = {
            name: types.SimpleNamespace(
                is_async=False,
                handler=lambda args, **kwargs: "official",
                toolset="browser",
                schema={"name": name, "parameters": {"type": "object", "properties": {}}},
                check_fn=lambda: False,
                requires_env=[],
                description="official",
                emoji="🔐",
            )
            for name in VAULT_TOOL_NAMES
        }
        registry = types.SimpleNamespace(get_entry=lambda name: entries.get(name))
        tools = types.ModuleType("tools")
        registry_module = types.ModuleType("tools.registry")
        registry_module.registry = registry
        official_module = types.ModuleType("tools.browser_vault_tool")

        class Authority:
            def lease_tools(self, names, *, passthrough):
                self.names, self.passthrough = names, passthrough

            def consume(self, name, args, *, session_id):
                return types.SimpleNamespace(tool_call_id="call")

        class Context:
            def __init__(self):
                self.tools = {}

            def has_capability(self, name):
                return name == "tools.override"

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs

            def on_unload(self, callback):
                self.unload = callback

        context = Context()
        profile = types.SimpleNamespace(authority=Authority())
        bindings = types.SimpleNamespace(
            claims=lambda session: session == "session",
            close=lambda: None,
            has_bindings=lambda: False,
        )
        adapted = types.SimpleNamespace(invoke=lambda name, args, **kwargs: "private")
        with patch.dict(
            sys.modules,
            {
                "tools": tools,
                "tools.registry": registry_module,
                "tools.browser_vault_tool": official_module,
            },
        ):
            names = register_vault_overrides(
                context, profile, bindings, adapted, lease_arg="_lease", lease_error=ValueError
            )
        self.assertEqual(set(names), set(VAULT_TOOL_NAMES))
        self.assertTrue(profile.authority.passthrough)
        for tool in context.tools.values():
            self.assertEqual(tool["toolset"], "browser")
            self.assertEqual(tool["requires_env"], [])
            self.assertFalse(tool["check_fn"]())
        bindings.has_bindings = lambda: True
        self.assertTrue(context.tools["browser_vault_list"]["check_fn"]())
        handler = context.tools["browser_vault_fill"]["handler"]
        self.assertTrue(context.tools["browser_vault_fill"]["override"])
        self.assertEqual(
            handler({"handle": "login", "_lease": "token"}, session_id="session"), "private"
        )
        self.assertEqual(handler({"handle": "login"}, session_id="other"), "official")
        self.assertEqual(
            json.loads(handler({"handle": "login"}, session_id="session"))["error_type"],
            "binding_denied",
        )

    @contextmanager
    def unified_registry(self, *, is_async=False):
        calls = []

        def original(args, *, task_id=None):
            calls.append((args, task_id))
            return "official"

        async def async_original(args, *, task_id=None):
            return original(args, task_id=task_id)

        entry = types.SimpleNamespace(
            name="browser_vault",
            is_async=is_async,
            handler=async_original if is_async else original,
            toolset="browser",
            schema={
                "name": "browser_vault",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "fill", "save_login", "enter_code", "unlock"],
                        },
                        "handle": {"type": "string"},
                    },
                },
            },
            check_fn=lambda: False,
            requires_env=[],
            description="official",
            emoji="🔐",
        )
        entries = {"browser_vault": entry}

        class Context:
            def __init__(self):
                self.tools, self.cleanups = {}, []

            def has_capability(self, name):
                return name == "tools.override"

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs

            def on_unload(self, callback):
                self.cleanups.append(callback)

        class Authority:
            def lease_tools(self, names, *, passthrough):
                self.names = tuple(names)

            def consume(self, name, args, *, session_id):
                if args.get("_lease") != "good":
                    raise ValueError("invalid lease")
                return types.SimpleNamespace(tool_call_id="call")

        context, authority = Context(), Authority()
        bindings = types.SimpleNamespace(
            claims=lambda session: session == "session",
            close=lambda: None,
            has_bindings=lambda: True,
        )
        modules = {
            "tools": types.ModuleType("tools"),
            "tools.registry": types.ModuleType("tools.registry"),
            "tools.browser_vault_tool": types.ModuleType("tools.browser_vault_tool"),
        }
        modules["tools.registry"].registry = types.SimpleNamespace(get_entry=entries.get)
        with patch.dict(sys.modules, modules):
            yield context, types.SimpleNamespace(authority=authority), bindings, entry, calls

    def test_unified_registration_routes_bound_calls_and_preserves_unbound_contract(self):
        with self.unified_registry() as (ctx, profile, bindings, entry, calls):
            names = register_vault_overrides(
                ctx, profile, bindings, self.adapter, lease_arg="_lease", lease_error=ValueError
            )
        self.assertEqual(names, ("browser_vault",))
        self.assertEqual(profile.authority.names, names)
        tool = ctx.tools["browser_vault"]
        self.assertEqual(tool["schema"]["parameters"]["required"], ["action"])
        self.assertIn("request_id", tool["schema"]["parameters"]["properties"])
        self.assertNotIn("request_id", entry.schema["parameters"]["properties"])
        self.assertFalse(tool["is_async"])
        handler = tool["handler"]
        result = json.loads(
            handler({"action": "fill", "handle": "login", "_lease": "good"}, session_id="session")
        )
        self.assertTrue(result["success"], result)
        self.assertEqual(calls, [])
        denied = json.loads(handler({"action": "fill", "handle": "login"}, session_id="session"))
        self.assertEqual(denied["error_type"], "binding_denied")
        self.assertEqual(
            handler({"action": "list"}, session_id="other", task_id="official-task"), "official"
        )
        self.assertEqual(calls, [({"action": "list"}, "official-task")])

    def test_async_unified_contract_refuses_before_any_override(self):
        # 中文注释：官方遮盖提示与解锁会话归属使用thread-local，不能悄悄移到线程池。
        with self.unified_registry(is_async=True) as (ctx, profile, bindings, _, calls):
            with self.assertRaisesRegex(RuntimeError, "async Vault contract unsupported"):
                register_vault_overrides(
                    ctx, profile, bindings, self.adapter, lease_arg="_lease", lease_error=ValueError
                )
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.cleanups, [])
        self.assertFalse(hasattr(profile.authority, "names"))
        self.assertEqual(calls, [])

    def test_binding_cleanup_is_owned_before_registration_can_fail(self):
        closed = []
        with self.unified_registry() as (ctx, profile, bindings, _, _):
            bindings.close = lambda: closed.append(True)

            def fail(**kwargs):
                raise RuntimeError("synthetic registration failure")

            ctx.register_tool = fail
            with self.assertRaisesRegex(RuntimeError, "synthetic registration failure"):
                register_vault_overrides(
                    ctx, profile, bindings, self.adapter, lease_arg="_lease", lease_error=ValueError
                )
        self.assertEqual(len(ctx.cleanups), 1)
        ctx.cleanups[0]()
        self.assertEqual(closed, [True])

    def test_guidance_names_the_registered_unified_list_action(self):
        spec = importlib.util.spec_from_file_location(
            "vault_guidance_fixture", ROOT / "executor-plugin/__init__.py"
        )
        plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(plugin)
        sections = []
        ctx = types.SimpleNamespace(
            register_system_prompt_section=lambda name, text: sections.append(text)
        )
        plugin._register_guidance(
            ctx, vault_enabled=True, vault_list_tool="browser_vault action=list"
        )
        self.assertIn("check browser_vault action=list first", sections[-1])
        self.assertNotIn("browser_vault_list", sections[-1])

    def test_unified_save_and_otp_keep_values_on_the_private_path(self):
        saved = []
        self.source.prompt_login = lambda origin: {
            "identifier": "synthetic@example.test",
            "password": "SyntheticSecret!",
        }
        self.source.save = lambda *args: saved.append(args) or "login"
        result = self.invoke("browser_vault", {"action": "save_login", "label": "Test"})
        self.assertTrue(result["success"], result)
        self.assertEqual(saved[0][0], "https://example.test")
        self.assertEqual(self.port.fills[-1]["fills"][0]["value"], "SyntheticSecret!")
        inspect_port = self.port.inspect

        def code_page(scope):
            receipt = inspect_port(scope)
            receipt["controls"][0].update(type="text", autocomplete="one-time-code")
            return receipt

        self.port.inspect = code_page
        self.source.otp = lambda handle: "246810"
        code = self.invoke("browser_vault", {"action": "enter_code", "handle": "login"})
        self.assertTrue(code["success"], code)
        self.assertEqual(
            self.port.fills[-1]["fills"],
            [{"index": 0, "token": "one-time-code", "value": "246810"}],
        )
        self.assertNotIn("SyntheticSecret!", json.dumps([result, code]))
        self.assertNotIn("246810", json.dumps([result, code]))

    def test_unified_invalid_actions_and_scope_never_fall_back_to_official(self):
        for args in (
            {},
            {"action": "unknown"},
            {"action": []},
            {"action": "fill", "handle": "login", "owner": "forged"},
            {"action": "list", "password": "SyntheticSecret!"},
        ):
            with self.subTest(args=args):
                self.assertEqual(
                    self.invoke("browser_vault", args)["error_type"], "invalid_arguments"
                )
        self.runtime.task["generation"] += 1
        with self.unified_registry() as (ctx, profile, bindings, _, calls):
            register_vault_overrides(
                ctx, profile, bindings, self.adapter, lease_arg="_lease", lease_error=ValueError
            )
        result = json.loads(
            ctx.tools["browser_vault"]["handler"](
                {"action": "fill", "handle": "login", "_lease": "good"}, session_id="session"
            )
        )
        self.assertEqual(result["error_type"], "binding_denied")
        self.assertEqual(calls, [])
        self.assertEqual(self.port.fills, [])

    def test_unified_unlock_projects_only_the_safe_official_result(self):
        backends = []
        self.source.unlock = lambda backend: backends.append(backend) or {
            "success": True,
            "master_password": "SyntheticSecret!",
        }
        result = self.invoke("browser_vault", {"action": "unlock", "backend": "bitwarden"})
        self.assertEqual(result, {"success": True, "backend": "bitwarden"})
        self.assertEqual(backends, ["bitwarden"])
        self.assertEqual(self.port.fills, [])

    def test_unified_private_inspection_checks_scope_origin_and_nonce_before_resolving(self):
        inspect_port = self.port.inspect
        resolved = []
        self.source.resolve = lambda *args: resolved.append(args) or {
            "password": "SyntheticSecret!"
        }
        for changes, error in (
            ({"taskId": "other"}, "scope_changed"),
            ({"generation": 4}, "scope_changed"),
            ({"modeGeneration": 3}, "scope_changed"),
            ({"origin": "https://other.test"}, "origin_mismatch"),
            ({"nonce": ""}, "scope_changed"),
            ({"documentGeneration": "4"}, "scope_changed"),
        ):
            with self.subTest(changes=changes):
                self.port.inspect = lambda scope: {**inspect_port(scope), **changes}
                result = self.invoke("browser_vault", {"action": "fill", "handle": "login"})
                self.assertEqual(result["error_type"], error)
        self.assertEqual(resolved, [])
        self.assertEqual(self.port.fills, [])


if __name__ == "__main__":
    unittest.main()


class VaultMultiBindingTests(unittest.TestCase):
    def test_attached_binding_revalidates_current_scope_and_retains_fail_closed_claim(self):
        from vault_adapter.integration import VaultBindingRegistry

        runtime = Runtime()
        runtime.task.update(workTabs=[], attachedTabIds=[7])
        registry = VaultBindingRegistry(
            runtime, types.SimpleNamespace(revoke_binding=lambda *_: None)
        )
        for name, change in (
            ("live tabs", lambda: runtime.task.update(tabIds=[])),
            ("attachment", lambda: runtime.task.update(attachedTabIds=[])),
            ("generation", lambda: runtime.task.update(generation=4)),
            ("instance", lambda: runtime.task.update(instanceId="other")),
            ("state", lambda: runtime.task.update(state="cancelled")),
        ):
            with self.subTest(name=name):
                runtime.task.update(
                    tabIds=[7],
                    attachedTabIds=[7],
                    generation=3,
                    instanceId="browser",
                    state="ready",
                )
                registry.bind("session", owner="owner", task_id="task", tab_id=7)
                self.assertEqual(registry.resolve_vault_binding("session")["tab_id"], 7)
                self.assertIsNone(registry.resolve_vault_binding("other-session"))
                change()
                self.assertIsNone(registry.resolve_vault_binding("session"))
                self.assertTrue(registry.claims("session"))
        runtime.task.update(state="ready", tabIds=[], attachedTabIds=[7])
        with self.assertRaises(ValueError):
            registry.bind("session", owner="owner", task_id="task", tab_id=7)
        with self.assertRaises(ValueError):
            registry.bind("session", owner="forged", task_id="task", tab_id=7)

    def test_switch_revokes_old_nonce_and_unbind_preserves_other_task(self):
        from vault_adapter.integration import VaultBindingRegistry

        runtime = Runtime()
        original = runtime.call

        def call(method, params):
            if method == "shared.get" and params["taskId"] == "second":
                return {
                    **runtime.task,
                    "id": "second",
                    "tabIds": [8],
                    "workTabs": [{"tabId": 8, "groupId": 2, "windowId": 2}],
                }
            return original(method, params)

        runtime.call = call
        revoked = []
        port = types.SimpleNamespace(revoke_binding=lambda *args: revoked.append(args))
        registry = VaultBindingRegistry(runtime, port)
        registry.bind("session", owner="owner", task_id="task", tab_id=7)
        registry.bind("session", owner="owner", task_id="second")
        self.assertEqual(registry.resolve_vault_binding("session")["task_id"], "task")
        registry.bind("session", owner="owner", task_id="second", tab_id=8)
        self.assertIn(("session", "owner", "task"), revoked)
        registry.unbind("session", task_id="task")
        self.assertEqual(registry.resolve_vault_binding("session")["tab_id"], 8)
        with self.assertRaises(ValueError):
            registry.bind("session", owner="owner", task_id="second", tab_id=9)

    def test_implicit_multiple_tabs_never_become_credential_target(self):
        from vault_adapter.integration import VaultBindingRegistry

        runtime = Runtime()
        registry = VaultBindingRegistry(
            runtime, types.SimpleNamespace(revoke_binding=lambda *_: None)
        )
        registry.bind("session", owner="owner", task_id="task")
        runtime.task["tabIds"].append(8)
        runtime.task["workTabs"].append({"tabId": 8, "groupId": 1, "windowId": 2})
        self.assertIsNone(registry.resolve_vault_binding("session"))
