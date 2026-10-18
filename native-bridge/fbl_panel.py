"""可信侧栏的初始化和诊断入口；发现与确认分开，关闭协作后重载。"""

from pathlib import Path
from fbl_runtime import Context, doctor, read
from fbl_discovery import changes, confirm


def context(copilot):
    return Context.locate(
        user=copilot.config.get("fbl_user_home"),
        hermes=copilot.config.get("hermes_home"),
        runtime=copilot.directory.parents[2],
    )


def readiness(ctx, diagnostic):
    checks = diagnostic["checks"]

    def ok(*names):
        return all(any(row["component"] == name and row["ok"] for row in checks) for name in names)

    registered = any(row["ok"] for row in checks if row["component"].startswith("host_"))
    items = [
        {
            "id": "setup",
            "ok": registered and ok("runtime", "templates", "fast-copilot"),
            "command": "fbl setup",
        },
        {
            "id": "browser",
            "ok": ok("runtime", "daemon", "extension") and registered,
            "command": "fbl doctor --fix",
        },
        {"id": "integrity", "ok": ok("runtime_integrity"), "command": "fbl update"},
        {"id": "templates", "ok": ok("templates"), "command": "fbl doctor --fix"},
        {
            "id": "profiles",
            "repairable": any(
                row["component"] == "fast-copilot" and row.get("code") == "drift" for row in checks
            ),
            "ok": ok("fast-copilot"),
            "command": "fbl setup",
        },
        {"id": "discovery", "ok": not changes(ctx), "command": "fbl packs discover"},
    ]
    return {"ready": all(row["ok"] for row in items), "items": items, "chains": checks}


def request(copilot, method, params):
    ctx = context(copilot)
    if method == "fbl_pack_state" and not params:
        from fbl_cli import pack_state

        return pack_state(
            ctx,
            copilot.registry.inspect(copilot._tool_context(copilot.active or "pack-manager")),
            busy=any(state["enabled"] for state in copilot.states.values())
            or bool(copilot.registry.jobs)
            or copilot.tool_health_running,
        )
    if (
        method in {"fbl_pack_install", "fbl_pack_remove"}
        and set(params) == {"name"}
        and isinstance(params["name"], str)
    ):
        with copilot.lock:
            if (
                any(state["enabled"] for state in copilot.states.values())
                or copilot.registry.jobs
                or copilot.tool_health_running
            ):
                raise ValueError("close collaboration and wait for jobs before managing packs")
            if (
                method == "fbl_pack_install"
                and params["name"] not in {"general", "seo"}
                and not Path(params["name"]).is_absolute()
            ):
                raise ValueError("absolute plugin folder required")
            from fbl_cli import install_pack, pack_state

            install_pack(ctx, params["name"], remove=method == "fbl_pack_remove")
            config = read(ctx.copilot / "config.json")
            copilot.config.update(
                {key: config[key] for key in ("extension_dirs", "managed_packs") if key in config}
            )
            copilot._reload_tools()
            return pack_state(
                ctx,
                copilot.registry.inspect(copilot._tool_context(copilot.active or "pack-manager")),
            )
    if method in {"fbl_readiness", "fbl_fix"} and not params:
        return readiness(ctx, doctor(ctx, fix=method == "fbl_fix"))
    if method == "fbl_layout" and set(params) == {"url", "tables"}:
        if not isinstance(params["url"], str) or not isinstance(params["tables"], list):
            raise ValueError("invalid layout notice")
        import json

        if len(json.dumps(params).encode()) > 8192:
            raise ValueError("layout notice too large")
        from fbl_discovery import report_layout, candidate
        from copilot import private_write

        row = report_layout(params["url"], {"tables": params["tables"]})
        if not row:
            return {"found": False}
        known = {tool["id"] for tool in copilot.packages.tools}
        if row["tool"]["id"] in known:
            return {"found": False}
        path = ctx.copilot / "discovery-pages.json"
        pending = read(path, [])
        pending = list({item["id"]: item for item in [*pending, candidate(row)]}.values())[-20:]
        private_write(path, json.dumps(pending, ensure_ascii=False))
        return {"found": True}
    if method == "fbl_discover" and not set(params) - {"urls", "scan_tabs"}:
        urls = params.get("urls", [])
        if (
            not isinstance(urls, list)
            or any(not isinstance(url, str) for url in urls)
            or type(params.get("scan_tabs", False)) is not bool
        ):
            raise ValueError("invalid discovery options")
        from fbl_cli import discover

        return discover(ctx, urls, params.get("scan_tabs", False))
    if method == "fbl_confirm" and not set(params) - {"ids", "edits"}:
        result = confirm(ctx, params.get("ids", []), params.get("edits", {}))
        from copilot import private_write
        import json

        state = read(ctx.copilot / "fbl-state.json")
        state["discovery_reviewed"] = True
        private_write(ctx.copilot / "fbl-state.json", json.dumps(state))
        return result
    raise ValueError("invalid fbl request")
