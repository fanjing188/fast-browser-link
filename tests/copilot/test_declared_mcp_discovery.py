"""已安装通用MCP的显式映射、来源隔离、合同及版本回归；不调用供应商。"""

import copy
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import textwrap
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot_capabilities import Registry, Stopped
from copilot_contracts import private_write, validate
from copilot_packages import Packages
from copilot_recommendations import metadata_current, inventory
from fbl_discovery import (
    scan,
    confirm,
    changes,
    digest,
    file_digest,
    mcp_tool_list,
    mcp_call,
    mcp_rpc,
)
from fbl_runtime import Context


MALFORMED_SCHEMA_KEYWORDS = [
    {"minLength": "oops"},
    {"pattern": "["},
    {"enum": 12},
    {"maxItems": -1},
    {"minProperties": True},
    {"maxContains": 1.5},
    {"minimum": "0"},
    {"exclusiveMaximum": False},
    {"multipleOf": 0},
    {"uniqueItems": "yes"},
    {"readOnly": 1},
    {"examples": {}},
    {"dependentRequired": {"x": "y"}},
    {"dependentRequired": {"x": ["y", "y"]}},
    {"patternProperties": {"[": {}}},
    {"unevaluatedItems": []},
    {"contentSchema": 1},
    {"type": ["string", "string"]},
    {"$ref": 12},
    {"$dynamicRef": []},
    {"$anchor": "not an anchor"},
    {"$id": "https://example.test/schema#fragment"},
    {"$vocabulary": {"urn:test": 1}},
    {"description": 1},
    {"format": []},
    {"dependencies": {"x": ["y", "y"]}},
]


class DeclaredMCPDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fbl-declared-mcp-")
        self.root = Path(self.tmp.name).resolve()
        user = self.root / "user"
        user.mkdir()
        self.ctx = Context(user, user / ".hermes", user / ".fast-browser-link")
        self.now = 2000000000
        self.config = user / ".claude.json"
        private_write(self.config, json.dumps({"mcpServers": {"cases": {"command": "NEVER_RUN"}}}))
        self.schema = {
            "input": {
                "type": "object",
                "properties": {"case_id": {"type": "string"}},
                "required": ["case_id"],
                "additionalProperties": False,
            },
            "output": {
                "type": "object",
                "properties": {
                    "records": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"case_id": {"type": "string"}},
                            "required": ["case_id"],
                            "additionalProperties": False,
                        },
                    },
                    "source": {"type": "string"},
                },
                "required": ["records", "source"],
                "additionalProperties": False,
            },
        }
        self.binding = {
            "id": "case-reader",
            "type": "mcp",
            "config_path": str(self.config),
            "server": "cases",
            "tool_name": "inspect_case",
            "input_fields": ["case_id"],
            "cost": "zero",
        }
        self.package = self.root / "case-pack"
        self.package.mkdir()
        self.manifest = {
            "id": "custom-cases",
            "version": 1,
            "release": "1.0.0",
            "schemas": {"case.inspect": self.schema},
            "capabilities": {"case.inspect": [self.binding]},
        }
        self.save_package()
        private_write(
            self.ctx.copilot / "config.json",
            json.dumps({"extension_dirs": [str(self.package)], "managed_packs": True}),
        )
        self.tool = {
            "name": "inspect_case",
            "inputSchema": copy.deepcopy(self.schema["input"]),
            "outputSchema": copy.deepcopy(self.schema["output"]),
        }
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def save_package(self):
        private_write(self.package / "package.json", json.dumps(self.manifest))

    def discover(self, tools=None):
        tools = copy.deepcopy([self.tool] if tools is None else tools)

        def probe(server, method, params=None):
            self.calls.append(method)
            self.assertEqual(method, "tools/list")
            return {"tools": tools}

        with patch("fbl_discovery.time.time", return_value=self.now):
            return scan(self.ctx, mcp_probe=probe)

    def acknowledge(self, identity):
        with patch("fbl_discovery.time.time", return_value=self.now):
            return confirm(self.ctx, [identity])

    def test_declared_custom_tool_requires_explicit_confirmation_and_is_not_duplicated(self):
        draft = self.discover()
        self.assertEqual(len(draft["candidates"]), 1)
        row = draft["candidates"][0]
        self.assertEqual(row["capability"], "case.inspect")
        self.assertFalse(row["selected"])
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))
        self.acknowledge(row["id"])
        self.assertTrue(metadata_current(self.ctx.copilot, self.binding, self.now))
        discovered = json.loads(
            (self.ctx.copilot / "extensions/discovered/package.json").read_text()
        )
        self.assertFalse(discovered["capabilities"])
        packages = Packages(
            [self.package, self.ctx.copilot / "extensions/discovered"], include_builtin=False
        )
        registry = Registry(
            packages, self.ctx.copilot, private_write, validate, clock=lambda: self.now
        )
        self.assertEqual(len(packages.bindings["case.inspect"]), 1)
        self.assertEqual(registry.structural(packages.bindings["case.inspect"][0]), "available")
        self.assertEqual(self.calls, ["tools/list"])

    def test_unknown_generic_tool_is_inventory_only_and_optional_remote_output_is_supported(self):
        known = copy.deepcopy(self.tool)
        known.pop("outputSchema")
        unknown = {**copy.deepcopy(known), "name": "unregistered_case_tool"}
        draft = self.discover([known, unknown])
        self.assertEqual(len(draft["mcp_tools"]), 2)
        self.assertEqual(len(draft["candidates"]), 1)
        self.acknowledge(draft["candidates"][0]["id"])
        self.assertTrue(metadata_current(self.ctx.copilot, self.binding, self.now))
        self.assertFalse(
            metadata_current(
                self.ctx.copilot, {**self.binding, "tool_name": unknown["name"]}, self.now
            )
        )

    def test_input_or_declared_remote_output_contract_mismatch_is_not_mapped(self):
        for field in ("inputSchema", "outputSchema"):
            tool = copy.deepcopy(self.tool)
            tool[field]["additionalProperties"] = True
            with self.subTest(field=field):
                draft = self.discover([tool])
                self.assertFalse(draft["candidates"])
                self.assertIn("declared_contract_mismatch", [r["code"] for r in draft["errors"]])

    def test_package_version_or_contract_change_requires_new_discovery_and_confirmation(self):
        first = self.discover()["candidates"][0]
        self.acknowledge(first["id"])
        self.manifest["release"] = "1.0.1"
        self.save_package()
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))
        with self.assertRaisesRegex(ValueError, "source changed"):
            self.acknowledge(first["id"])
        new = self.discover()["candidates"][0]
        self.acknowledge(new["id"])
        self.assertTrue(metadata_current(self.ctx.copilot, self.binding, self.now))
        self.schema["output"]["properties"]["source"]["maxLength"] = 200
        self.save_package()
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))

    def test_same_server_and_tool_cannot_borrow_another_configuration_confirmation(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        other = self.root / "other-config.json"
        private_write(other, self.config.read_text())
        source_id = digest([str(other), self.binding["server"]])
        path = self.ctx.copilot / "discovery-confirmed.json"
        snapshot = json.loads(path.read_text())
        snapshot["sources"].append(
            {
                "source_id": source_id,
                "kind": "mcp",
                "coverage": "complete",
                "captured_at": self.now,
                "config_digest": file_digest(other),
            }
        )
        snapshot["mcp_tools"].append({**snapshot["mcp_tools"][0], "source_id": source_id})
        private_write(path, json.dumps(snapshot))
        self.assertFalse(
            metadata_current(
                self.ctx.copilot, {**self.binding, "config_path": str(other)}, self.now
            )
        )
        self.assertTrue(metadata_current(self.ctx.copilot, self.binding, self.now))
        snapshot["candidates"][0].pop("source_id")
        private_write(path, json.dumps(snapshot))
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))

    def test_confirmed_metadata_preserves_health_expiry_and_disabled_scope(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now + 601, ttl=600))
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now + 86401))
        self.assertFalse(
            metadata_current(self.ctx.copilot, {**self.binding, "server": "other"}, self.now)
        )
        self.assertFalse(
            metadata_current(self.ctx.copilot, {**self.binding, "input_fields": []}, self.now)
        )

    def test_failed_refresh_invalidates_previously_confirmed_catalog(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        with patch("fbl_discovery.time.time", return_value=self.now + 1):
            draft = scan(
                self.ctx, mcp_probe=lambda *_: (_ for _ in ()).throw(ValueError("offline"))
            )
        self.assertFalse(draft["mcp_tools"])
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now + 1))
        with patch("fbl_discovery.time.time", return_value=self.now + 2):
            confirm(self.ctx, [])
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now + 2))

    def test_deep_change_check_invalidates_failed_or_changed_source(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        for result in (None, {"tools": []}):
            with self.subTest(result=result):

                def probe(*_):
                    if result is None:
                        raise ValueError("offline")
                    return result

                with patch("fbl_discovery.time.time", return_value=self.now + 1):
                    self.assertTrue(changes(self.ctx, deep=True, mcp_probe=probe))
                self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now + 1))

    def test_catalog_keeps_full_contracts_and_explicit_poll_only_revision(self):
        self.tool["description"] = "Remote metadata, not a business result"
        draft = self.discover()
        tool, source = draft["mcp_tools"][0], draft["sources"][0]
        self.assertEqual(tool["inputSchema"], self.tool["inputSchema"])
        self.assertEqual(tool["outputSchema"], self.tool["outputSchema"])
        self.assertEqual(tool["description"], self.tool["description"])
        self.assertEqual(source["revision"], source["metadata_digest"])
        self.assertEqual(source["notification_scope"], "request_session_only")
        self.assertEqual(source["fresh_until"], self.now + 86400)

    def test_mcp_call_requires_current_confirmation_and_retained_schema(self):
        with self.assertRaisesRegex(ValueError, "metadata|confirmation"):
            mcp_call(self.binding, {"case_id": "A"})

    def test_missing_retained_schema_is_not_ready_even_with_matching_fingerprints(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        path = self.ctx.copilot / "discovery-confirmed.json"
        value = json.loads(path.read_text())
        value["mcp_tools"][0].pop("inputSchema")
        private_write(path, json.dumps(value))
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))

    def test_unselected_contract_change_is_not_reconfirmed_by_other_candidates(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        # 中文注释：未映射工具的元数据改变也生成新目录修订；空确认不授权旧候选。
        self.tool["description"] = "new revision"
        self.discover()
        with patch("fbl_discovery.time.time", return_value=self.now):
            confirm(self.ctx, [])
        self.assertFalse(metadata_current(self.ctx.copilot, self.binding, self.now))

    def test_inventory_exposes_catalog_invalidation_not_fresh_bound_tool(self):
        row = self.discover()["candidates"][0]
        self.acknowledge(row["id"])
        packages = Packages([self.package], include_builtin=False)
        registry = Registry(
            packages, self.ctx.copilot, private_write, validate, clock=lambda: self.now
        )
        app = SimpleNamespace(
            directory=self.ctx.copilot,
            packages=packages,
            registry=registry,
            _tool_context=lambda _: {},
            _state=lambda _: {},
        )
        first = inventory(app, "fixture", clock=lambda: self.now)
        with patch("fbl_discovery.time.time", return_value=self.now + 1):
            scan(self.ctx, mcp_probe=lambda *_: (_ for _ in ()).throw(ValueError("offline")))
        latest = inventory(app, "fixture", clock=lambda: self.now + 1)
        self.assertEqual(latest["mcp_tools"][0]["metadata_state"], "invalidated")
        self.assertEqual(latest["mcp_tools"][0]["state"], "needs_refresh")
        self.assertNotEqual(first["revision"], latest["revision"])
        self.assertEqual(latest["sources"][0]["metadata_state"], "invalidated")
        self.assertNotIn("NEVER_RUN", json.dumps(latest))
        self.assertNotIn(str(self.config), json.dumps(latest))


class MCPSessionPagination(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fbl-mcp-session-")
        self.root = Path(self.tmp.name)
        self.record = self.root / "requests.jsonl"
        self.script = self.root / "server.py"
        self.script.write_text(
            textwrap.dedent("""\
            import json, sys
            from pathlib import Path
            initialized = False
            for line in sys.stdin:
                request = json.loads(line)
                with Path(sys.argv[1]).open("a") as record:
                    record.write(json.dumps(request) + "\\n")
                method = request["method"]
                if method == "notifications/initialized":
                    initialized = True
                    continue
                if method == "initialize":
                    result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": True}}}
                elif method == "tools/list":
                    if not initialized:
                        raise RuntimeError("not initialized")
                    cursor = request.get("params", {}).get("cursor")
                    if cursor and not first_page:
                        raise RuntimeError("cursor belongs to a different session")
                    first_page = True
                    result = {"tools": [{"name": "two" if cursor else "one", "description": "retained", "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"}}]}
                    if not cursor:
                        result["nextCursor"] = "session-only"
                else:
                    raise RuntimeError("business tools forbidden")
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
                if method == "initialize":
                    first_page = False
        """)
        )
        self.server = {"command": sys.executable, "args": [str(self.script), str(self.record)]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_stdio_cursor_pages_share_one_initialized_process(self):
        result = mcp_tool_list(self.server)
        self.assertEqual([tool["name"] for tool in result["tools"]], ["one", "two"])
        self.assertEqual(result["tools"][1]["description"], "retained")
        self.assertEqual(result["tools"][1]["outputSchema"], {"type": "object"})
        methods = [json.loads(line)["method"] for line in self.record.read_text().splitlines()]
        self.assertEqual(
            methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"]
        )

    @contextmanager
    def http_fixture(
        self,
        listing=None,
        *,
        changed=False,
        delay=0,
        call_result=None,
        stream=False,
        fault=None,
        sse_chunks=None,
    ):
        from http.client import HTTPResponse
        import socket

        requests, sessions = [], {}
        progress, consumed = {}, threading.Condition()
        original_read = HTTPResponse.read1

        def read_chunk(response, *args):
            chunk = original_read(response, *args)
            token = response.getheader("X-Fixture-Stream")
            if token is not None:
                with consumed:
                    if token in progress:
                        progress[token] += len(chunk)
                        consumed.notify_all()
            return chunk

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                # 中文注释：小块 SSE 由夹具显式分块，不让 Nagle/延迟 ACK 额外消耗共享截止。
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(request)
                if delay:
                    threading.Event().wait(delay)
                method = request["method"]
                session = self.headers.get("Mcp-Session-Id")
                if method == "initialize":
                    session = "session-" + str(len(sessions))
                    sessions[session] = {"initialized": False, "first": False}
                    result = {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {"listChanged": True}},
                    }
                elif session not in sessions:
                    self.send_error(400)
                    return
                elif method == "notifications/initialized":
                    sessions[session]["initialized"] = True
                    self.send_response(202)
                    self.end_headers()
                    return
                elif method == "tools/list":
                    cursor = request.get("params", {}).get("cursor")
                    if not sessions[session]["initialized"] or (
                        cursor and not sessions[session]["first"]
                    ):
                        self.send_error(400, "session scoped cursor")
                        return
                    sessions[session]["first"] = True
                    result = (
                        listing(request, requests)
                        if listing
                        else {
                            "tools": [
                                {
                                    "name": "two" if cursor else "one",
                                    "inputSchema": {"type": "object"},
                                }
                            ],
                            **({} if cursor else {"nextCursor": "session-only"}),
                        }
                    )
                elif method == "tools/call" and call_result is not None:
                    if call_result == "disconnect":
                        self.close_connection = True
                        return
                    result = call_result
                else:
                    self.send_error(400, "business tools forbidden")
                    return
                data = json.dumps(
                    {"jsonrpc": "2.0", "id": request["id"], "result": result}
                ).encode()
                if method == "initialize" and fault:
                    kind = fault.get("kind")
                    if kind == "redirect":
                        self.send_response(307)
                        self.send_header("Location", "/other")
                        self.end_headers()
                        return
                    if kind == "status":
                        self.connection.sendall(b"not-an-http-status\r\n\r\n")
                        self.close_connection = True
                        return
                    if kind == "slow_headers":
                        try:
                            self.connection.sendall(b"HTTP/1.1 200 OK\r\n")
                            for _ in range(10):
                                threading.Event().wait(0.03)
                                self.connection.sendall(b"X-Drip: value\r\n")
                            self.connection.sendall(b"Content-Length: 0\r\n\r\n")
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                        self.close_connection = True
                        return
                    if kind == "deep":
                        data = b'{"id":1,"result":' + b"[" * 1100 + b"0" + b"]" * 1100 + b"}"
                    elif kind == "nonobject":
                        data = b'{"id":1,"result":[]}'
                if changed and method == "tools/list":
                    data = (
                        b"event: message\ndata: "
                        + data
                        + b'\n\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/tools/list_changed"}\n\n'
                    )
                elif stream:
                    data = b"event: message\r\ndata: " + data + b"\r\n\r\n"
                self.send_response(200)
                self.send_header("Mcp-Session-Id", session)
                self.send_header(
                    "Content-Type",
                    "text/event-stream"
                    if stream or (changed and method == "tools/list")
                    else "application/json",
                )
                if not stream:
                    self.send_header("Content-Length", str(len(data)))
                if sse_chunks:
                    with consumed:
                        token = f"{self.server.server_port}:{len(progress)}"
                        progress[token] = 0
                    self.send_header("X-Fixture-Stream", token)
                self.end_headers()
                try:
                    chunks = list(sse_chunks(data)) if sse_chunks else [data]
                    sent = 0
                    for index, chunk in enumerate(chunks):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        sent += len(chunk)
                        if sse_chunks and index < len(chunks) - 1:
                            # 中文注释：按真实 read1 消费推进分块，避免微小定时等待的调度抖动。
                            with consumed:
                                if not consumed.wait_for(
                                    lambda: progress[token] >= sent, timeout=1
                                ):
                                    return
                    if stream:
                        threading.Event().wait(0.4)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(HTTPResponse, "read1", read_chunk):
                yield {"url": "http://127.0.0.1:" + str(server.server_port) + "/mcp"}, requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_http_cursor_pages_share_one_initialized_session(self):
        with self.http_fixture() as (server, requests):
            result = mcp_tool_list(server)
        self.assertEqual([tool["name"] for tool in result["tools"]], ["one", "two"])
        self.assertEqual(
            [r["method"] for r in requests],
            ["initialize", "notifications/initialized", "tools/list", "tools/list"],
        )

    def test_untrusted_initialize_failure_invalidates_source_and_scan_continues(self):
        original_root = self.root
        tool = {
            "name": "keyword_metrics",
            "inputSchema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
        }
        for kind in ("deep", "status", "nonobject"):
            with self.subTest(kind=kind):
                self.root = original_root / kind
                self.root.mkdir()
                fault = {}
                with self.http_fixture(lambda *_: {"tools": [tool]}, fault=fault) as (server, _):
                    ctx, binding = self.confirmed_binding(server)
                    with self.http_fixture() as (healthy, _):
                        private_write(
                            ctx.user / ".claude/settings.json",
                            json.dumps({"mcpServers": {"healthy": healthy}}),
                        )
                        fault["kind"] = kind
                        draft = scan(ctx)
                    self.assertEqual([s["coverage"] for s in draft["sources"]].count("failed"), 1)
                    self.assertEqual([s["coverage"] for s in draft["sources"]].count("complete"), 1)
                    self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))
                    self.assertEqual(len(draft["mcp_tools"]), 2)
                    with self.assertRaises(ValueError):
                        mcp_tool_list(server)
        self.root = original_root

    def test_deep_tool_extension_invalidates_old_catalog_and_continues_other_sources(self):
        tool = {
            "name": "keyword_metrics",
            "inputSchema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
        }
        with self.http_fixture(lambda *_: {"tools": [tool]}) as (server, _):
            ctx, binding = self.confirmed_binding(server)
            nested = 0
            for _ in range(600):
                nested = [nested]
            tool["_meta"] = {"deep": nested}
            with self.http_fixture() as (healthy, requests):
                private_write(
                    ctx.user / ".claude/settings.json",
                    json.dumps({"mcpServers": {"healthy": healthy}}),
                )
                draft = scan(ctx)
            self.assertTrue(requests)
            self.assertEqual([s["coverage"] for s in draft["sources"]].count("failed"), 1)
            self.assertEqual([s["coverage"] for s in draft["sources"]].count("complete"), 1)
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))
            self.assertEqual(len(draft["mcp_tools"]), 2)
            with self.assertRaises(ValueError):
                mcp_tool_list(server)

    def test_stdio_initialize_nonobject_or_deep_json_is_a_value_error(self):
        original = self.script.read_text()
        for raw in ("[]", "null", "1", "[" * 1100 + "0" + "]" * 1100):
            with self.subTest(raw=raw[:30]):
                self.script.write_text(
                    original.replace(
                        'result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": True}}}',
                        'print(\'{"id":1,"result":\' + '
                        + repr(raw)
                        + ' + "}", flush=True)\n        continue',
                    )
                )
                with self.assertRaises(ValueError):
                    mcp_tool_list(self.server)

    def test_http_rejects_bad_cursor_duplicate_names_partial_failure_and_bounds(self):
        tool = {"name": "one", "inputSchema": {"type": "object"}}
        cases = [
            ({"tools": [], "nextCursor": 7}, {}),
            ({"tools": [], "nextCursor": ""}, {}),
            ({"tools": [], "nextCursor": "session-only"}, {}),
            ({"tools": [tool]}, {}),
            ({"unexpected": "partial failure"}, {}),
            ({"tools": []}, {"max_pages": 1}),
            ({"tools": [{**tool, "name": "two"}]}, {"max_tools": 1}),
        ]
        for second, bounds in cases:
            with self.subTest(second=second, bounds=bounds):

                def listing(request, _):
                    return (
                        second
                        if request.get("params", {}).get("cursor")
                        else {"tools": [tool], "nextCursor": "session-only"}
                    )

                with self.http_fixture(listing) as (server, requests):
                    with self.assertRaises(ValueError):
                        mcp_tool_list(server, **bounds)
                    self.assertNotIn("tools/call", [r["method"] for r in requests])

    def test_malformed_schema_rejects_entire_remote_catalog(self):
        for schema in (
            None,
            [],
            {},
            {"type": "string"},
            {"type": "object", "properties": []},
            {"type": "object", "properties": {"x": {"type": "typo"}}},
            {"type": "object", "required": "x"},
        ):
            with self.subTest(schema=schema):

                def listing(*_):
                    return {
                        "tools": [
                            {
                                "name": "invalid",
                                **({"inputSchema": schema} if schema is not None else {}),
                            }
                        ]
                    }

                with self.http_fixture(listing) as (server, _):
                    with self.assertRaisesRegex(ValueError, "schema"):
                        mcp_tool_list(server)

    def test_schema_keyword_types_and_regex_reject_entire_catalog(self):
        for invalid in MALFORMED_SCHEMA_KEYWORDS:
            for field in ("inputSchema", "outputSchema"):
                with self.subTest(invalid=invalid, field=field):
                    tool = {
                        "name": "invalid",
                        "inputSchema": {"type": "object"},
                        field: {"type": "object", "properties": {"x": invalid}},
                    }
                    with self.assertRaisesRegex(ValueError, "schema"):
                        mcp_tool_list(
                            {},
                            lambda *_: {
                                "tools": [
                                    {"name": "valid", "inputSchema": {"type": "object"}},
                                    tool,
                                ]
                            },
                        )

    def test_schema_annotations_and_enum_structure_are_bounded(self):
        deep = 0
        for _ in range(70):
            deep = [deep]
        for value in (deep, list(range(11000))):
            with self.subTest(value="deep" if value is deep else "wide"):
                with self.assertRaisesRegex(ValueError, "schema"):
                    mcp_tool_list(
                        {},
                        lambda *_: {
                            "tools": [
                                {
                                    "name": "invalid",
                                    "inputSchema": {"type": "object", "default": value},
                                }
                            ]
                        },
                    )

    def test_valid_rich_schema_preserves_references_extensions_and_large_integer_bounds(self):
        schema = {
            "type": "object",
            "$defs": {"optional": {"type": ["string", "null"]}},
            "properties": {
                "ref": {"$ref": "https://example.invalid/never-fetch.json"},
                "size": {"type": "integer", "minimum": -(10**400), "maximum": 10**400},
                "text": {"type": "string", "pattern": "^[a-z]+$", "minLength": 1.0},
                "list": {"type": "array", "prefixItems": [True], "unevaluatedItems": False},
                "choice": {"enum": [None, {"a": [1, True]}, "text"]},
            },
            "dependentRequired": {"ref": ["text"]},
            "additionalProperties": False,
            "x-extension": {"preserve": [1, 2]},
        }
        listing = {"tools": [{"name": "rich", "inputSchema": schema}]}
        with patch("urllib.request.urlopen", side_effect=AssertionError("must not resolve refs")):
            self.assertEqual(mcp_tool_list({}, lambda *_: listing), listing)

    def test_tool_extension_budgets_cover_width_and_bytes_without_dropping_valid_metadata(self):
        tool = {"name": "metadata", "inputSchema": {"type": "object"}}
        for extension in (list(range(31000)), {"head": "x" * 1048576, "tail": ""}):
            with self.subTest(kind=type(extension).__name__):
                with self.assertRaisesRegex(ValueError, "metadata"):
                    mcp_tool_list({}, lambda *_: {"tools": [{**tool, "_meta": extension}]})
        valid = {"tools": [{**tool, "_meta": {"custom": [1, {"safe": True}]}}]}
        self.assertEqual(mcp_tool_list({}, lambda *_: valid), valid)

    def test_total_deadline_covers_handshake_and_all_pages(self):
        self.script.write_text(
            self.script.read_text().replace(
                "request = json.loads(line)",
                "import time; time.sleep(0.06)\n    request = json.loads(line)",
            )
        )
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            mcp_tool_list(self.server, timeout=0.14)
        self.assertLess(time.monotonic() - started, 0.8)

    def test_total_wire_byte_budget_includes_metadata_envelopes(self):
        with self.assertRaisesRegex(ValueError, "bound|limit"):
            mcp_tool_list(self.server, max_bytes=250)

    def test_stdio_blocked_request_write_respects_total_deadline(self):
        self.script.write_text(
            self.script.read_text().replace(
                "initialized = True", "import time; time.sleep(1)\n        sys.exit(0)"
            )
        )
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            mcp_rpc(
                self.server,
                "tools/call",
                {"arguments": {"keyword": "x" * 1024 * 1024}},
                timeout=0.14,
            )
        self.assertLess(time.monotonic() - started, 0.8)

    def test_list_changed_in_same_stdio_chunk_rejects_snapshot(self):
        self.script.write_text(
            self.script.read_text().replace(
                'print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)',
                'print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}) + ("\\n" + json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}) if method == "tools/list" else ""), flush=True)',
            )
        )
        with self.assertRaisesRegex(ValueError, "changed"):
            mcp_tool_list(self.server)

    def test_http_sse_list_changed_invalidates_response_even_after_matching_id(self):
        with self.http_fixture(changed=True) as (server, _):
            with self.assertRaisesRegex(ValueError, "changed"):
                mcp_tool_list(server)

    def test_http_total_deadline_and_wire_budget(self):
        with self.http_fixture(delay=0.06) as (server, _):
            with self.assertRaises(TimeoutError):
                mcp_tool_list(server, timeout=0.14)
        with self.http_fixture() as (server, _):
            with self.assertRaisesRegex(ValueError, "bound|limit"):
                mcp_tool_list(server, max_bytes=200)

    def test_response_header_drip_obeys_shared_deadline_without_late_dispatch(self):
        with self.http_fixture(fault={"kind": "slow_headers"}) as (server, requests):
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                mcp_rpc(server, "tools/call", {"name": "never_dispatch"}, timeout=0.09)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.22, f"headers exceeded deadline: {elapsed:.3f}s")
            threading.Event().wait(0.35)
            self.assertEqual([r["method"] for r in requests], ["initialize"])

    def test_deadline_transport_does_not_follow_redirects(self):
        with self.http_fixture(fault={"kind": "redirect"}) as (server, requests):
            with self.assertRaisesRegex(ValueError, "redirect"):
                mcp_tool_list(server)
            self.assertEqual([r["method"] for r in requests], ["initialize"])

    def test_deadline_transport_keeps_default_tls_certificate_and_hostname_checks(self):
        import ssl
        import urllib.request
        from fbl_discovery import MCPBudget, mcp_http_opener

        opener = mcp_http_opener(MCPBudget(1, 1024))
        handler = next(h for h in opener.handlers if isinstance(h, urllib.request.HTTPSHandler))
        with patch.object(handler, "do_open") as do_open:
            handler.https_open(urllib.request.Request("https://localhost/"))
        factory = do_open.call_args.args[0]
        connection = factory("localhost", **do_open.call_args.kwargs)
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        connection.close()

    def test_partial_request_sends_cannot_renew_the_shared_deadline(self):
        import urllib.request
        from fbl_discovery import MCPBudget, mcp_http_opener

        class PartialSocket:
            def settimeout(self, _):
                pass

            def send(self, _):
                threading.Event().wait(0.03)
                return 1

            def sendall(self, data):
                # 中文注释：模拟 SSL sendall 内多次短写，不能只设置一次相对 timeout。
                for byte in data:
                    self.send(bytes([byte]))

            def close(self):
                pass

        opener = mcp_http_opener(MCPBudget(0.09, 1024))
        handler = next(h for h in opener.handlers if isinstance(h, urllib.request.HTTPHandler))
        with patch.object(handler, "do_open") as do_open:
            handler.http_open(urllib.request.Request("http://localhost/"))
        connection = do_open.call_args.args[0]("localhost")
        connection.sock = PartialSocket()
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                connection.send(b"1234567890")
            self.assertLess(time.monotonic() - started, 0.22)
        finally:
            connection.close()

    def test_dns_returning_after_deadline_cannot_send_a_late_request(self):
        import socket

        resolve = socket.getaddrinfo

        def slow_dns(*args, **kwargs):
            threading.Event().wait(0.12)
            return resolve(*args, **kwargs)

        with self.http_fixture() as (server, requests):
            with patch("socket.getaddrinfo", side_effect=slow_dns):
                with self.assertRaises(OSError):
                    mcp_rpc(server, "tools/call", {"name": "never_dispatch"}, timeout=0.05)
            threading.Event().wait(0.1)
            self.assertFalse(requests)

    def confirmed_binding(self, server):
        # 中文注释：完整发现与确认后再测试真实传输执行，不伪造 ready 状态。
        user = self.root / "user"
        user.mkdir()
        ctx = Context(user, user / ".hermes", user / ".fast-browser-link")
        private_write(user / ".claude.json", json.dumps({"mcpServers": {"fixture": server}}))
        draft = scan(ctx)
        self.assertEqual(len(draft["candidates"]), 1)
        confirm(ctx, [draft["candidates"][0]["id"]])
        binding = draft["candidates"][0]["binding"]
        self.assertTrue(metadata_current(ctx.copilot, binding, time.time()))
        return ctx, binding

    def test_http_sse_response_is_consumed_without_waiting_for_connection_close(self):
        with self.http_fixture(stream=True) as (server, requests):
            result = mcp_tool_list(server, timeout=0.25)
            self.assertEqual([tool["name"] for tool in result["tools"]], ["one", "two"])
            self.assertEqual([r["method"] for r in requests].count("initialize"), 1)

    def test_http_fixture_disables_nagle_on_accepted_socket(self):
        import socket
        from urllib.parse import urlsplit

        observed = []
        original = socket.socket.setsockopt

        def record(connection, level, option, value, *args):
            if (level, option, value) == (socket.IPPROTO_TCP, socket.TCP_NODELAY, 1):
                observed.append(connection.getsockname()[1])
            return original(connection, level, option, value, *args)

        with patch.object(socket.socket, "setsockopt", record):
            with self.http_fixture() as (server, _):
                result = mcp_tool_list(server)
                self.assertEqual(len(result["tools"]), 2)
                self.assertIn(urlsplit(server["url"]).port, observed)

    def test_sse_fixture_keeps_distinct_reads_without_timed_chunk_delays(self):
        from http.client import HTTPResponse

        sleeps, reads = [], []
        original_wait, original_read = threading.Event.wait, HTTPResponse.read1

        def wait(event, delay=None):
            sleeps.append(delay)
            return original_wait(event, delay)

        def read(response, *args):
            chunk = original_read(response, *args)
            reads.append(chunk)
            return chunk

        chunks = lambda data: [b": heartbeat\r\n\r\n", b"id: eve", b"nt-1\r\n" + data]
        with patch.object(threading.Event, "wait", wait), patch.object(HTTPResponse, "read1", read):
            with self.http_fixture(stream=True, sse_chunks=chunks) as (server, _):
                result = mcp_tool_list(server, timeout=0.35)
                self.assertEqual([tool["name"] for tool in result["tools"]], ["one", "two"])
        self.assertNotIn(0.01, sleeps)
        self.assertEqual(reads.count(b"id: eve"), 3)

    def test_sse_id_first_and_split_id_after_heartbeat_keep_stream_mode(self):
        for chunks in (
            lambda data: [b"id: event-1\r\nretry: 5\r\n" + data],
            lambda data: [b": heartbeat\r\n\r\n", b"id: eve", b"nt-1\r\nretry: 5\r\n" + data],
        ):
            with self.subTest(chunks=chunks):
                with self.http_fixture(stream=True, sse_chunks=chunks) as (server, requests):
                    result = mcp_tool_list(server, timeout=0.35)
                    self.assertEqual([t["name"] for t in result["tools"]], ["one", "two"])
                    self.assertEqual([r["method"] for r in requests].count("initialize"), 1)

    def test_sse_line_endings_accept_bare_cr_and_split_crlf_without_false_empty_lines(self):
        def split_crlf(data):
            stream = data.replace(b"data: {", b"data: {\r\ndata: ")
            return [
                part for line in stream.splitlines(keepends=True) for part in (line[:-1], line[-1:])
            ]

        for chunks in (lambda data: [data.replace(b"\r\n", b"\r")], split_crlf):
            with self.subTest(chunks=chunks):
                with self.http_fixture(stream=True, sse_chunks=chunks) as (server, requests):
                    result = mcp_tool_list(server, timeout=1)
                    self.assertEqual([t["name"] for t in result["tools"]], ["one", "two"])
                    self.assertEqual([r["method"] for r in requests].count("initialize"), 1)

    def test_sse_id_first_matching_result_cannot_hide_same_chunk_list_changed(self):
        for ending in (b"\n", b"\r"):
            with self.subTest(ending=ending):
                with self.http_fixture(
                    changed=True,
                    stream=True,
                    sse_chunks=lambda data: [
                        b"id: event-1"
                        + ending
                        + data.replace(b"\r\n", b"\n").replace(b"\n", ending)
                    ],
                ) as (server, _):
                    with self.assertRaisesRegex(ValueError, "changed"):
                        mcp_tool_list(server)

    def test_execution_rechecks_all_pages_then_calls_once_in_same_session(self):
        def listing(request, _):
            return (
                {"tools": []}
                if request.get("params", {}).get("cursor")
                else {
                    "tools": [
                        {
                            "name": "keyword_metrics",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"keyword": {"type": "string"}},
                            },
                        }
                    ],
                    "nextCursor": "session-only",
                }
            )

        with self.http_fixture(listing, call_result={"structuredContent": {"records": []}}) as (
            server,
            requests,
        ):
            _, binding = self.confirmed_binding(server)
            requests.clear()
            value = mcp_call(binding, {"keyword": "A"})
            self.assertEqual(value["records"], [])
            self.assertEqual(
                [r["method"] for r in requests],
                [
                    "initialize",
                    "notifications/initialized",
                    "tools/list",
                    "tools/list",
                    "tools/call",
                ],
            )

    def test_changed_or_incomplete_execution_preflight_never_calls_business_tool(self):
        state = {"changed": False}

        def listing(request, _):
            if state["changed"]:
                return {"tools": []}
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(listing, call_result={"structuredContent": {"records": []}}) as (
            server,
            requests,
        ):
            ctx, binding = self.confirmed_binding(server)
            requests.clear()
            state["changed"] = True
            with self.assertRaisesRegex(ValueError, "contract|changed|missing"):
                mcp_call(binding, {"keyword": "A"})
            self.assertNotIn("tools/call", [r["method"] for r in requests])
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_unknown_execution_result_is_never_retried(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(listing, call_result="disconnect") as (server, requests):
            ctx, binding = self.confirmed_binding(server)
            requests.clear()
            with self.assertRaisesRegex(Stopped, "outcome unknown"):
                mcp_call(binding, {"keyword": "A"})
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_expired_execution_confirmation_does_not_open_transport(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(listing, call_result={"structuredContent": {}}) as (
            server,
            requests,
        ):
            _, binding = self.confirmed_binding(server)
            requests.clear()
            with patch("fbl_discovery.time.time", return_value=time.time() + 601):
                with self.assertRaisesRegex(ValueError, "expired"):
                    mcp_call(binding, {"keyword": "A"})
            self.assertFalse(requests)

    def test_malformed_result_after_dispatch_stops_instead_of_falling_back(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(
            listing, call_result={"content": [{"type": "text", "text": "not JSON"}]}
        ) as (server, requests):
            ctx, binding = self.confirmed_binding(server)
            requests.clear()
            with self.assertRaisesRegex(Stopped, "outcome unknown"):
                mcp_call(binding, {"keyword": "A"})
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_execution_observing_other_tool_removal_invalidates_entire_catalog(self):
        state = {"changed": False}
        tool = {
            "name": "keyword_metrics",
            "inputSchema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
        }

        def listing(*_):
            return {
                "tools": [tool]
                + (
                    []
                    if state["changed"]
                    else [{"name": "unmapped", "inputSchema": {"type": "object"}}]
                )
            }

        with self.http_fixture(listing, call_result={"structuredContent": {}}) as (
            server,
            requests,
        ):
            ctx, binding = self.confirmed_binding(server)
            requests.clear()
            state["changed"] = True
            with self.assertRaisesRegex(ValueError, "changed"):
                mcp_call(binding, {"keyword": "A"})
            self.assertNotIn("tools/call", [r["method"] for r in requests])
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_invalid_declared_output_after_dispatch_is_not_a_retryable_provider_failure(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(
            listing, call_result={"structuredContent": {"records": "invalid"}}
        ) as (server, requests):
            _, binding = self.confirmed_binding(server)
            binding["_schema"] = {
                "type": "object",
                "properties": {"records": {"type": "array"}},
                "required": ["records"],
            }
            requests.clear()
            with self.assertRaisesRegex(Stopped, "outcome unknown"):
                mcp_call(binding, {"keyword": "A"})
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)

    def test_deep_json_output_stops_registry_without_fallback_and_invalidates_source(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        result = {"content": [{"type": "text", "text": "[" * 1100 + "0" + "]" * 1100}]}
        with self.http_fixture(listing, call_result=result) as (server, requests):
            ctx, binding = self.confirmed_binding(server)
            packages = Packages([ctx.copilot / "extensions/discovered"], include_builtin=False)
            packages.bindings["keyword.metrics"].append(
                {
                    "id": "fallback",
                    "type": "command",
                    "argv": [sys.executable],
                    "priority": 200,
                    "cost": "zero",
                }
            )
            registry = Registry(packages, ctx.copilot, private_write, validate)
            requests.clear()
            with patch.object(registry, "_command", return_value={"records": []}) as fallback:
                with self.assertRaisesRegex(Stopped, "outcome unknown"):
                    registry.execute(
                        "keyword.metrics",
                        {"keyword": "A"},
                        self.root / "work",
                        threading.Event(),
                        {"secondary_confirmed": True},
                    )
                fallback.assert_not_called()
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)
            self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_dispatch_exception_boundary_preserves_process_control_exceptions(self):
        tool = {
            "name": "keyword_metrics",
            "inputSchema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
        }
        with self.http_fixture(
            lambda *_: {"tools": [tool]}, call_result={"structuredContent": {}}
        ) as (server, requests):
            ctx, binding = self.confirmed_binding(server)
            for error in (RuntimeError, LookupError, AssertionError, KeyboardInterrupt, SystemExit):
                with self.subTest(error=error):
                    draft = scan(ctx)
                    confirm(ctx, [draft["candidates"][0]["id"]])
                    requests.clear()
                    with patch("fbl_discovery.mcp_output", side_effect=error("synthetic")):
                        with self.assertRaises(Stopped if issubclass(error, Exception) else error):
                            mcp_call(binding, {"keyword": "A"})
                    self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)
                    if issubclass(error, Exception):
                        self.assertFalse(metadata_current(ctx.copilot, binding, time.time()))

    def test_invalidation_write_failure_after_dispatch_still_stops(self):
        tool = {
            "name": "keyword_metrics",
            "inputSchema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
        }
        with self.http_fixture(
            lambda *_: {"tools": [tool]},
            call_result={"content": [{"type": "text", "text": "invalid"}]},
        ) as (server, requests):
            _, binding = self.confirmed_binding(server)
            requests.clear()
            with patch("fbl_discovery.invalidate_mcp_source", side_effect=OSError("disk failed")):
                with self.assertRaises(Stopped):
                    mcp_call(binding, {"keyword": "A"})
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)

    def test_registry_does_not_fall_through_to_another_provider_after_unknown_dispatch(self):
        def listing(*_):
            return {
                "tools": [
                    {
                        "name": "keyword_metrics",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"keyword": {"type": "string"}},
                        },
                    }
                ]
            }

        with self.http_fixture(listing, call_result="disconnect") as (server, requests):
            ctx, _ = self.confirmed_binding(server)
            packages = Packages([ctx.copilot / "extensions/discovered"], include_builtin=False)
            packages.bindings["keyword.metrics"].append(
                {
                    "id": "fallback",
                    "type": "command",
                    "argv": [sys.executable],
                    "priority": 200,
                    "cost": "zero",
                }
            )
            registry = Registry(packages, ctx.copilot, private_write, validate)
            requests.clear()
            with patch.object(
                registry, "_command", side_effect=AssertionError("must not replay via fallback")
            ):
                with self.assertRaisesRegex(Stopped, "outcome unknown"):
                    registry.execute(
                        "keyword.metrics",
                        {"keyword": "A"},
                        self.root / "work",
                        threading.Event(),
                        {"secondary_confirmed": True},
                    )
            self.assertEqual([r["method"] for r in requests].count("tools/call"), 1)


if __name__ == "__main__":
    unittest.main()
