# Fast-browser-link 1.10.2

macOS 版本，适用于已登录的 Chrome / Edge。日期：2026-10-11。

## 改动

- 所有网站的读取结果显示真实邮箱，不再替换为 `[email]`（外链联系人、登录账号选择都需要）；卡号、`key=`/`Bearer` 令牌和密码框值仍遮挡。
- 登录账号选择页（如 Google）里有不可检查的跨源小 iframe 时，主文档里唯一命中、且不与该 iframe 重叠的账号项可以直接点击；目标有歧义或可能落在未覆盖区域时仍拒绝，并返回 iframe 来源和尺寸。（真实 NextBigProduct「Continue with Google」实测发现）
- 自动屏蔽网页干扰：只对成句、明确面向访问者的禁止自动化声明设置站点限制，工具站介绍自家“爬虫/自动化/bot”功能不再被误判；命中时说明“这是页面声明，不是插件故障”，并给出可继续的读取方式。提示注入过滤不变。
- 结构读取（semantic_snapshot / read_page 等）遇到页面动态变化时最多自动重读 2 次，减少 `content_shield_stale` / `content_shield_changed`；写操作、脚本、截图不自动重放。
- `content_shield_unavailable` 增加具体 `reasonCode`；页面 DOM 尚未就绪时在读取内部等待后重读。
- 跨源 iframe 不可检查时，结构读取返回主文档内容和 `skippedFrames`（来源与尺寸），不整体失败；js.evaluate / 截图维持严格策略并提示改用结构读取。
- CDP 仅新增放行只读几何方法 `Page.getLayoutMetrics`、`DOM.getBoxModel`。

## 安装

下载本版本的 `fast-browser-link-1.10.2.zip`，不要下载 GitHub 自动生成的 Source code ZIP。解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后重载 Chrome / Edge 扩展，并重启使用该插件的 Hermes 会话。

## 验证范围

- 离线门禁：`npm test` 1023/1023；固定 Hermes 源码下 `npm run verify` 全部测试通过（本机运行时仓库外工具改写了未跟踪的 status-cache.json，判定为源码漂移，与产品代码无关）；`npm run lint` 0 错误。
- 真实浏览器（临时 profile、完整 background/daemon 链路、本地模拟身份提供方）：`real-login-windows.mjs` Chrome 25/25、Edge 25/25（含带跨源小 iframe 的账号页按邮箱选择并登录回源）；`real-content-shield.mjs` Chrome、Edge 通过（含工具站功能介绍不误判、动态页面结构读取、iframe 跳过诊断、封闭组件保护不泄漏）；`real-overlay`、`real-takeover`、`real-tabs-interaction` 通过。
- 已知：Edge 上“顶层 popover”场景在一次运行中出现过 `stale_reference`，复跑通过，根因未确认。真实 Google 账号登录流程将在发布后复测。付费 SEO 工具 误判的修复以合成文案验证，未在 付费 SEO 工具 现场复现。
- 支持范围为 macOS + Chrome / Edge；Windows、Linux 未完成安装验收。
