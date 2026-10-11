---
name: troubleshoot
description: Handle browser connection errors, failed element recovery, incomplete coverage and uncertain action results while continuing the remaining task.
---

# Browser errors

定位失败由插件内部等待页面稳定、重扫 frame 和 Shadow DOM、重新定位，最多恢复三轮。读取结果中的 `coverage` 描述未读范围，不代表整个页面不可用。

恢复后仍失败时，检查 `recovery.strategies`、`recovery.candidates` 和 `recovery.screenshotPath`。换名称、角色或选择器重新找；无法处理的条目记录原因后跳过，继续其他条目，不因单个元素失败停止整个任务。

`recovery.selected` 说明最终候选，`otherCandidates` 是其余匹配数量，`locator` 和 `clickMethod` 说明采用的定位与点击方式。

只有确定尚未派发的动作会重试。`outcomeUnknown=true` 或 `outcome_unknown=true` 表示可能已经执行；先读取页面核实业务结果，不重复提交。确认已完成就继续后续步骤，不能确认则记录该项结果未知并继续独立条目。

同一任务页可以跨站导航。使用任务自己的 `tab_id`，不同任务或会话不能共用租约。`foreign_tab` 时选择本任务的页；`task_paused` 时等待用户恢复；连接断开时检查扩展与本地桥连接。停止和撤销仍使当前任务失效。

JavaScript 对话框会阻塞页面脚本；用 `dialog` 处理后继续。`unsupported_operation` 表示当前接口不支持该动作，应换受支持的接口。

点击成功但 `effect=unobserved` 表示已点中、页面没有可见变化；读页面确认即可，不要重复点。点击后页面跳转时回执带 `navigation` 和 `url`，直接在同一工作页读取新页面。

登录弹窗用 `popup_catalog` 查候选、`popup_adopt` 直接接管，无需确认（含白名单外候选），再选返回的 `tabId` 读取。收到 `popupClosed.returnedTo` 后回读源页。密码、支付、验证码字段（`inputRequired: vault_or_user`）不能直接填写，走凭据工具或交给用户。
