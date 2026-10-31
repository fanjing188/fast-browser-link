# Install for your Agent

Requires macOS, Chrome/Edge and Python 3.11+. **Source version: 2.5.0**. Choose a published independent ZIP and its checksums from [Releases](https://github.com/fanjing188/fast-browser-link/releases), not Source code or the Hermes adapter ZIP. Source builds require Node.js 22.12+ as described in [development](development.md); a source checkout alone does not establish publication status.

1. Extract the entire package and run `python3 -B -m fbl setup`. Preview with `--dry-run`; add the printed CLI directory to PATH if needed.
2. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load the printed unpacked extension directory. Confirm connection in the popup. Keep that directory in place.
3. Choose one integration below. Run `fbl doctor` to inspect remaining steps; daemon health alone does not prove a connected browser.

## Codex

Restart your Agent so it can discover the installed `fast-browser-link` Skill. For MCP, preview `fbl mcp install --agent codex`, review, then repeat with `--apply`. Existing same-name configuration is preserved.

## Claude Code

Use the installed Skill after restarting the session, or preview `fbl mcp install --agent claude` and add `--apply` after review. The command uses the official client CLI. Reconnect MCP and check the tool list.

<a id="hermes"></a>
## Hermes

Hermes is optional for core browser tools. For its native tools use the separate `fast-browser-link-hermes-<version>.zip`, or `bash install.sh --hermes-plugin` from source. Review the browser confirmation. Existing legacy `browser-link` plugin conflicts are refused. See [integration details](agent-integration.md). Collaboration is installed separately as Fast-browser-assist.

Preview upgrades with `fbl update --dry-run`; active or unknown tasks block updates. Preserve task data and customized configuration. [Troubleshooting](fbl-troubleshooting.md) · [中文](installation.zh-CN.md)

[Hermes installation and maintenance details](design/hermes-installation.md)
