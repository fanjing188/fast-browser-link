# 页面读取与定位恢复

页面正文、站点声明、属性文本、脚本结果和诊断内容原样返回。不存在内容过滤开关、区域屏蔽规则或内容保护拒绝。

`input[type=password]` 的值不在任何输出中回显，出现处替换为 `[password]`。

密码、支付、验证码字段保留保护：按 `type`、`autocomplete`（current-password/new-password、`cc-*`、one-time-code）以及 name、id、label、placeholder、aria 说明中的关键词（如 password/密码、cvv/卡号、otp/验证码）判定。语义快照对这类字段只返回 `fieldKind` 和 `inputRequired: vault_or_user`，`actions` 为空；对它们执行 `ref_fill`、`ref_press` 不会写入，而是返回 `user_input_required`，由浏览器提示用户亲自填写，用户点"我已填写"后用相同参数再查询得到 `completed_by_user`。启用 Vault 时可改用凭据工具填写。

覆盖率不足、不可检查的 frame、Shadow DOM 或未知几何通过 `coverage` 描述，不以此拒绝整次读取。

同一任务页允许跨站导航。任务、会话和标签页租约隔离仍有效；暂停、停止和撤销必须生效。

定位失败由插件自动等待稳定、重扫、重新定位并恢复，最多三轮。歧义时选择最匹配且可见、在视口内、未遮挡的候选。`recovery` 返回轮数、定位方式、点击方式和候选信息。

仍失败时查看尝试策略、最接近候选及截图路径；换描述重找，或记录并跳过该项继续任务。已派发但结果未知的写入只回读核实，不盲目重复执行。
