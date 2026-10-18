# Install and verify from GitHub

Send the following to an Agent that can execute local commands. Use independent Skills by default.

```text
Download and install Fast-browser-link from actual published Releases at https://github.com/fanjing188/fast-browser-link, then verify real browser calls.

1. Use the GitHub API or gh to find an actual fast-browser-link-<version>.zip asset. Do not choose Source code or a -hermes- adapter ZIP.
2. Verify the published ZIP SHA256 and internal SHA256SUMS.json; extract into an isolated directory. Stop honestly if the repository or asset is unavailable; never guess a URL.
3. Read installation instructions and check macOS, Python 3.11+ and target directories. Do not overwrite or remove an existing installation.
4. Record digests of existing Hermes configuration, plugins and Native host files. Preserve all plugins, data and tabs.
5. Run bash install.sh --dry-run, then bash install.sh. Do not add --hermes-plugin, enable tools.override, or modify Hermes source/config.yaml.
6. Load the printed extension directory through normal Chrome/Edge extension management in the everyday browser. The extension ID is hhnljehnkmhhgjjjmnlhilfpcjhobloc; keep the old extension enabled. Do not install into another application's dedicated browser or a temporary profile.
7. Read ~/.agents/skills/fast-browser-link/SKILL.md. Use scripts/browser.py to verify health, browsers, public-page reading and a local test page's fill/click/readback. Never submit test data to real sites.
8. Close tasks created for this check; verify cleanup and unchanged prior installation files. Report the actual Release URL, digests, installation location and results.

Execute the work. Copying files or passing health is not proof of browser calls. State any specific browser confirmation the user must complete.
```

The independent package requires neither Node.js nor Hermes. Browser confirmation for an unpacked extension still applies. An Agent without local command execution cannot directly use this local Skill. The source candidate is unreleased; build it separately if needed.

[Installation](installation.md) · [中文](agent-install-prompt.zh-CN.md)
