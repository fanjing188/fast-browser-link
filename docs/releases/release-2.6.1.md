# Fast-browser-link 2.6.1

草稿日期：2026-11-05。发布状态、改动摘要和验证结果待填写；本草稿不代表已发布或已通过验收。

## 改动

- 连续交互焦点租约、锁屏错误和浏览器后台渲染诊断。
- 独立窗口的工作页在建页、导航和选择时激活，保持系统焦点。
- 更新 skill、参考资料与 Hermes 镜像。

## 安装

独立模式下载 `fast-browser-link-2.6.1.zip`，解压后运行 `./install.sh`；通用安装器不覆盖已有安装，升级时保留 `.fast-browser-link/plugin-data` 并遵循通用接入文档的维护要求。Hermes integration 使用单独的 `fast-browser-link-hermes-2.6.1.zip`，其已有安装使用 `./install.sh --upgrade`。更新后重载 Chrome/Edge 扩展，并重新加载或重启 Hermes 插件运行时。安装支持范围待核实。

## 验证范围

离线测试与真实浏览器验收结果以本次任务报告为准；草稿尚未发布，未打 tag。
