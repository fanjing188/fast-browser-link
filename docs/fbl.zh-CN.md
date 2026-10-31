# fbl 命令参考

需要 Python 3.11+ 与 macOS Chrome/Edge。在已校验包中运行 `python3 -B -m fbl`，安装后可运行 `fbl`。浏览器底座不会安装或启动 Fast-browser-assist。

| 命令 | 行为 |
| --- | --- |
| `fbl setup [--yes] [--dry-run] [--agent-profile 名称]` | 安装底座运行时，并向已检测到的 Agent 目录安装 FBL 浏览器技能；保留未知或修改过的技能。显式指定的 Hermes profile 只安装核心技能，不配置推理模型。 |
| `fbl update --dry-run` | 预览已安装运行时、扩展、技能和未结清浏览器任务，不修改内容。 |
| `fbl update [--source 发布包目录] [--wait 秒数] [--pause-hermes] [--yes]` | 校验发布包与任务清理证据后，以事务方式交换受管运行时文件；可安全回滚时恢复旧文件。旧 Assist 数据和 profile 保持原样。 |
| `fbl doctor [--fix]` | 检查宿主清单、daemon、浏览器连接、版本与完整性。fix 只修受管清单，可启动已核实为空闲的 daemon。 |
| `fbl logs [--follow] [--type system\|execution\|capture] [--errors]` | 有界读取固定字段的浏览器诊断；不包含旧协作日志。 |
| `fbl logs --bundle [输出.zip]` | 向私有目录导出固定字段的浏览器诊断 ZIP，不含页面正文、凭据或原始 stderr；不覆盖已有文件。 |
| `fbl browser [--session 文件] 操作 [JSON]` | 无 Hermes 的核心浏览器入口；先 browsers，再 create/get/run，最后 close。 |
| `fbl mcp install --agent codex\|claude [--dry-run\|--apply]` | 预览或显式安装 FBL MCP 接入。 |

每个命令可使用 `--user-home`、`--hermes-home`、`--runtime` 和 `--source` 指向隔离测试或明确安装位置。`update --source` 仅接受摘要已校验的发布包，不接受源码目录。升级不会按任务年龄猜测可清理状态；必须核实浏览器纪元和清理证据，身份不明或出现新任务时保留备份并拒绝不安全回滚。

Fast-browser-assist 是独立产品。它通过 FBL 的有界产品连接配对；每次浏览器动作仍受 FBL 任务授权、接管、停止和未知结果规则约束。参见[浏览器底座](browser-core.md)与[安装说明](installation.zh-CN.md)。
