# 功能插件与技能适配包开发标准

第一次写包请先读[从你的工作流程到功能包](packs-guide.zh-CN.md)，本页保留为字段参考。

功能插件是可安装的本地适配包，公开入口为 `package.json`。它把工作场景、建议、取数能力和执行步骤放在同一个包里。核心负责浏览器连接、任务隔离、权限和结果；插件声明业务规则与数据来源。

## 用户安装与初始化

首次打开协作侧栏时，先在“连接你的 Agent”中选择 Hermes，点击“配置并连接”。已安装的 Hermes 会被复用；检查进度依次显示检测环境、安装与绑定、检查连接、准备就绪，完成后点击“开始协作”。若提示账户或模型未就绪，先完成自己的登录配置后重试。此检查只验证 ACP 连接，不调用模型生成。以下 CLI 流程保留给安装和诊断。

1. 使用已校验的完整安装包，先为 Hermes 配好自己的可用模型和登录；纯浏览器工具不要求 Hermes。
2. 在安装包目录执行 `python3 -B -m fbl setup --seo`。通用模式不需要 SEO 时省略 `--seo`。安装器保留个人技能、未知 profile 和认证，不复制他人的凭据。
3. 按安装器输出，在 Edge/Chrome 加载安装目录中的解压扩展，启用本地连接。执行 `fbl doctor`，确认宿主、后台服务、扩展及专用 profile 的状态。
4. 打开侧栏“设置 → 功能插件”，查看已安装包、版本、来源、能力和待初始化项。关闭协作后，可安装内置包或输入本地插件文件夹路径。修改过的包保持原样；受管包可在二次确认后卸载。
5. 使用自己的关键词工具或其他业务工具登录态，在“本机能力 → 发现”审阅候选并确认绑定，再运行能力体检。网站、账户、付费 API 和个人文件路径由用户提供，不属于通用安装包。
6. 重新开启协作，在匹配的工作页面执行一次只读任务，核对真实结果、来源、缺项及工作页清理。安装完成和能力可执行是两项独立状态。

SEO 的三个前置能力：`keyword.metrics` 需要返回相应市场的搜索量和 KD；`keyword.expand` 的上升查询来源须声明 `reports: ["rising"]`；`trends.series` 读取公开趋势曲线。指标工具的搜索量、KD 是其估算口径，不能保证新用户天然拥有可用账户。缺少来源、登录失效、验证码或额度限制时保留缺项并提示处理。

页面技术故障停用的来源可通过再次体检恢复，只有页面核实成功才恢复；登录、验证码、限流和额度造成的停用不自动解除。

`fbl packs init` 在 `copilot/drafts/` 生成待审阅骨架，草稿不会自动加载；审阅后再安装。

CLI 同样支持：

```sh
fbl packs list
fbl packs install /absolute/path/to/my-adapter
fbl packs remove my-adapter
```

## 包结构与元数据

```text
my-adapter/
  package.json
  inspect_case.py
  cases.json
```

`id` 是稳定唯一标识；`version: 1` 是声明契约版本，`release: "1.0.0"` 是插件自身版本。可选 `name`、`description` 用于列表。使用插件 ID 前缀命名工具、工作流和绑定，避免冲突。

包可提供以下模块，按需要添加：

| 模块 | 职责 |
| --- | --- |
| `tools` | 域名、页面路径、URL 参数中的工作对象、可读报表链接与列映射 |
| `experience` / `experience_file` | 最多 800 字的建议策略；有工具画像时只在匹配域名与页面路径生效，没有画像时作为全局策略 |
| `capabilities` | `command`、`browser`、`mcp` 或显式 `hermes` 后备来源 |
| `schemas` | 自定义能力的输入、输出 JSON schema |
| `flows` | 有序工作步骤、可选步骤、只读处理和至多一轮模型判断 |
| `templates` / `prompts` | 经校验的任务契约与中英文提示 |

多个插件的策略按当前页面匹配后组合，随工作场景更新，不由最后安装的插件静默覆盖。策略是业务约束，不是测量值，也不能扩大浏览器授权。

## 可运行示例

[示例目录](examples/adapter-pack/) 中的 `support-triage-example` 仅读取随包合成工单，没有网络调用，也不操作真实订单。

```sh
fbl packs install /absolute/path/to/docs/examples/adapter-pack
```

页面对象约定为 `https://support.example.test/cases?q=CS-1001`；该域名只用于测试，不是实际服务。也可以在隔离测试中直接调用能力，输入 `{"case_id":"CS-1001"}`，返回合成工单的材料缺项。在自己的插件中替换域名、路由和数据源后重新验收。

## 能力与数据契约

### 通用领域声明（version 1）

以下字段均可选，旧包不需要迁移。参见 [package.json 格式](fbl-pack.schema.json) 和 [工单示例](examples/adapter-pack/package.json)。

| 字段 | 格式与默认行为 |
| --- | --- |
| `scene` | `{"id":"support","name":{"zh":"工单协作","en":"Support"}}`；省略时场景 ID 为包 ID。显式声明时名称中英文必填、各不超过 100 字。 |
| `objects` | 自定义对象类型字典。每项有双语 `name` 和 `from` 来源数组；`keyword`、`domain`、`url` 是保留类型，不能重定义。对象类型 ID 为小写字母起始的字母、数字、下划线，最长 64 字符。 |
| `objects.<id>.from` | `{"url_param":"q"}`、`{"column":["Case","工单号"]}`、`{"selection":"^[A-Z]{2}-\\d{4,}$"}` 三种声明。列别名忽略大小写和首尾空白；只消费当前页已经取得的可见、脱敏单元格。选中文字必须完整匹配声明正则才成为该类型对象；匹配的选区优先于页面对象。无匹配则不猜测。 |
| `schemas.<capability>` | 含 `input`、`output`。自定义能力使用自己的 `output.properties.records.items` 记录结构，输出信封保持 `records`、`source` 和可选 `missing`。记录可用 `case_id`、`customer` 等字段，不自动追加 SEO 字段；建议对象合同均设 `additionalProperties:false`。内置 SEO 能力合同不能覆盖。 |
| `tools[].pages[].columns` | 字段必须来自内置 SEO 字段或当前包的输出记录 schema，值为表头别名数组。JSON 原样校验；CSV/可见表格按字段 schema 转换数字、布尔和 JSON 数组/对象，再校验。 |
| `templates` | 继续允许内置动作命名空间，并允许 `<包id>.<名字>`，例如 `support-triage-example.review`。模板文件必须在包内、最长 128 KiB，仍由宿主检查身份、参数、输出、风险等合同。 |
| `flows.<id>.object` | 引用保留对象或当前包声明的类型；省略时使用旧的 `keyword` 行为。 |
| `flows.<id>.description` / `when` | 可选双语说明与适用时机，各语言最多 500 字；与流程名称、对象类型和明确对象一同提供给推理模型。 |
| `flows.<id>.decision_schema` | 可选本流程单轮判断合同；省略时使用现有 SEO `DECISION`。自定义判断读取该流程记录，单独保存在结果的 `decision`，不会改写原始记录。可选 `verdict` 用作摘要，没有则显示判断已完成。 |
| `flows.<id>.result` | 可为 `{"columns":[{"field":"case_id","label":{"zh":"工单号","en":"Case"}}],"primary":"case_id"}`。列必须来自最终步骤记录 schema，不能重复，`primary` 必须在列中。省略时自定义记录按最终输出 schema 推导列；旧的 `"$steps.read.records"` 结果引用继续有效。 |

自定义 schema 使用宿主已有子集：`type`、`properties`、`required`、`additionalProperties`、`items`、`maxItems`、`minLength`、`maxLength`、`enum`。单份合同最多 32 KiB、嵌套最多 8 层，每个对象最多 100 个字段；字符串上限 12000 字、数组上限 5000 项，未写界限时沿用宿主默认值。`decision_schema` 同样受这些限制。不支持 `$ref`、`pattern` 等其他关键字；选区正则仅在 `objects.from.selection` 声明。

推理模型每轮收到当前 URL 匹配的工具页面与流程合同。匹配的包流程既可在自身场景，也可在 `general` 场景推荐；场景外或没有明确对象时拒绝模型推荐。已完成、忽略和稍后的任务不重复；风险、能力可用性和执行授权仍由宿主独立判定。SEO 内置动作及其特化视图保持原路径。

通用结果表格支持每列排序、全列筛选、行选择、复制和 CSV 导出。没有选中行时处理当前筛选结果；选中后处理筛选范围内的选中行。缺失值显示“未知”，真实的 `0` 保留。加入工作篮先通过现有导出合同生成已确认表格，再作为表格加入，不将工单强行当关键词。可见列采样最多 3 表、每表前 10 行，总计不超过 2400 字节，超过范围的对象须通过明确选区或 URL 提供。

### 通用本地转换

步骤格式仍为 `{"id":"筛选步骤id","transform":"filter","from":"$steps.read_case.records","options":{...},"risk":"zero"}`。以下转换不调用浏览器、模型或外部来源，风险固定为 `zero`；其余步骤和整个流程的风险仍单独核定。

| 转换 | `options` | 行为 |
| --- | --- | --- |
| `filter` | `{"field":"status","equals":"open"}`、`{"field":"customer","contains":"Example"}` 或 `{"field":"count","min":1,"max":5}` | 等于、字符串/数组包含、闭区间；可组合，全部满足才保留。缺失值不匹配，不将其当零。 |
| `dedupe` | `{"field":"case_id"}` | 按字段值稳定去重、保留第一行；缺该字段的行保留。 |
| `sort` | `{"field":"count","direction":"desc"}` | 默认 `asc`，数字按数值排序，其余按文本；缺失值始终在末尾。 |
| `top` | `{"n":10}` | 取前 N 行，N 为 0–5000 整数。 |
| `pick` | `{"fields":["case_id","status"]}` 或 `{"fields":{"case_id":"ticket","status":"state"}}` | 只保留指定字段，可按“原字段 → 新字段”改名；不补造缺值。 |

- 本机命令使用 argv 数组和相对包路径，例如 `['python3', './inspect_case.py']`；不拼接 shell 命令。stdin 为输入 JSON，也可使用 `{input_json}`、`{output_json}` 等受支持占位符。
- 标准输出返回 `records`、`source`、`missing`；趋势能力返回 `series`、`source`、`missing`。缺失指标留空，不填零，不将 PKD 当作 KD。
- `keyword.metrics` 的 `exact: true` 表示当前来源能提供所需的明确指标值，仍须注明提供商、市场、更新时间和来源；不是对指标绝对精度的保证。
- 浏览器来源声明工具、页面、链接、批量上限、`reports` 和 `fields`。同一工具共享 `serial_group`，避免并发抢同一账户或触发限流。
- 可选 `plan_argv` 只生成查询 URL，输出必须恰为 `{"url":"https://已声明域名/..."}`。宿主继续核对域名、协议、凭据与长度；不能通过规划器扩展来源范围。
- 链接只填入查询条件、还需生成报表时，可声明 `query_submit: {"root":"#report","names":["分析","Analyze"]}`。限定区域内必须只有一个同名按钮，仅支持分析、查询、搜索、应用筛选及其英文名称；通过任务页快照引用点击一次。回执未知时停止，不能重放；不能用于登录、导出、付款或业务提交。
- 声明 `risk` 为 `zero`、`metered` 或 `external`。未声明按 `metered` 处理。自动执行还要求独立满足只读、本机/公开来源等检查，不能靠插件自称免费绕过。
- `--help` 必须不访问网络。发现阶段只读取声明、帮助和 MCP schema；真正查询在用户执行任务后进行。
- 密钥、登录态、私有工具地址、个人业务门槛及缓存不进入可分发包。参数只引用本机配置，不复制凭据。

## 开发验收

至少覆盖：声明加载；场景内出现相应建议、场景外不出现；真实执行回执；字段与市场一致；空结果/部分数据；停止和重试；登录、验证码、限流与配额；任务页清理；安装冲突与卸载保护。离线夹具、真实浏览器和付费来源验收分别记录。

先在临时目录运行示例与测试，再安装到自己的运行时。改动过的受管包不会被静默覆盖或卸载，需由作者审查后处理。
