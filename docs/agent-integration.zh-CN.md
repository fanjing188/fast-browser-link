# 接入 Codex、Claude Code 或 Hermes

先完成[安装](installation.zh-CN.md)与浏览器确认。Skills、MCP 共用任务归属、敏感输入和未知写入检查。

| Agent | Skill | 可选 MCP 预览 |
| --- | --- | --- |
| Codex | 重启后使用 `fast-browser-link/SKILL.md` | `fbl mcp install --agent codex --dry-run` |
| Claude Code | 重启后使用 `fast-browser-link/SKILL.md` | `fbl mcp install --agent claude --dry-run` |
| Hermes | 使用独立 Skill，或单独的原生适配器 | 见 [Hermes 安装](installation.zh-CN.md#hermes) |

审阅 MCP 命令后再加 `--apply`。保留已有配置，配置无法核实时停止。重新连接 MCP 并检查 `fast_browser_link`。这说明安装行为，不表示每个客户端版本都已真实验收。

用 Skill 自带 Python 入口或 `fbl browser` 执行 JSON CLI。每个任务使用独立私有会话文件，同任务复用；MCP 使用自己的进程身份。先 `create`，等待就绪，再操作归属工作页，完成后读回结果并关闭任务。

多步工作使用 `script`，传 `taskId`、Python `code`、有界 `timeout`。检查 `execution_complete`、`outcome_unknown` 和 `last_operation`；捕获异常不代表人工输入或审批已完成。未知写入先核实再继续。[Python 参考](python-scripting.md) · [CLI](fbl.zh-CN.md)

主动建议由独立的 Fast-browser-assist 产品提供。核心浏览器工具无需 Hermes 或模型配置。[English](agent-integration.md)
