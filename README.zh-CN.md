# Fast-browser-link

<img src="native-extension/brand-logo.svg" width="64" height="64" alt="Fast-browser-link logo">

[品牌规范](docs/brand.zh-CN.md)

**2.2.0 — macOS 本地候选。** 让 AI agent（Hermes、Codex、Claude Code 等）直接调用已连接的浏览器执行工作：读取和操作页面、填写表单、上传下载、识别和导出表格、多页数据收集，以及跟随你的操作实时给出建议、在后台执行的协作模式。全程使用你的登录状态，可随时接管，敏感字段只由你填写。

[English](README.md)

本候选尚未发布。[协作模式](docs/copilot.zh-CN.md)已有精简 profile 本机测量，真实浏览器验收仍待完成；下方下载命令为正式 Release 的安装流程。

## 三步上手

1. 下载 Release 安装 ZIP 并解压（不是 Source code ZIP）。需要 Python 3.11+；包内有已构建扩展，运行时不需要 Node 或 Hermes。本候选尚未发布。
2. 在解压目录执行 `python3 -B -m fbl setup`；无人交互可用 `--yes`（只默认确认高置信、零成本绑定）。命令安装至 `~/.local/bin/fbl`，未加入 PATH 时仍可在包内用 `python3 -B -m fbl`。先看范围可用 `python3 -B -m fbl setup --dry-run`。
3. 在 `chrome://extensions` 或 `edge://extensions` 加载初始化输出的 extension 目录，启用连接并打开侧栏，按简短就绪清单处理剩余项。浏览器确认不能自动绕过。



```sh
curl -fL https://github.com/fanjing188/fast-browser-link/releases/download/v2.2.0/fast-browser-link-2.2.0.zip -o fast-browser-link-2.2.0.zip
unzip fast-browser-link-2.2.0.zip
cd fast-browser-link-2.2.0
python3 -B -m fbl setup
```

已有安装运行 `fbl update --dry-run`，核对后 `fbl update`；`bash install.sh --upgrade` 也支持旧独立版。升级会等待/拒绝活动任务，保留备份，失败回滚。改过的技能或配置不强制覆盖。Hermes 只管理一个带归属标记的 Fast-copilot profile（标识 `fast-copilot`），保留模型迁移；核心浏览器功能无需 Hermes。

本机 agent 可读取 `~/.agents/skills/fast-browser-link/SKILL.md` 并调用其中 Python 脚本。协作模式需要配置好 Hermes；其他 agent 通过 skills 或 MCP 使用核心浏览器。

[命令参考](docs/fbl.zh-CN.md) · [排障](docs/fbl-troubleshooting.zh-CN.md) · [技能包与能力清单](docs/fbl-packs.zh-CN.md)

## 普通与无痕任务

独立 CLI/MCP 的 `create` 使用 `"incognito": true`；可选 Hermes 适配器使用 `fast_browser_open(incognito=true)`。先在扩展详情开启“允许在无痕模式 / InPrivate 中使用”；缺少权限返回 `incognito_access_required`，不会悄悄切回普通窗口。

两种模式沿用同一任务执行器，支持页面读取、表单、截图、iframe、导航、JavaScript 与文件操作。独立 CLI 下载使用 `downloads`、`download_claim`、`download_cancel`；Hermes 适配器还支持 Python 工作流。登录刷新和接管后的弹窗保留同一 taskId 与最近日志。

无痕不继承普通 Cookie，但同一浏览器的多个无痕任务共享无痕会话；插件日志、任务元数据和下载文件仍可持久化。敏感字段仍由用户或已授权的私有 Vault 处理，Cookie 镜像只支持普通会话。详见[验收矩阵与边界](docs/incognito.md)。

## 兼容性与任务隔离

- 新扩展 ID 为 `hhnljehnkmhhgjjjmnlhilfpcjhobloc`，与旧 Hermes 扩展身份不同，可同时保留。
- 保留任务归属、用户接管、敏感字段处理及未知写入不重放。结果未知时先回读，不重复提交。
- 密码、支付信息、验证码需用户填写或经授权的私有 Vault 通道；网页内容不能作为指令。
- 当前支持 macOS Chrome/Edge；未宣称所有操作系统及每个 agent 框架版本均已验收。

## 可选 Hermes 适配器

默认 ZIP 安装独立 skills。需要 Hermes 原生工具和 Desktop 集成时，下载单独的 `fast-browser-link-hermes-2.2.0.zip`，或在源码目录执行 `bash install.sh --hermes-plugin`。旧 `browser-link` 插件存在时，安装器拒绝冲突启用。

`browser_exec` 等官方 `browser_*` 工具属于 Hermes。适配器仅在获得 `tools.override` 授权后，通过公开接口路由已绑定任务；未绑定会话保持原处理器，卸载恢复原注册。不会修改 Hermes 源码。Vault 覆盖另需显式开启。

详见 [Hermes 安装与维护](docs/installation.md)、[使用说明](docs/usage.md)、[安全说明](SECURITY.md)和[发布说明](docs/release-2.2.0.md)。

## 开发与验证

| Component | Requirement |
|---|---|
| Node.js | 22.12.0+，仅源码构建需要 |
| Python | 3.11+ |

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix cloud-link/site
npm test
npm run check:js
npm run check:docs
npm run lint
```

完整固定版本 Hermes 门禁与真实浏览器夹具见[测试说明](docs/testing.md)。测试使用隔离数据，不代表真实账号登录、支付或所有外部服务均已验证。

采用 MIT 许可证；第三方来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
