# Fast-browser-link 1.11.0

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

### 页面解析与交互增强（参考 Hermes 桌面预览栏）

- 交互可见性：交互清单排除透明、clip/clip-path 隐藏、读屏专用、宽或高小于 3px、aria-hidden/inert 的控件；透明的原生复选框/单选框通过可见 label 保留。视口内中心点被网页元素遮挡的控件保留并标 `blocked: "occluded"`、`actionable: false`（插件自身浮层不算遮挡）。页外隐藏按文档与滚动容器坐标判断，滚出视口的控件照常列出。定位恢复的候选筛选使用同一函数。
- 增量快照：按 UTF-8 序列化字节比较，delta 严格小于 full 时才返回 delta；分页、参数变化与 cursor 失效仍重新同步。
- 动作后回读：`click`、`fill`、`press` 及 `ref_*` 动作接受可选 `after={root, mode, budget}`（mode 为 interactive/content/table，budget 512–6000），回执附带 `observation`；不传时回执不变。回读失败只写入 `observation.error`，不改变送达结果、不重发动作；导航或文档替换后重新绑定。
- 富文本填写：contenteditable 目标改为聚焦、全选目标内容后通过受控输入通道 `Input.insertText` 输入，按稳定回读核对；不再写 `textContent`，不使用 execCommand 或自动提交。核对不一致时返回 `delivery: "unconfirmed"`，不补写。
- 许可：部分交互判断改编自 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research），声明见 `THIRD_PARTY_NOTICES.md` 与 `third-party/licenses/hermes-agent-MIT.txt`，随扩展与安装包分发。

## 验证

- `TMPDIR=/tmp npm test`：Node 与全部 Python 清单通过。
- 真实浏览器（Chrome、Edge，临时 profile）：`tests/v1.11.0/real-recovery-1110.mjs` 8/8；`real-login-windows` 29/29；`real-tabs-interaction` cookie 横幅场景 100/100；`real-page-chains`、`real-forms`、`real-complex-ui`、`real-session`、`real-background-input` 通过。
- `real-concurrent`、`v1.1-advanced/real-recovery` 在 1.10.3 上同样失败（审批面板/daemon 重启夹具），非本版回归。
- 页面解析增强合入后复验：`npm test` Node 935/935、Python 全部通过；`tests/parsing-port/real-s1-s4.mjs`（含 Tiptap 2.11.5、ProseMirror、Lexical 0.23.1 真实编辑器）Chrome、Edge 均 10/10；`real-recovery-1110` 8/8、`real-forms` 12/12、`real-login-windows` 29/29，`real-complex-ui`、`real-page-chains`、`real-tabs-interaction` 通过，与合入前一致。
- 未验证：Windows/Linux；真实网站上的业务保存结果（富文本仅核对编辑器内部内容）。
