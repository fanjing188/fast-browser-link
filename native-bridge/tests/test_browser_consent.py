"""Browser UI may install an empty new-tab-only task, never API credentials."""
import unittest
from pathlib import Path
import tempfile
from daemon import BridgeDaemon, ProtocolError


class BrowserConsentTests(unittest.TestCase):
    def test_incognito_creation_checks_browser_permission_before_persistence(self):
        with tempfile.TemporaryDirectory() as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            params = {'owner': 'owner', 'title': 'private', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test'], 'incognito': True}
            calls = []
            def check(extension, method, payload, **options):
                calls.append((method, payload))
                return {'allowed': False}
            daemon._extension_call = check
            with self.assertRaises(ProtocolError) as error:
                daemon._create_task(params)
            self.assertEqual(error.exception.code, 'incognito_access_required')
            self.assertEqual(daemon.tasks, {})
            self.assertEqual(calls, [('extension.incognito_status', {})])
            daemon._extension_call = lambda *args, **kwargs: {'allowed': True}
            task = daemon._create_task(params)
            self.assertTrue(task['incognito'])
            self.assertEqual(task['isolation'], 'incognito-profile')
            for invalid in ('true', 1, None):
                with self.assertRaises(ProtocolError):
                    daemon._create_task({**params, 'incognito': invalid})

    def test_workspace_only_approval_is_generation_bound_and_api_denied(self):
        scratch = Path.home() / '.hermes/cache/scratch'
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            daemon = BridgeDaemon(Path(directory))
            daemon._persist_tasks = lambda: None
            daemon._notify_tasks_changed = lambda _: None
            daemon.extensions['browser'] = {'browser': 'chrome'}
            task = daemon._create_task({'owner': 'owner', 'title': 'new', 'instanceId': 'browser', 'allowedOrigins': ['https://example.test']})
            params = {'taskId': task['id'], 'generation': task['generation'], 'tabIds': [], 'allowedOrigins': task['allowedOrigins'], 'workspaceOnly': True}
            for change in ({'generation': 999}, {'generation': None}, {'apiBridgeApproved': True}, {'tabIds': [1]}, {'allowedOrigins': ['https://other.test']}):
                with self.assertRaises(ProtocolError):
                    daemon._dispatch_extension('browser', 'extension.approve', {**params, **change})
            with self.assertRaises(ProtocolError):
                daemon._dispatch_client('extension.approve', params)
            with self.assertRaises(ProtocolError):
                daemon._dispatch_extension('browser', 'extension.stop', {'taskId': task['id'], 'generation': 999})
            ready = daemon._dispatch_extension('browser', 'extension.approve', params)
            self.assertEqual(ready['state'], 'authorizing')
            with self.assertRaises(ProtocolError):
                daemon._run_task({'owner': 'owner', 'taskId': task['id'], 'action': 'tabs', 'requestId': 'early'})
            ready = daemon._dispatch_extension('browser', 'extension.mode', {'taskId': task['id'], 'generation': ready['generation'], 'modeGeneration': ready['modeGeneration'], 'mode': 'full'})
            self.assertEqual(ready['state'], 'ready')
            self.assertEqual(ready['activeMode'], 'full')
            self.assertEqual(ready['tabIds'], [])
            self.assertNotIn('apiBridgeApproved', ready)
            self.assertEqual(daemon.tab_leases, {})

if __name__ == '__main__':
    unittest.main()
