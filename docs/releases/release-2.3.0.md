# Fast-browser-link 2.3.0

日期：2026-10-22。macOS 稳定版，整合复杂页面执行、任务工作台、推荐、原页接管及统一 Vault/MCP 适配。只有对应提交的发布门禁通过后才创建版本标签；公开 Release 与安装包是最终发布依据。

## 改动

- 复杂页面恢复保持业务记录、文档、frame/Shadow 和局部根身份；歧义不猜测，未知写入不重放。结构解析器首次按需装入，保留原注入字节上限。
- 原生侧栏整合材料、通用任务与插件推荐，支持参数、队列与结果详情；就绪推荐优先，受阻准备提示最多一条。旧未映射卡保留正文并只读迁移，显式任务和在途结果保持原合同。
- `fast_browser_open(existing_tab=true)` 及独立 `create` 的 `existingTab={}` 接管当前页或唯一精确 URL；保留草稿、窗口和分组，不授予创建或删除原页的资格。
- 同步统一 `browser_vault` 与旧五工具均保留原线程、私有凭据通道与一次性租约，默认关闭，失效绑定不能回退官方浏览器。
- MCP 完整分页复用同一会话；失败刷新、目录变化与合同变化使旧确认失效。派发后未知结果停止、不重放；完整工具扩展与 schema 分别受结构预算约束，SSE 兼容跨块行尾与 UTF-8。
- CSV 表头/数据公式保护、采集部分覆盖标记及用户编辑的待升级模板保护同步纳入。

## 安装

独立模式下载 `fast-browser-link-2.3.0.zip`，解压后运行 `./install.sh`；通用安装器不覆盖已有安装，升级时保留 `.fast-browser-link/plugin-data` 并遵循通用接入文档的维护要求。Hermes integration 使用单独的 `fast-browser-link-hermes-2.3.0.zip`，已有安装使用正式维护入口或 `./install.sh --upgrade`。更新前核任务空闲与维护锁，保留程序回滚副本及 profile 配置。插件配置与个人凭据不包含在发行包中，不自动启用 Vault。更新后按安装结果重载 Chrome/Edge 扩展及 Hermes 插件运行时。

## 验证范围

发布检查入口：`npm test`、`npm run verify`、`npm run format:check`、`npm run lint`、`npm run check:js`、`npm run check:docs`、`npm run check:version`、公开源码扫描、双模式不可变包和逐文件哈希。

真实浏览器组合使用 `real-existing-tab.mjs`、`real-workbench.mjs` 与 `real-complex-ui.mjs`，在 Chrome/Edge 临时 profile、本地合成页面、真实 HOME 和私有 scratch 中运行。原生侧栏 320/375 深浅色截图与完成详情 1440/375 截图需逐张目视；480 只有 DOM 验证。浏览器合成夹具不证明真实业务账号、模型准确率或个人 Vault 已验收。

CI 使用 Node 22、Python 3.11/3.14 和固定 Hermes SDK 提交 `e62a47ab680bf952b26559e540c28bc18571017c`，完整结果按发布提交关联到 Core checks、Pinned Hermes integration 和 Secret scan 工作流。macOS 以外平台、真实 MCP 服务、真实 TLS/代理压力未作业务认证；MCP 当前没有常驻目录通知监听，执行前重读目录；同步系统 DNS 无法硬中断，截止后拒绝迟到发送。
