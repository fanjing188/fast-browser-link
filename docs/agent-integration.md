# Fast-browser-link 通用 agent 接入

默认 `./install.sh` 自动检测 agent 目录并安装通用技能；`--agent all` 安装全部目标，`--agent codex --agent cursor` 可选择目标。`--dry-run` 不写入文件；`--no-open` 不打开浏览器。环境要求：macOS、Python 3.11+，以及 Chrome 或 Edge；只有源码构建需要 Node.js 22.12+。

安装在用户目录的 `.fast-browser-link` 下，技能自带 `scripts/browser.py`，自动定位运行时，无需 PATH、端口、API Key 或 MCP 配置。Native host 为 `com.fast.browser_link`。新扩展使用独立固定 ID `hhnljehnkmhhgjjjmnlhilfpcjhobloc`，与旧 Hermes 扩展隔离，可并存，不会替换旧扩展及其 Native host。

| agent 能力 | 接入方式 | 验证范围 |
|---|---|---|
| Codex / Claude Code / Cursor / Copilot / Gemini CLI / Hermes 的本地技能目录 | 安装器复制同一 SKILL.md 与 Python 入口 | 已覆盖七处目录安装；未逐个启动这些产品验收 |
| 能执行命令的 LangChain / LangGraph / AutoGen / CrewAI 等框架 | 调用 JSON CLI，或将 Python Browser.call 包装为框架工具 | CLI 已在 Chrome/Edge 实测读写与会话隔离；框架集成尚未逐个实测 |
| MCP 客户端 | 启动 `runtime/agent-link/fast_browser_link.py --mcp` | JSON-RPC initialize、tools/list、tools/call、错误帧已有测试 |
| 无本机命令能力的纯云端 agent | 使用既有云端适配器 | 需要云端配对，单独安装 skill 无法访问本机 |

所有常见框架可通过 CLI 或 MCP 协议接入，并不表示所有版本均已验收。框架必须提供至少一种本机工具执行能力。MCP 的启动配置保存在安装目录的 `installation.json`，只对需要 MCP 的客户端使用；skills 路径不需要 MCP 配置。

## CLI

```bash
python3 <技能目录>/scripts/browser.py browsers
python3 <技能目录>/scripts/browser.py --session /tmp/fast-task-unique.session create \
  '{"title":"读取示例","instanceId":"已连接实例","allowedOrigins":["https://example.com"]}'
python3 <技能目录>/scripts/browser.py --session /tmp/fast-task-unique.session get '{"taskId":"返回的id"}'
```

任务 ready 后用 `run` 和 `new_tab` 打开页面，再用 `semantic_snapshot` 读取。调用参数采用 Native 协议 camelCase。完成后 close。不同任务使用独立会话文件；同一任务复用文件。文件权限必须为 0600。MCP 每个进程使用独立身份。

来源、任务、标签页租约、用户接管、敏感字段、未知写入不重放等检查仍由现有执行器实施。CLI 不提供任意 RPC 转发，也不允许传 owner。

## 安装状态和升级

安装器的 `extensionStatus=requires_browser_confirmation` 表示文件及注册已准备，尚未确认扩展已加载。首次加载扩展并开启连接后，用 `browsers` 查看连接。`health` 只证明 daemon 可用，不能证明浏览器已连接。

当前通用安装器遇到既有目标会在写入前拒绝覆盖，失败时回滚本次创建的运行时、skills 和 Native host 注册。Fast-browser-link 的 Hermes 适配器使用 `./install.sh --hermes-plugin`。发现旧 `browser-link` 插件时，安装器和插件加载入口均拒绝同时启用，避免官方工具和钩子冲突；保留旧插件时应使用独立 skills 模式。旧插件的更新/卸载仍使用旧版自己的安装器。新旧 Native host 名、工具名、数据目录已分离，不会自动复制旧任务或权限。旧版数据保留在原目录。发布包默认是独立模式；Hermes 适配器使用单独的 fast-browser-link-hermes ZIP。

macOS 普通 Chrome 用户必须确认加载未上架扩展。说明依据：[Chrome 扩展分发规则](https://developer.chrome.com/docs/extensions/how-to/distribute)。安装器不会修改浏览器安全策略或用户 Preferences 来绕过限制。

## Hermes 原生工具影响

默认 skills 安装不修改 Hermes 的 config.yaml，不注册 Hermes 工具覆盖或生命周期 hooks。旧浏览器插件、Native host 和数据目录保持原状。

单独启用 Fast-browser-link Hermes 适配器时，未授予 tools.override 不覆盖官方工具；授予后仅已绑定任务会话走共享浏览器，未绑定会话继续原工具，卸载恢复原注册。Vault 还需单独启用，覆盖时保留官方 toolset、可用性检查和环境要求。旧 browser_shared_* 名称属于旧插件，新插件工具名为 fast_browser_*；旧脚本不会被悄悄迁移。


### 无痕任务和登录连续性

独立 CLI/MCP 的 `create` 支持 `incognito: true`，Hermes 适配器的 `fast_browser_open` 和 `fast_browser_create` 同样支持。浏览器须允许扩展在无痕/InPrivate 模式运行，否则返回 `incognito_access_required`，不会降级为普通窗口。普通与无痕任务分开复用；同一浏览器的无痕任务仍共享无痕会话，任务元数据和日志继续遵循原持久化规则。

登录点击后，源页刷新或跳转保留原操作剩余的两分钟弹窗观察期；旧候选仍失效，新弹窗沿用原任务。新文档及已接管弹窗自动恢复同一任务的最近五步日志。


## 文件与保留页面

CLI/MCP 使用 Native camelCase 参数。上传通过 `run` 的 `files.upload`，传 `tabId`、`selector`、用户指定的绝对 `paths`；选择成功不代表网站已收到文件，需回读网站状态。下载使用：

```json
{"operation":"downloads","params":{"taskId":"任务ID"}}
{"operation":"download_claim","params":{"taskId":"任务ID","downloadId":"下载ID"}}
{"operation":"download_cancel","params":{"taskId":"任务ID","downloadId":"下载ID"}}
```

CLI 的写法为 `browser.py --session <原会话文件> download_claim '{"taskId":"...","downloadId":"..."}'`。只领取本任务完成的下载；保留返回的哈希验证，不猜测浏览器下载目录。浏览器自己的保存位置或下载权限提示仍需用户处理。

要交还页面而不关闭它，调用 `close`，参数为 `{"taskId":"...","keepTabs":true,"handoffReason":"user_requested"}`，确认清理成功后再向用户交付。默认 `close` 关闭任务新建的工作页。更多能力与当前验收范围见 [无痕验收矩阵](incognito.md)。

现有独立安装升级时，先结束任务并核实清理状态，再备份 `.fast-browser-link` 程序目录、安装记录与技能目录；校验新 Release 的 ZIP 校验和及包内 `SHA256SUMS.json`，同步程序和技能，但保留 `plugin-data` 中的身份和数据。更新后重载扩展，并用 `browsers` 和无痕测试回读。通用安装器仍只负责新安装，不可用删除数据或覆盖未知任务状态来绕过检查。
