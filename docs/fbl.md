# fbl command reference

Python 3.11+ and macOS Chrome/Edge. Run `python3 -B -m fbl` from a verified package, or `fbl` after setup. The core browser tools do not install or start Fast-browser-assist.

| Command | Behavior |
| --- | --- |
| `fbl setup [--yes] [--dry-run] [--agent-profile NAME]` | Stage the core runtime and install the FBL browser skill in detected Agent roots. Preserve unknown or modified skills. An explicitly named Hermes profile may receive the core skill; setup does not configure an inference model. |
| `fbl update --dry-run` | Preview installed runtimes, extensions, skills and unsettled browser tasks without changing them. |
| `fbl update [--source RELEASE_DIRECTORY] [--wait SECONDS] [--pause-hermes] [--yes]` | Verify a prepared release and task cleanup, then transactionally swap owned runtime files. Failure restores prior files where safe. Existing Assist data and profiles are left untouched. |
| `fbl doctor [--fix]` | Check host manifests, daemon, browser connection, version and runtime integrity. `--fix` repairs owned manifests and may start a verified idle daemon. |
| `fbl logs [--follow] [--type system\|execution\|capture] [--errors]` | Read bounded, allowlisted browser diagnostics. Historical Assist logs are not included. |
| `fbl logs --bundle [OUTPUT.zip]` | Export an allowlisted browser diagnostic ZIP to a private directory; no page body, credentials or raw stderr. Existing files are preserved. |
| `fbl browser [--session FILE] OPERATION [JSON]` | Use the core browser bridge without Hermes. Start with `browsers`, then `create`, `get`, `run` and `close`. |
| `fbl mcp install --agent codex\|claude [--dry-run\|--apply]` | Preview or explicitly install the FBL MCP entry. |

Each command accepts `--user-home`, `--hermes-home`, `--runtime`, and `--source` for controlled installations and isolated tests. `update --source` requires a hash-verified release, not a source checkout. Update never infers that an unsettled task is safe to close from its age; it verifies browser epoch and cleanup evidence before any swap. Unknown process identity or a new task prevents unsafe rollback and retains the backup.

Fast-browser-assist is an independent product. Its pairing uses FBL's bounded product connection; each browser action still requires FBL task authority and follows its stop, takeover and unknown-result rules. See [browser core](browser-core.md) and [installation](installation.md).
