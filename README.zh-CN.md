# Fast-browser-link

Fast-browser-link 让 AI Agent 使用你已经登录的浏览器：读取页面、填写表单、上传下载文件和采集页面数据。协作功能由独立的 Fast-browser-assist 产品提供。

<!-- 演示录制待补：补充 docs/assets/demo.gif（浏览 → 建议 → 执行 → 结果）后在此嵌入。 -->

## 三步安装

1. 准备 macOS、Chrome 或 Edge、Python 3.11+，按[安装说明](docs/installation.zh-CN.md)获取已发布安装包，或从源码构建。**Source version: 2.5.1**。正式版本及校验文件以 [Releases](https://github.com/fanjing188/fast-browser-link/releases) 为准。
2. 在包目录运行 `python3 -B -m fbl setup`，加载打印的扩展目录，并确认浏览器连接。
3. 在 Codex 或 Claude Code 中使用已安装的 Skill；也可预览 `fbl mcp install --agent codex` / `fbl mcp install --agent claude`，审阅后加 `--apply`。打开侧栏即可先试本地工具。

[English](README.md)

## 始终由你掌控

复用已登录的浏览器，密码、支付、验证码和最终提交始终由你完成。Agent 任务在自己的工作页里运行，你随时可以接管或停止。详见[安全与边界](SECURITY.md)。

## 功能一览

- **浏览器工具：** 通过 Skills、CLI 或 MCP 读取和导航页面、填写普通字段、上传下载文件及采集页面数据。
- **已有页面接管：** Hermes 使用 `fast_browser_open(existing_tab=true)`，独立 CLI/MCP 在 `create` 中传 `existingTab={}` 接管当前页；提供 `url` 可精确匹配已打开的页面，不刷新、不另开工作页，结束任务保留原标签页与标签组。
- **产品连接：** Fast-browser-assist 等独立扩展通过受限产品连接和工作页接口使用 FBL；浏览器执行、授权与清理由 FBL 管理。

## 平台

目前支持 macOS + Chrome/Edge。Windows、Linux 列入计划，不承诺日期。

[故障排查](docs/fbl-troubleshooting.zh-CN.md) · [可选 Hermes 集成](docs/installation.zh-CN.md#hermes) · [无痕模式](docs/incognito.zh-CN.md)

[开发](docs/development.md) · [设计与安全合同](docs/design/architecture.md) · [测试](docs/testing.md) · [版本说明](docs/releases/release-2.5.1.md)

MIT · [第三方声明](THIRD_PARTY_NOTICES.md)
