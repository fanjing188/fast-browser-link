"""当前页成品包：真实 helper/CDP 回执合同与实际 ZIP，不启动浏览器。"""

import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
import subprocess
import socket
import sys
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "export_child", ROOT / "native-bridge/script_lane/child.py"
)
assert spec is not None and spec.loader is not None
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)


@contextmanager
def workspace():
    with tempfile.TemporaryDirectory() as directory:
        previous = Path.cwd()
        os.chdir(directory)
        try:
            yield Path(directory)
        finally:
            os.chdir(previous)


class ExportTests(unittest.TestCase):
    def test_script_history_supports_repeated_export_and_keeps_paginated_ambiguity(self):
        self.resources = [
            {"url": "https://example.test/a.js", "type": "Script", "mimeType": "text/javascript"}
        ]
        self.bodies[self.resources[0]["url"]] = {
            "content": "window.exactSource=true",
            "base64Encoded": False,
        }
        original = self.receipt
        context = {
            "method": "Runtime.executionContextCreated",
            "params": {"context": {"id": 1, "auxData": {"frameId": "main", "isDefault": True}}},
        }

        def script(identifier):
            return {
                "method": "Debugger.scriptParsed",
                "params": {
                    "url": self.resources[0]["url"],
                    "scriptId": identifier,
                    "length": 218,
                    "executionContextId": 1,
                    "executionContextAuxData": {"frameId": "main", "isDefault": True},
                },
            }

        for ambiguous in [False, True]:
            history = (
                [{"method": "Console.messageAdded", "params": {}}] * 499
                + [script("other"), script(self.resources[0]["url"]), context]
                if ambiguous
                else [context, script(self.resources[0]["url"])]
            )

            def receipt(op, args):
                if args[0] != "cdp.events":
                    return original(op, args)
                cursor = args[1]["cursor"]
                end = min(cursor + args[1]["max"], len(history))
                return {"events": history[cursor:end], "cursor": end, "hasMore": end < len(history)}

            with (
                self.subTest(ambiguous=ambiguous),
                workspace() as root,
                patch.object(child, "_call", side_effect=receipt),
            ):
                for index in range(2):
                    child.export_page(f"repeat-{index}.zip")
                    with zipfile.ZipFile(root / f"repeat-{index}.zip") as archive:
                        manifest = json.loads(archive.read("manifest.json"))
                        self.assertEqual(
                            manifest["resources"][0]["status"],
                            "unreadable" if ambiguous else "exported",
                        )

    def test_script_identity_refuses_ambiguity_gaps_and_foreign_context(self):
        import copy

        self.resources = [
            {"url": "https://example.test/a.js", "type": "Script", "mimeType": "text/javascript"}
        ]
        self.bodies[self.resources[0]["url"]] = {
            "content": "window.exactSource=true",
            "base64Encoded": False,
        }
        original = self.receipt
        for mode in [
            "unique",
            "duplicate",
            "source_url",
            "gap",
            "foreign_context",
            "child_session",
            "destroyed",
            "cleared",
        ]:
            self.debugger_enabled = False
            self.calls.clear()

            def receipt(op, args):
                result = original(op, args)
                if args[0] != "cdp.events" or not self.debugger_enabled:
                    return result
                rows = result["events"]
                assert isinstance(rows, list)
                script = rows[-1]["params"]
                if mode == "duplicate":
                    duplicate = copy.deepcopy(rows[-1])
                    duplicate["params"]["scriptId"] = "other"
                    rows.append(duplicate)
                if mode == "source_url":
                    script["hasSourceURL"] = True
                if mode == "gap":
                    result["dropped"] = 1
                if mode == "foreign_context":
                    script["executionContextId"] = 99
                if mode == "child_session":
                    rows[-1]["childSession"] = True
                if mode == "destroyed":
                    rows.append(
                        {
                            "method": "Runtime.executionContextDestroyed",
                            "params": {"executionContextId": 1},
                        }
                    )
                if mode == "cleared":
                    rows.append({"method": "Runtime.executionContextsCleared", "params": {}})
                return result

            with (
                self.subTest(mode=mode),
                workspace() as root,
                patch.object(child, "_call", side_effect=receipt),
            ):
                child.export_page("script.zip")
                with zipfile.ZipFile(root / "script.zip") as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    self.assertEqual(
                        manifest["resources"][0]["status"],
                        "exported" if mode == "unique" else "unreadable",
                    )
                sources = [
                    p
                    for action, p, _ in self.calls
                    if action == "cdp.send" and p["method"] == "Debugger.getScriptSource"
                ]
                self.assertEqual(len(sources), int(mode == "unique"))

    def test_mhtml_transport_truncation_is_an_error_not_missing_cache(self):
        original = self.receipt

        def truncated(op, args):
            if args[0] == "cdp.send" and args[1]["method"] == "Page.captureSnapshot":
                return {"executed": True, "resultTooLarge": True, "size": 600000}
            return original(op, args)

        with workspace() as root, patch.object(child, "_call", side_effect=truncated):
            with self.assertRaises(child.BrowserError) as caught:
                child.export_page("too-large.zip")
            self.assertEqual(caught.exception.code, "export_budget")
            self.assertFalse((root / "too-large.zip").exists())

    def test_css_import_is_disabled_instead_of_dangling_after_budget_clip(self):
        self.resources = [
            {"url": "https://example.test/A.css", "type": "Stylesheet", "mimeType": "text/css"},
            {"url": "https://example.test/B.css", "type": "Stylesheet", "mimeType": "text/css"},
        ]
        self.bodies = {
            self.resources[0]["url"]: {
                "content": '@import "B.css";h1{color:red}',
                "base64Encoded": False,
            },
            self.resources[1]["url"]: {
                "content": "h1{color:blue}/*" + "x" * 2000 + "*/",
                "base64Encoded": False,
            },
        }
        with workspace() as root, patch.object(child, "_call", side_effect=self.receipt):
            receipt = child.export_page("styles.zip", max_bytes=8192)
            with zipfile.ZipFile(root / "styles.zip") as archive:
                self.assertNotIn(b"@import", archive.read("preview/0000.css"))
            self.assertGreater(receipt["coverage"]["cssUnresolved"], 0)

    def test_css_preview_drops_unsupported_external_image_set(self):
        export_spec = importlib.util.spec_from_file_location(
            "css_export", ROOT / "native-bridge/script_lane/page_export.py"
        )
        assert export_spec is not None and export_spec.loader is not None
        module = importlib.util.module_from_spec(export_spec)
        export_spec.loader.exec_module(module)
        result, missing = module._css_preview(
            b'body{background-image:image-set("/probe.png" 1x)}',
            "https://example.test/theme.css",
            {},
        )
        self.assertEqual(result, b"")
        self.assertEqual(missing, 1)

    def test_css_preview_refuses_unknown_resource_functions_and_keeps_safe_styles(self):
        spec = importlib.util.spec_from_file_location(
            "css_export", ROOT / "native-bridge/script_lane/page_export.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for value in [
            b'body{background:future-image("/probe.png")}',
            b'body{background:src("/probe.png")}',
            b'body{content:"</style>"}',
        ]:
            with self.subTest(value=value):
                self.assertEqual(
                    module._css_preview(value, "https://example.test/theme.css", {}), (b"", 1)
                )
        self.assertEqual(
            module._css_preview(
                b"h1{color:rgb(1,2,3);width:calc(100% - 2px)}", "https://example.test/theme.css", {}
            ),
            (b"h1{color:rgb(1,2,3);width:calc(100% - 2px)}", 0),
        )

    def test_no_refetch_resource_backend_and_svg_mime(self):
        self.resources = [
            {"url": "https://example.test/icon.svg", "type": "Image", "mimeType": "image/svg+xml"}
        ]
        self.bodies[self.resources[0]["url"]] = {"content": "<svg/>", "base64Encoded": False}
        with workspace() as root, patch.object(child, "_call", side_effect=self.receipt):
            child.export_page("svg.zip")
            with zipfile.ZipFile(root / "svg.zip") as archive:
                manifest = json.loads(archive.read("manifest.json"))
                self.assertTrue(manifest["resources"][0]["path"].endswith(".svg"))
        methods = [p["method"] for action, p, _ in self.calls if action == "cdp.send"]
        self.assertNotIn("Page.getResourceContent", methods)

    def test_total_deadline_bounds_blocked_send_and_lock(self):
        with workspace():
            left, right = socket.socketpair()
            left.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            code = """import time
token = _export_deadline.set(time.monotonic() + 0.05)
try:
    _call('run', ['cdp.send', {'method':'Page.getFrameTree','params':{'padding':'x'*16000}}])
except BrowserError as error:
    print(error.code, error.outcome_unknown)
finally:
    _export_deadline.reset(token)
"""
            bootstrap = (
                "import runpy; n=runpy.run_path("
                + repr(str(ROOT / "native-bridge/script_lane/child.py"))
                + "); exec("
                + repr(code)
                + ",n)"
            )
            try:
                process = subprocess.run(
                    [sys.executable, "-I", "-c", bootstrap],
                    capture_output=True,
                    text=True,
                    pass_fds=[left.fileno()],
                    env={**os.environ, "FAST_BROWSER_FD": str(left.fileno())},
                    timeout=2,
                )
            finally:
                left.close()
                right.close()
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stdout.strip(), "export_timeout True")

    def test_manifest_budget_includes_archive_overhead(self):
        self.resources = []
        with workspace() as root, patch.object(child, "_call", side_effect=self.receipt):
            child.export_page("measure.zip")
            with zipfile.ZipFile(root / "measure.zip") as archive:
                raw_bytes = sum(entry.file_size for entry in archive.infolist())
            with self.assertRaises(child.BrowserError):
                child.export_page("small.zip", max_bytes=raw_bytes)
            self.assertFalse((root / "small.zip").exists())

    def test_cached_body_exception_is_classified_without_swallowing_authority_errors(self):
        original = self.receipt
        self.resources = [
            {"url": "https://example.test/a.js", "type": "Script", "mimeType": "text/javascript"}
        ]
        for code in (
            "extension_error",
            "credential_mode_conflict",
            "execution_lane_denied",
            "browser_access_revoked",
        ):

            def fail_body(op, args):
                if args[0] == "cdp.send" and args[1]["method"] == "Debugger.getScriptSource":
                    raise child.BrowserError("fixed error", code=code, outcome_unknown=False)
                return original(op, args)

            with (
                self.subTest(code=code),
                workspace() as root,
                patch.object(child, "_call", side_effect=fail_body),
            ):
                if code == "extension_error":
                    child.export_page("cache.zip")
                    with zipfile.ZipFile(root / "cache.zip") as archive:
                        manifest = json.loads(archive.read("manifest.json"))
                        self.assertEqual(manifest["resources"][0]["status"], "unreadable")
                else:
                    with self.assertRaises(child.BrowserError):
                        child.export_page("cache.zip")
                    self.assertFalse((root / "cache.zip").exists())

    def test_resource_tree_transport_handle_fails_closed_with_controlled_error(self):
        with (
            workspace() as root,
            patch.object(child, "_call", return_value={"executed": True, "resultTooLarge": True}),
        ):
            with self.assertRaises(child.BrowserError) as caught:
                child.export_page("chunk.zip")
            self.assertEqual(caught.exception.code, "export_unavailable")
            self.assertFalse((root / "chunk.zip").exists())

    def test_real_isolated_child_transport_loads_module_closure(self):
        with workspace() as root:
            parent, peer = socket.socketpair()
            errors = []

            def serve():
                try:
                    with parent, parent.makefile("rwb") as stream:
                        while line := stream.readline():
                            request = json.loads(line)
                            self.assertEqual(request["tab"], 7)
                            value = self.receipt(request["op"], request["args"])
                            stream.write(
                                (
                                    json.dumps({"id": request["id"], "ok": True, "value": value})
                                    + "\n"
                                ).encode()
                            )
                            stream.flush()
                except BaseException as exc:
                    errors.append(exc)

            worker = threading.Thread(target=serve)
            worker.start()
            try:
                process = subprocess.run(
                    [sys.executable, "-I", str(ROOT / "native-bridge/script_lane/child.py")],
                    input="print(__import__('json').dumps(export_page('isolated.zip', tab=7)))",
                    text=True,
                    capture_output=True,
                    pass_fds=[peer.fileno()],
                    env={**os.environ, "FAST_BROWSER_FD": str(peer.fileno())},
                    timeout=10,
                )
            finally:
                peer.close()
                worker.join(timeout=5)
            self.assertEqual(errors, [])
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout)
            self.assertEqual(result["path"], str(root / "isolated.zip"))
            with zipfile.ZipFile(result["path"]) as archive:
                self.assertIsNone(archive.testzip())

    def test_total_deadline_stops_pending_transport_without_replay(self):
        with workspace():
            parent, peer = socket.socketpair()
            requests = []

            def serve():
                with parent, parent.makefile("rb") as stream:
                    if line := stream.readline():
                        requests.append(json.loads(line))
                    stream.read()

            worker = threading.Thread(target=serve)
            worker.start()
            code = """import time
token = _export_deadline.set(time.monotonic() + 0.05)
try:
    _call('run', ['cdp.send', {'method':'Page.getFrameTree','params':{'padding':'x'*16000}}])
except BrowserError as error:
    print(error.code, error.outcome_unknown)
finally:
    _export_deadline.reset(token)
"""
            # 中文注释：真实隔离子进程执行模块，直接检验唯一 JSONL 通道的剩余总期限。
            bootstrap = (
                "import runpy; n=runpy.run_path("
                + repr(str(ROOT / "native-bridge/script_lane/child.py"))
                + "); exec("
                + repr(code)
                + ",n)"
            )
            try:
                process = subprocess.run(
                    [sys.executable, "-I", "-c", bootstrap],
                    text=True,
                    capture_output=True,
                    pass_fds=[peer.fileno()],
                    env={**os.environ, "FAST_BROWSER_FD": str(peer.fileno())},
                    timeout=3,
                )
            finally:
                peer.close()
                worker.join(timeout=5)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stdout.strip(), "export_timeout True")
            self.assertEqual(len(requests), 1)

    def test_real_dom_serializer_and_cached_css_are_wired_into_offline_package(self):
        self.resources = [
            {"url": "https://example.test/a.css", "type": "Stylesheet", "mimeType": "text/css"},
            {"url": "https://example.test/a.js", "type": "Script", "mimeType": "text/javascript"},
            {"url": "https://example.test/a.png", "type": "Image", "mimeType": "image/png"},
        ]
        self.bodies.update(
            {
                "https://example.test/a.css": {
                    "content": 'h1 {color: red; background:url("a.png"); mask:url("missing.png")}',
                    "base64Encoded": False,
                },
                "https://example.test/a.js": {
                    "content": "window.neverExecute = 'private frontend source';",
                    "base64Encoded": False,
                },
            }
        )
        original = self.receipt

        def real_dom(op, args):
            if args[0] != "js.evaluate":
                return original(op, args)
            params = args[1]
            script = """const {JSDOM}=require('jsdom');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const p=JSON.parse(raw);const d=new JSDOM('<html><head><link rel=stylesheet href=a.css><script src=a.js></script><script>window.state="inline private state"</script></head><body><h1>server</h1><input value=default><img src=a.png></body></html>',{url:'https://example.test/page',runScripts:'outside-only'});d.window.document.querySelector('h1').textContent='rendered';d.window.document.querySelector('input').value='runtime-sentinel';console.log(JSON.stringify({value:d.window.eval('('+p.expression+')')(p.arguments)}));});"""
            process = subprocess.run(
                [os.environ.get("NODE", "node"), "-e", script],
                input=json.dumps(params),
                text=True,
                capture_output=True,
                cwd=ROOT,
                check=True,
            )
            return json.loads(process.stdout)

        with workspace() as root, patch.object(child, "_call", side_effect=real_dom):
            result = child.export_page("real-dom.zip")
            with zipfile.ZipFile(root / "real-dom.zip") as archive:
                html = archive.read("index.html").decode()
                self.assertIn("rendered", html)
                self.assertNotIn("runtime-sentinel", html)
                self.assertNotIn("<script", html)
                self.assertIn("preview/0000.css", html)
                self.assertIn("assets/0002.png", html)
                self.assertIn("script-src 'none'", html)
                self.assertIn(
                    'url("../assets/0002.png")', archive.read("preview/0000.css").decode()
                )
                self.assertIn('url("")', archive.read("preview/0000.css").decode())
                self.assertEqual(
                    archive.read("assets/0001.js").decode(),
                    self.bodies["https://example.test/a.js"]["content"],
                )
                self.assertIn(b"inline private state", archive.read("source/inline-0000.js"))
                manifest = json.loads(archive.read("manifest.json"))
                self.assertTrue(manifest["coverage"]["cssUnresolved"])
                self.assertIn("may contain sensitive", manifest["privacyWarning"])
                self.assertEqual(set(result), {"path", "sha256", "count", "coverage"})

    def test_resource_limits_skip_source_maps_data_documents_and_large_items(self):
        self.resources = [
            {
                "url": "https://example.test/a.js.map",
                "type": "Other",
                "mimeType": "application/json",
            },
            {"url": "https://example.test/api", "type": "Fetch", "mimeType": "application/json"},
            {"url": "https://example.test/document", "type": "Document", "mimeType": "text/html"},
            {
                "url": "https://example.test/huge.png",
                "type": "Image",
                "contentSize": 9 * 1024 * 1024,
            },
            {
                "url": "https://example.test/a.png",
                "type": "Image",
                "mimeType": "image/png",
                "contentSize": 3,
            },
            {
                "url": "https://example.test/limit.png",
                "type": "Image",
                "mimeType": "image/png",
                "contentSize": 3,
            },
        ]
        with workspace() as root, patch.object(child, "_call", side_effect=self.receipt):
            result = child.export_page("limited.zip", max_resources=5)
            self.assertTrue(result["coverage"]["partial"])
            with zipfile.ZipFile(root / "limited.zip") as archive:
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(
                    [r["status"] for r in manifest["resources"]],
                    ["skipped", "skipped", "skipped", "over_budget", "exported", "over_budget"],
                )
            self.assertFalse(
                any(
                    p["method"] == "Page.getResourceContent"
                    for action, p, _ in self.calls
                    if action == "cdp.send"
                )
            )

    def test_actual_byte_budget_and_invalid_resource_receipts_are_partial(self):
        self.resources = [
            {"url": "https://example.test/a.js", "type": "Script", "mimeType": "text/javascript"}
        ]
        for receipt, status in [
            ({"content": "x" * 10000, "base64Encoded": False}, "over_budget"),
            ({"content": "not base64!", "base64Encoded": True}, "unreadable"),
            ({"executed": True, "resultTooLarge": True}, "unreadable"),
        ]:
            with (
                self.subTest(status=status),
                workspace() as root,
                patch.object(child, "_call", side_effect=self.receipt),
            ):
                self.bodies[self.resources[0]["url"]] = receipt
                child.export_page("limited.zip", max_bytes=8192)
                with zipfile.ZipFile(root / "limited.zip") as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    self.assertEqual(manifest["resources"][0]["status"], status)
                    self.assertLessEqual(sum(i.file_size for i in archive.infolist()), 8192)

    def test_document_replacement_and_unknown_reads_abort_without_archive(self):
        original = self.receipt

        def replaced(op, args):
            result = original(op, args)
            if args[0] == "cdp.send" and args[1]["method"] == "Page.getFrameTree":
                result["frameTree"]["frame"]["loaderId"] = "changed"
            return result

        with workspace() as root, patch.object(child, "_call", side_effect=replaced):
            with self.assertRaises(child.BrowserError):
                child.export_page("changed.zip")
            self.assertFalse((root / "changed.zip").exists())
        self.bodies[self.resources[0]["url"]] = child.BrowserError(
            "unknown", code="extension_disconnected"
        )

        def unknown(op, args):
            if args[0] == "cdp.send" and args[1]["method"] == "Page.captureSnapshot":
                raise self.bodies[self.resources[0]["url"]]
            return original(op, args)

        with workspace() as root, patch.object(child, "_call", side_effect=unknown):
            with self.assertRaises(child.BrowserError):
                child.export_page("unknown.zip")
            self.assertFalse((root / "unknown.zip").exists())

    def test_unsafe_paths_and_budgets_fail_before_any_browser_read(self):
        with workspace() as root, patch.object(child, "_call") as call:
            (root / "exists.zip").write_bytes(b"keep")
            (root / "link").symlink_to(root, target_is_directory=True)
            for path in (
                "../escape.zip",
                "a/../escape.zip",
                "exists.zip",
                "link/a.zip",
                "wrong.html",
                "/var/denied.zip",
            ):
                with self.subTest(path=path), self.assertRaises(child.BrowserError):
                    child.export_page(path)
            for values in (
                {"max_bytes": True},
                {"max_bytes": 0},
                {"max_bytes": 2**40},
                {"max_resources": 0},
                {"max_resources": 10001},
            ):
                with self.subTest(values=values), self.assertRaises(child.BrowserError):
                    child.export_page("valid.zip", **values)
            call.assert_not_called()
            self.assertEqual((root / "exists.zip").read_bytes(), b"keep")

    def test_failure_removes_reserved_archive_and_never_replays(self):
        with (
            workspace() as root,
            patch.object(
                child,
                "_call",
                side_effect=child.BrowserError(
                    "denied", code="credential_mode_conflict", outcome_unknown=False
                ),
            ) as call,
        ):
            with self.assertRaises(child.BrowserError) as caught:
                child.export_page("no.zip")
            self.assertEqual(caught.exception.code, "credential_mode_conflict")
            self.assertEqual(call.call_count, 1)
            self.assertFalse((root / "no.zip").exists())

    def receipt(self, op, args):
        self.assertEqual(op, "run")
        action, params = args
        self.calls.append((action, params, child._tab_scope.get()))
        if action == "js.evaluate":
            return {
                "value": {
                    "html": "<!DOCTYPE html><html><head></head><body>rendered</body></html>",
                    "styles": [],
                    "coverage": {"topLevelOnly": True},
                }
            }
        if action == "cdp.events":
            return {
                "events": (
                    [
                        {
                            "method": "Runtime.executionContextCreated",
                            "params": {
                                "context": {
                                    "id": 1,
                                    "auxData": {"frameId": "main", "isDefault": True},
                                }
                            },
                        }
                    ]
                    + [
                        {
                            "method": "Debugger.scriptParsed",
                            "params": {
                                "url": row["url"],
                                "scriptId": row["url"],
                                "length": 218,
                                "executionContextId": 1,
                                "executionContextAuxData": {"frameId": "main", "isDefault": True},
                            },
                        }
                        for row in self.resources
                        if row.get("type") == "Script"
                    ]
                )
                if getattr(self, "debugger_enabled", False)
                else [],
                "hasMore": False,
                "cursor": 0,
            }
        self.assertEqual(action, "cdp.send")
        method = params["method"]
        if method == "Runtime.enable":
            return {}
        if method == "Debugger.enable":
            self.debugger_enabled = True
            return {}
        if method == "Debugger.getScriptSource":
            receipt = self.bodies.get(params["params"]["scriptId"], {})
            return (
                {"scriptSource": receipt.get("content")}
                if receipt.get("base64Encoded") is False
                else receipt
            )
        if method == "Page.captureSnapshot":
            from email.message import EmailMessage

            message = EmailMessage()
            message.make_mixed()
            for row in self.resources:
                body = self.bodies.get(row["url"])
                if not isinstance(body, dict) or not isinstance(body.get("content"), str):
                    continue
                try:
                    data = (
                        base64.b64decode(body["content"], validate=True)
                        if body.get("base64Encoded")
                        else body["content"].encode()
                    )
                except ValueError:
                    continue
                part = EmailMessage()
                part.set_content(data, maintype="application", subtype="octet-stream")
                part["Content-Location"] = row["url"]
                message.attach(part)
            return {"data": message.as_string()}

        if method == "Page.getFrameTree":
            return {
                "frameTree": {
                    "frame": {"id": "main", "loaderId": "doc", "url": "https://example.test/page"}
                }
            }
        if method == "Page.getResourceTree":
            return {
                "frameTree": {
                    "frame": {"id": "main", "loaderId": "doc", "url": "https://example.test/page"},
                    "resources": self.resources,
                    "childFrames": [],
                }
            }
        self.fail("unexpected CDP method " + method)

    def setUp(self):
        self.calls = []
        self.debugger_enabled = False
        self.resources = [
            {
                "url": "https://example.test/a.png",
                "type": "Image",
                "mimeType": "image/png",
                "contentSize": 3,
            }
        ]
        self.bodies = {
            "https://example.test/a.png": {
                "content": base64.b64encode(b"PNG").decode(),
                "base64Encoded": True,
            }
        }

    def test_helper_exports_private_crc_valid_hash_listed_archive_via_existing_actions(self):
        self.assertIn("export_page", child.HELPERS)
        with workspace() as root, patch.object(child, "_call", side_effect=self.receipt):
            result = child.HELPERS["export_page"]("page.zip", tab=7)
            target = root / "page.zip"
            self.assertEqual(result["path"], str(target))
            self.assertEqual(result["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("example.test", json.dumps(result))
            with zipfile.ZipFile(target) as archive:
                self.assertIsNone(archive.testzip())
                manifest = json.loads(archive.read("manifest.json"))
                self.assertIn(b"rendered", archive.read("index.html"))
                for entry in manifest["members"]:
                    data = archive.read(entry["path"])
                    self.assertEqual(entry["bytes"], len(data))
                    self.assertEqual(entry["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(
                    set(archive.namelist()),
                    {"manifest.json", *[entry["path"] for entry in manifest["members"]]},
                )
                self.assertEqual(manifest["resources"][0]["url"], self.resources[0]["url"])
            self.assertTrue(all(tab == 7 for _, _, tab in self.calls))
            self.assertEqual(
                {p["method"] for action, p, _ in self.calls if action == "cdp.send"},
                {"Page.getFrameTree", "Page.getResourceTree", "Page.captureSnapshot"},
            )


if __name__ == "__main__":
    unittest.main()
