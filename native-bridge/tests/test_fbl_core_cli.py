"""The core CLI reads only allowlisted browser diagnostics after Assist extraction."""

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

NATIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NATIVE))
sys.path.insert(0, str(NATIVE.parent / "browser-diagnostics/python"))
from browser_diagnostics import JsonlDiagnosticSink
from browser_diagnostics.schema import make_event
from fbl_cli import logs
from fbl_runtime import Context


class CoreLogTests(unittest.TestCase):
    def test_execution_view_and_bundle_exclude_legacy_assist_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            context = Context(root / "user", root / "hermes", root / "runtime")
            context.data.mkdir(parents=True)
            sink = JsonlDiagnosticSink(context.data / "diagnostics")
            sink.write(
                make_event(
                    component="native_bridge",
                    event_type="action_state",
                    status="failed",
                    action="ref_click",
                    error_code="TIMEOUT",
                )
            )
            old = context.data / "copilot/logs"
            old.mkdir(parents=True)
            (old / "old.events.jsonl").write_text("SECRET_CANARY")
            output = StringIO()
            with redirect_stdout(output):
                result = logs(context, kind="execution", errors=True)
            self.assertEqual(result["entries"], 1)
            row = json.loads(output.getvalue())
            self.assertEqual(row["error_code"], "TIMEOUT")
            self.assertNotIn("SECRET_CANARY", output.getvalue())
            archive = root / "diagnostics.zip"
            self.assertEqual(logs(context, bundle=archive)["bundle"], str(archive))
            with ZipFile(archive) as package:
                self.assertIn("events.jsonl", package.namelist())
                self.assertNotIn(b"SECRET_CANARY", package.read("events.jsonl"))


if __name__ == "__main__":
    unittest.main()
