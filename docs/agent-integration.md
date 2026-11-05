# Connect Codex, Claude Code or Hermes

Finish [installation](installation.md) and browser confirmation first. Skills and MCP share the same task ownership, sensitive-input and unknown-write checks.

Work products can use the [local Python SDK](browser-core.md) directly. The SDK, CLI and MCP share one browser client; no cloud pairing or relay is needed.

| Agent | Skill | Optional MCP preview |
| --- | --- | --- |
| Codex | Restart and use `fast-browser-link/SKILL.md` | `fbl mcp install --agent codex --dry-run` |
| Claude Code | Restart and use `fast-browser-link/SKILL.md` | `fbl mcp install --agent claude --dry-run` |
| Hermes | Use the independent Skill, or the separate native adapter | See [Hermes setup](installation.md#hermes) |

Review the MCP command before adding `--apply`. Existing configuration is preserved; uncertain configuration stops the operation. Reconnect MCP and check for `fast_browser_link`. This describes installation behavior, not verified acceptance of every client version.

Use the installed Skill's Python entrypoint or `fbl browser` for JSON CLI operations. Keep one private session file per task; reuse it within that task. MCP keeps its own process identity. Call `create`, wait for task readiness, then operate only on its owned pages. Read back the result and close the task when finished.

For multi-step work use the `script` operation with `taskId`, Python `code` and a bounded `timeout`. Inspect `execution_complete`, `outcome_unknown` and `last_operation`; a caught exception does not clear pending human input or approval. Inspect an uncertain write before continuing. [Python helpers](python-scripting.md) · [CLI](fbl.md)

Collaboration is provided by the separate Fast-browser-assist product. The core browser tools require no Hermes or model configuration. [中文](agent-integration.zh-CN.md)

## Shared skill reference

The canonical `skills/fast-browser-link` contains the fast path and installed `references/` for helper signatures, troubleshooting, batch extraction and task boundaries. The Hermes copy is a generated mirror; run `python3 tests/agent-link/test_skill_layout.py --sync` after editing the canonical files. Its tests check both copies and helper signatures. Independent installs copy that directory; `fbl setup` copies the same tree into `fbl-assets/core-skill`, and the Hermes package contains both the mirror and `core-skills`. Existing separate Hermes skills remain compatible. Candidate skill version is 2.6.1; the runtime remains 2.6.0 pending a coordinated release version bump.
