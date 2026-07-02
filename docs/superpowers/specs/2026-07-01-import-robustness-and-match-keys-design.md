# Import Robustness & Match-Key UX — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`
**Builds on:** the unified Import wizard + File/Clipboard source toggle
(`2026-06-30-unified-dataset-import-design.md`, `2026-07-01-import-source-toggle-design.md`).

## 1. Problem & goal

Four independent refinements to the import Update/Replace experience, prompted by
review questions:

1. **Match-key picker doesn't scale to real documents.** It renders one checkbox
   per **top-level** field. Wide docs (hundreds of fields) become an unusable
   wall, and **nested** fields (`address.zip`) can't be selected at all.
2. **Composite-key probe can be slow.** For a multi-field key the pre-flight probe
   builds an up-to-1000-way `$or` of `$and`s per batch; without a compound index
   that scans the collection per batch.
3. **No large-dataset warning.** Update/Replace runs one write per matched row;
   a user importing tens of thousands of rows gets no heads-up that it'll take
   minutes.
4. **Pre-existing test flake.** `RecordList.jsx:44`'s `requestAnimationFrame`
   fires post-teardown under full-suite load → an unhandled-rejection.

Goal: a **searchable, nested-aware match-key picker**; a **faster composite-key
probe** when a key field is indexed; a **non-blocking large-import caution**; and
the **rAF guard**.

### Non-goals
- No change to the mode/plan/execute contract beyond dotted-path support.
- Not fixing per-row execution throughput itself (inherent; the guardrail sets
  expectations). No server-side `$merge` (unverified on this backend).
- Clipboard/source-toggle, tabs, and the summary callout are already shipped.

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| Nested keys | **Full nested support** — the picker lists flattened **dotted leaf paths** (top-level + nested), searchable, selected shown as chips. Default `_id`. |
| Probe optimization | For a composite key with **≥1 indexed field**, prefilter by that field's indexed `$in` + project key paths + `_id`, match tuples **client-side**; **fall back to `$or`** when no key field is indexed. Results identical. |
| Guardrail | **Warn but allow** — a dismissible caution when a Update/Replace will do **≥ 10,000 per-row writes** (`willApply + willInsert`, or file-row count before the plan resolves). Non-blocking. Insert mode (batched) gets no warning. |
| rAF | Guard `RecordList.jsx:44` with `typeof requestAnimationFrame === 'function'` (the pattern `StageLinkOverlay.jsx` already uses). |
| Commit policy | Write this spec; **do not git-commit** (standing user preference). |

## 3. Verified facts (grounding)

- `importPlan.js` today keys off top-level fields via `hasField(doc,k)`/`doc[k]`
  in `keyValue`/`analyzeFileKeys`/`buildProbePipeline`; composite probe emits
  `$match:{$or:[{$and:[{f:v}…]}]}` + `$group:{_id:{f:'$f',…}}`.
- `runImport.js` `probeCollection` maps each probe-result row to
  `groups.set(stableKey(row._id), {ids,count})`; `buildUpdateSet(doc,keys)` drops
  top-level `keys`+`_id`; execution filters by the resolved `_id`.
- MongoDB supports **dotted-path** field access in `$match`/`$in` and in
  aggregation field refs (`'$a.b'`) natively. **Caveat:** a `$group._id` *object*
  whose keys contain dots is unsafe — so composite group keys must be sanitized.
- The wizard already fetches `indexedFields` (a `Set` of index key-field names,
  which includes dotted names like `address.zip`) in the CONFIRM stage.
- `ImportConfirm` now shows a `.import-summary-callout` (mode explanation + live
  plan counts) directly above the actions; cautions (`blocked`, missing-key,
  `indexWarning`) render just above it.
- `StageLinkOverlay.jsx` already guards rAF with `typeof requestAnimationFrame === 'function'`; `RecordList.jsx:44` does not.

## 4. Piece 1 — searchable, nested-aware match-key picker

### Field discovery (pure, `importPlan.js`)
`collectFieldPaths(docs, { sampleSize = 50, maxDepth = 5 }) -> string[]`
- Walks up to `sampleSize` docs; returns the **sorted union** of dotted **leaf
  paths**. Always includes `_id` first.
- Descends into **plain objects** only. **Arrays** are leaves (offer the array
  field itself, never `arr.0.x`). **EJSON wrappers** (`{$oid}`, `{$date}`, or any
  single-key `$*` object) are leaves (no `_id.$oid`). Stops at `maxDepth`.

### Dotted-path resolution (pure, `importPlan.js`)
- New `getPath(doc, 'a.b.c')` + `hasPath(doc, path)` (returns `undefined`/`false`
  if any segment is missing or a non-object is traversed).
- `keyValue`, `keyKeyOf`, `analyzeFileKeys`, `buildProbePipeline` use `getPath`/
  `hasPath` instead of `doc[k]`/`hasField`. Flat keys are a strict subset, so
  existing behavior is unchanged.
- `coerceKeyValue` still coerces 24-hex only when the path is exactly `_id`.

### Probe pipeline with dotted + positional group keys (`importPlan.js`)
- **Single key** (flat or dotted): `$match:{ '<path>': {$in:[…]} }`,
  `$group:{ _id: '$<path>', ids:{$push:'$_id'}, count:{$sum:1} }`. (`'$a.b'` is
  valid.)
- **Composite key:** `$match:{$or:[{$and:[{'<path>':v}, …]}]}` (dotted paths OK in
  a match), but the group `_id` uses **positional, dot-free keys**:
  `$group:{ _id:{ k0:'$<path0>', k1:'$<path1>', … }, ids, count }`.
  `probeCollection` reconstructs each group's tuple by reading `row._id.k0`,
  `row._id.k1`, … **in key order**, building the object it hashes with
  `stableKey` so the client join key matches `keyKeyOf(fileDoc, keys)`.
- `buildProbePipeline(keys, batch)` keeps returning a **stages array** (so the
  existing tests stay structural). The reconstruction convention is fixed and
  deterministic: **single** key → `_id` is the value (`stableKey(row._id)`);
  **composite** key → `_id` is `{ k0, k1, … }` positional and `probeCollection`
  rebuilds the tuple by reading `k0…kn` in `keys` order. The **prefilter** path is
  a separate builder `buildPrefilterProbe(keys, prefilterPath, batch)` (§5) with
  its own client-side grouping, so `probeCollection` always knows which shape it
  asked for.

### `buildUpdateSet` with a nested key (`runImport.js`)
- Still drops exact top-level names in `keys` + `_id`. A nested key
  (`address.zip`) is **not** a top-level field, so its parent object rides along
  in `$set` (the row's value wins; the matched leaf is unchanged). No per-leaf
  merge — documented behavior.

### UI — `components/MatchKeyPicker.jsx` (new)
- Props: `{ paths, keys, setKeys }`. Renders selected `keys` as removable **chips**
  (✕) and a **type-to-filter input** over `paths` (excluding already-selected).
  Clicking/Enter on a suggestion adds it; Backspace on empty input removes the
  last chip. Keeps the wrapper `data-testid="match-keys"`.
- `ImportConfirm` computes `paths = collectFieldPaths(docs)` and renders
  `MatchKeyPicker` in place of the `.match-fields` checkbox block. Default keys
  still come from `defaultKeysFor(docs)`.
- Styling in `console.css` (`.match-key-picker`, `.match-key-chip`,
  `.match-key-suggest`), reusing existing tokens.

## 5. Piece 2 — composite-key probe optimization

- The wizard passes the already-fetched `indexedFields` into `probeCollection`.
- For a **composite** key, if any chosen key path is in `indexedFields`, pick the
  first such path `p` and build a **prefilter** pipeline:
  `$match:{ '<p>': {$in:[distinct values of p in the batch]} }`,
  `$project:{ <each key path>:1, _id:1 }`. `probeCollection` then computes each
  returned doc's tuple (`keyKeyOf`) client-side and accumulates
  `groups.get(kk) = {ids:[…], count}` (counting duplicates for uniqueness).
- If **no** key path is indexed → keep the current `$or` pipeline (unchanged).
- Single-field keys are unchanged (already an indexed-friendly `$in`).
- Result parity: matched/ambiguous/new buckets are identical to the `$or` path
  (client-side tuple match reproduces exact equality). A projection cap
  (e.g. stop after a large N per batch and fall back) guards a pathological
  low-cardinality prefilter; `log`/warn is not needed (bounded per batch).

## 6. Piece 3 — large-dataset guardrail (`ImportConfirm.jsx`)

- `LARGE_IMPORT_THRESHOLD = 10000`.
- For Update/Replace: `perRow = plan ? plan.counts.willApply + plan.counts.willInsert : docs.length`.
  When `perRow >= LARGE_IMPORT_THRESHOLD`, render a caution
  (`.import-warn`, `data-testid="import-large-warn"`) in the warnings region above
  the summary callout: *"Large import: ~{perRow} per-row writes — Update/Replace
  runs one write per row; this may take several minutes."* Non-blocking (the run
  button is unaffected).
- Insert mode: no warning (batched inserts are fast).

## 7. Piece 4 — rAF guard (`RecordList.jsx`)

- Wrap the `requestAnimationFrame(...)` at line ~44 so it only calls when defined:
  `if (typeof requestAnimationFrame === 'function') { raf = requestAnimationFrame(…); }`
  (mirror `StageLinkOverlay.jsx`). Behavior in the browser is unchanged; the
  jsdom full-suite unhandled-rejection disappears.

## 8. Architecture / files

- **`importPlan.js`** — `getPath`/`hasPath`, `collectFieldPaths`, dotted-aware
  `keyValue`/`keyKeyOf`/`analyzeFileKeys`, positional-group `buildProbePipeline`
  (+ prefilter variant metadata).
- **`runImport.js`** — `probeCollection` (positional-group reconstruction +
  indexed-prefilter path; new `indexedFields` param), path-aware `buildUpdateSet`.
- **`components/MatchKeyPicker.jsx`** (new) — searchable chips picker.
- **`components/ImportConfirm.jsx`** — use `MatchKeyPicker` + `collectFieldPaths`;
  add the large-import caution; pass `indexedFields` through if needed.
- **`components/ImportWizard.jsx`** — thread `indexedFields` into `probeCollection`.
- **`RecordList.jsx`** — rAF guard.
- **`console.css`** — picker + caution styles.

## 9. Backward compatibility
- Flat single/composite keys behave exactly as today (dotted resolution is a
  superset; positional group keys reconstruct to the same join keys).
- `probeCollection` gains an optional `indexedFields` arg (defaulted) → callers
  without it keep the `$or`/`$in` behavior.
- No storage-key changes. `defaultKeysFor` unchanged (`_id` default).

## 10. Testing
- **`mdh-import-plan`**: `getPath`/`hasPath` (missing segments, non-object
  traversal); `collectFieldPaths` (nesting, arrays-as-leaves, EJSON-as-leaf,
  `_id` first, depth/sample caps); dotted single-key probe; composite positional
  group-key shape; flat-key regression (unchanged).
- **`mdh-run-import`**: probe tuple reconstruction from positional `_id`;
  indexed-prefilter path (mock `aggregate` returns projected docs → correct
  groups) + `$or` fallback when unindexed; dotted `buildUpdateSet` (parent object
  rides along; `_id` dropped).
- **`mdh-match-key-picker`** (new): filter suggestions, add/remove chips, exclude
  selected, default `_id`.
- **`mdh-import-confirm`**: picker renders (`match-keys`); large-import caution
  appears at threshold and is absent below it and for Insert.
- Run `npm run build` + `npm test`; the rAF guard should also clear the known
  full-suite unhandled-rejection.

## 11. Risks
- **Dotted group-key sanitization** is the subtle part — pinned by a
  reconstruction test so client/server join keys can't silently diverge.
- **Prefilter over-fetch** on a low-cardinality indexed field — bounded per batch
  (tiny projection) with a fallback cap; parity preserved.
- **`collectFieldPaths` cost** on huge wide docs — bounded by `sampleSize`/
  `maxDepth`.
