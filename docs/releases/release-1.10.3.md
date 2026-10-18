# Fast-browser-link 1.10.3

macOS 稳定版，适用于 Chrome / Edge。日期：2026-10-11。

## 改动

- 修复 Google 等登录页的账号项采用 ARIA link/button 时，点击被 `content_shield_uninspectable` 误拒绝的问题。复用真实语义引用和局部保护，不关闭内容保护；目标与不可读框架重叠、包含该框架或引用失效时仍拒绝。
- 更新配套 `fast-browser-link`、`fast-browser-batch-scrape`、`troubleshoot` 技能，明确按账号项实际角色定位、部分覆盖的处理、弹窗回源后的登录核验及清理异常处理。
- 文档统一 smart/full 下白名单 OAuth 弹窗自动接管的说明。

## 安装

下载 `fast-browser-link-1.10.3.zip`，不要下载 GitHub 自动生成的源码 ZIP。解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后重新加载 Chrome/Edge 扩展和 Hermes 插件运行时，确认版本为 1.10.3。

## 验证范围

- 本次行为修复候选已通过完整 `npm test`：Node 1027 项、Python 512 项；构建、语法、传输预算检查通过，lint 0 错误。
- Chrome、Edge 的隔离本地登录矩阵各 29/29，包含原生与 ARIA 账号项、跨源附属框架及登录回源；离线边界覆盖框架重叠和包含关系拒绝。
- 保持内容保护开启，在真实 NextBigProduct 完成 Google 账号选择、弹窗关闭回源和已登录页面读回；未投稿或修改账号设置。
- 最终版本的离线、固定 Hermes integration、公开源及密钥检查以该版本源码提交的 GitHub Actions 结果为准。
- 已知边界：真实测试收尾曾因浏览器断连返回清理状态 unknown，核实无残留后经正式维护流程登记；本版不宣称解决该断连根因。此前 Edge popover 偶发旧引用、本次未复现；付费 SEO 工具页面未现场复验。Windows、Linux 未完成安装验收。
