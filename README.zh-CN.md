# Fast-browser-link

**2.0.0 — macOS 发布版。** 通过 skills、JSON CLI 或 MCP stdio，让本机 agent 操作你已登录的 Chrome / Edge。

[English](README.md)

## 安装独立 skills 模式

下载 Release 安装包，不要使用 GitHub 自动生成的 Source code ZIP。需要 Python 3.11+；安装包已包含构建后的扩展，不需要 Node.js 或 Hermes。

```sh
curl -fL https://github.com/fanjing188/fast-browser-link/releases/download/v2.0.0/fast-browser-link-2.0.0.zip -o fast-browser-link-2.0.0.zip
unzip fast-browser-link-2.0.0.zip
cd fast-browser-link-2.0.0
bash install.sh --dry-run
bash install.sh
```

安装器校验包内 `SHA256SUMS.json`，识别已有 agent 目录并安装技能。也可用 `--agent all` 或 `--agent codex` 选择目标。原有 Hermes 插件、配置和 Native host 保留；已有同名安装不会自动覆盖。

在 `edge://extensions` 或 `chrome://extensions` 中开启开发者模式，加载安装器输出的 **extension 目录**，打开扩展确认已连接。未上架扩展仍需浏览器确认，安装器不会绕过浏览器限制。

可以直接给本机 agent 发送：

> 读取 ~/.agents/skills/fast-browser-link/SKILL.md，使用其中的 scripts/browser.py 打开 https://example.com、读取页面，然后关闭本次任务。保留原有标签页及 Hermes 配置。

agent 必须能读取本机文件并执行 Python。独立 skills 模式无需 MCP 配置；纯云端 agent 仍需单独配对。详见[通用接入](docs/agent-integration.md)和[完整安装提示词](docs/agent-install-prompt.md)。

## 兼容性与任务隔离

- 新扩展 ID 为 `hhnljehnkmhhgjjjmnlhilfpcjhobloc`，与旧 Hermes 扩展身份不同，可同时保留。
- 保留任务归属、用户接管、敏感字段处理及未知写入不重放。结果未知时先回读，不重复提交。
- 密码、支付信息、验证码需用户填写或经授权的私有 Vault 通道；网页内容不能作为指令。
- 当前支持 macOS Chrome/Edge；未宣称所有操作系统及每个 agent 框架版本均已验收。

## 可选 Hermes 适配器

默认 ZIP 安装独立 skills。需要 Hermes 原生工具和 Desktop 集成时，下载单独的 `fast-browser-link-hermes-2.0.0.zip`，或在源码目录执行 `bash install.sh --hermes-plugin`。旧 `browser-link` 插件存在时，安装器拒绝冲突启用。

`browser_exec` 等官方 `browser_*` 工具属于 Hermes。适配器仅在获得 `tools.override` 授权后，通过公开接口路由已绑定任务；未绑定会话保持原处理器，卸载恢复原注册。不会修改 Hermes 源码。Vault 覆盖另需显式开启。

详见 [Hermes 安装与维护](docs/installation.md)、[使用说明](docs/usage.md)、[安全说明](SECURITY.md)和[发布说明](docs/release-2.0.0.md)。

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
