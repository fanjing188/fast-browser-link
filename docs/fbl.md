# fbl command reference

Python 3.11+, macOS Chrome/Edge. Use `python3 -B -m fbl` in a verified unpacked installation ZIP, or `fbl` after setup (`~/.local/bin` must be in PATH). Source builds require Node; installed runtime commands do not. This candidate is unpublished. `-B` prevents bytecode caches from changing the verified release file set.

| Command | Behavior |
| --- | --- |
| `fbl setup [--yes] [--dry-run] [--seo]` | Detect agent skill directories, stage core runtime if absent, create only marked dedicated Hermes profiles, choose from actual available model metadata, install general pack, optionally SEO, discover and confirm tools, print readiness and capability checks. `--yes` selects only available zero-cost high-confidence candidates. |
| `fbl update --dry-run` | List installed runtimes, adapter copies, extensions and skills. Does not download or replace files. |
| `fbl update [--source RELEASE_DIRECTORY] [--wait SECONDS] [--pause-hermes]` | Verify a complete prebuilt release; wait/refuse active or unsettled tasks; lock, optionally pause scheduling, back up, stop only identity-verified own daemons, swap atomically, migrate managed templates/profiles, import-check and restart previously running daemons. Failure restores previous files. Unknown process or new task prevents unsafe rollback and retains the backup. |
| `fbl doctor [--fix]` | Check each chain; `--fix` repairs owned manifests/profiles/templates and may start a missing, verified idle daemon. Preserves Hermes model migration, config version, unrelated fields, unknown profiles and root authentication. |
| `fbl logs [--follow] [--type system\|execution\|inference\|capture\|stderr] [--errors]` | Bounded event/stderr views. Following does not start Hermes. |
| `fbl logs --bundle [OUTPUT.tar.gz]` | Private archive of fixed diagnostic codes, numeric event fields, stderr signatures and configuration presence. No page data, credentials, raw argv or arbitrary exception bodies. Existing archive is preserved. |
| `fbl packs list` | List bundled and local packs. |
| `fbl packs install general` / `seo` / `LOCAL_DIRECTORY` | Validate and install a managed pack, register its generated path; modified managed files are preserved. |
| `fbl packs remove PACK_ID` | Remove only an unchanged managed pack and its registered path. |
| `fbl packs init [ID] [--argv JSON] [--capability NAME] [--url URL]` | Generate a validated local skeleton under the selected runtime; verify local script paths. Install/review it before use. |
| `fbl packs discover [--url URL] [--scan-tabs] [--no-draft] [--yes]` | Read skill declarations/help, MCP schemas and opted-in report layouts; show source/evidence/confidence/cost/validation and editable binding values before saving. Unknown or paid candidates require explicit selection. |
| `fbl browser [--session FILE] OPERATION [JSON]` | Core browser bridge without Hermes. Use `browsers`, `create`, `get`, `run`, `close`; session identity is private and cannot be supplied in JSON. |

Each subcommand accepts `--user-home`, `--hermes-home`, `--runtime`, `--source`. Explicit paths are for controlled installations and isolated tests; symlink targets are refused. Never change HOME or bypass a guard to make an update succeed. `update --source` expects a prepared, hash-verified release, not a source checkout. No source argument downloads the fixed project's latest stable release through the existing release verifier.

Setup does not copy authentication. If Hermes is absent, core skills work; collaboration stays pending. If a dedicated profile already exists without our ownership marker, setup preserves it and reports pending. Template conflicts produce `.json.new` files for manual merging. Modified skills prevent replacement. Reload an unpacked extension when update asks; Python cannot bypass browser extension installation policy.

Discovery and confirmation are also available in sidebar readiness and Settings → Local capabilities → Discover. Reopen the checklist after fixing readiness; close collaboration and reload declarations after confirming new bindings. Doctor compares local sources and help/MCP metadata; collaboration startup checks local files/new skills immediately and refreshes help/MCP metadata in a bounded background worker. Browser layout refresh checks previously confirmed URLs when connected; new URLs/tabs require opt-in; unavailable remote checks are not proof of unchanged layout. See [pack development](fbl-packs.md) and [troubleshooting](fbl-troubleshooting.md).
