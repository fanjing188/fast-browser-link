# Fast-browser-link

**Let your AI agent use the Chrome or Edge browser you are already signed into.**

[简体中文：项目介绍与使用教程](README.zh-CN.md) · [Installation](docs/installation.md) · [Download a release](https://github.com/fanjing188/fast-browser-link/releases)

Describe a task in Codex, Claude Code, or another local agent. Fast-browser-link sends page reads, clicks, form input, and file operations to your browser, then returns the results to the agent. For example:

> Use fast-browser-link to read the page I have open and turn its table into a CSV. Keep the original tab and do not submit any forms.

The project contains a **browser extension and a local runtime**, connected to your agent through a Skill, CLI, or MCP. Bring your own agent with permission to run local tools: FBL does not include a chat model or require a cloud server. The core browser tools work without Hermes.

```text
Your request → AI agent → Fast-browser-link → Local Chrome / Edge
```

## What can it do?

| Task | What the agent can use FBL for |
| --- | --- |
| Read and collect | Read page text, tables, and forms; collect and organize records across pages. |
| Operate a website | Search, click, fill ordinary fields, scroll, and navigate, using fresh page observations. |
| Work with files | Upload files you specify, download results, and check expected rows, columns, or date ranges. |
| Use an existing session | Reuse your normal browser login, explicitly attach an existing tab, or request incognito mode. |
| Run longer workflows | Combine steps, wait for results, process batches, save checkpoints, resume, and generate reports. |
| Handle interruptions | Slow down when rate-limited, stop repeated failures or stalled loops, and recover eligible temporary page failures. |

**Source version: 2.6.0**. This page describes the current source. `main` may be ahead of the published packages; [Releases](https://github.com/fanjing188/fast-browser-link/releases) is the source of truth for available downloads. See the [2.6.0 notes](docs/releases/release-2.6.0.md) for the new workflow, recovery, and popup capabilities.

## Requirements

- **OS:** macOS. Windows and Linux are not yet verified.
- **Browser:** Chrome or Microsoft Edge.
- **Runtime:** Python 3.11+. Release packages do not need Node.js; building from source needs Node.js 22.12+.
- **Agent:** a local Codex, Claude Code, or another client that can use Skills, MCP, or command-line tools. A cloud-only chat cannot directly access your local browser.

## Install and run your first task

### 1. Download and extract

Get `fast-browser-link-<version>.zip` and its checksums from [Releases](https://github.com/fanjing188/fast-browser-link/releases). Verify and extract it as described in [installation](docs/installation.md).

Choose the regular package. GitHub's **Source code** downloads are source archives; a ZIP containing **-hermes-** is the optional adapter. For capabilities that have not been released yet, use the source-build instructions below.

### 2. Install the local runtime

Open a terminal in the extracted package and run:

```sh
python3 -B -m fbl setup
```

The installer prints the browser extension directory and installs the Skill for supported agents it detects. Keep the installed directory in place. For an existing installation, use the upgrade flow instead of removing or overwriting its data.

### 3. Connect your everyday browser

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select the extension directory printed by the installer.
4. Click the Fast-browser-link extension icon, confirm the local connection, and check that it says **Connected**.

### 4. Try a read-only task

Start a new agent session so it can discover the installed `fast-browser-link` Skill. Then ask:

> Use fast-browser-link to open https://example.com and tell me its title and main content. Close the task page you created when finished.

Success means the agent **actually returns page content**, not just that installation exited successfully. Use `fbl doctor` to investigate connection problems. If `fbl` is not on your PATH, follow the installer's output or run `python3 -B -m fbl doctor` from the package directory.

## Choose an agent connection

| Connection | Best for | Getting started |
| --- | --- | --- |
| **Skill** | Giving natural-language browser tasks to a local agent | Install, start a new agent session, and ask it to use `fast-browser-link`. |
| **MCP** | Clients that should discover structured browser tools | Preview and apply the configuration, reconnect, and look for `fast_browser_link`. |
| **CLI / Python SDK** | Scripts, custom applications, and other agents | See the [CLI](docs/fbl.md) and [Python reference](docs/python-scripting.md). |
| **Hermes adapter** | Hermes's native tool integration | Optional; see [Hermes installation](docs/installation.md#hermes). |

For MCP with Codex, run the following. Replace `codex` with `claude` for Claude Code:

```sh
fbl mcp install --agent codex --dry-run
# Review the preview before applying:
fbl mcp install --agent codex --apply
```

Usually one connection is enough. They share the same browser executor and task management. [Full integration guide](docs/agent-integration.md).

## Example requests

- “Attach the page I currently have open and extract its table. Do not reload it, and keep the tab afterward.”
- “Fill this form using the supplied information, then stop before submission so I can check it.”
- “Collect the list across pages, detect duplicate records, slow down if access is rate-limited, and stop when there are no new records.”
- “Download this export and check that it contains id and date columns and the requested date range.”

You can take over or stop a task from the extension. Use [combined steps](docs/browser-workflows.md) for multi-step actions. [Durable workflows](docs/workflow-tools.md) cover checkpoints, batches, templates, and reports. Resume is limited to the original task binding; it does not transfer execution authority to a new task.

## Background execution and limits

- Normal tasks use work tabs. Explicitly attaching an existing page preserves it without reloading or opening a replacement. Normal mode reuses your login; incognito needs separate extension permission.
- Ordinary operations aim to stay in the background. Popups have background-first, block, and explicit compatibility modes. **On macOS, Edge can still take focus when navigating to local HTTP addresses such as localhost or 127.0.0.1.** These remain allowed, with a visible warning. [Popup policies and limits](docs/popup-policy.md).
- Passwords, payment details, and verification codes are handled by the user. Complete required human login or verification steps yourself, and tell your agent which submissions or data changes are authorized.
- A timeout does not prove that an action did not happen. Unknown writes require verification rather than automatic replay. Reports establish the checks you declared, not every aspect of a website's business outcome.
- Page content is returned to the agent you choose and is subject to that agent's data policies. [Security](SECURITY.md).

## Install the current source

Requires Git, Python 3.11+, and Node.js 22.12+. Build a standalone package first:

```sh
git clone https://github.com/fanjing188/fast-browser-link.git
cd fast-browser-link
npm ci --ignore-scripts
python3 -B scripts/package-agent.py --output out/fbl-local
cd out/fbl-local
python3 -B -m fbl setup
```

For an existing installation, replace the last `setup` command with the following. Review the preview and settle unfinished tasks before proceeding:

```sh
python3 -B -m fbl update --source . --dry-run
python3 -B -m fbl update --source .
```

After upgrading, confirm that the browser extension has reloaded. A source build or local installation does not publish a GitHub Release.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| The agent has no browser tool | Start a new session and confirm Skill discovery; for MCP, check that configuration was applied and reconnect the client. |
| The extension is disconnected | Check the loaded extension directory, confirm the local connection, and run `fbl doctor`. |
| An upgrade is blocked by tasks | Finish active tasks and follow the instructions for unresolved records; do not delete task data to bypass the check. |
| Work stops at login, verification, or an unknown result | Complete the human step or inspect the page state, then continue the original task instead of repeatedly starting new ones. |

More: [Troubleshooting](docs/fbl-troubleshooting.md) · [Incognito](docs/incognito.md) · [Development](docs/development.md) · [Tests](docs/testing.md) · [Architecture](docs/design/architecture.md)

Fast-browser-assist is a separate product. FBL provides its bounded product connection interface; installing Assist is not required to use this repository's browser tools.

MIT · [Third-party notices](THIRD_PARTY_NOTICES.md)
