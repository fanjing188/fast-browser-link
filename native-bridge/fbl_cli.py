#!/usr/bin/env python3
"""fbl：标准库 CLI；安装、升级、诊断与发现共用同一运行时定位。"""

import argparse
import hashlib
import json
import math
import re
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from fbl_runtime import (
    Context,
    HERE,
    HOST,
    ORIGIN,
    agent_roots,
    doctor,
    load,
    read,
    safe,
)
from fbl_runtime import private_write
from fbl_update import update, verify_source, tree_digest


def launcher(ctx):
    target = safe(ctx.user / ".local/bin/fbl")
    marker = ctx.data / "fbl-launcher.json"
    text = (
        "#!"
        + sys.executable
        + '\nimport os,runpy,sys\nos.environ["FAST_BROWSER_LINK_HOME"]='
        + repr(str(ctx.runtime))
        + "\nsys.path.insert(0,"
        + repr(str(ctx.data / "host-bin"))
        + ")\nfrom fbl_cli import main\nraise SystemExit(main())\n"
    )
    previous = read(marker)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != previous.get(
        "sha256"
    ):
        raise ValueError("existing fbl command not managed; preserved")
    private_write(target, text)
    target.chmod(0o700)
    private_write(marker, json.dumps({"sha256": hashlib.sha256(text.encode()).hexdigest()}))
    return str(target)


def install_core(ctx):
    payload = verify_source(ctx.source)
    from fbl_runtime import manifests
    from fbl_update import _copy

    targets = [ctx.runtime, *manifests(ctx.user)]
    for target in targets:
        safe(target)
        if target.exists():
            raise ValueError("installation target exists; use fbl update or review manifest")
    ctx.user.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fbl-setup-", dir=ctx.user) as temporary:
        root = Path(temporary)
        stage = root / "runtime"
        user = root / "user"
        user.mkdir()
        installer = load("fbl_initial_native", payload["native"] / "install.py")
        installer.stage(user, [ORIGIN], runtime_home=stage)
        host = stage / "plugin-data/fast-browser-link-native/host-bin" / HOST
        host.write_text(host.read_text().replace(str(stage), str(ctx.runtime)))
        _copy(payload["extension"], stage / "extension")
        link = ctx.source / "agent-link"
        if not link.is_dir():
            link = payload["adapter"] / "agent_link"
        (stage / "runtime").mkdir()
        _copy(link, stage / "runtime/agent-link")
        (stage / "runtime/native-bridge").symlink_to(
            ctx.data / "host-bin", target_is_directory=True
        )
        private_write(
            stage / "installation.json",
            json.dumps(
                {
                    "version": 1,
                    "runtime": str(ctx.runtime),
                    "extension": str(ctx.runtime / "extension"),
                    "skills": [],
                }
            ),
        )
        prepared = [(stage, ctx.runtime)]
        for source, target in zip(manifests(user), manifests(ctx.user)):
            value = read(source)
            value["path"] = str(ctx.data / "host-bin" / HOST)
            private_write(source, json.dumps(value))
            prepared.append((source, target))
        created = []
        try:
            for source, target in prepared:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    raise ValueError("installation target appeared")
                os.replace(source, target)
                created.append(target)
        except BaseException:
            for target in reversed(created):
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            raise
    return payload


def install_skills(ctx, selected, profiles=(), preserved=None):
    source = (ctx.source / "skills/fast-browser-link") if ctx.source else None
    if not source or not source.is_dir():
        source = ctx.data / "host-bin/fbl-assets/core-skill"
    if not source.is_dir():
        raise ValueError("core skill payload missing")
    installed = []
    roots = agent_roots(ctx, profiles)
    for row in roots:
        if row["agent"] not in selected:
            continue
        target = safe(Path(row["path"]) / "fast-browser-link")
        if target.exists():
            record = read(target / ".fbl-skill.json")
            if tree_digest(target) == record.get("sha256"):
                continue
            history = read(assets(ctx) / "skill-history.json", {})
            if tree_digest(target) not in history.get(target.name, []):
                if preserved is not None:
                    preserved.append(
                        {
                            "path": str(target),
                            "status": "preserved_unmanaged",
                            "message": "保留未接管",
                        }
                    )
                continue
            # 中文注释：已知历史技能的首次接管只写归属摘要，程序升级仍由 update 事务处理。
            private_write(
                target / ".fbl-skill.json",
                json.dumps({"version": 1, "sha256": tree_digest(target)}),
            )
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
        private_write(
            target / ".fbl-skill.json", json.dumps({"version": 1, "sha256": tree_digest(target)})
        )
        installed.append(str(target))
    return installed


def setup(
    ctx,
    *,
    yes=False,
    dry_run=False,
    seo=None,
    urls=(),
    scan_tabs=False,
    agent_profiles=(),
    input_fn=input,
):
    agents = agent_roots(ctx, agent_profiles)
    selected = list(dict.fromkeys(row["agent"] for row in agents if row["detected"]))
    if dry_run:
        return {
            "status": "dry_run",
            "runtime": str(ctx.runtime),
            "agents": selected,
            "commands": ["fbl setup --yes", "fbl doctor", "fbl update --dry-run"],
            "profiles": "only dedicated managed profiles; no credentials copied",
        }
    if not (ctx.data / "host-bin").is_dir():
        install_core(ctx)
    elif not (ctx.data / "host-bin/fbl_cli.py").is_file():
        if not ctx.source:
            raise ValueError(
                "legacy runtime needs a complete release; run python3 -B -m fbl setup from that release"
            )
        update(ctx, ctx.source)
    preserved = []
    command_path = launcher(ctx)
    installed = install_skills(ctx, selected, agent_profiles, preserved)
    return {
        "status": "configured",
        "command": command_path,
        "skills": installed,
        "preserved_skills": preserved,
        "readiness": doctor(ctx),
    }


def logs(ctx, *, follow=False, kind=None, errors=False, bundle=None):
    # 核心诊断仅含固定枚举、时间和不透明身份；不读取旧协作日志或 stderr 正文。
    diagnostics_source = HERE.parent / "browser-diagnostics" / "python"
    if diagnostics_source.is_dir():
        sys.path.insert(0, str(diagnostics_source))
    from browser_diagnostics import JsonlDiagnosticSink

    root = ctx.data / "diagnostics"
    if not root.is_dir():
        if not bundle:
            return {"entries": 0}
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    sink = JsonlDiagnosticSink(root, max_bytes=1048576, max_files=5)
    if bundle:
        target = safe(Path(bundle))
        if target.suffix != ".zip":
            raise ValueError("diagnostic bundle must be a .zip file")
        result = sink.export_bundle(target.parent, target.name)
        return {"bundle": str(result), "page_content_included": False}
    groups = {
        "system": {"task_state", "connection_state", "extension_request", "sink_state"},
        "execution": {"request_state", "action_state"},
        "capture": {"buffer_state"},
    }
    seen = set()
    while True:
        for row in sink.read_validated_events()[-2000:]:
            if kind and row.get("event_type") not in groups[kind]:
                continue
            if errors and row.get("status") not in {"failed", "unknown"}:
                continue
            key = json.dumps(row, sort_keys=True)
            if key not in seen:
                print(json.dumps(row, ensure_ascii=False))
                seen.add(key)
        if not follow:
            return {"entries": len(seen)}
        if len(seen) > 4000:
            seen = set(list(seen)[-2000:])
        time.sleep(0.5)


def parser():
    p = argparse.ArgumentParser(
        prog="fbl",
        description="Core browser tools for any Agent via Skills, CLI or MCP.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    def common(s):
        for key in ("user-home", "hermes-home", "runtime", "source"):
            s.add_argument("--" + key, type=Path)

    for name in ("setup", "update", "doctor", "logs", "browser", "mcp"):
        s = sub.add_parser(name)
        common(s)
        if name == "setup":
            s.add_argument(
                "--agent-profile",
                action="append",
                default=[],
                help="Explicit Hermes profile for the agent skill",
            )
            s.add_argument("--yes", action="store_true")
            s.add_argument("--dry-run", action="store_true")
        elif name == "update":
            s.add_argument(
                "--preserve-skills",
                action="store_true",
                help="Preserve installed agent skills; update runtime and browser extension only",
            )
            s.add_argument("--yes", action="store_true")
            s.add_argument("--dry-run", action="store_true")
            s.add_argument("--wait", type=float, default=0)
            s.add_argument("--pause-hermes", action="store_true")
        elif name == "doctor":
            s.add_argument("--fix", action="store_true")
        elif name == "logs":
            s.add_argument("--follow", action="store_true")
            s.add_argument(
                "--type", choices=["system", "execution", "capture"]
            )
            s.add_argument("--errors", action="store_true")
            s.add_argument("--bundle", nargs="?", const="fbl-diagnostics.zip")
        elif name == "mcp":
            s.add_argument("action", choices=["install"])
            s.add_argument("--agent", choices=["codex", "claude"], required=True)
            mode = s.add_mutually_exclusive_group()
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--apply", action="store_true")
        elif name == "browser":
            s.add_argument("--session")
            s.add_argument("operation")
            s.add_argument("params", nargs="?", default="{}")
    return p


def confirm_update(prompt):
    if not sys.stdin.isatty():
        return False
    print(prompt, end="", file=sys.stderr, flush=True)
    return input().strip().lower() in {"y", "yes"}


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        ctx = Context.locate(args.user_home, args.hermes_home, args.runtime, args.source)
        if ctx.source is None:
            ctx.source = next(
                (
                    path
                    for path in (HERE.parent, HERE.parent.parent)
                    if (path / "SHA256SUMS.json").is_file()
                ),
                None,
            )
        if args.command == "setup":
            result = setup(
                ctx,
                yes=args.yes,
                dry_run=args.dry_run,
                agent_profiles=args.agent_profile,
            )
        elif args.command == "update":
            if not args.source:
                if args.dry_run:
                    from fbl_update import preview
                    from fbl_update import plan

                    result = preview(ctx, plan(ctx, preserve_skills=args.preserve_skills))
                else:
                    from fbl_update import fetch_update

                    result = fetch_update(
                        ctx,
                        wait=args.wait,
                        pause_hermes=args.pause_hermes,
                        yes=args.yes,
                        confirm=confirm_update,
                        preserve_skills=args.preserve_skills,
                    )
            else:
                result = update(
                    ctx,
                    args.source,
                    dry_run=args.dry_run,
                    wait=args.wait,
                    pause_hermes=args.pause_hermes,
                    yes=args.yes,
                    confirm=confirm_update,
                    preserve_skills=args.preserve_skills,
                )
        elif args.command == "doctor":
            result = doctor(ctx, fix=args.fix, deep=True, start=args.fix)
        elif args.command == "logs":
            result = logs(
                ctx, follow=args.follow, kind=args.type, errors=args.errors, bundle=args.bundle
            )
        elif args.command == "mcp":
            from fbl_mcp import install

            result = install(ctx, args.agent, apply=args.apply, dry_run=args.dry_run)
        else:
            from fbl_browser import browser_call

            result = browser_call(
                ctx,
                args.operation,
                json.loads(sys.stdin.read() if args.params == "-" else args.params),
                args.session,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except Exception as error:
        if args.command != "update" and not isinstance(
            error, (ValueError, OSError, RuntimeError, subprocess.SubprocessError)
        ):
            raise
        from fbl_redact import redact

        if args.command == "update":
            # 中文注释：任一升级拒绝都给机器可读结果；逐字段脱敏，避免整段 JSON 被截断或丢失换行。
            def cleaned(value, field=None):
                if field in {"status", "reason", "group"}:
                    return value
                if isinstance(value, str):
                    return "\n".join(redact(line) for line in value.splitlines())
                if isinstance(value, list):
                    return [cleaned(item) for item in value]
                if isinstance(value, dict):
                    return {key: cleaned(item, key) for key, item in value.items()}
                return value

            detail = str(error) + ("\n" + error.fix if getattr(error, "fix", None) else "")
            result = cleaned(
                {
                    "status": "refused",
                    "reason": getattr(
                        error,
                        "reason",
                        "validation_failed" if isinstance(error, ValueError) else "update_failed",
                    ),
                    "blocking": getattr(
                        error,
                        "blocking",
                        [
                            {
                                "title": "升级前置条件或事务验证",
                                "group": "update",
                                "reason": type(error).__name__,
                                "message": detail,
                            }
                        ],
                    ),
                    "message": detail,
                    "backup": getattr(error, "backup", None),
                    "rolled_back": getattr(error, "rolled_back", False),
                    "warnings": getattr(error, "notes", []),
                }
            )
            # 中文注释：恢复命令只拼接本 CLI 与调用方已给出的路径/选项，不使用任务标题等不可信文本。
            retry = [sys.executable, "-B", str(Path(__file__).resolve()), "update"]
            for key in ("user_home", "hermes_home", "runtime", "source"):
                value = getattr(args, key)
                if value is not None:
                    retry.extend(["--" + key.replace("_", "-"), str(value.expanduser().resolve())])
            if args.wait:
                retry.extend(["--wait", str(args.wait)])
            if args.pause_hermes:
                retry.append("--pause-hermes")
            if args.preserve_skills:
                retry.append("--preserve-skills")
            if args.yes or result["reason"] == "confirmation_required":
                retry.append("--yes")
            result["retry_command"] = shlex.join(retry)
            result["preview_command"] = shlex.join([*retry, "--dry-run"])
            print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
            print(result["message"], file=sys.stderr)
            print("复查命令：" + result["preview_command"], file=sys.stderr)
            return 1
        if str(error).startswith("active or unsettled"):
            print("\n".join(redact(line) for line in str(error).splitlines()), file=sys.stderr)
            return 1
        print(
            json.dumps(
                {
                    "error": type(error).__name__,
                    "message": redact(str(error)),
                    "backup": getattr(error, "backup", None),
                    "rolled_back": getattr(error, "rolled_back", False),
                    "warnings": getattr(error, "notes", []),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
