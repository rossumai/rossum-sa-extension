# Excel (.xlsx) import — custom zero-dependency parser

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Add **Excel (.xlsx) import** to the MDH Dataset Management app, mirroring the existing CSV import. Parse `.xlsx` entirely in-house using only native browser Web APIs — **no third-party library** — so the feature is CSP-clean by construction (no `eval`/`new Function`, no Web Worker) and adds zero dependencies. This matches the repo's hand-rolled `csv.js` and Galaxy patterns.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Direction | **Import only** | Export deferred; xlsx-write is a separate effort (and can't use the streaming download model — a ZIP must be built whole in memory). |
| Parser | **Custom, zero-dependency** | Eliminates the residual worker/CSP risk of `read-excel-file` (its `fflate` dep spawns a Blob-URL worker for parts >160 KB). |
| Decompression | Native **`DecompressionStream('deflate-raw')`** | Verified working (round-trips a 28 KB buffer; raw-DEFLATE is exactly what ZIP method-8 entries store, distinct from zlib `'deflate'` 0x78 0x9c). A standard Web API — CSP-irrelevant, no worker. |
| XML parsing | Native **`DOMParser`** | Standard Web API; no `@xmldom/xmldom` needed in a browser-only context. |
| Date/number-format fidelity | **Values only — no `styles.xml`** | Strings/numbers/booleans decode natively; date cells import as their raw Excel **serial number**. Drops the fiddliest, edge-case-prone part (numFmt date detection, 1900 leap-year bug, 1904 system). A static UI note tells the user dates arrive as serial numbers. |
| Wizard structure | **Parallel `XlsxImportWizard`** reusing the shared tail | Lowest risk; mirrors how the JSON and CSV importers already coexist. (Generalizing one shared wizard is a possible later refactor, not now.) |
| UI status | **Marked "beta"** in the Dataset Management UI | New, hand-rolled parser — flag it as beta on the "Insert from Excel file" menu item and in the wizard header, reusing the repo's existing beta-badge idiom. |

## 3. Verified facts (grounding)

- **`DecompressionStream('deflate-raw')`** exists and round-trips (verified: `node v24`, 28000 → 90 → 28000 bytes; `'deflate'` emits a `0x78 0x9c` zlib header while `'deflate-raw'` does not — ZIP entries are raw DEFLATE). Browser support: Chrome **103+** (June 2022), Baseline. *(Plan must check `manifest.json` `minimum_chrome_version` against this — almost certainly fine.)*
- **The import seam is a single function.** `parseCsv(buffer, opts) → { docs, columns, warnings, error }` (`src/mdh/csv.js:207`). Everything downstream — `analyzeDocs`, `dedupeById`, `runChunkedInsert`/`runChunkedOverwrite` (`src/mdh/importFile.js`), and `StageConfirm`/`StageImporting`/`StageDone` (`src/mdh/components/ImportStages.jsx`) + the `CsvPreview` table — is **format-agnostic and reused unchanged**. An xlsx parser must produce the same shape.
- **CSP:** the Console page runs under the default MV3 policy `script-src 'self'` (no explicit policy in `manifest.json`; no `unsafe-eval`). The repo verifies cleanliness with `grep -cE "eval\(|new Function\(|WebAssembly" dist/console/console.js` → must be 0. `DecompressionStream` and `DOMParser` are Web APIs and trip none of this.
- **OOXML structure (ECMA-376 / SpreadsheetML):** an `.xlsx` is an OPC ZIP of XML parts — `xl/workbook.xml` (sheet list + `r:id`s), `xl/_rels/workbook.xml.rels` (`r:id` → sheet part path), `xl/sharedStrings.xml` (string table), `xl/worksheets/sheetN.xml` (rows/cells). Cells carry a `t` type attribute (`s`=shared-string index, `b`=boolean, `str`/`inlineStr`=string, `e`=error, absent/`n`=number) and a `<v>` value. Dates are *styled numbers* (detectable only via `styles.xml` + numFmt) — which **values-only mode intentionally ignores**, so date cells import as numbers.

## 4. Architecture

### 4.1 The seam — `src/mdh/xlsx.js`

A new module mirroring `csv.js`'s factoring, with the parse split into testable pieces:

```
parseXlsx(arrayBuffer, { sheet, hasHeader, emptyMode })
  → Promise<{ docs, columns, warnings, error, sheets }>
```

- **Async** (because `DecompressionStream` is stream-based). Returns the exact `parseCsv` shape **plus** `sheets: string[]` (sheet names, for the picker). On any failure returns `{ docs:[], columns:[], warnings:[], error:{ message }, sheets:[] }`.
- Internal, individually-testable helpers:
  - `unzip(arrayBuffer) → Promise<Map<string, Uint8Array>>` — parse the ZIP End-of-Central-Directory record → central-directory entries (name, method, offset) → for each entry read its local header and inflate via `DecompressionStream('deflate-raw')` (method 8) or copy bytes (method 0 "stored"). Unsupported method or a Zip64 sentinel (`0xFFFFFFFF`) → throw a clear error (caught → `error`). *(Only the parts we need are inflated.)*
  - `readWorkbook(xmlString) → { sheets: [{ name, rid }] }` (via `DOMParser`).
  - `readRels(xmlString) → Map<rid, targetPath>`.
  - `readSharedStrings(xmlString) → string[]` — one entry per `<si>`; concatenate rich-text `<r><t>` runs; respect `xml:space="preserve"`.
  - `readSheet(xmlString, sharedStrings) → rows: Array<Array<value | undefined>>` — walk `<row>/<c>`; column letter (`A1`) → 0-based index; sparse/missing cells stay `undefined`; decode each cell by `t` (below).
  - `rowsToDocs(rows, { hasHeader, emptyMode }) → { docs, columns, warnings }` — **pure**, no Web API; mirrors `csv.js`'s `rowsToDocs` but over already-typed cells (no string coercion, no type inference, no trim).

### 4.2 Cell value decoding (`readSheet`)

| `t` | Meaning | JS value |
|---|---|---|
| `s` | shared-string index | `sharedStrings[Number(<v>)]` (string) |
| `b` | boolean | `<v> === '1'` |
| `str` | formula string result | the `<v>` text (string) |
| `inlineStr` | inline string | concatenated `<is><t>` text (string) |
| `e` | error (e.g. `#DIV/0!`) | `null` |
| *(absent)* / `n` | number | `Number(<v>)` — **includes date/time cells as their raw serial number** |

Missing/empty `<v>` or absent cell → handled by `emptyMode` in `rowsToDocs`.

### 4.3 `rowsToDocs` semantics

- **Header:** `hasHeader: true` (default) → row 1 supplies field names; trim/blank header names get a generated fallback (`column_N`) and a warning if duplicated (mirror CSV behavior). `hasHeader: false` → all rows are data, columns named `column_1, column_2, …`.
- **Columns:** the ordered union across rows (header order first, then any later columns), preserving sheet column order. (Reuse `orderColumns`? No — xlsx column order is positional, not `_id`-first/alphabetical; keep sheet order. `_id`, if present as a header, flows through naturally for dedupe/overwrite, exactly like CSV.)
- **Empty cell** (`undefined`/missing) → per `emptyMode`: `'null'` (default) → `null`; `'omit'` → field absent from the doc. *(No `'empty'` empty-string option — meaningless for xlsx; an empty xlsx cell is absent, not `""`.)*
- **Warnings:** ragged rows (cell count ≠ header count), duplicated/blank header names — same warning style as CSV.

### 4.4 Wizard — `src/mdh/components/XlsxImportWizard.jsx`

Mirrors `CsvImportWizard` (a 5-stage state machine: pick → configure → confirm → importing → done):
- **PICK:** `<input accept=".xlsx">` → `file.arrayBuffer()` → CONFIGURE.
- **CONFIGURE:** xlsx options (§5) + a **live preview**. Because `parseXlsx` is **async** (unlike CSV's synchronous `useMemo`), the stage parses in an effect with `{ loading, result, error }` state and a race guard (an incrementing token / `live` flag, like the export preview), re-parsing when `buffer`, `sheet`, `hasHeader`, or `emptyMode` change. The `sheets` list (for the picker) comes from the same parse result. Display reuses the **format-agnostic `CsvPreview`** (`{ columns, docs, warnings, error }`).
- **CONFIRM / IMPORTING / DONE:** reuse `StageConfirm` / `StageImporting` / `StageDone` from `ImportStages.jsx` verbatim.
- **Import:** `dedupeById(docs)` then `runChunkedInsert` / `runChunkedOverwrite` — all reused from `importFile.js`.

### 4.5 UI wiring

- `src/mdh/components/RecordList.jsx` — add an **"Insert from Excel file"** menu item next to "Insert from CSV file", firing action `'insert-xlsx-file'`, carrying `beta: true`.
- `src/mdh/components/DataPanel.jsx` — route `'insert-xlsx-file'` to `openDataOperations`.
- `src/mdh/components/DataOperations.jsx` — dispatch `'insert-xlsx-file'` → `<XlsxImportWizard onSuccess={…} />`.

### 4.6 Beta marking

Mark the Excel feature as **beta** in two places, reusing the existing beta-badge idiom (`.beta-badge` in `popup.css`, `.app-rail-beta` in `console.css`):
- **Menu item badge.** The Insert split-button menu renderer currently maps a plain string label (`RecordList.jsx:214-216`: `<button …>{item.label}</button>`). Extend the item shape with an optional `beta` flag and the renderer to append a small badge: `{item.label}{item.beta && <span class="toolbar-menu-beta">beta</span>}` (key stays `item.label`). Only the Excel item sets `beta: true`; JSON/CSV items are unchanged.
- **Wizard header tag.** `XlsxImportWizard`'s pick stage shows the feature name with a small "Beta" tag (same `.toolbar-menu-beta`/shared class), so the status is visible once the modal is open.
- **CSS.** Add a small `.toolbar-menu-beta` chip to `console.css` styled consistently with `.app-rail-beta` (uppercase-ish, muted/accent, small) — or, if cleaner, a single shared `.beta-tag` used by both spots. Dark-mode covered by the existing variable system.
- This is an explicit, current request; it does not conflict with the earlier removal of beta badges from the *popup Audit Logs* button (different feature, different surface).

## 5. Configure-stage options (simpler than CSV)

- **Sheet** — a picker, shown **only when the workbook has >1 sheet** (default: first sheet). Changing it re-parses.
- **First row is a header** — toggle, default on (off → `column_1…`).
- **Empty cell →** `null` / `omit` (default `null`).
- A **static hint:** "Excel date cells import as their underlying serial number." (We can't detect dates without `styles.xml`, which values-only mode skips — so this is stated up front rather than guessed per-cell.)
- **Dropped vs CSV:** delimiter, encoding, quote/escape/double-quote, skip-empty-lines, infer-types, trim — all N/A for a binary, natively-typed format.

## 6. CSP

- The parser uses **only `DecompressionStream` + `DOMParser`** — both Web APIs, neither `eval`/`new Function` nor a Worker. CSP-clean by construction.
- The existing grep stays green; **extend the post-build check** to also assert no `new Worker(`/`createObjectURL(`/`blob:` were introduced in `dist/console/console.js` (defensive — proves we didn't pull in a worker-based path). Keep it as the documented manual step (no CI hook exists today).
- **Verify** `manifest.json` `minimum_chrome_version` (if set) is ≤ 103; if unset, note `deflate-raw` needs Chrome 103+.

## 7. Testing strategy

Structured so pure logic never depends on a Web API:
- **`rowsToDocs` (pure)** — unit tests: header on/off, generated/duplicate/blank column names, column union & order, `emptyMode` null vs omit, ragged-row warnings, mixed typed values, `_id` passthrough.
- **`readSheet` / `readSharedStrings` / `readWorkbook` / `readRels`** — unit tests feeding XML strings (uses `DOMParser`; runs in the **jsdom** vitest env). Cover each `t` type, shared-string rich-text runs, inline strings, error cells → null, sparse cells, date-as-serial-number.
- **`unzip` + full `parseXlsx`** — integration test against a **small committed fixture** `tests/fixtures/sample.xlsx` (built once — see note) exercising: header row, string/number/boolean cells, a date cell (asserted to arrive as a number), an empty cell, shared strings, and a second sheet (sheet selection + `sheets` list). Plus a not-an-xlsx buffer → `error`.
  - **Test-env caveat to verify in the plan:** confirm `DecompressionStream` is available in the vitest run (Node 18+ exposes it globally; we're on v24). If the chosen test env lacks it, run the `unzip`/`parseXlsx` integration test in a node env and keep the XML-decode tests in jsdom.
  - **Fixture generation:** the fixture is created once by a throwaway **zero-dependency** Node script (hand-authored OOXML XML parts + a minimal ZIP writer using native `node:zlib` `deflateRawSync`) and the resulting binary committed. The shipped extension contains **no** writer. The script deliberately **mixes** compression methods so the committed fixture exercises both `unzip` branches end-to-end — the method-8 `DecompressionStream('deflate-raw')` inflate (sharedStrings + worksheets are DEFLATE) and the method-0 copy (container parts are Stored) — and emits a real `xl/sharedStrings.xml` so the worksheet uses `t="s"` cells (including one rich-text `<si>` run) that drive `readSharedStrings` + the `t="s"` decode through the real-file integration test, not just the Task 3 inline-XML unit tests. (An off-the-shelf `xlsx@0.18.5` writer was tried first but emitted Stored-only entries with no sharedStrings — `t="str"` inline strings — leaving exactly those two paths uncovered, so it was replaced.)
- **Wizard flow** — `XlsxImportWizard`: pick → async preview renders (condition-based `waitFor`), sheet/header/empty changes re-parse, Next gating. Reuse the existing `ImportStages` coverage for confirm/importing/done.
- **Beta marking** — the Excel menu item renders a `.toolbar-menu-beta` badge while the JSON/CSV items do not; the wizard header shows the Beta tag.
- **Build + CSP grep** (eval/Function + the new worker/blob assertion).

## 8. Edge cases & graceful failure

- **Not an `.xlsx`** (bad ZIP signature / missing `workbook.xml`) → `error` shown in preview.
- **Zip64 / unsupported compression method** → clear `error` (we support stored + DEFLATE only). Rare for typical Excel output.
- **Encrypted / password-protected** workbook (it's a different container, "EncryptedPackage") → fails the ZIP/part lookup → `error`.
- **Empty sheet / no data rows** → empty preview, Next disabled (mirror CSV's "No data rows").
- **Merged cells** → the value lives in the top-left cell; others are empty → handled naturally by `emptyMode`.
- **Large files** → whole workbook decompressed + parsed in memory (no streaming); acceptable for typical SA imports. *(No explicit size cap in v1; revisit if needed.)*
- **Locale/number formatting** → values come straight from `<v>` (canonical, locale-independent), so no locale issues; dates are serial numbers regardless of display format.

## 9. Non-goals

- **Export to `.xlsx`** (separate effort; can't reuse the streaming serializer).
- **Legacy `.xls`** (BIFF binary — entirely different format).
- **Date/number-format detection** (values-only by decision — dates are serial numbers).
- **Formulas** — we take the cached `<v>` result; we do not evaluate formulas.
- **Styling, merged-cell expansion, charts, multiple sheets at once, streaming.**

## 10. Open risks

- **Real-world file variety** — different producers (Excel, Google Sheets, LibreOffice, openpyxl) emit slightly different XML; mitigated by a multi-producer fixture suite and graceful failure. This is the cost of owning the parser (vs. a battle-tested library).
- **`deflate-raw` Chrome floor (103)** — verify against `minimum_chrome_version`.
- **Test-env `DecompressionStream`** availability — verify; fall back to a node-env integration test if needed.
