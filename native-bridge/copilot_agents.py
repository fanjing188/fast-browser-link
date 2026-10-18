"""协作 Agent 注册、只读发现和用户主动触发的后台安装；目前仅支持 Hermes。"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

REGISTRY = {"hermes": {"id": "hermes", "name": "Hermes"}}
METHODS = {
    "agent_catalog",
    "agent_setup_start",
    "agent_setup_status",
    "agent_setup_cancel",
    "agent_select",
}
INSTALL_URL = "https://hermes-agent.nousresearch.com/install.sh"
INSTALL_DOCS = "https://hermes-agent.nousresearch.com/docs/getting-started/installation"
PHASES = {"detect", "install_engine", "integration", "profiles", "connection", "complete"}
ERRORS = {
    "engine_install_failed",
    "engine_existing_configuration_requires_manual",
    "auth_required",
    "profile_unmanaged",
    "adapter_unavailable",
    "setup_failed",
    "connection_failed",
    "setup_timeout",
}


class SetupError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def command(ctx, config):
    for candidate in (config.get("hermes_command", "hermes"), str(ctx.user / ".local/bin/hermes")):
        if isinstance(candidate, str) and shutil.which(candidate):
            return shutil.which(candidate)
    return None


def configured(ctx, config):
    from fbl_profiles import profile_plan
    from fbl_runtime import safe

    if not config.get("agent_onboarded"):
        return False
    try:
        if profile_plan(ctx.hermes, "fast-copilot", allow_subprocess=False)["state"] != "ready":
            return False
        shared = safe(ctx.hermes / "plugins/fast-browser-link")
        local = ctx.hermes / "profiles/fast-copilot/plugins/fast-browser-link"
        safe(local.parent)
        return shared.is_dir() and local.is_symlink() and local.resolve() == shared.resolve()
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return False


class InstallerRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        url = urlsplit(newurl)
        if (
            url.scheme != "https"
            or url.hostname != "hermes-agent.nousresearch.com"
            or url.port not in (None, 443)
            or url.username
            or url.password
            or url.path != "/install.sh"
            or url.query
            or url.fragment
        ):
            raise SetupError("engine_install_failed")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def install_engine(ctx):
    from fbl_runtime import safe

    checkout = ctx.hermes / "hermes-agent"
    protected = [
        checkout,
        ctx.user / ".local/bin/hermes",
        *[ctx.hermes / name for name in ("config.yaml", "auth.json", ".env", "active_profile")],
    ]
    if any(path.exists() or path.is_symlink() for path in protected):
        raise SetupError("engine_existing_configuration_requires_manual")
    for path in protected:
        try:
            safe(path)
        except ValueError as error:
            raise SetupError("engine_existing_configuration_requires_manual") from error
    request = urllib.request.Request(
        INSTALL_URL, headers={"User-Agent": "fast-browser-link-onboarding"}
    )
    with urllib.request.build_opener(InstallerRedirect()).open(request, timeout=30) as response:
        payload = response.read(2 * 1024 * 1024 + 1)
    if not payload or len(payload) > 2 * 1024 * 1024:
        raise SetupError("engine_install_failed")
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("HERMES_INSTALL") and key != "HERMES_REPO_URL"
    }
    with tempfile.TemporaryDirectory(prefix="fbl-hermes-install-") as temporary:
        script = Path(temporary) / "install.sh"
        script.write_bytes(payload)
        script.chmod(0o600)
        process = subprocess.Popen(
            [
                "/bin/bash",
                str(script),
                "--non-interactive",
                "--channel",
                "stable",
                "--skip-browser",
                "--skip-computer-use",
                "--hermes-home",
                str(ctx.hermes),
                "--dir",
                str(checkout),
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            code = process.wait(timeout=180)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)
                except ProcessLookupError:
                    process.wait(timeout=2)
        if code or not command(ctx, {}):
            raise SetupError("engine_install_failed")


@contextmanager
def adapter_source(ctx):
    """优先复用已安装共享适配器；缺失时只取现有校验下载器的正式包。"""
    from fbl_runtime import load
    from fbl_update import verify_source

    adjacent = Path(__file__).resolve().parent.parent
    if (adjacent / "plugin.yaml").is_file():
        yield adjacent
        return
    support = ctx.support
    if (
        not support
        or not (support / "update.py").is_file()
        or not (support / "install-executor.py").is_file()
    ):
        raise SetupError("adapter_unavailable")
    downloader = load("fbl_onboarding_download", support / "update.py")
    verifier = load("fbl_onboarding_verifier", support / "install-executor.py")
    release = downloader.latest_release()
    if not release:
        raise SetupError("adapter_unavailable")
    with tempfile.TemporaryDirectory(prefix="fbl-agent-adapter-") as temporary:
        source = downloader.extract_archive(
            downloader.fetch(release["url"], downloader.MAX_ARCHIVE),
            release,
            Path(temporary),
            verifier,
        )
        yield verify_source(source)["adapter"]


def bind_adapter(ctx):
    from fbl_runtime import safe

    shared = safe(ctx.hermes / "plugins/fast-browser-link")
    if shared.exists():
        if not (shared / "plugin.yaml").is_file():
            raise SetupError("adapter_unavailable")
    else:
        shared.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (
            adapter_source(ctx) as source,
            tempfile.TemporaryDirectory(prefix=".fbl-agent-", dir=shared.parent) as temporary,
        ):
            stage = Path(temporary) / "adapter"
            # 中文注释：下载器已拒绝链接；本机已有包同样拒绝任何链接，避免复制外部目录。
            if any(path.is_symlink() for path in source.rglob("*")):
                raise SetupError("adapter_unavailable")
            shutil.copytree(source, stage, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            if not (stage / "plugin.yaml").is_file() or shared.exists() or shared.is_symlink():
                raise SetupError("adapter_unavailable")
            os.rename(stage, shared)
    local = ctx.hermes / "profiles/fast-copilot/plugins/fast-browser-link"
    safe(local.parent)
    if local.is_symlink():
        if local.resolve() != shared.resolve():
            raise SetupError("profile_unmanaged")
    elif local.exists():
        raise SetupError("profile_unmanaged")
    else:
        local.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        local.symlink_to(shared, target_is_directory=True)


def setup(ctx, config, progress=lambda _: None):
    from copilot_acp import ACP
    from fbl_profiles import profile_plan, repair
    from fbl_runtime import available_models, choose_model, private_write, safe
    from fbl_cli import install_skills

    progress("detect")
    root = safe(ctx.hermes / "profiles/fast-copilot")
    if root.exists() and not (root / ".copilot-profile.json").is_file():
        raise SetupError("profile_unmanaged")
    binary = command(ctx, config)
    if not binary:
        progress("install_engine")
        install_engine(ctx)
        binary = command(ctx, config)
        if not binary:
            raise SetupError("engine_install_failed")
    try:
        catalog = available_models(ctx, command=[binary, "-p", "default", "acp"])
        model, provider = choose_model(catalog)
    except (ValueError, RuntimeError) as error:
        raise SetupError("auth_required") from error
    progress("profiles")
    if profile_plan(ctx.hermes, "fast-copilot", model, provider)["state"] == "unmanaged":
        raise SetupError("profile_unmanaged")
    repair(ctx.hermes, "fast-copilot", private_write, model, provider)
    progress("integration")
    bind_adapter(ctx)
    install_skills(ctx, ["hermes"])
    progress("connection")
    runtime = ACP(
        {
            "hermes_command": binary,
            "hermes_home": str(ctx.hermes),
            "inference_profile": "fast-copilot",
            "timeout_seconds": 20,
        },
        ctx.copilot,
    )
    try:
        runtime.start(initialize_only=True)
    except (OSError, RuntimeError) as error:
        raise SetupError("connection_failed") from error
    finally:
        runtime.close()
    progress("complete")
    return {
        "connection": {
            "inference": "connected",
            "execution": "connected",
            "check": "acp_initialize",
            "model_call": False,
        },
        "hermes_command": binary,
        "hermes_home": str(ctx.hermes),
        "bridge_home": str(ctx.runtime),
        "fbl_user_home": str(ctx.user),
    }


class Agents:
    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()
        self.jobs = {}
        self.closed = False

    def summary(self, health):
        identity = self.app.config.get("default_agent", "hermes")
        if not isinstance(identity, str) or identity not in REGISTRY:
            return {
                **health,
                "id": identity if isinstance(identity, str) else "unsupported",
                "name": "Agent",
                "state": "error",
                "reason": "默认 Agent 暂不受支持，请重新选择",
                "reason_en": "Default agent unsupported; choose an available agent",
                "acp_ready": False,
            }
        return {**REGISTRY[identity], **health}

    def busy(self):
        with self.lock:
            return any(
                job["status"] == "pending" or job["process"] is not None
                for job in self.jobs.values()
            )

    def _context(self):
        from fbl_panel import context

        return context(self.app)

    def _active(self):
        return bool(
            any(
                state["enabled"]
                or state["running"]
                or any(
                    row.get("status") in {"queued", "executing", "stopping"}
                    for row in state["suggestions"].values()
                )
                for state in self.app.states.values()
            )
            or self.app.registry.jobs
            or self.app.executions.jobs
            or self.app.fetcher.jobs
            or self.app.basket.active_jobs
            or self.app.tool_health_running
            or self.app.acp_executions
            and self.app.acp_executions.jobs
        )

    def _idle(self):
        if self.app.closed or self._active():
            raise ValueError("close collaboration and finish tasks before configuring agent")

    @staticmethod
    def _view(job):
        return {
            key: job[key]
            for key in (
                "id",
                "agent_id",
                "status",
                "phase",
                "error",
                "next_command",
                "connection",
                "installation",
            )
            if key in job
        }

    def catalog(self, instance):
        with self.app.lock:
            config = dict(self.app.config)
            active = self._active()
        busy = active or self.busy()
        ctx = self._context()
        installed = bool(command(ctx, config))
        ready = installed and configured(ctx, config)
        row = {
            **REGISTRY["hermes"],
            "installed": installed,
            "configured": ready,
            "status": "configured" if ready else "needs_setup" if installed else "not_installed",
            "can_setup": not busy,
            "setup_action": "configure" if installed else "install_engine",
            "setup_hint": "配置 Hermes 专用协作环境" if installed else "安装 Hermes 并配置协作",
        }
        selected = config.get("default_agent", "hermes")
        result = {
            "default_agent": selected,
            "busy": busy,
            "onboarding_required": not ready
            or not isinstance(selected, str)
            or selected not in REGISTRY,
            "agents": [row],
        }
        with self.lock:
            jobs = [job for job in self.jobs.values() if job["owner"] == instance]
            if jobs:
                result["job"] = self._view(jobs[-1])
        return result

    def request(self, instance, method, params):
        expected = (
            {"agent_id"}
            if method in {"agent_setup_start", "agent_select"}
            else {"id"}
            if method in {"agent_setup_status", "agent_setup_cancel"}
            else set()
        )
        if method not in METHODS or not isinstance(params, dict) or set(params) != expected:
            raise ValueError("invalid agent request")
        if "agent_id" in params and (
            not isinstance(params["agent_id"], str) or params["agent_id"] not in REGISTRY
        ):
            raise ValueError("unsupported collaboration agent")
        if method == "agent_catalog":
            return self.catalog(instance)
        if method == "agent_select":
            with self.app.lock:
                self._idle()
                if self.busy() or not self.catalog(instance)["agents"][0]["configured"]:
                    raise ValueError("agent setup required")
                self.app._save_configuration({"default_agent": params["agent_id"]})
                self.app._emit(instance, "configuration", changes=["default_agent"])
            return self.catalog(instance)
        if method == "agent_setup_start":
            with self.app.lock, self.lock:
                self._idle()
                active = next(
                    (
                        job
                        for job in self.jobs.values()
                        if job["status"] == "pending" or job["process"] is not None
                    ),
                    None,
                )
                if active:
                    if active["owner"] != instance:
                        raise ValueError("agent setup busy")
                    return self._view(active)
                if self.closed:
                    raise ValueError("agent service closed")
                while len(self.jobs) >= 16:
                    self.jobs.pop(next(iter(self.jobs)))
                job = {
                    "id": uuid.uuid4().hex,
                    "agent_id": params["agent_id"],
                    "owner": instance,
                    "status": "pending",
                    "phase": "detect",
                    "process": None,
                }
                self.jobs[job["id"]] = job
                job["thread"] = threading.Thread(target=self._run, args=(job,), daemon=True)
                job["thread"].start()
                return self._view(job)
        with self.lock:
            identity = params["id"]
            job = self.jobs.get(identity) if isinstance(identity, str) else None
            if not job or job["owner"] != instance:
                raise ValueError("agent setup unavailable")
            if method == "agent_setup_cancel" and job["status"] == "pending":
                job["status"] = "cancelled"
                self._terminate(job["process"])
            return self._view(job)

    @staticmethod
    def _terminate(process, force=False):
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass

    def _read(self, job, process):
        for line in iter(lambda: process.stdout.readline(4097), ""):
            try:
                value = json.loads(line) if len(line) <= 4096 else {}
                if not isinstance(value, dict):
                    continue
                with self.lock:
                    if value.get("phase") in PHASES:
                        job["phase"] = value["phase"]
                    if value.get("result") in {"completed", "failed"}:
                        job["outcome"] = value
            except (ValueError, TypeError):
                pass

    def _run(self, job):
        process = None
        reader = None
        outcome = {"result": "failed", "error": "setup_failed"}
        try:
            with self.lock:
                if self.closed or job["status"] != "pending":
                    return
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-B",
                        str(Path(__file__).resolve()),
                        "--worker",
                        str(self.app.directory),
                    ],
                    cwd=self.app.directory,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    start_new_session=True,
                )
                job["process"] = process
            reader = threading.Thread(target=self._read, args=(job, process), daemon=True)
            reader.start()
            deadline = time.monotonic() + 300
            while True:
                try:
                    process.wait(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    with self.lock:
                        if job["status"] == "cancelled":
                            break
                    if time.monotonic() >= deadline:
                        raise
            reader.join(timeout=1)
            with self.lock:
                if not process.returncode:
                    outcome = job.pop("outcome", outcome)
        except subprocess.TimeoutExpired:
            outcome = {"result": "failed", "error": "setup_timeout"}
        except (OSError, ValueError):
            pass
        finally:
            if process is not None:
                try:
                    self._terminate(process)
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        self._terminate(process, force=True)
                        process.wait(timeout=2)
                except (OSError, subprocess.SubprocessError):
                    outcome = {"result": "failed", "error": "setup_failed"}
                if reader:
                    reader.join(timeout=1)
                try:
                    process.stdout.close()
                except OSError:
                    outcome = {"result": "failed", "error": "setup_failed"}
        with self.app.lock, self.lock:
            job["process"] = None
            if job["status"] != "pending":
                return
            if outcome["result"] == "completed":
                try:
                    expected = {
                        "inference": "connected",
                        "execution": "connected",
                        "check": "acp_initialize",
                        "model_call": False,
                    }
                    if (
                        outcome.get("connection") != expected
                        or type(outcome["connection"].get("model_call")) is not bool
                    ):
                        raise ValueError("invalid connection receipt")
                    ctx = self._context()
                    if (
                        outcome.get("hermes_home") != str(ctx.hermes)
                        or outcome.get("bridge_home") != str(ctx.runtime)
                        or outcome.get("fbl_user_home") != str(ctx.user)
                        or not isinstance(outcome.get("hermes_command"), str)
                        or not Path(outcome["hermes_command"]).is_absolute()
                    ):
                        raise ValueError("invalid agent setup receipt")
                    self.app._save_configuration(
                        {
                            "default_agent": job["agent_id"],
                            "agent_onboarded": True,
                            "hermes_command": outcome["hermes_command"],
                            "hermes_home": outcome["hermes_home"],
                            "bridge_home": outcome["bridge_home"],
                            "fbl_user_home": outcome["fbl_user_home"],
                            "inference_profile": "fast-copilot",
                            "exec_profile": "fast-copilot",
                        }
                    )
                    job.update(
                        status="completed", phase="complete", connection=outcome["connection"]
                    )
                    self.app._emit(job["owner"], "configuration", changes=["default_agent"])
                except (OSError, ValueError, KeyError):
                    job.update(status="failed", error="setup_failed")
            else:
                error = outcome.get("error") if outcome.get("error") in ERRORS else "setup_failed"
                job.update(status="failed", error=error)
                if error == "auth_required":
                    job["next_command"] = "hermes model"
                if error == "engine_existing_configuration_requires_manual":
                    job["installation"] = {
                        "url": INSTALL_DOCS,
                        "command": "See the official installation and repair instructions",
                    }

    def close(self):
        with self.lock:
            self.closed = True
            threads = []
            for job in self.jobs.values():
                if job["status"] == "pending":
                    job["status"] = "cancelled"
                    self._terminate(job["process"])
                threads.append(job["thread"])
        for thread in threads:
            thread.join(timeout=10)


def worker(directory):
    from fbl_runtime import Context, read

    directory = Path(directory)
    config = read(directory / "config.json")
    ctx = Context.locate(
        user=config.get("fbl_user_home"),
        hermes=config.get("hermes_home"),
        runtime=directory.parents[2],
    )

    def cancelled(*_):
        raise SystemExit(130)

    signal.signal(signal.SIGTERM, cancelled)

    def emit(value):
        print(json.dumps(value), flush=True)

    try:
        result = setup(ctx, config, lambda phase: emit({"phase": phase}))
        emit({"result": "completed", **result})
    except SetupError as error:
        emit({"result": "failed", "error": error.code})
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        emit({"result": "failed", "error": "setup_failed"})


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--worker":
        raise SystemExit(2)
    worker(sys.argv[2])
