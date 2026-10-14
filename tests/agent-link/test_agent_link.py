import importlib.util
import io
import base64
import hashlib
import sys
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

agent = load('agent_link', 'agent-link/fast_browser_link.py')
installer = load('agent_install', 'scripts/install-agent.py')

class AgentTests(unittest.TestCase):
    def test_owners_are_isolated_and_cannot_be_forged(self):
        client = Mock()
        first, second = agent.Browser(client=client), agent.Browser(client=client)
        self.assertNotEqual(first.owner, second.owner)
        first.call('get', {'taskId': 't'})
        client.call.assert_called_once_with('shared.get', {'taskId': 't', 'owner': first.owner})
        with self.assertRaises(ValueError): first.call('get', {'owner': 'other'})

    def test_incognito_create_is_forwarded_with_trusted_owner(self):
        client = Mock()
        browser = agent.Browser(client=client)
        params = {'title': 'private', 'instanceId': 'edge', 'allowedOrigins': ['https://example.com'], 'incognito': True}
        browser.call('create', params)
        client.call.assert_called_once_with('shared.create', {**params, 'owner': browser.owner})
        self.assertNotIn('owner', params)

    def test_download_operations_keep_task_identity(self):
        client = Mock(); browser = agent.Browser(client=client)
        for operation in ('downloads', 'download_claim', 'download_cancel'):
            args = {'taskId': 'task'}
            if operation != 'downloads': args['downloadId'] = 'download'
            browser.call(operation, args)
            client.call.assert_called_with('shared.' + operation, {**args, 'owner': browser.owner})

    def test_close_with_keep_tabs_uses_existing_handoff_contract(self):
        client = Mock(); browser = agent.Browser(client=client)
        args = {'taskId': 'task', 'keepTabs': True, 'handoffReason': 'user_requested'}
        browser.call('close', args)
        client.call.assert_called_once_with('shared.handoff', {**args, 'owner': browser.owner})

    def test_write_is_never_retried_after_lost_response(self):
        client = Mock(); client.call.side_effect = agent.bridge.BridgeError('outcome_unknown', 'lost')
        with self.assertRaises(agent.bridge.BridgeError):
            agent.Browser(client=client).call('run', {'taskId': 't', 'action': 'click'})
        self.assertEqual(client.call.call_count, 1)
        self.assertTrue(client.call.call_args.args[1]['requestId'])

    def test_mcp_handshake_tools_and_errors(self):
        client = Mock(); client.call.return_value = {'ok': True}
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'fast_browser_link', 'arguments': {'operation': 'health'}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'unknown'},
        ]
        output = io.StringIO()
        agent.serve(agent.Browser(client=client), io.StringIO('\n'.join(map(json.dumps, requests))), output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(replies), 4)
        self.assertIn('tools', replies[0]['result']['capabilities'])
        self.assertEqual(replies[1]['result']['tools'][0]['name'], 'fast_browser_link')
        self.assertEqual(json.loads(replies[2]['result']['content'][0]['text']), {'ok': True})
        self.assertEqual(replies[3]['error']['code'], -32601)

    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve() / 'home'
            result = installer.install(home, ['generic'], dry_run=True)
            self.assertFalse(home.exists())
            self.assertEqual(result['extensionStatus'], 'requires_browser_confirmation')

    def test_existing_skill_is_preserved_before_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve(); target = home / '.agents/skills/fast-browser-link'
            target.mkdir(parents=True); (target / 'user.txt').write_text('keep')
            with patch.object(installer.subprocess, 'run') as build:
                with self.assertRaises(ValueError): installer.install(home, ['generic'])
                build.assert_not_called()
            self.assertEqual((target / 'user.txt').read_text(), 'keep')
            self.assertFalse((home / '.fast-browser-link').exists())

    def test_reject_symlink_even_on_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve(); (home / '.fast-browser-link').symlink_to(home / 'elsewhere')
            with self.assertRaises(ValueError): installer.install(home, ['generic'], dry_run=True)

    def test_install_failure_rolls_back_native_registration_and_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            original = installer.shutil.copytree
            def copy(source, destination, *args, **kwargs):
                if Path(source) == ROOT / 'skills/fast-browser-link':
                    raise OSError('simulated disk error')
                return original(source, destination, *args, **kwargs)
            with patch.object(installer.shutil, 'copytree', side_effect=copy), patch.object(installer.sys, 'platform', 'darwin'):
                with self.assertRaisesRegex(OSError, 'simulated'):
                    installer.install(home, ['generic'], open_browser=False)
            self.assertFalse((home / '.fast-browser-link').exists())
            self.assertFalse((home / '.agents/skills/fast-browser-link').exists())
            self.assertFalse(list(home.rglob('com.fast.browser_link.json')))

    def test_new_extension_identity_and_install_preserve_legacy_hermes_files(self):
        manifest = json.loads((ROOT / 'native-extension/manifest.json').read_text())
        digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
        identity = ''.join(chr(97 + int(char, 16)) for char in digest)
        self.assertNotEqual(identity, 'dhioigkigkkhceflkkkmoljhdaefjohb')
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            legacy = [home / '.hermes/config.yaml', home / '.hermes/plugins/browser-link/plugin.yaml',
                      home / '.hermes/plugin-data/browser-link-native/tasks.json',
                      *[home / 'Library/Application Support' / browser / 'NativeMessagingHosts/com.hermes.browser_link.json'
                        for browser in ('Google/Chrome', 'Microsoft Edge')]]
            for path in legacy:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'legacy user content')
            before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in legacy}
            with patch.object(installer.sys, 'platform', 'darwin'):
                installer.install(home, ['hermes', 'generic'], open_browser=False)
            self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in legacy})
            for browser in ('Google/Chrome', 'Microsoft Edge'):
                host = home / 'Library/Application Support' / browser / 'NativeMessagingHosts/com.fast.browser_link.json'
                self.assertEqual(json.loads(host.read_text())['allowed_origins'], [f'chrome-extension://{identity}/'])

    def test_bundle_tampering_fails_before_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp).resolve()
            (package / 'extension').mkdir()
            (package / 'extension/manifest.json').write_text('{}')
            (package / 'SHA256SUMS.json').write_text('{}')
            with patch.object(installer, 'ROOT', package):
                with self.assertRaisesRegex(ValueError, 'SHA256SUMS'):
                    installer.verify_bundle()

if __name__ == '__main__': unittest.main()
