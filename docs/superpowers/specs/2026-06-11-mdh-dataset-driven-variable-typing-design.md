# Dataset-Driven Variable Typing for MDH Aggregation Queries

**Date:** 2026-06-11
**Status:** Design — awaiting review (hardened by an adversarial grounding/completeness/backward-compat critique against the repo)
**Area:** Dataset Management app (`src/mdh/`) — pipeline editor variable substitution

---

## 1. Problem

When a user runs an aggregation in the Dataset Management app, any `{var}` placeholders in
the pipeline are filled from the **Variables** inputs. Today the substituted value's JSON
**type is inferred purely from the text the user typed**, not from the data being queried.

Ground truth — `src/mdh/hooks/usePipeline.js:101-105` `renderWholeToken()` (a *whole-quoted*
`"{var}"` with no modifier):

```js
function renderWholeToken(val, modifier, arg) {
  if (!modifier && (val === 'true' || val === 'false' || val === 'null')) return val;
  if (!modifier && isJson5NumberLiteral(val)) return val;        // "123" -> bare 123
  return JSON.stringify(applyModifier(val, modifier, arg));       // else -> quoted string
}
```

So typing `123` to match a **string** field that stores `"123"` substitutes `{ field: 123 }`
(a JSON number) and silently returns no rows. Likewise typing `null` always becomes JSON
`null`, never the literal string `"null"`.

**Repro:** a collection whose `code` field is the string `"123"`; pipeline
`[{ "$match": { "code": "{code}" } }]`; type `123` into the `{code}` input → 0 results,
because the match becomes `{ "code": 123 }`.

### What the user asked for

1. Infer the variable's type **from the dataset field**, not from the input text.
2. **Show** how the type was resolved, and let the user **override** it.
3. Handle the `null` edge case (literal string `"null"` vs JSON `null`).
4. Ground every decision in verified facts; preserve backward compatibility.

### Decisions taken during brainstorming

- **Scope:** dataset-driven default **+** per-variable override.
- **Mixed-type fields:** pick the **dominant type**, shown with its share (e.g. `82%`), overridable.
- **Type set:** **primitives only** — String / Number / Boolean / Null (+ `Auto`). Date /
  ObjectId / array / object fields are *detected and displayed* but fall back to value-based
  substitution in v1 (no EJSON `$oid`/`$date` wrapping).
- **Architecture:** **Approach A** — an analysis pass + a typed text-substitution path (keep
  today's substituter; thread in a resolved type). No migration to AST-walk substitution.
- **No `$or` rewrite:** the pipeline shape is never restructured (match-both was not chosen).

---

## 2. Goals / Non-goals

**Goals**

- For a WHOLE `"{var}"` placeholder (no modifier) that maps to a known field, default its JSON
  type to the field's dataset type instead of the input-text shape.
- Display the resolved type and its **source** next to each variable; allow per-variable override.
- Fix the `null` / `"null"` ambiguity via the type control.
- Be **byte-identical to today** whenever no dataset type is resolved (the value-based path).

**Non-goals (v1)**

- Date / ObjectId EJSON wrapping (`{"$oid":…}` / `{"$date":…}`). Detect + display only.
- `$or`-both-types rewrite for mixed fields.
- Type-aware substitution for EMBEDDED or modifier (`split`/`re`) placeholders — string/array as today.
- Fixing the pre-existing big-integer precision footgun (`usePipeline.js:64-68`) — noted, not in scope.

---

## 3. Current behavior (verified)

| Aspect | Fact | Location |
|---|---|---|
| Type decision | From input text via regex; no dataset input | `usePipeline.js:101-105` (regex at `:68`, `isJson5NumberLiteral` at `:70-72`) |
| Substitution order | Textual replace → then `JSON5.parse`; `runQuery(collection, rawText, substituteFn)` → `substituteFn(rawText)` then parse | `usePipeline.js:193-209`; `useQuery.js:20-26` |
| WHOLE vs EMBEDDED | WHOLE `"{v}"` type-aware; EMBEDDED `"...{v}..."` always string; per-occurrence (`whole` flag) | `usePipeline.js:37,43,97-116` |
| Modifiers | `split(sep)`→array, `re`→escaped string; bypass the type rule | `usePipeline.js:91-95` |
| Placeholder scan | `scanPlaceholders` returns `{whole,name,modifier,arg,start,end}` per occurrence | `usePipeline.js:23-55` |
| `renderWholeToken` call site | single, in `substitutePlaceholders` | `usePipeline.js:203` |
| `substitutePlaceholders` consumers | `computeEditorState` (`:221`); passed **by reference** from `DataPanel.jsx:98` into `runQuery`; called directly at `DataPanel.jsx:200,458,536,617,709` (bulk delete/update, download, etc.) | as cited |
| Variable inputs | One plain text `<input>` per name; values stored as **strings** keyed by name | `PlaceholderInputs.jsx:75-87`; `usePipeline.js:132,211-213` |
| Fill-from-Annotation | auto-runs via `onRunQuery()` | `PlaceholderInputs.jsx:51` |
| Field types knowable? | Yes — `$type` `$facet` per field | `statsPipelines.js:121-130` |
| `transformTypes` | **mixed-only** — filters `types.length > 1`, drops single-type fields; not the shape we need | `statsSummary.js:103-111` |
| Mixed-type detection | already detected + warned when `types.length > 1` | `statsSummary.js:22-24`; `StatsPanel.jsx:519-530` |
| Cache | LRU; **stats keys use `TTL_LONG = 600_000` (10 min)**, not 60s; `stats_types` holds the **raw** facet result | `cache.js:6,15` |
| Field-name encoding | `encKey` maps `.`→`__DOT__` for facet keys; `$type:"$a.b"` resolves dotted paths | `statsPipelines.js:6,121-130` |
| Persisted var state | `lastPipeline.js:12-33` stores `{pipelineText, variables}`, `bootPrefillFor`→`{collection,pipelineText,variables}`; `QueryHistory.jsx:29-46` entries `{collection,pipeline,ts,variables?}` | as cited |
| Backward-compat tests | `"5"→5`, `"true"→true`, string→string, unfilled→`""`, `"id-{id}"+5→"id-5"` | `tests/mdh-compute-editor-state.test.js` |

**Key consequence:** the live substituter only knows a variable's **name**, never the field it
is compared against. Dataset typing requires a new pass to recover that mapping.

---

## 4. Design overview (Approach A)

Three small, independently testable additions plus one threaded argument. When no type is
resolved for a variable, every code path takes its **current** branch — so existing behavior
and tests are unchanged.

```
pipeline text ──▶ scanPlaceholders (EXISTS)         ──▶ WHOLE/EMBEDDED + modifier + spans
              └─▶ mapPlaceholdersToFields (NEW)      ──▶ { name → {field, op} | {ambiguous} }
                       │ fields
                       ▼
        resolveFieldTypes (NEW; own transform over $type facet)  ──▶ { field → FieldTypeInfo }
                       │
   resolvedTypeFor(name) = { type, source }          (NEW signals: placeholderTypes, fieldTypes)
                       │ .type (undefined → value-based, byte-identical)
                       ▼
   renderWholeToken(val, modifier, arg, resolvedType)  (1 NEW arg)  ──▶ typed token
                       ▼
              JSON5.parse ──▶ run query (UNCHANGED)
```

---

## 5. Components & interfaces

### 5.1 `mapPlaceholdersToFields(text) → { [name]: { field, op } | { ambiguous: true } }` (NEW, pure)

- Parse the editor text with `JSON5.parse`. WHOLE `"{v}"` and EMBEDDED `"...{v}..."`
  placeholders are valid JSON strings, so a syntactically valid pipeline parses; a bare
  unquoted `{v}` is not valid JSON and is not a variable (`usePipeline.js:16-17`). On parse
  failure return `{}` (no mapping → all value-based); see §5.5 for the badge's transient state.
- Walk the parsed structure. For each **string node** whose value matches `VAR_RE`
  (`usePipeline.js:20`) with `modifier === null` (a WHOLE, no-modifier placeholder), resolve
  the field from its position:

  | Position | Field |
  |---|---|
  | `{ "field": "{v}" }` | `field` |
  | `{ "field": { "$eq"\|"$ne"\|"$gt"\|"$gte"\|"$lt"\|"$lte": "{v}" } }` | `field`, op recorded |
  | `{ "field": { "$in"\|"$nin": [ …, "{v}", … ] } }` | `field`, op `$in`/`$nin` |
  | inside `$and`/`$or`/`$nor`/`$not` | recurse, keep field context per operand (see below) |
  | `{ "$expr": { "$eq": [ "$field", "{v}" ] } }` (and other cmp ops) | `field` from the `$fieldpath` operand |
  | anything else — `$limit`, `$project`/`$addFields`/`$group` expressions, computed, no field | **unresolved** → omit |

- **Dotted vs nested:** a **literal dotted key** `{ "address.zip": "{v}" }` resolves to field
  `address.zip`. A **nested object literal** `{ "address": { "zip": "{v}" } }` is *not* a
  `$match` field path and is **not** traversed for field context → unresolved → value-based.
- **Logical/branch ambiguity:** field context is per comparison operand. If a name resolves to
  the **same** field across all branches (e.g. both arms of `$or`) → use it. If it resolves to
  **different** fields in any branch → `{ ambiguous: true }` → value-based.
- **WHOLE vs EMBEDDED, same name:** typing is per-name but applies only to WHOLE occurrences.
  A name used both WHOLE `"{x}"` and EMBEDDED `"id-{x}"` is allowed — the WHOLE occurrence is
  typed; the EMBEDDED occurrence stays an in-string string (`renderEmbeddedFragment` unchanged).
- Operator (`op`) is recorded for display/future use; v1 typing does not branch on it.

### 5.2 `resolveFieldTypes(collectionName, fields) → Promise<{ [field]: FieldTypeInfo }>` (NEW)

`FieldTypeInfo = { dominant: Category, share: number, distribution: [{ bsonType, count, pct }], mixed: boolean, raw: Category }`

- `Category ∈ { 'string','number','boolean','null','other' }`. **Full BSON `$type`→Category fold:**
  `string → string`; `int|long|double|decimal → number`; `bool → boolean`; `null → null`;
  everything else (`date|timestamp|objectId|binData|regex|array|object|javascript|minKey|maxKey|…`) `→ other`.
  The special `missing` bucket (absent field) is **excluded from the denominator**, mirroring
  `transformTypes`' `_id !== 'missing'` filter (`statsSummary.js:108`).
- Source, in order (no new API capability — reuses verified Stats machinery):
  1. If `stats_types` is cached for the collection (`cache.js`, the **raw** facet result), read
     it (no network) — **still transform locally** (next bullet). Cache reuse only helps when
     `field` is in the cached discovery set (`discoverFields`, ≤`MAX_FIELDS=50` from a 200-doc
     sample); otherwise probe directly.
  2. Else run `buildTypePipeline([field…])` (`statsPipelines.js:121`) for **only** the
     requested fields — a small `$facet` of one `{$group:{_id:{$type:"$f"},count}}` per field
     (already sorted by count desc at `:126`). The cost model (memory
     `reference_mdh_stats_facet_cost_model`) says cost is `$facet` field-*count*-bound, so 1–3
     fields is cheap. Cache the raw result under the `stats_types` key.
- **Do not reuse `statsSummary.transformTypes`** — it filters to mixed-only fields and omits
  single-type fields. `resolveFieldTypes` runs its **own** transform over the raw `$type` facet
  output (`raw.result[0][encKey(field)]` = `[{_id: bsonType, count}]`): fold each `_id` to a
  Category, sum counts per Category over non-`missing` buckets, `dominant` = max-count Category,
  `share` = dominantCount/totalNonMissing, `distribution` = `[{bsonType,count,pct}]`,
  `mixed` = (#distinct BSON types > 1).
- **Tie-break:** on an exact count tie, `dominant` = highest-precedence Category
  (string > number > boolean > null). Badge surfaces it (e.g. `50% (string preferred, tied)`).
  This stays dominant-type behavior (not a value-based fallback), consistent with the design.
- If `dominant === 'other'` (date/objectId/array/object), v1 does **not** type it → caller
  falls back to value-based, but `raw`/`distribution` are kept so the badge shows the detected
  type (e.g. `ObjectId · value-based`).

### 5.3 `renderWholeToken(val, modifier, arg, resolvedType)` (EXTEND, `usePipeline.js:101`)

Add a 4th arg. **Dataset/override typing only applies to the no-modifier path**; when a
modifier is present the typed switch is bypassed entirely (final `return` unchanged), so
`split`→array and `re`→escaped-string contracts hold regardless of resolved type.

```js
function renderWholeToken(val, modifier, arg, resolvedType) {
  if (!modifier) {
    switch (resolvedType) {
      case 'string':  return JSON.stringify(String(val));
      case 'number':  return isJson5NumberLiteral(val) ? val : JSON.stringify(String(val));
      case 'boolean': return (val === 'true' || val === 'false') ? val : JSON.stringify(String(val));
      case 'null':    return 'null';
      default: // undefined → today's value-based branch order, byte-identical
        if (val === 'true' || val === 'false' || val === 'null') return val;
        if (isJson5NumberLiteral(val)) return val;
        return JSON.stringify(applyModifier(val, modifier, arg)); // == JSON.stringify(String(val))
    }
  }
  return JSON.stringify(applyModifier(val, modifier, arg));
}
```

- **`renderWholeToken` never warns** — it only emits the safe token. Incompatible-value
  detection is the caller/UI's job (§5.6).
- **Strict coercion (documented):** `'number'` uses `isJson5NumberLiteral` (rejects `007`,
  `5,000`, ` 42 `); `'boolean'` accepts only lowercase `true`/`false`. Anything else emits a
  quoted string so `JSON5.parse` never crashes (preserving the rationale at `usePipeline.js:57-67`),
  and the UI flags a likely no-match.
- `default` (no `resolvedType`) reproduces the exact current branch order →
  `mdh-compute-editor-state.test.js` passes unchanged.

### 5.4 `substitutePlaceholders(text, resolvedTypes = {})` and `computeEditorState(text, resolvedTypes = {})` (EXTEND)

- Thread an optional `resolvedTypes` map (`name → 'string'|'number'|'boolean'|'null'|undefined`)
  into substitution; pass `resolvedTypes[m.name]` as the 4th arg of `renderWholeToken` for WHOLE
  matches. EMBEDDED is unaffected. Default `{}` → value-based → identical output (tests pass).
- **All user-editable-pipeline callers must supply current types.** `DataPanel.jsx` passes
  `pipeline.substitutePlaceholders` *by reference* into `runQuery` (`DataPanel.jsx:98` →
  `useQuery.js:26`) and calls it directly at `DataPanel.jsx:200,458,536,617,709` (bulk
  delete/update, download, …). If only the run path is typed, bulk/download would substitute
  value-based while the badge shows dataset types → silent divergence (e.g. a bulk delete
  matching 0 rows). **Fix:** `usePipeline` exposes a bound
  `substituteWithTypes = (rawText) => substitutePlaceholders(rawText, resolvedTypesSignal.value)`
  that reads the live signal; pass *that* everywhere (run, bulk delete/update, download,
  fill-from-annotation), avoiding stale closures.

### 5.5 State: `placeholderTypes` signal, `fieldTypes` signal, `resolvedTypeFor` (EXTEND `usePipeline.js`)

- New signal `placeholderTypes: signal({})` — `name → 'auto'|'string'|'number'|'boolean'|'null'`.
  Absence/`'auto'` = Auto.
- New `fieldTypes: signal({})` (collection-scoped) — `field → FieldTypeInfo`, populated by an
  effect. **The effect** (in `usePipeline` or DataPanel's editor-snapshot effect): on each
  debounced recompute, call `mapPlaceholdersToFields(text)`; for each newly-discovered
  non-ambiguous field not already in `fieldTypes`, fire `resolveFieldTypes(collection, [field])`
  and write results to `fieldTypes` on resolve (eager cache fill). Cleared on collection change.
- `resolvedTypeFor(name) → { type, source }`:
  - `type ∈ { 'string','number','boolean','null', undefined }` — the run path uses **`.type`**
    (undefined → value-based, byte-identical).
  - `source ∈ { 'override','field','mixed','other','no-field','ambiguous','detecting','invalid' }`
    — the badge uses **`.source`**.
  - Resolution:
    1. explicit override → `{ type: override, source: 'override' }`.
    2. else if pipeline text didn't parse → `{ type: undefined, source: 'invalid' }`.
    3. else if `mapping[name]` ambiguous → `{ type: undefined, source: 'ambiguous' }`.
    4. else if no field for name → `{ type: undefined, source: 'no-field' }`.
    5. else if field type not yet in `fieldTypes` (probe pending) → `{ type: undefined, source: 'detecting' }`.
    6. else if `dominant` is primitive → `{ type: dominant, source: mixed ? 'mixed' : 'field' }`.
    7. else (`dominant === 'other'`) → `{ type: undefined, source: 'other' }` (display detected type).

### 5.6 UI: `PlaceholderInputs.jsx` (EXTEND)

Each variable row gains a compact **type selector** + a **resolved-type/source badge**:

```
{code}  [ 123    ]   String · from `code`           ▾   (single-type field)
{qty}   [ 5      ]   Number · dominant 82%          ▾   (mixed field)
{sku}   [ 9      ]   String · 50% (string preferred, tied) ▾  (count tie)
{tag}   [ x      ]   String · ambiguous (multiple fields)  ▾  (value-based)
{name}  [ acme   ]   String · auto (no field)        ▾   (value-based)
{when}  [ 2026.. ]   Date · value-based              ▾   (detected non-primitive)
{c2}    [ 7      ]   detecting…                       ▾   (probe in flight)
{flag}  [ true   ]   Boolean · manual                ▾   (override)
            selector ▾ = Auto · String · Number · Boolean · Null
```

- Badge text comes from `source` (§5.5). While the pipeline JSON is invalid (mid-edit,
  `source: 'invalid'`), **freeze the badge at the last valid parse** (greyed as `pending…`) — do
  not flash a freshly-stale type. While a probe is in flight, show `detecting…`.
- Selector default = **Auto**. Choosing a primitive sets `placeholderTypes[name]`; choosing Auto clears it.
- **Validation warning** (inline, non-blocking) via a pure helper
  `isCompatibleWithType(val, type)` in `PlaceholderInputs` (number → `isJson5NumberLiteral`;
  boolean → `val==='true'||val==='false'`; null → `val==='null'`): when the resolved/chosen type
  is `number`/`boolean` and the value can't be coerced, show "won't match as Number/Boolean".
  Query still runs. `isJson5NumberLiteral` is module-private (`usePipeline.js:70`) — **export it**
  (preferred) rather than duplicate the regex.

### 5.7 Run / refresh timing

- The §5.5 effect populates `fieldTypes` eagerly on each debounced recompute (`DataPanel.jsx`
  ~400ms; `computeEditorState` at `usePipeline.js:219`).
- On **Run** (Enter, debounced auto-run, or Fill-from-Annotation auto-run at
  `PlaceholderInputs.jsx:51`): execute `await flushPendingFieldTypeProbes()` (bounded by the
  existing 30s `api.js` AbortController) **before substituting**, so the executed query and the
  badge agree. The Run button is disabled and shows `Detecting types…` until all probes settle
  (resolve/error/timeout). On timeout/error a field reverts to value-based and the badge shows
  `value-based (probe timeout)`; the query still runs.
- When the editor text changes and the field set changes, abort in-flight probes for fields no
  longer referenced. Collection change clears `fieldTypes`; mapping re-derives from the
  (per-collection) pipeline.

---

## 6. Substitution semantics (WHOLE, no modifier)

| Input | resolvedType | Output token | Note |
|---|---|---|---|
| `123` | `string` | `"123"` | the fix: matches string field |
| `123` | `number` / value-based | `123` | number (`JSON5.parse` → JS number) |
| `123` | `boolean` | `"123"` | + warn (not a bool) |
| `abc` | `number` | `"abc"` | + warn (not a number) |
| `true` | `string` | `"true"` | literal string |
| `true` | value-based / `boolean` | `true` | JSON boolean |
| `null` | `string` | `"null"` | **literal string** (the null edge case) |
| `null` | `null` / value-based | `null` | JSON null |
| `null` | (Auto, field=string) | `"null"` | dataset says string → string |
| `` (empty/unfilled) | any | `""` | unchanged (`usePipeline.js:202`) |
| `007`, `5,000`, ` 42 ` | value-based / `number` | `"007"` etc. | stays string; parse-safe (`usePipeline.js:57-67`) |

A bare returned token (`true`, `123`) is unquoted *text* that `JSON5.parse` later turns into the
JSON boolean/number. EMBEDDED (`"id-{v}"`) and modifier (`{v | split(',')}`, `{v | re}`)
placeholders are unchanged (string/array), regardless of dataset type.

---

## 7. Persistence & backward compatibility

- **`lastPipeline.js`** (`chrome.storage.local`): `saveLastPipeline(pipelineText, variables,
  placeholderTypes)` stores `{ pipelineText, variables, placeholderTypes }`; `bootPrefillFor`
  returns `…, placeholderTypes: { ...(stored.placeholderTypes || {}) }`.
- **`QueryHistory.jsx`** + saved entries: gain optional `placeholderTypes` (omit when empty,
  mirroring the existing `variables` guard at `:34,42`). Restoring re-applies overrides.
- **`pipelineState.js`** (per-collection session): persist `placeholderTypes` alongside
  `placeholderValues`.
- **Absence = Auto** on load → every existing stored pipeline/history entry restores unchanged.
- `fieldTypes` is **not** persisted (cache, rebuilt on demand).
- **No version marker / no validation-on-unknown-keys needed:** storage is per-user local JSON;
  `bootPrefillFor`/QueryHistory destructure named fields and ignore extras, so a downgraded
  extension reading a newer entry simply ignores `placeholderTypes` — no corruption path. The
  field is purely additive.
- All extended function signatures take optional args defaulting to today's behavior. The
  `mdh-compute-editor-state.test.js` contract is preserved by construction.

---

## 8. Performance & cost

- Type resolution reuses the **already-verified** Stats `$type` `$facet`, restricted to the 1–3
  fields actually referenced — cheap per the cost model (field-count-bound, not doc-count). No
  new endpoint, no full-collection wide `$facet`. (Worth a quick measurement before shipping; no
  hard p99 figures are available without it, and none are load-bearing for the design.)
- Cached per collection under the `stats_types` key (`cache.js`, **10-minute `TTL_LONG`**),
  shared with the Stats panel and invalidated by the Stats refresh button. A stale type hint for
  ≤10 min is acceptable — the user can override or refresh Stats.

---

## 9. Testing plan

- `mapPlaceholdersToFields`:
  - each recognized shape (direct, cmp ops, `$in`/`$nin`, `$and`/`$or`/`$nor`/`$not` nesting, `$expr`);
  - **dotted key** `{"address.zip":"{v}"}` → `address.zip`; **nested object** `{"address":{"zip":"{v}"}}` → unresolved;
  - **branch ambiguity:** `[{$or:[{a:{$eq:"{x}"}},{b:{$eq:"{x}"}}]}]` → ambiguous; same field in both branches → resolved;
  - WHOLE+EMBEDDED same name → WHOLE typed, EMBEDDED string;
  - non-comparison stages (`$project`/`$addFields`/`$group`) → unresolved → value-based;
  - parse failure → `{}`.
- `resolveFieldTypes`: single-type, mixed→dominant+share, tie→string (precedence), full BSON→Category
  fold incl. `missing` excluded, `dominant==='other'`→fallback, cache reuse vs probe-when-field-absent.
- `renderWholeToken` with each `resolvedType` incl. incompatible-value → quoted string; modifier
  present bypasses the switch; `default`/undefined reproduces current outputs.
- `isCompatibleWithType` truth table.
- `substitutePlaceholders`/`computeEditorState` with and without `resolvedTypes` (regression); a
  test asserting bulk/download paths route through `substituteWithTypes`.
- Existing `mdh-compute-editor-state.test.js` stays green unchanged.
- **Live verification (must do):** against Data Storage, confirm a `number`-typed bare `123`
  matches docs whose field is `{$numberLong:"123"}` / `{$numberDecimal:"123"}` in both direct
  `$eq` and `$in` contexts. If a subtype doesn't coerce, downgrade it to value-based and note in §11.
- Follow the repo's Vitest `.test.js` + `h()`/`vi.mock` convention (memory
  `reference_vitest_test_jsx_convention`); avoid fixed-timeout waits (memory
  `reference_vitest_flaky_fixed_timeouts`).

---

## 10. Files touched

- `src/mdh/hooks/usePipeline.js` — `mapPlaceholdersToFields`, `placeholderTypes`/`fieldTypes`
  signals, `resolvedTypeFor`, `substituteWithTypes`; extend `renderWholeToken`/
  `substitutePlaceholders`/`computeEditorState`; **export `isJson5NumberLiteral`**.
- `src/mdh/` new module — `resolveFieldTypes` (reuses `statsPipelines.buildTypePipeline`,
  `encKey`; own transform — NOT `statsSummary.transformTypes`).
- `src/mdh/components/PlaceholderInputs.jsx` — type selector + source badge + `isCompatibleWithType` warning.
- `src/mdh/components/DataPanel.jsx` — wire `substituteWithTypes`; **audit every
  `substitutePlaceholders` call (lines 98, 200, 458, 536, 617, 709)** so all route through the
  type-aware path; pass props/effect.
- `src/mdh/pipelineState.js`, `src/mdh/lastPipeline.js`, `src/mdh/components/QueryHistory.jsx` —
  persist/restore `placeholderTypes`.
- `console.css` — `.placeholder-*` type-control + badge styles.
- `tests/` — new unit tests above.

---

## 11. Open items / future

- Date / ObjectId EJSON matching (`{"$oid":…}`, `{"$date":…}`) — high value for `_id`/date; v2.
- Match-both `$or` rewrite for mixed fields (AST path) — alternative to dominant-type; v2.
- Big-integer precision footgun (`usePipeline.js:64-68`) — independent fix.
- Per-occurrence (vs per-name) typing when one name maps to multiple fields — currently collapsed
  to value-based via the ambiguity rule.
- Any numeric BSON subtype that fails live coercion verification (§9) → downgrade to value-based here.
