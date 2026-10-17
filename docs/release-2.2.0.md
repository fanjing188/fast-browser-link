# Fast-browser-link 2.2.0

草稿日期：2026-10-17。发布状态、改动摘要和验证结果待填写；本草稿不代表已发布或已通过验收。

## 改动

- 新增协作模式本地候选，详见 [用户说明](copilot.zh-CN.md) 与 [实施报告](growth/report-copilot-mode-p1.md)。
- 常驻 ACP 取代每次启动 CLI；新增增量输入、单飞节流、缓存、上下文滚动、空闲和每日预算控制。
- 主会话只做推理，执行使用独立 Hermes chat 子进程及独立任务组；已取得精简profile本机成本/延迟测量，长期上下文成本和浏览器验收仍待完成，不具备发布验收结论。

## 安装

独立模式下载 `fast-browser-link-2.2.0.zip`，解压后运行 `./install.sh`；通用安装器不覆盖已有安装，升级时保留 `.fast-browser-link/plugin-data` 并遵循通用接入文档的维护要求。Hermes 适配器使用单独的 `fast-browser-link-hermes-2.2.0.zip`，其已有安装使用 `./install.sh --upgrade`。更新后重载 Chrome/Edge 扩展，并重新加载或重启 Hermes 插件运行时。安装支持范围待核实。

## 验证范围

待记录测试命令、退出码、环境、真实浏览器验收及未核实或受阻项。
