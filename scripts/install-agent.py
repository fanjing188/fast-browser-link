#!/usr/bin/env python3
"""无需 Hermes 的 Fast-browser-link 安装入口。"""

from __future__ import annotations
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
AGENTS = {
    "codex": ".codex/skills",
    "claude": ".claude/skills",
    "cursor": ".cursor/skills",
    "copilot": ".copilot/skills",
    "gemini": ".gemini/skills",
    "hermes": ".hermes/skills",
    "generic": ".agents/skills",
}


def verify_bundle():
    manifest = ROOT / "SHA256SUMS.json"
    if not (ROOT / "extension").exists():
        return
    if not manifest.is_file():
        raise ValueError("安装包缺少 SHA256SUMS.json")
    expected = json.loads(manifest.read_text())
    if not isinstance(expected, dict):
        raise ValueError("安装包校验清单无效")
    actual = {}
    for path in ROOT.rglob("*"):
        if path.is_symlink():
            raise ValueError("安装包不能包含符号链接")
        if path.is_file() and path != manifest:
            actual[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("安装包文件与 SHA256SUMS.json 不一致")


def install(user_home, agents, *, dry_run=False, open_browser=True, upgrade=False):
    if upgrade:
        sys.path.insert(0, str(ROOT / "native-bridge"))
        from fbl_runtime import Context
        from fbl_update import update, plan

        ctx = Context.locate(user_home, source=ROOT)
        if dry_run:
            return plan(ctx)
        if (ROOT / "SHA256SUMS.json").is_file():
            return update(ctx, ROOT)
        with tempfile.TemporaryDirectory(prefix="fbl-upgrade-package-") as temporary:
            package = Path(temporary) / "release"
            subprocess.run(
                [sys.executable, str(ROOT / "scripts/package-agent.py"), "--output", str(package)],
                check=True,
            )
            return update(ctx, package)
    if dry_run:
        return _install(user_home, agents, dry_run=True, open_browser=open_browser)
    home = user_home.expanduser().absolute()
    if home.is_symlink():
        raise ValueError("安装根目录不能是符号链接")
    home.mkdir(parents=True, exist_ok=True)
    lock = home / ".fast-browser-link-install.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        return _install(home, agents, open_browser=open_browser)
    finally:
        os.close(fd)


def _install(user_home, agents, *, dry_run=False, open_browser=True):
    home = user_home.expanduser().absolute()
    runtime_home = home / ".fast-browser-link"
    targets = [home / AGENTS[name] / "fast-browser-link" for name in agents]
    manifests = [
        home
        / "Library/Application Support"
        / browser
        / "NativeMessagingHosts/com.fast.browser_link.json"
        for browser in ("Google/Chrome", "Microsoft Edge")
    ]
    paths = [runtime_home, *targets, *manifests]
    for target in paths:
        if any(p.is_symlink() for p in (target, *target.parents)):
            raise ValueError("安装路径不能包含符号链接")
    plan = {
        "runtime": str(runtime_home),
        "skills": list(map(str, targets)),
        "extension": str(runtime_home / "extension"),
        "extensionStatus": "requires_browser_confirmation",
    }
    if dry_run:
        return plan
    if sys.platform != "darwin":
        raise ValueError("当前 Native Messaging 安装支持 macOS Chrome/Edge；其他平台尚未验证")
    verify_bundle()
    if any(target.exists() for target in paths):
        raise ValueError("已有安装或同名技能，未覆盖；请保留现有安装并核对安装目录")
    # 中文注释：先构建到临时目录，失败不触碰已安装环境。
    with tempfile.TemporaryDirectory(prefix="fast-browser-install-") as tmp:
        staging = Path(tmp)
        if (ROOT / "extension/manifest.json").is_file():
            shutil.copytree(ROOT / "extension", staging / "extension")
        else:
            subprocess.run(
                ["node", str(ROOT / "native-extension/build.mjs"), str(staging / "extension")],
                check=True,
                stdout=sys.stderr,
            )
        shutil.copytree(
            ROOT / "agent-link",
            staging / "runtime/agent-link",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        spec = importlib.util.spec_from_file_location(
            "fast_native_installer", ROOT / "native-bridge/install.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        created_parents = []
        for target in paths:
            parent = target.parent
            while not parent.exists():
                if parent not in created_parents:
                    created_parents.append(parent)
                parent = parent.parent
        try:
            runtime_home.mkdir(mode=0o700, parents=True)
            for name in ("runtime", "extension"):
                shutil.copytree(staging / name, runtime_home / name)
            module.stage(
                home,
                ["chrome-extension://hhnljehnkmhhgjjjmnlhilfpcjhobloc/"],
                runtime_home=runtime_home,
            )
            # 中文注释：CLI 与 Native host 使用同一完整运行时，避免缺少诊断模块或启动两种 daemon。
            (runtime_home / "runtime/native-bridge").symlink_to(
                runtime_home / "plugin-data/fast-browser-link-native/host-bin",
                target_is_directory=True,
            )
            for target in targets:
                shutil.copytree(ROOT / "skills/fast-browser-link", target)
                sys.path.insert(0, str(ROOT / "native-bridge"))
                try:
                    from fbl_update import tree_digest

                    (target / ".fbl-skill.json").write_text(
                        json.dumps({"version": 1, "sha256": tree_digest(target)})
                    )
                finally:
                    sys.path.pop(0)
            plan["mcp"] = {
                "command": sys.executable,
                "args": [str(runtime_home / "runtime/agent-link/fast_browser_link.py"), "--mcp"],
            }
            (runtime_home / "installation.json").write_text(
                json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
            )
        except Exception:
            # 中文注释：只删除本次新建的目标；预检保证不覆盖既有安装。
            for target in reversed(paths):
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.exists():
                    target.unlink()
            for parent in sorted(created_parents, key=lambda p: len(p.parts), reverse=True):
                try:
                    parent.rmdir()
                except OSError:
                    pass
            raise
    if open_browser and home.resolve() == Path.home().resolve():
        subprocess.run(["open", str(runtime_home / "extension")], check=False)
        subprocess.run(["open", "-a", "Google Chrome", "chrome://extensions"], check=False)
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="append", choices=[*AGENTS, "all"])
    parser.add_argument("--user-home", type=Path, default=Path.home())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--upgrade", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    agents = args.agent or [
        name for name, directory in AGENTS.items() if (args.user_home / directory).parent.is_dir()
    ]
    agents = list(AGENTS) if "all" in agents else list(dict.fromkeys([*agents, "generic"]))
    try:
        result = install(
            args.user_home,
            agents,
            dry_run=args.dry_run,
            open_browser=not args.no_open,
            upgrade=args.upgrade,
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"安装失败：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.dry_run:
        print(
            "请在扩展管理页开启开发者模式，加载 extension 目录，并在扩展中启用连接。浏览器确认前不算安装完成。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
