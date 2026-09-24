# MDH provenance for lookup fields — design

**Date:** 2026-09-24
**Status:** shipped
**Scope:** `src/popup/mdh-provenance.ts`, `src/popup/cache.ts`,
`src/popup/components/MdhProvenancePanel.tsx`, `src/popup/components/ConfigBlock.tsx`,
`src/popup/popup.css`. The side panel inherits everything, because it hosts
the same `MdhProvenancePanel`.
**Base record:** `2026-08-07-mdh-provenance-side-panel-design.md` (the card and its side
panel); the row-scope rule is the one described in `rowScopeForConfig`.

## 1. Why

The "MDH on this screen" card explains an annotation's Master Data Hub matches. It finds
them one way only: MDH **webhooks** on the queue, whose `settings.configurations` it parses,
fills with the document's values and replays against Data Storage.

Rossum now has a second home for the same matching: a **lookup field** — a schema datapoint
whose `ui_configuration.type` is `"lookup"`. It has no hook. On a queue that matches only
through lookup fields the card says *"No MDH matching hooks on this queue."*, which is
false in the way that matters: the document IS being matched, the card just cannot see it.

## 2. Verified facts this design rests on

All live-probed on the internal elis org on 2026-09-24. The test fixture is the EPD queue
(Demos workspace): `supplier_match` is a header lookup (a fuzzy `$search`, five options,
query 0) and `item_uom_match` a line-item lookup with a two-query cascade. Its five rows
cover every status: `hours` wins query 1, `EA` wins query 0, `case` wins query 1 with two
options, `zzz` matches nothing.

**a. Where the config lives.** On the datapoint, not on a hook:

```
matching: {
  type: "master_data_hub",
  configuration: {
    dataset: "<collection>",
    queries: [ { "//": "<label>", aggregate: [ …stages… ] }, … ],
    variables: { <name>: { __formula: "<formula>" }, … }
  }
}
```

The queries are an ordered cascade, like a hook's. `describeQuery` already reads the `//`
label and `queryToPipeline` already handles `aggregate`, so each query needs no new parser.

**b. How variables are written.** `"$$name"`, substituted textually, only when it is the
WHOLE string, and typed by the formula's result. `"$$name "` (trailing space) is not a
variable. The pipeline editor has understood this form since `0b7a6fa`, where the probes
are recorded.

**c. The engine saves its own result.** Each lookup datapoint in the annotation content
carries the options it produced, and every option names the query that produced it:

```
"options": [ { "value": "HR", "label": "Hour", "struct": { "__query_index": 1 } } ]
```

A computed lookup that matched nothing has **no `options` key at all**. `no_recalculation`
marks a value the user set by hand.

**d. It is per row.** A lookup inside a tuple is evaluated once per row, and each row's
datapoint carries its own options and `__query_index`.

**e. Variable values are recoverable, but untyped.** Adding a temporary formula datapoint
`__var__<name>` beside the lookup (inside its tuple, for a row-level lookup) and posting
the schema plus annotation content to `POST /api/v1/internal/schemas/evaluate_formulas`
returns each variable's value, per row. This is the dashboard's own technique for its
"Test lookup" preview. The values come back as **strings** — a numeric formula returns
`"1500.0"` — so the formula's result type is lost.
`POST /api/v1/internal/schemas/formulas_info` returns each variable's `dependencies`
(the schema ids it reads).

**f. The card already fetches the schema.** `loadSchemaTypesForQueue` (now
`loadSchemaForQueue`) reads
`queue → schema?fields=content` to classify field types. The lookup configs are in that
same payload.

## 3. Decision

**A lookup field's query statuses come from the result the engine SAVED, not from a
replay.**

For a hook, the card must replay: nothing on the annotation records which query won. For a
lookup, the annotation does record it (fact c), so the card can show exactly what the
engine did — no extra request, no reconstruction. A replay would also be *less* faithful:
it needs the variable values, and those are only available as strings (fact e), while the
engine substitutes them typed (fact b). A replayed `$match` on a numeric field could then
disagree with the engine and show a wrong verdict with confidence.

The variable values are still needed, but only for the two actions that hand the query to
a person — **Copy query** and **Open in Dataset Management** — so they are fetched on
demand, on click, through `evaluate_formulas`.

Rejected: replaying lookup cascades like hooks (above); showing only the saved result with
no way to open the query (the Open action is most of the card's value to an SA).

## 4. Design

### 4a. Discovery

`extractLookupConfigs(schemaContent)` walks the schema and returns one cfg per datapoint
with `ui_configuration.type === "lookup"` and `matching.type === "master_data_hub"`. It
maps onto the existing cfg model, so the filter, the row picker and `QueryItem` reuse it:

| cfg field | lookup source |
|---|---|
| `source` | `'lookup'` (hook cfgs gain `source: 'hook'`) |
| `target` | the datapoint `id` |
| `name` | the datapoint `label` |
| `dataset` | `configuration.dataset` |
| `queries[]` | `configuration.queries`, `label` via `describeQuery`, `placeholders` = the `$$` names each query uses |
| `variables` | `configuration.variables` (name → formula) |
| `tableSchemaId` | the multivalue the datapoint sits in, or `null` for a header field |
| `actionCondition`, `additionalMappings`, `queueIds` | `null` / `[]` / `[]` — lookups have none |

A datapoint whose `matching` is not `master_data_hub` (the bundle also knows a
`hook_interface` variant) is not listed.

### 4b. Loading

`MdhProvenancePanel` fetches the schema BEFORE deciding the queue has nothing to show, and
derives both the field types and the lookup cfgs from that one response. The
"No MDH matching hooks" early return becomes "No MDH matching on this queue", taken only
when there are neither hook cfgs nor lookup cfgs ("No MDH configurations apply to this
queue" still covers hooks that exist but none apply). An empty hook list is still never
cached, so the two messages cannot blur into each other on a warm reopen.

The annotation content is fetched even when there are no `{placeholder}` names — a
lookup-only queue has none, but still needs its lookup datapoints. `flattenContent` gains a
`lookupResults` map, filled for the schema ids the lookup cfgs name:

```
lookupResults[schemaId] = header ? Result : Result[]   // one per row, in table order
Result = { value, winnerIndex: number | null, optionCount, noRecalculation }
```

`winnerIndex` is the `__query_index` of the option whose `value` equals the datapoint's
value, falling back to the first option's; `null` when there are no options.

### 4c. Statuses

`ConfigBlock` branches on `cfg.source`. A lookup cfg runs no replay; its statuses are
derived from the selected row's `Result`:

| query index `i` | status | hint |
|---|---|---|
| `i < winnerIndex` | `empty` | no results, cascade moved on |
| `i === winnerIndex` | `winner` | `N option(s)` |
| `i > winnerIndex` | `skipped` | an earlier query already matched |
| `winnerIndex === null` | `empty` for all | no query matched |

`noRecalculation` adds a caption above the list — *"Value set by hand — the lookup's saved
result may be stale"* — and keeps the statuses, since they are still what the engine last
did. The replay cache (`getCachedReplay`) is not used for lookups; there is nothing to
cache that the annotation does not already hold.

### 4d. Row scope

A lookup is row-scoped exactly when its target sits in a table, so `rowScopeForConfig`
already returns the right table from `target`. What does NOT carry over is
`configUsesLineItems`, which decides row-scoping from placeholder names being schema ids in
`rowValues`; `$$` names are variable names, not schema ids. For a lookup cfg,
`usesRows = cfg.tableSchemaId != null`.

### 4e. Copy and Open

On click, `resolveLookupVariables(ctx, schemaContent, annotationContent, cfg, row)` builds
the `__var__<name>` datapoints beside the target, posts `evaluate_formulas`, and reads the
values for the selected row. Then:

- **Copy query** substitutes `"$$name"` (whole strings only) with the value and copies the
  pipeline.
- **Open in Dataset Management** passes the pipeline with `"$$name"` intact, plus
  `variables`. It passes NO `variableTypes`: the values are strings of unknown type, so the
  editor's value-based Auto is the honest default, and the user can override it.

If `evaluate_formulas` fails (403, a role without access, an org where it is gated), Copy
copies the unsubstituted pipeline and Open opens it with the variables empty — both still
useful. The buttons do not announce the fallback; the unsubstituted `"$$name"` is visible
in what they produce.

Copy has one extra constraint: the popup has no `clipboardWrite` permission, and the values
arrive after a network round trip that can outlive the click's user activation. So it hands
`navigator.clipboard.write` a `ClipboardItem` whose content is a promise, which Chrome binds
to the originating click; `writeText` after the await is only the fallback where
`ClipboardItem` does not exist (jsdom).

### 4f. Presentation

The card is renamed from "MDH on this screen" to **"Matching provenance"** (owner, 2026-09-24):
it now covers two sources, and the old title named neither.

The card is ONE list in **schema order**, across both sources (owner, 2026-09-24):
`provenanceItems` flattens hook cfgs and lookup cfgs and sorts them, stably, by where each
target field sits in the schema (`buildSchemaOrder`, depth-first). So the card reads top
to bottom like the document, and a lookup sits next to a hook that matches the same
thing. A target the schema does not know sinks to the end. The hook grouping is gone; it
was the rejected alternative, because keeping groups also keeps the two sources apart.
What that costs: a hook's own configuration order is no longer visible across fields.
MDH runs configurations in array order, and whether a later one reads an earlier one's
output is not verified.

Each cfg says where it comes from on a line under `target ← dataset`: the hook's name
linked to its extension page, or **Lookup field** linked to
`${domain}/queues/${queueId}/settings/fields/${fieldId}` (a dashboard route,
bundle-derived), then `· <cfg name>`. The filter matches `target` as before, and cfg keys
come from the unfiltered position, so a replay-cache entry survives a filter change.

### 4g. Caching

- `mdhProv:schemaTypes:v1:` becomes `mdhProv:schema:v2:`, storing `{ types, lookups, order }`
  per queue. A v1 entry is ignored, not migrated.
- `mdhProv:ann:v4:` becomes `v5:`, adding `lookupResults`. A v4 entry lacks it and would
  render every lookup as "no match".
- Both keys already invalidate on the Refresh button; the annotation entry still keys on
  `modified_at`, so a recomputed lookup (which modifies the annotation) is picked up.

## 5. Not in scope

- **Re-running a lookup's cascade live** — rejected in §3. The recorded result can be stale
  when inputs changed after the last computation; the card shows what was computed, which
  is the question it exists to answer.
- **Previewing "what would it compute now"** via `evaluate_formulas` on the lookup itself.
  It works (fact e's endpoint returns the lookup's options too) and would expose staleness,
  but it is a second, heavier request on every card load.
- **Memory fields** (a separate datapoint property, `memory`, which the dashboard bundle
  also routes to `master_data_hub`) and `hook_interface` lookups.
- **The Dataset Management side**: `"$$name"` support there already shipped in `0b7a6fa`.

## 6. Testing

Pure-core first, as the rest of the card:

- `extractLookupConfigs`: header and tuple datapoints; `tableSchemaId`; a non-lookup and a
  non-`master_data_hub` datapoint are skipped; `$$` placeholder names per query.
- `flattenContent` → `lookupResults`: a winner, a missing `options` key, several options
  where the value picks the winner, `no_recalculation`, per-row results in table order.
- The status mapping in §4c, including `winnerIndex === null`.
- `configUsesLineItems` is not consulted for lookups: a tuple lookup with no schema-id
  placeholders still gets a row picker.
- The panel no longer early-returns on a lookup-only queue (a render test with zero hooks
  and one lookup).
- `resolveLookupVariables`: the `__var__` datapoints land in the target's container; a
  failed request degrades as §4e says.
- Cache key bumps: a v4 annotation entry and a v1 schema entry are ignored.

## 7. Live gates

Things this design assumes and has NOT verified; check each on the EPD fixture before
shipping.

1. **The shape before first computation.** A lookup added to a schema shows up on open
   annotations as an empty datapoint before anything computes it. Whether that datapoint
   has no `options` key (indistinguishable from "matched nothing") or an empty list was not
   captured. If indistinguishable, the card cannot tell "not computed" from "no match" and
   the all-`empty` row needs wording that covers both.
2. ~~**Several options.**~~ Verified 2026-09-24: a five-option supplier result and a
   two-option UoM result each carried ONE `__query_index` on every option, and the
   datapoint's value was the first option's. The value-equality rule in §4b is therefore
   redundant but harmless; keep it as the guard against a hand-picked second option.
3. **`evaluate_formulas` for a non-admin role.** Probed only as an organisation admin.
4. **`no_recalculation`**: set a lookup by hand in the UI and confirm the flag and whether
   `options` are kept.
5. **Freshness**: edit `item_uom` in the UI and confirm the annotation's `modified_at`
   moves when the lookup recomputes, so the v5 annotation cache invalidates.

## 7b. Verified after implementation

Run against the live EPD annotation (2026-09-24) through the shipped functions
(`loadSchemaForQueue` → `loadAnnotationValues` → `lookupStatuses` →
`resolveLookupVariables`), every row matched the engine's saved result: supplier winner
(5 options); UoM rows `hours` empty|winner, `EA` winner|skipped, `case` empty|winner
(2 options), `zzz` empty|empty; and each row's `$$uom` value came back from
`evaluate_formulas`. Gates 1, 3, 4 and 5 remain open, and the card has not yet been
clicked through in a browser — in particular the `ClipboardItem` Copy path, which jsdom
cannot exercise.

## 8. Backward compatibility

Hook cfgs are unchanged apart from gaining `source: 'hook'`; their replay path is untouched.
Both cache bumps only make older entries miss. No storage key is removed, so older builds
keep working on the keys they know.
