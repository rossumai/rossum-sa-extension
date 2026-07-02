# Unified Dataset Import — Design

**Date:** 2026-06-30
**Status:** Approved (brainstorming) → ready for implementation plan
**Area:** Dataset Management (MDH) Console app — `src/mdh/`

## 1. Problem & goal

The MDH app today has **two inconsistent import families**:

1. **Insert wizards** (JSON, JSONL, CSV, Excel, XML) — polished: multi-stage,
   chunked (`runChunkedInsert` / `runChunkedOverwrite`), progress bar, cancel,
   in-file dedup, ObjectId-`_id` normalization, partial-failure reporting.
   Modes: `insert` (fail on duplicate `_id`) and `overwrite` (delete-by-`_id`
   + re-insert). **Matching is `_id`-only.**
2. **Update / Replace panels** (`DataOperations.jsx`) — crude: a per-document
   `await` loop, configurable match keys, but no chunking / progress / cancel /
   dedup / `_id` normalization. **Unreachable from the UI** — `DataPanel.jsx`'s
   action handler only dispatches `insert*` actions, so `update-file` /
   `replace-file` are never triggered. Effectively dead code.

**Goal:** one **unified Import wizard** that does **Insert / Update / Replace**
across **all five formats**, with **configurable match keys**, a **live
"what-will-happen" plan**, progress, and cancellation — so it is always clear
which mode the user is in and exactly what the import will do.

This is a refactor *and* a feature: it removes per-format wizard duplication and
revives (properly) the update/replace capability that has bit-rotted.

### Non-goals

- Bulk update/delete **by filter** (`BulkUpdate.jsx` / `BulkDelete.jsx`) stay as
  they are — that is a different feature (edit/delete records matching a query,
  not "apply a file to the collection").
- The inline JSON-editor insert (`InsertPanel`) stays as a quick path; it is not
  part of the file-import wizard.
- No change to the MDH Datasets (file-based) service — this is all Data Storage
  (`/svc/data-storage`).

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| Mode model | Three top-level modes **Insert / Update / Replace** + an **"also insert rows that don't match" (upsert)** toggle on Update & Replace. The legacy `overwrite` becomes the fast path for *Replace · key = `_id` · upsert on*. |
| Format coverage | **All formats support all modes** (parsing already yields plain row objects, so mode logic is format-agnostic). |
| Refactor shape | **Unify** the five near-duplicate wizard files into one wizard with **pluggable per-format parsers** + shared mode / match-key / preview / progress / done stages. |
| Entry point | A single **`Import ▾`** toolbar button. The `▾` menu preselects the format; the **mode is chosen inside** the wizard. |
| Multi-match | **Block if non-unique** — if any match-key tuple matches >1 existing record, *or* repeats within the file, the run is blocked until the user picks a unique key or fixes the data. |
| In-file duplicate keys | Also **block** (a file that maps two rows to one key is ambiguous for update/replace). |
| Update `$set` | Excludes the match-key fields **and** `_id`. |
| Retire | Delete the 4 separate wizard files and the dead `UpdatePanel`/`ReplacePanel`. |
| Commit policy | Write this spec; **do not git-commit** (standing user preference). |

## 3. Verified API facts (grounding)

From `src/mdh/api.js` and the Data Storage reference:

- `update_one` / `update_many` / `replace_one` accept an `options` object and
  return `upserted_id` ⇒ **native upsert is supported by the API**, but the
  current client never passes `options`, so it is unused today.
- `bulk_write` is **async (202 + poll) and documented unreliable** in this
  repo's own comments (twice: `importFile.js`, `bulkOps.js`) — "returns success
  without actually replacing." The codebase deliberately uses delete+insert
  instead. ⇒ **No reliable single-call batch for heterogeneous per-row writes.**
- `{$oid}` / `{$date}` EJSON in request bodies become real BSON types on insert
  (the EJSON-on-input path). `normalizeDocId` coerces a 24-hex string `_id` to
  `{$oid}`.
- Data writes (insert/update/delete/replace) are **synchronous** (200);
  only collection-level ops (create/drop/rename/index) are async (202 +
  `content-location` operation id).
- `find` and `aggregate` are read-only and run up to 120 s; the pre-flight probe
  uses `aggregate`.

## 4. Mode semantics (exact)

`keys` = the chosen match-key field name(s). `upsert` = the toggle.

| Mode | Matched existing record | Row with **no** match | `_id` handling |
|---|---|---|---|
| **Insert** | n/a (no matching done) | inserted; `_id` collisions surface as failed batches (today's behavior, preserved) | 24-hex string `_id` → `{$oid}` via `normalizeDocId`; in-file dup `_id`s collapsed |
| **Update** | `update_one` filtered by the matched record's `_id`, with `$set` = row fields **minus** `keys` and **minus** `_id` | `upsert` on → insert the row; off → skip | `_id` is never in `$set` |
| **Replace** | `replace_one` filtered by the matched record's `_id`, replacement = full row **minus** `_id` | `upsert` on → insert the row; off → skip | matched record's `_id` is preserved |

Rules common to Update / Replace:

- **≥1 match key required.** Default to `_id` when every row in the file has an
  `_id`; otherwise the user must pick at least one field before proceeding.
- **Block** the run if, per the pre-flight probe, any key tuple matches >1
  existing record, or if any key tuple repeats within the file. (Insert is
  exempt — it does no matching.)
- **Upsert is emulated** from the plan split (matched → update/replace path;
  unmatched → batched insert path). This avoids relying on the unverified native
  `options.upsert` and yields exact counts.

### Legacy "overwrite" mapping

The old `overwrite` mode (delete every file `_id` then re-insert, idempotent
re-import) is preserved as the **fast path** for *Replace · key = `_id` · upsert
on*. The function `runChunkedOverwrite` stays exported and behavior-identical.

## 5. UX — the unified wizard

### Stages

```
PICK → [CONFIGURE*] → CONFIRM (mode + keys + live plan) → IMPORTING → DONE
       *format-specific parse options. JSON & JSONL have none → CONFIGURE skipped.
```

- **PICK** — drag/drop or click; `accept` from the preselected format. Format is
  preselected by the `Import ▾` menu item but the wizard still validates the
  picked file's extension.
- **CONFIGURE** (CSV/Excel/XML only) — the existing per-format option controls
  (CSV dialect/encoding/types; Excel sheet/header/empty/trim; XML record
  element/infer-types) with the live parsed preview. Unchanged behavior, now
  rendered via the format registry's `ConfigureControls`.
- **CONFIRM** — the centerpiece (see below).
- **IMPORTING** — phase-aware progress (`analyzing` / `inserting` / `updating` /
  `replacing` / `deleting`), counts, and **Cancel**.
- **DONE** — summary: inserted / updated / replaced / skipped (no-match, upsert
  off) / in-file duplicates collapsed / failed batches, with the per-range
  failure detail the current `StageDone` already renders.

### CONFIRM stage layout

- **Mode** — segmented control `Insert · Update · Replace`.
- **Match by** (Update/Replace) — a chip/checkbox picker of the file's columns
  (union of keys across the parsed rows). Defaults to `_id` when present on all
  rows.
- **`☑ Also insert rows that don't match`** (Update/Replace) — the upsert toggle.
- **Live plan** — a sentence recomputed (debounced ~300 ms) when mode/keys/upsert
  change, e.g. *"Update 1,240 matched · insert 87 new · 0 skipped"* (Insert mode
  shows the existing in-file/`_id` summary instead — no probe).
- **Inline blockers / warnings**:
  - 🔴 non-unique key (collection or in-file) → block, name the count, suggest a
    unique key.
  - 🟡 match key not backed by an index → soft perf warning (per-row filtered
    queries on an unindexed field are slow). Uses `api.listIndexes`.
  - 🟡 rows missing the chosen key field → counted and reported (treated as
    "cannot match" → skipped or, with upsert, inserted).
- **Primary button** — labeled per mode/plan: *"Update 1,327 records"*,
  *"Replace 1,327 records"*, *"Insert 1,414 documents"*; `btn-danger` styling for
  destructive (Replace / overwrite), `btn-success` for Insert.

## 6. Execution & performance

- **Pre-flight probe** (Update/Replace only). One batched aggregation per key
  batch (≈1000 keys/call), cancellable:
  ```
  [ { $match: { <syntheticKey> ∈ batch } },
    { $group: { _id: <syntheticKey>, ids: { $push: "$_id" }, count: { $sum: 1 } } } ]
  ```
  Returns, for each file key: matched (count = 1, with the `_id`), ambiguous
  (count > 1 → block), or absent (new). **Single-field** keys match directly
  (`{ field: { $in: [...] } }`); **composite** keys use a stable synthetic
  serialization (`$concat` of stringified key fields with a separator, matched
  against the same serialization computed client-side) so `$in` works over
  tuples. This one query yields the matched/new split, the key→`_id` map, and the
  uniqueness check together.
- **Insert path** — `runChunkedInsert` (batched, ordered:false, continue-past-
  failure; existing).
- **`_id`-keyed Replace / overwrite** — `runChunkedOverwrite` (batched
  delete+insert; existing, fast).
- **Arbitrary-key Update / Replace** — inherently **per-row** `update_one` /
  `replace_one`, filtered by the matched `_id` from the probe. Run through a
  **concurrency worker pool** (the sliding-window pattern already proven in
  `downloadCollection.js`: N workers pull the next row from a shared counter),
  with chunked progress + cancel. `bulk_write` is **not** used.
- **Upsert** — the plan split routes matched rows to the update/replace executor
  and unmatched rows to `runChunkedInsert`. Counts are summed for the DONE
  summary.

**Performance honesty:** per-row update/replace of a large file is O(rows)
round-trips (mitigated by concurrency, not eliminated). The UI surfaces this via
live progress + cancel. Re-imports keyed on `_id` use the batched fast path. This
matches expected MDH master-data scale (thousands–tens-of-thousands of rows).

## 7. Architecture / modules

New / changed under `src/mdh/`:

- **`formats/` registry** (new) — one module per format exporting
  `{ id, label, accept, parse(input, opts) → { docs, columns, warnings, error },
  ConfigureControls, defaultOpts }`. Wraps the existing `csv.js`, `xlsx.js`,
  `xml.js`, `ndjson.js`, and `JSON.parse`. This is what removes the per-format
  wizard duplication.
- **`components/ImportWizard.jsx`** (new, single) — owns the stage machine; takes
  a `format` prop (preselected from the menu); renders the format's
  `ConfigureControls` in CONFIGURE then the shared CONFIRM / IMPORTING / DONE.
- **`importPlan.js`** (new, pure, unit-tested) — local analysis (in-file
  duplicate keys, rows missing key fields), the synthetic-key serializer +
  probe-pipeline builder, and the plan computation (matched / new / ambiguous /
  blocked) from probe results.
- **`runImport.js`** (new) — the mode executor: concurrency pool for
  arbitrary-key update/replace; delegates to `runChunkedInsert` /
  `runChunkedOverwrite` for insert and `_id`-keyed paths; emits progress; honors
  an `AbortSignal`.
- **`importFile.js`** (reused, unchanged signatures) — `runChunkedInsert`,
  `runChunkedOverwrite`, `dedupeById`, `analyzeDocs`, `normalizeDocId`,
  `stableKey`, `findExistingIds`.
- **`components/ImportStages.jsx`** — evolve the shared CONFIRM/IMPORTING/DONE to
  cover all modes (mode selector, match-key picker, plan line, mode-aware
  summary). PICK stays per-format-trivial (driven by registry `accept`).
- **`api.js`** — add an `options` passthrough to `updateOne` / `replaceOne` (so a
  future native-upsert optimization is one line away) — *additive, defaulted to
  omitted, so existing callers are unaffected*.

**Deleted / retired:**

- `components/InsertFileWizard.jsx`, `components/CsvImportWizard.jsx`,
  `components/XlsxImportWizard.jsx`, `components/XmlImportWizard.jsx`.
- The dead `UpdatePanel` / `ReplacePanel` (+ `FileInput`, `MatchFields`,
  `getSelectedMatchFields`) in `components/DataOperations.jsx`; `openDataOperations`
  is simplified to dispatch the inline insert + the unified wizard.

**Toolbar / dispatch:**

- `RecordList.jsx`: the `Insert ▾` split button becomes **`Import ▾`**; the menu
  lists the formats (`From JSON / CSV / Excel / XML / JSONL…`). The inline insert
  stays available (e.g. as the split button's main action or a menu entry).
- `DataPanel.jsx`: the `insert*` action strings are rerouted to open
  `ImportWizard` with the right format + Insert default, so no dispatch is
  orphaned. (Reusing the existing `invalidateAndRun` / `currentFields` callbacks.)

## 8. Backward compatibility

- Pure primitives in `importFile.js` keep their signatures ⇒ their unit tests
  stay green; `runChunkedOverwrite` keeps exact legacy "overwrite" behavior.
- Format parsers (`csv.js` / `xlsx.js` / `xml.js` / `ndjson.js`) are untouched ⇒
  their tests stay green.
- The 4 wizard component test files are replaced by tests for `ImportWizard`;
  their format-specific assertions (CSV dialect, Excel sheet, XML record element)
  are re-pointed at the registry-driven CONFIGURE stage.
- New `api.js` `options` argument is optional ⇒ all existing call sites unchanged.
- No storage-key changes required. (If we later persist "last import mode/keys"
  it would be a new key; out of scope for v1.)

## 9. Testing strategy

- **Pure unit tests** (no DOM): `importPlan.js` — in-file dup detection, missing-
  key rows, synthetic composite-key serialization, plan computation across the
  match/no-match × upsert matrix, ambiguity/block detection. `runImport.js` —
  with a mocked `api`, assert the correct primitive is called per mode
  (`update_one` by `_id` / `replace_one` by `_id` / `runChunkedInsert` /
  `runChunkedOverwrite`), `$set` excludes keys + `_id`, upsert routing, abort
  mid-run, partial-failure accounting.
- **Component tests** (`h()` + `vi.mock`, per repo convention): `ImportWizard`
  stage transitions; mode switch re-runs the plan; non-unique block disables the
  primary button; per-format CONFIGURE renders.
- Run the full suite in a loop to catch the known flaky fixed-timeout pattern;
  use condition-based `waitFor`, not sleeps.

## 10. Open items to verify live before relying on them (each has a safe fallback)

These are explicitly **not** in the committed baseline — the baseline works
without them. They will be probed on a **throwaway scratch collection** (never on
customer data) and adopted only if they prove reliable.

1. **Native single-op `options.upsert`** — reference says supported; the baseline
   emulates upsert and does **not** need it. Adopt only if a scratch test shows
   it reliable; otherwise emulation stands.
2. **`$merge` server-side fast path** — could turn arbitrary-key update/replace
   into a single fast server-side op, but DocumentDB-backed stores frequently
   lack `$merge` / `$out`. **Unverified ⇒ excluded from the baseline.** Per-row
   concurrency is the committed path; `$merge` is a possible later optimization
   only if a scratch probe confirms support.

## 11. Risks

- **Per-row throughput** on very large arbitrary-key imports — mitigated by the
  `_id` fast path, concurrency, progress + cancel, and the index warning. Not
  eliminated; surfaced honestly in the UI.
- **Composite-key serialization edge cases** (separator collisions, null/typed
  values) — handled by a typed, length-prefixed or escaped serialization, unit-
  tested against adversarial values.
- **Test churn** from retiring 4 wizards — contained: parser + primitive tests
  stay; only the wizard-shell tests are rewritten.
