# 协作模式（2.2.0 本地候选）

协作模式读取普通网页的有界语义快照与最近30步操作，在侧栏展示建议、进行中和结果。只有开启时才动态注册采集；关闭时注销、清空采集窗口，并取消/回收本次启动的 ACP 与执行进程。

主会话只推理，默认 `inference_profile=copilot`，不需要创建任务组；启动时通过 ACP `/tools` 核对零工具，发现工具即拒绝继续。点击建议后 daemon 启动独立 Hermes chat 子进程，默认 `exec_profile=gefei`。执行进程通过正常 browser-link 工具创建自己的任务和 `Hermes 协作·` 开头的组，结束按2.1规则清理，不共享 owner 或任务文件，不合并多个任务组。

这是未发布候选。用户提供的本机 copilot 测量已达到早期轮次约1.5k–2.2k tokens、含去抖p50约2.7–3.0秒；更长上下文成本、浏览器操作、任务组清理和外部词池仍须验收，见 [实施报告](growth/report-copilot-mode-p1.md)。

## 初始化与配置

配置位于 `<运行时根>/plugin-data/fast-browser-link-native/copilot/config.json`。独立安装根为 `~/.fast-browser-link`；Hermes 适配器沿用既有 HERMES_HOME/shared-root。安装/同步只填充不存在的配置和模板，不覆盖用户修改。本轮没有安装或开发同步。

先预览专用 profile 初始化内容，再由你执行：

```sh
bash scripts/setup-copilot-profile.sh --model '<可用的低价快速模型>' --provider '<对应供应商>'
bash scripts/setup-copilot-profile.sh --model '<可用的低价快速模型>' --provider '<对应供应商>' --apply
```

脚本只新建 `copilot`，不克隆 gefei、不复制凭据、不改 active_profile、不改现有 profile。相同受管文件重复运行不写入；已有未知或被修改的 copilot 会明确拒绝。配置将 ACP 工具设为空、禁用 MCP/插件/记忆/技能索引，SOUL 和工作区规则文件为空；Hermes 本身的少量身份和运行提示仍可能存在。认证遵循 Hermes 的共享规则，本机已确认可共享根目录凭据，无需重复配置。用户已在本机用 gpt-5.6-luna / openai-codex 初始化 copilot；本轮没有改动该 profile。

本地配置字段：

- `inference_profile` 默认 `copilot`；`inference_model` 可按 ACP 会话覆盖；`context_limit` 默认8000且可配置，达到阈值后“≤500字摘要→新会话接续”。它不是单轮请求的硬上限；不再隐式限制为2200，也不因单轮超过3000自动暂停。每日预算仍有效。
- `exec_profile` 默认 `gefei`；`exec_model` 非空时通过 `-m` 覆盖，否则沿用执行 profile 模型；`max_turns` 默认30，通过 `--max-turns` 与模板上限取小值；`max_parallel` 默认3。
- 模板 `toolsets` 通过 `-t` 实际传给 CLI，不包含 all/* 或无关 MCP。Hermes 的30轮语义是普通工具循环上限，上游可能另做收尾摘要请求。
- `report_dir` 可为绝对路径或相对 copilot 数据目录的路径。`pool_command` 为结尾包含 ingest 的 argv；宿主追加 CSV、`--link L1 --date YYYY-MM-DD`，CSV写 `seed=copilot`。未配置时明确报落盘失败。已有配置中的显式 context_limit 会保留，需要用户按本轮要求自行调整；初始化不覆盖既有配置。

仓库示例为 `native-bridge/copilot-config.example.json`，模板位于 `native-bridge/copilot-templates/`。个人路径只能保存在本机配置。

## 使用与成本

从扩展弹窗或浏览器侧栏打开看板，开启协作后继续浏览；点击执行才启动执行进程，忽略的同ID建议当天不再出现。悬浮球可拖动/隐藏；点击立即尝试打开侧栏，浏览器拒绝时展示页内迷你列表。

本地过滤滚动、悬停和细碎 DOM 变化；导航、内容点击、选中、新页停留3秒及显著变化才推理。默认1.5秒去抖、5秒最小间隔、单飞；新页快照≤3KB，同页只发差异。固定规则/模板只在新会话开头发送。

主会话达到 context_limit 时摘要并换会话；3分钟空闲暂停、30分钟自动关闭。每日 token 预算耗尽暂停模型任务；缓存命中和存词池仍在本地完成。关键词/同域竞品结果缓存7天，当前读取的是本模块的结果副本。

执行进程将完整结果写入指定 JSON；daemon 限制大小、校验 schema，写 Markdown/缓存/词池并渲染结果卡。完成后仅将≤100字节状态加入下一轮主会话增量，不把完整结果带回主会话。“停止”取消对应执行进程组，已发生的写入不会撤销。

主会话 token 优先按 ACP 累计 usage 的差值统计；执行按 stream-json 的 usage。缺失 usage 明确标为估算，不能视为准确账单。

不采集输入框、文本域、密码框或 contenteditable 的值，不读 cookie、页面存储或整页DOM。特殊协议页和PDF不采集。日志保留7天，报告/缓存等保存本机，勿加入公开源码。

真实验收需在 Chrome/Edge 分别检查采集隐私、侧栏手势、差异建议、独立任务组、停止/关闭回收、报告/词池回读、缓存与预算。离线夹具不替代这些结果。

模型输出允许去除前后空白和整段JSON代码围栏后严格解析；失败仅重试一次，再失败保留原建议/标记未就绪。不会从额外说明文字中猜取JSON，重试用量也计入每日预算。
