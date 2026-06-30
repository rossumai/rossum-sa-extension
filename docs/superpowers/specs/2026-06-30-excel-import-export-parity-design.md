# Excel (.xlsx) import / export parity — design

Date: 2026-06-30
Status: approved (brainstorm), pending implementation plan

## 1. Problem & goal

The Dataset Management (MDH) app supports five record interchange formats, but
their support is asymmetric. Verified from source:

| Format | Import | Export |
| --- | --- | --- |
| JSON | yes | yes |
| JSON Lines (NDJSON) | yes | yes (beta) |
| CSV | yes (beta) | yes (beta) |
| XML | yes (beta) | yes (beta) |
| **Excel (.xlsx)** | yes (beta) | **missing** |

**Excel is the only format that cannot be exported.** It is also the only
importer with a data-fidelity hole: date cells import as their raw Excel serial
number (e.g. `45306`) instead of a date, because the reader skips `styles.xml`.

Goal: bring `.xlsx` to full parity with the other formats — add streamed Excel
export, and fix the Excel import date handling. Stay dependency-free and
CSP-clean (no new npm dependency, no `eval`/`new Function`/Worker), matching the
existing hand-rolled `xlsx.js` reader.

Out of scope: multi-sheet export, cell styling/formatting beyond what dates
require, formulas, charts, images, named ranges.

## 2. Constraints (verified facts, not assumptions)

- **No XLSX library.** The reader (`src/mdh/xlsx.js`) is hand-rolled on
  `DecompressionStream('deflate-raw')` + `DOMParser`. The writer will be
  hand-rolled symmetrically.
- **`CompressionStream('deflate-raw')` is available** in the Console page and in
  the jsdom test environment — `tests/mdh-xlsx-env.test.js` already uses it to
  produce compressed bytes and round-trips them through `DecompressionStream`.
  So a deflate-based writer is both runnable and testable.
- **The Data Storage API speaks MongoDB Extended JSON on input, not only
  output.** `importFile.js#findExistingIds` sends
  `{ _id: { $in: [ {$oid: "<hex>"}, ... ] } }` and that probe matches real
  ObjectIds — it is load-bearing for the overwrite/conflict flow. Responses also
  return `{$oid}` / `{$date}` shapes (relied on by `csvCell`, `displayValue.js`,
  `JsonTree`). The same EJSON parser handles `{$date}`. Import dates will be sent
  as `{$date: "<ISO>"}`; a live insert→read round-trip is a verification gate in
  the plan (see §9), with an ISO-string representation as the documented fallback
  if `{$date}` does not store as a real date.
- **The export engine** (`downloadCollection.js`) is a streamed, format-agnostic
  pipeline: sliding-window fetch workers → in-order flush → `writeChunk` →
  FS-Access writer or Blob fallback. It already provides the >10k-row confirm
  gate, progress, cancellation, and the file picker. The XLSX serializer must
  plug into this, not bypass it.
- The import insert tail (`runChunkedInsert` / `runChunkedOverwrite`,
  `analyzeDocs`, `dedupeById`, `StageConfirm`/`StageImporting`/`StageDone`) is
  shared and format-independent; XLSX already reuses it and will continue to.

## 3. Architecture decisions (from brainstorm)

1. **Scope:** Excel export + Excel import date fix (full parity both ways).
2. **Export shape:** streamed binary serializer inside the existing engine — no
   memory ceiling, reuses progress/cancel/picker/gate.
3. **Dates:** convert both directions. Import date cells → `{$date}`; export
   `{$date}` values → real Excel date cells.
4. **No backward-compatibility toggle.** Excel dates always import as `{$date}`
   (previously raw serial numbers). The change is intentional and unconditional;
   no legacy "dates as number" mode.

## 4. New & changed files

### New
- `src/mdh/xlsxDates.js` — pure date/serial helpers, shared by reader & writer:
  - `serialToDate(serial, { date1904 = false })` → JS `Date` (UTC).
  - `dateToSerial(date, { date1904 = false })` → number.
  - `isDateFormat(numFmtId, formatCode)` → boolean (builtin date ids + custom
    format-code token scan).
  - `BUILTIN_DATE_FMT_IDS` set; epoch constants `EPOCH_1900 = 25569`,
    `EPOCH_1904 = 24107` (days from the system epoch to 1970-01-01; 25569
    coincides with Excel's Unix-epoch serial, correct for all dates
    ≥ 1900-03-01).
- `src/mdh/xlsxWrite.js` — pure-ish writer:
  - CRC-32 (table built once, polynomial `0xEDB88320`).
  - ZIP framing: local file header, optional **data descriptor** (for the
    streamed sheet entry), central-directory header, EOCD. No Zip64.
  - OOXML part builders: `[Content_Types].xml`, `_rels/.rels`,
    `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml`, and the
    `xl/worksheets/sheet1.xml` head/row/tail fragments.
  - Cell encoders (`cellXml(value, ref, { dateStyleIdx })`) + column-letter
    helper (`indexToCol`, inverse of the reader's `colToIndex`).
  - `sanitizeSheetName(name)` (≤31 chars, strip `: \ / ? * [ ]`, non-empty).
  - `buildXlsxSerializer({ sheetName, header, columns })` returning the binary
    serializer object (see §5).
- `src/mdh/components/XlsxExportOptions.jsx` — options + preview modal, mirrors
  `CsvExportOptions.jsx`: sheet-name input, header toggle, table preview of the
  exact-union columns + a small row sample. Beta tag. Hands discovered columns
  back through `onDownload` so the download does not re-scan.

### Changed
- `src/mdh/xlsx.js` (reader):
  - `parseXlsx` reads `xl/styles.xml` (`<cellXfs><xf numFmtId=…>`) and the
    workbook `date1904` flag (`<workbookPr date1904="1"/>`), builds a
    `styleIsDate[]` lookup, and passes it into `readSheet`.
  - `readSheet(xmlString, sharedStrings, { styleIsDate, date1904 } = {})`: a
    numeric cell (`t` absent/`n`) whose `s` style is a date format becomes
    `{ $date: serialToDate(serial,{date1904}).toISOString() }`. Signature gains
    optional params → existing callers/tests unaffected.
  - `rowsToDocs` gains `emptyMode: 'empty'` (alongside `null`/`omit`) and a
    `trim` option (string cells only) for CSV parity. Defaults unchanged.
- `src/mdh/downloadCollection.js`:
  - `writeChunk` accepts `string | Uint8Array` (FS-Access `writer.write` and the
    `Blob` fallback both accept bytes already).
  - Add a **binary-serializer protocol** detected via `serializer.binary === true`:
    `await serializer.start(writeBytes, ctx)`, `await serializer.writeDocs(docs, writeBytes)`
    per ordered batch, `await serializer.finish(writeBytes)`. The existing text
    protocol (`preamble`/`item`/`separator`/`postamble`) is untouched and its
    output stays **byte-for-byte identical** (JSON/CSV/XML/NDJSON). The flush
    loop branches once on `binary`.
  - Export `buildXlsxSerializer` (re-export from `xlsxWrite.js`).
- `src/mdh/components/DownloadSplitButton.jsx`: add an Excel (.xlsx) item to both
  submenus → `onAllXlsx` / `onFilteredXlsx` props, with a `beta` tag.
- `src/mdh/components/DataPanel.jsx`: `downloadAllXlsx` / `downloadFilteredXlsx`
  mirroring the CSV/XML handlers exactly (open `XlsxExportOptions`, same column
  discovery, same >10k gate + count + cancel + picker, `serializer:
  buildXlsxSerializer(...)`). Wire the two new `DownloadSplitButton` props in
  `RecordList.jsx`.
- `src/mdh/components/XlsxImportWizard.jsx`: drop the "imports as serial number"
  hints (now false); add an empty-cell `""` option and a Trim toggle (CSV
  parity). No date toggle.

## 5. Streamed XLSX export — the binary serializer

A single-worksheet workbook. The serializer owns a `CompressionStream('deflate-raw')`
and a running byte offset, CRC-32, and uncompressed-size counter for the sheet
entry.

- `start(writeBytes, { collectionName, pipelineStages })`:
  - If columns were not supplied, discover them (same as CSV:
    `buildColumnDiscoveryPipeline` + `orderColumns`).
  - Write the sheet entry's **ZIP local header** (general-purpose flag bit 3 set
    → CRC/sizes deferred to a data descriptor), via `writeBytes`.
  - Start a pump that reads the deflate stream's readable side and forwards each
    compressed chunk to `writeBytes` (tracking compressed size).
  - Feed the sheet XML head + (if `header`) the header `<row>` into the deflate
    writable side (tracking CRC + uncompressed size).
- `writeDocs(docs, writeBytes)`: build `<row>` XML for each doc (cells in column
  order) and feed it into the deflate writable side. Row index is tracked across
  batches. No per-row engine separator (rows are self-delimiting).
- `finish(writeBytes)`: feed the sheet XML tail, `close()` the deflate writer,
  drain the pump, then write (all via `writeBytes`): the sheet **data
  descriptor** (CRC, comp size, uncomp size); each small metadata part as its own
  **stored** (method 0) ZIP entry; the **central directory**; the **EOCD**.

Worksheet name = `sanitizeSheetName(collectionName)`. **Inline strings**
(`t="inlineStr"`, `<t xml:space="preserve">`) — no shared-string pre-pass, so the
sheet streams. The big sheet is deflated; small parts are stored (tiny, sizes
known up front).

### Cell value mapping (symmetric with `csv.js#csvCell`)
- `string` → `inlineStr`, XML-escaped (reuse/extend `xml.js#escapeXml`), illegal
  XML 1.0 control chars stripped.
- finite `number` → numeric `<v>`.
- `boolean` → `t="b"`, `<v>1|0</v>`.
- `null` / missing key → empty cell (`<c r="…"/>`).
- EJSON `{$date}` → **date cell**: `<c r="…" s="<dateStyleIdx>"><v>serial</v></c>`,
  `serial = dateToSerial(new Date(iso))`.
- EJSON `{$oid}` and any other object/array/EJSON → string cell via
  `formatEjsonValue` / `JSON.stringify` (exactly matching `csvCell`, including
  `$numberLong` beyond 2^53 → string to avoid precision loss).

### styles.xml
Minimal: `cellXfs[0]` = default (numFmtId 0); `cellXfs[1]` = date, referencing a
custom numFmt (id 164) `"yyyy-mm-dd hh:mm:ss"`. Date cells use `s="1"`. Always
included (harmless when a collection has no dates).

## 6. Import date conversion (reader)

- Read `date1904` from `xl/workbook.xml` `<workbookPr date1904="1"/>` (default
  false).
- Read `xl/styles.xml` `<cellXfs>`; for each `xf`, resolve `numFmtId` against the
  builtin date set and any `<numFmts>` custom codes via `isDateFormat`, producing
  `styleIsDate[xfIndex]`.
- In `readSheet`, a numeric cell whose `s` is a date style →
  `{ $date: serialToDate(serial, { date1904 }).toISOString() }` (ISO 8601, `Z`).
- Epoch 1899-12-30 (1900 system) / 1904-01-01 (1904 system). Correct for all
  dates ≥ 1900-03-01; the pre-1900-03-01 Excel leap-year-bug region is a
  documented edge (not corrected — no real master data lives there).

## 7. Backward compatibility

Per explicit instruction, **not a concern here**. The only behavioral change is
Excel dates importing as `{$date}` instead of serial numbers (intended,
unconditional, no toggle). Engine text serializers and the JSON export stay
byte-identical. `readSheet`/`rowsToDocs` signature additions are optional params.
`DownloadSplitButton` only gains props. No storage key or wire-format change.

## 8. Testing

All tests use the existing vitest + jsdom convention (`tests/**/*.test.js`,
`h(Component, …)` not raw JSX in `.test.js`).

- `tests/mdh-xlsx-dates.test.js` — `serialToDate`/`dateToSerial` round-trip,
  known values (e.g. 45292 ↔ 2024-01-01), `date1904`, `isDateFormat` for builtin
  ids and custom codes (date vs. non-date).
- `tests/mdh-xlsx-write.test.js` — **cross-check round-trip**: build a workbook
  with `xlsxWrite.js`, feed the bytes to the existing reader (`unzip` →
  `readWorkbook`/`readSheet`/`parseXlsx`), assert values, native types, and date
  cells survive. Plus unit tests for CRC-32 (known vector), `indexToCol`,
  `sanitizeSheetName`, and cell encoders.
- `tests/mdh-xlsx.test.js` — extend with reader date conversion (date-styled
  numeric cell → `{$date}`), `date1904`, `emptyMode:'empty'`, `trim`.
- `tests/mdh-download-collection.test.js` — assert the XLSX binary serializer
  produces a valid archive (round-trippable by the reader) and that JSON/CSV/XML/
  NDJSON output is unchanged (guard the byte-identical text path).
- `tests/mdh-download-dropdown.test.js` — Excel item present, fires
  `onAllXlsx`/`onFilteredXlsx`.
- `tests/mdh-xlsx-export-options.test.js` — options modal (sheet name, header,
  preview, columns handed back).
- `tests/mdh-xlsx-wizard.test.js` — new empty-`""` option + Trim toggle; updated
  hint text.

## 9. Implementation order & verification gates

1. `xlsxDates.js` + tests.
2. `xlsxWrite.js` (CRC, ZIP, parts, cells) + writer↔reader round-trip tests.
3. Reader date conversion + `emptyMode`/`trim` in `xlsx.js` + tests.
4. Engine binary-serializer protocol in `downloadCollection.js` + `buildXlsxSerializer`
   + tests (incl. text-path regression guard).
5. `XlsxExportOptions.jsx` + `DownloadSplitButton.jsx` + `DataPanel.jsx` /
   `RecordList.jsx` wiring + tests.
6. `XlsxImportWizard.jsx` parity options + tests.
7. `npm run build` (verify bundle, CSP-clean grep of `dist/console/console.js`
   for `eval`/`Function`), `npm test` (full suite green).
8. **Live verification on a dev org** (read-only-then-confirm): export a small
   collection to .xlsx, open it in Excel/LibreOffice and re-import it; confirm a
   `{$date}` value inserts as a real BSON date and round-trips. If `{$date}` does
   not store as a date, switch the import representation to an ISO string (writer
   unaffected) and note it.

## 10. Risks

- **ZIP/CRC/deflate correctness** is the highest-risk surface. Mitigated by the
  writer↔reader cross-check tests (the reader is independent, already trusted)
  and an external-tool open in step 8.
- **Streaming deflate pump** (CompressionStream readable/writable plumbing)
  ordering vs. the engine's in-order flush — kept inside the serializer; the
  engine only sees ordered `writeBytes` calls through the existing `flushChain`.
- **`{$date}` insert semantics** — strong evidence it works (EJSON `$oid` input
  is proven), but gated by step 8 with a documented fallback.
