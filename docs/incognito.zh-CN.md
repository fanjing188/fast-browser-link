# 使用无痕任务

先在扩展详情允许“无痕 / InPrivate”。CLI/MCP 的 `create` 传 `incognito: true`；可选 Hermes open/create 工具传 `incognito=true`。缺权限返回 `incognito_access_required`，不会改用普通窗口。

无痕不会继承普通 Cookie，同一浏览器的无痕任务仍共享无痕会话。工作页隔离不等于账号隔离；任务元数据、日志和下载文件可能保留。密码、支付、验证码和最终提交由人工完成。

核心读取、表单、文件和导航使用相同执行器。夹具成功不代表所有第三方网站或 Agent 版本已验收。详见[边界与验收](design/incognito.zh-CN.md)、[连接排查](fbl-troubleshooting.zh-CN.md)。[English](incognito.md)
