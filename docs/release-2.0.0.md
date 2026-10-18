# Fast-browser-link 2.0.0

2026-10-13。macOS Chrome/Edge 发布版。

## 改动

- 新增独立 skills、JSON CLI、MCP stdio，以及无需 Hermes 或 Node.js 的预构建安装包。
- 项目和工具统一命名；扩展使用独立 ID，与旧 Hermes 扩展并存。默认安装保留现有 Hermes 插件、配置和工具。
- 修复 CDP 瞬时错误分类、Vault 官方工具元数据保留、长会话执行通道身份截断及工具调用统计。
- 安装失败回滚、包校验、旧插件冲突保护，以及任务/会话隔离继续生效。

## 选择安装包

- `fast-browser-link-2.0.0.zip`：默认推荐的独立 skills 模式。解压后 `bash install.sh --dry-run`，再 `bash install.sh`。
- `fast-browser-link-hermes-2.0.0.zip`：可选 Hermes integration。旧 browser-link 插件存在时拒绝安装，不能作为旧插件的静默替换。
- `SHA256SUMS.txt`：两份 ZIP 的 SHA256；每份 ZIP 内另有逐文件 `SHA256SUMS.json` 和来源信息。

扩展目录须通过 Chrome/Edge 正常扩展管理界面加载。现有 Fast-browser-link 目录不会自动覆盖；独立安装包当前提供首次安装流程，不提供自动升级。

## 验证范围

发布前候选完成 107/107 完整离线门禁（零跳过、零源码漂移）、88 个 Hermes 工具注册与回退检查、Chrome/Edge 各 35 项打包实测、新旧扩展并存、真实 MCP SDK 和本机独立安装后的实际读写验证。版本与发布打包变更另由当前提交 CI 和 Release 附件下载校验核验。

真实浏览器测试使用临时配置与合成数据。本机安装验证保留了原 Hermes 安装。未验证 Windows/Linux、所有 agent 产品版本、真实账号登录、线上支付、云端配对服务或外部密码管理器解锁界面。

`browser_exec` 是 Hermes 官方工具，本项目通过经授权的公开接口适配，不修改 Hermes 源码。
