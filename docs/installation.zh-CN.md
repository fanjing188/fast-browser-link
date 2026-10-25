# 为你的 Agent 安装

需要 macOS、Chrome/Edge、Python 3.11+。**Source version: 2.4.0**。从 [Releases](https://github.com/fanjing188/fast-browser-link/releases) 选择正式独立 ZIP 及校验文件，不选 Source code 或 Hermes 适配器 ZIP。源码构建需按[开发说明](development.md)使用 Node.js 22.12+；源码版本标记本身不代表已公开发布。

1. 完整解压，在包目录运行 `python3 -B -m fbl setup`。加 `--dry-run` 可预览；需要时把打印的 CLI 目录加入 PATH。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，加载打印的扩展目录，在弹窗确认连接。保留该稳定目录。
3. 选择下面一种接入。用 `fbl doctor` 检查剩余步骤；后台服务健康不等于浏览器已连接。

## Codex

重启 Agent 会话以发现已安装的 `fast-browser-link` Skill。MCP 先预览 `fbl mcp install --agent codex`，审阅后加 `--apply`。已有同名配置保留。

## Claude Code

重启会话后使用 Skill；或预览 `fbl mcp install --agent claude`，审阅后加 `--apply`。命令使用官方客户端 CLI，重新连接 MCP 并检查工具清单。

<a id="hermes"></a>
## Hermes

核心浏览器能力不需要 Hermes。原生工具使用单独的 `fast-browser-link-hermes-<版本>.zip`，或从源码运行 `bash install.sh --hermes-plugin`。核对专用 profile 并完成浏览器确认。发现旧 `browser-link` 插件冲突时拒绝同时安装。详见[接入细节](agent-integration.zh-CN.md)和[第一次使用 Assist](assist.zh-CN.md)。

升级先预览 `fbl update --dry-run`；活动或未知任务会阻止升级。保留任务数据和自定义配置。[故障排查](fbl-troubleshooting.zh-CN.md) · [English](installation.md)

[Hermes 安装维护详解](design/hermes-installation.md)
