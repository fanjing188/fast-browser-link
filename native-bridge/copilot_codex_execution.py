"""Codex 每任务独立进程/线程；只对后续任务重建，不重放执行。"""

import json
import threading
import time
from pathlib import Path
from copilot_acp import ACPError
from copilot_codex import Codex
from copilot_execution import ExecutionError
from copilot_diagnostics import failure


class CodexExecutions:
    def __init__(self, config, directory, on_error=lambda _: None, on_process=lambda _: None):
        self.config, self.directory = config, directory
        self.on_error, self.on_process = on_error, on_process
        self.lock = threading.RLock()
        self.jobs, self.cancelled = {}, set()
        self.closed = False
        self.runtime = None

    def start(self):
        if self.closed:
            raise ExecutionError("Assist execution closed")
        return self

    def prepare(self, key):
        with self.lock:
            self.cancelled.discard(key)

    def cancel(self, key):
        with self.lock:
            self.cancelled.add(key)
            runtime = self.jobs.get(key)
        if runtime:
            runtime.cancel()

    def run(
        self,
        key,
        brief,
        result_path,
        parse,
        write,
        progress=lambda _: None,
        selected_model=None,
        *,
        template=None,
        broker=None,
    ):
        work = Path(result_path).parent.resolve()
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        execution = brief.get("single_judgment") is not True and brief["action"] == "general.task"
        if not execution and template and template.get("toolsets") != ["none"]:
            execution = True
        config = {**self.config}
        config["exec_model" if execution else "inference_model"] = selected_model or ""
        runtime = Codex(config, work, execution=execution, broker=broker)
        runtime.deadline = time.monotonic() + config.get("timeout_seconds", 180)
        runtime.exit_observer = self.on_process
        metrics = None
        with self.lock:
            if self.closed or key in self.cancelled:
                runtime.close()
                raise ExecutionError("Assist execution stopped")
            self.jobs[key] = runtime
        try:
            runtime.start()
            with self.lock:
                if self.closed or key in self.cancelled:
                    raise ExecutionError("Assist execution stopped")
            progress({"type": "model", "model": runtime.active_model, "source": "codex.thread"})
            text, metrics = runtime.prompt(
                json.dumps(
                    {
                        **brief,
                        "output": "Return strict JSON matching result_schema; Assist writes the result. Use only authorized tools and supplied evidence.",
                    },
                    ensure_ascii=False,
                )
            )
            with self.lock:
                if self.closed or key in self.cancelled:
                    raise ExecutionError("Assist execution stopped")
            result = parse(text)
            write(result_path, json.dumps(result, ensure_ascii=False))
            return result, metrics
        except (ACPError, ValueError, OSError, ExecutionError) as error:
            exc = ExecutionError(str(error))
            exc.failure = failure(error, runtime)
            if metrics or getattr(error, "metrics", None):
                exc.metrics = metrics or error.metrics
            raise exc from None
        finally:
            # 中文注释：先撤销和取消回调，再 interrupt、清理工作页、结束自有线程进程。
            runtime.cancel()
            try:
                if broker:
                    cleanup = broker.cleanup()
                    write(work / "browser-cleanup.json", json.dumps(cleanup, ensure_ascii=False))
                    progress({"type": "browser_cleanup", "receipt": None, "cleanup": cleanup})
            finally:
                runtime.close()
                with self.lock:
                    self.jobs.pop(key, None)
                    self.cancelled.discard(key)

    def close(self):
        with self.lock:
            self.closed = True
            keys = list(self.jobs)
        for key in keys:
            self.cancel(key)
        with self.lock:
            runtimes = list(self.jobs.values())
        for runtime in runtimes:
            if runtime.broker:
                runtime.broker.cleanup()
            runtime.close()
