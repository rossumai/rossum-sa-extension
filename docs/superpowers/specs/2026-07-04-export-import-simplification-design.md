# Export/Import wizard simplification — design

Date: 2026-07-04 (refined 2026-07-07)
Status: delivered (uncommitted → committed 2026-07-07). This document describes
the **final delivered** design; a follow-up refinement pass (2026-07-07) is folded
into the sections below and summarized in the changelog.

## Changelog

- **2026-07-04** — original design (sections below), implemented across a 7-task
  plan (`docs/superpowers/plans/2026-07-04-export-import-simplification.md`).
- **2026-07-07** — refinement pass, per owner feedback:
  1. The picked-file line (name · size · rows · columns) moved out of the Decide
     body **into the modal title** (frees body space).
  2. Parsing options are **shown inline by default** on the Decide screen — the
     one-line summary + `Change ▾` disclosure were removed, and with them the
     now-dead `summarizeOpts` format-descriptor helper.
  3. The shape-mismatch override became an **acknowledgement checkbox inside the
     error card**; ticking it enables import but the **full error card stays
     visible** (the collapse-to-one-line "overridden" state was removed).
  4. The tabular import preview shows the **first 5 rows** (was 10), matching the
     JSON preview.

## Problem

Both MDH wizards are busy and text-heavy. The Export modal stacks seven vertical
zones, three of them prose (count line, filename line, a 5–6-bullet always-visible
"What will happen" block, ~90 words). The Import wizard's Confirm screen stacks six
zones, including a shape-validation toggle with an always-rendered result panel and
a mode-specific "What will happen" block (Update: 7 bullets, ~150 words). CSV/Excel/
XML files pay an extra Configure step, while JSON imports are confirmed with no data
preview at all.

The verbose copy was deliberate ("verified verbose confirm", commit 8cbde29) — every
bullet states live-verified semantics. The simplification must keep every verified
fact reachable, just not shoved at the user by default.

## Owner decisions (asked, not assumed)

1. "What will happen" blocks → **one dynamic summary sentence + collapsed
   `Details ▾` expander** holding the full verified bullets verbatim.
2. **Flow restructuring allowed** — Configure may merge into Confirm.
3. Shape check → **silent pass, loud fail**: toggle removed, check always runs,
   pass is one muted line, mismatch keeps the error card with an "Import anyway"
   override inside it.
4. Overall shape: **Approach A — one decision screen** for import; export keeps its
   single screen with its three text zones merged into one summary + Details.

## Non-goals

- No changes to import/export semantics, guards, or the download/import engines
  (`downloadCollection.js`, `runChunkedInsert`, `datasetUpdate`/`datasetReplace`,
  `waitForDatasetOperation`).
- No changes to the Bulk operations modals (BulkUpdate/BulkDelete/BulkConfirm) —
  out of scope.
- No new persisted state; no storage-key migrations.

## Import wizard

Flow: `PICK → DECIDE → IMPORTING → DONE` (CONFIGURE stage removed; its controls
move into DECIDE).

### Pick screen

- `File | Clipboard` segmented unchanged.
- The redundant label "Drop a file or click to choose:" is deleted; the drop area's
  own label becomes "Drop a file here or click to choose" (+ existing format line).
- Clipboard label tightens to "Paste JSON — array, object, or JSON-lines".
- Picking a parseable file goes straight to DECIDE for every format (today only
  JSON/JSONL skip Configure).

### Decide screen — zones

0. **Modal title** (not a body zone): the picked file's identity — filename
   (emphasized) + `size · rows · columns` — is surfaced in the modal **header**
   via a guarded `setModalTitle` (Modal.jsx) that the wizard drives from an
   effect keyed on the file/parse state. Reverts to `Import` before a file is
   chosen and after Back. Columns appear only for column formats; clipboard reads
   `Pasted data · N rows`. (Original design placed this as an in-body "source
   strip"; the 2026-07-07 refinement moved it to the title to free body space.)
1. **Parsing options** (only when the format has `ConfigureControls` —
   CSV/Excel/XML): the existing `ConfigureControls` are rendered **inline and
   expanded by default** in a `.parse-strip` wrapper (CSV's Advanced stays
   nested). No summary line and no `Change ▾` disclosure — the controls
   themselves show the current state, so the `summarizeOpts` helper was removed.
   Any option change re-parses (race-guarded `parseToken` effect on DECIDE) and
   resets match keys + the shape override (column sets can change).
2. **Preview**:
   - Column formats: existing `CsvPreview` (caption + type legend), capped at the
     **first 5 rows** (was 10).
   - JSON/JSONL (parse returns `columns: []`): compact `<pre>` of the first
     5 docs, single-line `JSON.stringify` each. Strict improvement — the old
     confirm screen had no data preview.
3. **Mode + keys**: `Insert | Update | Replace` segmented and `MatchKeyPicker`
   unchanged. The red "Select at least one match field." hint is deleted — the
   summary sentence carries that state.
4. **Summary + Details** (shared `PlanSummary` component; replaces the
   "What will happen" block):
   - Insert: `Adds 1,240 new records — existing records are never modified.`
     Append `(3 duplicate _id rows dropped)` only when dedupe actually drops rows.
   - Update, no keys: `Pick one or more fields above to match existing records
     by.` (Go disabled.)
   - Update, keys chosen: `Upserts 1,240 rows matched by sku — matched records
     are replaced whole, unmatched rows are inserted. Runs on the server; can't
     be undone.` Multi-key: `matched by sku + warehouse (all must match)`.
   - Replace: `Deletes every existing record, then loads these 1,240 rows as the
     collection's new contents. Can't be undone.`
   - `Details ▾` expands to the existing per-mode verified bullets **verbatim**
     (AND-match, whole-row replace, one-of-duplicates, `_id`/`__digest_md5`
     ignored, batching, cancel semantics, 30–60 s). Collapsed on every open.
   - The missing-key guard stays a conditional one-sentence red alert (rare,
     blocking, earns its visibility).
5. **Shape line — silent pass, loud fail** (toggle row deleted; the `$sample`
   fetch + `validateAgainstShape` run exactly as today):
   - Running: muted `Checking shape…`.
   - Pass: muted `✓ Shape matches · checked against a 500-record random sample`
     (or `· all 213 existing records` when the sample exhausted the collection).
   - Empty/new collection: nothing on the main screen; "no existing records to
     compare against — shape check skipped" noted inside Details.
   - Sample fetch failed entirely: nothing on the main screen; "shape check
     unavailable" noted inside Details.
   - Fail: the error card (field lists, whitespace markers, sample note) carries
     an **acknowledgement checkbox** — `Import anyway — I've reviewed the mismatch
     above.`. Ticking it enables Go, and the **full error card stays visible**
     (the 2026-07-07 refinement replaced the earlier "Import anyway" link +
     collapse-to-one-line "overridden · Undo" state — the error must not be
     hidden once acknowledged).
   - The uniformity ("may over-reject") caveat appears only inside the fail card.
   - Internal state: `shapeOverride` boolean (default false), never persisted.
     The legacy orphaned `mdhImportValidateShape` key stays orphaned.

Gating is unchanged: Go disabled on no-docs / update-without-keys /
missing-key rows / unresolved shape mismatch. Shape loading never blocks Go
(today's behavior, kept).

### Importing / Done

Structure unchanged. The heartbeat hint shortens to:
`Typically 30–60 s. You can close this — the outcome appears in Operation Logs.`

## Export modal

Top half untouched: Scope segmented with live counts, Format segmented, per-format
options strip, 10-row preview, and all mechanics (count fetching, column-discovery
caching, aborts). The conditional filter-unavailable reason line stays.

Bottom half: the count/filename line + "What will happen" block + inline
large-export warning merge into one `PlanSummary`:

- Count known: `Exports 51,204 records to customers.json — streamed to the file
  you pick; the collection is never modified.` Append `Large export — may take a
  while.` only when > 10,000.
- Counting: `Counting documents…` (unchanged).
- Count failed: `Exports to customers.json — streamed to the file you pick;
  read-only.`
- `Details ▾`: existing bullets verbatim — scope semantics (pipeline ignored vs.
  paging stages stripped), 1,000-record batches ×10 parallel, stable ordering,
  column-union rule (CSV/Excel only), cancel-discards-partial-file, read-only.

Download button label unchanged (`Download 51,204 records · JSON`).

## Shared component

`src/mdh/components/PlanSummary.jsx`: props `{ summary, summaryTestid, children }`
(children = the bullet `<ul>`). Renders the sentence with a right-aligned
`Details ▾ / Hide ▴` text button; expanded content reuses the existing
`.import-steps` CSS so bullets render exactly as today. Local `useState`,
collapsed on mount, no persistence. The `.import-steps-head` "What will happen"
heading is retired.

`Modal.jsx` gains `setModalTitle(title)` — a guarded no-op when no modal is open —
used by the import wizard to surface the picked file in the header (zone 0).

## Edge cases

- **Parse error after an opts change on DECIDE**: preview shows the existing
  parse-error box; summary sentence and shape line hide; Go disables (existing
  `!parsed || parsed.error || !docs.length` gate).
- **Opts change → column set changes**: keys reset on every opts-triggered
  re-parse; shape check re-derives automatically.
- **Clipboard**: no parsing strip; Back from DECIDE restores typed text
  (existing behavior).
- **Cancel mid-server-operation**: unchanged neutral cancelled summary.

## Backward compatibility

- **Storage**: zero changes — no keys added, removed, renamed, or migrated.
- **Engine contracts**: `onExport` config `{scope, formatId, opts, columns,
  count}`, `buildExportJob`, and all import API call shapes unchanged.
- **Semantics**: identical guards; shape override ≡ today's toggle-off; dedupe,
  missing-key guard, `_id`/`__digest_md5` stripping unchanged.
- **Honest delta**: the shape check now always computes (client-side, in-memory
  data) — previously a user could pre-emptively disable it. The gate remains
  bypassable per-mismatch via Import anyway.
- **Tests reference removed testids** (`shape-toggle`, `configure-back`,
  `import-next`): updated alongside — internal only, no user-facing impact.

## Testing

- Update existing `ImportWizard`/`ImportConfirm`/`ExportWizard` suites for the
  merged flow (`.test.js` + `h()` convention, no raw JSX).
- New coverage: summary sentence per mode/state; Details expander; shape
  silent-pass/loud-fail states; the shape acknowledgement checkbox keeps the
  error card visible while enabling Go; parsing options visible by default;
  the picked file surfaced in the modal title (integration test through `Modal`);
  key reset on re-parse; JSON `<pre>` preview; 5-row tabular preview.
- `npm run build` + full `npm test`; the loaded extension runs `dist/`, so the
  extension must be rebuilt and reloaded before browser verification.

## Copy rules applied throughout

- One sentence states outcome + risk; mechanics live in Details.
- Conditional truths render only when true (dupes dropped, large export,
  uniformity caveat, missing-key guard).
- No customer names or customer data in copy, examples, or this spec —
  placeholder values only (`customers.csv`, `sku`, `Sheet1`, `item`).
