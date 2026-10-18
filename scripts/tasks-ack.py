#!/usr/bin/env python3
"""中文注释：把用户核实过的已关闭任务标记为清理完成，替代手工修改 tasks.json。

只在 daemon 已停止并持有其启动锁时写入；写入前自动备份原文件。
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLI = load_module("tasks_ack_installer", ROOT / "scripts/install-cli.py")
CLI.EXECUTOR = CLI.load_module("tasks_ack_executor", ROOT / "scripts/install-executor.py")
InstallError = CLI.InstallError


def shared_home(value):
    home = Path(value).expanduser()
    if home.is_symlink():
        raise InstallError("Hermes 目录不能是链接。", "使用实际目录路径后重试。")
    home = home.resolve()
    return home.parent.parent if home.parent.name == "profiles" else home


def hold_daemon_lock(data):
    # 中文注释：持有 daemon 自身的启动锁，写入期间任何入口都无法启动新 daemon。
    lock = data / "daemon.lock"
    CLI.EXECUTOR.reject_target_symlinks([lock])
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        os.close(descriptor)
        raise InstallError("桥接启动锁不安全 / Unsafe bridge lock.", "核对私有桥接目录后重试。")
    # 中文注释：daemon 先删 PID 文件、进程退出时才释放锁；刚停止时短暂等待锁释放。
    deadline = time.monotonic() + 5
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return descriptor
        except BlockingIOError as error:
            if time.monotonic() < deadline:
                time.sleep(0.1)
                continue
            os.close(descriptor)
            raise InstallError(
                "桥接仍在运行 / Bridge is running.",
                "加 --stop-daemon 让本命令进入维护模式并停止已核实的 daemon，或等它空闲退出后重试。",
            ) from error


def acknowledge(home, task_id, reason, env, *, stop_daemon=False):
    data = home / "plugin-data/fast-browser-link-native"
    CLI.EXECUTOR.reject_target_symlinks([data])
    if not data.is_dir():
        raise InstallError("找不到桥接数据目录。", "核对 HERMES_HOME 后重试。")
    with CLI.install_lock(data):
        token = None
        try:
            if stop_daemon:
                token = CLI.enter_maintenance(home, "tasks:ack", os.getpid())
                CLI.stop_daemon(home, env)
            if CLI.verified_daemon_pid(home, env) is not None:
                raise InstallError(
                    "桥接仍在运行 / Bridge is running.",
                    "加 --stop-daemon 让本命令进入维护模式并停止已核实的 daemon 后重试。",
                )
            descriptor = hold_daemon_lock(data)
            try:
                CLI.check_daemon_stopped(home, env)
                result = CLI.acknowledge_tasks(home, [task_id], reason, env, descriptor)
                return {**result, "taskId": task_id}
            finally:
                os.close(descriptor)
        finally:
            if token:
                CLI.leave_maintenance(home, token)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="标记用户已核实的已关闭任务 / Acknowledge a verified closed task"
    )
    parser.add_argument("task_id")
    parser.add_argument("--reason", default="用户已核实浏览器中没有残留标签页或操作")
    parser.add_argument(
        "--stop-daemon",
        action="store_true",
        help="进入维护模式并停止已核实的 daemon；完成后删除维护标记",
    )
    parser.add_argument(
        "--hermes-home", default=os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
    )
    args = parser.parse_args(argv)
    if not args.reason.strip() or len(args.reason) > 500:
        parser.error("--reason 不能为空且不超过 500 字")
    try:
        result = acknowledge(
            shared_home(args.hermes_home),
            args.task_id,
            args.reason.strip(),
            os.environ,
            stop_daemon=args.stop_daemon,
        )
    except InstallError as error:
        print("错误 / Error: " + str(error) + "\n处理 / Fix: " + error.fix, file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(
            "错误 / Error: " + type(error).__name__ + ": " + str(error).splitlines()[0][:200],
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
