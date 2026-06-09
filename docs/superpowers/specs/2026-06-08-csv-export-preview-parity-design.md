# CSV export preview + import/export parity

**Date:** 2026-06-08
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Bring the "Export CSV" modal to reasonable parity with the "Insert from CSV file" modal: give Export a **live preview**, and trim both option sets to the essentials. Specifically: add a CSV-text preview to Export, remove Export's BOM option (and never write a BOM), and remove the Quote / Escape / Double-quote / Skip-empty-lines controls from the import wizard (keep them as fixed parser defaults).

## 2. Verified facts (grounding)

- **`CsvExportOptions.jsx`** today takes only `{ onDownload }`, has Delimiter (Segmented), Header (Toggle), and **BOM** (Toggle), and no preview. On Download it calls `closeModal(); onDownload({ delimiter, header, bom })`.
- **`DataPanel.jsx`** opens it in `downloadAllCsv` (~line 496, `pipelineStages = [{ $match: {} }]`) and `downloadFilteredCsv` (~line 536, the parsed filter pipeline) via `openModal('Export CSV', () => <CsvExportOptions onDownload={…} />)`. `col` (collection) and `pipelineStages` are in scope at both sites. `onDownload` runs the >10k confirm / filtered pre-count, then `runDownloadJob({ …, serializer: buildCsvSerializer({ dialect:{delimiter:opts.delimiter}, header:opts.header, bom:opts.bom }) })`.
- **`buildCsvSerializer({ dialect, header, bom = true, columns = null })`** (`downloadCollection.js`): if `columns != null`, its `init` skips the exact-union discovery and uses the supplied columns. `bom` prepends `﻿` when truthy.
- **`csv.js`** exports the pure helpers `csvHeader(columns, dialect)`, `csvRow(doc, columns, dialect)`, `orderColumns(keys)`, `buildColumnDiscoveryPipeline(filterStages)`.
- **MDH `api`** exports `aggregate(collectionName, pipeline, { signal })` and `find(...)`.
- **Import `CsvOptions`** (`CsvImportWizard.jsx`): toolbar = Delimiter (`csv-delim-*`, + custom), Header (`csv-header`), Infer types (`csv-infer`), Advanced disclosure (`csv-advanced-toggle`). Advanced panel = Quote (chip), Escape (chip), Double-quote (`csv-doublequote`), Encoding (`csv-encoding`), Empty-cell (`csv-empty`), Skip-empty-lines (`csv-skipempty`), Trim (`csv-trim`). `DEFAULT_OPTS` holds `delimiter`, `quoteChar:'"'`, `escapeChar:''`, `doubleQuote:true`, `encoding:'utf-8'`, `hasHeader:true`, `inferTypes:false`, `emptyMode:'empty'`, `skipEmptyLines:true`, `trim:false`. The parser (`parseCsv`) reads all of these; `escapeChar:''` is normalized to `null` at the `useMemo` call site.

## 3. Decisions

| Decision | Choice |
|---|---|
| Export preview | A live **CSV-text** block (header + ~10 sample rows), re-rendered on a delimiter/header change. |
| Preview columns | **Exact union** (the same discovery the download uses), computed once on modal open, **reused** by the download (passed as `columns`). |
| Preview data | A 10-row sample via `aggregate([...pipelineStages, { $limit: 10 }])`. |
| Export BOM | **Removed** as an option; the export **never** writes a BOM (`bom: false`). |
| Import controls removed | Quote, Escape, Double-quote, Skip-empty-lines — kept as fixed parser defaults (`DEFAULT_OPTS` unchanged). |
| Preview decoupling | The modal takes an injected `loadPreview()` (testable without mocking the API). |

## 4. Export preview (`CsvExportOptions.jsx`)

New signature: `CsvExportOptions({ loadPreview, onDownload })`.
- `loadPreview: () => Promise<{ columns: string[], sample: object[] }>` — injected by `DataPanel` (closes over `col` + `pipelineStages`).
- State: `delimiter` (`,`), `header` (`true`); `preview` = `{ loading: true, columns: [], sample: [], error: null }`.
- `useEffect(() => { let live = true; loadPreview().then((r) => live && setPreview({ loading:false, ...r, error:null })).catch((e) => live && setPreview({ loading:false, columns:[], sample:[], error: e.message || 'failed' })); return () => { live = false; }; }, [])` — runs once on mount.
- Options row: Delimiter + Header only (BOM control deleted).
- Preview region (`.csv-export-preview`, monospace `<pre>` in a scroll box):
  - loading → a spinner + "Building preview…";
  - error → "Preview unavailable" (muted; Download still allowed);
  - else → caption `Preview · first {sample.length} of the collection · {columns.length} columns` + the text:
    `(header ? csvHeader(columns, { delimiter }) + '\n' : '') + sample.map((d) => csvRow(d, columns, { delimiter })).join('\n')`.
  - Re-computed on every render, so toggling the delimiter/header updates it instantly (no re-fetch). Empty collection (`sample` empty / `columns` empty) → render an empty/"No rows" note.
- Download button: `onClick={() => { const cols = (!preview.loading && !preview.error && preview.columns.length) ? preview.columns : null; closeModal(); onDownload({ delimiter, header, columns: cols }); }}`. Reuse the discovered `columns` ONLY when the preview has fully loaded a non-empty set; otherwise pass `null` so the serializer discovers at download time. This covers three cases safely: (a) Download clicked while the preview is still loading → `null` (the empty `[]` would otherwise make the serializer skip discovery and write an empty file); (b) preview failed → `null`; (c) genuinely empty collection (`columns:[]`) → `null`, and the serializer's own discovery also yields `[]` → a correct empty/header-only file. Download stays enabled throughout (the user need not wait for a slow discovery scan).
- The preview display uses `\n` line breaks (the file itself uses CRLF via the serializer; the preview illustrates columns/delimiter/quoting/value formatting, not exact line-ending bytes). Sample rows are "a sample," not guaranteed to be the file's exact first rows.

## 5. Import simplification (`CsvImportWizard.jsx`)

Delete these four controls from the Advanced panel: **Quote** (chip input), **Escape** (chip input), **Double-quote** (`csv-doublequote` Toggle), **Skip-empty-lines** (`csv-skipempty` Toggle). Keep Encoding, Empty-cell, Trim in Advanced; toolbar unchanged (Delimiter, Header, Infer types, Advanced disclosure).

`DEFAULT_OPTS` is **unchanged** — `quoteChar`, `escapeChar`, `doubleQuote`, `skipEmptyLines` remain, so `parseCsv` still receives them (RFC-4180 quoting, `""` collapse, blank-line skipping all still happen, just not user-configurable). The `useMemo` call site (`escapeChar: opts.escapeChar || null`) is unchanged.

### 5.1 Import preview value rendering (`PreviewValue` + legend + table CSS)

Today `PreviewValue` wraps every string in literal double quotes (`"{value}"`) as a JSON-style "this is a string" hint, advertised by the legend's `"text"`. That hint isn't part of the imported value and reads as confusing — the preview should show *exactly what will be imported*. Change the rendering (the parser is untouched):

- **Non-empty string** → plain text, **no surrounding quotes** (`<span class="csv-cell-string">{value}</span>`).
- **Empty string (`''`)** → a muted, italic `(empty)` marker (`.csv-cell-empty`) so a genuinely-empty value stays visible and distinct from `null` and an omitted field. This marker is a clearly-an-annotation UI affordance, not data. A whitespace-only string (e.g. `'  '`) is **not** relabelled `(empty)` — that would misrepresent what gets imported; it renders as its literal content, and the new cell gridlines keep every cell (including blank-looking ones) bounded and visible.
- Number / boolean / null / omitted are **unchanged** (number+bool: accent + monospace; null: muted italic `null`; omitted: `—`). Type distinction therefore survives the quote removal via color/font, not quotes.
- **Legend** drops the quotes around `"text"` → renders `text` in the normal text style, so the legend mirrors the new rendering (`123` number · `text` · `null`).
- **Subtle cell outlines:** the preview table currently has only horizontal `border-bottom`s. Add a 1px `var(--border)` `border-right` to every `th`/`td` (cleared on the last column so it doesn't double against the scroll container's edge), giving a quiet column grid that bounds each cell — so a blank/empty cell still reads as a real cell.

## 6. DataPanel wiring (`DataPanel.jsx`)

Import `buildColumnDiscoveryPipeline, orderColumns` from `../csv.js`. At both export sites, pass `loadPreview` and update `onDownload`:
```jsx
<CsvExportOptions
  loadPreview={async () => {
    const [keysRes, sampleRes] = await Promise.all([
      api.aggregate(col, buildColumnDiscoveryPipeline(pipelineStages)),
      api.aggregate(col, [...pipelineStages, { $limit: 10 }]),
    ]);
    return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
  }}
  onDownload={async ({ delimiter, header, columns }) => {
    // …existing >10k confirm / filtered pre-count unchanged…
    await runDownloadJob({
      …,
      serializer: buildCsvSerializer({ dialect: { delimiter }, header, bom: false, columns }),
    });
  }}
/>
```
`bom: false` is fixed (BOM never written). `columns` (from the preview's exact-union) is threaded into the serializer so the download does NOT re-scan; if it's `null` (preview failed), the serializer discovers as before. The filtered handler still parses its pipeline before opening the modal (so `pipelineStages` is available to `loadPreview`).

## 7. Files & tests

**Modify**
- `src/mdh/components/CsvExportOptions.jsx` — add the `loadPreview`-driven preview; remove the BOM control; thread `columns` through `onDownload`.
- `src/mdh/components/CsvImportWizard.jsx` — remove the four Advanced controls (DEFAULT_OPTS untouched).
- `src/mdh/components/DataPanel.jsx` — pass `loadPreview`, drop `bom` from the options object (fixed `bom:false`), thread `columns`.
- `src/console/console.css` — `.csv-export-preview` monospace scroll block (+ caption).

**Tests**
- `tests/mdh-csv-export-options.test.js` (rewrite): with an injected `loadPreview` resolving `{ columns:['_id','active','name'], sample:[…] }`, the preview renders the CSV text (header + rows); toggling the delimiter to `;` re-renders with semicolons; Download fires `onDownload` with `{ delimiter, header, columns }` (columns passed through); there is no BOM control (`csv-export-bom` absent); a rejecting `loadPreview` shows "Preview unavailable" and Download passes `columns: null`. Async render handled with the file's condition-based `waitFor`/`flush`.
- `tests/mdh-csv-wizard.test.js` (update): assert the removed controls are gone (`csv-doublequote` / `csv-skipempty` absent even when Advanced is open; no Quote/Escape chip); the kept ones (`csv-empty`, `csv-encoding`, `csv-trim`, `csv-infer`, `csv-header`, delimiter) still present; the existing infer-types reparse test still passes (parser unchanged). The `csv.js` parser tests are untouched (defaults still applied).

## 8. Non-goals

- `parseCsv` behavior is unchanged. The import preview stays a parsed-document table; only its *value rendering* changes (drop string quotes, mark empty strings, add subtle cell outlines — see §5.1).
- No new export options (Export stays Delimiter + Header; encoding is always UTF-8, no BOM).
- No change to the streaming download engine, the >10k confirm, or the progress UI.
- The preview's sample rows are illustrative (a 10-row sample), not a guarantee of the file's exact first rows or total count.
