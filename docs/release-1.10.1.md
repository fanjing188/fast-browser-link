# Hermes Browser Link 1.10.1

macOS 版本，适用于已登录的 Chrome / Edge。日期：2026-10-11。修复 1.10.0 的两个问题，建议 1.10.0 用户升级。

## 改动

- 修复 1.10.0 授权弹窗自动接管在实际使用中不生效：连接授权后任务默认处于 full 模式，此前自动接管只在 smart 模式触发。现在 Google、Apple、Microsoft、GitHub、Facebook、X 的授权页弹窗在 smart 和 full 模式下都自动接管并记审计；其他来源的弹窗在两种模式下仍需确认；密码、验证码、2FA 仍由用户亲自填写。（真实 NextBigProduct「Continue with Google」实测发现）
- 修复 1.10.0 引入的坐标点击（`interaction.click`）回归：弹窗观察不再使坐标点击经真实执行器返回失败。
- 读取参数无效时，模型收到的提示写明是哪个参数不受支持；协议层错误码保持 `invalid_params` 不变。
- 工具说明恢复“非白名单登录窗口仍须明确确认”的约束文字。

## 安装

下载本版本的 `hermes-browser-link-1.10.1.zip`，不要下载 GitHub 自动生成的 Source code ZIP。解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后重载 Chrome / Edge 扩展，并重启使用该插件的 Hermes 会话。

## 验证范围

- 离线门禁：`npm test` 退出 0；固定 Hermes 源码下 `npm run verify` 通过（`passed=True`，drift=0），覆盖 1.10.0 在 CI 失败的 `test_interaction_wire`、`test_wire_contract`；`npm run lint` 0 错误。
- 真实浏览器（临时 profile、完整 background/daemon 链路、本地模拟身份提供方）：`tests/complex-ui/real-login-windows.mjs` Chrome 23/23、Edge 23/23，含 full 模式下白名单自动接管、非白名单仍需确认、关闭回源读取新文档。`real-overlay`、`real-takeover`、`real-tabs-interaction` 通过。
- 真实 Google 账号登录流程将在发布后用本机 Chrome 复测。
- 支持范围为 macOS + Chrome / Edge；Windows、Linux 未完成安装验收。
