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


def acknowledge(home, task_ids, reason, env, *, stop_daemon=False):
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
                result = CLI.acknowledge_tasks(home, task_ids, reason, env, descriptor)
                return {**result, "taskIds": task_ids}
            finally:
                os.close(descriptor)
        finally:
            if token:
                CLI.leave_maintenance(home, token)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="标记用户已核实的已关闭任务 / Acknowledge a verified closed task"
    )
    parser.add_argument("task_id", nargs="*")
    parser.add_argument(
        "--list", action="store_true", help="只列出含未知结果的终态任务，不修改数据"
    )
    parser.add_argument("--reason", default="用户已核实浏览器中没有残留标签页或操作")
    parser.add_argument(
        "--stop-daemon",
        action="store_true",
        help="进入维护模式并停止已核实的 daemon；完成后删除维护标记",
    )
    parser.add_argument("--hermes-home", default=None)
    args = parser.parse_args(argv)
    if not args.reason.strip() or len(args.reason) > 500:
        parser.error("--reason 不能为空且不超过 500 字")
    try:
        candidates = (
            [args.hermes_home]
            if args.hermes_home
            else [
                os.environ.get("HERMES_HOME"),
                *(str(Path.home() / name) for name in (".fast-browser-link", ".hermes")),
            ]
        )
        homes = list(dict.fromkeys(shared_home(value) for value in candidates if value))
        if args.list:
            found = []
            for home in homes:
                if not (home / "plugin-data/fast-browser-link-native").is_dir():
                    continue
                for task in CLI.load_task_records(home)["tasks"]:
                    if not isinstance(task, dict) or task.get("state") not in {
                        "closed",
                        "cancelled",
                        "failed",
                    }:
                        continue
                    rows = (
                        [task.get("currentOperation")]
                        + task.get("requestHistory", [])
                        + task.get("operationTimeline", [])
                    )
                    if task.get("workOutcomeUnknown") or any(
                        isinstance(row, dict) and row.get("state") == "unknown" for row in rows
                    ):
                        found.append(
                            {
                                "home": str(home),
                                "taskId": task.get("id"),
                                "state": task.get("state"),
                                "verified": isinstance(task.get("userVerified"), dict),
                            }
                        )
            print(
                json.dumps(
                    {
                        "tasks": found,
                        "instruction": "先逐项核实站点结果及浏览器残留，再运行 npm run tasks:ack -- TASK_ID --reason '核实依据'；daemon 必须停稳。",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if not args.task_id:
            parser.error("请提供任务 ID，或用 --list 查看未知结果任务")
        located = {}
        for home in homes:
            if not (home / "plugin-data/fast-browser-link-native").is_dir():
                continue
            ids = {
                row.get("id")
                for row in CLI.load_task_records(home)["tasks"]
                if isinstance(row, dict)
            }
            for task_id in args.task_id:
                if task_id in ids:
                    located.setdefault(task_id, []).append(home)
        if any(len(located.get(task_id, [])) != 1 for task_id in args.task_id):
            raise InstallError(
                "任务 ID 未找到或属于多个数据目录。", "显式传 --hermes-home 指定正确运行时。"
            )
        grouped = {}
        for task_id in args.task_id:
            grouped.setdefault(located[task_id][0], []).append(task_id)
        result = [
            acknowledge(home, ids, args.reason.strip(), os.environ, stop_daemon=args.stop_daemon)
            for home, ids in grouped.items()
        ]
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
