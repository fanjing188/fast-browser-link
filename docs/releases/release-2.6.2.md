# Fast-browser-link 2.6.2

日期：2026-11-06。macOS 补丁版本；是否已公开发布以对应 GitHub Release 为准。

## 改动

- 修复未决动作阻止脚本前置标签绑定时，未捕获异常导致 MCP 进程退出的问题。
- 返回结构化阻塞结果，保持原任务与 owner，不重放未知写入，不绕过真正的人工待处理状态或跨 owner 保护。
- 增加单页、多页及人工暂停场景的真实 stdio 回归。内部 authorizing/pending 瞬态不单独表示需要用户再次授权。
- 包含此前 2.6.1 的后台渲染、焦点租约与错误分类改进。

## 安装

独立模式下载 `fast-browser-link-2.6.2.zip`，解压后运行 `./install.sh`；通用安装器不覆盖已有安装，升级时保留 `.fast-browser-link/plugin-data` 并遵循通用接入文档的维护要求。Hermes integration 使用单独的 `fast-browser-link-hermes-2.6.2.zip`，其已有安装使用 `./install.sh --upgrade`。更新后重载 Chrome/Edge 扩展，并重新加载或重启 Hermes 插件运行时。安装支持范围待核实。

## 验证范围

本地 macOS：`npm test` 退出0，Node 1277项通过、无失败及跳过，后续Python回归全部通过；新增真实stdio测试3项通过。真实stdio测试使用合成runtime，不等于真实网页端到端验收。真实浏览器故障恢复与其他操作系统的交互能力尚未验收；本补丁不宣称自动恢复已因旧进程退出而失效的历史任务。发布前的固定Hermes集成、核心与秘密扫描结果以该提交的GitHub Actions记录为准。
