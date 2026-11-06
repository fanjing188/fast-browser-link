# Fast-browser-link 2.6.3

日期：2026-11-06。macOS 稳定补丁候选；是否已公开发布以对应 GitHub Release 为准。

## 改动

- 多工作页的未知结果可通过 `reconcile(tab=原页ID)` 核对；外层 `tabId` 也必须匹配原请求目标。新建页须有 native 明确的 created/tabId 元数据，不从现有工作页推断。
- 核对重新验证页租约，只读取原目标，不选择或聚焦浏览器标签，不自动重放未知写入。缺少目标证据、目标不符或快照失败时保持冻结；人工待处理、暂停与跨 owner 保护仍有效。
- MCP 未分类内部异常返回脱敏 `internal_error`，保持 stdio 进程；后续仅允许只读诊断。此状态不证明动作未发生，不能自动重试。

## 安装

独立模式下载 `fast-browser-link-2.6.3.zip`，解压后运行 `./install.sh`；通用安装器不覆盖已有安装，升级时保留 `.fast-browser-link/plugin-data` 并遵循通用接入文档的维护要求。Hermes integration 使用单独的 `fast-browser-link-hermes-2.6.3.zip`，其已有安装使用 `./install.sh --upgrade`。更新后重载 Chrome/Edge 扩展，并重新加载或重启 Hermes 插件运行时。安装支持范围待核实。

## 验证范围

修复阶段已有 macOS 全量 `npm test` 退出 0 的归档证据：Node 1277 项通过，后续 Python 各组通过。该记录早于本次版本准备，不替代最终提交的 CI。

本次版本准备在 macOS、Homebrew Python 与私有短路径 scratch 下，版本一致性、格式、lint（0 errors，1320 warnings）、JS、文档与公开源码扫描均通过；精准回归 stdio 9 项、ActionSession 39 项、脚本工具 32 项及版本脚本 7 项通过。发布前仍须核对同一最终提交的 Core checks、Pinned Hermes integration 与 Secret scan。真实 MCP stdio、脚本子进程及原生桥接测试使用合成 runtime/隔离夹具，不连接真实浏览器，不证明真实网页恢复或采集已验收。

本次准备不打 tag、不合并 main、不安装；真实浏览器故障恢复、个人安装升级和其他操作系统交互能力尚未验收。
