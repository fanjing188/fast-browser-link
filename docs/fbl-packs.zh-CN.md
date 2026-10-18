# 技能包与本机能力清单

第一次写包请先读[从你的工作流程到功能包](packs-guide.zh-CN.md)，本页保留为字段参考。

运行时从已登记 `extension_dirs` 读取 `package.json`，当前格式版本 **1**。`pack.json` 是依赖与升级策略说明，执行契约仍是 package.json。通用包依赖 `browser.core`；SEO 判断另依赖 agent。setup 默认安装 general，询问 SEO（默认不装），使用 managed_packs 避免重复加载旧内置包。已有安装在 setup 前保持原配置。

`fbl packs init my-local --argv '["python3","/absolute/local/script.py","--input","{input_json}"]' --capability keyword.expand` 在所选运行时的 `plugin-data/fast-browser-link-native/copilot/drafts/my-local` 生成骨架。程序生成根路径并核实脚本，不接受穿越/软链接。审阅后 `fbl packs install 生成目录` 登记；`fbl packs remove my-local` 只移除摘要匹配的受管包。

升级比较 `.fbl-pack.json` / `.fbl-skill.json` 和已知历史技能摘要。未修改内置包、技能与运行时一同进入回滚事务；用户修改阻止覆盖/删除，模板冲突保留 `.json.new`。未知格式版本拒绝，版本变更需明确迁移。

## 通用工作流

`package.json` 仍为 `version: 1`。现在可选声明 `scene`（`id`、双语 `name`，默认包 ID）、`objects`（双语名与 `from` URL 参数/表头列/完整匹配选区正则），流程 `object` 引用该类型。保留 `keyword/domain/url`，旧包无需修改。

`schemas.<能力>.input/output` 可定义本领域记录；页面 `columns` 可映射包内输出 schema 的字段。`templates` 允许 `<包id>.<名字>` 前缀，仍限制包内路径并经过宿主模板校验。流程新增可选双语 `description`、`when`、独立 `decision_schema` 和 `result:{columns:[{field,label:{zh,en}}],primary}`；未写判断合同沿用旧 `DECISION`，未写列时自定义记录按最终输出 schema 展示，原字符串结果引用保持兼容。

当前页匹配的流程可在自己的场景或 `general` 推荐；不匹配页面或没有明确对象时不由模型猜测。`filter`（等于/包含/数值区间）、`dedupe`（按字段）、`sort`、`top`、`pick`（选字段/改名）是 `risk:zero` 的本地转换。通用结果支持排序、筛选、复制、导出及作为已确认表格加入工作篮；缺失显示“未知”，真实零保留，SEO 继续使用专用视图。

完整字段、限制、转换参数与兼容说明见[通用领域声明](adapter-packs.zh-CN.md#通用领域声明version-1)，机器格式见 [package schema](fbl-pack.schema.json)。[工单示例](examples/adapter-pack/package.json) 使用 `support/case_id` 和独立记录，可在隔离测试中运行，无需真实服务。

`general/pack.json` 中的 recipes 是 agent 执行步骤，不是新 RPC 方法。读页使用 `fbl browser browsers` → create/get 就绪 → new_tab → semantic_snapshot → close；每个任务独立私有 session。表格导出、多页采集使用侧栏识别与确认，保留页数上限和部分读取状态；摘要由调用 agent 判断已读内容；表单普通字段先拟定并确认，最终提交交用户，敏感项始终人工处理。核心浏览器本身不调用模型。

SEO 包仅含公开联想、公开搜索结果、Trends 页面、sitemap 页面族；不附带私人账号或付费指标。缺量/KD 保持未知；中性判档不硬编码业务阈值，本机规则可配置。agent 推理仍可能产生用户配置的模型费用；发现阶段不执行查询。

## 为自己的技能加能力清单

在 `SKILL.md` 旁放可选 `fbl-capabilities.json`，参照[合成示例](fbl-capabilities.example.json)和[格式](fbl-capabilities.schema.json)。个人路径、工具名、站点、凭据和业务阈值只留本机，不进公开仓库。

每条写标准能力名、成本及命令绑定：argv 参数模板、JSON/CSV 输出格式、优先级、批量上限、超时、停用码/文本。相对脚本以技能目录解析；命令必须在 PATH 或为已有绝对路径。按数组执行，不经过 shell。可用 `{input_json}`、`{input_csv}`、`{keywords_file}`、`{output_json}`、`{output_csv}`、`{work_dir}` 及标准输入字段；stdin 也是输入 JSON。输出需符合标准能力 schema；保留指标精确性/缺失原因。`--help` 必须本地、无副作用。

能力包括 keyword.expand/metrics/questions/judge/filter、serp.top、domain.keywords/top_pages/authority、trends.series、pool.lookup/save。判档、筛选、池操作保持本机命令。准确 schema 见 `native-bridge/copilot_capabilities.py`，绑定字段见 `copilot_packages.py`。

有清单时确定性发现；无清单时读取技能正文和有界帮助，交零工具模型单轮起草，标“模型起草·待确认”。帮助加超时/禁止联网沙箱，不支持沙箱则不运行。MCP 只读配置和 tools/list，不调用工具；生成包引用配置路径，不复制 env 和认证；HTTP 重定向需核实。

工具站来自用户填网址或明确勾选扫描当前普通标签 URL/标题，不读历史。发现只在归属工作页检查登录态和表头，按结构别名匹配，不按域名。未知成本、付费、模型草稿、需登录默认不勾；只有已声明零成本、可用且置信度至少95%才默认选中。确认屏审阅来源/依据/置信度/成本/验证结果，可改优先级、参数、上限；确认后仅保存本机 extensions/discovered 包。日常遇新报表表头提示审阅，不执行查询。

doctor 比较文件、帮助摘要和 MCP schema；开启协作检查文件/新技能并后台刷新帮助/MCP 元数据。doctor 可刷新此前确认的网址表头；启动时不打开网页，后续已采集表头发生变化则提示。变化提示重新确认，绝不自动改绑定；远端没检查不能当成未变化。


功能插件的安装、初始化、管理和开发标准见 [功能插件与技能适配包](adapter-packs.zh-CN.md)。
