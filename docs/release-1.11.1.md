# Fast-browser-link 1.11.1

2026-10-12。macOS 稳定版补丁，修复 1.11.0 中误删的两项保护。

## 改动

- **敏感字段人工填写**：对密码、支付、验证码字段（`inputRequired: vault_or_user`）执行 `ref_fill`、`ref_press` 时，重新进行只读预审，返回 `user_input_required` 并由浏览器提示用户亲自填写；用户点"我已填写"后，用相同参数再查询得到 `completed_by_user`。预审不发送输入文字，并在同一状态锁内核对暂停、代次、模式、租约与撤权。1.11.0 中这类请求只返回 `sensitive_target` 错误，不会提示用户。
- **凭据页脚本排斥**：Vault 填写过凭据的标签页，`PageRuntime` 在登记脚本资源前即拒绝任意脚本与 CDP 目标访问；先跑脚本再用 Vault、先用 Vault 再跑脚本两种顺序都被拒绝。1.11.0 中只在目标列表里排除，直接调用未拦截。
- **登录弹窗**：所有登录弹窗（含 OAuth 白名单外的候选及已发现的现有窗口）通过 `popup_adopt` 直接接管，无需确认；白名单内由本任务新打开的授权页仍自动接管。租约、代次、任务归属、`popup_stale` 与回源校验不变。`fast_browser_run` 工具描述、`fast-browser-link`/`troubleshoot` 技能和文档已统一。Cookie 镜像仍需单独确认。
- **测试与门禁**：完整离线门禁（`npm run verify`）中按 1.11.0 已删除的行为（内容过滤与脱敏、普通动作审批、跨站导航冻结等）断言的旧用例，改为断言放开后的行为或删除；打包相关测试夹具补入 `THIRD_PARTY_NOTICES.md` 与 `third-party/`。

其余行为与 1.11.0 相同，包括页面解析与交互增强（交互可见性与遮挡标记、增量择优、动作后 `after` 回读、富文本真实输入）。

## 安装

下载 `fast-browser-link-1.11.1.zip`，解压后运行 `./install.sh`；已有安装运行 `./install.sh --upgrade`。更新后扩展会自动重载；如修改了桌面插件页，重启 Hermes 桌面应用。仅在 macOS 上验证。

## 验证范围

- `npm test`：Node 933/933，Python 全部通过，API 参考无漂移。
- `npm run verify`（完整离线门禁，本机 Hermes 源码）：105 组全部通过，`passed=True`。`tests/v1.11.0` 的两个 Python runner 已登记进复审清单与覆盖矩阵。
- 真实浏览器（Chrome/Edge，临时 profile）：`tests/parsing-port/real-s1-s4.mjs` 均 10/10；`real-recovery-1110` 8/8、`real-forms` 12/12、`real-login-windows` 29/29，`real-complex-ui`、`real-page-chains`、`real-tabs-interaction` 通过。
- 敏感字段实测（Chrome）：对密码框 `ref_fill` 返回 `user_input_required` 且字段未被写入；1.11.0 同一操作返回 `execution_denied`。
- 未验证：Windows/Linux。`tests/native-v2/real-native-v2.mjs` 在 1.11.0 与本版均于下拉选项步骤失败（`select_option_missing`），为既有问题，未在本版处理。
