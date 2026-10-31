#!/usr/bin/env python3
"""FBL 产品中立启动器：只装配既有填表通路与受限工作通路。"""

from product_adapter import ProductAdapter
from work_adapter import WorkAdapter


class CoreAdapter:
    def __init__(self, daemon):
        self.daemon = daemon
        self.product = ProductAdapter(daemon)
        self.work = WorkAdapter(daemon)

    @staticmethod
    def handles_extension(method):
        return isinstance(method, str) and method.startswith(
            ("extension.product.", "extension.assist.work.")
        )

    def dispatch_extension(self, extension, method, params):
        if method.startswith("extension.product."):
            return self.product.dispatch_extension(extension, method, params)
        return self.work.dispatch_extension(extension, method, params)

    def prepare_task(self, params):
        # 中文注释：不接受旧 Assist 私有令牌；静默选择只来自进程内关键字参数。
        if any(
            key in params
            for key in ("copilotSilentToken", "copilotResourceToken", "copilotTableExport")
        ):
            raise self.daemon.protocol_error("invalid_params", "legacy collaboration token denied")
        return dict(params), False, None

    def task_created(self, task, context):
        pass

    def frame_event(self, instance, event, size=None):
        pass

    def connection_changed(self, instance, connected):
        self.work.connection_changed(instance, connected)

    def close(self):
        self.work.close()


def main():
    from daemon import main as run_daemon

    return run_daemon(service_factory=CoreAdapter)


if __name__ == "__main__":
    raise SystemExit(main())
