# native-bridge

Python standard-library daemon and Chromium Native Messaging host. Wire contracts are described in [docs/design/protocol.md](../docs/design/protocol.md).

## Files

| File | Role |
|---|---|
| `daemon.py` | Per-profile service on a Unix-domain socket: tasks, `(instanceId, tabId)` leases, request ledger, approvals routing, persistence |
| `host.py` | Native Messaging host: 4-byte little-endian framing ↔ JSONL socket |
| `client.py` | Synchronous client used by the plugin: `ensure_service(home)` and `BridgeClient(home).call(method, params)` |
| `api_client.py` | Pinned, bounded HTTPS client for approved read-only `api_request` calls |
| `artifacts.py`, `downloads.py` | Task-private upload staging and download attribution / claiming |
| `cdp_gateway.py` | Local CDP endpoint for the `browser_exec` override under task browser access |
| `vault_private.py`, `vault_client.py` | Private channel for the optional Vault fill integration |
| `install.py` | Stages the host launcher and Chrome/Edge manifests into an **isolated** home for tests (refuses the active user's home) |

Runtime data lives in `$HERMES_HOME/plugin-data/fast-browser-link-native/` (mode `0700`); `bridge.sock`, `token`, `daemon.pid` and `tasks.json` are `0600`. The token never appears in a Native Messaging manifest.

Settled tasks stay in the hot `tasks.json` ledger for seven days by default. After that, the daemon moves only tasks with confirmed cleanup, no live tab leases or pending human input, and settled operation history (or a valid prior user verification) into the private, compressed `tasks-archive.sqlite3` file. The full request fingerprints and original unknown states remain in the archive; elapsed time never turns an unknown browser outcome into success. Set `FAST_BROWSER_TASK_ARCHIVE_DAYS` in the trusted daemon environment to change the hot retention period. Archiving is checked at startup and hourly while the daemon runs. SQLite uses Python's built-in `sqlite3` module and does not run a database server. The active ledger remains the installer's safety gate; archive writes commit before a task is removed from the hot snapshot so an interrupted archive can be retried safely.

Unix socket addresses are limited to 103 encoded bytes. `client.socket_address()` keeps a fitting absolute address; otherwise it uses a fitting path relative to the caller's current directory, pointing to the same canonical socket. If neither fits, it refuses before connecting or binding. It does not change the process working directory, create aliases, relocate runtime data, or weaken authentication and permissions.

## Behavior worth knowing

- Native host uses cancellable unbuffered pipe I/O and joins both forwarding threads before closing its socket reader. Bridge EOF, partial frames and a browser that stops draining output do not leave a buffered daemon thread alive at interpreter shutdown.
- `extension.tasks` with `{includeClosed: true}` is the trusted extension's overlay cleanup inventory. Each row contains only `id`, `instanceId`, `generation`, `state` and `tabIds`; operation history remains persisted and ordinary task reads retain their existing details. This keeps reconnect cleanup below the transport limit for large histories.
- A lost response after dispatch returns `outcome_unknown`; the client never replays.
- Approval authority is never restored after a daemon or connection restart. Non-terminal tasks become `needs_sync` and need `shared.resume` and freshly verified task authority under browser connection authorization; no ordinary per-action confirmation is required.
- Each task keeps at most 4096 hashed request-ID/payload bindings. A retained ID whose outcome is unknown after a restart fails with `request_outcome_unavailable`.
- Extension timeouts, disconnects and invalid `new_tab` outcomes revoke the task's leases and start a bounded best-effort release.
- An existing socket at the path is never unlinked automatically; after an unclean crash, remove a verified-stale `bridge.sock` by hand.

## Tests

```sh
python3 -m unittest discover -s native-bridge/tests -v
```

The suite uses real Unix sockets and subprocess Native Messaging framing under a temporary Hermes home, and terminates every daemon it starts.
