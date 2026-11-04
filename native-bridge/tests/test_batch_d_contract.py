"""任务批次 D 的资源上限回执。"""

import sys
import socket
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from daemon import BridgeDaemon, ProtocolError  # noqa: E402
from cdp_gateway import CdpGateway, MAX_CONNECTIONS_PER_GRANT  # noqa: E402


class BatchDContractTests(unittest.TestCase):
    def test_cdp_capacity_returns_explicit_plugin_response(self):
        gateway = CdpGateway(lambda *_: {}, lambda grant: grant, lambda *_: {})
        gateway._grants["fixture"] = {"token": "fixture"}
        gateway._connections["fixture"] = [object() for _ in range(MAX_CONNECTIONS_PER_GRANT)]
        server, client = socket.socketpair()
        self.addCleanup(client.close)
        client.settimeout(1)
        client.sendall(
            b"GET /devtools/browser/fixture HTTP/1.1\r\n"
            b"Upgrade: websocket\r\nSec-WebSocket-Key: fixture\r\n\r\n"
        )
        gateway._handshake(server)
        response = client.recv(4096)
        self.assertIn(b"429 Too Many Requests", response)
        self.assertIn(b'"category":"plugin"', response)
        self.assertIn(b'"code":"cdp_capacity"', response)

    def test_extension_capacity_is_plugin_error_before_dispatch(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as home:
            daemon = BridgeDaemon(Path(home))
            extension = {
                "pendingLock": threading.Lock(),
                "pending": {str(i): None for i in range(128)},
            }
            with self.assertRaises(ProtocolError) as raised:
                daemon._extension_call(extension, "browser.execute", {}, timeout=0.01)
            error = raised.exception
            self.assertEqual(error.code, "too_many_pending")
            self.assertEqual(error.data["category"], "plugin")
            self.assertTrue(error.data["retryable"])
            self.assertFalse(error.data["outcomeUnknown"])
            self.assertEqual(len(extension["pending"]), 128)


if __name__ == "__main__":
    unittest.main()
