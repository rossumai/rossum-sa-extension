# JSON Lines (NDJSON) import + export

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Add **JSON Lines / NDJSON** support to the MDH Dataset Management app — the mongo-native, line-delimited bulk-interchange format for a MongoDB-compatible store. **Import merges into the existing JSON importer** (auto-detect whole-file JSON vs. line-delimited); **export is a new sibling "JSON Lines" option** in the Download submenu. Pure native `JSON` — **zero dependencies, CSP-clean**.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Import wiring | **Merge into the existing "Insert from JSON file"** | `InsertFileWizard` already `JSON.parse`s the whole file (array, or a single object wrapped as `[obj]`); it only *fails* on NDJSON because a multi-object file isn't valid JSON. So NDJSON is a clean **fallback** when whole-file parse throws — existing behavior untouched. One entry, no new wizard. |
| Export wiring | **New sibling "JSON Lines" option** in the Download submenu | A JSON *array* and JSON *Lines* are different output bytes; the JSON download is a single click with no options. Can't merge into one button without an array/lines toggle (friction). So it sits *alongside* JSON/CSV/XML. |
| Parser | Native `JSON.parse` / `JSON.stringify` only | No custom parser, no library, zero-dep, CSP-clean. |
| Malformed line | **Skip + warn** (import the valid docs); hard `error` only if **zero** lines parse | mongoimport-like — one bad line shouldn't block a bulk load. Skipped-line warnings shown on the confirm stage. |
| Export streaming | **Streams** (`item = JSON.stringify(doc)`, `separator = '\n'`) | NDJSON's whole point — ideal for huge collections; no array-bracket buffering. |
| Naming | label **"JSON Lines (NDJSON)"**, export `.jsonl`, import accepts `.jsonl` + `.ndjson`, mime `application/x-ndjson` | Common conventions. |
| Beta | **Marked beta** — import entry relabelled **"From JSON/JSONL file"** + badge; export "JSON Lines" option + badge | Per decision. The relabel keeps the badge meaningful (it flags the new JSON-Lines capability, not stable JSON import). *Open for adjustment on review — e.g. badge only the export option + a "JSON Lines (beta)" note shown on import only when NDJSON is detected.* |

## 3. Verified facts (grounding)

- **`InsertFileWizard.handleFile`** (`src/mdh/components/InsertFileWizard.jsx:47-61`): `file.text()` → `JSON.parse(text)`; non-array → `[parsed]` (so a single object already imports as one doc); empty → error; then `analyzeDocs` → CONFIRM. It throws "Couldn't parse JSON" on an NDJSON file because the whole file isn't valid JSON — **the exact injection point for an NDJSON fallback.** The wizard is PICK → CONFIRM → IMPORTING → DONE (no options, no preview today); `StagePick` input `accept=".json,application/json"`.
- **Export serializer contract** (`downloadCollection.js`): `{ ext, mimeType, pickerTypes, init?, preamble(), item(doc), separator, postamble() }`, all sync; `buildJsonSerializer` uses `preamble:'[\n'`, `item: formatJsonDoc(doc)` (pretty), `separator:',\n'`, `postamble:'\n]\n'`. The JSON download (`downloadAll`/`downloadFiltered` in `DataPanel.jsx:424/447`) runs **directly with no options modal** (unlike CSV/XML).
- **`DownloadSplitButton`** renders a per-row flyout with JSON/CSV/XML buttons (`data-testid="download-<key>-<fmt>"`); adding a format = a prop pair + one button. CSV and XML options carry a `.toolbar-menu-beta` badge; JSON does not.
- **Data Storage is MongoDB-compatible**, documents are arbitrary JSON (`data-storage-reference/reference.md:3`, `:16`). Line-delimited JSON is the natural bulk interchange (mongoexport/mongoimport).

## 4. Import — merge NDJSON into `InsertFileWizard`

- New `src/mdh/ndjson.js` exporting a **pure** `parseNdjson(text) → { docs, warnings, error }`:
  - Split on `/\r?\n/`, trim, drop blank lines.
  - `JSON.parse` each line: a plain **object** → a doc; valid JSON that **isn't an object** (number/string/array) → skip + `warnings.push('Line N: not a JSON object, skipped')`; parse failure → skip + `warnings.push('Line N: invalid JSON, skipped')`.
  - Zero valid docs → `error: { message: 'No JSON or JSON Lines documents found' }`.
- **`InsertFileWizard.handleFile`** gains the fallback: keep the current `JSON.parse(text)` path (array / single object); in the `catch`, call `parseNdjson(text)` — on `error`, surface a combined message ("Couldn't parse as JSON or JSON Lines: …"); else set `docs` + stash `warnings`.
- **Skipped-line warnings:** stash `warnings` in state and render them on the **CONFIRM** stage (a small `⚠` list; reuse the import warning style). (First time this wizard surfaces warnings — a minor addition.)
- **`StagePick`** `accept` → `.json,.jsonl,.ndjson,application/json,application/x-ndjson`.
- **Menu/label:** the Insert item (`RecordList.jsx`) relabels to **"From JSON/JSONL file"** with a `beta` badge (action key unchanged — `insert-file`). Modal title (in `DataOperations`/wherever set) follows.
- Everything downstream (`analyzeDocs`/`dedupeById`/chunked insert+overwrite/stages) is unchanged. EJSON `$oid`/`$date` survive (they're literal JSON).

## 5. Export — `buildNdjsonSerializer`

- `buildNdjsonSerializer()` in `downloadCollection.js`:
  - `ext: 'jsonl'`, `mimeType: 'application/x-ndjson'`, `pickerTypes: [{ description: 'JSON Lines file', accept: { 'application/x-ndjson': ['.jsonl', '.ndjson'] } }]`.
  - `preamble: () => ''`, `item: (doc) => JSON.stringify(doc)` (compact, one object per line — preserves EJSON shapes), `separator: '\n'`, `postamble: () => ''`.
  - Streams incrementally through the existing pipeline.
- **`DownloadSplitButton`** gains `onAllJsonl`/`onFilteredJsonl` props + a flyout button `JSON Lines` (with a `beta` badge), `data-testid="download-<key>-jsonl"`.
- **`RecordList`** passes the callbacks → `onRefresh('download-jsonl')` / `onRefresh('download-filtered-jsonl')`.
- **`DataPanel`** adds `downloadAllJsonl`/`downloadFilteredJsonl` — **mirroring the direct (modal-less) JSON `downloadAll`/`downloadFiltered`**, but with `buildNdjsonSerializer()` and a `.jsonl` filename — plus the two action routes. No options modal.

## 6. Testing

- **`parseNdjson` (pure)** — unit: multiple objects → docs; blank lines skipped; CRLF; a bad line → skipped + warning (others import); a non-object line (`42`, `"x"`, `[…]`) → skipped + warning; all-bad → `error`.
- **`InsertFileWizard` (merged)** — a JSON **array** still imports (unchanged); a **single object** still imports; an **NDJSON** file now imports (was an error before); a `.jsonl` file is accepted; skipped-line warnings render on confirm; a truly junk file → combined error.
- **`buildNdjsonSerializer`** — `item` is compact single-line JSON, `\n` separator, empty preamble/postamble; EJSON (`{$oid}`) preserved; an export→`parseNdjson` round-trip reproduces the docs.
- **`DownloadSplitButton`** — a "JSON Lines" option (with beta badge) appears beside JSON/CSV/XML and fires `onAllJsonl`/`onFilteredJsonl`.
- **Menu** — the relabelled "From JSON/JSONL file" item carries a beta badge.
- **Build + CSP/zero-dep grep** — no `eval`/`new Function`; no new dependency.

## 7. Non-goals

- No NDJSON-specific import options (it's optionless typed JSON).
- No array-vs-lines toggle on the JSON download (kept frictionless; JSON Lines is its own option).
- Not changing the existing JSON array import/export behavior or bytes.
- YAML / Parquet (rejected earlier — would add the first runtime dependency).
