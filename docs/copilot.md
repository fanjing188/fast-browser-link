# Copilot mode (2.2.0 local candidate)

Copilot collects bounded semantics and recent user steps while enabled. One persistent ACP session only infers suggestions; its default profile is `copilot`, and `/tools` must confirm zero tools before it becomes ready. It does not create a workspace.

Executing a suggestion launches an independent Hermes chat process with explicit template toolsets, optional model, and a default 30-turn limit. The default execution profile is `gefei`; concurrency defaults to three. Each execution creates and cleans up its own normal browser-link task/group with a `Hermes 协作·` title prefix, preserving existing ownership and authorization. There is no shared owner or merged group.

Preview `bash scripts/setup-copilot-profile.sh --model '<available fast model>' --provider '<provider>'`, then add `--apply` to create the dedicated profile. The initializer only creates `copilot`, does not clone credentials or change existing profiles, and refuses unknown or modified existing targets. Hermes may share root authentication; this was confirmed for the user’s existing copilot profile, so separate setup is not always required. It disables ACP tools, MCP, plugins, memory and skill injection and provides empty identity/rule files; a small Hermes runtime prompt remains.

Configuration: `<runtime-root>/plugin-data/fast-browser-link-native/copilot/config.json`. Independent installations use `~/.fast-browser-link`; the Hermes adapter uses its existing shared root. Set `inference_profile`, optional `inference_model`, `exec_profile`, optional `exec_model`, `max_turns`, `max_parallel`, report directory and pool argv locally. Installation only fills missing configuration/templates. No real installation or sync was performed.

Local filtering, 1.5-second debounce, five-second minimum interval, single inference, incremental 3KB snapshots, configurable context rollover (default 8000 tokens), idle pause/shutdown, seven-day caching and daily token limits remain. Cached executions and saving the pool bypass model calls. Completed work contributes only a line of at most 100 bytes to inference, rather than the full result. ACP cumulative usage is counted by differences; missing usage is labelled as estimated.

No control values, editable content, cookies, storage, full DOM, special browser pages or PDFs are collected. Floating-button sidebar opening has an in-page fallback. Stop targets the execution process group; previous side effects are not undone.

This is an unpublished candidate. User-supplied local measurements show early-turn usage around 1.5k–2.2k tokens and 2.7–3.0 seconds including debounce. Longer-context costs, browser behavior, process/task cleanup and external pool writes still require acceptance. See the [implementation report](growth/report-copilot-mode-p1.md) and [Chinese guide](copilot.zh-CN.md).

First run setup-copilot-profile.sh if the profile does not exist. Existing configuration is preserved. The 8000-token rollover threshold is not an absolute request-size cap; there is no hidden 2200-token limit or automatic pause at 3000 per turn. Daily budgeting remains. Model responses allow surrounding whitespace and a complete JSON code fence; parsing is retried once, with both attempts counted, before the response is rejected.
