"""当前顶层页面的私有离线包；浏览器读取只使用已有受控 helper。"""

import base64
from email import policy
from email.parser import BytesParser
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urljoin, urlsplit
import zipfile


def _invalid(error):
    return error("page export path or budget denied", code="invalid_params", outcome_unknown=False)


@contextmanager
def _destination(path, error):
    # 中文注释：先固定目录 fd，逐级拒绝符号链接；浏览器读取前独占预留文件。
    if not isinstance(path, str) or not path or "\x00" in path or ".." in Path(path).parts:
        raise _invalid(error)
    target = Path.cwd().resolve() / path
    roots = [Path.cwd().resolve()]
    roots.extend(
        Path(value).expanduser().resolve()
        for value in os.environ.get("FAST_BROWSER_EXPORT_ROOTS", "").split(os.pathsep)
        if value and Path(value).expanduser().is_absolute()
    )
    root = next((root for root in roots if target != root and root in target.parents), None)
    if root is None or target.suffix.lower() != ".zip":
        raise _invalid(error)
    directory = None
    created = False
    try:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parts = target.relative_to(root).parts
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            nested = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = nested
        fd = os.open(
            parts[-1], os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory
        )
        created = True
    except (OSError, ValueError):
        if directory is not None:
            os.close(directory)
        raise _invalid(error) from None
    try:
        with os.fdopen(fd, "w+b") as output:
            yield target, output
    except BaseException:
        if created:
            os.unlink(parts[-1], dir_fd=directory)
        raise
    finally:
        os.close(directory)


MAX_RESOURCE_BYTES = 384 * 1024
TOTAL_SECONDS = 60
RESOURCE_TYPES = {
    "Stylesheet": ".css",
    "Image": ".img",
    "Font": ".font",
    "Script": ".js",
    "Media": ".media",
}


def _identity(tree):
    frame = tree["frame"]
    return frame["id"], frame["loaderId"], frame["url"]


def _css_preview(data, base, mapping):
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        return b"", 1
    if "\\" in text or "/*" in text or "<" in text or re.search(r"@import\b", text, re.I):
        return b"", 1
    unresolved = 0

    def local(value):
        nonlocal unresolved
        path = mapping.get(urljoin(base, value))
        if not path:
            unresolved += 1
        return "../" + path if path else ""

    text = re.sub(
        r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"()]*))\s*\)""",
        lambda m: 'url("' + local(next(v for v in m.groups() if v is not None)) + '")',
        text,
        flags=re.I,
    )

    # 中文注释：与HTML序列化保持同一保守合同；未知函数可能用裸字符串请求包外资源。
    safe_functions = set(
        "rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix linear-gradient radial-gradient "
        "conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient "
        "calc min max clamp var env not is where has nth-child nth-last-child nth-of-type "
        "nth-last-of-type translate translatex translatey translatez translate3d scale scalex scaley "
        "scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d "
        "perspective cubic-bezier steps".split()
    )
    syntax = re.sub(r'url\("[^"]*"\)', "", text, flags=re.I)
    if any(
        name.lower() not in safe_functions
        for name in re.findall(r"([a-z_-][a-z0-9_-]*)\s*\(", syntax, re.I)
    ):
        return b"", 1
    return text.encode("utf-8"), unresolved


def export_page(path, *, cdp, events, evaluate, error, max_bytes, max_resources):
    if type(max_bytes) is not int or not 1 <= max_bytes <= 64 * 1024 * 1024:
        raise _invalid(error)
    if type(max_resources) is not int or not 1 <= max_resources <= 1000:
        raise _invalid(error)
    with _destination(path, error) as (target, output):
        deadline = time.monotonic() + TOTAL_SECONDS

        def check_time():
            if time.monotonic() >= deadline:
                raise error(
                    "page export deadline exceeded", code="export_timeout", outcome_unknown=False
                )

        def read(method, **params):
            check_time()
            result = cdp(method, **params)
            check_time()
            return result

        def frame_tree(method):
            receipt = read(method)
            try:
                tree = receipt["frameTree"]
                if not all(isinstance(value, str) and value for value in _identity(tree)):
                    raise ValueError()
                return tree
            except (TypeError, KeyError, ValueError):
                raise error(
                    "page tree unavailable", code="export_unavailable", outcome_unknown=False
                ) from None

        tree = frame_tree("Page.getResourceTree")
        identity = _identity(tree)
        # 中文注释：getResourceContent 会让 Chromium 重新请求样式表；MHTML仅序列化内存资源，绝不调用该接口。
        snapshot = read("Page.captureSnapshot", format="mhtml")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("data"), str):
            raise error(
                "page snapshot unavailable or exceeds transport budget",
                code="export_budget",
                outcome_unknown=False,
            )
        cached = {}
        message = BytesParser(policy=policy.default).parsebytes(snapshot["data"].encode("utf-8"))
        for part in message.walk():
            if part.is_multipart() or part.get_content_type() == "text/html":
                continue
            url = str(part.get("Content-Location", ""))
            body = part.get_payload(decode=True)
            if url and isinstance(body, bytes):
                cached[url] = body
        script_ids = {}
        script_candidates = {}
        contexts = set()
        script_event_gap = False
        if any(row.get("type") == "Script" for row in tree.get("resources", [])):
            # 中文注释：保留完整有界历史和本轮新增事件；enable 已生效时不会重发上下文或脚本。
            batch = events(max=500, cursor=0)
            cursor = 0
            read("Runtime.enable")
            read("Debugger.enable")
            history_pending = True
            while True:
                check_time()
                script_event_gap |= bool(batch.get("dropped") or batch.get("lostRanges"))
                check_time()
                for event in batch.get("events", []):
                    if event.get("childSession"):
                        continue
                    params = event.get("params", {})
                    if event.get("method") == "Runtime.executionContextCreated":
                        context = params.get("context", {})
                        aux = context.get("auxData", {})
                        if aux.get("frameId") == identity[0] and aux.get("isDefault") is True:
                            contexts.add(context.get("id"))
                    if event.get("method") == "Runtime.executionContextDestroyed":
                        contexts.discard(params.get("executionContextId"))
                    if event.get("method") == "Runtime.executionContextsCleared":
                        contexts.clear()
                    if (
                        event.get("method") == "Debugger.scriptParsed"
                        and params.get("executionContextAuxData", {}).get("frameId") == identity[0]
                        and params.get("executionContextAuxData", {}).get("isDefault") is True
                    ):
                        script_candidates.setdefault(params.get("url"), []).append(params)
                next_cursor = batch.get("cursor")
                if (
                    type(next_cursor) is not int
                    or next_cursor < cursor
                    or (batch.get("hasMore") and next_cursor == cursor)
                ):
                    raise error(
                        "invalid script event cursor",
                        code="export_unavailable",
                        outcome_unknown=False,
                    )
                cursor = next_cursor
                if not batch.get("hasMore"):
                    if not history_pending:
                        break
                    history_pending = False
                batch = events(max=500, cursor=cursor)
            if not script_event_gap:
                for url, candidates in script_candidates.items():
                    # 中文注释：URL只是标签；重放后的活跃默认上下文中仍须唯一，拒绝sourceURL冒名。
                    eligible = {
                        candidate.get("scriptId"): candidate
                        for candidate in candidates
                        if candidate.get("executionContextId") in contexts
                        and not candidate.get("hasSourceURL")
                    }
                    if len(eligible) == 1:
                        script_ids[url] = next(iter(eligible.values()))
        members = {}
        resources = []
        used = 0
        # 中文注释：清单与 ZIP 元数据预留有界空间；超小预算直接失败，不产出伪完整包。
        metadata_reserve = min(max_bytes // 2, 2 * 1024 * 1024)
        payload_budget = max_bytes - metadata_reserve

        for index, resource in enumerate(tree.get("resources", [])):
            check_time()
            url = resource.get("url", "")
            row = {
                "url": url,
                "type": resource.get("type"),
                "mimeType": resource.get("mimeType"),
                "status": "skipped",
            }
            resources.append(row)
            kind = resource.get("type")
            if index >= max_resources:
                row.update(status="over_budget", reason="resource_count")
                continue
            if (
                urlsplit(url).path.lower().endswith(".map")
                or kind not in RESOURCE_TYPES
                or urlsplit(url).scheme not in {"http", "https", "data", "blob"}
            ):
                row["reason"] = "not_frontend_resource"
                continue
            limit = min(MAX_RESOURCE_BYTES, payload_budget - used)
            size = resource.get("contentSize")
            if limit <= 0 or (type(size) in {int, float} and size > limit):
                row.update(status="over_budget", reason="resource_bytes")
                continue
            try:
                if kind == "Script":
                    script = script_ids.get(url)
                    if (
                        not script
                        or type(script.get("length")) is not int
                        or script["length"] > limit
                    ):
                        row.update(status="unreadable", reason="script_cache_unavailable")
                        continue
                    source = read("Debugger.getScriptSource", scriptId=script["scriptId"])
                    receipt = {"content": source.get("scriptSource"), "base64Encoded": False}
                elif url in cached:
                    receipt = {
                        "content": base64.b64encode(cached[url]).decode("ascii"),
                        "base64Encoded": True,
                    }
                else:
                    row.update(status="unreadable", reason="cache_unavailable")
                    continue
            except error as exc:
                # 中文注释：只接受已确定的缓存读取失败；撤权、专用 lane、凭据保护及未知一律停止。
                if exc.code != "extension_error" or exc.outcome_unknown is not False:
                    raise
                row.update(status="unreadable", reason="cache_unavailable")
                continue
            if (
                not isinstance(receipt, dict)
                or not isinstance(receipt.get("content"), str)
                or type(receipt.get("base64Encoded")) is not bool
            ):
                row.update(status="unreadable", reason="cache_receipt_unavailable")
                continue
            content = receipt["content"]
            if len(content) > (limit * 4 // 3 + 4 if receipt["base64Encoded"] else limit):
                row.update(status="over_budget", reason="resource_bytes")
                continue
            try:
                body = (
                    base64.b64decode(content, validate=True)
                    if receipt["base64Encoded"]
                    else content.encode("utf-8")
                )
            except (ValueError, UnicodeError):
                row.update(status="unreadable", reason="invalid_cache_encoding")
                continue
            if len(body) > limit:
                row.update(status="over_budget", reason="resource_bytes")
                continue
            suffix = {
                "image/svg+xml": ".svg",
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/webp": ".webp",
                "image/gif": ".gif",
            }.get(resource.get("mimeType"), RESOURCE_TYPES[kind])
            name = f"assets/{index:04d}{suffix}"
            members[name] = body
            used += len(body)
            row.update(status="exported", path=name)
        mapping = {
            r["url"]: r["path"]
            for r in resources
            if r["status"] == "exported" and r["type"] != "Script"
        }
        css_unresolved = 0
        for row in resources:
            if row["status"] != "exported" or row["type"] != "Stylesheet":
                continue
            path = "preview/" + Path(row["path"]).name
            mapping[row["url"]] = path
        for row in resources:
            if row["status"] == "exported" and row["type"] == "Stylesheet":
                data, missing = _css_preview(members[row["path"]], row["url"], mapping)
                css_unresolved += missing
                if used + len(data) <= payload_budget:
                    path = mapping[row["url"]]
                    members[path] = data
                    row["previewPath"] = path
                    used += len(data)
                else:
                    mapping.pop(row["url"], None)
                    css_unresolved += 1
        check_time()
        serializer = Path(__file__).with_suffix(".js").read_text(encoding="utf-8")
        page = evaluate(serializer, {"resources": mapping, "maxChars": 160000}, timeout_ms=10000)
        check_time()
        if (
            not isinstance(page, dict)
            or not isinstance(page.get("html"), str)
            or page.get("overBudget")
        ):
            raise error(
                "page DOM unavailable or exceeds export budget",
                code="export_budget",
                outcome_unknown=False,
            )
        members["index.html"] = page["html"].encode("utf-8")
        for index, script in enumerate(page.get("scripts", [])):
            members[f"source/inline-{index:04d}.js"] = script["text"].encode("utf-8")
        used = sum(len(value) for value in members.values())
        if _identity(frame_tree("Page.getFrameTree")) != identity:
            raise error(
                "page changed during export", code="document_changed", outcome_unknown=False
            )
        coverage = {
            **page["coverage"],
            "partial": True,
            "complete": False,
            "topLevelOnly": True,
            "childFrames": len(tree.get("childFrames", [])),
            "cssUnresolved": css_unresolved + page["coverage"].get("cssUnresolved", 0),
            "resourceCount": len(resources),
            "exportedResources": sum(r["status"] == "exported" for r in resources),
        }
        manifest = {
            "version": 1,
            "coverage": coverage,
            "privacyWarning": "Private package: JavaScript, embedded state and visible content may contain sensitive data; not universal secret sanitization. Frontend resources only, not backend or original project source.",
            "limits": {
                "maxBytes": max_bytes,
                "maxResources": max_resources,
                "maxResourceBytes": MAX_RESOURCE_BYTES,
                "totalSeconds": TOTAL_SECONDS,
            },
            "resources": resources,
            "members": [
                {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                for name, data in members.items()
            ],
        }
        manifest_bytes = json.dumps(manifest, ensure_ascii=True).encode("utf-8")
        if used + len(manifest_bytes) > max_bytes:
            raise error(
                "page manifest exceeds export budget", code="export_budget", outcome_unknown=False
            )
        check_time()
        with zipfile.ZipFile(output, "w") as archive:
            for name, data in members.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", manifest_bytes)
        if output.tell() > max_bytes:
            raise error(
                "page ZIP exceeds export budget", code="export_budget", outcome_unknown=False
            )
        check_time()
        output.seek(0)
        digest = hashlib.file_digest(output, "sha256").hexdigest()
        return {
            "path": str(target),
            "sha256": digest,
            "count": len(members) + 1,
            "coverage": coverage,
        }
