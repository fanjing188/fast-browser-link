"""Agent 引导只使用临时文件、模拟安装器和 ACP 替身；不下载、安装或调用真实模型。"""

from contextlib import contextmanager
import io
import builtins
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot import Copilot
from copilot_agents import (
    Agents,
    INSTALL_URL,
    InstallerRedirect,
    SetupError,
    configured,
    install_engine,
    setup,
)
from fbl_profiles import repair
from fbl_runtime import Context, private_write


class AgentSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.ctx = Context(self.root / "user", self.root / "hermes", self.root / "runtime")
        self.ctx.copilot.mkdir(parents=True)
        self.payload = self.root / "adapter"
        self.payload.mkdir()
        (self.payload / "plugin.yaml").write_text("name: fast-browser-link\n")

    def tearDown(self):
        self.temporary.cleanup()

    @contextmanager
    def adapter(self, *_):
        yield self.payload

    def test_fresh_setup_uses_only_hermes_skills_managed_profiles_and_initialize(self):
        self.ctx.hermes.mkdir()
        default = self.ctx.hermes / "config.yaml"
        default.write_text("model: original-global-model\n")
        auth = self.ctx.hermes / "auth.json"
        auth.write_text("SYNTHETIC_UNREAD_AUTH")
        phases = []
        runtime = Mock()
        runtime.prompt.side_effect = AssertionError("no model prompt allowed")
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch(
                "fbl_runtime.available_models",
                return_value={"availableModels": [{"modelId": "test:mini"}]},
            ),
            patch("copilot_agents.adapter_source", self.adapter),
            patch("fbl_cli.install_skills", return_value=[]) as skills,
            patch("copilot_acp.ACP", return_value=runtime) as acp,
        ):
            result = setup(self.ctx, {}, phases.append)
        self.assertEqual(phases, ["detect", "profiles", "integration", "connection", "complete"])
        self.assertEqual(default.read_text(), "model: original-global-model\n")
        self.assertEqual(auth.read_text(), "SYNTHETIC_UNREAD_AUTH")
        self.assertTrue(
            (self.ctx.hermes / "profiles/fast-copilot/plugins/fast-browser-link").is_symlink()
        )
        for profile in ("fast-copilot",):
            self.assertEqual(
                json.loads((self.ctx.hermes / "profiles" / profile / "config.yaml").read_text())[
                    "model"
                ],
                {"default": "mini", "provider": "test"},
            )
        self.assertFalse((self.ctx.hermes / "profiles/copilot-exec").exists())
        skills.assert_called_once_with(self.ctx, ["hermes"])
        self.assertEqual(acp.call_count, 1)
        self.assertEqual(runtime.start.call_args_list, [unittest.mock.call(initialize_only=True)])
        self.assertEqual(runtime.close.call_count, 1)
        runtime.prompt.assert_not_called()
        self.assertEqual(result["connection"]["check"], "acp_initialize")
        self.assertFalse(result["connection"]["model_call"])
        self.assertFalse(configured(self.ctx, {}))
        self.assertTrue(configured(self.ctx, {"agent_onboarded": True}))

    def test_owned_legacy_configuration_seeds_one_profile_without_copying_credentials(self):
        legacy = self.ctx.hermes / "profiles/copilot"
        legacy.mkdir(parents=True)
        original = {
            "model": {"default": "existing", "provider": "original"},
            "_config_version": 99,
            "custom": {"keep": True},
            "platform_toolsets": {"acp": ["terminal"]},
        }
        (legacy / "config.yaml").write_text(json.dumps(original))
        (legacy / ".copilot-profile.json").write_text(
            json.dumps({"version": 3, "files": {"config.yaml": "owned"}})
        )
        (legacy / "auth.json").write_text("SYNTHETIC_PRIVATE")
        (legacy / "history").write_text("SYNTHETIC_HISTORY")
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch(
                "fbl_runtime.available_models",
                return_value={"availableModels": [{"modelId": "new:mini"}]},
            ),
            patch("copilot_agents.adapter_source", self.adapter),
            patch("fbl_cli.install_skills"),
            patch("copilot_acp.ACP"),
        ):
            setup(self.ctx, {})
        target = self.ctx.hermes / "profiles/fast-copilot"
        merged = json.loads((target / "config.yaml").read_text())
        self.assertEqual(merged["model"], original["model"])
        self.assertEqual(merged["_config_version"], 99)
        self.assertEqual(merged["custom"], original["custom"])
        self.assertEqual(merged["platform_toolsets"], {"acp": [], "cli": []})
        self.assertEqual(merged["agent"]["max_turns"], 1)
        self.assertFalse((target / "auth.json").exists())
        self.assertFalse((target / "history").exists())
        self.assertEqual(json.loads((legacy / "config.yaml").read_text()), original)
        self.assertEqual((legacy / "history").read_text(), "SYNTHETIC_HISTORY")
        self.assertFalse((self.ctx.hermes / "profiles/copilot-exec").exists())
        self.assertTrue(configured(self.ctx, {"agent_onboarded": True}))

    def test_existing_managed_model_provider_and_unknown_profile_are_preserved(self):
        for profile in ("fast-copilot",):
            repair(self.ctx.hermes, profile, private_write, "existing-model", "existing-provider")
        unrelated = self.ctx.hermes / "profiles/my-work/config.yaml"
        unrelated.parent.mkdir()
        unrelated.write_text("PRIVATE_PROFILE_SENTINEL")
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch(
                "fbl_runtime.available_models",
                return_value={"availableModels": [{"modelId": "new:mini"}]},
            ),
            patch("copilot_agents.adapter_source", self.adapter),
            patch("fbl_cli.install_skills"),
            patch("copilot_acp.ACP"),
        ):
            setup(self.ctx, {})
        self.assertEqual(unrelated.read_text(), "PRIVATE_PROFILE_SENTINEL")
        for profile in ("fast-copilot",):
            self.assertEqual(
                json.loads((self.ctx.hermes / "profiles" / profile / "config.yaml").read_text())[
                    "model"
                ],
                {"default": "existing-model", "provider": "existing-provider"},
            )

    def test_unknown_dedicated_profile_rejected_before_install_or_metadata_call(self):
        target = self.ctx.hermes / "profiles/fast-copilot/config.yaml"
        target.parent.mkdir(parents=True)
        target.write_text("UNKNOWN_PROFILE")
        with (
            patch("copilot_agents.install_engine") as engine,
            patch("fbl_runtime.available_models") as models,
        ):
            with self.assertRaises(SetupError) as caught:
                setup(self.ctx, {})
            self.assertEqual(caught.exception.code, "profile_unmanaged")
            engine.assert_not_called()
            models.assert_not_called()
        self.assertEqual(target.read_text(), "UNKNOWN_PROFILE")

    def test_no_model_metadata_needs_user_auth_configuration_and_does_not_write_profiles(self):
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch("fbl_runtime.available_models", return_value={}),
            patch("copilot_acp.ACP") as acp,
        ):
            with self.assertRaises(SetupError) as caught:
                setup(self.ctx, {})
            self.assertEqual(caught.exception.code, "auth_required")
            acp.assert_not_called()
        self.assertFalse((self.ctx.hermes / "profiles").exists())

    def test_connection_failure_closes_probe(self):
        runtime = Mock()
        runtime.start.side_effect = RuntimeError("PRIVATE_ERROR")
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch(
                "fbl_runtime.available_models",
                return_value={"availableModels": [{"modelId": "test:mini"}]},
            ),
            patch("copilot_agents.adapter_source", self.adapter),
            patch("fbl_cli.install_skills"),
            patch("copilot_acp.ACP", return_value=runtime),
        ):
            with self.assertRaises(SetupError) as caught:
                setup(self.ctx, {})
            self.assertEqual(caught.exception.code, "connection_failed")
            runtime.close.assert_called_once()

    def test_profile_drift_and_symlinks_require_setup_again(self):
        for profile in ("fast-copilot",):
            repair(self.ctx.hermes, profile, private_write, "existing", "test")
        shared = self.ctx.hermes / "plugins/fast-browser-link"
        shared.mkdir(parents=True)
        (shared / "plugin.yaml").write_text("name: existing\n")
        binding = self.ctx.hermes / "profiles/fast-copilot/plugins/fast-browser-link"
        binding.parent.mkdir()
        binding.symlink_to(shared, target_is_directory=True)
        self.assertTrue(configured(self.ctx, {"agent_onboarded": True}))
        path = self.ctx.hermes / "profiles/fast-copilot/config.yaml"
        value = json.loads(path.read_text())
        value["platform_toolsets"]["acp"] = ["terminal"]
        path.write_text(json.dumps(value))
        self.assertFalse(configured(self.ctx, {"agent_onboarded": True}))
        repair(self.ctx.hermes, "fast-copilot", private_write)
        self.assertTrue(configured(self.ctx, {"agent_onboarded": True}))
        path.unlink()
        path.symlink_to(self.root / "outside")
        self.assertFalse(configured(self.ctx, {"agent_onboarded": True}))

    def test_read_only_detection_never_spawns_yaml_helper(self):
        root = self.ctx.hermes / "profiles/fast-copilot"
        root.mkdir(parents=True)
        (root / "config.yaml").write_text("model: synthetic\n")
        (root / ".copilot-profile.json").write_text(
            json.dumps({"version": 3, "files": {"config.yaml": "synthetic"}})
        )
        original = builtins.__import__

        def import_without_yaml(name, *args, **kwargs):
            if name == "yaml":
                raise ImportError("synthetic unavailable YAML reader")
            return original(name, *args, **kwargs)

        with (
            patch("builtins.__import__", side_effect=import_without_yaml),
            patch(
                "fbl_profiles.subprocess.run",
                side_effect=AssertionError("catalog must not spawn YAML helper"),
            ),
        ):
            self.assertFalse(configured(self.ctx, {"agent_onboarded": True}))

    def test_existing_engine_or_root_configuration_never_runs_installer(self):
        for name in ("hermes-agent", "config.yaml", "auth.json", ".env", "active_profile"):
            with self.subTest(name=name):
                self.ctx.hermes.mkdir(exist_ok=True)
                target = self.ctx.hermes / name
                target.write_text("PRIVATE_EXISTING")
                with (
                    patch("copilot_agents.urllib.request.build_opener") as opener,
                    patch("copilot_agents.subprocess.Popen") as run,
                ):
                    with self.assertRaises(SetupError) as caught:
                        install_engine(self.ctx)
                    self.assertEqual(
                        caught.exception.code, "engine_existing_configuration_requires_manual"
                    )
                    opener.assert_not_called()
                    run.assert_not_called()
                self.assertEqual(target.read_text(), "PRIVATE_EXISTING")
                target.unlink()

    def test_configuration_symlink_never_runs_installer(self):
        self.ctx.hermes.mkdir()
        (self.ctx.hermes / "auth.json").symlink_to(self.root / "missing")
        with patch("copilot_agents.urllib.request.build_opener") as opener:
            with self.assertRaises(SetupError) as caught:
                install_engine(self.ctx)
            self.assertEqual(caught.exception.code, "engine_existing_configuration_requires_manual")
            opener.assert_not_called()

    def test_installer_fixed_url_argv_environment_and_private_temporary_script(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"#!/bin/bash\n# synthetic installer; never executed\n"
        opener = Mock()
        opener.open.return_value = response

        def inspect(argv, **kwargs):
            self.assertEqual(argv[0], "/bin/bash")
            script = Path(argv[1])
            self.assertEqual(script.read_bytes(), response.read.return_value)
            self.assertEqual(script.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                argv[2:],
                [
                    "--non-interactive",
                    "--channel",
                    "stable",
                    "--skip-browser",
                    "--skip-computer-use",
                    "--hermes-home",
                    str(self.ctx.hermes),
                    "--dir",
                    str(self.ctx.hermes / "hermes-agent"),
                ],
            )
            self.assertNotIn("shell", kwargs)
            self.assertEqual(kwargs["env"]["HOME"], os.environ["HOME"])
            self.assertNotIn("HERMES_INSTALL_CHANNEL", kwargs["env"])
            self.assertNotIn("HERMES_REPO_URL", kwargs["env"])
            self.assertTrue(kwargs["start_new_session"])
            self.script = script
            process = Mock(returncode=0)
            process.wait.return_value = 0
            process.poll.return_value = 0
            self.installer = process
            return process

        with (
            patch("copilot_agents.urllib.request.build_opener", return_value=opener),
            patch("copilot_agents.subprocess.Popen", side_effect=inspect) as run,
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch.dict(
                os.environ,
                {
                    "HERMES_INSTALL_CHANNEL": "PRIVATE_BAD",
                    "HERMES_REPO_URL": "https://invalid.test",
                },
            ),
        ):
            install_engine(self.ctx)
        self.assertEqual(opener.open.call_args.args[0].full_url, INSTALL_URL)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 30)
        response.read.assert_called_once_with(2 * 1024 * 1024 + 1)
        run.assert_called_once()
        self.installer.wait.assert_called_once_with(timeout=180)
        self.assertFalse(self.script.exists())

    def test_oversized_installer_and_unavailable_binary_do_not_claim_installed(self):
        for payload, binary in [
            (b"x" * (2 * 1024 * 1024 + 1), "/fixture/hermes"),
            (b"fixture", None),
        ]:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = payload
            opener = Mock()
            opener.open.return_value = response
            process = Mock(returncode=0)
            process.wait.return_value = 0
            process.poll.return_value = 0
            with (
                patch("copilot_agents.urllib.request.build_opener", return_value=opener),
                patch("copilot_agents.command", return_value=binary),
                patch("copilot_agents.subprocess.Popen", return_value=process),
            ):
                with self.assertRaises(SetupError) as caught:
                    install_engine(self.ctx)
                self.assertEqual(caught.exception.code, "engine_install_failed")

    def test_installer_timeout_and_cancellation_reap_own_process_group(self):
        for error in (subprocess.TimeoutExpired("fixture", 180), SystemExit(130)):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = b"synthetic installer"
            opener = Mock()
            opener.open.return_value = response
            process = Mock(pid=234568, returncode=None)
            process.poll.return_value = None
            process.wait.side_effect = [error, 0]
            with (
                patch("copilot_agents.urllib.request.build_opener", return_value=opener),
                patch("copilot_agents.subprocess.Popen", return_value=process),
                patch("copilot_agents.os.killpg") as kill,
            ):
                with self.assertRaises(type(error)):
                    install_engine(self.ctx)
                kill.assert_called_once_with(process.pid, signal.SIGTERM)
                self.assertEqual(
                    process.wait.call_args_list,
                    [unittest.mock.call(timeout=180), unittest.mock.call(timeout=2)],
                )

    def test_installer_redirects_reject_external_origins_and_parameters(self):
        handler = InstallerRedirect()
        for url in (
            "http://hermes-agent.nousresearch.com/install.sh",
            "https://evil.test/install.sh",
            "https://hermes-agent.nousresearch.com/other.sh",
            "https://hermes-agent.nousresearch.com/install.sh?repo=bad",
            "https://user" + "@" + "hermes-agent.nousresearch.com/install.sh",
        ):
            with self.subTest(url=url), self.assertRaises(SetupError):
                handler.redirect_request(None, None, 302, "", {}, url)


class AgentManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / "runtime/plugin-data/fast-browser-link-native/copilot"
        private_write(
            self.directory / "config.json",
            json.dumps(
                {"fbl_user_home": str(self.root / "user"), "hermes_home": str(self.root / "hermes")}
            ),
        )
        self.app = Copilot(self.directory)

    def tearDown(self):
        self.app.close()
        self.temporary.cleanup()

    def outcome(self, value):
        process = Mock(pid=234567, returncode=0)
        process.poll.return_value = 0
        process.stdout = io.StringIO(json.dumps(value) + "\n")
        with patch("copilot_agents.subprocess.Popen", return_value=process) as launch:
            job = self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})
            self.app.agents.jobs[job["id"]]["thread"].join(timeout=2)
            self.assertFalse(self.app.agents.jobs[job["id"]]["thread"].is_alive())
            result = self.app.request("one", "agent_setup_status", {"id": job["id"]})
        return result, process, launch

    def test_catalog_is_read_only_and_only_exposes_supported_hermes(self):
        before = (self.directory / "config.json").read_bytes()
        with (
            patch("copilot_agents.command", return_value=None),
            patch(
                "copilot_agents.subprocess.Popen",
                side_effect=AssertionError("catalog must not spawn"),
            ),
            patch(
                "copilot_agents.urllib.request.build_opener",
                side_effect=AssertionError("catalog must not download"),
            ),
        ):
            result = self.app.request("one", "agent_catalog", {})
        self.assertEqual(result["default_agent"], "hermes")
        self.assertTrue(result["onboarding_required"])
        self.assertEqual([row["id"] for row in result["agents"]], ["hermes"])
        self.assertEqual(result["agents"][0]["setup_action"], "install_engine")
        self.assertFalse(result["agents"][0]["installed"])
        self.assertEqual((self.directory / "config.json").read_bytes(), before)
        self.app.config["inference_profile"] = "custom-analysis"
        self.app.config["exec_profile"] = "custom-execution"
        self.assertEqual(self.app.view("one")["agent"]["name"], "Hermes")
        self.assertFalse(self.app.view("one")["agent"]["acp_ready"])

    def test_request_shapes_and_unsupported_agents_are_rejected(self):
        for method, params in [
            ("agent_catalog", {"refresh": True}),
            ("agent_setup_start", {"agent_id": "codex"}),
            ("agent_setup_start", {"agent_id": []}),
            ("agent_setup_start", {"agent_id": "hermes", "url": "https://evil.test"}),
            ("agent_setup_status", {"id": []}),
            ("agent_select", {"agent_id": "claude"}),
        ]:
            with self.subTest(method=method, params=params), self.assertRaises(ValueError):
                self.app.request("one", method, params)

    def test_unknown_default_keeps_state_and_registry_recoverable(self):
        self.app.config["default_agent"] = "unsupported-agent"
        state = self.app.view("one")
        self.assertEqual(state["agent"]["name"], "Agent")
        self.assertEqual(state["agent"]["state"], "error")
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch("copilot_agents.configured", return_value=True),
        ):
            result = self.app.request("one", "agent_catalog", {})
            self.assertTrue(result["onboarding_required"])
            selected = self.app.request("one", "agent_select", {"agent_id": "hermes"})
        self.assertEqual(selected["default_agent"], "hermes")
        self.assertFalse(selected["onboarding_required"])
        self.assertEqual(self.app.view("one")["agent"]["name"], "Hermes")

    def test_completion_persists_selection_and_emits_without_claiming_model_or_runtime_ready(self):
        receipt = {
            "inference": "connected",
            "execution": "connected",
            "check": "acp_initialize",
            "model_call": False,
        }
        result, process, launch = self.outcome(
            {
                "result": "completed",
                "connection": receipt,
                "hermes_command": "/fixture/hermes",
                "hermes_home": str(self.root / "hermes"),
                "bridge_home": str(self.root / "runtime"),
                "fbl_user_home": str(self.root / "user"),
            }
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["connection"], receipt)
        self.assertTrue(self.app.config["agent_onboarded"])
        self.assertEqual(
            json.loads((self.directory / "config.json").read_text())["default_agent"], "hermes"
        )
        state = self.app.view("one")
        self.assertFalse(state["enabled"])
        self.assertFalse(state["ready"])
        self.assertEqual(state["agent"]["state"], "disconnected")
        self.assertGreater(state["revision"], 0)
        self.assertEqual(launch.call_args.args[0][-2:], ["--worker", str(self.directory)])
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        self.assertTrue(process.stdout.closed)

    def test_failed_jobs_return_fixed_errors_and_auth_next_step_without_persisting(self):
        for error in ("auth_required", "PRIVATE_BAD_ERROR"):
            result, _, _ = self.outcome(
                {"result": "failed", "error": error, "stderr": "PRIVATE_CREDENTIAL"}
            )
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"], error if error == "auth_required" else "setup_failed")
            if error == "auth_required":
                self.assertEqual(result["next_command"], "hermes model")
            self.assertNotIn("PRIVATE", json.dumps(result))
            self.assertFalse(self.app.config["agent_onboarded"])

    def test_malformed_completed_receipts_cannot_mark_agent_configured(self):
        base = {
            "result": "completed",
            "connection": {
                "inference": "connected",
                "execution": "connected",
                "check": "acp_initialize",
                "model_call": False,
            },
            "hermes_command": "/fixture/hermes",
            "hermes_home": str(self.root / "hermes"),
            "bridge_home": str(self.root / "runtime"),
            "fbl_user_home": str(self.root / "user"),
        }
        for changed in (
            {"connection": {}},
            {"connection": {**base["connection"], "model_call": 0}},
            {"connection": {**base["connection"], "execution": "disconnected"}},
            {"hermes_home": "/other-user"},
            {"hermes_command": "relative/hermes"},
        ):
            with self.subTest(changed=changed):
                result, _, _ = self.outcome({**base, **changed})
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], "setup_failed")
                self.assertFalse(self.app.config["agent_onboarded"])

    def test_existing_configuration_failure_gives_official_manual_route(self):
        result, _, _ = self.outcome(
            {"result": "failed", "error": "engine_existing_configuration_requires_manual"}
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(
            result["installation"]["url"],
            "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
        )

    def test_active_collaboration_rejects_setup_and_select(self):
        self.app._state("one")["enabled"] = True
        for method in ("agent_setup_start", "agent_select"):
            with self.assertRaises(ValueError):
                self.app.request("one", method, {"agent_id": "hermes"})

    def test_catalog_busy_disables_setup_without_hiding_configured_agent(self):
        self.app._state("one")["enabled"] = True
        with (
            patch("copilot_agents.command", return_value="/fixture/hermes"),
            patch("copilot_agents.configured", return_value=True),
        ):
            result = self.app.request("one", "agent_catalog", {})
        self.assertTrue(result["busy"])
        self.assertFalse(result["agents"][0]["can_setup"])
        self.assertTrue(result["agents"][0]["configured"])
        self.assertEqual(result["agents"][0]["status"], "configured")

    def test_job_ownership_same_owner_reuse_cancel_and_close_only_signal_own_process_group(self):
        entered = threading.Event()
        release = threading.Event()
        process = Mock(pid=234567, returncode=None)
        process.poll.return_value = None
        process.stdout = io.StringIO("")

        def wait(**_):
            entered.set()
            release.wait(timeout=2)
            process.returncode = -15
            process.poll.return_value = -15
            return -15

        process.wait.side_effect = wait
        with (
            patch("copilot_agents.subprocess.Popen", return_value=process) as launch,
            patch("copilot_agents.os.killpg", side_effect=lambda *_: release.set()) as kill,
        ):
            job = self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})
            self.assertTrue(entered.wait(timeout=1))
            self.assertEqual(
                self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})["id"],
                job["id"],
            )
            with self.assertRaises(ValueError):
                self.app.request("two", "agent_setup_status", {"id": job["id"]})
            with self.assertRaises(ValueError):
                self.app.request("two", "agent_setup_start", {"agent_id": "hermes"})
            with self.assertRaises(ValueError):
                self.app.request("one", "settings", {"enabled": True})
            self.app.request("one", "agent_setup_cancel", {"id": job["id"]})
            self.app.agents.jobs[job["id"]]["thread"].join(timeout=2)
            self.assertEqual(
                self.app.request("one", "agent_setup_status", {"id": job["id"]})["status"],
                "cancelled",
            )
            launch.assert_called_once()
            kill.assert_called_once_with(process.pid, signal.SIGTERM)
        self.assertFalse(self.app.config["agent_onboarded"])

    def test_worker_launch_error_does_not_leave_pending_job(self):
        with patch("copilot_agents.subprocess.Popen", side_effect=OSError("PRIVATE_LAUNCH_ERROR")):
            job = self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})
            self.app.agents.jobs[job["id"]]["thread"].join(timeout=2)
            result = self.app.request("one", "agent_setup_status", {"id": job["id"]})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "setup_failed")
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_timeout_terminates_and_reaps_only_own_worker_group(self):
        process = Mock(pid=234567, returncode=None)
        process.poll.return_value = None
        process.stdout = io.StringIO("")

        def wait(timeout):
            if timeout == 0.25:
                raise subprocess.TimeoutExpired("synthetic-worker", timeout)
            process.returncode = -15
            process.poll.return_value = -15
            return -15

        process.wait.side_effect = wait
        with (
            patch("copilot_agents.subprocess.Popen", return_value=process),
            patch("copilot_agents.time.monotonic", side_effect=[0, 301]),
            patch("copilot_agents.os.killpg") as kill,
        ):
            job = self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})
            self.app.agents.jobs[job["id"]]["thread"].join(timeout=2)
            result = self.app.request("one", "agent_setup_status", {"id": job["id"]})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "setup_timeout")
        kill.assert_called_once_with(process.pid, signal.SIGTERM)
        self.assertTrue(process.stdout.closed)
        self.assertIsNone(self.app.agents.jobs[job["id"]]["process"])

    def test_worker_wait_error_clears_job_and_closes_stdout(self):
        process = Mock(pid=234567, returncode=None)
        process.poll.return_value = None
        process.stdout = io.StringIO("")
        process.wait.side_effect = OSError("PRIVATE wait failure")
        with (
            patch("copilot_agents.subprocess.Popen", return_value=process),
            patch("copilot_agents.os.killpg"),
        ):
            job = self.app.request("one", "agent_setup_start", {"agent_id": "hermes"})
            self.app.agents.jobs[job["id"]]["thread"].join(timeout=2)
            result = self.app.request("one", "agent_setup_status", {"id": job["id"]})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "setup_failed")
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertTrue(process.stdout.closed)
        self.assertIsNone(self.app.agents.jobs[job["id"]]["process"])


if __name__ == "__main__":
    unittest.main()
