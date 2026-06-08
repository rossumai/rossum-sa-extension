# Dataset Management: CSV download (export)

**Date:** 2026-06-08
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Add CSV export to the Dataset Management download feature, alongside the existing streamed JSON download. The user can export a whole collection or the current filtered pipeline result as a `.csv` file, after choosing a few options (delimiter, header, Excel BOM).

## 2. Verified facts (grounding)

- **UI:** `DownloadSplitButton` (`src/mdh/components/DownloadSplitButton.jsx`) is a caret-only `Download ▾` with a flat 2-item menu ("Download all…", "Download filtered…"), calling `onAll`/`onFiltered` → `RecordList` → `onRefresh('download')` / `onRefresh('download-filtered')` → `DataPanel.handleToolbarAction` → `downloadAll()` / `downloadFiltered()`.
- **`DataPanel.downloadAll()`**: >10k confirm (via `confirmModal`), then `runDownloadJob({ pipelineStages: [{$match:{}}], filename: `${col}.json`, filtered:false, fetchCount })`.
- **`DataPanel.downloadFiltered()`**: parses the pipeline editor (`substitutePlaceholders` → `JSON5.parse` → `stripPaginationStages`), pre-counts via `aggregate([...stages, {$count:'total'}])` (cancellable; populates progress total + gates the >10k confirm on the filtered subset), then `runDownloadJob({ pipelineStages, filename: `${col}-filtered.json`, filtered:true, fetchCount })`.
- **`runDownloadJob({pipelineStages, filename, filtered, fetchCount})`**: sets `downloadState`, calls `runDownload` (= `downloadCollection`) with `isCancelled`/`onProgress`, manages the toolbar progress/cancel/done UI.
- **`downloadCollection.js`** (the engine): `pickFile` first (transient-activation requirement — must be the first await after the user gesture; AbortError → cancelled; other errors → Blob fallback), then `fetchCount()`, then a sliding-window worker pool (`CONCURRENCY=10`, `BATCH_SIZE=1000`, `MAX_BUFFERED=20`) where each worker runs `api.aggregate(collection, [...stages, {$skip}, {$limit}])`; in-order chained-promise flush; cancellation between fetches and in the buffer-room wait; appends `{$sort:{_id:1}}` unless the caller's pipeline already ends with a `$sort`. **Serialization is hardcoded JSON**: writes `[\n`, per-doc `'  ' + JSON.stringify(doc,null,2)` joined by `,\n`, then `\n]\n`; Blob fallback uses `application/json` + per-batch string parts; picker `types` advertises `.json`.
- The Data Storage aggregate API supports `$objectToArray`, `$unwind`, `$group`, `$addToSet`, `$project` (per the data-storage reference) and is **runtime-limited to 120s**.
- The CSV **import** wizard already provides reusable `Segmented` and `Toggle` controls (exported from `src/mdh/components/CsvImportWizard.jsx`) and `src/mdh/csv.js` is the home of CSV parsing helpers.

## 3. Decisions

| Decision | Choice |
|---|---|
| Exporter architecture | Generalize `downloadCollection` to a **pluggable serializer** (engine reused); JSON behavior becomes the JSON serializer; CSV is a second serializer. |
| Column set | **Pre-pass exact union** of top-level keys via one aggregation, before streaming. |
| Column order | **`_id` first, then the rest alphabetically.** |
| Non-scalar cell values | **`JSON.stringify` into the cell** (then CSV-quoted). |
| Scalar mapping | null/missing → empty cell; boolean → `true`/`false`; number → as-is; string → as-is. |
| Quoting | RFC 4180: quote a cell containing the delimiter / `"` / CR / LF; `"` → `""`. |
| Line terminator | **CRLF** (`\r\n`). |
| Options UX | **Small options modal** before the save dialog. |
| Options exposed | Delimiter (comma / semicolon / tab), Header row (default on), Excel-friendly UTF-8 BOM (default on). |
| Menu | **Two labeled sections** (JSON / CSV), each with "all" and "filtered". |
| Scope | Both whole-collection and filtered get CSV. JSON download stays byte-for-byte identical. |

## 4. Architecture: pluggable serializer

Generalize `downloadCollection(collectionName, opts)` so the format lives in a **serializer** object passed via `opts.serializer` (default: the JSON serializer, preserving today's exact output):

```
serializer = {
  async init(ctx),     // optional; runs AFTER pickFile, BEFORE preamble. ctx = { collectionName, pipelineStages, signal }.
                        // CSV uses this to discover columns; JSON omits it.
  preamble(),          // string written before the first item   (JSON: '[\n'      CSV: BOM? + header + '\r\n')
  item(doc),           // string for one document                (JSON: indented JSON.stringify   CSV: csvRow)
  separator,           // string between items                   (JSON: ',\n'      CSV: '\r\n')
  postamble(),         // string after the last item             (JSON: '\n]\n'    CSV: '')
  mimeType,            // Blob fallback type                     (JSON: 'application/json'   CSV: 'text/csv')
  pickerTypes,         // showSaveFilePicker `types`             (JSON: .json     CSV: .csv)
}
```

The engine's worker pool, backpressure, cancellation, in-order flush, and `{$sort:{_id:1}}` injection are unchanged. The write path changes from hardcoded JSON to: `await serializer.init?.(ctx)` → write `preamble()` → for each doc write `(written>0 ? separator : '') + item(doc)` → write `postamble()`. Picker stays the first await after the user gesture; `init()` (CSV column discovery) runs after the picker like `fetchCount`, so transient activation is unaffected.

Two factory helpers in `downloadCollection.js`: `buildJsonSerializer()` (current behavior, the default) and `buildCsvSerializer({ columns?, dialect, header, bom })` whose `init(ctx)` runs the column pre-pass when `columns` isn't supplied.

## 5. Column discovery (pure builders in `csv.js` + the aggregate call in the CSV serializer's `init`)

- `buildColumnDiscoveryPipeline(filterStages)` → `[...filterStages, {$project:{kv:{$objectToArray:'$$ROOT'}}}, {$unwind:'$kv'}, {$group:{_id:null, keys:{$addToSet:'$kv.k'}}}]`. (Pure, testable.)
- The CSV serializer's `init(ctx)` runs `api.aggregate(collectionName, buildColumnDiscoveryPipeline(pipelineStages))`, reads `result[0]?.keys ?? []`, and sets `columns = orderColumns(keys)`.
- `orderColumns(keys)` → `_id` first (if present), then the remaining keys sorted with `localeCompare`. (Pure, testable.) If the collection is empty → `keys = []` → a header-only (or empty) file; the export still completes.
- **Known limit:** the pre-pass is a second full scan and is subject to the 120s aggregate cap. Acceptable for typical master-data collections (the user chose exact union over cost). Documented; a future fallback (sample/async) is out of scope.

## 6. CSV serialization (pure, in `csv.js` — symmetric with the parser)

- `csvCell(value, { delimiter, quoteChar = '"' })` → string:
  - `null`/`undefined` → `''`
  - `boolean` → `'true'`/`'false'`
  - `number` → `String(value)` (NaN/Infinity, which JSON lacks, won't occur from Data Storage docs)
  - object/array → `JSON.stringify(value)`
  - else → `String(value)`
  - then quote: if the result contains `delimiter`, `quoteChar`, `\n`, or `\r`, wrap in `quoteChar` and replace each `quoteChar` with two.
- `csvRow(doc, columns, dialect)` → `columns.map((c) => csvCell(doc[c], dialect)).join(delimiter)`. Missing key → `doc[c]` is `undefined` → empty cell.
- `csvHeader(columns, dialect)` → `columns.map((c) => csvCell(c, dialect)).join(delimiter)` (header names quoted by the same rule).
- The CSV serializer composes these: `preamble = (bom ? '﻿' : '') + (header ? csvHeader(columns,dialect) + '\r\n' : '')`; `item = (doc) => csvRow(doc, columns, dialect)`; `separator = '\r\n'`; `postamble = () => ''`.

## 7. Options modal (`src/mdh/components/CsvExportOptions.jsx`)

Opened by the CSV menu items before the save dialog. Reuses the modernized `Segmented`/`Toggle` controls (imported from `CsvImportWizard.jsx`). Controls:
- **Delimiter** — `Segmented`: Comma `,` / Semicolon `;` / Tab. Default comma. (Semicolon helps European Excel.)
- **Header row** — `Toggle`, default on.
- **Excel-friendly (UTF-8 BOM)** — `Toggle`, default on. (Lets Excel read accented characters.)
- Actions: Cancel / **Download** (primary). The **Download** click is the user gesture that starts the export.

The modal does NOT do the file picking itself; its `onDownload(opts)` callback hands the chosen options back to `DataPanel`, which runs the existing pre-count/confirm/`runDownloadJob` flow with a CSV serializer built from those options.

## 8. Flow (DataPanel)

`runDownloadJob` gains an optional `serializer` argument (default `buildJsonSerializer()`), forwarded to `downloadCollection`. The existing JSON callers are unchanged in behavior (they omit it). No separate CSV download runner — the CSV path reuses `runDownloadJob` with a CSV serializer. New menu actions `download-csv` / `download-filtered-csv`:
- `downloadAllCsv()` opens `openModal('Export CSV', <CsvExportOptions onDownload={opts => …} />)`. On **Download** it runs `runDownloadJob({ pipelineStages:[{$match:{}}], filename:`${col}.csv`, filtered:false, fetchCount, serializer: buildCsvSerializer({dialect:{delimiter:opts.delimiter}, header:opts.header, bom:opts.bom}) })`, where `fetchCount` is the same whole-collection count `downloadAll` uses (`pagination.totalCount.value`, else an `aggregate([{$count:'total'}])`).
- `downloadFilteredCsv()` parses the pipeline exactly like `downloadFiltered` (substitute placeholders → `JSON5.parse` → `stripPaginationStages`), opens the same modal, and on **Download** pre-counts the filtered set (progress total + >10k confirm gate) then runs `runDownloadJob({ pipelineStages, filename:`${col}-filtered.csv`, filtered:true, fetchCount: () => filteredCount, serializer: buildCsvSerializer(...) })`.

The >10k confirm and the `downloadState` toolbar UI (count/total/filtered/done/cancelled) are reused as-is.

## 9. Download menu (`DownloadSplitButton.jsx`)

Reworked to two labeled sections; takes four callbacks (or a small structured prop):
```
Download ▾
  ┌ JSON ─────────────
  │ Download all          → onAllJson
  │ Download filtered     → onFilteredJson
  ┌ CSV ──────────────
  │ Download all          → onAllCsv
  │ Download filtered     → onFilteredCsv
```
Menu items have **no trailing ellipsis** (the existing `Download all…` / `Download filtered…` ellipses are removed too — done as a standalone tweak to `DownloadSplitButton.jsx`). `RecordList` passes the four handlers, wired to `onRefresh('download'|'download-filtered'|'download-csv'|'download-filtered-csv')`. New `.toolbar-menu-section` style in `console.css` for the section labels.

## 10. Files

**New**
- `src/mdh/components/CsvExportOptions.jsx` — the options modal.
- `tests/mdh-csv-export.test.js` — `csvCell`/`csvRow`/`csvHeader`/`orderColumns`/`buildColumnDiscoveryPipeline` unit tests + a `buildCsvSerializer` test (mocked `api.aggregate` for `init`).

**Modify**
- `src/mdh/csv.js` — add `csvCell`, `csvRow`, `csvHeader`, `orderColumns`, `buildColumnDiscoveryPipeline` (pure).
- `src/mdh/downloadCollection.js` — generalize to `serializer`; add `buildJsonSerializer` (default, identical output) + `buildCsvSerializer`.
- `src/mdh/components/DownloadSplitButton.jsx` — two sections, four callbacks.
- `src/mdh/components/RecordList.jsx` — pass the four download handlers.
- `src/mdh/components/DataPanel.jsx` — `download-csv`/`download-filtered-csv` actions; `downloadAllCsv`/`downloadFilteredCsv`; add the optional `serializer` arg to `runDownloadJob`; import `buildCsvSerializer` (and the JSON callers keep working via the default) + `CsvExportOptions`.
- `src/console/console.css` — `.toolbar-menu-section` label style.
- `tests/mdh-download-collection.test.js` — extend for the serializer abstraction: assert the JSON serializer still produces identical output, and a CSV serializer produces header + CRLF-joined quoted rows.

**Reused unchanged**
- The streaming engine internals (workers/backpressure/cancellation/flush), `runDownloadJob`'s `downloadState` UI, `confirmModal`, the modal system, `Segmented`/`Toggle`.

## 11. Error handling & edge cases

- Empty collection / filter matches nothing → `columns = []` → header-only (if header on) or empty file; completes cleanly.
- Pre-pass aggregation error or 120s timeout → surfaced via the existing `error.value` / download-failure path; the partial file (if any) is aborted (existing `safeAbort`).
- Cancellation works at the same checkpoints (the pre-pass `init` honors the cancel signal; cancel before/while discovering columns aborts the writer).
- A document whose value for a column is itself a string that looks like JSON is written verbatim (quoted) — no double-encoding.
- Picker unavailable → Blob fallback with `text/csv` (+ BOM in the first part).
- Numbers: Data Storage returns JSON numbers; `String(n)` is correct. Big integers stored as strings stay strings.

## 12. Testing

- **`csv.js` (pure):** `csvCell` (null/bool/number/string/object/array; quoting for delimiter/quote/newline; `"`→`""`); `csvRow` (column order, missing key → empty, custom delimiter); `csvHeader`; `orderColumns` (`_id` first then alphabetical; no `_id`; empty); `buildColumnDiscoveryPipeline` (shape).
- **`downloadCollection.js`:** with a fake writer + mocked `api.aggregate`: the **JSON** serializer output is unchanged (guard against regression); the **CSV** serializer writes BOM? + header + CRLF-joined rows, honors `header:false` and the delimiter, and `init` discovers/sorts columns; cancellation still works.
- **`CsvExportOptions.jsx`:** renders the three controls with defaults; toggling/selecting updates state; Download fires `onDownload` with the chosen `{delimiter, header, bom}`.
- **`DownloadSplitButton.jsx`:** both sections render; the four items fire the right callbacks.

## 13. Non-goals

- XLSX export.
- Dot-flattening nested objects (we JSON-encode them).
- Per-column type/format configuration or column selection/reordering UI (columns are auto-discovered, `_id`-first-then-alphabetical).
- Changing the JSON download's behavior or output.
- A sample/async fallback for column discovery on huge collections (exact pre-pass only, with the 120s caveat documented).
