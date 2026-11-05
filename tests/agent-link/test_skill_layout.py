"""验证主技能镜像、安装参考资料和脚本签名。"""

import ast
from pathlib import Path
import re
import shutil
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "skills/fast-browser-link"
MIRROR = ROOT / "executor-plugin/skills/fast-browser-link"
FILES = (
    "SKILL.md",
    "references/helpers.md",
    "references/boundaries.md",
    "references/troubleshoot.md",
    "references/batch-scrape.md",
)


def sync():
    # 中文注释：只同步本技能的固定文件，保留其他已有文件。
    for relative in FILES:
        target = MIRROR / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / relative, target)


class SkillLayoutTest(unittest.TestCase):
    def test_mirror_and_local_references(self):
        for relative in FILES:
            with self.subTest(file=relative):
                self.assertEqual((SOURCE / relative).read_bytes(), (MIRROR / relative).read_bytes())
        main = (SOURCE / "SKILL.md").read_text()
        self.assertLessEqual(len(main.encode()), 5120)
        for reference in re.findall(r"\]\((references/[^)]+)\)", main):
            self.assertTrue((SOURCE / reference).is_file(), reference)
            self.assertTrue((MIRROR / reference).is_file(), reference)
        self.assertIn("不需要询问用户", main)
        self.assertIn("不要改用 computer_use", main)

    def test_every_script_helper_signature_matches_runtime(self):
        tree = ast.parse((ROOT / "native-bridge/script_lane/child.py").read_text())
        functions = {
            node.name: node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        assignment = next(
            node
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "HELPERS" for t in node.targets)
        )
        names = {
            item.value
            for item in assignment.value.generators[0].iter.elts
            if isinstance(item, ast.Constant)
        }
        names -= {"BrowserError", "ApprovalRequired", "UserInputRequired"}
        table = (SOURCE / "references/helpers.md").read_text()
        signatures = re.findall(r"^\| `([^`]+)` \|", table, re.M)
        parsed = {}
        for signature in signatures:
            node = ast.parse("def " + signature + ":\n    pass\n").body[0]
            self.assertNotIn(node.name, parsed)
            parsed[node.name] = ast.dump(node.args, include_attributes=False)
        self.assertEqual(set(parsed), names)
        for name in sorted(names):
            with self.subTest(helper=name):
                self.assertEqual(
                    parsed[name], ast.dump(functions[name].args, include_attributes=False)
                )


if __name__ == "__main__":
    if sys.argv[1:] == ["--sync"]:
        sync()
    else:
        unittest.main()
