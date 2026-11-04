# 通用观察、组合操作与定位诊断

## 语义快照取更多条

`semantic_snapshot` 的读取参数放在 `options`：`query` 按可访问名称或文本筛选，`role` 筛单一角色（多角色用 `roles`），`limit` 默认 20、允许 1–200，`root` 缩小范围，`budget` 是估算预算（最少 512）。示例：`{"action":"semantic_snapshot","options":{"query":"创建","role":"button","limit":50,"budget":12000}}`。响应带 `coverage.nextCursor`（同顶层 `nextCursor`）时，保持原 options 并加上 `cursor` 读取下一页；`coverage.hidden` 统计不可见项，`coverage.queryFiltered` 统计名称/角色过滤项，`coverage.omitted` 统计分页或预算截断项。每页检查 `coverage.complete`。页面变化后重新读取，不复用旧 cursor 或引用。

2.6.0 候选新增 Python helper：`wait_until`、`run_steps`、`diagnose_target`、`execution_status`、`recover_page`、`read_resilient`。SDK、JSON CLI、MCP 和 Hermes 都通过原有 `script` 执行链调用；没有新增常驻工具或第二套浏览器执行器。宿主先核本任务绑定实例的 `browser_workflow_v1`，旧组件返回 `workflow_unsupported`，不切换执行方式。恢复与执行保护另核 `execution_resilience_v1`；`run_steps` 同时要求两种能力。需要同时升级宿主和扩展。

持久检查点、逐项批量结算、报告、业务进展、站点模板、下载校验与执行预算见 [持久工作流](workflow-tools.md)。

## 统一等待

```python
result = wait_until([
    {"kind": "element", "selector": "#result", "state": "text", "text": "Ready"},
    {"kind": "element", "selector": ".error", "state": "present"},
], mode="any", timeout=10)
```

最多 8 个条件，`mode` 为 `any` 或 `all`；超时 `(0,60]` 秒，轮询间隔 `[0.05,2]` 秒。返回 `satisfied`、`timed_out`、`matched`、逐条件的 `complete/evidence` 和 `reason`。条件不回显输入正文；不完整读取不能证明不存在。

| kind     | 参数                             | 含义                                                                                     |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| element  | selector、state，可选 text/count | 可见元素的 present/absent/text/count/stable；stable 要求连续三次相同观察，不代表布局稳定 |
| url      | url                              | 顶层页面完整地址精确匹配；回读 frame/loader，发生变化时拒绝拼接结果                      |
| response | url，可选 status                 | 监听后新观察到的匹配响应；只返回请求编号、状态和 filter_only 关联，不证明由某个动作触发  |
| download | 可选 state=complete/interrupted  | 监听后新出现且唯一匹配的本任务下载；多个匹配不擅自选择                                   |
| popup    | 可选 origin                      | 监听后新发现且唯一匹配的原生弹窗；只返回候选，不接管或关闭                               |

状态条件每轮重新读取，不跨轮累计不同页面状态；响应证据可保留到本次等待结束。多个读取是顺序观察，不提供网页事务或原子快照。元素遵守原有有界可见 DOM 读取范围，不证明未加载记录或不可读框架内的状态。URL/response 使用现有 CDP，凭据页排斥继续生效。弹窗只沿已有 opener/观察期合同发现，不扫描个人窗口。

`wait_until` 自调用时建立事件基线，之前已有的响应、下载或弹窗不会命中。需要先监听再点击时使用下面的 `run_steps`。旧下载的等待仍可使用 `wait_for_download`。

## 带前后条件的步骤

```python
result = run_steps([
    {"action": "fill", "name": "Search", "role": "textbox", "text": "example"},
    {"action": "click", "name": "Query", "role": "button", "after": {
        "mode": "any", "timeout": 10,
        "conditions": [
            {"kind": "element", "selector": "#results", "state": "present"},
            {"kind": "element", "selector": ".error", "state": "present"},
        ],
    }},
], timeout=30)
```

最多 16 步，总截止 `(0,60]` 秒覆盖准备、定位、动作和核验。支持 `click/fill/press/scroll/navigate/wait`；点击、填写和按键使用名称，可加 role/root；固定按键是 Enter/Tab/Escape/ArrowDown/ArrowUp，滚动为 up/down。navigate 接受 HTTP(S) url；wait 必须有 after。before/after 接受 conditions、mode（默认 all）、timeout（默认10秒）、interval（默认0.25秒）。

整组格式与 CSS 语法先验证再开始。每步先验证 before，再建立 after 的事件观察，最后只做一次动作并核验；第一个失败立即返回。定位只等待同一文档当前范围内唯一目标，不自动关闭遮挡层，不因遮挡选另一个同名目标。多个可操作同名目标拒绝派发。

返回 `completed/failed_step/reason/outcome_unknown/steps`。每步包含 index/action/phase/dispatched、简短 receipt 和条件证据；不会累计表单输入值或整页快照。`dispatched=null` 表示动作可能已发送，不能重放。`completed` 仅表示已声明步骤和条件完成；业务正确性取决于调用者声明的条件。

后置条件超时保留已经确认的动作送达字段，返回 postcondition_failed；不把已执行动作改成未执行，不自动回滚。结果未知、撤权、断连、人工输入或暂停异常均停止，不恢复旧授权、不换请求编号重做。底层 RPC 超时时仅停止本地等待，不声称取消浏览器动作；此时保守报告未知。确定未开始下一步时的普通等待超时可以返回 timed_out。

## 定位诊断

```python
report = diagnose_target("Query", role="button", root="#search-form", action="click")
```

只读取一次当前范围，返回 reason、actionable、complete、matches、eligible、suggestion 及最多 5 个候选状态。action 支持 click/fill/press。固定原因包含 ready、target_not_found、ambiguous_target、target_disabled、target_readonly、target_not_actionable、target_occluded、target_hidden、incomplete_target_scope。

诊断不返回写入引用或页面文本，不创建执行资格。诊断通过后实际动作仍须取得新引用并进行末端核验。引用过期、文档变化、权限变化由实际执行链保留原始错误，不能借诊断补发。没有框架、虚拟列表或遮挡层证据时不推测原因。

## 故障恢复、降速与循环保护

```python
health = execution_status()
recovery = recover_page(timeout=15)
result = read_resilient(mode="content", timeout=15)
```

`execution_status` 返回页面原因、刷新资格、冷却时间与熔断状态；探针只回有界摘要，不回正文、标题或表单值。页面文字识别是启发式判断，不能替代调用者的业务后置条件。`recover_page` 最多观察三轮；只有当前扩展运行期间由本任务新建、无既往写入、无凭据标记、无表单/可编辑区或框架的暂时故障页才允许自动刷新。刷新前再次核对同文档、加载代次、进展摘要和十秒内的健康回执，每个任务标签最多刷新一次，派发前消耗额度。恢复不重新授权、不重放提交，刷新已派发后丢失回执保留未知。

`read_resilient` 支持 content/interactive/table 和可选 root，只对明确未派发的文档变化、旧引用、页面未就绪等读取错误最多尝试三次；验证码、登录、权限、配额和未知结果停止。返回 completed/reason/attempts/page/recovery；恢复成功只代表页面重新可读，不代表原业务成功。已有写入、原有用户页面、浏览器重连恢复的旧页面均保护现场。

`run_steps` 默认启用保护，单独使用旧 helper 需先调用 `execution_status` 或恢复 helper。启用后，该扩展实例内已启用任务按 HTTP(S) 同源共享访问预算，非跨浏览器全局限流；独立 API 请求不在浏览器动作节流范围。顶层同源 Document/XHR/Fetch 的 429/503 和可见频繁提示触发降速，忽略第三方、静态资源及子会话信号。遵守 Retry-After 秒数/HTTP 日期，初始间隔 500 毫秒，重复信号指数增加至 30 秒，并发从四降为一。最多排队 16 个动作；等待超过五秒返回 access_cooldown，未派发。冷却结束后每四个相关成功响应逐步减半，超长冷却要求人工处理。

连续三个已知未派发失败熔断 30 秒，状态查询不清零。相同目标的点击、导航或滚动连续三次未改变摘要时，停止后续动作，返回 execution_no_progress。摘要只覆盖前 256 个可见文字节点、最多约 8000 字符和滚动位置；变化能解除停滞判定，因此它是循环保护，不能证明业务结果。步骤回执保留已执行动作，不因保护停止而改写送达事实。

保护状态和同源预算有固定容量，仅在扩展内存中保存；扩展重启不持久化节流和循环计数。重启后的旧标签不再具备自动刷新资格，原有持久未知结果屏障继续生效。容量不足返回 guard_capacity，不放行绕过。

## 后台执行

普通任务的输入队列只串行执行，不自动切换活动标签、不恢复或聚焦工作窗口。键盘、编辑器及原始 CDP 键盘/文本输入通过目标页焦点模拟交付，不使用系统前台。SDK/CDP 的 Page.bringToFront 和 Target.activateTarget 只验证并选择已授权逻辑目标，不提升窗口；Target 激活仍核目标归属。原始 Browser.setWindowBounds、Target.createTarget 和 Target.sendMessageToTarget 在自动执行链拒绝，创建工作页改用 new_tab/goto_url 等原有接口。不会因后台输入不可靠而把用户窗口切走或重放未知动作。

自动审批提示使用不聚焦的扩展面板和通知，任务仍等待真实批准；用户点击通知、主动打开待确认或查看任务页时可以聚焦。连接时显式请求的浏览器授权管理窗口保留原有确认流程。旧策略实测 window.open 独立窗口会提升浏览器前台。新候选默认采用 [网页弹窗策略](popup-policy.md)：在已验证的新建顶层工作页中后台接管明确安全的同源调用，不兼容时暂停；用户显式兼容模式仍允许前台窗口。已有文档、框架及浏览器/系统原生对话框未获得全场景静默保证，不通过事后抢回焦点掩盖干扰。

## 验证

离线回归见 `tests/v1.1-script-lane/test_workflow.py`，另有实际脚本子进程与宿主、绑定实例/代次及旧能力拒绝回归。真实浏览器 runner 使用打包产物、本地合成页面、临时 profile 和显式私有 TMPDIR：

```sh
node tests/v1.1-script-lane/real-workflow.mjs
node tests/v1.1-script-lane/real-workflow.mjs --edge
node tests/v1.1-script-lane/real-resilience.mjs
node tests/v1.1-script-lane/real-resilience.mjs --edge
```

同机对比分散三次脚本、原有单次批处理与一次 run_steps，保存各三轮耗时；这不是模型端到端、第三方网站或生产业务的提速证明。个人安装和公开发布另行验收。
