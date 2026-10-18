# Assist extension packages

Assist ships a neutral generic package: Google Search, Google Trends, visible table export and keyword workflows. Private tools, credentials, team rules and adapters belong in local packages outside this repository. Packages never grant browser access; normal workspaces, leases, origin checks and quiet execution still apply.

Add absolute package directories to `extension_dirs` in your local Assist `config.json`. Loading is explicit, at daemon startup; no discovery, downloads or execution on package load. Do not change the Hermes root configuration. Existing managed configuration and templates are never overwritten by setup. After an upgrade, review the new template contracts and merge them into your local template copies.

```json
{"extension_dirs":["/absolute/path/copilot-packages/my-adapters"]}
```

Each directory contains `package.json`, version 1. The last package overrides earlier declarations. `generic` is reserved for the bundled package; duplicate IDs fail. An invalid package fails startup rather than silently falling back. See [the offline example](examples/copilot-package/package.json).

- `fetchers`: fetcher name → command argv. No shell. `./file` arguments resolve against the package directory. Commands take stdin JSON and return stdout JSON matching the template's `output_schema`. Use environment/local credential files inside your adapter; never put credentials in a template or repository.
- `pool.command`: accepts stdin `{"keywords":[{"keyword":"sample"}],"csv_path":"...","date":"YYYY-MM-DD"}`. There are **no implicit CLI flags**. Returns `{"written":1,"skipped":[],"accepted_keywords":["sample"]}`. Legacy command-line adapters need a local wrapper. With no configured pool, no write happens; the result shows missing receipt data.
- `pool.lookup_command`: read only, accepts `{"keyword":"sample"}`; returns `{"found":true,"tier":"test","last_checked":"YYYY-MM-DD"}`. Three-second timeout. Lookup/cache/menu classification does not call models.
- `rules`: JSON judgment policy merged into the model brief. The generic policy has no volume/KD threshold. Configure measured numeric gates and intent guidance here, not in product code. Missing data remains unknown.
- `tools`: `{id,hosts,name:{en,zh},links}` profiles. Links may use `{keyword}`. They describe local tool capabilities and are included as context, never permission grants or automatically opened destinations.
- `templates`: supported action ID → relative JSON file inside the package. The template must retain the host's typed result/decision contract. Use `prompt` and `prompt_en`, parameter/output schemas and fetch steps. A local template can use a custom JSON fetcher but cannot enable arbitrary content-script code.
- `workflows`: currently `seo.ranking_sites: {seed_fetcher,site_fetcher,max_sites}`. The built-in workflow fetches one SERP, then up to the first three distinct domains, then makes one combined judgment. `max_sites` is 1–3. The two adapters retain the canonical SERP/competitor output schemas.
- `prompts`: optional `{action:{en,zh}}` prompt overrides. They are model instructions from an explicitly configured local package, not page-provided text.

For declaration generation, prepare your own `package.json`, then preview:

```sh
python3 scripts/setup-copilot-package.py --source /absolute/path/source/package.json --destination /absolute/path/copilot-packages/my-adapters
```

Add `--apply` only when ready. The generator writes the declaration with mode 0600, never overwrites an existing declaration, and does not edit Assist/Hermes configuration. Place referenced local scripts/template files in the destination yourself. Relative template paths cannot escape the package directory. Configured local commands are trusted code and are executed only when their capability is requested.

Google Trends uses background work pages, groups up to five terms per chart, and visits US/world × last 12 months/5 years. It reads visible chart data tables with explicit dates and values (0–100). It does not infer values from SVG geometry, access private endpoints, log in or solve challenges. If the site's chart does not expose such a table, the result explicitly marks missing curves; real browser acceptance is required before claiming a working curve source. Trends batches are limited to 50 terms and the complete browser acquisition has a ten-minute bound. Curves from different comparison groups are independently normalized and must not be compared as absolute demand.

Browser language selects Chinese or English interface labels and model prompts. Page content, keywords and source text retain their original language. The selection popup follows Assist on/off, can be disabled separately, ignores editors/password forms/work pages, and only shows a sidebar entry beyond 300 characters. A seven-day hit opens the exact existing result without fetching or judging again. Selection-driven inference is deduplicated for ten minutes. Translation/explanation uses one turn on the inference model with no tools; tool-requiring general tasks retain the explicit oneshot boundary.

For page-related work, background pages receive the same URL, including filter/sort/search parameters and normal/incognito context. In-memory filters and form values are not copied; the UI warns that background filters may differ. No user tab is activated or modified.

Browser fetch messages and the judgment context are bounded at 128 KiB; an oversized batch is marked unavailable rather than truncated or retried. Reduce the batch size if necessary.

The public Google Search fallback also keeps per-keyword SERPs in one acquisition job (maximum 50 words, paced; challenges stop the batch). A configured bulk adapter may use the template batch limit of 1,000.
