"""发现只列标签元数据或在新归属工作页读取结构，不接管用户页面。"""

import json
import os
from pathlib import Path
import secrets
import stat
import time
import uuid
from urllib.parse import urlsplit
from client import BridgeClient

METHODS = {
    "health": "health",
    "browsers": "browser.list",
    "create": "shared.create",
    "get": "shared.get",
    "run": "shared.run",
    "close": "shared.close",
    "cancel": "shared.cancel",
    "resume": "shared.resume",
    "list": "shared.list",
    "downloads": "shared.downloads",
}


def browser_call(ctx, operation, params, session=None):
    if operation not in METHODS or not isinstance(params, dict):
        raise ValueError("invalid browser operation")
    if any(key in params for key in ("owner", "session_id", "__owner_lease")):
        raise ValueError("caller cannot supply task authority")
    values = dict(params)
    if operation not in {"health", "browsers"}:
        if not session:
            raise ValueError("task operations require --session")
        path = Path(session).expanduser()
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise ValueError("unsafe session file")
            owner = handle.read(129)
        if not owner or len(owner) > 128:
            raise ValueError("invalid session identity")
        values["owner"] = owner
    if operation == "run":
        values.setdefault("requestId", uuid.uuid4().hex)
    client = BridgeClient(ctx.runtime)
    try:
        return client.call(METHODS[operation], values)
    finally:
        client.close()


class BrowserDiscovery:
    def __init__(self, ctx, client_factory=BridgeClient):
        self.ctx = ctx
        self.client_factory = client_factory

    def tabs(self):
        client = self.client_factory(self.ctx.runtime)
        try:
            browsers = client.call("browser.list", {})
            rows = []
            for browser in browsers:
                identity = browser.get("instanceId") or browser.get("id")
                if browser.get("connected") and identity:
                    rows += client.call("fbl.tabs", {"instanceId": identity, "confirm": True})
            return rows
        finally:
            client.close()

    def page(self, url):
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("invalid report URL")
        client = self.client_factory(self.ctx.runtime)
        task = None
        owner = secrets.token_urlsafe(24)
        try:
            browsers = [row for row in client.call("browser.list", {}) if row.get("connected")]
            if not browsers:
                raise ValueError("no connected browser")
            browser = browsers[0]
            identity = browser.get("instanceId") or browser.get("id")
            task = client.call(
                "shared.create",
                {
                    "owner": owner,
                    "title": "Fast-browser-link · Report discovery",
                    "instanceId": identity,
                    "allowedOrigins": [parsed.scheme + "://" + parsed.netloc],
                },
            )
            deadline = time.monotonic() + 10
            while task.get("state") != "ready" and time.monotonic() < deadline:
                if task.get("state") in {"cancelled", "closed", "paused"}:
                    raise ValueError("browser confirmation required")
                time.sleep(0.1)
                task = client.call("shared.get", {"owner": owner, "taskId": task["id"]})
            if task.get("state") != "ready":
                raise ValueError("browser confirmation required")
            opened = client.call(
                "shared.run",
                {
                    "owner": owner,
                    "taskId": task["id"],
                    "requestId": uuid.uuid4().hex,
                    "action": "new_tab",
                    "url": url,
                },
            )
            tab = opened.get("tabId", opened.get("id"))
            if type(tab) is not int:
                raise ValueError("owned discovery tab missing")
            snapshot = client.call(
                "shared.run",
                {
                    "owner": owner,
                    "taskId": task["id"],
                    "tabId": tab,
                    "requestId": uuid.uuid4().hex,
                    "action": "semantic_snapshot",
                    "options": {"mode": "table", "budget": 3000},
                },
            )
            items = snapshot.get("items", [])
            headers = list(
                dict.fromkeys(
                    str(item.get("name", "")).strip()
                    for item in items
                    if item.get("role") in {"columnheader", "rowheader"} and item.get("name")
                )
            )[:100]
            headers = headers or next(
                (
                    list(item.get("cells", []))
                    for item in items
                    if item.get("role") == "row"
                    and any(
                        str(cell).strip().casefold() in {"keyword", "关键词", "domain", "url"}
                        for cell in item.get("cells", [])
                    )
                ),
                [],
            )
            title = str(snapshot.get("title", ""))
            blocked = (
                "login"
                if any(word in title.casefold() for word in ("sign in", "log in", "登录"))
                else None
            )
            return {"blocked": blocked, "tables": [{"headers": headers}] if headers else []}
        finally:
            if task:
                try:
                    receipt = client.call("shared.close", {"owner": owner, "taskId": task["id"]})
                    if receipt.get("cleanupState") != "succeeded":
                        raise ValueError("discovery cleanup unverified")
                finally:
                    client.close()
            else:
                client.close()
