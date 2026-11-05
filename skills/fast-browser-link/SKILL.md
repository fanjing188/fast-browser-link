---
name: fast-browser-link
version: 2.6.1
description: 使用用户已登录的 Chrome 或 Edge 执行网页任务、批量读取、填写表单及处理登录弹窗；优先 MCP。
---

# Fast-browser-link

后台页 hidden 卡住时直接处理，不需要询问用户，不要改用 computer_use。连续交互使用 `with focused_window():`；单个遮罩使用 `focus_window`。若返回 `screen_locked`，停止并报告“浏览器未带 --disable-backgrounding-occluded-windows 启动”，不要反复重试。

## 快路径

优先 MCP `fast_browser_link(operation, params)`：`browsers` 选用户指定的已连接实例 → `create` → `get` 确认 `state=ready` → 一个 `script` 打开工作页并在同一脚本完成多步与读回 → `close`。保留 taskId，不因等待重复创建。Hermes 也优先 MCP；无 MCP 时独立技能用 `<技能目录>/scripts/browser.py`，同任务共用独立 `--session` 文件；Hermes 可用 `fast_browser_open` / `fast_browser_script`。

例如 `script` 的参数为 `{"taskId":"任务ID","code":"new_tab('https://example.com')\nprint(read_page()['items'])","timeout":120}`。输出检查 `execution_complete`、`outcome_unknown`、`last_operation` 和截断标记；进程退出码不是业务成功证明。导航后重读并使用新引用。接管用户已打开的页面、登录、文件及人工交接先读 [边界](references/boundaries.md)。

## 错误码 → 动作

| 回执 / reasonCode | 下一步 |
| --- | --- |
| `invalid_params`、`invalid_expression` 等 usage | 修参数；确认未派发后重试。 |
| `stale_reference`、`reference_target_missing`、`page_not_ready` | 等就绪并重读新快照；导航可能已发生，核实 `tabId` / `tabState`，勿重复建页或写入。 |
| `permission_denied` | 核任务租约、来源、权限和 `stage`/`reasonCode`；若已有 `tabId`/`tabState` 先检查该页，勿重复建页；不绕过权限。 |
| `document_hidden_stalled` | 原动作未派发：连续交互放进 `with focused_window():`；单个遮罩用 `focus_window`。锁屏见 `screen_locked`。 |
| `screen_locked` | 停止并报告浏览器未带 `--disable-backgrounding-occluded-windows` 启动，不要反复重试。 |
| `focus_lease_unavailable` | 租约失效；检查并报告。 |
| `focus_window_busy` | 本次未执行，稍后重试；`focus_window_denied` 不支持该任务/页，停止此路径并报告。 |
| `focus_window_changed`、`focus_visibility_unavailable`、`focus_restore_unavailable` | 核当前窗口和任务状态；不能确认时停止并报告。`restored:false` 看 `restoreReason`，不等于置前失败，也不盲目再次置前。 |
| `outcome_unknown`、`request_outcome_unavailable` 或 `outcomeUnknown=true` | 查询原 requestId 的 `operation_status`，并读回站点核实；不重放未知写入。 |
| `task_paused`、`user_input_required`、需人工处理的 `popup_policy_*` | 等用户处理或恢复；`popup_policy_unprotected` 是未执行的保护拒绝，按边界文档处理。 |
| `execution_denied` / `runtime_preparation_failed` 的 `tab_closed` | 核任务页是否存在；仅 `outcomeUnknown=false` 且 `retryable=true` 时安全重试。 |
| `debugger_attach_failed` | 检查浏览器调试连接；仅明确未派发且可重试时重试。 |
| `debugger_detached`、`cdp_timeout`、`frame_destroyed`、`execution_context_lost`、`service_worker_disconnected`、`chrome_api_error` | 看 `stage`、`outcomeUnknown`、`retryable`，核连接、页面或 frame；未知先读回，只有明确未派发且可重试才重试。 |
| `internal_exception` 或未归类 `execution_denied` | 停止该动作并报告固定码和阶段；未知先核实，不暴露页面异常正文。 |

`focus_window(*, restore=True, hold_ms=1000, tab=None)` 只作用于本任务创建的独立工作窗口页，hold_ms 为 0–15000；返回 `focused`、`visible`、`previousWindowId`、`restored`，失败恢复时有 `restoreReason`。静默、产品、接管页和 current 窗口被拒绝。`with focused_window(tab=None, max_ms=120000):` 在块内保持焦点，退出、异常、到期或任务关闭时尝试恢复。`run` 的 `focus_window` 可设 `restore="deferred"`、`maxMs`，返回 `focusLeaseId`；使用 `focus_restore` 与该 ID 恢复。独立工作窗口的任务页在 new_tab、navigate、use_tab 时成为窗口活动标签，不抢系统焦点。

## Script 签名与批量读取

不要读安装目录源码找接口；完整签名、默认值和返回字段见 [script helpers 签名表](references/helpers.md)。`read_page` 返回包含 `items` 的字典；`evaluate` 使用函数表达式，业务值通过 arguments 传入。

一次 evaluate 读取约 100–200 行并按游标续读，不要每行调用一次；单次 JS 结果序列化上限 256 Ki 字符。每批写工作目录文件并打印一行进度；stdout/stderr 各保留最多 20000 字符，返回前不流式显示。检查截断、coverage 和最终完成状态。参见 [批量采集](references/batch-scrape.md) 和 [排障](references/troubleshoot.md)。
