#!/usr/bin/env python3
"""中文注释：从一个已提交版本导出已审阅的公开源码，不携带 Git 历史或本机文件。"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

# 中文注释：品牌图片按当前 SVG 生成器的逐字重建回归核对；仅允许这些路径的固定摘要，不能替换成任意图片。
REVIEWED_BRANDING = {
    "docs/assets/readme-banner.png": "da846881754337cfa977515c69beccce5b01c115184382e9eadb6e2e32ce8316",
    "native-extension/icon-128.png": "5e3f7d47f684f74e60a2e0a812294c1b76b66b6e5dcbad166e2295696707e47b",
    "native-extension/icon-16.png": "c97e8c96f4bb66b5856da25e4feda7dbdc9788320200260c93b5485b24ac11b9",
    "native-extension/icon-32.png": "3683e5e78f61d5e849eca5de06160d3a923396aa555de5fd7e8b012c8d78de79",
    "native-extension/icon-48.png": "0832c24ba12ea569c14f4d9f01bb325ead279c21ac5acf4edf7bfd5c7874f4f8",
}


def export_source(source, revision, output):
    source = Path(source).resolve()
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output must not exist")
    commit = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "--verify", revision + "^{commit}"], text=True
    ).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid source commit")
    entries = subprocess.check_output(
        ["git", "-C", str(source), "ls-tree", "-rz", "--full-tree", commit]
    ).split(b"\0")
    manifest = {}
    output.mkdir(parents=True)
    process = subprocess.Popen(
        ["git", "-C", str(source), "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    try:
        for entry in entries:
            if not entry:
                continue
            header, raw_name = entry.split(b"\t", 1)
            mode, kind, oid = header.decode().split()
            name = raw_name.decode("utf-8")
            parts = Path(name).parts
            if (
                kind != "blob"
                or mode not in {"100644", "100755"}
                or ".." in parts
                or name.startswith("/")
                or any(
                    part
                    in {
                        ".git",
                        ".ci",
                        "node_modules",
                        "artifacts",
                        "evidence",
                        "logs",
                        "profiles",
                        "__pycache__",
                    }
                    for part in parts
                )
                or any(part.startswith(".env") for part in parts)
                or name == ".dev-sync.local.json"
                or Path(name).suffix.lower()
                in {".pem", ".key", ".db", ".sqlite", ".sqlite3", ".har", ".zip"}
            ):
                raise ValueError("Unreviewed public path: " + name)
            process.stdin.write((oid + "\n").encode())
            process.stdin.flush()
            found = process.stdout.readline().decode().split()
            if len(found) != 3 or found[1] != "blob":
                raise ValueError("Cannot read tracked blob: " + name)
            data = process.stdout.read(int(found[2]))
            process.stdout.read(1)
            # 中文注释：品牌路径的内容必须匹配固定摘要，未知或被替换的二进制继续拒绝。
            fixture_image = name in {
                "bench/site/assets/logo.png",
                "bench/site/assets/screenshot.png",
            }
            branding_image = name in REVIEWED_BRANDING
            if branding_image and hashlib.sha256(data).hexdigest() != REVIEWED_BRANDING[name]:
                raise ValueError("Reviewed branding digest changed: " + name)
            if b"\0" in data and not (fixture_image or branding_image):
                raise ValueError("Binary content requires review: " + name)
            if not (fixture_image or branding_image):
                data.decode("utf-8")
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
            manifest[name] = hashlib.sha256(data).hexdigest()
    except BaseException:
        shutil.rmtree(output)
        raise
    finally:
        process.stdin.close()
        process.stdout.close()
        process.wait()
    return {
        "sourceCommit": commit,
        "files": len(manifest),
        "gitHistoryIncluded": False,
        "contentSha256": hashlib.sha256(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(export_source(args.source, args.ref, args.output), indent=2))
