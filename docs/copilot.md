# Copilot (2.2.0 local candidate)

Copilot follows bounded semantic snapshots and recent actions. The sidebar now loads Hermes model catalogs before activation, with a 24-hour daemon cache and explicit refresh. Catalog discovery uses initialize/session/new only, without model prompts. Missing catalogs allow manual provider:model IDs. Credentials and profile defaults are never changed.

The main view shows status, informational daily/session usage and suggestions/running/results. Settings and logs use secondary views in the same sidebar. Settings are grouped into interface, execution mode, collapsed advanced controls and local capabilities. First activation uses Balanced defaults with a dismissible notice. Fields auto-save and show a brief check mark; changes affect subsequent calls while running tasks retain their starting configuration. Presets match model names rather than live prices. Unmatched IDs use profile defaults.

User-run initialization/managed upgrade:

```sh
bash scripts/setup-copilot-profile.sh --apply
bash scripts/setup-copilot-profile.sh --profile copilot-exec --apply
```

Preview first without --apply. Unknown or modified profiles, changed plugin links and different model/provider arguments are refused. Verified owned files receive title-generation/approval additions; the execution ACP toolset becomes empty for judgment, while CLI retains browser/web/terminal/file tools. No permanent terminal commands are allowed and no yolo mode is enabled. The user runs this script; this candidate has not been installed or synchronized.

The default persistent execution ACP creates a fresh session per SEO judgment, verifies zero tools, sends one model prompt, and writes/validates its returned JSON in the daemon. /tools and /reset are local controls. Sessions run concurrently, bounded by max_parallel; cancellation targets one session. A crashed connection restarts once without replaying in-flight tasks. Completed task memory is limited to500 UTF-8 bytes.

**Current Hermes ACP has no effective per-session tool/iteration controls or close-session method.** Full general tasks are refused in ACP mode; explicitly choose oneshot to run them with bounded tools. /reset clears history but does not end/remove the retained Hermes session object. These upstream limitations remain unfulfilled requirements, not validated capabilities.

SEO data acquisition runs in daemon subprocesses: Google Suggest for longtail; user-configured keyword_metrics/serp_top10/competitor_keywords JSON commands; the existing matching snapshot for SERP breakdown. save_pool and cache hits remain local. Fetch commands take stdin JSON and return schema-validated stdout JSON; private adapters and credentials belong in local fetch_commands/fetch_dir configuration. See template output schemas. Missing sources, timeout or malformed data are explicitly marked. Keyword browser fallback is opt-in and uses bounded oneshot execution, default3 turns. Pure judgments use no tools and one turn, irrespective of the quality preset.

Input, cache-read and output tokens remain informational per day/session/task/model. There is no weighted daily limit or usage-based pause. Legacy daily_token_budget/cache_weight keys are ignored on read and removed on the next save. Context rollover defaults to 6000; unreliable usage is labeled estimated. Idle pause after three minutes and automatic close after thirty minutes remain. Work-tab exclusion and typed-value privacy boundaries remain unchanged.

See the [implementation report](growth/report-copilot-mode-p1.md) for verified tests, source contracts, user-supplied4198-token measurement, remaining blockers and real Edge checks.

## R7 structured results and local tables

Each template now owns its result and decision schemas: verdict≤30, level, up to3 metrics, missing, process and next, with typed keyword/longtail/competitor/SERP/local-save/general bodies. Model judgments cannot overwrite raw metrics. Legacy caches convert where possible; otherwise use a generic review card. No raw JSON is printed in the sidebar.

Cards progressively disclose groups (first5), competitor rows (first10), selection/batch actions and a full internal result page. Batch keyword checks create one execution, capped at1000 words without truncation. Replenishment fetches metrics only and keeps the prior judgment. Missing columns are omitted. Pool membership requires a verified accepted_keywords receipt; unknown written counts are null. Replacements preserve history and reports, children attach to parents, older roots fold after20.

Local table detection handles native/ARIA/data-ui/repeated div structures. Rendered visible text only, no input/editor/hidden values. Table data remains on the local path; inference receives header/count summaries. Current-page exports and manual recognition work without activating a model. XLSX uses only Python stdlib ZIP/XML; BOM CSV and parsed-numeric/link columns preserve data, with formula-like CSV text protected. TSV copies the original visible text.

Multi-page collection uses the existing workspace-only approval and ownership pipeline in an inactive separate work window, keeping normal/incognito context. URL/button/infinite/virtual pagination is deduplicated and bounded. Production clicks use bound Executor references; scrolling uses a scoped, static Executor operation. Default jitter1.5–3s and50-page cap; exceeding the configured cap requires another explicit sidebar confirmation. Stop, blockers, changed ownership/schema or timeout save partial data. Virtual units are batches. Hidden-page throttling is bounded by worker polling and10s script timeout, never by focusing tabs or disabling browser throttling.

Silent child tasks receive a rotating nonpersisted capability, force separate windows, skip activation queues and deny explicit foreground/unmanaged-target CDP calls. User-focused or moved work tabs are rejected. No system notifications for these tasks; the sidebar owns progress/results. The user may explicitly open exported files. See the report for actual evidence, static samples, remaining upstream ACP limits and real Edge acceptance.

Selection tasks, trends and local adapter packages: see [Copilot extension packages](copilot-packages.md).

Tool memory, capability binding, discovery and composable workflows: [capability guide](copilot-capabilities.md).

## Live logs

Capture, inference, execution and system events record fixed summaries, sizes, timings, model usage/estimate flags, suggestion counts, source IDs and page/script stages. No input values, cookies, authentication headers, page bodies, raw errors or command arguments are logged.

Events batch every 200ms. The log page renders only its fixed-height viewport window; JSON details are separate. At most 2,000 records are retained, with type/error/search filters, pause/follow, clear for the current browser/day, and full JSONL copy/export. Logs use the existing seven-day directory as logs/YYYY-MM-DD.events.jsonl with mode 0600 and reload on reopening the sidebar. Connection events observed offline remain explicitly volatile until reconnect submission and readback.

The board defaults to “Hermes Copilot” (Chinese: “Hermes协作看板”). Rename it in Settings → Interface; the brand remains Fast-browser-link. The primary view contains connections, suggestions/running tasks/collapsed results, the latest three logs and one usage line. Execution, table/export and local capabilities live in secondary settings. The popup shows the inline Board button only while collaboration is enabled.

Table extraction requires synchronized confirmation in the sidebar and a closed-shadow decoration on the source page. No export or multipage work starts before confirmation. Escape, cancellation and target removal clear it; changed ownership, navigation or changed captured rows reject stale confirmation. Multipage confirmation opens the same URL in a background work page, retaining the 200-page ceiling.

Local Hermes health reads ACP readiness, execution-profile file and executable existence, and the latest call result. `execution_startable` denotes a structural check, not a live launch or model proof. Reading health starts no model and consumes no tokens; Retry after a startup failure starts a new collaboration session. A disconnected state can mean collaboration is off. Renaming and export preferences only write this extension instance's Copilot configuration.


## Managed templates and startup recovery

Install, sync and initialization share `copilot_setup.py`. The instance's `copilot/managed-templates.json` contains `version: 1` and a `templates` map keyed by filename. Each entry stores a content version (`sha256:` plus the first 12 digest characters) and the full `sha256`. Unmodified files upgrade automatically; missing and newly introduced templates are filled. Existing configuration is preserved.

Modified or unknown templates stay intact. The new version is written to `templates/<name>.json.new`, with `pending_version` and `pending_sha256` in the manifest; Settings → Local capabilities lists merge requests. After reviewing and adopting the new file, initialization records its digest and removes an unchanged candidate. Custom merges remain user modifications.

For installations without a manifest, only exact raw-byte digests from `native-bridge/copilot-templates/managed-history.json` or the current source qualify as managed. The history contains filenames and hashes from actual Git versions. To maintain it, extract each shipped template with `git show <commit>:<template-path>`, compute SHA-256 over the exact bytes, and append deduplicated hashes without deleting older entries. Never collect personal templates or infer ownership from missing fields.

Missing `decision_schema` receives the action's default contract. Irrecoverable templates are excluded from inference contracts and suggestions and logged once; other templates can still start the session. Local capabilities lists disabled templates. Startup errors expose a short reason, with fixed error codes and exception types in logs rather than arbitrary exception text.

The browser background retries failed session starts after 5, 15 and 60 seconds, then stops at Error · retry. Ready or a manual toggle resets the startup budget; recovery-failure retries require a successful inference to reset automatically; turning collaboration off cancels waiting. Reopening or repainting the panel does not reset the background budget. Destroyed background timers are not restored. No tasks are replayed. Native browser-bridge reconnection remains independent.

Health summaries count all capabilities: available if a usable binding exists; otherwise awaiting login/browser/route confirmation if such a binding exists; otherwise unbound (including bindings that are currently unusable). The three counts add up to the capability total; details retain each capability's category.


## Inference diagnostics and recovery

Errors distinguish `model_output_invalid`, `acp_disconnected`, `acp_timeout`, `acp_process_exited` and `internal_error`, with fixed field/validation codes, exception types and exit codes. The first two consecutive inference failures retain suggestions and show a notice; the third marks an error. Success clears the count. Long titles/reasons are truncated with an ellipsis, suggestions are capped at eight, IDs are host-generated and unknown fields are discarded. Invalid actions/parameters are skipped without expanding permissions. Normalization creates one informational event, not an error alert.

Inference ACP, execution ACP and oneshot stderr are drained continuously and conservatively redacted into `copilot/logs/YYYY-MM-DD.hermes-stderr.log`. Each file is capped at 2 MiB with one same-day `.log.1` archive, seven-day retention and mode 0600. Credential-bearing lines, known token prefixes, long opaque strings, URLs and personal directory paths are masked. Raw model stdout is not included. Process-exit events carry the exit code and last twenty redacted lines. Disconnect events distinguish user, idle, service shutdown, process exit and transport failure.

An unexpected inference disconnect or process exit receives one immediate recovery per enabled collaboration session: revalidate the zero-tool profile, resume using the saved summary, completed-task memory and suggestion statuses, then resend current page deltas. Execution tasks are never replayed. A failed recovery or another exit uses the existing bounded 5/15/60-second startup retry policy and eventually waits for manual Retry. Brief ready states preserve this recovery budget until a valid inference succeeds or the user toggles collaboration.

The managed-profile generator was checked against Hermes configuration source. Creation or verified managed upgrades of `copilot` and `copilot-exec` write `_config_version: 50`, preserve higher versions and model/provider settings, and reject user-modified profiles. No global Hermes migration runs; other defaults merge at read time. Updating source alone does not modify installed profiles.
