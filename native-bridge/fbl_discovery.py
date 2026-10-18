"""发现只使用声明、帮助、schema 和页面布局；确认后才保存本机绑定。"""

import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import shutil
import subprocess
import time
import tempfile
import copy
import sys
from urllib.parse import urlsplit
from fbl_runtime import agent_roots, read, safe
from fbl_runtime import private_write
from copilot_packages import Packages, validate_binding
from copilot_capabilities import CAPABILITIES


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def file_digest(path):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 1024 * 1024:
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def no_network_help(argv, runner=subprocess.run):
    if not argv or not all(isinstance(item, str) for item in argv):
        return {"status": "parameters_unknown"}
    sandbox = shutil.which("sandbox-exec")
    if not sandbox:
        return {"status": "network_sandbox_unavailable"}
    try:
        prefix = [argv[0]]
        if len(argv) > 1 and Path(argv[1]).is_file():
            prefix.append(argv[1])
        result = runner(
            [sandbox, "-p", "(version 1)(allow default)(deny network*)", *prefix, "--help"],
            capture_output=True,
            text=True,
            timeout=3,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        output = (result.stdout or "")[:8192]
        return {
            "status": "available" if result.returncode == 0 else "help_failed",
            "help": output,
            "digest": hashlib.sha256(output.encode()).hexdigest(),
        }
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "help_failed"}


def mcp_servers(ctx):
    from fbl_profiles import read_config

    sources = [
        *((path, "mcp_servers") for path in (ctx.hermes / "profiles").glob("*/config.yaml")),
        (ctx.user / ".claude.json", "mcpServers"),
        (ctx.user / ".claude/settings.json", "mcpServers"),
        (ctx.hermes / "config.yaml", "mcp_servers"),
    ]
    rows = []
    for path, key in sources:
        if not path.is_file() or any(part.is_symlink() for part in (path, *path.parents)):
            continue
        try:
            value = read_config(path, ctx.hermes) if path.suffix == ".yaml" else read(path)
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict) or not isinstance(value.get(key, {}), dict):
            continue
        for name, server in value.get(key, {}).items():
            if isinstance(server, dict) and server.get("disabled") is not True:
                rows.append({"name": name, "config": str(path), "server": server})
    path = ctx.user / ".codex/config.toml"
    if path.is_file() and not path.is_symlink():
        import tomllib

        value = tomllib.loads(path.read_text())
        for name, server in value.get("mcp_servers", {}).items():
            rows.append({"name": name, "config": str(path), "server": server})
    return rows


def mcp_rpc(server, method, params=None, *, timeout=5):
    """只读发现调用 tools/list；执行工具仅由已确认的 binding 调用 tools/call。"""
    if method not in {"tools/list", "tools/call"}:
        raise ValueError("MCP method not allowed")
    if server.get("url"):
        return mcp_http(server, method, params or {}, timeout=timeout)
    command = server.get("command")
    args = server.get("args", [])
    if not isinstance(command, str) or not isinstance(args, list):
        raise ValueError("stdio MCP command missing")
    if not isinstance(server.get("env", {}), dict):
        raise ValueError("invalid MCP environment")
    env = {**os.environ, **{key: str(value) for key, value in server.get("env", {}).items()}}
    process = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    def call(identity, name, values):
        process.stdin.write(
            json.dumps({"jsonrpc": "2.0", "id": identity, "method": name, "params": values}) + "\n"
        )
        process.stdin.flush()
        deadline = time.monotonic() + timeout
        buffer = b""
        while time.monotonic() < deadline:
            if not selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise ValueError("MCP exited")
            buffer += chunk
            if len(buffer) > 262144:
                raise ValueError("MCP schema exceeds limit")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                message = json.loads(line)
                if message.get("id") == identity:
                    if "error" in message:
                        raise ValueError("MCP metadata unavailable")
                    return message.get("result", {})
        raise TimeoutError("MCP metadata timed out")

    try:
        call(
            1,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "fbl", "version": "1"},
            },
        )
        process.stdin.write(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        )
        process.stdin.flush()
        return call(2, method, params or {})
    finally:
        selector.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdin.close()
        process.stdout.close()


def mcp_http(server, method, params, timeout=5):
    if method not in {"tools/list", "tools/call"}:
        raise ValueError("MCP method not allowed")
    import urllib.request

    parsed = urlsplit(server["url"])
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("invalid MCP URL")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError("MCP redirects require configuration review")

    opener = urllib.request.build_opener(NoRedirect())
    headers = {
        **server.get("http_headers", {}),
        **server.get("headers", {}),
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    for name, variable in server.get("env_http_headers", {}).items():
        if os.environ.get(variable):
            headers[name] = os.environ[variable]
    token_name = server.get("bearer_token_env_var")
    if token_name and os.environ.get(token_name):
        headers["Authorization"] = "Bearer " + os.environ[token_name]

    def call(identity, name, values):
        payload = {"jsonrpc": "2.0", "method": name, "params": values}
        if identity is not None:
            payload["id"] = identity
        request = urllib.request.Request(
            server["url"], data=json.dumps(payload).encode(), headers=headers
        )
        with opener.open(request, timeout=timeout) as response:
            if response.headers.get("Mcp-Session-Id"):
                headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
            data = response.read(262145)
            if len(data) > 262144:
                raise ValueError("MCP response exceeds limit")
        if identity is None or not data:
            return {}
        text = data.decode()
        messages = (
            [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]
            if text.lstrip().startswith(("event:", "data:"))
            else [json.loads(text)]
        )
        message = next((item for item in messages if item.get("id") == identity), None)
        if not message or "error" in message:
            raise ValueError("MCP metadata unavailable")
        return message.get("result", {})

    initialized = call(
        1,
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "fbl", "version": "1"},
        },
    )
    headers["MCP-Protocol-Version"] = initialized.get("protocolVersion", "2025-03-26")
    call(None, "notifications/initialized", {})
    return call(2, method, params)


def capability_for(name, properties):
    name = name.casefold().replace("_", ".")
    patterns = {
        "keyword.metrics": r"keyword.*(?:metric|volume|difficulty)",
        "keyword.expand": r"keyword.*(?:expand|suggest)|expand.*keyword",
        "keyword.questions": r"keyword.*question|question.*keyword",
        "serp.top": r"serp|search.*result",
        "domain.keywords": r"domain.*keyword",
        "domain.top_pages": r"top.*page",
        "domain.authority": r"domain.*(?:authority|rating)",
        "trends.series": r"trend",
    }
    return next(
        (
            cap
            for cap, pattern in patterns.items()
            if re.search(pattern, name)
            and set(properties) & {"keyword", "keywords", "domain", "url"}
        ),
        None,
    )


def report_layout(url, metadata):
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("invalid tool URL")
    if metadata.get("blocked"):
        return None
    aliases = {
        "keyword": ["keyword", "关键词", "搜索词", "search term"],
        "vol": ["volume", "搜索量", "月搜索量"],
        "kd": ["kd", "difficulty", "难度"],
        "domain": ["domain", "域名"],
        "url": ["url", "页面", "page"],
        "traffic": ["traffic", "流量"],
    }
    tables = metadata.get("tables", [])
    matches = []
    for table in tables:
        headers = table.get("headers", [])
        columns = {
            field: [header for header in headers if header.strip().casefold() in names]
            for field, names in aliases.items()
        }
        columns = {field: values for field, values in columns.items() if values}
        cap = (
            "keyword.metrics"
            if "keyword" in columns and ("vol" in columns or "kd" in columns)
            else "domain.keywords"
            if "keyword" in columns and "domain" in columns
            else "domain.top_pages"
            if "url" in columns and "traffic" in columns
            else "domain.competitors"
            if "domain" in columns
            else None
        )
        if cap:
            matches.append((cap, columns))
    if len(matches) != 1:
        return None
    cap, columns = matches[0]
    identity = "local-web-" + digest([parsed.hostname, parsed.path, columns])[:12]
    tool = {
        "id": identity,
        "hosts": [parsed.hostname],
        "name": {"zh": "本机报表", "en": "Local report"},
        "links": {"report": url},
        "pages": [
            {
                "id": "report",
                "paths": ["^" + re.escape(parsed.path) + "$"],
                "columns": columns,
                "actions": [cap],
                "flows": [],
            }
        ],
        "probe": {"url": url, "ready_selectors": ["table", "[role=grid]"]},
    }
    binding = {
        "id": identity,
        "type": "browser",
        "tool": identity,
        "page": "report",
        "link": "report",
        "verified": True,
        "serial_group": identity,
        "batch_limit": 100,
        "cost": "unknown",
        "disable_on": ["login", "captcha", "quota", "rate_limit"],
        "max_pages": 1,
    }
    return {
        "capability": cap,
        "binding": binding,
        "tool": tool,
        "cost": "unknown",
        "confidence": 0.9,
        "validation": "available",
        "basis": "one report layout matched visible headers",
        "source": "browser",
        "source_ref": url,
    }


def candidate(row):
    row = {**row}
    row["id"] = digest(
        [row.get("source"), row.get("source_ref"), row.get("capability"), row.get("binding")]
    )[:24]
    row["selected"] = (
        row.get("cost") in {"zero", "free", "local"}
        and row.get("confidence", 0) >= 0.95
        and row.get("validation") == "available"
    )
    return row


def scan(
    ctx,
    *,
    draft=None,
    help_probe=no_network_help,
    mcp_probe=mcp_rpc,
    browser_probe=None,
    tab_probe=None,
    urls=(),
    scan_tabs=False,
):
    found = read(ctx.copilot / "discovery-pages.json", [])
    files = {}
    drafts = []
    errors = []
    for root in agent_roots(ctx):
        directory = Path(root["path"])
        if not directory.is_dir() or directory.is_symlink():
            continue
        for skill in list(directory.rglob("SKILL.md"))[:200]:
            if skill.is_symlink() or not skill.resolve().is_relative_to(directory.resolve()):
                continue
            files[str(skill)] = file_digest(skill)
            manifest = skill.parent / "fbl-capabilities.json"
            if manifest.is_file():
                if manifest.is_symlink():
                    errors.append({"source": "manifest", "code": "unsafe_path"})
                    continue
                files[str(manifest)] = file_digest(manifest)
                try:
                    value = read(manifest)
                except (OSError, ValueError):
                    errors.append({"source": "manifest", "code": "invalid_json"})
                    continue
                if value.get("version") != 1:
                    errors.append({"source": "manifest", "code": "unsupported_version"})
                    continue
                for entry in value.get("bindings", [])[:50]:
                    binding = dict(entry.get("binding", {}))
                    cap = entry.get("capability")
                    if cap not in CAPABILITIES:
                        continue
                    try:
                        validate_binding(binding)
                        if binding["type"] == "command":
                            argv = []
                            for arg in binding["argv"]:
                                local = skill.parent / arg
                                argv.append(
                                    str(local.resolve())
                                    if local.is_file() and not local.is_symlink()
                                    else arg
                                )
                            binding["argv"] = argv
                            if Path(argv[0]).is_file():
                                files[argv[0]] = file_digest(argv[0])
                            executable = (
                                Path(argv[0]).is_file()
                                if "/" in argv[0]
                                else bool(shutil.which(argv[0]))
                            )
                            paths = [
                                Path(arg)
                                for arg in argv[1:]
                                if arg.endswith((".py", ".sh", ".mjs", ".js")) and "{" not in arg
                            ]
                            valid = executable and all(path.is_file() for path in paths)
                            for path in paths:
                                files[str(path)] = file_digest(path)
                            probe = (
                                help_probe(argv)
                                if valid
                                else {"status": "missing_command_or_script"}
                            )
                        else:
                            probe = {"status": "parameters_unknown"}
                        found.append(
                            candidate(
                                {
                                    "source": "manifest",
                                    "source_ref": str(manifest),
                                    "capability": cap,
                                    "binding": binding,
                                    "cost": entry.get("cost", "unknown"),
                                    "confidence": 1.0,
                                    "validation": probe["status"],
                                    "help_digest": probe.get("digest"),
                                    "basis": "explicit capability declaration",
                                }
                            )
                        )
                    except (ValueError, KeyError, TypeError):
                        errors.append({"source": "manifest", "code": "invalid_binding"})
            else:
                scripts = [
                    path
                    for path in (skill.parent / "scripts").glob("*")
                    if path.suffix in {".py", ".sh"} and path.is_file() and not path.is_symlink()
                ][:4]
                helps = []
                for path in scripts:
                    files[str(path)] = file_digest(path)
                    argv = (
                        [sys.executable, str(path)] if path.suffix == ".py" else ["sh", str(path)]
                    )
                    probe = help_probe(argv)
                    helps.append(
                        {"argv": argv, "status": probe["status"], "help": probe.get("help", "")}
                    )
                drafts.append(
                    {"source": str(skill), "text": skill.read_text()[:6000], "scripts": helps}
                )
    if drafts and draft:
        try:
            for row in draft(drafts[:20]):
                validate_binding(row["binding"])
                row.update(
                    source="model_draft",
                    confidence=min(0.8, row.get("confidence", 0.5)),
                    validation="parameters_unknown",
                    cost="unknown",
                    basis="模型起草·待确认",
                )
                found.append(candidate(row))
        except (ValueError, OSError, KeyError, TypeError, RuntimeError):
            errors.append({"source": "model_draft", "code": "draft_unavailable"})
    elif drafts:
        errors.append(
            {"source": "model_draft", "code": "inference_not_configured", "count": len(drafts)}
        )
    for item in mcp_servers(ctx):
        files[item["config"]] = file_digest(item["config"])
        try:
            result = mcp_probe(item["server"], "tools/list")
            files["mcp:" + item["config"] + ":" + item["name"]] = digest(result)
            for tool in result.get("tools", [])[:200]:
                schema = tool.get("inputSchema", {})
                cap = capability_for(tool.get("name", ""), schema.get("properties", {}))
                if not cap:
                    continue
                binding = {
                    "id": "mcp-" + digest([item["name"], tool["name"]])[:16],
                    "type": "mcp",
                    "config_path": item["config"],
                    "server": item["name"],
                    "tool_name": tool["name"],
                    "batch_limit": 1,
                    "cost": "unknown",
                    "input_fields": list(schema.get("properties", {})),
                }
                found.append(
                    candidate(
                        {
                            "source": "mcp",
                            "source_ref": item["config"],
                            "capability": cap,
                            "binding": binding,
                            "cost": "unknown",
                            "confidence": 0.96,
                            "validation": "available",
                            "basis": "tools/list input schema match",
                        }
                    )
                )
        except (ValueError, OSError, TimeoutError):
            errors.append({"source": "mcp", "code": "schema_unavailable"})
    pages = list(urls)
    if scan_tabs:
        if tab_probe:
            pages.extend(row["url"] for row in tab_probe() if row.get("url"))
        else:
            errors.append({"source": "browser", "code": "tab_inventory_unavailable"})
    for url in list(dict.fromkeys(pages))[:20]:
        try:
            if not browser_probe:
                errors.append({"source": "browser", "code": "browser_not_connected"})
                continue
            metadata = browser_probe(url)
            row = report_layout(url, metadata)
            if row:
                row["layout_digest"] = digest(metadata.get("tables", []))
                found.append(candidate(row))
            else:
                errors.append(
                    {"source": "browser", "code": metadata.get("blocked") or "layout_unknown"}
                )
        except (ValueError, OSError, RuntimeError):
            errors.append({"source": "browser", "code": "page_unavailable"})
    value = {
        "version": 1,
        "candidates": list({row["id"]: row for row in found}.values()),
        "files": files,
        "errors": errors,
        "confirmed": False,
    }
    private_write(
        ctx.copilot / "discovery-draft.json", json.dumps(value, ensure_ascii=False, indent=2)
    )
    return value


def confirm(ctx, ids, edits=None):
    draft = read(ctx.copilot / "discovery-draft.json")
    selected = {row["id"]: row for row in draft.get("candidates", [])}
    if (
        not isinstance(ids, list)
        or any(not isinstance(identity, str) for identity in ids)
        or set(ids) - selected.keys()
    ):
        raise ValueError("unknown discovery candidate")
    for path, expected in draft.get("files", {}).items():
        if not path.startswith("mcp:") and file_digest(path) != expected:
            raise ValueError("source changed; discover and confirm again")
    target = safe(ctx.copilot / "extensions/discovered")
    from fbl_update import tree_digest

    if (
        target.exists()
        and (target / ".fbl-pack.json").is_file()
        and read(target / ".fbl-pack.json").get("sha256") != tree_digest(target)
    ):
        raise ValueError("confirmed package modified; preserve and review")
    package = read(
        target / "package.json", {"id": "discovered", "version": 1, "capabilities": {}, "tools": []}
    )
    for identity in dict.fromkeys(ids):
        row = selected[identity]
        if row["capability"] not in CAPABILITIES:
            raise ValueError("unknown capability")
        edit = (edits or {}).get(identity, {})
        if set(edit) - {
            "priority",
            "argv",
            "batch_limit",
            "serial_group",
            "disable_on",
            "timeout",
            "stop_text",
        }:
            raise ValueError("unsupported candidate edit")
        binding = {**row["binding"], "cost": row.get("cost", "unknown"), **edit}
        tool = copy.deepcopy(row.get("tool"))
        if tool:
            existing = next(
                (
                    item
                    for item in package.get("tools", [])
                    if set(item["hosts"]) & set(tool["hosts"])
                ),
                None,
            )
            if existing:
                page_id = row["id"]
                page = {**tool["pages"][0], "id": page_id}
                existing["pages"] = [
                    item for item in existing["pages"] if item["id"] != page_id
                ] + [page]
                existing["links"][page_id] = tool["links"]["report"]
                binding.update(tool=existing["id"], page=page_id, link=page_id)
                tool = None
        validate_binding(binding)
        if binding["type"] == "command":
            for arg in binding["argv"]:
                if (
                    arg.endswith((".py", ".sh", ".mjs", ".js"))
                    and "{" not in arg
                    and not Path(arg).is_file()
                ):
                    raise ValueError("binding script missing")
        for entries in package["capabilities"].values():
            entries[:] = [item for item in entries if item["id"] != binding["id"]]
        package["capabilities"].setdefault(row["capability"], []).append(binding)
        if tool:
            package["tools"] = [
                item for item in package.get("tools", []) if item["id"] != tool["id"]
            ] + [tool]
    # 中文注释：完整校验候选副本后才替换单个声明文件；失败保留原绑定和配置。
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=target.parent, prefix=".discovery-") as temp:
        stage = Path(temp)
        private_write(stage / "package.json", json.dumps(package, ensure_ascii=False, indent=2))
        Packages([str(stage)], include_builtin=False)
        private_write(target / "package.json", (stage / "package.json").read_text())
    private_write(
        target / ".fbl-pack.json", json.dumps({"version": 1, "sha256": tree_digest(target)})
    )
    config = read(ctx.copilot / "config.json")
    config["extension_dirs"] = list(dict.fromkeys([*config.get("extension_dirs", []), str(target)]))
    private_write(ctx.copilot / "config.json", json.dumps(config, indent=2))
    previous = read(ctx.copilot / "discovery-confirmed.json")
    private_write(
        ctx.copilot / "discovery-confirmed.json",
        json.dumps(
            {
                "version": 1,
                "files": {**previous.get("files", {}), **draft.get("files", {})},
                "ids": list(dict.fromkeys([*previous.get("ids", []), *ids])),
                "candidates": list(
                    {
                        row["id"]: row
                        for row in [
                            *previous.get("candidates", []),
                            *[selected[identity] for identity in ids],
                        ]
                    }.values()
                ),
            },
            indent=2,
        ),
    )
    return {"installed": len(ids), "path": str(target), "confirmed": True}


def changes(
    ctx,
    *,
    deep=False,
    help_probe=no_network_help,
    mcp_probe=mcp_rpc,
    browser_probe=None,
    stop=lambda: False,
):
    confirmed = read(ctx.copilot / "discovery-confirmed.json")
    files = confirmed.get("files", {})
    changed = [
        path
        for path, digest_value in files.items()
        if not path.startswith("mcp:") and file_digest(path) != digest_value
    ]
    if deep:
        for row in confirmed.get("candidates", []):
            if stop():
                return changed
            if row.get("help_digest") and row.get("binding", {}).get("argv"):
                if help_probe(row["binding"]["argv"]).get("digest") != row["help_digest"]:
                    changed.append("help:" + row["id"])
            if row.get("layout_digest") and browser_probe:
                try:
                    if (
                        digest(browser_probe(row["source_ref"]).get("tables", []))
                        != row["layout_digest"]
                    ):
                        changed.append("layout:" + row["id"])
                except (OSError, RuntimeError, ValueError):
                    changed.append("layout_unavailable:" + row["id"])
        for item in mcp_servers(ctx):
            if stop():
                return changed
            key = "mcp:" + item["config"] + ":" + item["name"]
            if key not in files:
                continue
            try:
                if digest(mcp_probe(item["server"], "tools/list")) != files[key]:
                    changed.append(key)
            except (OSError, RuntimeError, TimeoutError, ValueError):
                changed.append("schema_unavailable:" + item["name"])
    known = set(files)
    for root in agent_roots(ctx):
        path = Path(root["path"])
        if path.is_dir() and not path.is_symlink():
            changed.extend(
                str(skill)
                for skill in list(path.rglob("SKILL.md"))[:200]
                if not skill.is_symlink() and str(skill) not in known
            )
    return sorted(set(changed))[:200] if confirmed else []


def mcp_call(binding, inputs):
    from fbl_profiles import read_config

    path = Path(binding["config_path"])
    if not path.is_file() or path.is_symlink():
        raise ValueError("MCP binding configuration missing")
    if path.suffix == ".toml":
        import tomllib

        value = tomllib.loads(path.read_text())
    else:
        value = read_config(path, path.parent)
    servers = value.get("mcp_servers", value.get("mcpServers", {}))
    server = servers.get(binding["server"])
    if not isinstance(server, dict):
        raise ValueError("MCP server no longer configured")
    result = mcp_rpc(
        server,
        "tools/call",
        {
            "name": binding["tool_name"],
            "arguments": {
                key: value
                for key, value in inputs.items()
                if key in binding.get("input_fields", [])
            },
        },
    )
    if result.get("isError"):
        raise ValueError("MCP tool failed")
    value = result.get("structuredContent")
    if value is None:
        text = next(
            (
                block.get("text")
                for block in result.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            ),
            None,
        )
        if not isinstance(text, str):
            raise ValueError("MCP result has no structured JSON output")
        value = json.loads(text)
    if isinstance(value, list):
        value = {"records": value}
    if not isinstance(value, dict):
        raise ValueError("MCP result must be an object or records array")
    value.setdefault("source", binding["id"])
    return value
