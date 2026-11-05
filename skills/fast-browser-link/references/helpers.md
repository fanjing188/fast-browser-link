# Script helper 签名与返回值

本表列出 script 注入的全部函数。`tab=None` 使用当前选定任务页；失败抛 BrowserError，检查 code、outcome_unknown、stage 和 reason_code；retryable 查看原始回执，BrowserError 不提供该属性。回执字段只在适用动作出现；动作回执不等于业务成功。

| 签名 | 返回值 / 字段 |
| --- | --- |
| `parallel(fn, tabs)` | Call fn(tab) concurrently, returning input order; aggregate failures without retries. |
| `new_tab(url)` | Open a work tab on an approved origin; returns the numeric tab id. |
| `open_page(url, *, wait_for='load', timeout_ms=15000)` | 打开工作页并返回 tabId、ready 与等待结果。 |
| `use_tab(tab_id)` | Select the current owned work tab; prefer explicit tab= for parallel work. |
| `current_tab()` | Return the explicitly selected work-tab id without guessing the active tab. |
| `focused_window(tab=None, max_ms=120000)` | 上下文管理器：连续动作保持可见，退出或异常时恢复；租约到期或任务关闭时 daemon 兜底恢复。 |
| `focus_window(*, restore=True, hold_ms=1000, tab=None)` | 临时置前任务页，返回 focused、visible、previousWindowId、restored；未恢复时可有 restoreReason。 |
| `goto_url(url, *, summary=True, tab=None)` | Navigate the work tab to an approved origin. |
| `wait_for_load(timeout=15.0, *, until='interactive', tab=None)` | Wait until document.readyState reaches until; returns the final state.  The default 'interactive' returns once the DOM is parsed and readable; pass until='complete' only when images/ads/analytics must finish too. A slow page may replace its document while loading; those transient errors are polled through until the deadline instead of failing. |
| `page_text(*, tab=None)` | 返回 dict {url, title, elements, ...}；最小读法 print(page_text()['elements'][:5])，不能切片 dict。 |
| `semantic_snapshot(tab=None, **options)` | 返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}。query 按可访问名称/文本筛选，role 或 roles 筛角色，limit 默认 20、上限 200；保持原选项并传 cursor=coverage['nextCursor'] 续读。coverage.hidden/queryFiltered/omitted 区分不可见、筛选和截断。 |
| `parse_page(tab=None, **options)` | 返回 dict {schemaVersion,parseId,binding,regions,blocks,tables,forms,collections,records,coverage,warnings,nextCursor}；只读取指定 sections/root，结果引用仅作为来源证据。 |
| `page_markdown(tab=None, **options)` | 返回 markdown、coverage、nextCursor、warnings。 |
| `extract(schema, tab=None, **options)` | 返回 parse_page 的 dict；读 result['records']，每项含 fields/states/sources/valid；核对 coverage/warnings/nextCursor，不能把 sourceRef 用于写动作。 |
| `evaluate(function, arguments=None, *, world='isolated', timeout_ms=10000, frame_token=None, tab=None)` | 返回函数的 JSON 值；evaluate('(selector)=>document.querySelector(selector)?.textContent', '#result') 用 arguments 传数据。isolated 共享 DOM、不共享网站 JS 全局变量；main 仅确需网站变量时显式指定，禁止错误后自动切换。 |
| `network_start(*, tab=None)` | 开始主标签网络观察；返回 captureId，供后续调用防止串用游标。 |
| `network_list(capture_id, *, after_sequence=0, limit=20, filter='', tab=None)` | 只读摘要不返回请求头；cursor 表示更新序号，seq 表示请求标识。 |
| `network_detail(capture_id, seq, *, part='response', start=0, max_chars=8000, tab=None)` | 按摘要序号返回 captureId、body（text、nextStart 等）；正文及 URL 可能含敏感数据，不重新发送请求。 |
| `network_stop(*, tab=None)` | 清空本任务页捕获缓存，不关闭其他等待器使用的 Network 域。 |
| `page_request(url, *, fields, method='GET', max_bytes=65536, timeout_ms=10000, tab=None)` | 连接授权后直接执行同源 GET/HEAD 的有界 JSON 字段读取；不推断业务无副作用。 |
| `wait_for(selector, *, state='present', text=None, count=None, timeout=10, interval=0.25, tab=None)` | 声明式只读等待，不重试点击、填写或提交；返回 dict {satisfied, timed_out, last_observation, coverage, reason}；timeout 为 (0,60] 秒，state=present/absent/text/count/stable。satisfied=false 后改定位或停止，不重复等同一条件。 |
| `expect_response(url=None, *, timeout=15, tab=None)` | 返回上下文管理器；with 结束后 result 有 request_id、status、correlation。 |
| `expect_navigation(url=None, *, timeout=15, tab=None)` | 返回上下文管理器；with 结束后 result 有 frame_id、loader_id 或 same_document，以及 correlation。 |
| `frame_catalog(*, tab=None)` | 列出当前任务页的 frame 及可用的不透明引用。 |
| `popup_catalog(*, tab=None)` | 仅列出授权源页新建的独立登录弹窗元数据，不读取内容或接管。 |
| `popup_adopt(candidate_ref, *, tab=None)` | 登录弹窗直接接管，无需确认（含白名单外及已发现的现有窗口）。 白名单自动接管时直接 use_tab(popupOpened["tabId"]) 并重读；其他候选先调用 popup_catalog， 再 popup_adopt，显式 use_tab(回执['tabId']) 后重新 read_page 核实权限与内容。 成功回执只交付一次；未知结果不重发接管，也不另开登录网址。 |
| `read_page(*, query='', root=None, mode='content', budget=3000, cursor=None, tab=None)` | 返回 dict {binding, snapshotId, items, coverage, nextCursor, ...}，与 semantic_snapshot 相同；print(read_page(root='#results')['items'][:5])。 |
| `wait_for_element(name, *, role=None, root=None, exact=True, timeout=10.0, tab=None, action=None)` | 返回 snapshot、ref 和 recovery 等；timeout=0 只读一次。 |
| `click_element(name, *, mode='pointer', after=None, tab=None, **options)` | 按名称/角色点击一次；effect=observed 表示观察到效果；effect=unobserved 表示已点击但未见页面变化，先读页面核对。 |
| `fill_element(name, text, tab=None, *, after=None, **options)` | 按名称/角色定位后填写；helper 动作禁用自动关闭遮挡层。 |
| `scroll(direction='down', *, tab=None)` | 复用受控页面滚动；滚动后重新定位，不沿用旧元素引用。 |
| `click(selector, *, after=None, tab=None)` | 返回动作回执；可按动作检查 delivery、effect、verified、observation。 |
| `fill(selector, text, *, after=None, tab=None)` | 返回动作回执；可按动作检查 delivery、effect、verified、observation。 |
| `press(selector, key, *, after=None, tab=None)` | 返回动作回执；可按动作检查 delivery、effect、verified、observation。 |
| `ref_click(snapshot, ref, *, mode='pointer', after=None, tab=None)` | 按语义引用点击一次；依据实际送达回执区分交付方式。 |
| `ref_fill(snapshot, ref, text, *, after=None, tab=None)` | 返回动作回执；可按动作检查 delivery、effect、verified、observation。 |
| `ref_press(snapshot, ref, key, *, after=None, tab=None)` | 在当前语义目标上派发按键；已派发结果未知时先回读核实。 |
| `ref_set_checked(snapshot, ref, checked, *, after=None, tab=None)` | 设置当前语义引用的复选状态；结果由页面状态回读确认。 |
| `ref_select_option(snapshot, ref, values, *, by='value', after=None, tab=None)` | 按 value、Unicode 标签或零基 index 选择原生选项，并由页面状态回读确认。 |
| `upload_files(selector, artifact_ids=None, *, paths=None, tab=None)` | 把文件选择进当前任务页：用户在对话中给出的本地路径（paths），或已登记的文件 ID；网站接收结果须另行读取。 |
| `downloads()` | 列出本任务已归属的下载（不含本机路径）与归属未知的计数。 |
| `wait_for_download(timeout=30.0, *, ignore=())` | 等待一项本任务新完成的下载；ignore 为调用前已见过的下载编号。只读轮询，不触发下载。 |
| `claim_download(download_id, dest=None)` | 领取已完成的下载并复制到工作目录；返回相对路径与摘要。中断或变化的文件不能领取。 |
| `cancel_download(download_id)` | 取消本任务仍在进行的一项下载；不影响用户自己的下载。 |
| `js(expression, *, world='isolated', await_promise=True, timeout_ms=10000, frame_token=None, tab=None)` | 在任务页运行 JavaScript；连接授权后直接执行，凭据页排斥与敏感字段保护仍生效。 |
| `cdp(method, frame_token=None, tab=None, **params)` | 原始 CDP 方法；连接授权后直接执行，任务租约、来源和凭据保护仍生效。 |
| `cdp_events(max=200, *, cursor=None, tab=None)` | 读取本任务页已订阅的 CDP 事件。cursor=0 开始分页，随后传回执 cursor，循环到 hasMore=false；每页最多 500 条且 256 KiB。游标日志最多 10000 条/8 MiB，仅内存保存；超限或单事件过大时 dropped/lostRanges 明示缺口，requestState.state=unknown 表示缺口之前开始且尚未见终结的请求状态未知。省略 cursor 保持旧的 500 条消费队列及 dropped 语义，互不消费游标日志。 |
| `export_page(path='page-export.zip', *, tab=None, max_bytes=32 * 1024 * 1024, max_resources=200)` | 保存当前顶层渲染 DOM 与已加载资源的私有离线 ZIP；回执不含页面正文。 |
| `screenshot(path='shot.png', *, tab=None, name=None, selector=None)` | 保存视口截图到工作区或配置的导出根，返回绝对路径。 |
| `reconcile(*, tab=None)` | After BrowserError.outcome_unknown: read the page to check what happened, then continue. The uncertain action itself is never resent. |
| `operation_status(request_id=None)` | 只读查询最近一次或指定请求的持久账本；不重发动作。 |
| `reconnect(timeout_s=30.0)` | 在当前 Python 栈内等待同一任务恢复；返回后仍需核实未知写入。 |
| `load_checkpoint()` | 读取 Hermes 为本次协作式续跑显式提供的业务检查点。 |
| `wait_pending(timeout_s=20.0, *, tab=None)` | Wait for the same approval/manual-input request (max 300 s), without creating a new action. Sensitive-field manual input returns the original receipt. Login-window adoption runs directly without confirmation and does not need this helper. Unknown outcomes are never replayed. |
| `popup_status(*, tab=None)` | 只读查询弹窗模式、保护覆盖与暂停原因；切兼容模式仅允许用户在扩展界面操作，不重放被拦动作。 |
| `business_progress(selectors=None, *, tab=None)` | 绑定业务进度选择器（最多8个，可选 data-* / id / aria-rowindex 属性）；只回摘要，配置不可中途替换。 |
| `run_workflow(name, steps, *, resume=False, budget=None, progress=None, tab=None)` | 持久检查点与预算执行；同任务/实例/代次/标签恢复，已确认步骤跳过，在途或未知步骤冻结；自动保存JSON/Markdown报告。 |
| `run_batch(name, items, *, resume=False, budget=None, progress=None, tab=None)` | 最多100条独立项目，每项最多16步；仅已知未派发失败可继续其他项，未知/人工/熔断停止，续做跳过已确认步骤。 |
| `workflow_report(name, *, tab=None)` | 读取当前绑定任务的持久验收报告和待核实位置；不恢复授权，不发送浏览器动作。 |
| `extend_workflow_budget(name, budget, *, tab=None)` | 显式调整已停止流程的预算；不清除已花费次数/耗时，不解除在途或未知步骤。续做时传相同新预算。 |
| `reconcile_workflow(name, items, *, timeout=10, tab=None)` | 显式只读澄清原在途步骤；先完成原生请求reconcile，再用原计划的all后置条件验证，不补发动作。items格式与run_batch一致。 |
| `save_site_recipe(name, steps, *, tab=None)` | 记住当前同源已完整读取的定位模板；fill只存value_key，不存填写值、页面引用或业务正文。 |
| `run_site_recipe(name, values=None, *, workflow_name=None, resume=False, budget=None, tab=None)` | 复用当前同源模板前重核页面结构和定位；结构变化拒绝，填写值本次传入，所有写入取得新引用。 |
| `verify_download(download_id, *, expected=None, dest=None)` | 领取本任务下载后核大小/摘要、CSV/JSON记录数/列/ISO日期范围；ZIP检查CRC，PDF/图片仅校验签名，失败保留文件。 |
| `wait_until(conditions, *, mode='any', timeout=10, interval=0.25, tab=None)` | 统一有界等待：element/url/response/download/popup，any/all；事件仅匹配调用后新发生的证据。 |
| `diagnose_target(name, *, role=None, root=None, action='click', tab=None)` | 只读定位诊断，返回范围完整性、歧义、遮挡、禁用/只读及建议，不创建写入资格。 |
| `run_steps(steps, *, timeout=60, tab=None)` | 最多16步操作及前后条件；整组预检、事件先监听、首错停止，返回步骤回执，未知动作不重放。 |
| `execution_status(*, tab=None)` | 启用并读取任务保护：页面故障、刷新资格、同站冷却/并发与循环熔断；不回传正文或输入值。 |
| `recover_page(*, timeout=15, tab=None)` | 有界重新读取，最多一次受保护刷新；草稿、人工状态、既往写入及未知结果不刷新，不重放动作。 |
| `read_resilient(*, mode='content', root=None, timeout=15, tab=None)` | 最多三次只读恢复，返回 page/attempts/recovery；未知结果立即停止，不恢复授权或补发写入。 |
