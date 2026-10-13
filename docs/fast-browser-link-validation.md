# Fast-browser-link 首轮改造验收（2026-10-13）

本文件记录首轮结果。后续全面复查发现并修复了新旧扩展 ID 冲突及 Vault 注册元数据问题；不能用本首轮结果声称升级与所有 Hermes 工具均无影响。当前兼容边界见 [通用接入](agent-integration.md)。

本地开发候选，起点为 `727b128`，分支 `codex/fast-browser-link`。原工作目录及其已有修改保留，候选目录已改名为 `Fast-browser-link`。尚未提交、推送、发布或更改 GitHub 仓库名称。

## 日志分析与修复

只读抽查近期 30 份真实任务日志，仅统计错误类别，不复制页面、账号或敏感数据。发现 execution_denied 10 次（其中 official.ready_state 8 次）、reference_target_missing 5 次、target_unavailable 2 次、document_changed 1 次、page_not_ready 1 次。日志没有保留底层异常，不能逐条断言根因。

源码确认：CDP 瞬时错误曾用固定 JSON 字段顺序的正则匹配，空白或字段换序会落入笼统拒绝。改为解析 JSON 后识别固定错误类别，并复用同一判断函数。18 项回归通过；只读恢复与写入不重放边界保留。

候选带入主仓库已有的 DOM.describeNode 修复，避免内部扫描通过 DOM.getDocument 重置上传操作的前端节点编号。26 项核心测试以及 Chrome 上传回读验收通过；该修复并非此次新发现。

历史安装日志的 SHA256SUMS 不一致、桥接运行中和云端状态未知是保护拒绝，未删除校验或放宽门禁。改名后同步了 Native host 指纹、技能注册表及历史迁移测试的命名空间。

## 实现

- 品牌、包名、Native host、工具前缀、数据目录、技能名、构建和文档引用统一为 Fast-browser-link / fast-browser-link / fast_browser_*。
- 保留 Hermes 作为真实第三方框架的名称、接口与许可证出处，不将第三方名称伪装成本项目名称。
- 新增 skills + JSON CLI + MCP stdio，复用现有 Native 执行器；无需 Hermes、API Key、手写端口或 MCP 配置即可走 skills 调用。
- 安装器检测 agent 目录，支持 all/单独选择，准备扩展、注册 Native host、安装七处 skills、初始化共享运行时；失败回滚本次写入，拒绝覆盖既有目标，验证预构建包校验和。
- 独立安装包内含预构建扩展，安装时只需要 Python，不需要 Node.js。源码构建仍需要 Node.js。

## 验证结果

| 检查 | 结果 |
|---|---|
| JavaScript 核心离线矩阵 | 940/940 |
| Python 核心离线矩阵，分段复验 | 530/530，包含安装迁移 76 项和新入口 8 项 |
| 新入口单元测试 | 8/8，身份隔离、未知写入不重放、MCP、预览、路径保护、回滚、包篡改 |
| Chrome 原有完整 Native 验收 | 通过，包含读写、上传下载、登录弹窗、Vault、清理 |
| 新 CLI → Chrome | 连接、建任务、读、填、点、回读、跨会话拒绝、关闭通过 |
| 新 CLI → Edge | 同上通过 |
| 安装包 → 临时用户目录 | 七处技能、两份 Native 注册、health、browsers 通过；无真实浏览器连接时 browsers 返回空数组 |
| runtime / manifest / version / docs / git diff --check | 通过 |
| lint | 0 errors；存在风格及安全规则 warnings，不宣称零警告 |
| skill-creator 校验 | 通用 skill 通过 |

首次 npm test 在安装迁移分组失败后停止；修复后复跑该 76 项分组，并执行后续所有核心 Python 分组。此处报告的是完整清单的分段通过，不冒称最后重新跑过一次单命令 npm test。首次通用 CLI 夹具误用交互模式读取正文，改为指定正文区域的 content 模式后，两浏览器实际回读通过。

日志保存在本候选 `artifacts/validation`。浏览器验收使用临时 profile 与合成页面，未替换个人浏览器扩展或已运行的原桥接。

## 已知边界

- macOS Chrome/Edge 的未上架扩展需要用户首次“加载已解压扩展”并确认连接，不能静默绕过浏览器限制。安装器明确返回 requires_browser_confirmation。
- 本机支持 macOS；没有宣称 Windows/Linux 已适配。
- CLI/MCP 为框架无关协议，但尚未逐个启动所有 agent 产品/版本进行集成验收。纯云端且不能运行本地命令的 agent 仍需要云端配对。
- 通用安装器为首次安装流程，遇到既有目标拒绝覆盖；Hermes 原有升级/卸载流程通过 --hermes-plugin 进入。
- GitHub 新名称链接为目标引用，尚未执行远端仓库改名或发布；旧数据不自动迁移。
