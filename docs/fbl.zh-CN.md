# fbl 命令参考

需要 Python 3.11+ 与 macOS Chrome/Edge。在校验过的解压安装包内使用 `python3 -B -m fbl`；setup 后可用 `fbl`（把 `~/.local/bin` 加入 PATH）。源码构建需要 Node，安装后的维护命令不需要。本候选尚未发布。`-B` 禁止缓存写入，保持已校验安装包的完整文件清单。

| 命令 | 作用 |
| --- | --- |
| `fbl setup [--yes] [--dry-run] [--seo]` | 检测 agent 技能目录，缺运行时时安装核心；只创建/维护带标记的专用 Hermes profile，从实际可用模型元数据选快速模型；默认通用包、SEO 可选；发现并确认工具，打印就绪和能力体检。`--yes` 只默认确认可用、零成本、高置信候选。 |
| `fbl update --dry-run` | 列出已安装运行时、适配器、扩展与技能，并按进行中、停 daemon 后可通过、需要核实分类任务；不停 daemon、不结清任务、不下载、不替换。 |
| `fbl update [--source 安装包目录] [--wait 秒数] [--pause-hermes] [--yes]` | 校验预构建包，先拒绝进行中的任务；已关闭且清理成功的残留历史在停 daemon 后复核。旧浏览器纪元且清理 unknown/failed 的任务需交互确认或 `--yes`，备份后按 tasks:ack 规则结清。持锁、可选暂停调度、备份、只停身份核实的自家 daemon；原子替换，迁移受管模板/profile，导入校验并恢复原先运行的 daemon。失败回滚；新任务或未知进程阻止不安全回滚，保留备份。 |
| `fbl doctor [--fix]` | 逐环诊断；fix 修受管宿主清单、profile 和模板，可启动已核实为空闲的缺失 daemon。保留 Hermes 迁移模型、配置版本、其他键和认证。 |
| `fbl logs [--follow] [--type system\|execution\|inference\|capture\|stderr] [--errors]` | 有界查看/跟随事件及本机脱敏 stderr，不启动模型。 |
| `fbl logs --bundle [输出.tar.gz]` | 私有诊断包：固定诊断码、事件数字字段、stderr 类型摘要与配置存在性；不含页面正文、凭据、原始 argv、任意异常正文；不覆盖已有包。 |
| `fbl packs list` | 列出内置包和本机包。 |
| `fbl packs install general` / `seo` / `本机包目录` | 校验、安装并登记程序生成的运行时路径；修改过的受管文件保留。 |
| `fbl packs remove 包ID` | 只移除摘要仍匹配的受管包及登记路径。 |
| `fbl packs init [ID] [--argv JSON] [--capability 能力名] [--url 地址]` | 在正确运行时生成经校验的骨架，检查脚本路径存在；审阅/安装后使用。 |
| `fbl packs discover [--url 地址] [--scan-tabs] [--no-draft] [--yes]` | 读技能声明/帮助、MCP schema 和用户勾选的网页布局；确认屏列依据、来源、置信度、成本、验证结果，可编辑参数。未知/付费候选默认不勾。 |
| `fbl browser [--session 文件] 操作 [JSON]` | 无 Hermes 的核心浏览器入口；先 browsers、create/get、run，最后 close。会话文件私有，JSON 不接受自填 owner。 |

每个子命令都接受 `--user-home`、`--hermes-home`、`--runtime`、`--source`，用于明确安装或临时夹具；拒绝目标软链接。不要修改 HOME 或绕过门禁。`update --source` 接受完整已校验安装包，不接受源码目录；省略 source 时由既有下载校验器读取固定项目的最新稳定版本。

setup 不复制凭据。没有 Hermes 时核心技能可用，协作待处理；专用 profile 无归属标记则保留。模板冲突保留 `.json.new` 待手工合并，技能修改阻止覆盖。升级提示重新加载时去扩展管理页操作，Python 不能绕过浏览器策略。

侧栏首次清单与“设置 › 本机能力 › 发现”也可审阅候选。修复后重开清单刷新状态；确认绑定后关闭协作并重读声明。doctor 比较本地文件、帮助和 MCP schema；开启协作立即检查本地文件/新技能，后台有界刷新帮助/MCP 元数据。doctor 可在已连接时刷新此前确认的网址表头；新网址/标签扫描需要授权，未检查不能称为未变化。参见[排障](fbl-troubleshooting.zh-CN.md)与[技能包开发](fbl-packs.zh-CN.md)。

升级不会根据“几天前的任务”猜测会话失效。只有同用户 Chrome/Edge 主进程的启动时间可核实，任务创建、更新时间及已记录的操作时间均早于所有运行中浏览器的最早启动时间，且无许可、待人工输入或未结束操作，才允许列为可安全结清。浏览器不运行、进程读取受限或证据不全时保留待核实；不会自动结清当前会话或非终态任务。确认后仍在停稳 daemon、持其启动锁时重读并复核，任务有变化须重新确认。任务备份及 `userVerified` 记录保留；后续程序升级失败回滚也不会撤销用户已确认的任务结清。

手动安装缺少运行时版本登记时，doctor 的版本和完整性项显示 `unregistered` 信息及 `fbl update --source <包>` 建议，不代表已验证完整性。首次就绪检查仍等待版本登记。profile drift 显示当前模型、推理强度、受管字段差异和修复策略；有旧模型记录时显示迁移前后，缺记录时不推断旧模型。`--fix` 保留当前模型、提供商、较新的配置版本和非受管字段，恢复专用 profile 的受管约束。


功能插件的安装、初始化、管理和开发标准见 [功能插件与技能适配包](adapter-packs.zh-CN.md)。
