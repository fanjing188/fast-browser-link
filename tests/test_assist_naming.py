"""扫描用户可见文案；内部标识仅按用途显式放行。"""

import ast
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
OLD_NAMES = re.compile(
    r"\bCopilot\b|copilot mode|[Ff]ast-copilot|Hermes协作|Hermes 协作|协作看板|协作模式"
)
# 中文注释：每项只放行确切文本，不豁免整个文件或整个代码块。
ALLOWLIST = (
    (
        "native-extension/copilot-controls.mjs",
        re.compile(r"^  '(?:Hermes协作看板|Hermes 协作看板|Hermes Copilot|Agent协作看板)',$"),
        "识别旧默认名称以显示新的本地化默认值，不作为文案输出",
    ),
    (
        "native-bridge/daemon.py",
        re.compile(r"^Hermes 协作·$"),
        "移除已有工作页的旧标题前缀，兼容旧任务",
    ),
    (
        "docs/agent-integration.md",
        re.compile(r"GitHub Copilot"),
        "第三方 Agent 的产品本名，与 Assist 功能无关",
    ),
    (
        "docs/*.md",
        re.compile(r"`fast-copilot`"),
        "文档明确说明未改名的 Hermes profile 内部标识",
    ),
    (
        "README*.md",
        re.compile(r"`fast-copilot`"),
        "安装说明中的 Hermes profile 内部标识",
    ),
    (
        "native-bridge/*.py",
        re.compile(r"fast-copilot"),
        "Python 字符串中的 Hermes profile ID 或路径，配置和协议保持不变",
    ),
    (
        "scripts/*.py",
        re.compile(r"fast-copilot"),
        "安装和诊断脚本使用的 Hermes profile ID，保留现有安装合同",
    ),
    (
        "native-bridge/copilot-config.example.json",
        re.compile(r"fast-copilot"),
        "示例中的 Hermes profile 名，不更改配置字段或值",
    ),
)


def tracked():
    # 中文注释：扫描已跟踪及未忽略的新文件；被忽略的本机构建产物会随重新构建更新。
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout.decode()
    return {ROOT / name for name in listing.split("\0") if name}


def sources():
    files = tracked()
    for path in _sources():
        if path in files:
            yield path


def _sources():
    yield ROOT / "package.json"
    yield ROOT / "CHANGELOG.md"
    yield from ROOT.glob("README*.md")
    yield from ROOT.glob("*.sh")
    for directory in ("native-extension", "docs", "scripts"):
        for path in sorted((ROOT / directory).rglob("*")):
            if "growth" not in path.relative_to(ROOT).parts and path.suffix in {
                ".md",
                ".html",
                ".mjs",
                ".js",
                ".json",
                ".sh",
            }:
                yield path
    yield ROOT / "native-bridge/copilot-config.example.json"
    for directory in ("native-bridge", "scripts"):
        for path in sorted((ROOT / directory).glob("*.py")):
            yield path


def copy_strings(path):
    source = path.read_text()
    if path.suffix == ".py":
        # 中文注释：AST 只检查字符串，避免把 Copilot 类名和导入当成界面文案。
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                yield node.lineno, node.value
    else:
        yield from enumerate(source.splitlines(), 1)


def violations(label, value):
    for pattern, allowed, _reason in ALLOWLIST:
        if Path(label).match(pattern):
            value = allowed.sub("", value)
    return [match.group() for match in OLD_NAMES.finditer(value)]


class AssistNamingTests(unittest.TestCase):
    def test_visible_copy_uses_assist(self):
        errors = []
        for path in sources():
            label = path.relative_to(ROOT).as_posix()
            for line, value in copy_strings(path):
                if found := violations(label, value):
                    errors.append(f"{label}:{line}: {', '.join(found)}")
        self.assertEqual(errors, [], "\n".join(errors))

    def test_allowlist_does_not_hide_unrelated_copy(self):
        for pattern, allowed, reason in ALLOWLIST:
            self.assertTrue(reason, pattern)
            self.assertFalse(allowed.search("Start Copilot mode"), pattern)
        for label in (
            "README.md",
            "docs/new.md",
            "native-extension/new.mjs",
            "native-bridge/fbl_cli.py",
        ):
            for value in (
                "Copilot",
                "copilot mode",
                "Fast-copilot",
                "Hermes协作中",
                "Hermes 协作中",
                "协作看板",
                "协作模式",
            ):
                self.assertTrue(violations(label, value), (label, value))
        self.assertTrue(violations("docs/new.md", "`fast-copilot` enables Copilot"))
        self.assertTrue(violations("native-extension/new.mjs", "'Hermes Copilot'"))


if __name__ == "__main__":
    unittest.main()
