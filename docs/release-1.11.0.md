# Hermes Browser Link 1.11.0

2026-10-11。

## 改动

- 移除 content-shield、content-filter 的执行和发送拦截、设置及弹窗开关；页面文本不再按指令、站点声明、data-private 或令牌格式过滤。
- 任务动作默认允许，登录小窗 `popup_adopt` 直接接管；工作页可跨站导航，保留任务、会话、代次和标签页租约校验。
- 跨源 iframe 经 CDP 读取，覆盖不再因跨源小框架标记为不完整。
- 密码、支付、验证码字段保留保护（`inputRequired: vault_or_user`，不可直接填写），读取结果不回显其值。
- 定位失败最多恢复三轮：300/800/1500ms 退避、DOM 静默等待、frame/Shadow DOM 重扫、候选排序、滚动、Escape、关闭遮罩（含 Close cookies、Accept all、同意、知道了等按钮）、DOM 点击。重扫与动作使用同一执行上下文。
- 动作回执增加 `recovery`（每轮附失败原因）；失败附策略、候选和可用截图。已派发且结果未知的写入先回读，不重复派发。
- 点击已送达但页面无可见变化时按成功返回 `effect: unobserved` 并附提示，不再报 `click_no_effect` 错误。
- 点击/按键导致页面跳转（含跨站换进程）时，按成功返回 `navigation` 与新 `url`，不再报 `page_not_ready`。

## 验证

- `TMPDIR=/tmp npm test`：Node 与全部 Python 清单通过。
- 真实浏览器（Chrome、Edge，临时 profile）：`tests/v1.11.0/real-recovery-1110.mjs` 8/8；`real-login-windows` 29/29；`real-tabs-interaction` cookie 横幅场景 100/100；`real-page-chains`、`real-forms`、`real-complex-ui`、`real-session`、`real-background-input` 通过。
- `real-concurrent`、`v1.1-advanced/real-recovery` 在 1.10.3 上同样失败（审批面板/daemon 重启夹具），非本版回归。
