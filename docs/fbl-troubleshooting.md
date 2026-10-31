# Diagnose a connection

Run `fbl doctor`, inspect the failed component, then use its printed action. `fbl doctor --fix` is limited to owned configuration and a verified idle daemon; it does not install software, log in, kill unknown processes or change selected models. Sidebar repair performs configuration-only fixes and does not start/stop services.

| Doctor component | Check / recovery |
| --- | --- |
| runtime / runtime_integrity | Missing or changed host closure: preview `fbl update --dry-run`; use a complete verified release. |
| host_chrome / host_edge | Native manifest must point to the owned executable and exact extension origin. Fix recreates missing owned registrations. Malformed or foreign manifests need review. |
| daemon | Missing daemon: safe `--fix` can start it after idle/identity checks. Timeout is unconfirmed, not proof of exit. Unknown PID/socket blocks automatic action. |
| extension / version | Open the browser, load the printed unpacked directory and enable connection. Reload after update; installed extension version and host stamp must agree. |
| runtime_root | Conflicting manifest roots: select the intended runtime explicitly and review registrations; never guess based on whichever socket responds. |
| hermes / models | Hermes is optional for core browsing. Configure it separately; setup lists actual available models, not a fixed model name. Cached metadata alone does not prove live model availability. |
| templates | `.json.new` means user changes need merging. `--fix` updates digest-owned templates, preserving customized originals. |
| packages | Correct registered local paths with pack install/discovery. Do not copy private tools into the public repository. |
| logs | Check ownership and writable directory; do not chmod unrelated files or escalate permissions automatically. |
| discovery | Source/help/schema changed or new skill: rediscover and confirm. No binding is silently rewritten. Opt in again to refresh website structure. |
| cloud | Not configured is optional and does not block update. Any cloud data/registration/fence requires the existing strict cloud shutdown gates. |

`fbl logs --errors` shows errors; `--follow --type stderr` is local diagnostic text. Use `fbl logs --bundle` for sharing: arbitrary stderr bodies, page text and credentials are excluded. Keep its archive private. A successful transport restart never proves that an interrupted task completed. Read the page/task ledger before continuing; unknown writes are never replayed.

Updates retain a dated `fbl-backups` directory and report the backup path on failure. If task/process verification blocks rollback, retain everything and report that blocker; do not reset files, delete locks or stop unrelated processes. For a normal rollback failure, run doctor against the restored runtime before resuming work.

Stderr is written to `logs/<date>.agent-stderr.log`; readers also accept legacy `.hermes-stderr.log` files. Rotation remains 2 MiB with one archive and seven-day retention.
