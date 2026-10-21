# Configuration

Set runtime variables before starting Hermes or the Native Messaging host. Browser-spawned native hosts do not automatically inherit a terminal's exported environment. For daemon settings, configure its actual launch environment and restart the daemon only after active tasks finish. Only the two settings explicitly listed below read the shared bridge home's `.env`; other variables are not automatically loaded from that file.

| Variable | Default | Consumer and meaning |
|---|---|---|
| `HERMES_HOME` | `$HOME/.hermes` | Hermes profile home; installer target and host launcher. The installer pins this home in the launcher. Use `--hermes-home` to choose the installation target. |
| `FAST_BROWSER_BRIDGE_HOME` | Shared Hermes root inferred from the profile home | Plugin's shared daemon home. Named profiles normally share the root daemon; set explicitly for custom layouts. Also used by the stale-task sweep. |
| `FAST_BROWSER_DEFAULT` | Unset | Plugin browser selection: `chrome`, `edge`, or an instance ID. Explicit `instance_id` and the selected primary connected browser take precedence. Process environment takes precedence over shared `.env`. Ambiguous matches still require selection. |
| `FAST_BROWSER_EXPORT_ROOTS` | Script workspace only | Colon-separated absolute export roots for screenshots/files. Plugin process environment takes precedence over shared `.env`. Existing files and paths outside permitted roots are refused. |
| `FAST_BROWSER_IDLE_CLOSE_SECONDS` | `0` | Daemon's grace after a completed turn; finite non-negative seconds, `0` closes immediately. Same-session activity cancels grace. |
| `FAST_BROWSER_TASK_IDLE_TIMEOUT_SECONDS` | `1200` | Daemon's ready-task inactivity timeout; finite non-negative seconds. Paused tasks and valid pending human requests are protected. |
| `FAST_BROWSER_WORK_WINDOW` | `separate` | `separate` reuses an unfocused normal work window per browser instance, including after saved window/tab IDs change. After task cleanup succeeds, the extension closes its homepage only if it is the window's sole tab and no task still uses the window. Retained results and user tabs keep the window open. Task tab groups use that window; pointer/keyboard actions activate only the target tab and are serialized within the window. Reads do not activate tabs. `current` retains task groups in the current window. |
| `FAST_BROWSER_PAUSE_TIMEOUT_S` | `600` | Script action session's takeover/resume wait; integer `1..3600`. |
| `HERMES_BENCH_PROFILE` | `default` | Agent benchmark runner/scorer profile. Default database is `$HERMES_HOME/state.db`; named profile database is `$HERMES_HOME/profiles/<name>/state.db`. Use the same value for running and scoring. |

Plugin options are separate from environment variables. `vault_tools.enabled` defaults to `false`; enabling it also needs a `tools.override` capability grant. The optional official `browser_*` overrides require that grant and a bound task; installation alone grants neither. Browser connection authorization is full-only and must be confirmed in the extension. Ordinary task actions then execute directly; there is no smart-approval setting. Offline or unknown connection state does not prove authorization.

The source Vault adapter supports the currently verified synchronous contracts: the unified Hermes `browser_vault` tool (`action=list/fill/save_login/enter_code/unlock`) and the five legacy `browser_vault_*` tools. Async registrations are refused before any override because the official masked prompts and unlock-session ownership are thread-local; they are not moved into a worker thread. It overrides only tool names present in that SDK; it does not create missing legacy aliases. The default remains off. Browser connection and ordinary actions do not require enabling Vault. The [2.2.1 compatibility limit](../releases/release-2.2.1.md#验证范围) describes that release, not this source adapter.

For a bound task, login passwords and one-time codes use only the authenticated private `vault.sock` channel, with session/task, browser, tab, generation, origin, document and one-use nonce checks. List returns safe login metadata, never credential values; save/unlock/code prompts remain in the trusted official masked UI. Payment cards and addresses are not supported. Missing authorization or a stale/private-channel failure never falls back to Hermes' default browser; an uncertain write is not replayed. Only sessions not bound to this plugin retain the original official handler. Unload and failed plugin loading restore the original SDK registrations and release the private bindings/runtime. Compatibility probes use synthetic SDK registrations, temporary homes and synthetic credentials; they do not enable a personal Vault or certify real password-manager/browser execution.

## Browser popup and task cursor

The top-right version comes from the loaded extension manifest. The popup contains browser connection authorization (not a mode switch) and current-task controls. There is no content shielding switch: page content is returned as-is, except that password input values are omitted and password, payment and one-time-code fields are left to the user or Vault. See [page output and recovery](content-shield.md).

The visual task cursor is always enabled and has no popup switch. It stays visible during work and between actions, uses 240 ms target travel, and hides when paused, disconnected, stopped or in a hidden tab. System reduced-motion preferences remove cursor travel. Cookie mirror settings are on the Hermes Desktop page.

## Cookie mirror options

No environment variable enables automatic Cookie mirror approval. Both profiles must be connected with the updated extension and its `cookies` / `<all_urls>` permissions. Choose the target instance and sites in Hermes Desktop → Browser connections, then confirm in the source extension panel. Full access does not skip this confirmation.

| Option | Default | Meaning |
|---|---|---|
| `clearTarget` | `false` | Remove existing target cookies for the selected sites before import. Removal failures are counted; other imports continue. |
| `persistDays` | Absent | Preserve session cookies as session cookies. When selected, integer `1..365` sets their expiration to that many days. Persistent source cookies keep their original expiration. |

Only the default, non-incognito store is used. The fixed 60-second deadline includes confirmation time; transfers are limited to 256 selected sites, 16 MiB and 128 chunks. These limits are not configurable. Cookie values and transfer state have no disk or cloud storage option. See [usage](usage.md#cookie-mirror).

## Development and acceptance variables

These select test dependencies or fixtures; they are not required for installation.

| Variable | Default / purpose |
|---|---|
| `HERMES_SOURCE` | Test Hermes checkout; full gate otherwise looks for the standard local checkout. Prefer the isolated pinned checkout in `testing.md`. |
| `HERMES_PYTHON` | Hermes test interpreter; some runners use `python3`, others the standard Hermes venv. Set it explicitly for consistent acceptance. |
| `BROWSER_USE_CLI` | Official-tool acceptance CLI executable; not required for core tests |
| `BROWSER_USE_CLI_SOURCE` | Source checkout for the official browser inventory script |
| `BROWSER_EXECUTOR_PACKAGE` | Optional existing archive for package tests; otherwise built from the current source |
| `PUBLIC_RELEASE_EXTRA_KEYWORDS` | Newline-separated literal private markers for `check-public-release.sh`. Findings show file/line/type, never matched values. |
| `FAST_BROWSER_FD` | Internal inherited script socket, supplied by the host; do not set manually |
| `HERMES_NATIVE_FIXTURE` | Internal real-browser fixture directory; supplied by the test runner |

`HOME`, `TMPDIR`, `PATH`, locale variables and `PYTHONDONTWRITEBYTECODE` have their standard process meanings. Keep the real `HOME` in browser tests; isolate `HERMES_HOME`, `TMPDIR` and the browser user-data directory instead. Never publish `.env`, token files, live task state, benchmark results or browser evidence.

Work windows are recreated after closure. They are never focused or minimized by automation. CDP input is attempted even if a document remains hidden because the window is minimized or covered. Delivery confirmation alone does not mean a click had an effect: an unverified or synthetic action is observed for up to 1.5 seconds, then returns `effect: observed` or fails with `click_no_effect`.

At startup and once per hour, `needs_sync` tasks older than 24 hours with no live work pages are closed by revoking their permissions. Paused tasks and pending human requests are preserved. An open receipt includes the session work-page count as `open_tabs`; more than six pages adds a close-unused-pages reminder.
