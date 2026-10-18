# 从你的工作流程到功能包

从每天重复的工作开始。功能包为 Assist / 协作声明操作对象、数据来源、执行流程
和结果表，不必一开始就让模型判断。完整字段见[字段参考](design/adapter-packs.zh-CN.md)
和 [package schema](fbl-pack.schema.json)，本指南按一个工单任务走完。
[English](packs-guide.md)。

## 1. 填出你的工作

先填每天重复的 **3 件事**，选最小的一件实现。

| 重复任务 | 网站与页面 | 操作对象 `objects` | 数据与来源 `capabilities` | 如何判断 `decision_schema`，或不用模型 | 展示 `result` | 下一步 `next` |
| --- | --- | --- | --- | --- | --- | --- |
| 核对工单材料 | 合成工单台 `/cases` | 工单号 | 本地工单 JSON | 列缺失材料，不用模型 | 工单号、客户、缺项、状态 | 请人工收集材料 |
| 第二件事 | … | … | … | … | … | … |
| 第三件事 | … | … | … | … | … | … |

网站是任务发生的地方，不代表浏览授权。先用合成记录跑通，再审阅真实来源的访问
权限和成本。这里使用的 `support.example.test` 仅为离线测试域名。

## 2. 把第一行变成工单包

新建目录及 `package.json`，先填身份：

```json
{"id":"support-triage-example","version":1,"release":"1.0.0"}
```

**网站与页面**对应工具画像，路径锚定后不会在其他路径推荐：

```json
{"tools":[{"id":"support-triage-example","hosts":["support.example.test"],"pages":[{"id":"case","paths":["^/cases$"],"flows":["support_materials"]}]}]}
```

**操作对象**对应工单号，从 URL 参数、可见表格列或完整匹配的选区提取：

```json
{"objects":{"case_id":{"name":{"en":"Case ID","zh":"工单号"},"from":[{"url_param":"q"},{"column":["Case","工单号"]},{"selection":"^[A-Z]{2}-\\d{4,}$"}]}}}
```

**数据与来源**先写输入、输出合同，再写代码。下面是最小工单合同，完整示例另有
客户、缺项和状态；自定义输出使用 `records`、`source`，需要时增加 `missing`：

```json
{"schemas":{"case.inspect":{"input":{"type":"object","properties":{"case_id":{"type":"string","maxLength":40}},"required":["case_id"],"additionalProperties":false},"output":{"type":"object","properties":{"records":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"case_id":{"type":"string","maxLength":40}},"required":["case_id"],"additionalProperties":false}},"source":{"type":"string","maxLength":500}},"required":["records","source"],"additionalProperties":false}}}}
```

绑定包内脚本：

```json
{"capabilities":{"case.inspect":[{"id":"support-example-local","type":"command","argv":["python3","./inspect_case.py"],"risk":"zero","cost":"local","local_only":true,"read_only":true,"batch_limit":1}]}}
```

**如何判断**：材料清单无需模型，用 `judgment: false`，流程、步骤均声明风险：

```json
{"flows":{"support_materials":{"name":{"en":"Review case materials","zh":"核对工单材料"},"object":"case_id","judgment":false,"risk":"zero","steps":[{"id":"read_case","capability":"case.inspect","input":{"case_id":"$input.object"},"risk":"zero"}]}}}
```

若后续需要解释判断，改为 `judgment: true`，增加受限的 `decision_schema`，例如
含布尔字段 `needs_followup` 的对象。宿主单独校验一次模型判断，保留原始来源记录。
这会产生所配置 Agent 的模型费用，不能宣称整个流程零成本。

**结果展示**：把下面片段加到 `flows.support_materials`。新增客户等列时，也要加到
记录 schema 中。通用表已有排序、搜索、选行、复制和 CSV 导出：

```json
{"result":{"columns":[{"field":"case_id","label":{"en":"Case","zh":"工单号"}}],"primary":"case_id"}}
```

**触发与下一步**：给 `support_materials` 加入下面声明。`triggers` 各条是或、同条字段是且；表头来自同一表格，选区须完整匹配对象正则。目标 `support_reply_draft` 必须存在、对象同为 `case_id`，也要加入页面的 `flows`。目标设 `triggers: []`，仅在材料齐全时提出接续建议，不自动执行、不发送回复；完整示例已包含只读步骤。

```json
{"triggers":[{"table_columns":{"all":["Case","Status"]}},{"selection":{"object":"case_id"}}],"next":[{"flow":"support_reply_draft","when":{"field":"missing_materials","records":"all","empty":true}}]}
```

以上是逐项增加的字段，不是各自独立的包。需要完整字段时从
[可运行工单包](examples/adapter-pack/package.json)继续扩展。

## 3. 写一个本地命令能力

stdin 接收一个 JSON 对象，stdout 只输出 JSON，诊断写 stderr。
`--help` 必须在读取 stdin 或写文件之前退出。对应最小合同的 Python 脚本：

```python
import argparse
import json
import sys

parser = argparse.ArgumentParser(description="Read a synthetic local case")
parser.parse_args()
inputs = json.load(sys.stdin)
# 将合成记录替换为经过审阅的本地来源。
print(json.dumps({"records": [{"case_id": inputs["case_id"]}], "source": "synthetic"}))
```

完整读取本地 JSON 的例子见 [inspect_case.py](examples/adapter-pack/inspect_case.py)。
本地写入可以使用宿主任务工作目录，但应设 `read_only: false`，不能作为自动只读操作。

## 4. 起草、验证、审阅、安装

```sh
fbl packs new --describe "我每天核对工单材料" --url https://support.example.test/cases
fbl packs test /absolute/path/from/the/draft/output
fbl packs test /absolute/path/from/the/draft/output --json
# 审阅草稿并实现 TODO 脚本后再安装：
fbl packs install /absolute/path/from/the/draft/output
```

`new` 用默认 Assist Agent 的独立受限、无工具单轮会话，输入本指南、字段参考和
工作描述。不会访问 URL，URL 只生成 host 与 path 匹配规则，不复制查询参数或片段，
拒绝含凭据的 URL。生成命令由宿主统一替换为 TODO 骨架。宿主校验完整包合同，失败
后在新的受限会话修一次；仍失败时保留草稿、错误和原始响应。Agent 无法启动时退回
现有 `init` 模板形态并说明原因。草稿位于 `copilot/drafts/<id>/`，标注
**模型起草·待确认**，不会自动安装或启用。

`test` 检查格式、对象/能力引用、风险声明与路径包含关系。
`tests/scenarios.json` 是场景数组，例如：

```json
[{"url":"https://support.example.test/cases?q=CS-1001","expect":["support_materials"]},{"url":"https://other.example.test/cases?q=CS-1001","expect_absent":["support_materials"]},{"url":"https://support.example.test/cases","table_columns":["Case"],"table_rows":[["CS-1001"]],"selection":"","expect":["support_materials"]}]
```

场景走既有确定性推荐路径，不调用模型。每个 `risk: zero` 且 `local_only` 的
命令都要有 `tests/fixtures/<binding-id>.json`：数组元素为
`{"input": {...}, "expect": {...}}`，`expect` 可省略，但输出 schema 始终校验。
命令在禁止网络、仅临时任务目录可写的沙箱执行；其他命令仅运行沙箱里的 `--help`。
系统不能强制沙箱时，检查失败且不运行命令。失败退出码非零，`--json` 输出机器结果。

试试 [price-watch](examples/price-watch/README.md) 的合成可见价格、库存与本地 CSV
记录，或 [job-tracker](examples/job-tracker/README.md) 的本地职位去重清单、状态搜索。

侧栏完成任务后点击“存成流程”，只向新的受限会话发送已知工具/页面/流程 ID、
对象类型和固定动作类别，不发送 URL、对象值、选区或页面文字。
侧栏显示草稿路径及验证命令，仍须审阅后安装。

场景还支持 `follow_completed: [{"flow":"support_materials","status":"completed","object":"CS-1001","records":[{"missing_materials":[]}]}]` 和 `dwell_seconds`，与 `table_columns`、`table_rows`、`selection` 一起验收触发和条件接续；静态检查拒绝不存在的 next 流程。见[完整场景](examples/adapter-pack/tests/scenarios.json)。

## 5. 作者要知道的安全规则

- 凭据、账户状态和个人路径不进包；真实来源从用户管理的配置引用认证。
- 能力、流程、步骤明确声明 `zero`、`metered` 或 `external`。“本地”“免费”不授予
  执行权限，本地写入不属于只读。
- 包不能扩大浏览器所有权或授权范围。登录、验证码、支付和最终业务提交仍受宿主管理。
- 使用 argv 数组，不拼 shell；文件留在包内，输入输出有界，未知值保持未知。

接真实来源前阅读[安全政策](../SECURITY.md)、[能力参考](fbl-packs.zh-CN.md)
及[适配规则](design/adapter-packs.zh-CN.md)。
