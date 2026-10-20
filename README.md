# Fast-browser-link

Fast-browser-link lets AI agents work in the browser you’re already signed into: read pages, fill forms, export tables and collect multi-page data. Assist follows your work and suggests the next step.

<!-- Demo recording pending: add docs/assets/demo.gif (browse → suggestion → run → result) and embed it here. -->

## Install in three steps

1. On macOS with Chrome or Edge and Python 3.11+, follow [installation](docs/installation.md) to obtain a published package or build this candidate from source. **Unreleased (2.2.1 candidate)**.
2. Run `python3 -B -m fbl setup` from the package, then load the printed extension directory and confirm the browser connection.
3. Start Codex or Claude Code with the installed Skill, or preview `fbl mcp install --agent codex` / `fbl mcp install --agent claude` and add `--apply` after review. Open the sidebar to try local tools immediately.

[简体中文](README.zh-CN.md)

## You stay in control

Use your signed-in browser while passwords, payments, verification codes and final submission stay with you. Agent tasks run in their own work pages. Take over or stop at any time. [Security and boundaries](SECURITY.md).

## What you can do

- **Browser tools:** read and navigate pages, fill ordinary fields, upload/download files, export tables and collect multiple pages through Skills, CLI or MCP.
- **Assist:** optional Hermes or Codex integration for suggestions and background tasks. First try table exports, multi-page collection, page annotations and the work basket without configuring an Agent. [First use](docs/assist.md).
- **Packs:** describe your objects, data sources and repeatable workflows. [Write your own pack](docs/packs-guide.md).

## Platforms

macOS + Chrome/Edge. Windows and Linux are planned; no release dates are promised.

[Export a multi-page table](docs/export-tables.md) · [Troubleshooting](docs/fbl-troubleshooting.md) · [Optional Hermes integration](docs/installation.md#hermes) · [Incognito](docs/incognito.md)

[Development](docs/development.md) · [Design and safety contracts](docs/design/architecture.md) · [Testing](docs/testing.md) · [Release notes](docs/releases/release-2.2.1.md)

MIT · [Third-party notices](THIRD_PARTY_NOTICES.md)
