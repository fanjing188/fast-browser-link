#!/usr/bin/env python3
"""受信 Assist 产品装配；执行底座不导入、发现或初始化产品模块。"""

import secrets
from typing import Any
from urllib.parse import urlsplit


class _TableTaskParams(dict):
    """仅受信侧栏路由构造；JSON 客户端不能伪造该进程内类型。"""


class AssistAdapter:
    def __init__(self, daemon, *, app=None):
        self.daemon = daemon
        self.app: Any = app
        self.product = None

    @staticmethod
    def handles_extension(method):
        return isinstance(method, str) and method.startswith(
            ("extension.copilot.", "extension.product.")
        )

    def _initialize(self):
        if self.app is not None:
            return
        from copilot import Copilot
        from copilot_codex_broker import BrowserBroker

        daemon = self.daemon

        def notify(target, payload):
            current = daemon.extensions.get(target)
            if current:
                daemon._send_extension(current, {"method": "copilot.changed", "params": payload})

        app: Any = Copilot(daemon.data_dir / "copilot", notify)
        app.codex_browser_factory = lambda instance, epoch, row, template, limit: BrowserBroker(
            daemon,
            instance,
            lambda: app._valid(instance, epoch) and row.get("status") == "executing",
            row.get("page_context") or app._state(instance).get("page_context"),
            template,
            limit,
        )
        app.resource_status = lambda task_id: (
            daemon.tasks.get(task_id, {}).get("state") in {"closed", "cancelled"}
            and daemon.tasks.get(task_id, {}).get("cleanupState") == "succeeded"
        )
        self.app = app

    def dispatch_extension(self, extension, method, params):
        daemon = self.daemon
        instance = extension["instanceId"]
        if method.startswith("extension.product."):
            with daemon.state_lock:
                if daemon.extensions.get(instance) is not extension:
                    raise daemon.protocol_error("connection_replaced", "product request denied")
                if self.product is None:
                    # 中文注释：仅完整产品启动器懒装配；纯 daemon 不导入产品。
                    from product_adapter import ProductAdapter

                    self.product = ProductAdapter(daemon)
            return self.product.dispatch_extension(extension, method, params)
        try:
            with daemon.state_lock:
                if daemon.extensions.get(instance) is not extension:
                    raise daemon.protocol_error(
                        "connection_replaced", "browser connection was replaced"
                    )
                self._initialize()
            if method == "extension.copilot.work_create":
                return self._work_create(instance, params)
            return self.app.request(instance, method.removeprefix("extension.copilot."), params)
        except (ValueError, OSError, KeyError, TypeError):
            raise daemon.protocol_error(
                "copilot_denied", "Assist request failed; check local configuration"
            ) from None

    def _work_create(self, instance, params):
        if (
            set(params) - {"url", "incognito", "resourceId"}
            or not isinstance(params.get("url"), str)
            or type(params.get("incognito", False)) is not bool
        ):
            raise ValueError("invalid table workspace")
        parsed = urlsplit(params["url"])
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("invalid work URL")
        if not self.app.resource_allowed(
            instance, params["url"], fetch_id=params.get("resourceId")
        ):
            raise ValueError("serialized tool requires capability lane")
        # 中文注释：本地表格由可信扩展明确点选；只选择后台工作页，不替代标准授权/租约安装。
        return self.daemon._create_task(
            _TableTaskParams(
                owner="copilot-table-" + secrets.token_hex(12),
                title="Fast-browser-link · 后台数据",
                instanceId=instance,
                allowedOrigins=[f"{parsed.scheme}://{parsed.netloc}"],
                incognito=params.get("incognito", False),
                copilotSilentToken=self.app.silent_token,
                copilotResourceToken=params.get("resourceId"),
            )
        )

    def prepare_task(self, params):
        if "copilotTableExport" in params:
            raise self.daemon.protocol_error("invalid_params", "internal table flag denied")
        token = params.get("copilotSilentToken")
        silent = token is not None
        if silent and (
            self.app is None
            or not (
                self.app.valid_silent_token(token)
                or isinstance(params, _TableTaskParams)
                and token == self.app.silent_token
            )
        ):
            raise self.daemon.protocol_error("copilot_silent_denied", "协作后台会话已失效")
        prepared = dict(params)
        prepared.pop("copilotSilentToken", None)
        resource = prepared.pop("copilotResourceToken", None)
        if silent:
            title = self.daemon._required_string(params, "title")
            prepared["title"] = (
                "Fast-browser-link · "
                + title.removeprefix("Fast-browser-link ·")
                .strip()
                .removeprefix("Hermes 协作·")
                .removeprefix("协作·")
                .strip()
            )
        return prepared, silent, resource if silent else None

    def task_created(self, task, resource_token):
        if not resource_token:
            return
        instance = task["instanceId"]
        resource = self.app.browser_fetches.get(resource_token)
        if resource and resource["instance"] == instance:
            task["copilotRowId"] = resource.get("row_id") or resource.get(
                "job_key", ""
            ).removeprefix(instance + ":")
        self.app.resource_tasks[task["id"]] = resource_token

    def frame_event(self, instance, event, size=None):
        if self.app is None:
            return
        if event == "message_chunked":
            self.app.journal.add(instance, "bridge_warning", snapshot_bytes=size)
        elif event == "message_too_large":
            self.app.journal.add(instance, "bridge_rejected", error=True)

    def connection_changed(self, instance, connected):
        if self.app is not None:
            self.app.bridge_connection(instance, connected)

    def close(self):
        if self.app is not None:
            self.app.close()


def main():
    # 中文注释：默认产品启动器显式绑定唯一适配器；直接运行 daemon.py 始终是纯浏览器底座。
    from daemon import main as run_daemon

    return run_daemon(service_factory=AssistAdapter)


if __name__ == "__main__":
    raise SystemExit(main())
