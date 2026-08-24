# MDH export → import round trip

**Date:** 2026-08-24
**Status:** design approved, not yet implemented
**Area:** Dataset Management (`src/mdh/`) — export serializers, import formats, shape guard

Every example in this document is synthetic. No customer field names, values or
collection names appear anywhere in it.

## 1. The defect

Exporting a collection to CSV and importing the same file straight back is
blocked by the shape guard:

```
MISSING      "key.code" "key.system" "address.line" "address.city" …
UNEXPECTED   "key" "address"
WRONG TYPE   "_last_modified_date": date → string
```

A user reasonably expects an export to be importable. It is not — for three
separate reasons, all verified below.

## 2. Verified facts

Measured with a throwaway probe harness driving the real serializers and
parsers over a synthetic document holding one value of every kind. Not
estimates.

### 2.1 Round-trip fidelity today

| Value in the collection | JSON/JSONL | CSV | Excel | XML |
|---|---|---|---|---|
| string | ok | ok | ok | ok |
| number / bool | ok | → `"1500"` | ok | → string |
| nested object | ok | → JSON text | → JSON text | ok |
| array | ok | → JSON text | → JSON text | 1-elem → scalar |
| `{$date}` | ok | → ISO text | ok | → `{_date: …}` |
| `{$oid}` as `_id` | ok | ok | ok | → `{_oid: …}` |
| `{$oid}` elsewhere | ok | → hex text | → hex text | → `{_oid: …}` |
| field absent on some records | ok | → `""` | → `null` | ok |

### 2.2 Root cause

The export serializers flatten structure and BSON types into text
(`csv.ts#csvCell`, `xlsxWrite.ts#cellXml`, `xml.ts#valueToXml`), and the import
side has exactly **two** inverse rules:

- `importFile.ts#normalizeDocId` — a 24-hex string `_id` becomes `{$oid}`.
- `xlsx.ts:156` — a date-styled cell becomes `{$date}`.

Nothing inverts nested objects, arrays, non-`_id` ObjectIds, CSV dates, or CSV
numbers. `csv.ts#rowsToDocs` treats every cell as an opaque scalar.

Both existing rules are precedent: this repo already accepts that the import
side reconstructs a type the export flattened. This design generalises that
instead of inventing a new principle.

### 2.3 XML cannot round-trip EJSON at all

`xml.ts#toXmlName` strips characters outside `[A-Za-z0-9_.\-]`, so `$oid`
becomes `_oid`. An exported `<_id><_oid>…</_oid></_id>` re-imports as the plain
nested object `{_id: {_oid: "…"}}`. The `$` is unrecoverable.

### 2.4 The guard over-rejects by construction

`shape.ts#validateAgainstShape` requires **every** reference path in **every**
row, including paths `deriveShape` itself flagged as `optionalPaths` — fields
that only some existing records carry. So a non-uniform collection can never
validate its own export, no matter how faithful the round trip is. The error
card already half-admits this ("exact-shape validation may over-reject") rather
than fixing it.

### 2.5 The wrong-type line does not say which side is which

`ImportConfirm.tsx` renders `` `${t.expected.join('/')} → ${t.got}` ``. Reading
`date → string` gives no clue that `expected` is the collection and `got` is the
file, and the arrow reads like an instruction to convert.

### 2.6 Constraints that bound the solution

- Data Storage parses EJSON on input, so `{$date}` / `{$oid}` sent on insert
  become real BSON values (`insert_many` path).
- Update / Replace upload a JSON blob to the data-matching API, which preserves
  types. A nested `{$oid}` in a non-`_id` field is accepted and round-trips
  (live-verified 2026-07-04). `{$date}` through that same path is **not yet
  verified** — see §7.
- `_id` is stripped from Update / Replace uploads and cannot round-trip there;
  Insert does round-trip it.
- `importPlan.ts#walkPaths` already defines this repo's leaf rule — arrays,
  single-`$`-key EJSON wrappers and empty objects are leaves, `maxDepth = 5`.
  The flattener reuses it rather than defining a second one.

## 3. Decisions

Owner decisions from the 2026-08-24 brainstorm:

| # | Decision |
|---|---|
| D1 | Restore structure always; restore scalar types only where the target collection's own shape says so. Never guess by default. |
| D2 | Cover CSV, Excel **and** XML. |
| D3 | Restoration is visible: a control plus a one-line summary of what changed. |
| D4 | CSV/Excel export flattens nested objects into dotted columns. |
| D5 | Dotted columns are the **only** layout — the single-JSON-column layout is not kept as an option. Accepted consequence: the exported file's shape changes for anything already consuming it, with no way back. |
| D6 | Two import controls with distinct jobs; the existing "Infer types" is renamed because it no longer describes what it does. |

## 4. Design

### 4.1 Import is a layered restore

Structure is rebuilt first, then each leaf value resolves by a single rule:

> **If the target collection has an opinion about this path, it wins — including
> the opinion "this is a string". Only where it has none do the fallbacks run.**

| # | Layer | Basis | Runs when |
|---|---|---|---|
| 0 | Un-dot the header | The header grammar (§4.2) | always, under the toggle |
| 1 | Shape-guided value | The collection's sampled shape | the shape knows the path |
| 2 | Structural JSON | Text parses as `{…}` / `[…]` | the shape has no opinion |
| 3 | Detect numbers & booleans | Heuristic (`inferValue`) | as 2, and opted in |
| 4 | Leave as text | — | nothing above applied |

Ordering matters and the obvious arrangement is wrong. Parsing every
JSON-looking cell *before* consulting the collection would re-type precisely the
data the shape check exists to protect: a column the collection calls a string,
holding text that happens to look like JSON, would silently become an object.
Putting the grounded layer first makes every ambiguity resolve toward leaving
the value alone, and makes layer 3 safer than it is today — a known-string
column can no longer be re-typed by a guess.

Layers 2 and 3 are both "the collection has no opinion" fallbacks — an unknown
path, or a new/empty collection with no shape at all — ordered structural before
heuristic. This is what keeps a round trip into a *fresh* collection working:
with no shape, layer 2 still rebuilds objects and arrays.

### 4.2 New module: `src/mdh/flatten.ts` — the one home for the path grammar

Pure, DOM-free, no network. The escaping grammar, the two inverse functions,
and the shared leaf rule live here and **only** here (see "One home per
grammar" in CLAUDE.md); `shape.ts` imports it rather than joining on `.` itself.

```
encodeSegment(key)   ->  key with \ doubled and . escaped
joinPath(segments)   ->  encoded segments joined with '.'
splitPath(header)    ->  split on UNESCAPED dots, then unescape each segment
flattenDoc(doc, { maxDepth = 5 })  ->  Record<encodedPath, value>
unflattenDoc(row)                  ->  { doc, conflicts: string[] }
getByPath(doc, encodedPath)        ->  value at that path (preview lookup)
hasByPath(doc, encodedPath)        ->  whether that path exists at all
isOpaqueKey(key)                   ->  key has a '.' or starts with '$' (never descended into)
isEjsonWrapper(v)                  ->  single-'$'-key object; also adopted by importPlan.ts
```

Leaf rule (identical to `importPlan.ts#walkPaths`): array, EJSON wrapper,
empty object, or depth cap reached.

#### Dots inside key names

MongoDB permits a field literally named `a.b`, so a bare dotted header is
ambiguous: it could mean that key, or a nested `{a: {b: …}}`. Escaping removes
the ambiguity in both directions rather than special-casing it.

| Document | Column header | Re-imports as |
|---|---|---|
| `{a: {b: 1}}` | `a.b` | `{a: {b: 1}}` |
| `{"a.b": 1}` | `a\.b` | `{"a.b": 1}` |
| `{a: {"b.c": 1}}` | `a.b\.c` | `{a: {"b.c": 1}}` |
| `{a: {"b.c": {d: 1}}}` | `a.b\.c` (JSON cell) | `{a: {"b.c": {d: 1}}}` |
| `{"a\\b": 1}` | `a\\b` | `{"a\b": 1}` |

Encoding is `\` → `\\` then `.` → `\.`; decoding is the exact inverse. For a
key with no dot and no backslash — every normal key — it is a no-op, so headers
are unchanged for the overwhelming majority of collections.

#### Opaque keys: never descended into

One rule, applied identically by the flattener and by the discovery aggregation,
because the two must agree on the header set or the export drops data:

```
isOpaqueKey(key) = key.includes('.') || key.startsWith('$')
```

An opaque key is always a leaf. Its value — even a whole sub-document — becomes
one JSON-encoded cell, and layer 2 restores it, so fidelity is unaffected. Both
halves are forced by what an aggregation can express:

- **A dot.** Mongo's field path `"$a.b"` addresses a *nested* `b`, not a key
  named `a.b`. Only `$getField` can, and its availability on Data Storage is
  unverified.
- **A leading `$`.** Building a field path for a key named `$foo` yields
  `"$$foo"` — which Mongo parses as a **variable reference**, not a field. Left
  unguarded, discovery would either error or silently read the wrong thing.

Because no pending parent ever holds an opaque segment, every parent path is
dot-free per segment, and `splitPath(p).join('.')` reconstructs its Mongo field
path exactly. That invariant is what makes §4.4's `<p>` substitution safe, and
it is asserted by a test rather than assumed.

**Foreign files with dotted headers.** With "Restore structure & types" ON — the
default — a header `a.b` in a file this app did not write will nest. That is the
correct reading for an export and the intended one for the toggle; a user who
wants a literal flat `a.b` key turns the toggle off, which restores today's
behaviour exactly. Called out in §5.

**Unflatten conflicts.** If a path segment is already occupied by a non-object
(a file carrying both an `a` and an `a.b` column), the dotted key stays literal
rather than clobbering it, and `restoreDocs` reports it as a warning.

**CSV interaction.** A backslash needs no quoting in CSV, and the tokenizer's
optional `escapeChar` is honoured only *inside* quoted fields — an escaped
header is never quoted, so the two cannot interfere. Asserted by a test rather
than assumed.

### 4.3 New module: `src/mdh/restoreValues.ts`

```
restoreDocs(docs, shape) -> { docs, summary }
```

`shape` is the existing `deriveShape` result (`paths: Map<path, Set<type>>`
plus `optionalPaths`), or `null` when the collection is new or empty.

**Layer 1** applies per path only when the reference type set — ignoring `null`
— is a single type. A set with more than one non-null type is no opinion at all
and falls through:

| Reference type | Cell | Becomes |
|---|---|---|
| `object` | string that JSON-parses to an object | the parsed object |
| `array` | string that JSON-parses to an array | the parsed array |
| `array` | any scalar | `[value]` — fixes XML's 1-element collapse |
| `date` | ISO-8601 string | `{$date: <iso>}` |
| `objectId` | 24-hex string | `{$oid: <hex>}` |
| `number` | clean numeric string (`inferValue` rules) | number |
| `bool` | `"true"` / `"false"` | boolean |
| `string` | anything | **unchanged — this is the point** |
| any, path optional | `""` or `null` | key deleted |
| any but `string`, path required | `""` | `null` |

A cell that does not match its path's expected form is left alone rather than
forced — the shape check then reports it, which is the correct outcome for a
file that genuinely disagrees with the collection.

**Layers 2 and 3** apply only to paths the shape does not resolve: layer 2
parses a `{…}` / `[…]` cell, then layer 3 applies `inferValue` if the user opted
in. With `shape === null` every path takes this route, which is what makes a
round trip into a fresh collection restore structure.

The empty-cell rules are what let an optional field round-trip: the export
writes an empty cell both for an absent field and for a stored `null`, and
dropping the key is the reading that does not add data. A stored explicit
`null` on an optional path therefore comes back absent — documented, and the
lesser of the two losses.

`summary` counts each category so the UI can report them.

### 4.4 Export: exhaustive deep column discovery

Dotted columns are only safe if the header is the **exact** union of leaf paths.
A leaf missing from the header is silently dropped data, so a sampled discovery
is not acceptable. `buildColumnDiscoveryPipeline` currently returns top-level
keys only.

Replaced by a level-at-a-time walk in a new `src/mdh/columnDiscovery.ts` — it is
an aggregation concern shared by the CSV and Excel serializers, not CSV text
handling, and `csv.ts` is already at 287 lines. One aggregation per depth:

```
for each pending parent p (root first):
  [ ...filterStages,
    { $project: { kv: { $cond: [ { $eq: [ { $type: <p> }, 'object' ] },
                                 { $objectToArray: <p> }, [] ] } } },
    { $unwind: '$kv' },
    { $group: { _id: '$kv.k', types: { $addToSet: { $type: '$kv.v' } } } } ]
```

- All parents at one depth are batched into a single `$facet`. **`$facet` output
  keys cannot contain dots**, so facet keys are positional (`f0`, `f1`, …) and
  mapped back client-side.
- The `$cond` guard is required: `$objectToArray` errors on a non-document, and
  a path can hold an array or a scalar in some records.
- A key whose `types` include `object` becomes a pending parent for the next
  level; a key with any non-object type is also emitted as a leaf. A path that
  is an object in some records and a scalar in others is therefore both.
- **An opaque key is never made a pending parent** (§4.2) — it is emitted as a
  leaf, so no stage ever builds a field path Mongo's dot notation cannot address,
  and none ever builds `$$foo` out of a `$`-prefixed key. Emitted paths are
  escaped via `flatten.ts#joinPath`, so the header and the shape agree on one
  grammar.
- Terminates when no pending parents remain, or at `maxDepth`. Parents still
  pending at the cap are emitted as leaves and JSON-encoded.
- `$type` reports `objectId` / `date` for real BSON values, so EJSON is never
  mistaken for a sub-document.

The depth cap is cosmetic, not a fidelity limit: anything deeper arrives as a
JSON cell and layer 2 restores it.

Column ordering: `recordColumns.ts#orderExportColumns` seeds from the loaded
table's top-level order, then falls back to alphabetical. With leaf paths it
must order by the parent's table position first, then leaves within a parent —
otherwise every dotted column misses the seed and the whole header degrades to
alphabetical.

### 4.5 Export: writing dotted rows

`csvRow` and `xlsxWrite#writeDocs` currently do a flat `doc[column]` lookup.
Both switch to `flattenDoc(doc)` and look the dotted path up in the flat map.
`ExportWizard`'s preview grid does the same, so the preview stays truthful.

`csvCell` / `cellXml` are unchanged: an array or a too-deep sub-document is
still JSON-encoded, `{$date}` is still ISO text (a real date cell in Excel), and
`{$oid}` is still bare hex.

### 4.6 Export: XML

`valueToXml` currently recurses into `{$oid: …}` and emits `<_oid>`. It gains
the same EJSON check `csvCell` and `cellXml` already use, and writes the scalar
text instead:

```
<_id>000000000000000000000001</_id>
<updated>2026-01-31T09:00:00.000Z</updated>
```

Layer 2 restores both on import. XML nests natively, so dotted columns do not
apply; its remaining gap — a one-element array exported as a single element —
is closed by layer 1's array-wrapping rule.

### 4.7 Guard: stop requiring optional paths, and share the path grammar

`validateAgainstShape` skips the missing-path check for any path in
`shape.optionalPaths`. A field that only some existing records carry cannot be
"missing" from an imported row. Unknown-path and type checks are unchanged.

`shape.ts#collectPaths` also switches from a bare `` `${prefix}.${key}` `` join
to `flatten.ts#joinPath`. Without this, `deriveShape` cannot tell `{"a.b": 1}`
from `{a: {b: 1}}`, and layer 1 would look a restored path up under the wrong
key. One grammar, one module. `SpecialText` already renders the error card's
field names, so an escaped `a\.b` displays legibly.

Not changed: `importPlan.ts#collectFieldPaths` feeds the Update match-key
picker, and the data-matching API interprets a dotted `id_keys` value as
nesting regardless — so a literal dotted key can never be a match key. That is
a pre-existing limitation of the server contract, unrelated to this defect, and
is left alone.

This also lets the "existing records aren't uniform … may over-reject" note
retire: the guard no longer over-rejects on that axis.

### 4.8 UI

**Import Configure strip** (CSV, Excel, XML):

| Control | Default | Does |
|---|---|---|
| Restore structure & types | **ON** | layers 0–2 |
| Detect numbers & booleans | OFF | layer 3 — renamed from "Infer types" |

The rename is label-only; the `inferTypes` option key and the `csv-infer` /
`xml-infer` testids stay, so nothing downstream churns. Neither control is
persisted, matching the `shapeOverride` precedent.

**Summary line**, above the shape check:

```
Restored 9 nested columns, 1 array and 1 date to match the collection.
```

and when there is no reference shape:

```
Restored 9 nested columns · collection is empty, so value types were left as text.
```

and when the shape sample failed to load:

```
Restored 9 nested columns · couldn't read the collection's types, so values were left as text.
```

**Shape error card** — direction stated on every row, not just wrong-type:

```
MISSING      in the collection, not in the file    "address.region"
UNEXPECTED   in the file, not in the collection    "address"
WRONG TYPE   "updated"   collection has date · file has string
```

### 4.9 Data flow, and where each layer physically lives

**Every import-side layer lives in `restoreValues.ts`.** The format parsers are
not touched at all: they keep returning flat documents keyed by the raw header,
and `restoreDocs` un-dots, restores and infers in one pass. That keeps the whole
ordering rule in one readable function instead of split across three parsers.

```
file → format.parse (unchanged) → flat docs keyed by raw header
                                         │
                 shape ($sample 500, async) ──┐
                                         │    │
                                         ▼    ▼
                              restoreDocs(docs, shape, { inferTypes })
                                    0 unflatten · 1 shape · 2 JSON · 3 infer
                                         │
                        ┌────────────────┼────────────────┐
                        ▼                ▼                ▼
                     preview   validateAgainstShape   startImport
```

`restoreDocs` runs in one `useMemo` in `ImportWizard`, keyed on the parsed docs,
the shape and the two controls. Its output feeds the preview, the validator
**and** the upload — one source of truth, so what the preview shows is what gets
written. While the shape is still loading, `shapeLoading` gates `canImport` in
`ImportConfirm` directly (folded into the same computation as the shape-mismatch
guard) — the "Checking shape…" line is a sibling render, not a gate on its own,
so no partially-restored state is ever actionable. `shapeLoading` itself starts
`true`, not `false`: it flips to `true` again inside the sampling effect anyway,
but only after the first commit of the Decide screen, and defaulting it `false`
left that one render as an unprotected gap.

**Inference must move for the ordering rule to be true.** `inferTypes` is
applied today inside `rowsToDocs` / `elementToValue`, i.e. *before* any shape is
known — so a column the collection calls a string would already have become a
number, and layer 1 (which only converts strings) could not put it back. The
wizard therefore parses with `inferTypes: false` whenever restore is on and
hands the user's choice to `restoreDocs` instead:

```
restoreOn ? restoreDocs(parse(input, {…opts, inferTypes: false}).docs, shape,
                        { inferTypes: opts.inferTypes })
          : parse(input, opts).docs          // today's behaviour, byte for byte
```

The parsers keep their `inferTypes` option and their tests; only the caller
changes. `inferValue` stays in `csv.ts` as the single implementation of the
heuristic, imported by `restoreValues.ts`.

**The preview grid** keeps rendering `parsed.columns` (the raw headers) but
looks values up in the restored, now-nested documents via
`flatten.ts#getByPath`. The header *is* the encoded path, so the lookup is
exact.

## 5. Backward compatibility

- **Files exported before this change** — top-level headers with a JSON cell per
  nested field — still import correctly: layer 2 parses the cell where the
  collection has no opinion, layer 1 fixes the scalars where it does. This is a required test, not an expectation.
- **"Restore structure & types" OFF reproduces today's behaviour exactly**, including
  flat dotted keys for a file that genuinely has dotted headers. With it ON, a
  foreign file's `a.b` header nests — the one deliberate behaviour change on the
  import side, and the toggle is the way out of it (§4.2).
- **Headers are byte-identical for collections with no dotted key names**, which
  is nearly all of them: the escaping is a no-op unless a key contains `.` or
  `\`.
- **No new storage keys.** Neither control is persisted.
- **Export output changes shape** (D5). Accepted.
- **`_id` handling is untouched** in all three modes.

## 6. Out of scope

- Re-importing an export into the *same* collection with Insert still fails
  row-by-row on duplicate `_id`. That is correct behaviour, not this defect.
  The round trip this design guarantees is into a fresh collection, or via
  Replace / Update.
- `__digest_md5` is stripped for Update / Replace but carried on Insert. For a
  faithful restore (which also keeps `_id`) that is arguably right, and it is
  not part of this defect. Noted, not changed.
- Indexed array columns (`address.line.0`). Arrays stay JSON-encoded in one
  cell; the header would otherwise be ragged and unbounded.

## 7. Verification gates

Live probes on an internal sandbox org only — never a customer org, and no
customer data leaves the browser. Each must pass before the code that depends
on it is called done.

| # | Claim | Result |
|---|---|---|
| V1 | The level-at-a-time discovery aggregation runs on `svc/data-storage` and returns the exact leaf union | **PASS** — 2026-08-24, org 214757, scratch collection since dropped |
| V2 | `$facet` accepts positional keys and the per-level batch, and `$type` reports `objectId` / `date` for real BSON | **PASS** — `$facet`/`$cond`/`$eq`/`$type`/`$objectToArray` all execute; `$type` returned `date`, `objectId` and `array`, never `object` |
| V3 | `{$date}` in a data-matching JSON upload stores as a real BSON date | **NOT RUN** — no tooling reaches `svc/data-matching`; see below |
| V4 | `{$date}` via `insert_many` stores as a real BSON date | **PASS** — read back as `{$date}`, not a string |

V2 was the load-bearing gate: the entire leaf rule depends on EJSON wrappers being scalars
server-side, and they are. Two further behaviours were measured at level 2 and are worth
recording, because both were designed from reasoning alone:

- A field that is `{}` in every record produces **zero rows** at the next level — exactly the
  case §4.4's "pending parent with no children becomes a leaf" rule handles.
- A field that is an object in one record and a scalar in another reports
  `types: ["string","object"]` and yields children at the next level, i.e. it really is
  emitted as **both** a leaf and a parent. Real data produces this header.

**V3 remains unverified.** The data-matching upload is a multipart `PUT` to
`svc/data-matching/api/v1/dataset/{name}`, which no available tool reaches. The indirect
evidence is strong — a non-`_id` `{$oid}` was live-verified through that same upload on
2026-07-04, and `{$oid}` and `{$date}` share one EJSON ingest path — but it is indirect. If
V3 turns out false, Update/Replace keep ISO text for date paths, only Insert restores them,
and the summary line must say so.

**Dates are instant-preserving, not string-preserving.** Measured: Data Storage normalises
milliseconds on read — `{$date:"2026-01-31T09:00:00.000Z"}` comes back as
`{$date:"2026-01-31T09:00:00Z"}`. A round trip therefore returns the same instant, not the
same string. `tests/mdh-round-trip.test.js` cannot see this: its fixtures never leave memory.

## 8. Testing

New:

- `tests/mdh-flatten.test.js` — flatten/unflatten inverse property, leaf rule,
  unflatten conflict warning, and every row of §4.2's dotted-key table:
  `{a:{b:1}}` and `{"a.b":1}` must produce **different** headers and each must
  survive the round trip; a key containing a backslash; a dotted key nested
  inside a normal object staying a JSON leaf; a `$`-prefixed key staying a leaf;
  and a CSV header carrying a backslash tokenizing intact with `escapeChar` set
  to `\`.
- `tests/mdh-restore-values.test.js` — every row of the §4.3 table, plus: a
  string-typed path is never converted; a mixed `Set` of >1 non-null type is
  never converted; no shape → layers 2–3 only. **And the ordering rule itself**:
  with `inferTypes` on and the collection reporting a path as a string, a cell
  of `123456` stays the string `"123456"` — the regression the §4.9 relocation
  exists to prevent, and the one that would silently pass if inference stayed in
  the parser.
- `tests/mdh-round-trip.test.js` — the guarantee itself. One fixture document
  carrying nested object, array, one-element array, `{$date}`, non-`_id`
  `{$oid}`, number, bool and a field absent on one record. For each of
  CSV / Excel / XML / JSON / JSONL: serialize → parse → restore →
  `validateAgainstShape` is `ok`, and the restored document deep-equals the
  original. **Plus one legacy-layout CSV fixture** (top-level headers, JSON
  cells) proving §5's first bullet.
- `tests/mdh-column-discovery.test.js` — the level builder is pure; assert its
  stages, the positional facet keys and the `$cond` guard. The driver takes its
  `aggregate` injected, so the multi-level walk, the depth cap and the
  opaque-key rule are all tested against a fake with no network.

Updated: existing export-column, `csvRow`, xlsx-write, shape and
ImportConfirm tests, for dotted columns, the optional-path rule and the new
copy.

Note for whoever writes these: `tests/mdh-round-trip.test.js` needs
`// @vitest-environment jsdom` — the XML and XLSX readers use `DOMParser`.

## 9. Files touched

| File | Change |
|---|---|
| `src/mdh/flatten.ts` | new — the path grammar, flatten / unflatten |
| `src/mdh/restoreValues.ts` | new — layers 1–3 + summary |
| `src/mdh/columnDiscovery.ts` | new — level pipeline builder + `discoverLeafPaths` driver |
| `src/mdh/csv.ts` | `csvRow` via flattened map; `buildColumnDiscoveryPipeline` removed |
| `src/mdh/downloadCollection.ts` | CSV serializer `init` calls `discoverLeafPaths` |
| `src/mdh/xlsxWrite.ts` | `writeDocs` via flattened map |
| `src/mdh/xml.ts` | `valueToXml` writes EJSON as scalar text |
| `src/mdh/shape.ts` | optional paths are not required; paths built via `joinPath`; `uniform` removed |
| `src/mdh/importPlan.ts` | drops its private `isEjsonWrapper` for the shared one |
| `src/mdh/recordColumns.ts` | order leaf paths by parent, then leaf |
| `src/mdh/formats/csv.tsx`, `xlsx.tsx`, `xml.tsx` | new control, renamed label |
| `src/mdh/components/ImportWizard.tsx` | `restoreDocs` memo feeding preview + validator + upload |
| `src/mdh/components/ImportConfirm.tsx` | summary line; direction on every error row |
| `src/mdh/components/ImportControls.tsx` | `CsvPreview` looks up via `getByPath` |
| `src/mdh/components/ExportWizard.tsx` | preview grid reads flattened paths |

## 10. Related records

- `2026-06-30-unified-dataset-import-design.md` — the one-wizard import
- `2026-07-04-export-unify-design.md` — the one-wizard export
- `2026-06-30-excel-import-export-parity-design.md` — the xlsx writer and the
  date-cell rehydration this design generalises
- `2026-07-03-import-shape-sample-verbose-design.md` — the shape guard whose
  optional-path rule §4.7 changes
