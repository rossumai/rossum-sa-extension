# Unified Export: one button, one modal

**Date:** 2026-07-04
**Status:** design approved in conversation ("go"); spec formalizes it
**Scope:** MDH export UX (`RecordList.jsx` toolbar, `DataPanel.jsx` handlers, new `ExportWizard.jsx` + `exportFormats.jsx`; deletes `DownloadSplitButton.jsx`, `CsvExportOptions.jsx`, `XlsxExportOptions.jsx`, `XmlExportOptions.jsx`). The streaming engine (`downloadCollection.js`) is UNTOUCHED.

## Goals (user request, 2026-07-04)

Mirror the import unification for downloads: today exports fan out through a hover menu into ten
paths with inconsistent flows (JSON/JSONL: no options, no preview; CSV/Excel/XML: three separate
options modals; a second ">10k" confirm popup appears after the options modal closed). Unify into
one Export button → one modal. User selections: scope copy "All records" / "Current filter";
parity + small improvements (JSON/JSONL previews, exact in-modal count replacing the confirm
popup, CSV BOM toggle); one-button entry (menu retired).

## Verified fact base

Code-verified in `DataPanel.jsx` (~lines 460–990), `downloadCollection.js`, the three
`*ExportOptions.jsx`, `DownloadSplitButton.jsx`, `RecordList.jsx:281`:

| # | Fact |
|---|------|
| E1 | Ten near-identical DataPanel handlers duplicate: filtered-pipeline parse (`substituteWithTypes` → `JSON5.parse` → array check → `stripPaginationStages`), cancellable `$count` pre-fetch, a `confirmModal` gate at >10,000 docs, and a `runDownloadJob` call with a per-format serializer. |
| E2 | JSON/JSONL download with no options/preview; CSV/Excel/XML open separate modals whose preview scaffolding (loading/error/empty states, caption) is copy-pasted; CSV+Excel preview columns via `buildColumnDiscoveryPipeline` + `orderExportColumns(records.value, keys)`, XML previews sample only. |
| E3 | The filtered >10k confirm appears AFTER the options modal closed (modal-after-modal); the count is fetched between the user's Download click and the file picker. |
| E4 | `downloadCollection` opens the save picker as the FIRST await after the user gesture by design (comment at line 112); a count await before it (E3) races the browser's user-activation window — moving the count before the click strictly improves this. |
| E5 | Cancel semantics: `safeAbort(writer)` aborts the FS-Access writable → the partial file is DISCARDED (nothing saved); in Blob-fallback mode buffered parts are dropped and no download triggers. Picker-cancel (`AbortError`) returns `{cancelled, streamed:false}` quietly. |
| E6 | No-picker browsers (or permission denied) fall back to an in-memory Blob downloaded at the end. |
| E7 | Streaming: 1,000-doc batches, 10 parallel workers, in-order flush, backpressure; a stable `{$sort:{_id:1}}` is appended unless the caller's pipeline already ends with `$sort`. |
| E8 | CSV serializer supports `bom` (default true in the factory) but the UI hardcodes `bom: false`; there is no user-facing BOM option today. |
| E9 | Serializer factories: `buildJsonSerializer` (default), `buildNdjsonSerializer`, `buildCsvSerializer({dialect, header, bom, columns})`, `buildXmlSerializer({rootName, recordName})`, `buildXlsxSerializer({sheetName, header, columns})` (binary protocol). Filenames: `col.<ext>` / `col-filtered.<ext>`. |
| E10 | Beta badges are inconsistent: menu entries JSONL/CSV/Excel/XML + inside Excel/XML modals, absent in the CSV modal. |
| E11 | Export progress/cancel UI lives in the RecordList toolbar (`downloadState`), fed by DataPanel's single `runDownloadJob`; options modals close before the job starts. |
| E12 | Nothing export-related is persisted in any storage (grep: no export keys in chrome.storage/sessionStorage). |
| E13 | An empty/default pipeline makes "filtered" identical to "all" (the parse produces `[{$match:{}}]`-equivalent stages after `stripPaginationStages`). |

## Design

### 1. Entry point

`RecordList` toolbar: replace `<DownloadSplitButton …>` (10 callback props) with one button —
`<button class="btn btn-sm" data-testid="export-open">Export</button>` — next to Import, wired
through the existing `onRefresh('export')` action channel. DataPanel's `handleToolbarAction`
collapses the ten `download-*` cases to one `export` case → `openExport()`. The toolbar
progress bar + cancel (E11) is unchanged. Delete `DownloadSplitButton.jsx` + its test file
(`tests/mdh-download-dropdown.test.js`).

### 2. `openExport()` (DataPanel)

Parses the editor pipeline ONCE using the exact E1 sequence inside a try/catch. Precise rules:
- parse error → `filterState = { stages: null, available: false, reason: <error message> }`
- parses but `stages.length === 0` after `stripPaginationStages` → `{ stages: null, available: false, reason: 'No filter is active — the pipeline is empty.' }` (E13)
- otherwise → `{ stages, available: true }`

Scope preselection (§4.1): `Current filter` when `available` AND the stages are not the trivial
match-all (`stages.length === 1 && JSON.stringify(stages[0]) === '{"$match":{}}'`); else
`All records`. Scope enum values: `'all' | 'filtered'`.

Then `openModal('Export <collection>', () => <ExportWizard …/>)` with props:
`collection`, `filterState`, `totalCount` (the pagination signal's current value or null),
`recordsSample` (current `records.value` for column ordering, E2), and `onExport(config)`.

### 3. `exportFormats.jsx` registry (new, mirrors import's `formats/`)

Five descriptors: `{ id, label, ext, defaultOpts, OptionsControls | null, buildSerializer(opts),
previewKind: 'text' | 'grid', buildPreviewText?(sample, columns, opts), needsColumns: bool }`.

- json: no options; preview = pretty-printed sample docs (the serializer's own `formatJsonDoc` shape); needsColumns false.
- jsonl: no options; preview = one compact JSON line per doc; needsColumns false.
- csv: options delimiter (,/;/Tab) + header toggle + NEW "Excel-compatible (BOM)" toggle default OFF (E8 — today's behavior preserved); preview = `csvHeader`/`csvRow` text; needsColumns true.
- xlsx: options sheet name + header toggle; preview = grid (`previewKind: 'grid'`, the existing table markup); needsColumns true.
- xml: options root + record element names; preview = the existing XML text assembly; needsColumns false (sample only, E2).

`buildSerializer` maps 1:1 onto the existing factories (E9) — no serializer changes.

### 4. `ExportWizard.jsx` (new, single screen)

Layout top-to-bottom:
1. **Scope** segmented: `All records` / `Current filter`. `Current filter` disabled when
   `!filterState.available`, with `filterState.reason` as a hint. Preselect `Current filter`
   when available, else `All records`.
2. **Format** segmented: JSON / JSON Lines / CSV / Excel / XML (registry order). Default JSON.
   No beta badges (E10 — inconsistent today; engine unchanged; flagged for owner veto).
3. **Options strip** — the selected format's `OptionsControls` (same `csv-toolbar` styling);
   nothing for JSON/JSONL.
4. **Preview** — one shared block (single loading/error/empty implementation replacing the three
   copy-pasted ones): fetches `[...scopeStages, {$limit: 10}]` sample plus, for `needsColumns`
   formats, `buildColumnDiscoveryPipeline(scopeStages)`, ordered via
   `orderExportColumns(recordsSample, keys)`. Re-fetches on scope change; re-renders locally on
   option change (as today, E2). Stale-guarded (import-wizard pattern).
5. **Count line** — on open and on scope change, fetch the exact count (cancellable):
   all-records uses `totalCount` when non-null (E1 parity) else `$count`; current-filter always
   `[...stages, {$count}]`. Renders:
   `Exports {n} documents to {filename} — streamed to a file you choose.`
   At >10,000 the line turns warning-styled (`.import-warn` family) and appends
   `Large export — this may take a while.` NO confirm popup (replaces E3's second modal; the
   always-visible exact count is the confirmation).
6. **What will happen** — reuses `.import-steps` styling; every line traces to E5–E9:
   - Downloads in 1,000-record batches (10 in parallel) and streams to the file you pick; if the browser can't stream, the file downloads normally when complete.
   - Records are exported in a stable order — your filter's final sort if it has one, otherwise by `_id`.
   - (csv/xlsx only) Columns are the union of fields across the exported records, in table order.
   - Cancelling discards the partial file — nothing is saved.
   - The export is read-only — the collection is never modified.
7. **Actions**: `[Cancel] [Download <FORMAT>]`. Download is ALWAYS enabled once the modal is
   open — the count is informational, never a gate. If the count hasn't resolved or failed, the
   line shows the filename only and the config carries `count: null`; `executeExport` then passes
   `fetchCount: async () => 0`, which the engine already tolerates (total clamps to 0 → the
   toolbar bar runs indeterminate).
   On click: `closeModal()` then `onExport({ scope, formatId, opts, columns, count })` — matching
   today's options modals (E11) and keeping the picker the first await after the gesture (E4;
   `fetchCount: async () => count` returns the cached number).

### 5. `executeExport(config)` (DataPanel)

One function replacing the ten: builds `filename = `${col}${scope === 'filtered' ? '-filtered' : ''}.${ext}``
(E9 convention preserved), `serializer = format.buildSerializer({...opts, columns})`, and calls the
existing `runDownloadJob({ pipelineStages, filename, filtered, fetchCount: async () => config.count,
serializer })`. `runDownloadJob` itself is unchanged. All ten `downloadAll*/downloadFiltered*`
functions are deleted.

### 6. Backward compatibility

- Serializers, engine, batch/concurrency, filenames, BOM-off default, stable-sort behavior, progress
  UI, picker-first invariant: all preserved (E4–E9).
- Removed interactions: the hover menu (replaced by the button), the >10k confirm popups (replaced
  by the always-visible exact count + inline warning). Both are UX-approved changes, not silent ones.
- No storage keys added or removed (E12); nothing persisted — every modal open starts from defaults
  (JSON / preselected scope), consistent with the validate-shape non-persistence decision.
- CSS: existing `.csv-toolbar`/`.csv-export-preview*` classes are reused by the wizard; classes used
  only by deleted components are removed with them.

### 7. Testing

- Registry: per-format descriptor unit tests (serializer factory mapping incl. BOM flag pass-through,
  ext, needsColumns, preview text builders).
- ExportWizard component tests (jsdom, `h()`): scope preselection from `filterState` (available →
  Current filter; unavailable → disabled with reason + All records); format switching swaps options
  strip + preview kind; count line (exact number, filename, >10k warning styling, count-error
  fallback keeps Download enabled); per-format "what will happen" lines (columns line only for
  csv/xlsx); `onExport` receives the exact config (scope/formatId/opts/columns/count); Cancel closes
  without calling it.
- DataPanel tests: `export` action opens the modal; `executeExport` builds correct filename +
  serializer per config (spy on runDownload call args); filtered stages passed through; parse-error
  pipeline → modal opens with Current filter disabled.
- Deletion sweep: zero references to `DownloadSplitButton|CsvExportOptions|XlsxExportOptions|XmlExportOptions|download-filtered-csv` etc.
- Existing `mdh-download-collection`/`mdh-csv-export`/`mdh-download-xlsx` engine tests: UNTOUCHED
  (engine unchanged). `mdh-csv-export-options`/`mdh-xlsx-export-options`/`mdh-download-dropdown`
  test files are deleted with their components.
- Full `npm test` + `npm run build`.

### Out of scope

- Column include/exclude picking (explicitly deferred by owner choice).
- Export-config persistence (deliberately none).
- Any serializer/engine change.
- No customer names/data anywhere in fixtures or copy (generic `sku`/`name`/`region`/`price`).

## Addendum 2026-07-04e — owner feedback after first use

1. **Scope default**: always `All records` (the first tab). The spec's original preselect-filtered
   heuristic is retired; `Current filter` stays one click away and still disables (with reason)
   when the pipeline doesn't parse / is empty / ends in a write stage.
2. **Scope-aware "What will happen"**: the list was identical for both scopes, which made the sort
   line inaccurate for All records ("your filter's final sort" with no filter). Now:
   - All records leads with "Every record in the collection is exported — the pipeline editor is
     ignored." and orders "by `_id`".
   - Current filter leads with "Only records matching the current pipeline are exported; trailing
     paging stages (`$skip`/`$limit`) are removed, so the whole result set is exported — not just
     the visible page." (grounded: `stripPaginationStages` strips only TRAILING $skip/$limit; a
     final `$sort` survives and the engine respects it, E7) and keeps the filter-sort line.

## Addendum 2026-07-04f — scope visibility (owner feedback)

Concern: the All-records/Current-filter choice was easy to overlook (unlabeled row, visually
identical to the format tabs, consequence only in small text). Chosen fix — make the numbers
carry the meaning:
- A "Scope" field label (parity with "Format").
- BOTH counts are fetched once on mount and shown inside the segmented buttons:
  `All records · 45,231` / `Current filter · 1,234` (`…` while loading; plain label when the
  count failed or the filter is unavailable). All-records reuses the pagination total; the
  filter adds at most one `$count`.
- The Download button restates the commitment: `Download 1,234 records · CSV`
  (plain `Download CSV` when the count is unknown — count still never gates the action; the
  null-count path continues through buildExportJob's real-$count fallback).
- The count line (filename + streaming + >10k warning) is unchanged.
