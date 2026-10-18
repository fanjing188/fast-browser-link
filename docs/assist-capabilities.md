# Tool-aware Assist capabilities

Assist loads the bundled generic package, configured `extension_dirs`, and local `extensions/*/package.json` under its own data directory. Loading a declaration does not execute it. Public source contains no private provider routing, credentials, team thresholds or personal script locations. See the [schema catalog](assist-capabilities.schema.json), [example package](examples/copilot-package/package.json), and [package setup](assist-packages.md).

The capability page shows which implementation is bound, executable/script checks, read-only browser probe status, cost labels, batch limits and serial lanes. It runs once when Assist starts and can be refreshed manually, including while models are off. Command checks never invoke providers. Browser probes use owned background work pages and declared readiness selectors; no credential values, login, export or payment actions. A successful probe means the interface can be attempted, not that all report data or account quotas have been verified.

Skill discovery reads bounded frontmatter, names/descriptions and declared capability names. Heuristic matches remain “can bind”; they never become executable bindings automatically. The user reviews an implementation declaration and confirms the local save. Nothing modifies the Hermes root configuration.

## Standard contracts

The catalog declares inputs/outputs for `keyword.metrics`, `keyword.expand`, `keyword.questions`, `serp.top`, `domain.keywords`, `domain.top_pages`, `domain.authority`, `domain.competitors`, `site.page_family`, `trends.series`, `keyword.judge`, `pool.lookup` and `pool.save`; `keyword.filter` is a local extension. Custom contracts can be declared in `schemas`, using the same supported JSON Schema subset.

Most outputs are `{records,source,missing?,partial?,pages?}`. Rows use typed fields such as keyword/vol/kd/cpc/position/url/traffic/domain/authority/tier and per-field `field_sources`. `trends.series` uses measured dated series. `pool.save` returns actual written/skipped/accepted keyword receipts. Unknown metrics are omitted, never zero. Batch metrics require every requested term. SERPs retain each keyword's own observed results.

`metric_quality` distinguishes exact measurements from discovery estimates. Candidate metrics cannot be used for local grading. Supplementing contextual metrics preserves existing exact flags and provenance. The `fields` input can request traffic or original monthly values specifically; implementations must declare that they provide those fields.

## Declaration format

Add `capabilities`, `flows`, optional `schemas`, `experience_file` and `files` to a version 1 package. Legacy fetcher declarations remain supported.

```json
{
  "id":"example-local",
  "version":1,
  "files":["adapter.py"],
  "capabilities":{
    "keyword.metrics":[{
      "id":"example-exact-metrics",
      "type":"command",
      "argv":["python3","./adapter.py","{keywords_file}"],
      "priority":10,"batch_limit":100,"exact":true,
      "fields":["vol","kd","cpc"],
      "serial_group":"example-account",
      "stop_codes":[3],"cost":"configured provider quota"
    }]
  }
}
```

A binding has a unique ID and one of three types:

- `command`: argv, timeout, JSON/CSV output declaration, optional required paths, partial exit codes and stop text/code meanings. Stdin JSON and job-local `input_json`, `input_csv`, `keywords_file`, `output_csv`, `output_json`, `work_dir` placeholders are available. No shell; data cannot become positional options or interpolated interpreter code.
- `browser`: `tool`, `page`, `link`, `verified`, optional browser restriction, maximum pages and stop conditions. It opens only a profile host, uses visible tables and mapped columns, and retains URL filters when staying on the same report path. A route lacking confirmation is unavailable. An optional `plan_argv` can run a local query constructor without submitting RPC data. It does not make an unverified route valid.
- `hermes`: an explicitly configured oneshot tool fallback, bounded turns and normal authorization. It is unavailable in ACP-only mode. Resource leases constrain protected tool origins. Agent observations remain unverified candidates, not exact metrics or authoritative SERPs for grading; actual tool receipts need separate review.

Lower numeric priority wins, with usable bindings for the current recognized tool preferred. A failed or incomplete source can fall back; fields already measured by the preferred exact source are preserved. Shared `serial_group` locks span workflow threads/processes and read-only probes. All browser bindings for one tool must share the lane. Quiet general tasks cannot open protected origins outside a valid capability lease. Other independent applications must cooperate with the same lane; Assist does not change their code or take over their sessions.

Stop conditions disable the whole declared source lane until the next local date. Login, challenge, quota, rate limits and uncertain cleanup are reported; there is no account rotation, gate solving or automatic replay. Refresh does not clear a same-day disabled source. Independent available sources continue; all unavailable sources produce missing data.

## Profiles, workflows and learning

A tool has fixed hosts, bilingual name, link templates, a read-only probe and pages. Each page declares path patterns, optional query-object parameter, column aliases, actions and workflow IDs. No overlapping host profiles. Standard table export keeps its three-row threshold; an explicitly bound report reader can read a single data row. Non-tabular dashboards without a compatible table remain unsupported and are marked missing.

Flows use ordered unique step IDs, `capability` calls, `foreach`, typed input references (`$input.object`, `$steps.id.records`, `$item.domain`), `words_from`/`domains_from`, deterministic transforms and at most one judgment step. The bundled flows cover leading sites, smaller sites, page families, shared keyword opportunities, intent splits, seasonal windows, pool context, domain pages/changes/gaps and rising queries. Private bindings supply actual providers and policy. Explicit market/language requests must match a declared binding scope; unknown scopes are not silently borrowed. Basic template fetches prefer local capability bindings and preserve their field provenance; their existing general judgment interface remains distinct from policy-based workflow grading.

Each finished step writes an independent local artifact before progress advances. Stop cancels active child processes/model sessions and preserves completed steps and a partial result. Report pages use the existing paginator/virtual scrolling guards, jitter and page budget; no site export button. Keyword candidates are budgeted to 20 per generic run, while complete upstream artifacts remain local. The preview is limited to 1,000 rows and 200 KiB with an explicit notice; workflow bodies are fetched on expansion instead of repeated in every dashboard update; chunked report replies are bounded to 4 MiB. Judgment context remains bounded to 128 KiB.

Model judgment only adds existing-row intent/group/reason annotations. It cannot fill metrics, host or duplicate facts, overwrite known exclusion flags, or invent new row identifiers. Local judgment is a command capability. Pool writes require a separate explicit save action; data workflows cannot automatically write the pool. New-site discoveries are candidate artifacts, never automatic edits to external backlogs.

Tool memory stores only tool/page/action click and ignore counts plus source stop states, not selected text or report contents. Raw workflow evidence is stored separately as requested task output. Recent trajectories, selected object, table summaries and read-only related-pool context inform suggestions. Available flows are ranked first; missing bindings produce disabled cards that link to configuration.

“Remember this tool” sends only host/path/title/table headers to one zero-tool inference turn. The profile remains a draft. The user can edit it and must confirm a separate save to a local package. Saving a profile does not silently create capabilities or approve routes. Manual and learned bindings are validated before replacing any local declaration.

The setup script supports `--copy-assets` for explicitly listed package files and repeatable `--experience-source` arguments. It extracts at most 800 characters of local context without a model. Preview is the default; apply only creates missing files with restrictive permissions, writes the declaration last, and never changes Hermes/Assist root configuration. Existing package files are never overwritten.

Workflow judgment receives a semantic projection (existing row keys, keywords, URLs, titles and known intent/exclusion flags), plus requested trend series. Exact metrics and authority evidence stay in local step artifacts and the local grader. Reviewed pool terms are excluded before additional measurement; expansion loads a workflow body on demand.

Authority values keep an explicit authority_kind and are not automatically converted to a grader-specific score. Private grader adapters choose their own mapping. To refresh local experience, close Assist, wait for tasks/probes to finish, then use Reload local declarations; the next inference session receives the new prefix. Shared tool probes are reused within one health run.

Bindings declare supported reports explicitly. An input such as report=new_improved or report=rising cannot fall through to a plain ranking snapshot or suggestion endpoint. Missing specialized reports are shown as missing bindings.
