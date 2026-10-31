#!/usr/bin/env python3
"""生成不依赖 Hermes 和 Node.js 的本地安装包。"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package(output, release=None):
    version = json.loads((ROOT / "package.json").read_text())["version"]
    commit = None
    if release is not None:
        if release != version:
            raise ValueError("发布版本必须与 package.json 一致")
        subprocess.run(["node", str(ROOT / "scripts/package-version.mjs")], check=True)
        if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
            raise ValueError("正式包必须从干净、已提交的源码构建")
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    output = output.expanduser().absolute()
    if output.exists():
        raise ValueError("输出目录已存在，不覆盖")
    with tempfile.TemporaryDirectory(prefix="fast-package-") as tmp:
        staged = Path(tmp) / "fast-browser-link"
        staged.mkdir()
        subprocess.run(
            ["node", str(ROOT / "native-extension/build.mjs"), str(staged / "extension")],
            check=True,
        )
        for name in ("native-bridge", "agent-link", "skills", "browser-diagnostics/python"):
            shutil.copytree(
                ROOT / name,
                staged / name,
                ignore=shutil.ignore_patterns("__pycache__", "tests", "*.pyc"),
            )
        for name in (
            "fbl.py",
            "install.sh",
            "scripts/install-agent.py",
            "executor-plugin/task_diagnostics.py",
            "LICENSE",
            "docs/agent-integration.md",
        ):
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        # 中文注释：可选 Hermes 适配器已在构建时预打包，安装/更新现场不需要 Node。
        subprocess.run(
            [
                "node",
                str(ROOT / "scripts/package-executor.mjs"),
                "--output",
                str(staged / "adapter"),
                *(["--release", release] if release else []),
            ],
            check=True,
        )
        for name in (
            "install-cli.py",
            "install-executor.py",
        ):
            target = staged / "scripts" / name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(ROOT / "scripts" / name, target)
        shutil.copyfile(
            ROOT / "executor-plugin/maintenance/update.py", staged / "scripts/update.py"
        )
        (staged / "RELEASE.json").write_text(
            json.dumps(
                {
                    "project": "fast-browser-link",
                    "version": version,
                    "sourceCommit": commit,
                    "mode": "independent-skills",
                    "status": "release" if release else "local_candidate",
                },
                indent=2,
            )
            + "\n"
        )
        if release is not None:
            tracked = set(
                subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
            )
            for item in staged.rglob("*"):
                if not item.is_file():
                    continue
                relative = item.relative_to(staged).as_posix()
                if relative == "RELEASE.json" or relative.startswith(("extension/", "adapter/")):
                    continue
                if relative == "scripts/update.py":
                    relative = "executor-plugin/maintenance/update.py"
                if relative not in tracked or (ROOT / relative).is_symlink():
                    raise ValueError("正式包包含未跟踪或链接输入: " + relative)
        files = {
            str(p.relative_to(staged)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(staged.rglob("*"))
            if p.is_file()
        }
        (staged / "SHA256SUMS.json").write_text(json.dumps(files, indent=2) + "\n")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, output)
    return {
        "output": str(output),
        "files": len(files),
        "status": "release" if release else "local_candidate",
        "sourceCommit": commit,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/fast-browser-link-agent")
    parser.add_argument("--release", help="正式发布版本，要求已提交且干净的源码")
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.release)))
