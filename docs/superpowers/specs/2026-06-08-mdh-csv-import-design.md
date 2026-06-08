# Dataset Management: "Insert from CSV file"

**Date:** 2026-06-08
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Add an "Insert from CSV file" feature to the Dataset Management (MDH) app, parallel to
the existing "Insert from JSON file". The user selects a CSV file, configures how it is
parsed and converted, sees a live preview, and inserts the resulting documents into the
**currently-selected Data Storage collection**.

## 2. Verified facts that constrain the design

- **The Data Storage API has no CSV ingest endpoint.** Confirmed by the user and by the
  bundled `data-storage-reference`: every write path (`insert_one`, `insert_many`,
  `bulk_write`) accepts JSON bodies only. CSV parsing must therefore happen **client-side**.
- A separate **MDH Datasets API** (`/svc/master-data-hub/api/v1/dataset/{name}`) does do
  server-side CSV/XLSX upload (`field_delimiter`, `quoting`, `quotechar`, `escapechar`,
  `text_qualifier`, `encoding`), but it manages whole *named datasets* (create/replace/merge),
  is async (202), and is capped at 50 MB. **Out of scope** — it is a different service and a
  different mental model than the app's per-collection insert. We are explicitly *not* using it.
- The existing JSON insert (`src/mdh/components/InsertFileWizard.jsx`) reads the file with
  `File.text()`, `JSON.parse()`s to an array of objects, and inserts into the selected
  collection via `runChunkedInsert` / `runChunkedOverwrite` (`src/mdh/importFile.js`) over
  `api.insertMany` (chunked at `BATCH_SIZE = 1000`, `ordered: false`). It has an Overwrite
  mode (delete-by-`_id` then insert), a progress bar, in-file dedup, and per-batch error
  reporting. **The CSV feature reuses all of this unchanged.**

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where data goes | Selected Data Storage collection, via the existing `insert_many` path | "Similar to Insert from JSON file"; reuse all chunked-insert machinery |
| Who parses CSV | Client-side, in the browser | No server CSV endpoint exists |
| Parser | Hand-rolled, dependency-free, dialect-configurable (`src/mdh/csv.js`) | Needs `escape_character` **and** `double_quote` as independent controls (Papa Parse can't toggle the `""`→`"` collapse); matches repo's minimal-dependency / CSP-clean ethos; trivially unit-testable |
| Type handling | Strings by default; opt-in **Infer types** toggle (integers, decimals, booleans) | Lossless default preserves leading zeros / IDs / phone numbers; convenience available on demand |
| Empty cell | Configurable: empty string `""` (default) / `null` / omit field | Different downstream needs; default `""` round-trips losslessly |

## 4. Data flow

```
CSV file
  → read + decode (TextDecoder with chosen encoding)   → text
  → tokenizeCsv(text, dialect)                          → string[][] rows
  → rowsToDocs(rows, conversionOpts)                    → JSON document objects
  → runChunkedInsert / runChunkedOverwrite (UNCHANGED)  → Data Storage insert_many
```

Once `rowsToDocs` yields an array of row-objects, the flow is **identical** to the JSON
feature: same chunked `insert_many` (1000/batch, `ordered:false`), same Overwrite mode,
same progress, same in-file dedup, same per-batch error reporting, same `onSuccess` refresh.

## 5. Options exposed (each explained inline in the UI)

### Parsing — how the CSV text is tokenized
| Option | Internal name | Default | UI explanation |
|---|---|---|---|
| Field delimiter | `delimiter` | `,` | Character between fields. Presets: comma `,`, semicolon `;`, tab, pipe `\|`, custom (single char). |
| Quote character | `quoteChar` | `"` | Wraps fields containing the delimiter, quotes, or line breaks. |
| Escape character | `escapeChar` | *(none)* | If set (e.g. `\`), the next char inside a quoted field is taken literally. |
| Double-quote | `doubleQuote` | `true` | When on, `""` inside a quoted field means one literal `"` (RFC 4180). Off if the file escapes quotes another way. |
| Encoding | `encoding` | `utf-8` | File text encoding. `windows-1252`/`latin-1` for legacy exports. Read via `TextDecoder` (so non-UTF-8 works — `File.text()` alone cannot). |

### Conversion — how rows become JSON documents
| Option | Internal name | Default | UI explanation |
|---|---|---|---|
| First row is a header | `hasHeader` | `true` | Use row 1 as field names. Off → `column_1`, `column_2`, … Duplicate headers suffixed (`name`, `name_2`). |
| Infer types | `inferTypes` | `false` | Off → every value is a string. On → detect integers, decimals, `true`/`false`. |
| Empty cell → | `emptyMode` | `"empty"` | `"empty"` (`""`), `"null"`, or `"omit"` (drop the field). |
| Skip empty lines | `skipEmptyLines` | `true` | Ignore blank lines in the file. |
| Trim values | `trim` | `false` | Strip leading/trailing whitespace around each value. |

- Line terminator (`\n` / `\r\n` / `\r`) is **auto-detected**, not a knob.
- An **`_id` column**, if present, becomes each document's `_id` (enabling Overwrite/dedup
  exactly like JSON). Otherwise Data Storage auto-generates an ObjectId.

## 6. Tokenizer specification (`tokenizeCsv`)

Single-pass character state machine over the decoded text. Parameters: `delimiter`,
`quoteChar`, `escapeChar` (nullable), `doubleQuote`, `skipEmptyLines`.

Rules:
1. Fields are split on `delimiter` **outside** quotes only.
2. Records are split on a line terminator **outside** quotes only. Auto-detect terminator:
   a `\r\n`, `\n`, or lone `\r` outside quotes ends a record (handle all three).
3. A field beginning with `quoteChar` is a **quoted field**; the opening quote is consumed.
   Inside a quoted field, `delimiter` and line terminators are literal data.
4. Closing a quoted field: a `quoteChar` ends it **unless**:
   - `doubleQuote` is on and the next char is also `quoteChar` → emit one literal `quoteChar`,
     consume both (the `""`→`"` collapse); **or**
   - `escapeChar` is set and the *previous* char was `escapeChar` → the quote is literal
     (handled by rule 5, so it never reaches here).
5. If `escapeChar` is set: inside a quoted field, `escapeChar` consumes itself and emits the
   **next** character literally (so `\"` → `"`, `\\` → `\`). Outside quotes, `escapeChar` is
   ordinary data.
6. `skipEmptyLines`: a record that is entirely empty (zero fields, or one empty unquoted
   field) is dropped. A row of empty quoted fields (`"",""`) is **kept** (it has explicit cells).
7. Returns `{ rows: string[][], error: { message, line } | null }`. Errors: unterminated
   quoted field at EOF → `error` set, `rows` may be partial. Caller blocks import on `error`.

`rowsToDocs(rows, { hasHeader, inferTypes, emptyMode, trim })`:
1. If `hasHeader`: first row → column names; `trim` applies to names; blank/duplicate names
   resolved (`""` → `column_N`; dup → `name`, `name_2`, …). Else: names are `column_1..N`
   where N = max field count across rows.
2. For each data row, map field `i` → `columns[i]`. Short rows: missing columns handled by
   `emptyMode`. Extra fields beyond the header (ragged, longer) get keys `column_{N+k}` and
   raise a warning.
3. Per cell: apply `trim`; then if the (possibly trimmed) value is `""` apply `emptyMode`
   (`""` keep, `null` set null, `omit` skip the key); else if `inferTypes`, apply
   `inferValue`; else keep the string.
4. `inferValue(s)` — conservative: `true`/`false` (case-insensitive, exact) → boolean;
   `/^-?\d+$/` with no leading zero (except `"0"`) → integer; `/^-?\d*\.\d+$/` or
   `/^-?\d+\.\d*$/` → float; otherwise **string**. Leading-zero strings (`"01234"`),
   anything with surrounding text, etc. stay strings even with inference on.
5. Returns `{ docs, columns, warnings }`. Warnings: ragged-row count + sample row numbers,
   duplicate-header renames, generated column names.

## 7. UX flow

Five stages, mirroring `InsertFileWizard`; only **CONFIGURE** is new:

```
PICK → CONFIGURE → CONFIRM → IMPORTING → DONE
```

- **PICK** — file input `accept=".csv,text/csv"`; drop zone identical in style to the JSON picker.
- **CONFIGURE** *(new)* — two option groups (Parsing, Conversion) + a **live preview**: a
  table of the first ~10 converted rows showing resulting values (strings quoted, numbers/`null`
  rendered distinctly so the effect of *Infer types* / *Empty cell* is visible), the column
  count, the total row count, and any warnings. The file is read **once** as an
  `ArrayBuffer` on entry; the three layers re-run only as far back as the changed option
  requires: changing **encoding** re-decodes (`TextDecoder`) → re-tokenizes → re-converts;
  changing a **parsing** option re-tokenizes → re-converts; changing a **conversion** option
  re-converts only. For very large files the preview may decode/parse a leading slice for
  responsiveness; the full decode+parse runs on **Next**.
  A blocking parse error shows the line number and disables **Next**.
- **CONFIRM** — reused from the JSON wizard: file/row summary, `_id` distribution
  (`analyzeDocs`), in-file dupes, conflict mode **Insert** vs **Overwrite**.
- **IMPORTING** — reused: progress bar, processed/total, inserted count, failed batches, Cancel.
- **DONE** — reused: success/partial/cancelled summary, failed-batch ranges, hints.

ASCII mockup of CONFIGURE:
```
┌─ Insert from CSV file ─────────────────────────────────────────┐
│ vendors.csv · 2,418 rows · 312 KB                              │
│ ┌─ Parsing ───────────────┐ ┌─ Convert to JSON ─────────────┐ │
│ │ Delimiter [ , ▾]        │ │ ☑ First row is a header       │ │
│ │ Quote char [ " ]        │ │ ☐ Infer types                 │ │
│ │ Escape char [   ]       │ │ Empty cell → [ "" ▾]          │ │
│ │ ☑ Double-quote          │ │ ☑ Skip empty lines            │ │
│ │ Encoding [ utf-8 ▾]     │ │ ☐ Trim values                 │ │
│ └─────────────────────────┘ └───────────────────────────────┘ │
│ Preview (first 10 of 2,418 rows · 5 columns)                   │
│ ┌────────┬───────────────┬─────────┬──────────┬─────────────┐  │
│ │ _id    │ name          │ vat_id  │ active   │ balance     │  │
│ │ "V001" │ "ACME s.r.o." │ "CZ123" │ "true"   │ "1024.50"   │  │
│ └────────┴───────────────┴─────────┴──────────┴─────────────┘  │
│ ⚠ 2 rows have a different column count than the header          │
│                                          [ Cancel ]  [ Next → ]│
└────────────────────────────────────────────────────────────────┘
```

## 8. Files

**New**
- `src/mdh/csv.js` — pure, DOM-free: `tokenizeCsv(text, dialect)`, `rowsToDocs(rows, opts)`,
  helpers `inferValue`, `dedupeHeaders`. The whole testable core.
- `src/mdh/components/CsvImportWizard.jsx` — the 5-stage wizard.
- `tests/mdh-csv.test.js` — unit tests (see §10).

**Refactor**
- `src/mdh/components/InsertFileWizard.jsx` — extract the shared CONFIRM (conflict mode +
  `FileSummary`), IMPORTING (`StageImporting`), DONE (`StageDone`) sub-components into a new
  `src/mdh/components/ImportStages.jsx`, imported by both wizards. No behavior change to JSON.

**Edit**
- `src/mdh/components/DataOperations.jsx` — route `insert-csv-file` → `<CsvImportWizard>`.
- `src/mdh/components/RecordList.jsx` — `SplitButton` menu gains "Insert from CSV file";
  generalize the dropdown to render N menu items instead of one.
- `src/mdh/components/DataPanel.jsx` — `handleToolbarAction` gains an `insert-csv-file` case.
- `console.css` — `.csv-*` styles for the option grid + preview table (match modal styling).

**Reused unchanged**
- `src/mdh/importFile.js` (`runChunkedInsert`/`runChunkedOverwrite`), `src/mdh/api.js`
  (`insertMany`/`deleteMany`/`find`), the modal system, `src/mdh/store.js`.

## 9. Error & edge handling

- Ragged rows → non-blocking warning + count (short rows padded per `emptyMode`; extra
  columns keyed `column_N`).
- Unterminated quote / malformed → blocking error with line number; **Next** disabled.
- Zero data rows after parsing → blocked with a clear message.
- Duplicate / blank header names → auto-resolved with a warning listing the renames.
- Encoding mismatch produces mojibake but never throws; user can switch encoding and the
  preview updates.
- Type inference is conservative (§6.4): never coerces leading-zero strings or mixed text.

## 10. Testing

`tests/mdh-csv.test.js` (vitest, `.test.js` + `h()` convention per repo):
- `tokenizeCsv`: plain rows; quoted fields with embedded delimiter; embedded newline in a
  quoted field; `""` collapse with `doubleQuote` on vs off; `escapeChar` (`\"`, `\\`);
  each delimiter preset (`,` `;` tab `|`); CRLF / LF / lone-CR terminators; `skipEmptyLines`
  on vs off; unterminated-quote → `error` with line number.
- `rowsToDocs`: header mapping; `hasHeader:false` → `column_N`; duplicate/blank header
  resolution; `inferTypes` (int / decimal / bool / leading-zero-stays-string / mixed-stays-string);
  all three `emptyMode` values; `trim`; `_id` column passthrough; ragged-row warnings.
- The insert path itself is already covered by `tests/mdh-import-file.test.js` and is reused
  unchanged — no new tests needed there.

## 11. Non-goals (YAGNI for v1)

- XLSX import (CSV only).
- The MDH Datasets server-side upload API.
- Comment-character and "skip N leading rows" options (auto-detect terminator covers the
  common cases; can be added later if requested).
- Streaming parse of multi-hundred-MB files (the existing JSON path also loads fully into
  memory; CSV matches that envelope, with a sampled preview for responsiveness).
- Column type/name mapping UI (rename/retype columns before import) — out of scope for v1.
