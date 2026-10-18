# From your workflow to a pack

Start with work you already repeat. A pack gives Assist a name for your objects,
a way to obtain data, and a repeatable flow with a useful result. You can start
without a model decision. The [field reference](adapter-packs.zh-CN.md) and
[package schema](fbl-pack.schema.json) describe the complete contract; this guide
walks through one task.

## 1. Write down your work

Fill one row for each of **three things you repeat every day**. Pick the smallest
row to implement first.

| Repeated task | Website and page | Object (`objects`) | Data and source (`capabilities`) | How to decide (`decision_schema`, or no model) | Display (`result`) | Next action (`next`) |
| --- | --- | --- | --- | --- | --- | --- |
| Review missing case materials | Synthetic support desk, `/cases` | Case ID | Local case JSON | List missing materials; no model | Case, customer, missing materials, status | Ask a person to collect materials |
| Your second task | … | … | … | … | … | … |
| Your third task | … | … | … | … | … | … |

A domain is a place where a task happens, not permission to browse. Begin with
synthetic records; replace the source only after you have reviewed its access and
cost. Our support desk is `support.example.test`, an offline test domain.

## 2. Turn the first row into a support pack

Create a directory containing `package.json`. Start with an identity:

```json
{"id":"support-triage-example","version":1,"release":"1.0.0"}
```

For **website and page**, add a tool profile. An anchored path prevents the flow
from appearing elsewhere:

```json
{"tools":[{"id":"support-triage-example","hosts":["support.example.test"],"pages":[{"id":"case","paths":["^/cases$"],"flows":["support_materials"]}]}]}
```

For **the object**, name the case ID and where to find it. Selecting arbitrary
page text does not turn it into a case ID; the selection must fully match:

```json
{"objects":{"case_id":{"name":{"en":"Case ID","zh":"工单号"},"from":[{"url_param":"q"},{"column":["Case","工单号"]},{"selection":"^[A-Z]{2}-\\d{4,}$"}]}}}
```

For **data and source**, declare an input and output before writing code. Each
custom output has `records` and `source`; add `missing` if your source needs it.
Here is a minimal case contract (the complete example also has customer,
missing-material and status fields):

```json
{"schemas":{"case.inspect":{"input":{"type":"object","properties":{"case_id":{"type":"string","maxLength":40}},"required":["case_id"],"additionalProperties":false},"output":{"type":"object","properties":{"records":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"case_id":{"type":"string","maxLength":40}},"required":["case_id"],"additionalProperties":false}},"source":{"type":"string","maxLength":500}},"required":["records","source"],"additionalProperties":false}}}}
```

Bind it to a local command. `./inspect_case.py` belongs inside the pack:

```json
{"capabilities":{"case.inspect":[{"id":"support-example-local","type":"command","argv":["python3","./inspect_case.py"],"risk":"zero","cost":"local","local_only":true,"read_only":true,"batch_limit":1}]}}
```

For **how to decide**, a missing-material list needs no model. Add a single
capability step and declare its risk as well as the flow's risk:

```json
{"flows":{"support_materials":{"name":{"en":"Review case materials","zh":"核对工单材料"},"object":"case_id","judgment":false,"risk":"zero","steps":[{"id":"read_case","capability":"case.inspect","input":{"case_id":"$input.object"},"risk":"zero"}]}}}
```

If human interpretation is needed later, set `judgment: true` and add a bounded
`decision_schema`, for example an object with a boolean `needs_followup`. The
host validates that one model decision separately from source records. It has the
configured agent's model cost; do not label such a flow zero cost.

For **display**, add this to `flows.support_materials`:

```json
{"result":{"columns":[{"field":"case_id","label":{"en":"Case","zh":"工单号"}}],"primary":"case_id"}}
```

Add customer, missing materials and status to both the record schema and columns
when ready. The result table already supports sorting, searching, selecting,
copying and CSV export.

For **next action**, first write down “ask a person to collect materials”. Stage
35 introduces `triggers` and conditional `next` flow links. This authoring branch
is based on stages 32–34: it preserves those draft fields but does not implement
or certify their recommendation semantics. Until the stage 35 contract is merged,
leave `next` out of an executable pack and put the human handoff in `when`:

```json
{"when":{"en":"Review missing materials, then ask a person to collect them.","zh":"核对缺失材料后，请人工收集。"}}
```

Use the [complete runnable support package](examples/adapter-pack/package.json)
when extending all these snippets. Snippets above are incremental fields, not
separate packages.

## 3. Write one command

A command reads **one JSON object from stdin**, returns JSON on stdout, and sends
any diagnostics to stderr. `--help` must exit before reading stdin or writing data.
A minimal implementation of the contract above is:

```python
import argparse
import json
import sys

parser = argparse.ArgumentParser(description="Read a synthetic local case")
parser.parse_args()
inputs = json.load(sys.stdin)
# Replace this synthetic record with a reviewed local data source.
print(json.dumps({"records": [{"case_id": inputs["case_id"]}], "source": "synthetic"}))
```

Do not print progress on stdout. For a fuller local JSON reader see
[inspect_case.py](examples/adapter-pack/inspect_case.py). A local writer can use
the host's task working directory, but must set `read_only: false`; it will not
qualify for automatic local reads.

## 4. Draft, test, review, install

```sh
fbl packs new --describe "I review case materials each morning" --url https://support.example.test/cases
fbl packs test /absolute/path/from/the/draft/output
fbl packs test /absolute/path/from/the/draft/output --json
# After reviewing the draft and implementing its TODO commands:
fbl packs install /absolute/path/from/the/draft/output
```

`new` uses the default Assist Agent in a separate restricted, tool-free, single
turn. It reads this guide and the field reference, not the URL. Only the URL host
and path become matching rules; query, fragment and credentials are not copied.
The host replaces generated command bindings with TODO skeleton scripts, validates
all package contracts, and gives an invalid response one repair turn in a fresh
session. A still-invalid draft remains under `copilot/drafts/<id>/` with errors
and raw responses. If no agent can start, `new` falls back to the existing `init`
template shape and explains why. Drafts are labelled **Model draft · confirmation
required** and never installed or enabled automatically.

`test` checks contracts, object/capability references, explicit risks, and file
containment. Add `tests/scenarios.json` (a list):

```json
[{"url":"https://support.example.test/cases?q=CS-1001","expect":["support_materials"]},{"url":"https://other.example.test/cases?q=CS-1001","expect_absent":["support_materials"]},{"url":"https://support.example.test/cases","table_columns":["Case"],"table_rows":[["CS-1001"]],"selection":"","expect":["support_materials"]}]
```

These call the existing deterministic recommendation path, without a model.
For each zero-risk, `local_only` command add
`tests/fixtures/<binding-id>.json`, a list of `{"input": {...}, "expect": {...}}`.
`expect` is optional; output schema validation always runs. Commands run with
network denied and writes limited to temporary task directories. Other command
bindings receive only `--help` in the same sandbox. If the operating system cannot
enforce the sandbox, the check fails without running the command. Any failed
check returns a nonzero exit code; `--json` gives structured results.

Try [price-watch](examples/price-watch/README.md) for a visible price/stock reader
and local CSV history, or [job-tracker](examples/job-tracker/README.md) for a
local deduplicated job list with status filtering. Both use only synthetic data.

After completing a task in the sidebar, **Save as flow** sends only known tool,
page and flow IDs, object types and fixed action categories to another restricted
session. It excludes URLs, object values, selected text and page prose. The sidebar
shows the draft path and test command. Review the draft before installing it.

## 5. Keep the pack safe

- Keep credentials, account state and private paths out of the package. Refer to
  user-managed configuration when implementing a real source.
- Declare each binding, flow and step as `zero`, `metered` or `external`. “Local”
  and “free” do not grant permission. Local writes are not read-only.
- A pack cannot expand browser ownership or authorization. Login, CAPTCHA,
  payment and final business submission remain subject to the host's controls.
- Use argv arrays, never shell strings. Keep files inside the pack, bound inputs
  and outputs with schemas, and preserve unknown values as unknown.

Read the [security policy](../SECURITY.md), [capability reference](fbl-packs.md)
and [adapter rules](adapter-packs.zh-CN.md) before connecting real sources.
