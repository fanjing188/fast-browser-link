"""运行时更新保留本地技能；默认更新仍验证技能归属。"""

import json
import unittest
import test_r15 as fixtures
from fbl_update import update, plan
from fbl_cli import parser


class PreserveSkillsUpdate(unittest.TestCase):
    setUpClass = fixtures.R15.__dict__["setUpClass"]
    tearDownClass = fixtures.R15.__dict__["tearDownClass"]
    setUp = fixtures.R15.setUp
    tearDown = fixtures.R15.tearDown
    install = fixtures.R15.install

    def test_runtime_update_preserves_custom_skill_and_default_still_refuses(self):
        self.install()
        skill = self.user / ".agents/skills/fast-browser-link"
        skill.mkdir(parents=True)
        source = skill / "SKILL.md"
        source.write_text("CUSTOM_USER_SKILL")
        with self.assertRaisesRegex(ValueError, "skill modified or ownership unknown"):
            update(self.ctx, self.release)
        self.assertEqual(source.read_text(), "CUSTOM_USER_SKILL")
        preview = update(self.ctx, self.release, dry_run=True, preserve_skills=True)
        self.assertTrue(preview["preserve_skills"])
        self.assertNotIn(str(skill), preview["targets"])
        result = update(self.ctx, self.release, preserve_skills=True)
        self.assertEqual(result["status"], "updated")
        self.assertEqual(source.read_text(), "CUSTOM_USER_SKILL")
        self.assertFalse((self.ctx.data / "host-bin/old-fixture").exists())
        self.assertEqual(
            json.loads((self.runtime / "extension/manifest.json").read_text())["version"],
            json.loads((fixtures.ROOT / "package.json").read_text())["version"],
        )
        self.assertIn(str(skill), plan(self.ctx, self.release)["targets"])

    def test_cli_accepts_explicit_scope(self):
        self.assertTrue(
            parser().parse_args(["update", "--preserve-skills", "--dry-run"]).preserve_skills
        )

    def test_runtime_only_update_preserves_marked_profile_files(self):
        self.install()
        fixtures.repair(self.hermes, "fast-copilot", fixtures.private_write, "fixture-model")
        profile = self.hermes / "profiles/fast-copilot"
        config = profile / "config.yaml"
        value = json.loads(config.read_text())
        value["reasoning_effort"] = "high"
        config.write_text(json.dumps(value, indent=4))
        paths = [config, profile / ".copilot-profile.json"]
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in paths]
        result = update(self.ctx, self.release, preserve_skills=True)
        self.assertEqual(result["status"], "updated")
        self.assertEqual([(p.read_bytes(), p.stat().st_mtime_ns) for p in paths], before)

    def test_preview_lists_profile_migration_only_for_full_update(self):
        self.install()
        fixtures.repair(self.hermes, "fast-copilot", fixtures.private_write, "fixture-model")
        profile = self.hermes / "profiles/fast-copilot"
        full = plan(self.ctx, self.release)["targets"]
        runtime_only = plan(self.ctx, self.release, preserve_skills=True)["targets"]
        for name in ("config.yaml", ".copilot-profile.json"):
            self.assertIn(str(profile / name), full)
            self.assertNotIn(str(profile / name), runtime_only)


if __name__ == "__main__":
    unittest.main()
