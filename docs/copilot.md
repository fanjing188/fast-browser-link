# Copilot (2.2.0 local candidate)

Copilot follows bounded semantic snapshots and recent actions. The sidebar now loads Hermes model catalogs before activation, with a 24-hour daemon cache and explicit refresh. Catalog discovery uses initialize/session/new only, without model prompts. Missing catalogs allow manual provider:model IDs. Credentials and profile defaults are never changed.

Select saving/balanced/quality/custom, inference/execution models, concurrency1–3, weighted daily budget, context threshold, tool-turn multiplier and execution transport. Presets fill fields using name heuristics, not live price rankings. Start saves daemon-local configuration before activation. Changes apply to the next inference/execution; running tasks keep their settings. Models and input/cache/output usage appear on cards and in per-model totals. Oneshot model attribution uses Hermes startup metadata, not independent provider billing evidence.

User-run initialization/managed upgrade:

```sh
bash scripts/setup-copilot-profile.sh --apply
bash scripts/setup-copilot-profile.sh --profile copilot-exec --apply
```

Preview first without --apply. Unknown or modified profiles, changed plugin links and different model/provider arguments are refused. Verified owned files receive title-generation/approval additions; the execution ACP toolset becomes empty for judgment, while CLI retains browser/web/terminal/file tools. No permanent terminal commands are allowed and no yolo mode is enabled. The user runs this script; this candidate has not been installed or synchronized.

The default persistent execution ACP creates a fresh session per SEO judgment, verifies zero tools, sends one model prompt, and writes/validates its returned JSON in the daemon. /tools and /reset are local controls. Sessions run concurrently, bounded by max_parallel; cancellation targets one session. A crashed connection restarts once without replaying in-flight tasks. Completed task memory is limited to500 UTF-8 bytes.

**Current Hermes ACP has no effective per-session tool/iteration controls or close-session method.** Full general tasks are refused in ACP mode; explicitly choose oneshot to run them with bounded tools. /reset clears history but does not end/remove the retained Hermes session object. These upstream limitations remain unfulfilled requirements, not validated capabilities.

SEO data acquisition runs in daemon subprocesses: Google Suggest for longtail; user-configured keyword_metrics/serp_top10/competitor_keywords JSON commands; the existing matching snapshot for SERP breakdown. save_pool and cache hits remain local. Fetch commands take stdin JSON and return schema-validated stdout JSON; private adapters and credentials belong in local fetch_commands/fetch_dir configuration. See template output schemas. Missing sources, timeout or malformed data are explicitly marked. Keyword browser fallback is opt-in and uses bounded oneshot execution, default3 turns. Pure judgments use no tools and one turn, irrespective of the quality preset.

Budget = uncached input + output + cache read × cache_weight(default0.1). Context rollover defaults to6000; usage without reliable channels is labeled estimated. Work tabs are excluded using task/workspace ownership; SPA snapshots wait800ms quiet, maximum5s. No typed values, cookies, page storage or full DOM are collected. The ball position is global in extension local storage; model settings remain daemon-local.

See the [implementation report](growth/report-copilot-mode-p1.md) for verified tests, source contracts, user-supplied4198-token measurement, remaining blockers and real Edge checks.

## R7 structured results and local tables

Each template now owns its result and decision schemas: verdict≤30, level, up to3 metrics, missing, process and next, with typed keyword/longtail/competitor/SERP/local-save/general bodies. Model judgments cannot overwrite raw metrics. Legacy caches convert where possible; otherwise use a generic review card. No raw JSON is printed in the sidebar.

Cards progressively disclose groups (first5), competitor rows (first10), selection/batch actions and a full internal result page. Batch keyword checks create one execution, capped at1000 words without truncation. Replenishment fetches metrics only and keeps the prior judgment. Missing columns are omitted. Pool membership requires a verified accepted_keywords receipt; unknown written counts are null. Replacements preserve history and reports, children attach to parents, older roots fold after20.

Local table detection handles native/ARIA/data-ui/repeated div structures. Rendered visible text only, no input/editor/hidden values. Table data remains on the local path; inference receives header/count summaries. Current-page exports and manual recognition work without activating a model. XLSX uses only Python stdlib ZIP/XML; BOM CSV and parsed-numeric/link columns preserve data, with formula-like CSV text protected. TSV copies the original visible text.

Multi-page collection uses the existing workspace-only approval and ownership pipeline in an inactive separate work window, keeping normal/incognito context. URL/button/infinite/virtual pagination is deduplicated and bounded. Production clicks use bound Executor references; scrolling uses a scoped, static Executor operation. Default jitter1.5–3s and50-page cap; exceeding the configured cap requires another explicit sidebar confirmation. Stop, blockers, changed ownership/schema or timeout save partial data. Virtual units are batches. Hidden-page throttling is bounded by worker polling and10s script timeout, never by focusing tabs or disabling browser throttling.

Silent child tasks receive a rotating nonpersisted capability, force separate windows, skip activation queues and deny explicit foreground/unmanaged-target CDP calls. User-focused or moved work tabs are rejected. No system notifications for these tasks; the sidebar owns progress/results. The user may explicitly open exported files. See the report for actual evidence, static samples, remaining upstream ACP limits and real Edge acceptance.

Selection tasks, trends and local adapter packages: see [Copilot extension packages](copilot-packages.md).

Tool memory, capability binding, discovery and composable workflows: [capability guide](copilot-capabilities.md).
