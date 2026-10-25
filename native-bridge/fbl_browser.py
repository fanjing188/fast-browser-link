"""发现只列标签元数据或在新归属工作页读取结构，不接管用户页面。"""

import json

import secrets
import time
import uuid
from urllib.parse import urlsplit
from client import BridgeClient


def browser_call(ctx, operation, params, session=None):
    from browser_sdk import Browser, session_owner

    if operation not in {"health", "browsers"} and not session:
        raise ValueError("task operations require --session")
    owner = session_owner(session) if session else None
    with Browser(home=ctx.runtime, owner=owner) as browser:
        return browser.call(operation, params)


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
