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
from contextlib import contextmanager
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
    with mcp_stdio_session(server, timeout=timeout) as call:
        return call(method, params)


class MCPBudget:
    def __init__(self, timeout, max_bytes):
        self.deadline = time.monotonic() + timeout
        self.remaining_bytes = max_bytes

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("MCP metadata timed out")
        return remaining

    def consume(self, data):
        self.remaining()
        self.remaining_bytes -= len(data)
        if self.remaining_bytes < 0:
            raise ValueError("MCP response exceeds total byte limit")


def mcp_message(data):
    try:
        message = json.loads(data)
    except RecursionError:
        raise ValueError("MCP JSON nesting exceeds limit") from None
    if not isinstance(message, dict):
        raise ValueError("invalid MCP message")
    if message.get("method") == "notifications/tools/list_changed":
        raise ValueError("MCP tool directory changed; refresh required")
    return message


@contextmanager
def mcp_stdio_session(server, *, timeout=5, max_bytes=4 * 1024 * 1024):
    """一次握手覆盖整个目录，游标不能跨进程复用。"""
    command = server.get("command")
    args = server.get("args", [])
    if not isinstance(command, str) or not isinstance(args, list):
        raise ValueError("stdio MCP command missing")
    if not isinstance(server.get("env", {}), dict):
        raise ValueError("invalid MCP environment")
    env = {**os.environ, **{key: str(value) for key, value in server.get("env", {}).items()}}
    budget = MCPBudget(timeout, max_bytes)
    process = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        bufsize=0,
        start_new_session=True,
    )
    os.set_blocking(process.stdin.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b""

    def send(payload):
        data = memoryview((json.dumps(payload, allow_nan=False) + "\n").encode())
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("MCP request exceeds limit")
        with selectors.DefaultSelector() as writer:
            writer.register(process.stdin, selectors.EVENT_WRITE)
            while data:
                if not writer.select(budget.remaining()):
                    continue
                try:
                    data = data[os.write(process.stdin.fileno(), data[:65536]) :]
                except BlockingIOError:
                    continue

    def call(identity, name, values):
        nonlocal buffer
        budget.remaining()
        send({"jsonrpc": "2.0", "id": identity, "method": name, "params": values})
        while True:
            if not selector.select(min(0.1, budget.remaining())):
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                raise ValueError("MCP exited")
            budget.consume(chunk)
            buffer += chunk
            if len(buffer) > 262144:
                raise ValueError("MCP schema exceeds limit")
            matched = None
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                message = mcp_message(line)
                if message.get("id") == identity:
                    if "error" in message or not isinstance(message.get("result"), dict):
                        raise ValueError("MCP metadata unavailable")
                    matched = message["result"]
            if matched is not None:
                return matched

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
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        identity = 1

        def request(method, params=None):
            nonlocal identity
            identity += 1
            return call(identity, method, params or {})

        yield request
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
    with mcp_http_session(server, timeout=timeout) as call:
        return call(method, params)


def mcp_http_opener(budget):
    """每次底层 I/O 共用截止；保留 urllib 的代理、TLS 校验和拒绝重定向。"""
    import http.client
    import io
    import socket
    import urllib.request

    class DeadlineReader(io.RawIOBase):
        def __init__(self, sock):
            self.sock = sock
            self.stream = sock.makefile("rb", buffering=0)

        def readable(self):
            return True

        def readinto(self, buffer):
            self.sock.settimeout(budget.remaining())
            return self.stream.readinto(buffer)

        def close(self):
            try:
                self.stream.close()
            finally:
                super().close()

    class ResponseSocket:
        def __init__(self, sock):
            self.sock = sock

        def makefile(self, *_):
            return io.BufferedReader(DeadlineReader(self.sock))

    class DeadlineResponse(http.client.HTTPResponse):
        def __init__(self, sock, *args, **kwargs):
            super().__init__(ResponseSocket(sock), *args, **kwargs)

    def connect(address, timeout, source_address):
        host, port = address
        # 中文注释：系统 DNS 无法在这里中断；返回后先查截止，绝不迟到派发。
        addresses = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        error = OSError("MCP host has no addresses")
        for family, kind, proto, _, target in addresses:
            sock = socket.socket(family, kind, proto)
            try:
                if source_address:
                    sock.bind(source_address)
                sock.settimeout(budget.remaining())
                sock.connect(target)
                sock.settimeout(budget.remaining())
                return sock
            except (OSError, TimeoutError) as failure:
                error = failure
                sock.close()
        raise error

    class DeadlineConnection:
        response_class = DeadlineResponse

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._create_connection = connect

        def connect(self):
            super().connect()
            self.sock.settimeout(budget.remaining())

        def _tunnel(self):
            super()._tunnel()
            self.sock.settimeout(budget.remaining())

        def send(self, data):
            budget.remaining()
            if self.sock is None:
                self.connect()
            sys.audit("http.client.send", self, data)
            # 中文注释：请求只有序列化 JSON 字节；SSL 的多次短写也逐次扣同一截止。
            remaining = memoryview(data)
            while remaining:
                self.sock.settimeout(budget.remaining())
                sent = self.sock.send(remaining[:65536])
                if not sent:
                    raise OSError("MCP connection closed during request write")
                remaining = remaining[sent:]
            budget.remaining()

    class HTTPConnection(DeadlineConnection, http.client.HTTPConnection):
        pass

    class HTTPSConnection(DeadlineConnection, http.client.HTTPSConnection):
        pass

    class HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, request):
            return self.do_open(HTTPConnection, request)

    class HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, request):
            return self.do_open(HTTPSConnection, request, context=self._context)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError("MCP redirects require configuration review")

    return urllib.request.build_opener(HTTPHandler(), HTTPSHandler(), NoRedirect())


@contextmanager
def mcp_http_session(server, *, timeout=5, max_bytes=4 * 1024 * 1024):
    import http.client
    import urllib.request

    parsed = urlsplit(server["url"])
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("invalid MCP URL")

    budget = MCPBudget(timeout, max_bytes)
    opener = mcp_http_opener(budget)
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

    def exchange(identity, name, values):
        payload = {"jsonrpc": "2.0", "method": name, "params": values}
        if identity is not None:
            payload["id"] = identity
        request = urllib.request.Request(
            server["url"], data=json.dumps(payload).encode(), headers=headers
        )
        with opener.open(request, timeout=budget.remaining()) as response:
            if response.headers.get("Mcp-Session-Id"):
                headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
            sse = response.headers.get_content_type() == "text/event-stream"
            data, total, trailing_cr = b"", 0, False
            while True:
                # 中文注释：read1 不等待 SSE 连接关闭；头部及 body 均由底层 reader 限时。
                chunk = getattr(response, "read1", response.read)(65536)
                budget.consume(chunk)
                total += len(chunk)
                if total > 262144:
                    raise ValueError("MCP response exceeds limit")
                messages = []
                if sse:
                    # 中文注释：CR 本身结束一行；跨块 CRLF 的 LF 只吞一次，不能变成空行。
                    incoming = chunk[1:] if trailing_cr and chunk.startswith(b"\n") else chunk
                    trailing_cr = chunk.endswith(b"\r")
                    normalized = data + incoming.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                    while b"\n\n" in normalized:
                        frame, normalized = normalized.split(b"\n\n", 1)
                        lines = [
                            line[5:].lstrip(b" ")
                            for line in frame.splitlines()
                            if line.startswith(b"data:")
                        ]
                        if lines:
                            messages.append(mcp_message(b"\n".join(lines)))
                    data = normalized
                else:
                    data += chunk
                    try:
                        messages = [mcp_message(data)] if data else []
                        data = b""
                    except json.JSONDecodeError:
                        if not chunk:
                            raise ValueError("invalid MCP response") from None
                matched = None
                for message in messages:
                    if message.get("id") == identity and identity is not None:
                        if "error" in message or not isinstance(message.get("result"), dict):
                            raise ValueError("MCP metadata unavailable")
                        matched = message["result"]
                if matched is not None:
                    return matched
                if identity is None:
                    return {}
                if not chunk:
                    raise ValueError("MCP metadata unavailable")

    def call(identity, name, values):
        try:
            return exchange(identity, name, values)
        except http.client.HTTPException as error:
            # 中文注释：只规范传输协议错误，scan 不吞自己的编程错误。
            raise ValueError("invalid MCP HTTP response") from error

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
    identity = 1

    def request(method, params=None):
        nonlocal identity
        identity += 1
        return call(identity, method, params or {})

    yield request


def mcp_structure(
    root, *, label="tool metadata", max_depth=80, max_values=30000, max_bytes=1048576
):
    """先非递归核完整 JSON 树，防止扩展字段绕过 schema 预算后破坏复制和刷新。"""
    pending, count = [(root, 0)], 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if depth > max_depth or count > max_values:
            raise ValueError(f"MCP {label} structure exceeds limit")
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise ValueError(f"invalid MCP {label} JSON key")
            children = value.values()
        elif isinstance(value, list):
            children = value
        else:
            if value is not None and type(value) not in (str, int, float, bool):
                raise ValueError(f"invalid MCP {label} JSON value")
            children = ()
        if len(pending) + len(children) + count > max_values:
            raise ValueError(f"MCP {label} structure exceeds limit")
        pending.extend((child, depth + 1) for child in children)
    if len(json.dumps(root, allow_nan=False).encode()) > max_bytes:
        raise ValueError(f"MCP {label} exceeds byte limit")


def mcp_schema(schema):
    """有界校验 2020-12 关键词；保留扩展，不解析或下载引用。"""
    import math

    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ValueError("invalid MCP schema root")
    kinds = {"object", "array", "string", "integer", "number", "boolean", "null"}
    mcp_structure(schema, label="schema", max_depth=64, max_values=10000, max_bytes=262144)

    def strings(value):
        if (
            not isinstance(value, list)
            or any(not isinstance(v, str) for v in value)
            or len(set(value)) != len(value)
        ):
            raise ValueError("invalid MCP schema string array")

    def regex(value):
        if not isinstance(value, str):
            raise ValueError("invalid MCP schema regex")
        try:
            re.compile(value)
        except (re.error, RecursionError, OverflowError):
            raise ValueError("invalid MCP schema regex") from None

    def check(node, depth=0):
        if type(node) is bool:
            return
        if not isinstance(node, dict) or depth > 32:
            raise ValueError("invalid MCP schema node")
        if "type" in node:
            values = node["type"] if isinstance(node["type"], list) else [node["type"]]
            if not values or any(not isinstance(v, str) or v not in kinds for v in values):
                raise ValueError("invalid MCP schema type")
            strings(values)
        for key in (
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "minContains",
            "maxContains",
            "minProperties",
            "maxProperties",
        ):
            if key in node:
                v = node[key]
                if (
                    type(v) not in (int, float)
                    or v < 0
                    or (type(v) is float and not math.isfinite(v))
                    or int(v) != v
                ):
                    raise ValueError("invalid MCP schema integer bound")
        for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"):
            if key in node and (
                type(node[key]) not in (int, float)
                or (type(node[key]) is float and not math.isfinite(node[key]))
                or (key == "multipleOf" and node[key] <= 0)
            ):
                raise ValueError("invalid MCP schema numeric bound")
        for key in ("uniqueItems", "readOnly", "writeOnly", "deprecated"):
            if key in node and type(node[key]) is not bool:
                raise ValueError("invalid MCP schema boolean keyword")
        for key in (
            "$id",
            "$schema",
            "$ref",
            "$dynamicRef",
            "$recursiveRef",
            "$comment",
            "title",
            "description",
            "format",
            "contentEncoding",
            "contentMediaType",
        ):
            if key in node and not isinstance(node[key], str):
                raise ValueError("invalid MCP schema string keyword")
        for key in ("$anchor", "$dynamicAnchor", "$recursiveAnchor"):
            if key in node and (
                not isinstance(node[key], str)
                or not re.fullmatch(r"[A-Za-z_][-A-Za-z0-9._]*", node[key])
            ):
                raise ValueError("invalid MCP schema anchor")
        if "$id" in node and not re.fullmatch(r"[^#]*#?", node["$id"]):
            raise ValueError("invalid MCP schema identifier")
        if "$vocabulary" in node and (
            not isinstance(node["$vocabulary"], dict)
            or any(type(v) is not bool for v in node["$vocabulary"].values())
        ):
            raise ValueError("invalid MCP schema vocabulary")
        for key in ("enum", "examples"):
            if key in node and not isinstance(node[key], list):
                raise ValueError("invalid MCP schema value array")
        if "pattern" in node:
            regex(node["pattern"])
        for key in ("properties", "patternProperties", "$defs", "definitions", "dependentSchemas"):
            if key in node:
                if not isinstance(node[key], dict):
                    raise ValueError("invalid MCP schema mapping")
                for name, child in node[key].items():
                    if key == "patternProperties":
                        regex(name)
                    check(child, depth + 1)
        if "required" in node:
            strings(node["required"])
        for key in ("dependentRequired", "dependencies"):
            if key in node:
                if not isinstance(node[key], dict):
                    raise ValueError("invalid MCP schema dependencies")
                for child in node[key].values():
                    if key == "dependencies" and not isinstance(child, list):
                        check(child, depth + 1)
                    else:
                        strings(child)
        for key in (
            "items",
            "additionalProperties",
            "unevaluatedProperties",
            "unevaluatedItems",
            "contentSchema",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
        ):
            if key in node:
                check(node[key], depth + 1)
        for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            if key in node:
                if not isinstance(node[key], list) or not node[key]:
                    raise ValueError("invalid MCP schema alternatives")
                for child in node[key]:
                    check(child, depth + 1)

    check(schema)


def mcp_tool_list(
    server, probe=mcp_rpc, *, max_pages=20, max_tools=2000, timeout=5, max_bytes=4 * 1024 * 1024
):
    """完整分页后才发布清单；重复游标、重复工具或超限都不发布半份结果。"""
    if probe is mcp_rpc:
        session = mcp_http_session if server.get("url") else mcp_stdio_session
        with session(server, timeout=timeout, max_bytes=max_bytes) as call:
            return mcp_tool_list(
                server,
                lambda _, method, params=None: call(method, params),
                max_pages=max_pages,
                max_tools=max_tools,
                timeout=timeout,
                max_bytes=max_bytes,
            )
    budget = MCPBudget(timeout, max_bytes)
    tools, cursors, names = [], set(), set()
    result = probe(server, "tools/list")
    for page in range(max_pages):
        budget.consume(json.dumps(result, allow_nan=False).encode())
        if not isinstance(result, dict) or not isinstance(result.get("tools"), list):
            raise ValueError("invalid MCP tool listing")
        for tool in result["tools"]:
            if (
                not isinstance(tool, dict)
                or not isinstance(tool.get("name"), str)
                or not tool["name"]
                or tool["name"] in names
            ):
                raise ValueError("invalid or duplicate MCP tool")
            mcp_structure(tool)
            mcp_schema(tool.get("inputSchema"))
            if "outputSchema" in tool:
                mcp_schema(tool["outputSchema"])
            names.add(tool["name"])
            tools.append(tool)
        if len(tools) > max_tools:
            raise ValueError("MCP tool listing exceeds bound")
        cursor = result.get("nextCursor")
        if cursor is None:
            return {"tools": tools}
        if (
            not isinstance(cursor, str)
            or not cursor
            or len(cursor) > 4096
            or cursor in cursors
            or page + 1 == max_pages
        ):
            raise ValueError("incomplete MCP tool listing")
        cursors.add(cursor)
        result = probe(server, "tools/list", {"cursor": cursor})
    raise ValueError("incomplete MCP tool listing")


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


def declared_mcp_bindings(directory):
    """只读取已登记功能包；已声明的通用绑定仍需单独确认远端元数据。"""
    directory = Path(directory)
    config = read(directory / "config.json", {})
    directories = list(config.get("extension_dirs", []))
    directories += [
        str(path.parent)
        for path in sorted((directory / "extensions").glob("*/package.json"))
        if str(path.parent) not in directories
    ]
    packages = Packages(
        directories, include_builtin=not config.get("managed_packs", False), strict=False
    )
    records = {row["id"]: row for row in packages.package_records if row["state"] == "registered"}
    rows = []
    for capability, bindings in packages.bindings.items():
        schema = packages.schemas.get(capability, CAPABILITIES.get(capability))
        for binding in bindings:
            if (
                binding["type"] != "mcp"
                or Path(binding.get("_root", "")) == directory / "extensions/discovered"
            ):
                continue
            clean = {key: value for key, value in binding.items() if not key.startswith("_")}
            record = records[binding["_package"]]
            rows.append(
                {
                    "capability": capability,
                    "binding": clean,
                    "schema": schema,
                    "package_file": str(Path(binding["_root"]) / "package.json"),
                    "declaration": {
                        "package": binding["_package"],
                        "release": record["release"],
                        "declaration_digest": record["declaration_digest"],
                        "binding_digest": digest(clean),
                        "schema_digest": digest(schema),
                    },
                }
            )
    return rows


def declared_mcp_matches(entry, item, tool):
    binding, schema = entry["binding"], entry["schema"]
    if (binding["config_path"], binding["server"], binding["tool_name"]) != (
        item["config"],
        item["name"],
        tool["name"],
    ):
        return False
    return (
        tool.get("inputSchema") == schema["input"]
        and ("outputSchema" not in tool or tool["outputSchema"] == schema["output"])
        and set(binding.get("input_fields", [])) == set(schema["input"].get("properties", {}))
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
    sources = []
    mcp_tools = []
    captured_at = time.time()
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
    declarations = declared_mcp_bindings(ctx.copilot)
    for entry in declarations:
        files[entry["package_file"]] = file_digest(entry["package_file"])
    for item in mcp_servers(ctx):
        files[item["config"]] = file_digest(item["config"])
        source = {
            "source_id": digest([item["config"], item["name"]]),
            "kind": "mcp",
            "coverage": "failed",
            "captured_at": captured_at,
            "notification_scope": "request_session_only",
            "fresh_until": captured_at + 86400,
            "config_digest": file_digest(item["config"]),
        }
        sources.append(source)
        try:
            result = mcp_tool_list(item["server"], mcp_probe)
            source.update(
                coverage="complete",
                metadata_digest=digest(result),
                revision=digest(result),
                tool_count=len(result["tools"]),
            )
            files["mcp:" + item["config"] + ":" + item["name"]] = digest(result)
            for tool in result["tools"]:
                schema = tool.get("inputSchema", {})
                mcp_tools.append(
                    {
                        **copy.deepcopy(tool),
                        "source_id": source["source_id"],
                        "name": tool["name"],
                        "contract_digest": digest(schema),
                        "metadata_digest": source["metadata_digest"],
                        "output_contract_digest": digest(tool["outputSchema"])
                        if "outputSchema" in tool
                        else None,
                        "captured_at": captured_at,
                    }
                )
                declared = [
                    entry
                    for entry in declarations
                    if (
                        entry["binding"]["config_path"],
                        entry["binding"]["server"],
                        entry["binding"]["tool_name"],
                    )
                    == (item["config"], item["name"], tool["name"])
                ]
                for entry in declared:
                    if not declared_mcp_matches(entry, item, tool):
                        errors.append({"source": "mcp", "code": "declared_contract_mismatch"})
                        continue
                    row = candidate(
                        {
                            "source": "mcp",
                            "source_id": source["source_id"],
                            "captured_at": captured_at,
                            "contract_digest": digest(schema),
                            "metadata_digest": source["metadata_digest"],
                            "source_ref": item["config"],
                            "capability": entry["capability"],
                            "binding": entry["binding"],
                            "declaration": entry["declaration"],
                            "cost": entry["binding"].get("cost", "unknown"),
                            "confidence": 1.0,
                            "validation": "available",
                            "basis": "installed declaration and exact tools/list contract",
                        }
                    )
                    row["selected"] = False
                    found.append(row)
                if declared:
                    continue
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
                            "source_id": source["source_id"],
                            "captured_at": captured_at,
                            "contract_digest": digest(schema),
                            "metadata_digest": source["metadata_digest"],
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
        except (ValueError, OSError, TimeoutError, TypeError):
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
        "captured_at": captured_at,
        "sources": sources,
        "mcp_tools": mcp_tools,
        "coverage": "partial" if errors else "registered_sources_only",
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
    declarations = declared_mcp_bindings(ctx.copilot)
    for identity in dict.fromkeys(ids):
        row = selected[identity]
        if row.get("declaration"):
            if (edits or {}).get(identity) or not any(
                entry["capability"] == row["capability"]
                and entry["binding"] == row["binding"]
                and entry["declaration"] == row["declaration"]
                for entry in declarations
            ):
                raise ValueError("installed MCP declaration changed; discover and confirm again")
            # 中文注释：确认既有实现的元数据，不把同一绑定再次安装到 discovered 包。
            continue
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
    complete_sources = {
        source["source_id"]
        for source in draft.get("sources", [])
        if source.get("coverage") == "complete"
    }
    private_write(
        ctx.copilot / "discovery-confirmed.json",
        json.dumps(
            {
                "version": 1,
                "captured_at": time.time(),
                "sources": list(
                    {
                        source["source_id"]: source
                        for source in [
                            *previous.get("sources", []),
                            *[
                                source
                                for source in draft.get("sources", [])
                                if source.get("coverage") == "complete"
                            ],
                        ]
                    }.values()
                ),
                "mcp_tools": list(
                    {
                        (tool["source_id"], tool["name"]): tool
                        for tool in [
                            *[
                                tool
                                for tool in previous.get("mcp_tools", [])
                                if tool["source_id"] not in complete_sources
                            ],
                            *draft.get("mcp_tools", []),
                        ]
                    }.values()
                ),
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


def invalidate_mcp_source(directory, item, *, metadata_digest=None):
    """只落失效凭据，不把变更检查当作用户重新确认，也不发布半份目录。"""
    path = Path(directory) / "discovery-draft.json"
    draft = read(path, {})
    source_id = digest([item["config"], item["name"]])
    source = {
        "source_id": source_id,
        "kind": "mcp",
        "coverage": "invalidated",
        "captured_at": time.time(),
        "notification_scope": "request_session_only",
        "metadata_digest": metadata_digest,
    }
    draft["sources"] = [r for r in draft.get("sources", []) if r.get("source_id") != source_id] + [
        source
    ]
    draft["mcp_tools"] = [r for r in draft.get("mcp_tools", []) if r.get("source_id") != source_id]
    draft["candidates"] = [
        r for r in draft.get("candidates", []) if r.get("source_id") != source_id
    ]
    private_write(path, json.dumps(draft, ensure_ascii=False, indent=2))


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
                current = digest(mcp_tool_list(item["server"], mcp_probe))
                if current != files[key]:
                    changed.append(key)
                    invalidate_mcp_source(ctx.copilot, item, metadata_digest=current)
            except (OSError, RuntimeError, TimeoutError, ValueError, TypeError):
                changed.append("schema_unavailable:" + item["name"])
                invalidate_mcp_source(ctx.copilot, item)
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
    from copilot_recommendations import HEALTH_TTL, metadata_current

    directory = binding.get("_mcp_directory")
    if not directory or not metadata_current(directory, binding, time.time(), ttl=HEALTH_TTL):
        raise ValueError("MCP metadata confirmation expired; discover and confirm again")

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
    confirmed = read(Path(directory) / "discovery-confirmed.json", {})
    source_id = digest([binding["config_path"], binding["server"]])
    expected = next(
        (
            tool
            for tool in confirmed.get("mcp_tools", [])
            if tool.get("source_id") == source_id and tool.get("name") == binding["tool_name"]
        ),
        {},
    )
    mcp_schema(expected.get("inputSchema"))
    session = mcp_http_session if server.get("url") else mcp_stdio_session
    dispatched = False
    try:
        with session(server) as call:
            current = mcp_tool_list(server, lambda _, method, params=None: call(method, params))
            if digest(current) != expected.get("metadata_digest"):
                raise ValueError("MCP tool directory changed; discover and confirm again")
            tool = next(
                (tool for tool in current["tools"] if tool["name"] == binding["tool_name"]), {}
            )
            if any(tool.get(key) != expected.get(key) for key in ("inputSchema", "outputSchema")):
                raise ValueError("MCP tool contract changed or missing; confirm again")
            if not metadata_current(directory, binding, time.time(), ttl=HEALTH_TTL):
                raise ValueError("MCP metadata changed before execution")
            # 中文注释：同会话全目录预检后只派发一次；未知结果绝不重放 tools/call。
            dispatched = True
            result = call(
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
        return mcp_output(result, binding)
    except Exception:
        try:
            invalidate_mcp_source(
                directory, {"config": binding["config_path"], "name": binding["server"]}
            )
        finally:
            if dispatched:
                from copilot_capabilities import Stopped

                # 中文注释：派发后任何普通异常（含解析/清理失败）都不能转供应商重放。
                raise Stopped("MCP tool outcome unknown; read back before any retry") from None
        raise


def mcp_output(result, binding):
    if not isinstance(result, dict):
        raise ValueError("invalid MCP tool result")
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
    if binding.get("_schema"):
        from copilot_contracts import validate

        validate(value, binding["_schema"])
    return value
