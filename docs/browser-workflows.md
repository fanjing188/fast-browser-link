# 通用观察、组合操作与定位诊断

2.6.0 候选新增三个 Python helper：`wait_until`、`run_steps`、`diagnose_target`。SDK、JSON CLI、MCP 和 Hermes 都通过原有 `script` 执行链调用；没有新增常驻工具或第二套浏览器执行器。宿主先核本任务绑定实例的 `browser_workflow_v1`，旧组件返回 `workflow_unsupported`，不切换执行方式。需要同时升级宿主和扩展。

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

## 验证

离线回归见 `tests/v1.1-script-lane/test_workflow.py`，另有实际脚本子进程与宿主、绑定实例/代次及旧能力拒绝回归。真实浏览器 runner 使用打包产物、本地合成页面、临时 profile 和显式私有 TMPDIR：

```sh
node tests/v1.1-script-lane/real-workflow.mjs
node tests/v1.1-script-lane/real-workflow.mjs --edge
```

同机对比分散三次脚本、原有单次批处理与一次 run_steps，保存各三轮耗时；这不是模型端到端、第三方网站或生产业务的提速证明。个人安装和公开发布另行验收。
