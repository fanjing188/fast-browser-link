# Fast-browser-link 2.1.0

2026-10-14，macOS 稳定版。支持本机 Chrome / Edge；不宣称所有网站、操作系统或 agent 框架版本均已验收。

## 改动

- 普通与无痕任务使用同一执行器。独立 skills / JSON CLI / MCP 的 `create` 支持 `incognito: true`，Hermes 的 `fast_browser_open` / `fast_browser_create` 支持 `incognito=true`。创建前检查浏览器扩展无痕权限，普通与无痕任务不相互复用。
- 修复点击登录后源页面刷新或跳转导致弹窗观察中断；保留原操作剩余观察期，旧候选失效检查继续生效。新文档和已接管弹窗恢复同一 taskId 的最近日志。
- 独立 CLI/MCP 新增 `downloads`、`download_claim`、`download_cancel`。`close` 的 `keepTabs: true` 与 `handoffReason` 复用已有任务移交通道。
- 更新独立技能、Hermes 技能、双语 README、无痕验收矩阵和安装说明，避免把普通 Cookie 镜像或可选 Hermes 能力当作无痕通用能力。

- 修复 macOS 维护更新中守护进程已清理运行记录、但尚未被父进程回收时的退出检查竞态，继续拒绝未知进程和残留套接字。

## 验证

- 打包后的 Chrome、Edge 临时 profile 分别通过 17 组能力检查：页面读取、表单与控件、上传收件、下载归属/领取/哈希/取消、同源与跨源 iframe、截图/坐标点击/拖拽/滚动、JS/CDP、Python 与网络捕获、对话框、接管恢复、多标签导航、敏感字段转人工、清理撤权及独立 CLI 下载/页面移交。
- 普通与无痕模式的 A→B→C 登录夹具均通过 taskId、面板日志、弹窗回源、Cookie 隔离和清理检查。
- Chrome 无痕下载需要确认系统保存框；本次已在临时浏览器确认。Edge 的测试配置直接保存。未修改个人浏览器配置或替换真实下载委托。
- 离线回归、语法、lint、版本和文档检查、技能校验、公开源码与密钥扫描随发布提交执行；GitHub Core / Secret scan / Pinned Hermes integration 的结果绑定同一源码提交。真实浏览器夹具和离线检查各自独立，互不替代。

运行完整能力矩阵：

```sh
node tests/native-v2/real-incognito-matrix.mjs --package --headed
node tests/native-v2/real-incognito-matrix.mjs --package --headed --edge
node tests/native-v2/real-login-continuity.mjs
node tests/native-v2/real-login-continuity.mjs --edge
```

需要已有固定 Hermes 测试环境，设置 `HERMES_SOURCE` 与 `HERMES_PYTHON`；完整环境和证据范围见 [测试说明](../testing.md) 与 [无痕矩阵](../incognito.md)。

## 安装与更新

- 独立模式：下载 `fast-browser-link-2.1.0.zip`，校验 Release 的 `SHA256SUMS.txt` 与包内 `SHA256SUMS.json`，解压后运行 `bash install.sh`。仅需 Python 3.11+，不需要 Node.js 或 Hermes。
- 可选 Hermes integration：使用 `fast-browser-link-hermes-2.1.0.zip`；其现有安装支持 `./install.sh --upgrade`。
- 独立安装器不会覆盖已有目标。已有独立安装应先结束任务、备份程序及技能，按 [维护要求](../agent-integration.md#安装状态和升级) 校验并同步程序，保留 `plugin-data` 的任务身份和数据，不能用删除数据绕过活动任务检查。
- 更新后重载扩展，以 `browsers` 确认连接。无痕模式还需在扩展详情开启 Incognito / InPrivate 权限。扩展固定 ID 和 Native host 名保持不变。

## 能力边界

同浏览器内多个无痕任务共享无痕会话，不是每任务独立账号。插件任务日志、元数据和下载文件仍可能落盘。Cookie 镜像仅处理普通会话。密码、验证码和支付字段仍交给用户或已授权的私有 Vault；本轮未提交真实付款、未解锁外部密码管理器，也未声称所有第三方网站无痕流程均可自动完成。浏览器保存提示和下载限制仍遵循浏览器策略。
