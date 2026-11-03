# 持久工作流、批量结算与验收

2.6.0 未发布候选。九个 Python helper 复用原有 script 链路；需要宿主和绑定扩展同时支持 `durable_workflow_v1`。不增加常驻工具、第二套执行器或个人安装。基础条件与步骤格式见 [通用工作流](browser-workflows.md)。

## 检查点与逐项续做

```python
items = [{"id": "record-1", "steps": [
    {"action": "click", "name": "Advance", "after": {"conditions": [
        {"kind": "element", "selector": "#status", "state": "text", "text": "Saved"}
    ]}}
]}]
result = run_batch("daily-run", items)
# 在同一任务、浏览器实例、代次和标签中，显式续做相同计划。
result = run_batch("daily-run", items, resume=True)
```

单项目使用 `run_workflow(name, steps, ...)`。名称与项目 id 限 1–64 个 ASCII 字母、数字、下划线、点、短横线；最多 100 项，每项最多 16 步。全部项目先校验参数和 CSS，才允许第一笔写入。只对明确未派发的项目失败继续后续项目；结果未知、已派发但后置失败、验证码、人工状态、熔断及全局保护停止整批。

宿主 SQLite 在每步派发前持久写入在途位置，确认后结算；跨进程锁防并发续做。相同计划与预算才可恢复，已确认步骤跳过。输入正文只参与私钥 HMAC 指纹，不写入检查点；站点定位与条件仍应避免包含隐私正文。宿主崩溃、超时或断连不会自动清除在途位置，不因时间过去重跑。检查点每范围最多 256 条，单记录 512 KiB，数据库约 64 MiB，容量满明确拒绝；不会自动清理用户记录。

这里的恢复限定原绑定，不能跨新任务、换浏览器、换标签或换代次承接旧执行资格。原生请求未知时，先沿原有 `operation_status/reconcile` 只读核实；随后才可显式调用 `reconcile_workflow(name, items)`。宿主核对原计划指纹，并只读重验原在途步骤非空 `all` 后置条件；仅元素和 URL 条件可用于澄清，历史响应、下载或弹窗事件不能替代当前证据。没有原后置条件或无法证明时保持冻结，不补发。

## 报告与执行预算

自动输出 `.fbl-reports/<name>.json` 与 `.md`，也可 `workflow_report(name)` 读取。JSON 包含每项 completed/failed/blocked/pending、已确认与剩余步数、在途位置、送达摘要、预算耗用。报告区分 `verified_steps` 与 `unverified_confirmed_steps`；没有声明并满足后置条件的确认送达不算业务验证。步骤完成只说明声明的合同满足，不证明未声明的业务结果。文件写出失败单独返回 `report_error`，持久检查点仍保留。

```python
limits = {"max_seconds": 600, "max_operations": 2000, "max_wait_seconds": 120}
result = run_batch("daily-run", items, budget=limits)
# 停止且没有在途步骤时，才可显式调整；不重置耗用。
limits["max_operations"] = 3000
extend_workflow_budget("daily-run", limits)
result = run_batch("daily-run", items, budget=limits, resume=True)
```

默认限额如上；硬上限分别 3600 秒、20000 次、1800 秒。操作数按宿主浏览器 helper 请求计，包含定位、状态读取和核验，不等同业务点击数；等待预算计显式轮询睡眠，总时间覆盖运行准备与嵌套等待。续做累计实际运行时间，不计停机空闲；剩余时间不能被嵌套 helper 延长。截止只能停止本地等待，不声称取消已派发的浏览器动作；潜在写入后截止保持待核实。

## 业务进展

```python
business_progress([{"selector": "#row", "attribute": "data-record-id"}])
# 或让持久流程在开始前配置：
result = run_batch("daily-run", items, progress=[{"selector": "#row", "attribute": "data-record-id"}])
```

使用记录 id、游标等固定范围的摘要替代整页文字判断循环；元素匹配数与属性/文本只参与摘要，不返回内容。支持 1–8 个选择器；属性限 `data-*`、`id`、`aria-rowindex`。每选择器最多 256 节点，总内容有界，不完整时拒绝继续写入。每个任务标签配置一次，循环历史建立后不能切配置清除保护；摘要不变的跨文档导航仍计停滞。只有归属当前任务、代次、租约且安全、有界、实际存在的完成下载算额外进展，外来下载不清零。进展不是业务验收证据，扩展重启后仍不保留循环计数。

## 站点模板

```python
save_site_recipe("search", [
    {"action": "fill", "name": "Search", "value_key": "query"},
    {"action": "click", "name": "Run"},
])
result = run_site_recipe("search", values={"query": "example"}, workflow_name="search-1")
```

模板只存定位描述和参数键，不存输入值、快照引用、文档绑定或授权。按调用方与宿主回读的当前来源隔离；保存与执行都对声明控件做新诊断，要求完整且可操作，控件摘要变化时拒绝运行。每次取得新引用并通过原动作末端检查；不自动猜测改版后的新控件。支持 click/fill/press/scroll，模板执行结果复用持久报告；业务后置条件应使用明确 `run_workflow/run_batch` 计划声明。

## 下载校验

```python
check = verify_download(download_id, expected={
    "format": "csv", "min_rows": 1, "required_columns": ["id", "date"],
    "date_column": "date", "date_from": "2026-11-01", "date_to": "2026-11-30",
})
```

通过现有归属通道领取本任务下载，校验大小、SHA-256 与读取前后文件一致性；不接受任意外部文件路径。支持 CSV、JSON 记录数组、XLSX 第一工作表、ZIP 的有界解析。CSV 检查列和记录、拒绝重复表头及明显登录 HTML 冒充；日期使用 ISO 日期。XLSX 读取缓存单元格，支持日期样式，不执行公式、宏或外链，也不把压缩包解压到磁盘。ZIP 检 CRC，拒绝加密、过量条目与超大展开内容。PDF/PNG/JPEG 仅检查签名，返回 `signature_only`，不承诺完整文档或图片解码正确。

文件最大 100 MiB；结构化记录文件最大 16 MiB、10 万行；XLSX/ZIP 最多 1000 条目、展开 100 MiB，单 XML 8 MiB、50 万单元格、256 列。失败返回 `valid=False` 与固定原因，保留文件供检查。记录数、必需列、日期区间只证明已声明约束，不证明导出覆盖站点所有数据。

## 验证与边界

离线测试覆盖持久重开、真实进程退出、锁、未知冻结、预算、跨范围隔离、模板改版、报告及文件格式。手动真实打包验收使用 `tests/v1.1-script-lane/real-workflow-tools.mjs`，Chrome/Edge、本地合成站和临时 profile。桌面后台专项 `tests/v1.6.0/real-background-focus.mjs --headed` 需要用户同意，持续采样 macOS 前台应用；默认仍无头。

旧策略的独立窗口抢焦点已复现，新候选改为 [网页弹窗策略](popup-policy.md) 的后台优先/严格/显式兼容模式；首批保护范围有限，不能把兼容模式或所有第三方窗口称为静默通过。未安装、推送或发布。
