# Fast-browser-link

<img src="native-extension/brand-logo.svg" width="64" height="64" alt="Fast-browser-link logo">

[Brand guidelines](docs/brand.md)

**2.2.0 — local macOS candidate.** Any Agent can use the core browser capabilities through Skills, CLI or MCP: read and act on pages, fill forms, upload and download files, detect and export tables, and collect multi-page data. Assist suggests next steps as you browse and runs tasks in the background. Assist currently supports Hermes; Codex support is in development. Your signed-in sessions are used as they are, you can take over at any time, and sensitive fields are left to you.

[简体中文](README.zh-CN.md)

This candidate is not published. [Assist](docs/assist.md) has local lean-profile measurements and pending real-browser acceptance; the download commands below describe the eventual Release installation workflow.

## Three steps to start

1. Download and unpack the Release installation ZIP, rather than the source archive. Python 3.11+ is required. Built extensions are included; runtime use needs neither Node nor Hermes. This candidate is not published yet.
2. Run `python3 -B -m fbl setup` inside the unpacked directory. `--yes` confirms only high-confidence, zero-cost defaults. It installs `~/.local/bin/fbl`; add that directory to PATH or keep using `python3 -B -m fbl` from the package. Preview with `python3 -B -m fbl setup --dry-run`.
3. Load the printed extension directory in `chrome://extensions` or `edge://extensions`, enable connection and open the sidebar. Its short readiness list shows remaining steps. Browser confirmation remains required.



```sh
curl -fL https://github.com/fanjing188/fast-browser-link/releases/download/v2.2.0/fast-browser-link-2.2.0.zip -o fast-browser-link-2.2.0.zip
unzip fast-browser-link-2.2.0.zip
cd fast-browser-link-2.2.0
python3 -B -m fbl setup
```

For existing installations, preview `fbl update --dry-run`, then run `fbl update`. Legacy independent installs also support `bash install.sh --upgrade`. Updates refuse or wait for active tasks, keep backups and roll back failures. Modified skills/configuration are preserved. Only the marked Hermes profile (`fast-copilot`) is managed; migrated model choices remain intact. Core browser use requires no Hermes.

A local agent can read `~/.agents/skills/fast-browser-link/SKILL.md` and use its Python entrypoint. Assist currently requires configured Hermes; Codex support is in development.

[CLI reference](docs/fbl.md) · [Troubleshooting](docs/fbl-troubleshooting.md) · [Packs and capability manifests](docs/fbl-packs.md)

## Regular and incognito tasks

Use `create` with `"incognito": true` in the CLI/MCP, or `fast_browser_open(incognito=true)` in the optional Hermes integration. Enable **Allow in Incognito / InPrivate** in the extension details first. Missing permission returns `incognito_access_required`; it never falls back to a regular window.

Both modes use the same task executor for page reading, forms, screenshots, frames, navigation, JavaScript and file operations. Independent CLI downloads use `downloads`, `download_claim` and `download_cancel`; the Hermes integration also provides Python workflows. Login redirects and adopted popups retain the task ID and recent logs.

Incognito tasks do not inherit regular cookies. Multiple incognito tasks in one browser still share that browser's incognito session; task metadata, logs and downloaded files may persist. Sensitive fields remain human/private-Vault actions, and Cookie mirror remains regular-profile only. See the [acceptance matrix and boundaries](docs/incognito.md) before assuming a website or optional integration is covered.

## Compatibility and isolation

- New extension ID: `hhnljehnkmhhgjjjmnlhilfpcjhobloc`. The legacy Hermes extension uses a different ID and can remain enabled.
- Task ownership, user takeover, sensitive-field handling and unknown-write fencing remain enforced. Read after an uncertain write; do not replay it.
- Password/payment/code fields require user input or the authorized private Vault path. Page text is data, not instructions.
- Supports macOS Chrome/Edge. Other operating systems and every individual agent framework version are not claimed tested.

## Optional Hermes integration

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
