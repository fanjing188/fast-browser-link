# Packs and local capability declarations

A runtime loads `package.json` version **1** from registered `extension_dirs`. Pack metadata `pack.json` records dependency names and revision policy; the executable contract remains `package.json`. Builtin `general` depends on `browser.core`; `seo` additionally needs agent judgment for conclusions. `fbl setup` installs general, asks about SEO (default no), and sets `managed_packs` so legacy builtin templates are not loaded a second time. Already configured legacy installations keep their existing behavior until setup opts in.

`fbl packs init my-local --argv '["python3","/absolute/local/script.py","--input","{input_json}"]' --capability keyword.expand` generates a skeleton under the selected runtime's `plugin-data/fast-browser-link-native/copilot/drafts/my-local`. Existing scripts must exist. No user-entered runtime root, symlink or traversal is accepted. Review it, then `fbl packs install GENERATED_DIRECTORY`. This registers the path. Remove an unchanged managed pack with `fbl packs remove my-local`; user modifications block overwrites/removal.

Updates compare `.fbl-pack.json` / `.fbl-skill.json` digests and recognized historical skill digests. Unmodified builtin packs and installed skills update in the same rollback transaction as the runtime. Modified files need manual review; templates retain `.json.new` candidates. Schema version changes require an explicit migration; never reinterpret unknown versions.

## General recipes

`package.json` remains **version 1**; all generic fields are optional. `scene` contains an `id` and bilingual `name` (default scene ID: pack ID). `objects` maps custom type IDs to bilingual names and `from` sources: URL parameters, column aliases, or a selection regular expression. Only a full regex match makes selected text an object of that type. `keyword`, `domain`, and `url` remain reserved; old packs load unchanged.

Custom `schemas.<capability>.input/output` define domain records under `output.properties.records.items`; the envelope remains `records`, `source`, optional `missing`. Page `columns` accepts fields declared by the pack's output record schemas. Templates may use `<pack-id>.<name>` as well as builtin namespaces; paths stay inside the pack and host template validation still applies. Flows can declare bilingual `description` and `when`, their own `decision_schema`, and `result: {columns: [{field, label: {zh, en}}], primary}`. Without a decision schema, the existing `DECISION` applies. Custom decisions are retained separately as `decision`, preserving source records. Without explicit columns, custom records use the final output schema; legacy string result references continue to work.

Inference receives only page-matched workflows with names, descriptions, timing, object types, and explicit objects; these flows are valid in their own scene or `general`. Builtin SEO actions retain their conditions. Completed, ignored, or deferred actions are not repeated. Package schemas use the host subset (`type`, `properties`, `required`, `additionalProperties`, `items`, `maxItems`, `minLength`, `maxLength`, `enum`), limited to 32 KiB, 8 nesting levels, 100 fields per object, 12000 characters per string, and 5000 array items. Use `additionalProperties:false` to reject undeclared record fields; builtin capability contracts cannot be replaced.

Local steps add `filter` (`field` plus `equals`, `contains`, or inclusive `min/max`), `dedupe` (`field`), `sort` (`field`, optional `direction: asc/desc`), `top` (`n: 0–5000`), and `pick` (`fields` list or source-to-destination map). These transforms have `risk: zero` and perform no provider or browser calls. Missing filter values do not match; missing sort values stay last. Generic tables support per-column sorting, filtering, row selection, copying and CSV export; missing values read “Unknown”, while actual zero remains zero. Adding to the basket reuses confirmed table exports. Operations use visible selected rows, or all filtered rows when none are selected. Visible cell samples are redacted and bounded to 3 tables, 10 rows each and 2400 bytes total.

See the [package schema](fbl-pack.schema.json), [full field reference](adapter-packs.zh-CN.md), and executable [synthetic support pack](examples/adapter-pack/package.json), using `support`, `case_id`, `customer`, `missing_materials`, and `status` without SEO fields.

`general/pack.json` documents agent-side recipes, not extra RPC method names. For reading, use `fbl browser browsers`, create an owned task, open `new_tab`, read `semantic_snapshot`, then close. Keep one private `--session` per task. For table export or multi-page collection, the sidebar recognizes tables and requires confirmation before saving/collecting, with bounded pages and partial coverage. Page summary uses the calling agent's judgment over read content. Form assistance prepares ordinary values, asks for confirmation and lets the user perform final submission; sensitive fields stay manual. Free core browsing itself makes no model/provider call.

The SEO pack binds public suggestions, search result pages, trends pages and sitemap families. It does not provide private accounts or paid metrics. Missing volume/KD stays unknown; neutral decisions use configurable local rules rather than fixed thresholds. Inference can still have the user's configured model cost. Avoid programmatic queries during discovery; a real authorized workflow is separate.

## Add a manifest to your skill

Put optional `fbl-capabilities.json` beside `SKILL.md`. Start from [the synthetic example](fbl-capabilities.example.json) and [schema](fbl-capabilities.schema.json). Do not commit personal paths, tool names, domains, credentials or business thresholds to this repository.

Each entry declares a standard capability, cost and command binding: argv template, JSON/CSV output, priority, batch limit, timeout and stop codes/text. Relative script files resolve against the skill directory; command must exist in PATH or at an absolute path. Arguments execute as a list, never a shell string. Use `{input_json}`, `{input_csv}`, `{keywords_file}`, `{output_json}`, `{output_csv}`, `{work_dir}` or approved input fields. Script stdin is also the input JSON. JSON output must satisfy the standard capability schema; metric quality and missing fields remain explicit. `--help` must be local and side-effect-free.

Standard names include `keyword.expand`, `keyword.metrics`, `keyword.questions`, `keyword.judge`, `keyword.filter`, `serp.top`, `domain.keywords`, `domain.top_pages`, `domain.authority`, `trends.series`, `pool.lookup`, `pool.save`. Judgment/filter/pool operations stay local commands. See `native-bridge/copilot_capabilities.py` for authoritative input/output schemas and `copilot_packages.py` for supported binding fields.

Discovery uses declarations deterministically. Without one, SKILL text and bounded script help go into one zero-tool model turn labeled “model draft, confirmation required”. Help runs with timeout and network denial; if that sandbox is unavailable it is not run. MCP reads configuration and `tools/list` only, never actual tools. Environment values and authentication are referenced from configuration and are not copied into generated packs. HTTP MCP redirects require review.

Websites are found from user-provided URLs or explicit opt-in to open-tab URL/title inventory (normal tabs only; no history). Discovery opens owned work pages and reads only login state and report headers. Matching uses structural aliases, not domains. Unknown, paid, model-drafted or login-blocked candidates are unchecked. Only declared available zero-cost candidates with confidence at least 95% default checked. Review source, evidence, confidence, cost, validation and editable priority/arguments/bounds; confirmation saves a generated local `extensions/discovered` package, never the repository. Newly seen report headers produce a sidebar review notice, without a query.

Doctor compares file digests, help summaries and MCP schema hashes. Collaboration startup checks local files/new skills and refreshes help/MCP metadata asynchronously. Doctor can refresh previously confirmed report headers when connected; startup uses subsequent observed headers and never opens pages. New URLs/tabs require explicit opt-in. Changed sources prompt reconfirmation and never rewrite confirmed bindings. A missing probe cannot certify unchanged remote state.

## Active following: triggers and next

Flows optionally declare `triggers` (up to 20 clauses). Clauses are OR; keys within one clause are AND, independent of key order. Supported keys are `page: {tool, page}`, `table_columns: {all: ["Case", "Status"]}`, `selection: {object: "case_id"}`, `after: {flow, status: "completed"}`, and `dwell_seconds: 20` (0–86400). Columns must occur in the same already captured table, compared case-insensitively. Selection must fully match the object's declared selection regex. Completion requires the same object and a successful result in the current work. Dwell resets on page/tab changes and is checked every five seconds. Flows remain confined to their declared matching pages. Omitting triggers preserves existing recommendations; `[]` permits continuation only.

A match creates a suggestion with its trigger reason without starting a model inference. The model can rank and handle uncovered cases, but cannot bypass triggers. Model and deterministic proposals are deduplicated by flow/object and limited to 10 automatically proposed pending items. Explicit user tasks and existing execution/results are retained. Completed, Later, Wrong direction and today's ignored proposals remain suppressed. Habits can rank eligible flows, never create out-of-scene ones.

`next` accepts up to 20 `{flow, when}` entries; the target must exist and use the same object type. Every `when` requires `field` and `records: "any" | "all"`. Choose one operator: `empty: true | false`, `equals: scalar`, `contains: scalar`, or inclusive numeric `min`/`max` (either or both). Missing fields and empty record sets never match; null, empty strings/arrays/objects are empty, whereas 0 and false are not. Equality checks both type and value; contains handles string substrings and array membership. Conditions inspect successful result records only. The next proposal inherits the completed object's value, still requires a page-matched target, and is never automatically executed.

Synthetic support example additions, merged into the existing flow declarations (include the target in the page's `flows` list):

```json
{
  "support_materials": {
    "triggers": [
      {"page": {"tool": "support-triage-example", "page": "case"}},
      {"table_columns": {"all": ["Case", "Status"]}},
      {"selection": {"object": "case_id"}},
      {"dwell_seconds": 20}
    ],
    "next": [{"flow": "support_reply_draft", "when": {"field": "missing_materials", "records": "all", "empty": true}}]
  },
  "support_reply_draft": {"object": "case_id", "triggers": []}
}
```

These are additions, not complete runnable flows: retain names and steps, declare `judgment: false` and `risk: "zero"` on each model-free flow and `risk: "zero"` on its local steps, and supply the target's reviewed read-only steps. The Chinese field reference includes a complete flow fragment. This example does not send a reply.

Captures add visible field labels (`label`, `aria-label`, `placeholder`) and h1–h3 text, at most five per level. Values are never read. Password, verification and payment fields contribute only a sensitive-fields-present marker. Snapshots remain within 3KB, prioritizing table summaries, headings and selected objects over form labels, with existing redaction and permissions.
