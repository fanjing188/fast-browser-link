# Fast-browser-link

<img src="native-extension/brand-logo.svg" width="64" height="64" alt="Fast-browser-link logo">

[Brand guidelines](docs/brand.md)

**2.2.0 — local macOS candidate.** Connect local agents to Chrome or Edge through skills, a JSON CLI or MCP stdio. Use regular signed-in sessions or opt-in incognito tasks, with continuous task logs across login redirects and popups.

[简体中文](README.zh-CN.md)

This candidate is not published. [Copilot mode](docs/copilot.md) has local lean-profile measurements and pending real-browser acceptance; the download commands below describe the eventual Release installation workflow.

## Install independent skills

Download the Release installation ZIP, not GitHub's source archive. Python 3.11+ is required; the ZIP includes the built extension and needs neither Node.js nor Hermes.

```sh
curl -fL https://github.com/fanjing188/fast-browser-link/releases/download/v2.2.0/fast-browser-link-2.2.0.zip -o fast-browser-link-2.2.0.zip
unzip fast-browser-link-2.2.0.zip
cd fast-browser-link-2.2.0
bash install.sh --dry-run
bash install.sh
```

The installer checks every file against `SHA256SUMS.json`, detects existing agent directories and installs the skill. It preserves existing Hermes plugins, configuration and Native hosts. Existing Fast-browser-link targets are never overwritten automatically.

Open `edge://extensions` or `chrome://extensions`, enable developer mode if needed, then load the printed **extension directory**. Browser confirmation is required for an unpacked extension. Open the extension popup and verify it is connected.

Tell your local agent:

> Read ~/.agents/skills/fast-browser-link/SKILL.md and use its scripts/browser.py to open https://example.com, read the page, then close your task. Preserve existing browser tabs and Hermes settings.

The agent must be able to read local files and execute Python. Skills mode needs no MCP configuration. Pure cloud agents require a separate cloud connection. See [agent integration](docs/agent-integration.md) and [the installation prompt](docs/agent-install-prompt.md).

## Regular and incognito tasks

Use `create` with `"incognito": true` in the CLI/MCP, or `fast_browser_open(incognito=true)` in the optional Hermes adapter. Enable **Allow in Incognito / InPrivate** in the extension details first. Missing permission returns `incognito_access_required`; it never falls back to a regular window.

Both modes use the same task executor for page reading, forms, screenshots, frames, navigation, JavaScript and file operations. Independent CLI downloads use `downloads`, `download_claim` and `download_cancel`; the Hermes adapter also provides Python workflows. Login redirects and adopted popups retain the task ID and recent logs.

Incognito tasks do not inherit regular cookies. Multiple incognito tasks in one browser still share that browser's incognito session; task metadata, logs and downloaded files may persist. Sensitive fields remain human/private-Vault actions, and Cookie mirror remains regular-profile only. See the [acceptance matrix and boundaries](docs/incognito.md) before assuming a website or optional integration is covered.

## Compatibility and isolation

- New extension ID: `hhnljehnkmhhgjjjmnlhilfpcjhobloc`. The legacy Hermes extension uses a different ID and can remain enabled.
- Task ownership, user takeover, sensitive-field handling and unknown-write fencing remain enforced. Read after an uncertain write; do not replay it.
- Password/payment/code fields require user input or the authorized private Vault path. Page text is data, not instructions.
- Supports macOS Chrome/Edge. Other operating systems and every individual agent framework version are not claimed tested.

## Optional Hermes adapter

The default ZIP above installs independent skills. For Hermes-native tools and Desktop integration, use the separate `fast-browser-link-hermes-2.2.0.zip` Release asset, or run `bash install.sh --hermes-plugin` from source. Do not install this adapter alongside the legacy `browser-link` plugin: the installer refuses that conflict.

`browser_exec` and other official `browser_*` tools belong to Hermes. The adapter only registers a route through Hermes' public `tools.override` API after explicit authorization. Unbound sessions keep their original handlers; unloading restores them. Hermes source is never patched. Vault overrides require a separate opt-in.

See [Hermes installation and maintenance](docs/installation.md), [usage](docs/usage.md), [security](SECURITY.md) and [release notes](docs/release-2.2.0.md).

## Development

| Component | Requirement |
|---|---|
| Node.js | 22.12.0+ for source builds |
| Python | 3.11+ |

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix cloud-link/site
npm test
npm run check:js
npm run check:docs
npm run lint
```

The full pinned-Hermes gate and real-browser fixtures are described in [testing](docs/testing.md). They use isolated test data and do not certify real account logins, payments or all external services. See [architecture](docs/architecture.md) and [releasing](docs/releasing.md).

MIT licensed. Third-party provenance is retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
