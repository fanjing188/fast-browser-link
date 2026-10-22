"""隔离 HOME 内检查真实 Hermes 注册表；只替换原工具的执行末端，不连接个人浏览器。"""

from pathlib import Path
import json
import os
import shutil
import sys
import tempfile

root = Path(__file__).resolve().parents[2]
source = Path(os.environ["HERMES_SOURCE"])
mode = sys.argv[1]
with tempfile.TemporaryDirectory() as temporary:
    home = Path(temporary).resolve()
    os.environ.update(HOME=str(home), HERMES_HOME=str(home), PYTHONDONTWRITEBYTECODE="1")
    sys.path.insert(0, str(source))
    from hermes_cli import plugins
    from tools.registry import registry
    from tools.registry import discover_builtin_tools

    discover_builtin_tools()
    vault_names = (
        "browser_vault_list",
        "browser_vault_unlock",
        "browser_vault_fill",
        "browser_vault_save_login",
        "browser_vault_enter_code",
    )
    if mode.startswith("unified"):
        # 中文注释：仅合成注册合同；不调用官方 Vault、后端、提示或浏览器。
        for name in () if mode == "unified-mixed" else vault_names:
            entry = registry.get_entry(name)
            if entry is not None:
                registry.restore_registration(name, entry, None)
        registry.register(
            name="browser_vault",
            toolset="browser",
            handler=lambda args, **kw: "unused",
            is_async=mode == "unified-async",
            schema={
                "name": "browser_vault",
                "description": "synthetic official contract",
                "parameters": {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "fill", "save_login", "enter_code", "unlock"],
                        },
                        "handle": {"type": "string"},
                        "label": {"type": "string"},
                        "backend": {"type": "string", "enum": ["onepassword", "bitwarden"]},
                    },
                },
            },
        )
    originals = {entry.name: entry for entry in registry.get_all_entries()}
    browser_names = {name for name in originals if name.startswith("browser_")}
    assert "browser_navigate" in browser_names and "browser_exec" in browser_names
    vault_supported = "browser_vault" in originals or all(name in originals for name in vault_names)
    vault_refused = (mode == "vault" and not vault_supported) or mode == "unified-async"
    calls = []
    # 中文注释：哨兵只替代原生工具的实际浏览器/网络执行，插件管理器、授权 hook、路由与卸载保持真实。
    for name in browser_names:

        def sentinel(args, *, session_id=None, _name=name, **kwargs):
            calls.append((_name, args, session_id))
            return json.dumps({"original": _name, "args": args, "session": session_id})

        async def async_sentinel(args, _sentinel=sentinel, **kwargs):
            return _sentinel(args, **kwargs)

        originals[name].handler = async_sentinel if originals[name].is_async else sentinel
    plugin = home / "plugins/fast-browser-link"
    shutil.copytree(
        root / "executor-plugin", plugin, ignore=shutil.ignore_patterns("__pycache__", "tests")
    )
    shutil.copytree(
        root / "native-bridge",
        plugin / "native_bridge",
        ignore=shutil.ignore_patterns("__pycache__", "tests"),
    )
    allowed = mode in {
        "override",
        "vault",
        "unified-off",
        "unified-sync",
        "unified-async",
        "unified-mixed",
        "unified-failure",
    }
    vault_enabled = mode in {
        "vault",
        "unified-sync",
        "unified-async",
        "unified-mixed",
        "unified-failure",
    }
    configuration = (
        "plugins:\n  enabled: [fast-browser-link]\n  entries:\n    fast-browser-link:\n"
        f"      allow_tool_override: {str(allowed).lower()}\n"
    )
    if mode != "unified-off":
        configuration += (
            "      settings:\n        vault_tools:\n"
            + f"          enabled: {str(vault_enabled).lower()}\n"
        )
    (home / "config.yaml").write_text(configuration)
    if mode == "legacy":
        # 中文注释：即使旧插件尚未加载或已禁用，也不能擅自接管其工具；此目录只作存在性夹具。
        (home / "plugins/browser-link").mkdir()
        (home / "plugins/browser-link/user-data").write_text("unchanged")
    manager = plugins.get_plugin_manager()
    if mode == "unified-failure":
        register_tool = plugins.PluginContext.register_tool

        def fail_after_vault(self, **kwargs):
            result = register_tool(self, **kwargs)
            if kwargs["name"] == "browser_vault":
                raise RuntimeError("synthetic Vault registration failure")
            return result

        plugins.PluginContext.register_tool = fail_after_vault
    manager.discover_and_load(force=True)
    loaded = manager._plugins.get("fast-browser-link")
    assert loaded is not None
    if mode == "legacy":
        assert loaded.error and not loaded.tools_registered and not loaded.hooks_registered, loaded
        assert (home / "plugins/browser-link/user-data").read_text() == "unchanged"
    elif vault_refused or mode == "unified-failure":
        expected = (
            "synthetic Vault registration failure"
            if mode == "unified-failure"
            else "async Vault contract unsupported"
            if mode == "unified-async"
            else "official Vault tool unavailable"
        )
        assert loaded.error == expected, loaded
        assert not loaded.enabled and not loaded.tools_registered and not loaded.hooks_registered
        for name in loaded.manifest.provides_tools:
            assert registry.get_entry(name, scope=manager.scope_key) is None, name
    else:
        assert loaded.enabled and not loaded.error, loaded
        assert registry.get_entry("fast_browser_open", scope=manager.scope_key) is not None
        assert registry.get_entry("fast_browser_script", scope=manager.scope_key) is not None
    changed = []
    for name, original in originals.items():
        current = registry.get_entry(name, scope=manager.scope_key)
        assert current is not None, name
        if current.handler is not original.handler:
            changed.append(name)
            assert allowed and name in browser_names, name
            assert (
                current.toolset == original.toolset
                and current.requires_env == original.requires_env
            ), name
            assert current.is_async == original.is_async, name
            if name == "browser_vault" or name.startswith("browser_vault_"):
                assert vault_enabled, name
        if not allowed or vault_refused or mode == "unified-failure":
            assert current.handler is original.handler and current.schema == original.schema, name
    if allowed and not vault_refused and mode != "unified-failure":
        assert "browser_navigate" in changed and "browser_exec" in changed
        for index, name in enumerate(sorted(browser_names)):
            args = {"probe": "unbound"}
            block, bounded = plugins._dispatch_pre_tool_call_hooks(
                name, args, session_id="unbound", tool_call_id=f"probe-{index}"
            )
            assert block is None, (name, block)
            result = json.loads(
                registry.dispatch(
                    name,
                    args if bounded is None else bounded,
                    scope=manager.scope_key,
                    session_id="unbound",
                )
            )
            assert result == {"original": name, "args": args, "session": "unbound"}, (name, result)
    manager.unload()
    if mode in {"unified-failure", "unified-async"}:
        for module in list(sys.modules.values()):
            if str(getattr(module, "__file__", "")).endswith("/native_runtime.py"):
                assert str(home) not in getattr(module, "_RUNTIMES", {}), (
                    "failed load leaked runtime"
                )
    for name, original in originals.items():
        restored = registry.get_entry(name, scope=manager.scope_key)
        assert restored is original, name
        assert restored.schema == original.schema and restored.is_async == original.is_async, name
    assert registry.get_entry("fast_browser_open", scope=manager.scope_key) is None
    print(
        json.dumps(
            {
                "mode": mode,
                "original_tools": len(originals),
                "browser_tools": len(browser_names),
                "changed": sorted(changed),
                "unbound_calls": len(calls),
                "unload_restored": True,
                "vault_supported": vault_supported,
                "vault_opt_in_refused": vault_refused,
            }
        )
    )
