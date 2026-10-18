"""Assist 的供应商边界；业务调度继续使用现有会话和执行池合同。"""


class AgentAdapter:
    def __init__(self, identity):
        if identity not in {"hermes", "codex"}:
            raise ValueError("unsupported collaboration agent")
        self.id = identity

    def inference(self, config, directory, on_update=lambda _: None):
        if self.id == "codex":
            from copilot_codex import Codex

            return Codex(config, directory, on_update)
        from copilot_acp import ACP

        return ACP(config, directory, on_update)

    def executions(self, config, directory, on_error=lambda _: None, on_process=lambda _: None):
        if self.id == "codex":
            from copilot_codex_execution import CodexExecutions

            return CodexExecutions(config, directory, on_error, on_process)
        from copilot_exec_acp import ACPExecutions

        return ACPExecutions(config, directory, on_error, on_process)

    def capabilities(self):
        return {
            "inference_policy": "restricted_audited"
            if self.id == "codex"
            else "verified_zero_tools",
            "general_task": self.id == "codex",
            "model_call_limit": False,
        }

    def installation_guide(self):
        if self.id == "codex":
            return {
                "url": "https://developers.openai.com/codex/cli",
                "command": "npm install -g @openai/codex",
                "login_command": "codex login",
            }
        from copilot_agents import INSTALL_DOCS

        return {"url": INSTALL_DOCS, "login_command": "hermes model"}

    def detect(self, ctx, config):
        if self.id == "codex":
            from copilot_codex import detect

            return detect(config)
        from copilot_agents import command, configured

        installed = bool(command(ctx, config))
        return {"installed": installed, "configured": installed and configured(ctx, config)}


def adapter(config):
    return AgentAdapter(config.get("default_agent", "hermes"))
