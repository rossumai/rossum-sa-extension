# XML import + export — custom zero-dependency, native DOM APIs

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with the user

## 1. Goal

Add **XML import and export** to the MDH Dataset Management app, mirroring the CSV/Excel importers and the CSV/JSON exporters. Parse and serialize XML using **only native browser Web APIs** — `DOMParser` (parse) and a small string builder (serialize) — so the feature is CSP-clean by construction (no `eval`/`new Function`, no Worker) and adds **zero dependencies**, consistent with the hand-rolled `csv.js` / `xlsx.js` pattern. Marked **beta**.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Direction | **Both import & export** | XML import is sync + library-free (DOMParser); XML export is plain text and **streams** through the existing serializer contract (unlike xlsx, which had to buffer). |
| Import mapping | **Record-list ONLY** | Auto-detect the repeating record element (+ override picker); each occurrence → one document. The direct analogue of CSV/xlsx rows. **The whole-document fallback mode is explicitly dropped** (per decision). |
| Parse | Native **`DOMParser`** (`'application/xml'`), **synchronous** | Already used in `xlsx.js`; CSP-clean; no ZIP/inflate. Sync → the Configure stage uses a `useMemo` like CSV (simpler than xlsx's async). |
| Serialize | Native string builder (XML-escaped), streamed | Fits `downloadCollection.js`'s sync `item(doc)` contract and writes incrementally like CSV/JSON. (`XMLSerializer` exists but a string builder gives tighter control over escaping + name sanitization.) |
| Library | **None** | `fast-xml-parser`/`xml2js` add a dependency for what `DOMParser` + a ~100-line walker do CSP-clean. |
| Preview | Reuse **`JsonTree.jsx`** | XML docs are nested; the flat `CsvPreview` table renders nested values as `[object Object]`. `JsonTree` (collapse/expand, type badges) renders flat *and* nested results. |
| Conventions | attrs → `@_name`, text → `#text`, repeated tags → arrays, **strip namespace prefixes**, **strings by default** (+ opt-in infer) | The settled fast-xml-parser/xml2js conventions; type inference reuses `csv.js`'s conservative `inferValue`. |
| UI status | **Marked beta** | New hand-rolled feature — badge the "From XML file" menu item + the import wizard, and a beta tag in the export options modal. |

## 3. Verified facts (grounding)

- **`DOMParser`** is a standard Web API, **already used CSP-clean** at `src/mdh/xlsx.js:69` (`new DOMParser().parseFromString(str, 'application/xml')`, with `<parsererror>` detection). `dist/console/console.js` greps to 0 `eval(`/`new Function`. No library needed; `XMLSerializer` is the symmetric native counterpart (not yet used).
- **The import seam is one function.** `parseCsv`/`parseXlsx` return `{ docs, columns, warnings, error }`; the post-parse tail — `analyzeDocs`, `dedupeById`, `runChunkedInsert`/`runChunkedOverwrite` (`importFile.js`), `StageConfirm`/`StageImporting`/`StageDone` (`ImportStages.jsx`) — is **format-agnostic and accepts arbitrary nested-object docs unchanged**.
- **The export serializer contract** (`downloadCollection.js`): `{ ext, mimeType, pickerTypes, init?, preamble(): string, item(doc): string, separator: string, postamble(): string }`. `preamble`/`item`/`postamble` are **synchronous**; `item(doc)` is concatenated per-doc into the streamed buffer. A plain-text XML serializer (`preamble = '<?xml…?>\n<records>'`, `item = '<record>…</record>'`, `separator = '\n'`, `postamble = '</records>'`) **satisfies the contract and streams incrementally** like CSV/JSON.
- **`JsonTree.jsx`** renders nested objects/arrays (collapse/expand, type badges, auto-collapse beyond a field threshold); used by `RecordCard`. Reusable for the import preview.
- **XML Name rules (W3C XML 1.0):** first char must be a letter or `_` (NOT a digit/`.`/`-`); `_id` is valid (leading underscore legal); `$`, space, and (reserved) `:` are invalid; names starting with `xml` (any case) are reserved. → an export key-sanitizer is required; EJSON keys like `$oid`/`$date` get rewritten (**lossy round-trip — surfaced in the UI**).
- **`DOMParser` does not throw on malformed XML** — it returns a Document containing a `<parsererror>` element; must check it (as `xlsx.js` does) and return the standard `{ error }` shape.

## 4. Import architecture

### 4.1 `src/mdh/xml.js` (sync, native, zero-dep)

```
parseXml(input, { recordKey, inferTypes }) → { docs, columns, warnings, error, recordCandidates }
```
- `input`: an `ArrayBuffer` (decoded UTF-8 → string) or a string. Returns the `parseCsv` shape **plus** `recordCandidates` (for the picker). On `<parsererror>` or any failure → `{ docs:[], columns:[], warnings:[], error:{ message }, recordCandidates:[] }`.
- Internal, individually-testable pieces:
  - `detectRecords(doc, recordKey?) → { records: Element[], candidates }` — the record-element heuristic (§4.2).
  - `elementToValue(el, { inferTypes }) → object|string|...` — element → JS value via the conventions (§4.3). **Pure-ish** (operates on a DOM node).
  - `toDocs(records, { inferTypes }) → { docs, columns, warnings }` — map record elements → docs, compute the column union, collect warnings.

### 4.2 Record-element detection (+ picker)

Heuristic (overridable):
1. For every element `E`, group its direct child **elements** by local name; `bestRepeat(E)` = the largest group size.
2. `recordContainer` = the element with the largest `bestRepeat` (ties → shallowest); `recordTag` = that group's tag; **records** = that group's elements.
3. If nothing repeats (`maxBestRepeat ≤ 1`): records = the root's direct child **elements** (each → one doc); if the root has none, records = `[root]` (one doc).
4. `recordCandidates` = every element group with size ≥ 2, as `{ key, label: '<tag> (×N, under <parent>)', count }`, plus a "root children" entry; the auto-detected one is the default. `recordKey` overrides the selection.

### 4.3 Element → value conventions

- **Attributes** → keys `@_<localName>` (namespace prefix stripped).
- **Child elements** (grouped by local name, prefix stripped): a tag occurring **>1 time** → an **array**; occurring once → its value.
- **Text:** an element with no child elements and no attributes → its (trimmed) text is the value; an element that has children/attributes **and** non-whitespace text → a `#text` key; whitespace-only text alongside children is ignored.
- **Leaf values:** strings by default; with **Infer types** on, run `csv.js`'s `inferValue` (conservative — leading-zero IDs / oversized ints / signed-scientific stay strings).
- **Empty element** (`<a/>` / whitespace-only, no attrs/children) → `null`.
- **Namespace prefixes stripped** by default; if stripping collapses distinct names into one key → a **warning** (collision).
- **`columns`** = union of top-level keys across docs (first-appearance order) — drives the meta count + `analyzeDocs`. `_id`, if present, flows through for dedupe/overwrite exactly like CSV/xlsx.

### 4.4 Preview — `JsonTree`

XML docs are nested, so a new lightweight `XmlPreview` renders a **sample** of `parsed.docs` (e.g. first 10) via the existing **`JsonTree`** (verify its exact props in the plan — `data`, collapse depth), plus a meta line (doc/column counts) and warnings. (Flat record-lists render as small trees; no `[object Object]`.)

### 4.5 Import wizard — `XmlImportWizard.jsx`

Mirrors `CsvImportWizard` (pick → configure → confirm → importing → done):
- **PICK:** `<input accept=".xml">` → `file.arrayBuffer()` → CONFIGURE. Beta tag.
- **CONFIGURE:** options + live `useMemo(parseXml)` preview. Options: **Record element** picker (from `recordCandidates`, default auto-detected) + **Infer types** toggle (default off). Beta tag. Preview = `XmlPreview` (`JsonTree`).
- **CONFIRM / IMPORTING / DONE:** reuse `ImportStages` verbatim; import via `dedupeById` + `runChunkedInsert`/`runChunkedOverwrite`.

## 5. Export architecture

### 5.1 `buildXmlSerializer({ rootName, recordName })` in `downloadCollection.js`

Mirrors `buildCsvSerializer`/`buildJsonSerializer`:
- `ext: 'xml'`, `mimeType: 'application/xml'`, `pickerTypes: [{ description: 'XML file', accept: { 'application/xml': ['.xml'] } }]`, no `init`.
- `preamble()` → `'<?xml version="1.0" encoding="UTF-8"?>\n<' + rootName + '>'` (default `rootName='records'`).
- `item(doc)` → `'<' + recordName + '>' + fields + '</' + recordName + '>'` (default `recordName='record'`), where each `[key,value]` → `valueToXml(toXmlName(key), value)`.
- `separator: '\n'`, `postamble()` → `'</' + rootName + '>'`.

### 5.2 Object → XML (elements-only)

- `valueToXml(name, value)`: `null`/`undefined` → `<name/>`; **array** → one `<name>…</name>` per item; **object** → `<name>` + nested fields + `</name>`; **primitive** → `<name>` + `escapeXml(String(value))` + `</name>`.
- `escapeXml(text)` → replace `&`, `<`, `>` (element text; elements-only means no attribute quoting needed).
- `toXmlName(key)` (pure): replace chars outside `[A-Za-z0-9_.\-]` with `_`; empty → `_`; if it starts with a non-`[A-Za-z_]` (digit/`.`/`-`) prefix `_`; if it starts with `xml` (any case) prefix `_`. **`_id` is unchanged**; `$oid`/`$date` → `_oid`/`_date` (the lossy-round-trip caveat).

### 5.3 Export options modal — `XmlExportOptions.jsx`

Mirrors `CsvExportOptions`: editable **root** / **record** element-name inputs (defaults `records` / `record`) + a **live XML-text preview** of a sample (reuse the `loadPreview` pattern — an `aggregate([..., { $limit: 10 }])` sample serialized with `buildXmlSerializer`, shown in a monospace `<pre>`). A **beta** tag in the header. Download closes the modal and runs `runDownloadJob` with the serializer.

## 6. Wiring + beta

- **Import:** `RecordList.jsx` "From XML file" menu item (`beta: true`) → `DataPanel` route `'insert-xml-file'` → `DataOperations` op `'insert-xml'` → `<XmlImportWizard>` (modal title "Insert from XML file"). Mirrors xlsx exactly.
- **Export:** `DownloadSplitButton.jsx` gains `onAllXml`/`onFilteredXml` + an **XML** option beside JSON/CSV; `RecordList` passes them through; `DataPanel` adds `downloadAllXml`/`downloadFilteredXml` (open `XmlExportOptions`, then `runDownloadJob` with `buildXmlSerializer`) and routes `'download-xml'`/`'download-filtered-xml'`.
- **Beta:** reuse `.toolbar-menu-beta` — on the import menu item + both wizard stages, and a tag in the export options modal header. (Consistent with the CSV and Excel imports, which are also beta-badged.)

## 7. Testing strategy

- **`toXmlName` / `escapeXml` / `valueToXml` (pure)** — unit: `_id` unchanged, `$oid`→`_oid`, leading-digit/`xml`/space/`$` handling; `& < >` escaping; null→`<x/>`, array→repeated, nested object→nested elements, primitives.
- **`elementToValue` / `toDocs` / `detectRecords`** — unit (jsdom `DOMParser`): attributes→`@_`, `#text`, repeated→array, namespace strip + collision warning, infer-types off/on, empty→null, auto-detect + `recordKey` override + the no-repeat fallback, column union, `_id` passthrough.
- **`parseXml`** — integration: a record-list XML → expected docs/columns/recordCandidates; a wrapped/nested list (drill-down via `recordKey`); malformed XML → `{ error }`.
- **`buildXmlSerializer`** — `preamble`/`item`/`postamble` output; escaping; nested/array/null; name sanitization; a parse→serialize→re-parse shape check (noting the `$`-key caveat).
- **`XmlImportWizard`** — pick → `JsonTree` preview renders (condition-based `waitFor`), record-element picker + infer toggle re-parse, Next gating, beta tag.
- **`XmlExportOptions`** — live preview renders the sample XML, root/record inputs change it, Download passes the serializer; beta tag.
- **Wiring** — menu beta badge on the XML item; `DataOperations` dispatch + title; download-menu XML option.
- **Build + CSP grep** (`eval`/`new Function`/`WebAssembly` = 0; no `new Worker`/`blob:` introduced; zero deps in `package.json`).

## 8. Non-goals

- **Whole-document import mode** (explicitly dropped — record-list only).
- Attributes on **export** (elements-only), XML Schema/DTD validation, formula/CDATA-preservation, comments/PI/mixed-content fidelity.
- **Streaming parse** (DOMParser loads the whole tree in memory — same as xlsx).
- Non-UTF-8 encodings (v1 assumes UTF-8).

## 9. Open risks

- **EJSON `$`-key round-trip is lossy** on export (`$oid`/`$date` → `_oid`/`_date`); surfaced as a UI note. (Optional later: special-case EJSON.)
- **Namespace stripping is lossy** — `a:item` + `b:item` → `item` collide; warn on collision; "keep prefixes" is a possible later opt-out.
- **Record auto-detection is heuristic** — real-world XML varies (SOAP/RSS/custom); the override picker + the no-repeat fallback mitigate, but odd shapes may need manual selection.
- **Non-streaming parse** — a very large XML builds a full DOM in memory (chunked insert still bounds upload).
- **`parsererror` detection** is a de-facto convention (engine-dependent); fine for a Chrome extension.
