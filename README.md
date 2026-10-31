# Fast-browser-link

Fast-browser-link lets AI agents work in the browser you’re already signed into: read pages, fill forms, upload and download files, and collect page data. Collaboration lives in the separate Fast-browser-assist product.

<!-- Demo recording pending: add docs/assets/demo.gif (browse → suggestion → run → result) and embed it here. -->

## Install in three steps

1. On macOS with Chrome or Edge and Python 3.11+, follow [installation](docs/installation.md) to obtain a published package or build from source. **Source version: 2.5.1**. Published versions and checksums are listed in [Releases](https://github.com/fanjing188/fast-browser-link/releases).
2. Run `python3 -B -m fbl setup` from the package, then load the printed extension directory and confirm the browser connection.
3. Start Codex or Claude Code with the installed Skill, or preview `fbl mcp install --agent codex` / `fbl mcp install --agent claude` and add `--apply` after review. Open the sidebar to try local tools immediately.

[简体中文](README.zh-CN.md)

## You stay in control

Use your signed-in browser while passwords, payments, verification codes and final submission stay with you. Agent tasks run in their own work pages. Take over or stop at any time. [Security and boundaries](SECURITY.md).

## What you can do

- **Browser tools:** read and navigate pages, fill ordinary fields, upload/download files and collect page data through Skills, CLI or MCP.
- **Product connection:** external extensions such as Fast-browser-assist use the bounded product connection and work page APIs. Browser execution, authorization and cleanup remain in Fast-browser-link.

## Platforms

macOS + Chrome/Edge. Windows and Linux are planned; no release dates are promised.

[Troubleshooting](docs/fbl-troubleshooting.md) · [Optional Hermes integration](docs/installation.md#hermes) · [Incognito](docs/incognito.md)

[Development](docs/development.md) · [Design and safety contracts](docs/design/architecture.md) · [Testing](docs/testing.md) · [Release notes](docs/releases/release-2.5.1.md)

MIT · [Third-party notices](THIRD_PARTY_NOTICES.md)
