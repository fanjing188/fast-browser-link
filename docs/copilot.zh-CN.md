# 协作模式（2.2.0 本地候选）

协作模式读取普通网页的有界语义快照与最近30步操作，侧栏展示建议、任务进度和结果。关闭时注销采集，取消本次任务并回收协作进程。未安装、同步或发布当前候选；验收记录见[实施报告](growth/report-copilot-mode-p1.md)。

## 开启前设置

打开侧栏先读取两个 Hermes profile 的模型清单，缓存24小时；“刷新模型”强制重取。发现只做 ACP initialize/session/new，不发送 prompt，不消耗模型 token；Hermes 仍可能访问提供商模型目录。失败时可手动填写合法 `provider:model`（含 `custom:name:model`）。不接受空格、命令选项或 shell 符号；空值使用对应 profile 默认。

主界面只显示状态、今日/本次用量和建议/进行中/结果。齿轮打开设置二级页，分为界面、执行模式、高级（默认折叠）和本机能力；日志图标打开同一侧栏内的实时日志页，返回不创建新标签。首次开启直接保存均衡默认值并显示可关闭提示。字段修改自动保存，旁边短暂显示✓；下一次推理/执行生效，进行中的任务保留启动时的配置。预设按模型名挑选，不是实时价格排序；没有匹配项时沿用profile默认。

设置只存在 daemon 的本机 `copilot/config.json`，不存浏览器、不修改 Hermes 全局或 profile 默认模型。模型通过 ACP session/set_model 或独立 CLI `-m` 传递。卡片分别标注 ACP 会话模型、oneshot 启动回报或缓存来源；后者不是提供商逐请求路由的独立证明。今日/会话/任务分别列输入、缓存读、输出，并按模型汇总；旧账本无法归属的量标为历史/未归属。

## 初始化与升级

由用户执行预览，确认后加 `--apply`：

```sh
bash scripts/setup-copilot-profile.sh
bash scripts/setup-copilot-profile.sh --profile copilot-exec
bash scripts/setup-copilot-profile.sh --apply
bash scripts/setup-copilot-profile.sh --profile copilot-exec --apply
```

默认 `gpt-5.6-luna / openai-codex`，可传 model/provider。脚本只新建或升级摘要仍匹配的自有受管文件；未知 profile、用户修改、插件引用变化、模型/provider不匹配均拒绝。现有模型不同需传原模型/provider。升级补关闭自动标题/后台review/记忆、manual审批等项；执行 profile 的 ACP 工具改为空用于纯判读，CLI 保留 fast-browser-link/web/terminal/file。终端永久放行清单为空，没有 yolo。确定性取数已由 daemon 负责，判读无需授权危险命令。认证不复制，沿用 Hermes 的共享规则。

真实 config 位于 `<运行时根>/plugin-data/fast-browser-link-native/copilot/`。独立根为 `~/.fast-browser-link`，Hermes 适配器使用既有 shared-root。仓库示例为 `native-bridge/copilot-config.example.json`。安装/同步只补不存在的配置和模板，已有文件需用户合并本轮字段/schema/fetch步骤，本轮未实际安装或同步。

## 执行与已知限制

默认 `exec_transport=acp`：协作开启时建立常驻执行连接，每个SEO判读任务新建独立会话；先核对零工具，再仅发一个模型判读 prompt。工具检查 `/tools` 和清理 `/reset` 是本地命令，不调用模型。结果 JSON 由 daemon 校验并私有落盘，模型不需要文件或终端权限。同进程多会话并发，上限 max_parallel；停止发对应 session/cancel。传输崩溃只重启一次，失败任务不自动重放；再失败显示中文诊断，需要检查后重新连接。

**当前 Hermes ACP 不支持每会话工具/轮数上限配置，也没有逐会话关闭接口。** 通用任务在 ACP 路径会明确拒绝，请选择 `oneshot` 后备完整执行；不会悄悄放开工具。任务完成用 `/reset` 清空历史并停止客户端使用该会话，Hermes 仍保留会话对象/记录到进程关闭，这不等同于真正逐会话结束。本轮不能宣称完整实现了这两项上游能力。

`exec_transport=oneshot` 保留独立 `hermes chat`。通用任务继续完整工具执行；SEO取数后使用 `-t none --max-turns 1` 输出JSON，不再工具循环。显式启用的关键词取数后备才用浏览器，受后备上限和模板/全局上限共同限制。常规工具上限取小，模板基础：关键词15、长尾12、竞品15、SERP6；倍率仅作用于工具路径，SEO纯判读固定单轮。Hermes 可能额外收尾/重试，真实API次数需账单核对。

新任务附本次已完成工作的短清单，总长≤500 UTF-8字节；每个任务始终新会话，不把历史任务上下文串成一条长会话。

## SEO 取数接口

模板 `fetch` 声明 script、params_schema、output_schema、timeout。`fetch_commands` 将脚本名映射为本机命令 argv；命令从 stdin 读参数JSON，向 stdout 写符合模板schema的JSON，stderr不送模型。无 shell 拼接。相对可执行文件可由 `fetch_dir` 指定本机脚本目录；私有工具/凭据不要放进公开模板。

- 长尾：内置 Google Suggest 英文接口，种子+26字母+5问句前缀，最多100个去重候选。HTTP无模型token；部分失败会注明，不能将该来源当作地区精确搜索量。
- 关键词：`keyword_metrics` 提供词/量/KD/CPC；`serp_top10` 提供前十URL/标题。由本机配置JSON接口包装现有工具；没有配置明确标缺数据，不能把 不同来源的 KD 冒充example-seo-tool KD。
- 竞品：`competitor_keywords` 提供流量词与 pages，未配置标缺数据。
- SERP拆解：只用与对象URL对应的现有采集快照，不额外取数。
- 存词池：本地CSV/配置的 pool_command，不调用模型。已有关键词/竞品7天缓存命中也不调用模型。

查看各模板 output_schema 配置私有适配命令；例如关键词接口输出 `{"keywords":[{"keyword":"example","vol":100,"kd":12,"cpc":1.2}],"source":"本机查实来源"}`，SERP接口输出 `{"results":[{"url":"https://example.test/","title":"样例"}],"source":"本机查实来源"}`。只接受查实数字，缺失字段省略。命令成功并不代表数据来自正确市场，需适配器保留来源语义。

缺源/超时/错误格式都会进入 `missing_data` 和结果卡。关键词模板的 `fetch_fallback.enabled` 默认false；用户显式启用后仅用受限oneshot补缺，默认最多3轮。不会静默回退到无限工具调用。

## 采集、用量与隐私

默认上下文阈值6000，达到阈值请求≤160字摘要后新会话接续；不是单次请求硬上限。每日、本次与任务的输入/缓存读/输出按模型统计，仅作信息展示，无每日限额或加权暂停。旧配置的daily_token_budget/cache_weight读取时忽略，下次保存移除。缺少可靠usage时注明估算。3分钟空闲暂停、30分钟自动关闭保持。

实时lease/task及持久化workspace归属的工作页均不采集。导航等待DOM静默800ms，最长5秒；晚到表格补发，相同快照合并。语义快照≤3KB，不读输入值、cookie、存储或整页DOM；PDF和特殊协议不采集。

悬浮球位置全局保存在扩展local storage，右键/长按隐藏，侧栏打开时不显示迷你列表。报告与模型缓存保存在本机；日志保留7天，勿公开个人数据。

## R7 结构化结果与后台表格

结果统一包含 verdict（≤30字结论）、level、最多3项metrics、missing、process、最多2个next；各模板有独立主体和decision_schema。模型只输出判断，量/KD/CPC/排名由daemon从取数源合并，非法模型字段仍记已发生用量后拒绝。旧缓存尽量转换，无法转换时通用卡提示核对；不会将原始JSON倒进侧栏。

结果默认折叠；长尾按组切换、前5条、组头全选，竞品优先可做词、前10条并可排序。勾选后批量查词只建一个执行，存池走本地；上限1000词，超出明确拒绝，不截断。补取指标只重跑keyword_metrics批量接口，保留原判断，不发模型请求。缺量/KD整列隐藏并注明原因。✓池仅根据可核实的accepted_keywords回执，未回执不凭退出0假定已入池；written未知用null与missing说明。

新结果按完成时间排序，同对象同动作的显式新结果替换旧记录，旧记录/报告进历史；子任务挂父结果，20个根结果后折叠，更早内容可展开。完整表在后台新标签页打开扩展内部页，可排序/筛选并由daemon导出CSV；不会自动激活标签。

表格条支持原生table、ARIA grid/table/treegrid、data-ui-name和重复行/表头div表格。只读取已渲染且未隐藏的文本；控件、编辑区、隐藏字段不读，链接地址单独保留。自动采集只把列名/行数摘要送推理；手动“识别当前表格”及导出可在模型未开启时使用，操作本身0模型token。用户主动选词仍可成为操作上下文。

Excel/CSV保存到table_export_dir（默认~/Downloads/fast-browser-link/），不走浏览器下载框。XLSX由stdlib ZIP/XML生成，原文为文字、数值另列、链接另列；CSV UTF-8 BOM，公式样式文本作文字保护。复制TSV提供原表可见文字。打开文件/目录只接受本次导出的文件ID，不接受任意路径。

“保存全部”只在独立“Hermes 协作·”工作页运行，经原有workspace-only授权/租约安装，不借用用户标签；保持原普通/无痕上下文。URL分页、按钮分页、无限/虚拟滚动逐批合并、整行去重。生产按钮点击通过Executor语义引用，滚动通过受控Executor/CDP静态操作，保留原权限/遮挡检查。无法核实的分页目标、登录/验证码/额度、结构变化、焦点或归属变化立即停止并保存部分；不点站点导出。

默认1.5–3秒随机页间隔，table_max_pages默认50，可配1–200；预计超过配置上限要在侧栏再次确认，未知页数触顶仅保存部分。虚拟滚动按“批次”计，不假称页数。后台节流通过worker轮询加载/稳定状态应对，单次脚本10秒硬超时，不激活页面、不禁用浏览器节流；不能保证所有站点隐藏渲染都可运行。

静默能力由daemon短期令牌下发Hermes子进程，再经正常BridgeClient标记任务；每次开启轮换，不持久化令牌。静默任务强制separate工作窗口，禁止CDP显式激活/新建非受管target/窗口调整；输入不走激活队列，用户移走或正在前台查看工作页则拒绝动作。审批不弹系统通知，结果/进度只在侧栏，球显示进行中/新结果及表格提示。显式用户点击“打开文件”仍交系统默认程序处理。

本轮未安装、同步、发布或改真实配置；PNG与真实Edge验收仍待本机。三种表格本地页：`docs/growth/assets/r7-table-fixture.html`，可从仓库根运行普通HTTP静态服务器后访问（由用户执行），详见报告。R6b通用任务ACP/真正逐会话关闭的上游限制保持。

划词任务、趋势及本机适配扩展点参见[协作扩展包](copilot-packages.zh-CN.md)。

工具记忆、能力绑定、只读体检和组合编排见[能力说明](copilot-capabilities.zh-CN.md)。

## 实时日志

日志按采集、推理、执行、系统分类，包含大小、token（含估算标记）、耗时、建议变动计数、取数器/页码/脚本阶段、能力体检和配置变更；不保存输入值、Cookie、认证头、页面全文或命令参数。只记录固定摘要、统计和来源标识；失败保留固定错误码而非任意异常正文。

日志每200ms合批推送，只在日志页渲染固定行高的视口窗口；详情单独展开，避免JSON改变行高。最多2000条，支持类型/错误/搜索筛选、暂停滚动、回到最新、当前浏览器当天清空及全部JSONL复制/导出。文件位于协作数据目录logs/YYYY-MM-DD.events.jsonl，0600权限，保留7天；重开面板可读回当天记录。离线连接事件先标作本地临时记录，恢复后提交与读回，不冒充已持久化。

协作看板默认名为“Hermes协作看板”（英文 Hermes Copilot），可在设置的“界面”修改；品牌仍是 Fast-browser-link。一级视图仅保留连接、建议/进行中/折叠结果、最近3条日志和今日用量；执行、表格导出和本机能力在二级设置中。弹窗的看板按钮仅在协作开启时显示。

提取表格先在原页面与侧栏同步确认；页面装饰层使用 closed shadow root，不改表格或锁输入。确认前不导出或开启多页工作页；Esc、取消和目标移除会清理高亮，页面或数据改变时拒绝旧凭据。确认多页收集后才打开同一地址的后台工作页；上限仍为200页。

“本机 Hermes”仅检查当前ACP就绪、执行profile配置文件与可执行程序是否存在，以及最近调用结果。`execution_startable` 是结构检查，不代表实际启动或模型可用性验证；读取状态和重试读取均不启动模型、不消耗token。灰色可能是协作尚未开启，开启协作仍会按既有流程启动会话。名称和导出设置保存到本扩展实例的协作配置，不修改Hermes配置。
