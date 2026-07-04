# Import wizard: random-sample shape validation, whitespace detection, verbose action explanations

**Date:** 2026-07-03
**Status:** awaiting user review
**Scope:** MDH Import wizard (`src/mdh/components/ImportWizard.jsx`, `ImportConfirm.jsx`, `src/mdh/shape.js`, `src/mdh/matchEstimate.js`, `SpecialText.jsx`/`specialChars.js`, tests)

## Goals (user request, 2026-07-03)

1. Validate the incoming dataset's shape against a **random sample** of the existing collection (today: the first 500 records).
2. Make shape validation **detect leading/trailing whitespace differences** in column names — and make the difference *visible* to the user.
3. **Remove the update-change-count estimate**; instead **explain verbosely** what each Insert / Update / Replace action will do, so users are confident and understand the outcome. No assumptions — every claim verified.

Approach approved in conversation: explicit whitespace pairing + always-visible step list + exact
match-key guard. (The guard was offered as an optional add-on; the user was away for that final
confirmation, so it is included per the recommended option — trivially removable at review.)

## Verified fact base

Every behavioral claim in this design traces to one of these. "Probe" = live verification on the
user's test org (elis.rossum.ai) on 2026-07-03, scratch datasets created and deleted the same run.

| # | Fact | Source |
|---|------|--------|
| F1 | `$sample` aggregation works on Data Storage | probe (`[{$sample:{size:2}},{$count:"n"}]` → ok) + shipped usage in `prefetch.js:63`, `DataPanel.jsx:145` |
| F2 | Update (data-matching `PATCH`, `update_or_new=true`): a matched record is **fully overwritten** by the row (omitted fields dropped), keeps its `_id`; unmatched rows are inserted | probe 2026-07-01 (memory) + re-confirmed by probe 2026-07-03 |
| F3 | A file row **missing a match key** fails the **whole operation**: `CLIENT_ERROR "ID key 'sku' not found in the updated element"`; collection unchanged | probe |
| F4 | If **several existing records share one key value**, PATCH updates **only one** of them; the rest stay; no error. Which one is unspecified | probe |
| F5 | A row with a **`null` key value** is processed normally (inserted when nothing matches) | probe |
| F6 | **Dotted nested match keys work** (`id_keys=sku.code` matched a nested value, upserted the rest) | probe |
| F7 | `id_keys=_id` **fails the whole operation** (`"batch op errors occurred"`) when rows carry the EJSON `{"$oid":…}` `_id` our JSON export produces; nothing applied | probe |
| F8 | Rows that merely **contain** an EJSON `_id` fail **both** PATCH-by-business-key **and** PUT Replace the same way; nothing applied | probe |
| F9 | Replace (`PUT`) wipes the dataset and loads the file; **custom indexes survive**; `_id` cannot be set via upload (server-assigned) | probe 2026-07-01/-02 (memory) |
| F10 | Server ops take ~30–60 s even for tiny files; submitted ops cannot be recalled (wizard cancel only stops watching) | probe timings + `ImportWizard.jsx` abort comment |
| F11 | Insert path: Data Storage `insert_many`, **unordered** batches of 1000 — a duplicate-`_id` row is rejected individually, the rest of its batch still inserts; failures reported per batch with landed-count probe. File-internal `_id` dupes: first occurrence kept (`dedupeById`). Data Storage **does** round-trip `_id`/EJSON on insert | code: `importFile.js` (`runChunkedInsert`, `dedupeById`, pymongo-unordered comment); memory: Data Storage parses EJSON on input |
| F12 | Shape check compares exact dotted-path strings, so whitespace-differing names already *mismatch* — they just render indistinguishably. `_id`/`__digest_md5` excluded from shape | code: `shape.js` |
| F13 | CSV headers are always trimmed at parse; XLSX headers and JSON/JSONL keys are verbatim; XML element names cannot contain spaces | code: `csv.js:142-155`, `xlsx.js:37`; XML spec |
| F14 | `String.prototype.trim()` also strips NBSP/TAB/FEFF etc., so segment-trim pairing catches those edge characters too; `specialChars.js` deliberately treats U+0020 as never-special | code + JS spec |

## Design

### 1. Random-sample shape reference

In `ImportWizard.jsx`'s confirm-stage effect, replace

```js
api.find(selectedCollection.value, { limit: 500 })
```

with

```js
api.aggregate(selectedCollection.value, [{ $sample: { size: SHAPE_SAMPLE } }])   // SHAPE_SAMPLE = 500
  .catch(() => api.find(selectedCollection.value, { limit: SHAPE_SAMPLE }))
```

- Same `{result: []}` handling; empty result → `shape = null` → "nothing to validate against" (unchanged).
- The fallback preserves today's exact behavior if `$sample` is ever unavailable, so turning this on can never *lose* validation coverage (F1 says it won't be needed, but the fallback is cheap).
- The shape section shows the real sample size: `Compared against a random sample of {n} records.` (n = returned count; for collections ≤500 that is effectively the whole collection).
- `$sample` may return the occasional duplicate document; harmless for shape derivation.

### 2. Whitespace-only mismatch pairing (`shape.js`)

`validateAgainstShape` gains a post-pass and a new result list:

- `normalizePath(path)` = split on `.`, `trim()` each segment, re-join.
- Any `unknown` path *u* and `missing` path *m* with `normalizePath(u) === normalizePath(m)` (and `u !== m`) are removed from those lists and emitted as `whitespace: [{ expected: m, got: u }]`.
- Multiple file variants of one existing field (e.g. `"name "` and `" name"` vs `"name"`) each pair to the same `expected`.
- `ok` is false when `whitespace.length > 0` (these were blocking before as generic mismatches; they stay blocking, now explained). `failedDocCount` semantics unchanged.
- Per F14, `trim()` pairing catches ordinary spaces AND NBSP/TAB/FEFF-style edge characters; per F13 the file side can only carry these via JSON/JSONL/XLSX/clipboard, while the DB side always can (CSV-trim is unchanged and now *explained* by pairing when the DB field itself has edge whitespace).

### 3. Visible whitespace rendering (`SpecialText.jsx` + `ImportConfirm.jsx`)

- `SpecialText` gets a `markEdgeSpaces` prop: leading/trailing runs of ordinary spaces (U+0020) render as the existing marker chip (class `mdh-special mdh-special-space`, label `·`, title `U+0020 SPACE`). Interior U+0020 stays a plain space; all other special characters keep their existing markers. A clean string renders byte-identical.
- Every field name in the shape-error block (Missing / Unexpected / Wrong type / new Whitespace list) renders via `SpecialText` with `quote` + `markEdgeSpaces`, so `"name·"` vs `"name"` is visibly different everywhere.
- New Whitespace list item copy: `Whitespace: "name·" (file) vs "name" (existing) — the names differ only by leading/trailing whitespace.`

### 4. Remove the match estimate

Delete: `src/mdh/matchEstimate.js`, `tests/mdh-match-estimate.test.js`, the wizard's `estimate`/`estimateLoading` state + debounced effect + props, `ImportConfirm`'s `import-estimate` block and its tests, `.import-estimate` CSS (3 rules).
Keep: `stableKey` stays in `importFile.js` (other users). A dotted-path presence helper (the ex-`resolvePath`) moves to `importPlan.js` for the key guard (§6).
Justification beyond the request: F3 proves the estimate's core assumption ("unmatched-key rows insert as new") was wrong — it reported a "will insert" count for rows that actually fail the whole operation.

### 5. Verbose "What will happen" step list (`ImportConfirm.jsx`)

Replaces both the one-line `import-summary` text and the estimate block, always visible, per mode.
Every line maps to a fact (annotated here; annotations don't ship).

**Insert** (client-side Data Storage `insert_many` — F11):
- Every row is added as a new record. Existing records are never modified.
- Rows keep their `_id` if they have one; rows without one get a server-assigned id. If several rows in the file share an `_id`, the first is kept and the rest are dropped before upload.
- A row whose `_id` already exists in the collection is rejected by the server; the other rows still import, and every rejection is reported at the end.
- Runs from this browser in batches of 1,000 — cancelling keeps the rows already inserted.

**Update** (server-side upsert — F2–F8, F10):
- Each row is matched to existing records by `<keys>`.
- A matched record is **replaced by the row entirely** — fields the row doesn't include are removed. The record keeps its `_id`.
- If several existing records share the same key value, only **one** of them is updated (which one is not guaranteed).
- Rows that match nothing are **inserted** as new records.
- Existing records not matched by any row are left untouched.
- `_id` values in the file are ignored — records are identified only by the match keys, never by `_id`. A re-imported export can't be matched by `_id`; pick a business key instead. (F7/F8; see §7)
- Runs on the Rossum server as a single operation (typically 30–60 s, even for small files). Once started it can't be recalled or undone.

**Replace** (server-side — F9, F10):
- Deletes **every existing record**, then loads this file as the collection's entire new contents.
- Custom indexes are kept. `_id` values in the file are ignored — the server assigns fresh ids, so record ids from an export are not preserved.
- Runs on the Rossum server (typically 30–60 s). Once started it can't be recalled or undone.

Implementation: rendered directly in `ImportConfirm.jsx` (matching how `import-summary` works today; component tests cover it). Styling: new `.import-steps` built on the `.import-summary` look (heading + `ul`).

### 6. Exact match-key guard (Update mode)

Because one keyless row fails the entire server operation (F3):

- `countRowsMissingKeys(docs, keys)` in `importPlan.js` — dotted-aware own-property presence walk (no array traversal), `null` counts as **present** (F5). Pure, `useMemo`'d.
- If count > 0: the Upsert button is disabled and a blocking error shows the **exact** count:
  `N rows are missing <key> — the server rejects the whole import if any row lacks a match key. Fix the file or pick different keys.`
- This is a certainty check derived from a verified failure mode — not an estimate; no server round-trip.

### 7. `_id` handling fix (verification-discovered bug)

Today the wizard uploads parsed rows verbatim and auto-defaults the match key to `_id` whenever
every row has one — the standard JSON-export re-import. F7/F8 prove both halves fail server-side.

- `startImport` strips `_id` from every row for **Update and Replace** uploads (upload copy only; parsed docs held in wizard state are untouched). Insert is untouched (F11: Data Storage round-trips `_id`).
- `MatchKeyPicker` no longer offers `_id` in Update mode; `defaultKeysFor` is removed — match keys start empty and the existing "Select at least one match field" hint prompts a choice.
- The step-list lines in §5 state this plainly.

### 8. Error handling

- `$sample` failure → `find` fallback (§1); both failing → `shape = null`, validation reports "nothing to validate against" (same as today's catch).
- All confirm-stage effects keep their alive-guards/stale-guards; no new async paths besides the aggregate call.
- Key guard and whitespace pairing are pure synchronous computations — no failure modes beyond render.

### 9. Backward compatibility

- `mdhImportValidateShape` storage key, toggle, and hydration: unchanged.
- Empty/new collection: validation still skipped, same copy.
- Whitespace mismatches blocked imports before (as unexplained generic mismatches) and still block — no import that succeeded before is newly rejected by §2/§3.
- The key guard (§6) and `_id` stripping (§7) change behavior **only** for imports that are verified to fail server-side today (F3, F7, F8) — they convert guaranteed failures into a clear pre-flight block or a working import. The lost `_id` auto-default is deliberate: it defaulted into F7's failure.
- `$sample` fallback (§1) preserves the previous sampling behavior wherever aggregation is unavailable.
- No storage-key, manifest, or API-surface changes. CSV header trimming (F13) unchanged.

### 10. Testing

- `mdh-shape.test.js`: pairing — trailing, leading, both-sides-differ, NBSP/TAB edges, nested segment (`a. b` vs `a.b`), multiple variants of one field, pure-rename non-pair (stays missing+unknown), `ok=false` with whitespace-only findings, generic lists exclude paired paths.
- `mdh-import-confirm.test.js`: estimate tests removed; step list renders per mode (incl. `<keys>` interpolation); whitespace list + visible markers; key-guard blocks button with exact count; `_id` absent from Update key picker.
- `mdh-import-wizard.test.js`: confirm-stage shape fetch uses `$sample` and falls back to `find` on rejection; upload blob for update/replace contains no `_id`; estimate effect gone.
- `mdh-special-text.test.js` (or equivalent): `markEdgeSpaces` — leading/trailing runs marked, interior spaces plain, clean string byte-identical.
- Delete `tests/mdh-match-estimate.test.js`; grep sweep for `estimateMatches`/`import-estimate`/`defaultKeysFor`.
- Full suite + `npm run build` green before claiming done (per project practice: dist rebuild required for browser verification).

### Out of scope

- Server-side write-lock / read-only guarantees (tracked elsewhere).
- CSV header-trim policy change (kept as-is; §2 explains DB-side whitespace to CSV importers).
- Whether Update matches an existing `null` key value against a file `null` (unverified; nothing in the UI claims it).
- Any customer names or customer data in code, tests, spec, or copy — probe artifacts used generic fields (`sku`, `name`, `val`) on the user's own test org and all scratch datasets were deleted.

## Probe log locations (session-local, not committed)

Scratchpad `edge-probe.log`, `nested-key-probe.log`, `id-key-probe2.log`, `id-body-probe.log` —
session scratchpad only; findings are fully captured in the fact table above.

## Addendum 2026-07-04 — verification battery + message redesign

A 9-case live battery (owner's elis test org, scratch datasets `zzz-claude-bat-*`, deleted) extended the fact table:

| # | Fact | Consequence |
|---|------|-------------|
| F15 | `$sample {size: 500}` on a smaller collection returns ALL its docs | "all N existing records" phrasing is exact when returned < requested |
| F16 | Data Storage `insert_many` (unordered): a duplicate-`_id` row is rejected individually, other rows in the batch land, existing record NOT modified | Insert step-list lines verified live |
| F17 | A MIXED PATCH file (good match + missing-key row + new row) fails ATOMICALLY — nothing applied | Key-guard copy ("rejects the whole import") verified beyond single-row files |
| F18 | Composite `id_keys` (`sku`+`region`) work: exact-tuple match overwrites, near-miss tuples insert — i.e. **AND** semantics (a row matching only some keys matched nothing and was inserted, ruling out OR) | "matched by <k1, k2>" copy verified; 2026-07-04c: multi-key step-list line now states "all of them must match at once (AND, not OR)" |
| F19 | A `null` key value MATCHES an existing record with `null` in that key (in-place overwrite, `_id` kept) | consistent with guard's null-is-present |
| F20 | Nested `{"$oid"}` in a NON-`_id` field is accepted and round-trips | closes the §Out-of-scope residual — `_id` is the only toxic carrier |
| F21 | An uploaded `__digest_md5` is stored VERBATIM (never recomputed); PUT replace re-verified to preserve custom indexes | `stripServerFields` (ex-`stripIds`) now strips `__digest_md5` too; step-list `_id` lines mention it |

UI change in the same pass (user feedback): the shape-validation result is now a clearly-green
`.import-ok` panel ("Shape matches." + sample note inside) vs the existing red `.import-error`
panel (sample note inside, muted); loading/empty states use `.import-shape-neutral` — the old
line reused `.input-hint`, which is danger-red by default, making success look like an error.
The sample note says "all N existing records" when the sample exhausted the collection
(returned < requested, F15) and "a random sample of N" otherwise (`shapeCoversAll` prop).

## Addendum 2026-07-04b — back navigation

User request: fixing a wrong parsing setup required closing the modal and starting over. Added:
- Confirm gains "← Back" (left-aligned): → Configure for formats with parsing options (CSV/Excel/XML
  via file; user-tweaked dialect options preserved, no re-detection), → Pick otherwise (JSON/JSONL
  file cleared for re-pick; clipboard text RESTORED into the editor — new `clipboardText` state,
  editor re-seeds on remount).
- Configure gains "← Back" → Pick (choose a different file).
- Import mode persists across a round-trip; match keys reset (re-parsed columns may differ);
  Importing/Done unchanged. `ImportConfirm` takes an optional `onBack`; wizard adds
  `resetFileInput`/`configureBack`/`confirmBack`.
- Wizard tests now stub JsonEditor with a seed-only textarea (same value/editorRef contract as the
  real editable editor) so the clipboard round-trip is drivable under jsdom.

## Addendum 2026-07-04d — shape-validation toggle no longer persisted

Owner decision: "Validate shape against existing records" must always be ON when the wizard opens.
Removed `mdhImportValidateShape` chrome.storage persistence + the `globalThis.__mdhValidateShape`
cache + the mount-time hydration; `validateShape` is plain `useState(true)`. Turning it off now
applies to the current import only. The legacy storage key is orphaned (repo precedent), not read.
Locked by a two-wizard test (off in wizard #1 → fresh wizard #2 starts ON — previously leaked
through the globalThis cache).
