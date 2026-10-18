"""运行时更新保留本地技能；默认更新仍验证技能归属。"""
import json
import unittest
import test_r15 as fixtures
from fbl_update import update, plan
from fbl_cli import parser


class PreserveSkillsUpdate(unittest.TestCase):
    setUpClass = fixtures.R15.__dict__['setUpClass']
    tearDownClass = fixtures.R15.__dict__['tearDownClass']
    setUp = fixtures.R15.setUp
    tearDown = fixtures.R15.tearDown
    install = fixtures.R15.install

    def test_runtime_update_preserves_custom_skill_and_default_still_refuses(self):
        self.install()
        skill=self.user/'.agents/skills/fast-browser-link';skill.mkdir(parents=True)
        source=skill/'SKILL.md';source.write_text('CUSTOM_USER_SKILL')
        with self.assertRaisesRegex(ValueError,'skill modified or ownership unknown'):
            update(self.ctx,self.release)
        self.assertEqual(source.read_text(),'CUSTOM_USER_SKILL')
        preview=update(self.ctx,self.release,dry_run=True,preserve_skills=True)
        self.assertTrue(preview['preserve_skills']);self.assertNotIn(str(skill),preview['targets'])
        result=update(self.ctx,self.release,preserve_skills=True)
        self.assertEqual(result['status'],'updated');self.assertEqual(source.read_text(),'CUSTOM_USER_SKILL')
        self.assertFalse((self.ctx.data/'host-bin/old-fixture').exists())
        self.assertEqual(json.loads((self.runtime/'extension/manifest.json').read_text())['version'],'2.2.0')
        self.assertIn(str(skill),plan(self.ctx,self.release)['targets'])

    def test_cli_accepts_explicit_scope(self):
        self.assertTrue(parser().parse_args(['update','--preserve-skills','--dry-run']).preserve_skills)


if __name__=='__main__':unittest.main()
