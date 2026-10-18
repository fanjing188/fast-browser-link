# 逐环排障

先运行 `fbl doctor`，按失败项的命令处理。`--fix` 只修受管配置，可在空闲/进程身份门禁通过后启动缺失 daemon；不安装软件、不登录、不停止未知进程、不改选中模型。侧栏“修复”只修配置，不启停服务。

| 组件 | 核对与处理 |
| --- | --- |
| runtime / runtime_integrity | 宿主闭包缺失或改变：先 `fbl update --dry-run`，使用完整校验包。 |
| host_chrome / host_edge | Native 清单应指向自家可执行文件及唯一扩展来源。fix 可重建缺失受管清单；损坏/外来清单保留人工核实。 |
| daemon | 缺服务时 fix 可在门禁通过后启动；超时仅为未确认，不能判已退出。未知 PID/socket 拒绝自动动作。 |
| extension / version | 打开浏览器，加载输出目录并连接；升级后重新加载，宿主与扩展版本应一致。 |
| runtime_root | 多个清单指向不同运行时，显式选择并核对注册，不按哪个 socket 在线猜测。 |
| hermes / models | 核心浏览器不依赖 Hermes；单独配置后再 setup，从实际模型清单选择。缓存模型元数据不证明实时可用。 |
| Hermes profile (`fast-copilot`) | 只合并有标记的专用配置，保留迁移模型和版本，恢复 ACP 零工具、关闭标题和 low 推理。未知 profile 不写。 |
| templates | `.json.new` 需要人工合并；fix 升级摘要匹配项，保留用户原文。 |
| packages | 用 install/discover 登记正确本机路径；私人工具不复制到公开仓库。 |
| logs | 核对目录归属/可写性，不自动提权或改无关权限。 |
| discovery | 脚本/帮助/schema 变化或新技能需重新发现确认；不自动改绑定；网页结构需再次显式授权刷新。 |
| cloud | 从未配置不阻塞；一旦有数据、注册或 fence，继续执行原严格云端收尾门禁。 |

`fbl logs --errors` 查错误，`--follow --type stderr` 供本机查看；分享使用 `--bundle`，排除任意 stderr 正文、页面数据和凭据。诊断包保持私有。重连成功不证明中断任务完成；先回读页面和账本，未知写入禁止重放。

升级在 `fbl-backups` 留日期备份，错误输出含备份路径。若新任务/未知进程使回滚无法核实，保留文件并报告，不删除锁、重置文件或停无关进程。普通失败回滚后先 doctor 再恢复业务。

stderr 写入 `logs/<日期>.agent-stderr.log`，读取兼容旧 `.hermes-stderr.log`；仍为 2 MiB 轮转、一个归档、保留七天。
