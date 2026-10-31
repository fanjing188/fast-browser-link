"""Complete synthetic package/source fixtures for negative install controls."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def _write_tree(root: Path, files: dict[str, bytes]) -> None:
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def write_installer_package(root: Path, *, include_api_client: bool = True) -> Path:
    """Create the installer's real required layout and exact SHA256SUMS."""
    # 使用当前桥接候选包布局构造离线安装夹具。
    files: dict[str, bytes] = {
        "fast-browser-link/plugin.yaml": b"name: fast-browser-link\nversion: 1.3.0\n",
        "fast-browser-link/__init__.py": b'"""Fixture plugin."""\n',
        "fast-browser-link/runtime.py": b"# runtime fixture\n",
        "fast-browser-link/native_tools.py": b"# tools fixture\n",
        # 中文注释：合成包必须包含自动更新的维护闭包。
        "fast-browser-link/maintenance/update.py": b"# updater fixture\n",
        "fast-browser-link/maintenance/install-cli.py": b"# install fixture\n",
        "fast-browser-link/maintenance/install-executor.py": b"# verifier fixture\n",
        "fast-browser-link/open_tool.py": b"# open tool fixture\n",
        "fast-browser-link/skills/fast-browser-link/SKILL.md": b"# browser skill fixture\n",
        "fast-browser-link/task_diagnostics.py": b"# diagnostics projection fixture\n",
        "fast-browser-link/native_bridge/script_lane/host_bridge.py": b"# host bridge fixture\n",
        "fast-browser-link/native_bridge/script_lane/action_session.py": b"# action session fixture\n",
        "fast-browser-link/native_bridge/script_lane/child.py": b"# script child fixture\n",
        "fast-browser-link/native_bridge/script_lane/tool.py": b"# script tool fixture\n",
        "fast-browser-link/native_bridge/script_lane/page-request.js": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/script_lane/page_export.py": b"# export fixture\n",
        "fast-browser-link/native_bridge/script_lane/page_export.js": b"// export fixture\n",
        "fast-browser-link/native_bridge/site_tools/tools.py": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/site_tools/store.py": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/browser_sdk.py": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/fbl_scripts.py": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/host.py": b"# host fixture\n",
        "fast-browser-link/native_bridge/client.py": b"# client fixture\n",
        "fast-browser-link/native_bridge/daemon.py": b"# daemon fixture\n",
        "fast-browser-link/native_bridge/core_adapter.py": b"# product bootstrap fixture\n",
        "fast-browser-link/native_bridge/product_adapter.py": b"# product runtime fixture\n",
        "fast-browser-link/native_bridge/browser_diagnostics/__init__.py": b"# diagnostics fixture\n",
        "fast-browser-link/native_bridge/browser_diagnostics/schema.py": b"# schema fixture\n",
        "fast-browser-link/native_bridge/browser_diagnostics/runtime.py": b"# runtime fixture\n",
        "fast-browser-link/native_bridge/browser_diagnostics/sink.py": b"# sink fixture\n",
        "native-extension/manifest.json": json.dumps(
            {
                "manifest_version": 3,
                "background": {"service_worker": "background.mjs"},
            }
        ).encode()
        + b"\n",
        "native-extension/background.mjs": b"// background fixture\n",
        "docs/python-scripting.md": b"# python scripting fixture\n",
        "docs/CHANGELOG.md": b"# changelog fixture\n",
        "LICENSE": b"fixture license\n",
        "README.md": b"# fixture\n",
        "INSTALL.txt": b"fixture install instructions\n",
        "RELEASE-STATUS.txt": b"NOT FROZEN; not a formal release.\n",
        "install-executor.py": b"# fixture installer\n",
        "install-cli.py": b"# install entry\n",
        "install.sh": b"#!/bin/bash\n",
    }
    if include_api_client:
        files["fast-browser-link/native_bridge/api_client.py"] = b"# api client fixture\n"
    _write_tree(root, files)
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    (root / "SHA256SUMS.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return root


def write_packager_source(root: Path, *, include_api_client: bool = False) -> Path:
    """Create all packager preflight inputs, leaving only the requested omission."""
    files = {
        # 中文注释：合成源树也遵守完整版本闭包，负例只破坏被测文件。
        "package.json": b'{"version":"1.3.0"}\n',
        "package-lock.json": b'{"version":"1.3.0","packages":{"":{"version":"1.3.0"}}}\n',
        "executor-plugin/dashboard/manifest.json": b'{"version":"1.3.0"}\n',
        "native-bridge/cookie_mirror.py": b"# cookie mirror fixture\n",
        "native-extension/cookie-mirror.mjs": b"// cookie mirror fixture\n",
        "native-bridge/client.py": b"# client\n",
        "native-bridge/daemon.py": b"# daemon\n",
        "native-bridge/host.py": b"# host\n",
        "native-extension/manifest.json": b'{"manifest_version":3,"version":"1.3.0"}\n',
        "native-extension/build.mjs": b"// build entry fixture\n",
        "native-extension/background.mjs": "// 中文注释：版本握手夹具。\nconst hello={version:chrome.runtime.getManifest().version};const popup={version:chrome.runtime.getManifest().version};\n".encode(),
        "executor-plugin/plugin.yaml": b"name: fast-browser-link\nversion: 1.3.0\n",
        "executor-plugin/__init__.py": b'"""Plugin fixture."""\n',
        "executor-plugin/open_tool.py": b"# open tool\n",
        "executor-plugin/skills/fast-browser-link/SKILL.md": b"# browser skill\n",
        "native-bridge/script_lane/host_bridge.py": b"# host bridge\n",
        "native-bridge/script_lane/action_session.py": b"# action session\n",
        "native-bridge/script_lane/child.py": b"# script child\n",
        "native-bridge/script_lane/tool.py": b"# script tool\n",
        "native-bridge/script_lane/page-request.js": b"# runtime fixture\n",
        "native-bridge/script_lane/page_export.py": b"# export fixture\n",
        "native-bridge/script_lane/page_export.js": b"// export fixture\n",
        "native-bridge/site_tools/tools.py": b"# runtime fixture\n",
        "native-bridge/site_tools/store.py": b"# runtime fixture\n",
        "native-bridge/browser_sdk.py": b"# runtime fixture\n",
        "native-bridge/core_adapter.py": b"# product bootstrap fixture\n",
        "native-bridge/product_adapter.py": b"# product runtime fixture\n",
        "native-extension/product-fill.mjs": b"// product fill fixture\n",
        "native-extension/product-fill-content.mjs": b"// product content fixture\n",
        "native-extension/product-connections.mjs": b"// product connections fixture\n",
        "native-extension/product-connections-page.mjs": b"// product page fixture\n",
        "native-extension/product-connections.html": b"<!doctype html>\n",
        "native-extension/product-connections.css": b"/* product page fixture */\n",
        "native-bridge/fbl_scripts.py": b"# runtime fixture\n",
        "executor-plugin/single_tool_adapter/integration.py": b"# overrides\n",
        "executor-plugin/single_tool_adapter/adapter.py": b"# adapter\n",
        "LICENSE": b"fixture license\n",
        "page-semantics/index.js": b"// semantics\n",
        "browser-files/index.mjs": b"// browser files\n",
        "browser-files/adapters.mjs": b"// adapters\n",
        "browser-interactions/index.mjs": b"// interactions\n",
        "approval-policy/policy.mjs": b"// policy\n",
        "browser-workspaces/index.mjs": b"// workspaces\n",
        "browser-diagnostics/js/diagnostics.mjs": b"// diagnostics js\n",
        "browser-diagnostics/python/browser_diagnostics/__init__.py": b"# package\n",
        "browser-diagnostics/python/browser_diagnostics/schema.py": b"# schema\n",
        "browser-diagnostics/python/browser_diagnostics/runtime.py": b"# runtime\n",
        "browser-diagnostics/python/browser_diagnostics/sink.py": b"# sink\n",
        "CHANGELOG.md": b"# Changelog\n",
        "docs/python-scripting.md": b"# Python scripting\n",
        "docs/installation.md": b"# Installation\n",
    }
    if include_api_client:
        files["native-bridge/api_client.py"] = b"# api client\n"
    _write_tree(root, files)
    return root
