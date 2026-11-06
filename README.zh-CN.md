# Fast-browser-link

**让你的 AI Agent 操作本机已经登录的 Chrome 或 Edge。**

[English](README.md) · [安装说明](docs/installation.zh-CN.md) · [下载正式安装包](https://github.com/fanjing188/fast-browser-link/releases)

你在 Codex、Claude Code 等 Agent 中描述任务，Fast-browser-link 负责把页面读取、点击、填写和文件操作送到你的浏览器，并把结果返回给 Agent。例如：

> 使用 fast-browser-link，读取我当前打开的页面，把表格整理成 CSV。保留原页面，不提交任何表单。

它由**浏览器扩展 + 本机运行程序**组成，通过 Skill、CLI 或 MCP 接入 Agent。你需要自备能在本机运行工具的 Agent；项目本身不提供聊天模型，也不要求部署云服务器。核心浏览器功能不依赖 Hermes。

```text
你描述任务 → AI Agent → Fast-browser-link → 本机 Chrome / Edge
```

## 可以做什么

| 场景 | 你可以让 Agent 做的事 |
| --- | --- |
| 阅读与采集 | 读取页面正文、表格和表单；逐页采集并整理结果。 |
| 操作网站 | 搜索、点击、填写普通字段、滚动和导航；使用新的页面快照核对目标。 |
| 处理文件 | 上传你指定的文件，下载结果并校验记录数、列或日期范围。 |
| 使用已登录页面 | 复用普通浏览器的登录态；也可明确要求接管当前标签页或使用无痕模式。 |
| 执行长流程 | 组合步骤、等待结果、批量处理、保存检查点、续做和生成报告。 |
| 处理异常 | 在访问频繁时降速，遇到连续失败或没有进展时停止；对符合条件的故障页做受限恢复。 |

**Source version: 2.6.2**。本页介绍当前源码能力；`main` 可能领先于正式安装包，已发布版本以 [Releases](https://github.com/fanjing188/fast-browser-link/releases) 为准。2.6.2 的工作流、恢复和弹窗策略详见[版本说明](docs/releases/release-2.6.2.md)。

## 开始之前

- **系统：** macOS。目前尚未验证 Windows、Linux。
- **浏览器：** Chrome 或 Microsoft Edge。
- **运行环境：** Python 3.11+。使用正式安装包不需要 Node.js；从源码构建需要 Node.js 22.12+。
- **Agent：** 能执行本机工具的 Codex、Claude Code，或其他支持 Skill／MCP／命令行工具的客户端。仅能在云端运行的聊天窗口不能直接访问你的本机浏览器。

## 安装并开始第一个任务

### 1. 下载并解压

从 [Releases](https://github.com/fanjing188/fast-browser-link/releases) 下载 `fast-browser-link-<版本>.zip` 和校验文件，按[安装说明](docs/installation.zh-CN.md)校验后解压。

选普通安装包；GitHub 自动生成的 **Source code** 是源码，带 **-hermes-** 的 ZIP 是可选适配器。若需要尚未发布的源码功能，见下方“从源码安装”。

### 2. 安装本机程序

在解压后的目录打开终端，运行：

```sh
python3 -B -m fbl setup
```

安装器会显示浏览器扩展目录，并为检测到的受支持 Agent 安装 Skill。保留安装器给出的稳定目录；已有安装请走升级流程，不要删除或覆盖数据。

### 3. 连接日常使用的浏览器

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
2. 打开“开发者模式”，选择“加载已解压的扩展程序”。
3. 选择安装器输出的扩展目录。
4. 点击 Fast-browser-link 扩展图标，确认本地连接，检查状态为“已连接”。

### 4. 让 Agent 试一次

重新打开 Agent 会话，让它使用已安装的 `fast-browser-link` Skill。先做一个只读任务：

> 使用 fast-browser-link，打开 https://example.com，告诉我页面标题和主要内容。完成后关闭你新建的任务页。

成功的标志是 **Agent 实际返回网页内容**，而不只是安装命令成功。安装后的 `fbl doctor` 可检查连接问题；若命令不在 PATH 中，按安装器输出设置，或在安装包目录运行 `python3 -B -m fbl doctor`。

## Skill、MCP、CLI 怎么选

| 接入方式 | 适合谁 | 怎么开始 |
| --- | --- | --- |
| **Skill** | 已使用本机 Agent，希望直接用自然语言安排网页任务 | 完成安装，重新打开 Agent 会话，明确要求使用 `fast-browser-link`。 |
| **MCP** | 希望客户端直接发现结构化浏览器工具 | 先预览接入命令，再应用；重连后检查 `fast_browser_link` 工具。 |
| **CLI / Python SDK** | 需要写脚本、接入自己的程序或其他 Agent | 见 [CLI](docs/fbl.zh-CN.md) 与 [Python 参考](docs/python-scripting.md)。 |
| **Hermes 适配器** | 使用 Hermes 原生工具入口 | 可选安装，见 [Hermes 接入](docs/installation.zh-CN.md#hermes)。 |

MCP 以 Codex 为例；Claude Code 将 `codex` 换为 `claude`：

```sh
fbl mcp install --agent codex --dry-run
# 检查预览结果后，再应用：
fbl mcp install --agent codex --apply
```

通常选择一种入口即可，它们共用同一套浏览器执行和任务管理。[完整接入说明](docs/agent-integration.zh-CN.md)。

## 再试几个实际任务

- “接管我当前打开的页面，整理其中的表格。不要刷新，结束后保留标签页。”
- “把这份资料填写到指定表单，先停在提交前让我检查。”
- “逐页收集当前列表，检测重复记录；如果访问频繁就降速，没有新记录就停止。”
- “下载这次导出结果，检查是否包含 id、date 两列，以及日期是否在指定范围内。”

执行中可以从扩展界面接管或停止。多步骤任务可使用[组合工作流](docs/browser-workflows.md)；检查点、批量结算、模板和报告见[持久工作流](docs/workflow-tools.md)。续做限定在原任务绑定内，不是换一个任务就自动接着执行。

## 后台执行与边界

- 普通任务使用工作标签页；明确接管已有页时，不刷新或另开替代页，结束后保留原页。普通模式复用登录态，无痕模式需在扩展设置中另行允许。
- 默认尽量后台执行。网页弹窗可选择后台优先、严格拦截或显式兼容；**macOS Edge 访问 localhost 等本机回环 HTTP 地址仍可能抢焦点**，当前继续允许访问并显示提示。[弹窗策略与限制](docs/popup-policy.md)。
- 密码、支付信息和验证码等敏感输入由用户处理；需要人工完成的登录或验证步骤由你完成。请向 Agent 明确提交、修改数据等操作的范围。
- 超时不等于操作没有发生。结果不明时先核实，不自动重复写入；报告证明的是已声明的检查条件，不保证网站所有业务结果都正确。
- 网页内容会被交给你选择的 Agent 处理，仍受该 Agent 的数据政策影响。[安全说明](SECURITY.md)。

## 从源码安装当前版本

需要 Git、Python 3.11+ 和 Node.js 22.12+。先构建独立安装包：

```sh
git clone https://github.com/fanjing188/fast-browser-link.git
cd fast-browser-link
npm ci --ignore-scripts
python3 -B scripts/package-agent.py --output out/fbl-local
cd out/fbl-local
python3 -B -m fbl setup
```

已有安装时，用下面两条命令替代最后的 `setup`；检查预览、处理未完成任务后再升级：

```sh
python3 -B -m fbl update --source . --dry-run
python3 -B -m fbl update --source .
```

升级后需要确认浏览器扩展已重载。源码构建和本地安装不会发布 GitHub Release。

## 找不到工具或连接不上？

| 现象 | 先检查 |
| --- | --- |
| Agent 没有浏览器工具 | 重新打开会话，确认 Skill 已被发现；使用 MCP 时确认配置已应用并重新连接。 |
| 扩展显示未连接 | 检查是否加载了安装器输出的目录，并确认本地连接；运行 `fbl doctor`。 |
| 升级被任务拦住 | 先结束活动任务；待核实的旧记录按提示处理，不直接删除任务数据。 |
| 页面操作停在登录、验证码或未知结果 | 完成人工步骤或核实页面状态，再沿原任务继续，不反复创建任务重试。 |

更多：[故障排查](docs/fbl-troubleshooting.zh-CN.md) · [无痕模式](docs/incognito.zh-CN.md) · [开发](docs/development.md) · [测试](docs/testing.md) · [架构](docs/design/architecture.md)

Fast-browser-assist 是独立产品；FBL 保留它所需的受限产品连接接口，本仓库的浏览器工具不要求安装 Assist。

MIT · [第三方声明](THIRD_PARTY_NOTICES.md)
