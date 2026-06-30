# Excel (.xlsx) Import/Export Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add streamed Excel (.xlsx) export and fix Excel import date handling, bringing .xlsx to full parity with the JSON/JSONL/CSV/XML import+export already in the MDH app.

**Architecture:** A hand-rolled, dependency-free .xlsx *writer* (ZIP + OOXML, symmetric to the existing `xlsx.js` reader) plugged into the existing streamed `downloadCollection.js` engine via a new binary-serializer protocol. The reader gains `styles.xml`/`date1904` parsing so date cells import as EJSON `{$date}`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, minify), vitest + jsdom. Native Web APIs only: `CompressionStream`/`DecompressionStream('deflate-raw')`, `DOMParser`, `TextEncoder`/`TextDecoder`.

## Global Constraints

- **No new npm dependency.** Writer is hand-rolled on native Web APIs.
- **CSP-clean.** No `eval`, no `new Function`, no `Worker`. (Verified by grep of `dist/console/console.js` in the final task.)
- **No git commits during this run.** Each task ends with `npm test` (full suite) as its checkpoint. Work stays on `master`, no branches/worktrees. (User standing instruction — overrides the skill's commit step.)
- **No Co-Authored-By trailer** anywhere (no commits anyway).
- **Tests:** vitest, files `tests/**/*.test.js`, jsdom env via `// @vitest-environment jsdom` when DOM/Web-API is needed. Components rendered with `h(Component, props)` — never raw JSX inside `.test.js` (oxc breaks on it). Use `vi.mock` for module mocks.
- **EJSON cell mapping must match `csv.js#csvCell`** exactly (objects/arrays/`$oid`/`$numberLong` → string via `formatEjsonValue`/`JSON.stringify`).
- **Excel epoch:** 1900 system constant `25569`, 1904 system constant `24107` (days to 1970-01-01). Correct for all dates ≥ 1900-03-01.
- **Existing text serializers (JSON/CSV/XML/NDJSON) output must stay byte-for-byte identical** after the engine change.

---

## File Structure

**Create:**
- `src/mdh/xlsxDates.js` — pure date↔serial conversion + date-format detection (shared by reader & writer).
- `src/mdh/xlsxWrite.js` — pure ZIP/CRC primitives, OOXML part builders, cell encoders, and `buildXlsxSerializer` (streaming binary serializer).
- `src/mdh/components/XlsxExportOptions.jsx` — export options + preview modal (mirrors `CsvExportOptions.jsx`).
- `tests/mdh-xlsx-dates.test.js`, `tests/mdh-xlsx-write.test.js`, `tests/mdh-xlsx-export-options.test.js`.

**Modify:**
- `src/mdh/xlsx.js` — reader: parse `styles.xml` + `date1904`; date cells → `{$date}`; `rowsToDocs` gains `emptyMode:'empty'` + `trim`.
- `src/mdh/downloadCollection.js` — `writeChunk` accepts bytes; binary-serializer protocol; re-export `buildXlsxSerializer`.
- `src/mdh/components/DownloadSplitButton.jsx` — Excel item + `onAllXlsx`/`onFilteredXlsx` props.
- `src/mdh/components/DataPanel.jsx` — `downloadAllXlsx`/`downloadFilteredXlsx` handlers + `download-xlsx`/`download-filtered-xlsx` routing.
- `src/mdh/components/RecordList.jsx` — wire the two new `DownloadSplitButton` props.
- `src/mdh/components/XlsxImportWizard.jsx` — empty-`""` option + Trim toggle; remove the now-false serial-number hints.
- `tests/mdh-xlsx.test.js`, `tests/mdh-download-collection.test.js`, `tests/mdh-download-dropdown.test.js`, `tests/mdh-xlsx-wizard.test.js` — extend.

---

## Task 1: Date/serial conversion (`xlsxDates.js`)

**Files:**
- Create: `src/mdh/xlsxDates.js`
- Test: `tests/mdh-xlsx-dates.test.js`

**Interfaces:**
- Produces:
  - `serialToDate(serial: number, opts?: { date1904?: boolean }) → Date`
  - `dateToSerial(date: Date, opts?: { date1904?: boolean }) → number`
  - `isDateFormat(numFmtId: number, formatCode?: string) → boolean`
  - `BUILTIN_DATE_FMT_IDS: Set<number>`

- [ ] **Step 1: Write the failing test** — `tests/mdh-xlsx-dates.test.js`

```js
import { describe, it, expect } from 'vitest';
import { serialToDate, dateToSerial, isDateFormat, BUILTIN_DATE_FMT_IDS } from '../src/mdh/xlsxDates.js';

describe('serial <-> date (1900 system)', () => {
  it('maps 45292 to 2024-01-01 UTC', () => {
    expect(serialToDate(45292).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
  it('round-trips a date through a serial', () => {
    const d = new Date('2024-01-15T00:00:00.000Z');
    expect(dateToSerial(d)).toBe(45306);
    expect(serialToDate(45306).toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });
  it('handles fractional time-of-day', () => {
    // 0.5 day = 12:00
    expect(serialToDate(45292.5).toISOString()).toBe('2024-01-01T12:00:00.000Z');
  });
});

describe('serial <-> date (1904 system)', () => {
  it('is offset by 1462 days', () => {
    expect(serialToDate(45292 - 1462, { date1904: true }).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(dateToSerial(new Date('2024-01-01T00:00:00.000Z'), { date1904: true })).toBe(45292 - 1462);
  });
});

describe('isDateFormat', () => {
  it('treats builtin date ids as dates', () => {
    for (const id of [14, 15, 16, 17, 22, 45, 46, 47]) expect(isDateFormat(id)).toBe(true);
    expect(BUILTIN_DATE_FMT_IDS.has(14)).toBe(true);
  });
  it('treats builtin general/number ids as not dates', () => {
    for (const id of [0, 1, 2, 3, 4, 9, 10, 49]) expect(isDateFormat(id)).toBe(false);
  });
  it('detects date tokens in a custom format code', () => {
    expect(isDateFormat(164, 'yyyy-mm-dd hh:mm:ss')).toBe(true);
    expect(isDateFormat(165, 'dd/mm/yyyy')).toBe(true);
  });
  it('ignores tokens inside quotes / brackets / escapes for non-date custom codes', () => {
    expect(isDateFormat(166, '#,##0.00')).toBe(false);
    expect(isDateFormat(167, '"days: "0')).toBe(false);   // quoted text only
    expect(isDateFormat(168, '0.0%')).toBe(false);
    expect(isDateFormat(169, '[Red]-#,##0')).toBe(false); // bracket section only
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-dates.test.js`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement `src/mdh/xlsxDates.js`**

```js
// Pure Excel date helpers, shared by the .xlsx reader (xlsx.js) and writer
// (xlsxWrite.js). Excel stores a date as a number (a "serial") + a display
// number-format; the serial is days since the system epoch. The 1900-system
// constant 25569 coincides with the Excel serial of the Unix epoch, so it is
// correct for every date >= 1900-03-01 (the pre-1900-03-01 Excel leap-year-bug
// region is not corrected — no real master data lives there).

const MS_PER_DAY = 86400000;
export const EPOCH_1900 = 25569; // days from 1899-12-30 to 1970-01-01
export const EPOCH_1904 = 24107; // days from 1904-01-01 to 1970-01-01

export function serialToDate(serial, { date1904 = false } = {}) {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  return new Date(Math.round((serial - epoch) * MS_PER_DAY));
}

export function dateToSerial(date, { date1904 = false } = {}) {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  return date.getTime() / MS_PER_DAY + epoch;
}

// Builtin number-format ids that represent dates/times (ECMA-376 §18.8.30).
export const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

// A custom format (numFmtId >= 164) is a date if, after removing quoted
// literals, escaped chars, and bracketed sections (colors/locales/conditions),
// it still contains a y/m/d/h/s token.
export function isDateFormat(numFmtId, formatCode) {
  if (BUILTIN_DATE_FMT_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')   // quoted literals
    .replace(/\\./g, '')        // escaped char
    .replace(/\[[^\]]*\]/g, ''); // [Red], [$-409], [>0] ...
  return /[ymdhs]/i.test(stripped);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-xlsx-dates.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS (no regressions).

---

## Task 2: ZIP/CRC primitives + column helpers (`xlsxWrite.js`, part 1)

**Files:**
- Create: `src/mdh/xlsxWrite.js`
- Test: `tests/mdh-xlsx-write.test.js`

**Interfaces:**
- Produces:
  - `crc32(bytes: Uint8Array, seed?: number) → number` (final XORed CRC when called once on full data)
  - `indexToCol(index: number) → string` (`0→'A'`, `26→'AA'`)
  - `sanitizeSheetName(name: string) → string`
  - `localHeader({ name, method, flag, crc, compSize, uncompSize }) → Uint8Array`
  - `dataDescriptor({ crc, compSize, uncompSize }) → Uint8Array`
  - `centralHeader({ name, method, flag, crc, compSize, uncompSize, offset }) → Uint8Array`
  - `eocd({ count, cdSize, cdOffset }) → Uint8Array`

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-xlsx-write.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { crc32, indexToCol, sanitizeSheetName, localHeader, eocd } from '../src/mdh/xlsxWrite.js';

describe('crc32', () => {
  it('matches the standard vector for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes) >>> 0).toBe(0xcbf43926);
  });
  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0)) >>> 0).toBe(0);
  });
});

describe('indexToCol', () => {
  it('maps 0-based column index to A1 letters', () => {
    expect(indexToCol(0)).toBe('A');
    expect(indexToCol(25)).toBe('Z');
    expect(indexToCol(26)).toBe('AA');
    expect(indexToCol(27)).toBe('AB');
    expect(indexToCol(701)).toBe('ZZ');
  });
});

describe('sanitizeSheetName', () => {
  it('strips illegal chars and clamps to 31 chars', () => {
    expect(sanitizeSheetName('a/b:c?d*[e]')).toBe('a_b_c_d__e_');
    expect(sanitizeSheetName('x'.repeat(40)).length).toBe(31);
    expect(sanitizeSheetName('')).toBe('Sheet1');
  });
});

describe('zip records', () => {
  it('localHeader starts with the local-file signature', () => {
    const h = localHeader({ name: 'a.xml', method: 0, flag: 0, crc: 0, compSize: 0, uncompSize: 0 });
    const dv = new DataView(h.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(26, true)).toBe(new TextEncoder().encode('a.xml').length); // name length
  });
  it('eocd starts with the end-of-central-directory signature', () => {
    const e = eocd({ count: 1, cdSize: 10, cdOffset: 20 });
    const dv = new DataView(e.buffer);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(1); // total records
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-write.test.js`
Expected: FAIL — module/exports undefined.

- [ ] **Step 3: Implement part 1 of `src/mdh/xlsxWrite.js`**

```js
// Hand-rolled, dependency-free .xlsx (OOXML) writer — symmetric to the reader
// in xlsx.js. ZIP framing + CRC-32 + minimal OOXML parts, native APIs only
// (CSP-clean). The big worksheet is deflated via CompressionStream('deflate-raw')
// and streamed with a ZIP data descriptor; the small metadata parts are stored.

const ENC = new TextEncoder();

// --- CRC-32 (polynomial 0xEDB88320) ---------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Update a running CRC (pre-final, i.e. NOT XORed). Seed with 0 for a fresh run.
export function crc32Update(running, bytes) {
  let c = running ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// One-shot final CRC for a full buffer.
export function crc32(bytes, seed = 0) {
  return crc32Update(seed, bytes);
}

// --- A1 column letters (inverse of xlsx.js#colToIndex) ---------------------
export function indexToCol(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// --- Excel worksheet-name rules: <=31 chars, no : \ / ? * [ ], non-empty ---
export function sanitizeSheetName(name) {
  const cleaned = String(name == null ? '' : name).replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
  return cleaned.length ? cleaned : 'Sheet1';
}

// --- ZIP records -----------------------------------------------------------
function u16(dv, off, v) { dv.setUint16(off, v & 0xffff, true); }
function u32(dv, off, v) { dv.setUint32(off, v >>> 0, true); }

const DOS_TIME = 0;       // 00:00:00
const DOS_DATE = 0x21;    // 1980-01-01 (year 0 => 1980, month 1, day 1)

export function localHeader({ name, method, flag, crc, compSize, uncompSize }) {
  const nameBytes = ENC.encode(name);
  const buf = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x04034b50);
  u16(dv, 4, 20);          // version needed
  u16(dv, 6, flag);
  u16(dv, 8, method);
  u16(dv, 10, DOS_TIME);
  u16(dv, 12, DOS_DATE);
  u32(dv, 14, crc);
  u32(dv, 18, compSize);
  u32(dv, 22, uncompSize);
  u16(dv, 26, nameBytes.length);
  u16(dv, 28, 0);          // extra len
  buf.set(nameBytes, 30);
  return buf;
}

export function dataDescriptor({ crc, compSize, uncompSize }) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x08074b50);  // optional but widely expected signature
  u32(dv, 4, crc);
  u32(dv, 8, compSize);
  u32(dv, 12, uncompSize);
  return buf;
}

export function centralHeader({ name, method, flag, crc, compSize, uncompSize, offset }) {
  const nameBytes = ENC.encode(name);
  const buf = new Uint8Array(46 + nameBytes.length);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x02014b50);
  u16(dv, 4, 20);          // version made by
  u16(dv, 6, 20);          // version needed
  u16(dv, 8, flag);
  u16(dv, 10, method);
  u16(dv, 12, DOS_TIME);
  u16(dv, 14, DOS_DATE);
  u32(dv, 16, crc);
  u32(dv, 20, compSize);
  u32(dv, 24, uncompSize);
  u16(dv, 28, nameBytes.length);
  u16(dv, 30, 0);          // extra
  u16(dv, 32, 0);          // comment
  u16(dv, 34, 0);          // disk start
  u16(dv, 36, 0);          // internal attrs
  u32(dv, 38, 0);          // external attrs
  u32(dv, 42, offset);
  buf.set(nameBytes, 46);
  return buf;
}

export function eocd({ count, cdSize, cdOffset }) {
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  u32(dv, 0, 0x06054b50);
  u16(dv, 4, 0);           // this disk
  u16(dv, 6, 0);           // cd start disk
  u16(dv, 8, count);       // records on this disk
  u16(dv, 10, count);      // total records
  u32(dv, 12, cdSize);
  u32(dv, 16, cdOffset);
  u16(dv, 20, 0);          // comment len
  return buf;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-xlsx-write.test.js`
Expected: PASS.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 3: OOXML parts + cell encoders (`xlsxWrite.js`, part 2)

**Files:**
- Modify: `src/mdh/xlsxWrite.js`
- Test: `tests/mdh-xlsx-write.test.js`

**Interfaces:**
- Consumes: `indexToCol` (Task 2), `getEjsonType`/`formatEjsonValue` from `./displayValue.js`, `dateToSerial` from `./xlsxDates.js`.
- Produces:
  - `escapeXmlText(s) → string`
  - `cellXml(value, ref) → string` (one `<c>…</c>`; `''` for null/undefined → cell omitted)
  - `rowXml(rowIndex0, values) → string`
  - `CONTENT_TYPES_XML`, `ROOT_RELS_XML`, `WB_RELS_XML`, `STYLES_XML` (constants)
  - `workbookXml(sheetName) → string`
  - `SHEET_HEAD`, `SHEET_TAIL` (worksheet XML head/tail strings)
  - `DATE_STYLE_IDX = 1`

- [ ] **Step 1: Write the failing test** (append)

```js
import { cellXml, rowXml, escapeXmlText, workbookXml, STYLES_XML } from '../src/mdh/xlsxWrite.js';

describe('cellXml', () => {
  it('encodes a string as an inline string', () => {
    expect(cellXml('hi', 'A1')).toBe('<c r="A1" t="inlineStr"><is><t xml:space="preserve">hi</t></is></c>');
  });
  it('escapes XML metacharacters in strings', () => {
    expect(escapeXmlText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
  it('encodes a finite number as a numeric cell', () => {
    expect(cellXml(42, 'B2')).toBe('<c r="B2"><v>42</v></c>');
  });
  it('encodes a boolean', () => {
    expect(cellXml(true, 'C1')).toBe('<c r="C1" t="b"><v>1</v></c>');
    expect(cellXml(false, 'C2')).toBe('<c r="C2" t="b"><v>0</v></c>');
  });
  it('encodes an EJSON $date as a date-styled serial cell', () => {
    expect(cellXml({ $date: '2024-01-01T00:00:00.000Z' }, 'D1')).toBe('<c r="D1" s="1"><v>45292</v></c>');
  });
  it('omits null / undefined cells', () => {
    expect(cellXml(null, 'E1')).toBe('');
    expect(cellXml(undefined, 'E1')).toBe('');
  });
  it('stringifies objects/arrays and EJSON $oid like csvCell', () => {
    expect(cellXml({ $oid: 'abc' }, 'F1')).toBe('<c r="F1" t="inlineStr"><is><t xml:space="preserve">abc</t></is></c>');
    expect(cellXml({ a: 1 }, 'G1')).toBe('<c r="G1" t="inlineStr"><is><t xml:space="preserve">{"a":1}</t></is></c>');
  });
});

describe('rowXml', () => {
  it('builds a row, skipping omitted cells', () => {
    expect(rowXml(0, ['x', null, 3])).toBe('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">x</t></is></c><c r="C1"><v>3</v></c></row>');
  });
});

describe('static parts', () => {
  it('workbookXml embeds the sheet name', () => {
    expect(workbookXml('Data')).toContain('name="Data"');
  });
  it('STYLES_XML defines a date number format and two cellXfs', () => {
    expect(STYLES_XML).toContain('numFmtId="164"');
    expect(STYLES_XML).toContain('<cellXfs count="2">');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-write.test.js`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Append the part-2 implementation to `src/mdh/xlsxWrite.js`**

```js
import { getEjsonType, formatEjsonValue } from './displayValue.js';
import { dateToSerial } from './xlsxDates.js';

export const DATE_STYLE_IDX = 1;

// Escape XML text content and drop chars illegal in XML 1.0 (keep \t \n \r).
export function escapeXmlText(s) {
  return String(s)
    .replace(/[ --]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineStr(ref, s) {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(s)}</t></is></c>`;
}

// One cell. Mapping is symmetric with csv.js#csvCell: EJSON $date -> date cell,
// everything else non-scalar -> its human string. null/undefined -> '' (cell omitted).
export function cellXml(value, ref) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return inlineStr(ref, String(value));
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    if (ejson === '$date') {
      const iso = formatEjsonValue(value, ejson);
      const serial = dateToSerial(new Date(iso));
      return `<c r="${ref}" s="${DATE_STYLE_IDX}"><v>${serial}</v></c>`;
    }
    const s = ejson ? formatEjsonValue(value, ejson) : JSON.stringify(value);
    return inlineStr(ref, s);
  }
  return inlineStr(ref, String(value));
}

export function rowXml(rowIndex0, values) {
  const r = rowIndex0 + 1;
  let cells = '';
  for (let c = 0; c < values.length; c++) cells += cellXml(values[c], `${indexToCol(c)}${r}`);
  return `<row r="${r}">${cells}</row>`;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const CONTENT_TYPES_XML = XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

export const ROOT_RELS_XML = XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

export const WB_RELS_XML = XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

export const STYLES_XML = XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm:ss"/></numFmts>' +
  '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs></styleSheet>';

export function workbookXml(sheetName) {
  return XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXmlText(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

export const SHEET_HEAD = XML_DECL +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
export const SHEET_TAIL = '</sheetData></worksheet>';
```

> Note: `STYLES_XML` escapes the literal `-` in the date format code as `\\-` (a single backslash in the emitted XML) so Excel does not treat it as a number-format minus.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-xlsx-write.test.js`
Expected: PASS.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 4: Streaming binary serializer (`buildXlsxSerializer`)

**Files:**
- Modify: `src/mdh/xlsxWrite.js`
- Test: `tests/mdh-xlsx-write.test.js`

**Interfaces:**
- Consumes: all of Task 2/3; `./xlsx.js` reader (`unzip`, `parseXlsx`) for the round-trip test.
- Produces: `buildXlsxSerializer({ sheetName?, header?=true, columns?=null }) → serializer`
  - serializer fields: `binary: true`, `ext: 'xlsx'`, `mimeType`, `pickerTypes`,
    `async start(writeBytes, { collectionName, pipelineStages })`,
    `async writeDocs(docs, writeBytes)`, `async finish(writeBytes)`.
  - `writeBytes(chunk: Uint8Array)` is supplied by the engine; the serializer
    encodes strings to bytes itself and tracks the running byte offset.

- [ ] **Step 1: Write the failing round-trip test** (append)

```js
import { buildXlsxSerializer } from '../src/mdh/xlsxWrite.js';
import { parseXlsx } from '../src/mdh/xlsx.js';

// Drive the serializer like the engine does, collecting bytes, then read the
// result back with the independent reader.
async function buildWorkbook(docs, columns, opts = {}) {
  const ser = buildXlsxSerializer({ sheetName: 'Data', columns, ...opts });
  const parts = [];
  const writeBytes = async (chunk) => {
    parts.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
  };
  await ser.start(writeBytes, { collectionName: 'c', pipelineStages: [{ $match: {} }] });
  await ser.writeDocs(docs, writeBytes);
  await ser.finish(writeBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

describe('buildXlsxSerializer round-trip (writer -> reader)', () => {
  it('round-trips strings, numbers, booleans and dates', async () => {
    const docs = [
      { name: 'Alice', age: 30, active: true, joined: { $date: '2024-01-01T00:00:00.000Z' } },
      { name: 'Bob', age: 25, active: false, joined: { $date: '2024-01-15T00:00:00.000Z' } },
    ];
    const buf = await buildWorkbook(docs, ['name', 'age', 'active', 'joined']);
    const { docs: back, columns, error } = await parseXlsx(buf, { hasHeader: true, emptyMode: 'omit' });
    expect(error).toBe(null);
    expect(columns).toEqual(['name', 'age', 'active', 'joined']);
    expect(back[0]).toEqual({ name: 'Alice', age: 30, active: true, joined: { $date: '2024-01-01T00:00:00.000Z' } });
    expect(back[1]).toEqual({ name: 'Bob', age: 25, active: false, joined: { $date: '2024-01-15T00:00:00.000Z' } });
  });

  it('omits the header row when header:false', async () => {
    const buf = await buildWorkbook([{ a: 1 }], ['a'], { header: false });
    const { docs } = await parseXlsx(buf, { hasHeader: false });
    expect(docs[0]).toEqual({ column_1: 1 });
  });
});
```

> This test requires Task 5 (reader date conversion) to assert the `{$date}`
> values. Run it after Task 5; until then, assert only the non-date fields.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-write.test.js -t round-trip`
Expected: FAIL — `buildXlsxSerializer` undefined.

- [ ] **Step 3: Append `buildXlsxSerializer` to `src/mdh/xlsxWrite.js`**

```js
import * as api from './api.js';
import { orderColumns, buildColumnDiscoveryPipeline } from './csv.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_PART = 'xl/worksheets/sheet1.xml';

// Build a stored (method 0) entry's bytes + record its central-directory entry.
function storedEntry(name, text, offset) {
  const data = ENC.encode(text);
  const crc = crc32(data);
  const header = localHeader({ name, method: 0, flag: 0, crc, compSize: data.length, uncompSize: data.length });
  const central = centralHeader({ name, method: 0, flag: 0, crc, compSize: data.length, uncompSize: data.length, offset });
  return { bytes: [header, data], size: header.length + data.length, central };
}

export function buildXlsxSerializer({ sheetName = 'Sheet1', header = true, columns = null } = {}) {
  let cols = columns;
  let offset = 0;
  const centrals = [];
  let sheetCentral = null;
  // deflate pipeline state
  let cs, writer, pumpDone, sheetCrc = 0, sheetUncomp = 0, sheetComp = 0;
  let rowIndex = 0;
  let writeBytesRef = null;

  // Single byte sink: every write (headers, pumped compressed chunks, parts,
  // CD, EOCD) goes through here so `offset` stays the true byte position.
  async function emit(chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : ENC.encode(chunk);
    offset += u8.length;
    await writeBytesRef(u8);
  }
  // Feed uncompressed worksheet text into the deflate stream.
  async function feed(text) {
    const bytes = ENC.encode(text);
    sheetUncomp += bytes.length;
    sheetCrc = crc32Update(sheetCrc, bytes);
    await writer.write(bytes);
  }

  return {
    binary: true,
    ext: 'xlsx',
    mimeType: XLSX_MIME,
    pickerTypes: [{ description: 'Excel workbook', accept: { [XLSX_MIME]: ['.xlsx'] } }],

    async start(writeBytes, { collectionName, pipelineStages }) {
      writeBytesRef = writeBytes;
      if (cols == null) {
        const res = await api.aggregate(collectionName, buildColumnDiscoveryPipeline(pipelineStages));
        cols = orderColumns(res?.result?.[0]?.keys ?? []);
      }
      // Sheet entry local header — data descriptor (flag bit 3), method deflate.
      const sheetOffset = offset;
      await emit(localHeader({ name: SHEET_PART, method: 8, flag: 0x0008, crc: 0, compSize: 0, uncompSize: 0 }));
      // Start the deflate pump.
      cs = new CompressionStream('deflate-raw');
      writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      pumpDone = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sheetComp += value.length;
          await emit(value);
        }
      })();
      // Sheet head + optional header row.
      await feed(SHEET_HEAD);
      if (header) { await feed(rowXml(rowIndex, cols)); rowIndex++; }
      // Remember where to record the sheet's central-directory entry.
      this._sheetOffset = sheetOffset;
    },

    async writeDocs(docs) {
      let buf = '';
      for (const doc of docs) {
        const values = cols.map((c) => (doc == null ? undefined : doc[c]));
        buf += rowXml(rowIndex, values);
        rowIndex++;
      }
      if (buf) await feed(buf);
    },

    async finish() {
      await feed(SHEET_TAIL);
      await writer.close();
      await pumpDone;
      // Sheet data descriptor.
      await emit(dataDescriptor({ crc: sheetCrc, compSize: sheetComp, uncompSize: sheetUncomp }));
      sheetCentral = centralHeader({
        name: SHEET_PART, method: 8, flag: 0x0008,
        crc: sheetCrc, compSize: sheetComp, uncompSize: sheetUncomp, offset: this._sheetOffset,
      });
      centrals.push(sheetCentral);
      // Stored metadata parts.
      const parts = [
        ['[Content_Types].xml', CONTENT_TYPES_XML],
        ['_rels/.rels', ROOT_RELS_XML],
        ['xl/workbook.xml', workbookXml(sheetName)],
        ['xl/_rels/workbook.xml.rels', WB_RELS_XML],
        ['xl/styles.xml', STYLES_XML],
      ];
      for (const [name, text] of parts) {
        const e = storedEntry(name, text, offset);
        for (const b of e.bytes) await emit(b);
        centrals.push(e.central);
      }
      // Central directory + EOCD.
      const cdOffset = offset;
      let cdSize = 0;
      for (const c of centrals) { cdSize += c.length; await emit(c); }
      await emit(eocd({ count: centrals.length, cdSize, cdOffset }));
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes** (non-date assertions first; full after Task 5)

Run: `npx vitest run tests/mdh-xlsx-write.test.js`
Expected: PASS for the structural/non-date cases. The `{$date}` equality assertions pass once Task 5 lands (reader date conversion).

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 5: Reader — styles, date1904, date cells, emptyMode/trim (`xlsx.js`)

**Files:**
- Modify: `src/mdh/xlsx.js`
- Test: `tests/mdh-xlsx.test.js`

**Interfaces:**
- Consumes: `isDateFormat`, `serialToDate` from `./xlsxDates.js`.
- Produces (changed signatures, all backward-compatible via defaults):
  - `readStyles(xmlString) → boolean[]` (index = cellXfs position → is-date)
  - `readWorkbook(xmlString) → { sheets, date1904 }`
  - `readSheet(xmlString, sharedStrings, { styleIsDate = [], date1904 = false } = {}) → rows`
  - `rowsToDocs(rows, { hasHeader, emptyMode: 'null'|'omit'|'empty', trim })`
  - `parseXlsx(arrayBuffer, { sheet, hasHeader, emptyMode, trim })` now converts date cells.

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-xlsx.test.js`)

```js
import { readStyles, rowsToDocs as xlsxRowsToDocs } from '../src/mdh/xlsx.js';

describe('readStyles', () => {
  it('flags cellXfs entries whose numFmt is a date', () => {
    const xml = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';
    expect(readStyles(xml)).toEqual([false, true, true]);
  });
});

describe('rowsToDocs emptyMode/trim', () => {
  it("supports emptyMode 'empty'", () => {
    const { docs } = xlsxRowsToDocs([['a', 'b'], ['x', undefined]], { hasHeader: true, emptyMode: 'empty' });
    expect(docs[0]).toEqual({ a: 'x', b: '' });
  });
  it('trims string cells when trim:true', () => {
    const { docs } = xlsxRowsToDocs([['a'], ['  hi  '], [42]], { hasHeader: true, trim: true });
    expect(docs[0]).toEqual({ a: 'hi' });
    expect(docs[1]).toEqual({ a: 42 }); // non-strings untouched
  });
});
```

Also add a date round-trip case using a tiny in-memory workbook is covered by Task 4's test; here verify the reader unit path via `readSheet` if convenient.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx.test.js`
Expected: FAIL — `readStyles` undefined; emptyMode 'empty'/trim not honored.

- [ ] **Step 3: Modify `src/mdh/xlsx.js`**

3a. Add import at top:
```js
import { isDateFormat, serialToDate } from './xlsxDates.js';
```

3b. Add `readStyles` (after `readSharedStrings`):
```js
// Parse styles.xml -> per-cellXfs-index boolean "is a date format".
export function readStyles(xmlString) {
  const doc = parseXml(xmlString);
  const customFmt = new Map(); // numFmtId -> formatCode
  for (const nf of doc.getElementsByTagName('numFmt')) {
    customFmt.set(Number(nf.getAttribute('numFmtId')), nf.getAttribute('formatCode') || '');
  }
  const cellXfs = doc.getElementsByTagName('cellXfs')[0];
  if (!cellXfs) return [];
  return [...cellXfs.getElementsByTagName('xf')].map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    return isDateFormat(id, customFmt.get(id));
  });
}
```

3c. Extend `readWorkbook` to also return `date1904`:
```js
export function readWorkbook(xmlString) {
  const doc = parseXml(xmlString);
  const sheets = [...doc.getElementsByTagName('sheet')].map((el) => ({
    name: el.getAttribute('name') || '',
    rid: el.getAttribute('r:id') || el.getAttributeNS(RELS_NS, 'id') || '',
  }));
  const pr = doc.getElementsByTagName('workbookPr')[0];
  const d = pr && (pr.getAttribute('date1904') || '');
  const date1904 = d === '1' || d === 'true';
  return { sheets, date1904 };
}
```

3d. Extend `readSheet` to convert date cells. Add the options param and, in the
numeric branch, branch on `styleIsDate`:
```js
export function readSheet(xmlString, sharedStrings, { styleIsDate = [], date1904 = false } = {}) {
  const doc = parseXml(xmlString);
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    let auto = 0;
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const idx = ref ? colToIndex(ref) : auto;
      auto = idx + 1;
      const t = c.getAttribute('t');
      let value;
      if (t === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map((e) => e.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        const raw = v ? v.textContent : null;
        if (raw == null) value = undefined;
        else if (t === 's') value = sharedStrings[Number(raw)];
        else if (t === 'b') value = raw === '1';
        else if (t === 'str') value = raw;
        else if (t === 'd') value = raw;
        else if (t === 'e') value = null;
        else {
          const num = Number(raw);
          const s = Number(c.getAttribute('s') || 0);
          value = styleIsDate[s]
            ? { $date: serialToDate(num, { date1904 }).toISOString() }
            : num;
        }
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}
```

3e. Update `rowsToDocs` (the xlsx one) to honor `emptyMode: 'empty'` and `trim`:
```js
export function rowsToDocs(rows, { hasHeader = true, emptyMode = 'null', trim = false } = {}) {
  const warnings = [];
  const dataRows = rows.filter((r) => !r.every(isEmpty));
  if (dataRows.length === 0) return { docs: [], columns: [], warnings };
  const width = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  let header, body;
  if (hasHeader) {
    const h = dataRows[0];
    const seen = new Set();
    header = [];
    for (let i = 0; i < width; i++) {
      const name = isEmpty(h[i]) ? `column_${i + 1}` : String(h[i]);
      let candidate = name; let k = 2;
      while (seen.has(candidate)) candidate = `${name}_${k++}`;
      if (candidate !== name) warnings.push(`Duplicate column name "${name}" renamed to "${candidate}".`);
      seen.add(candidate); header.push(candidate);
    }
    body = dataRows.slice(1);
  } else {
    header = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    body = dataRows;
  }
  const docs = body.map((r) => {
    const doc = {};
    for (let i = 0; i < header.length; i++) {
      let v = r[i];
      if (trim && typeof v === 'string') v = v.trim();
      if (isEmpty(v)) {
        if (emptyMode === 'omit') continue;
        doc[header[i]] = emptyMode === 'empty' ? '' : null;
      } else doc[header[i]] = v;
    }
    return doc;
  });
  const ragged = body.filter((r) => r.length > header.length).length;
  if (ragged) warnings.push(`${ragged} row(s) have more columns than the header; extra cells ignored.`);
  return { docs, columns: [...header], warnings };
}
```

3f. Update `parseXlsx` to wire styles + date1904 into `readSheet` and forward
`trim`:
```js
export async function parseXlsx(arrayBuffer, { sheet, hasHeader = true, emptyMode = 'null', trim = false } = {}) {
  try {
    const files = await unzip(arrayBuffer);
    const wbBytes = files.get('xl/workbook.xml');
    if (!wbBytes) throw new Error('Not a valid .xlsx workbook (missing xl/workbook.xml).');
    const { sheets: defs, date1904 } = readWorkbook(textOf(wbBytes));
    if (defs.length === 0) throw new Error('Workbook has no sheets.');
    const sheets = defs.map((s) => s.name);

    const relsBytes = files.get('xl/_rels/workbook.xml.rels');
    const rels = relsBytes ? readRels(textOf(relsBytes)) : new Map();

    const def = (sheet ? defs.find((s) => s.name === sheet) : defs[0]) || defs[0];
    const target = rels.get(def.rid);
    let path;
    if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    else path = `xl/worksheets/sheet${defs.indexOf(def) + 1}.xml`;
    const sheetBytes = files.get(path);
    if (!sheetBytes) throw new Error('Worksheet part not found.');

    const ssBytes = files.get('xl/sharedStrings.xml');
    const shared = ssBytes ? readSharedStrings(textOf(ssBytes)) : [];
    const stylesBytes = files.get('xl/styles.xml');
    const styleIsDate = stylesBytes ? readStyles(textOf(stylesBytes)) : [];

    const rows = readSheet(textOf(sheetBytes), shared, { styleIsDate, date1904 });
    const { docs, columns, warnings } = rowsToDocs(rows, { hasHeader, emptyMode, trim });
    return { docs, columns, warnings, error: null, sheets };
  } catch (err) {
    return { docs: [], columns: [], warnings: [], error: { message: err.message }, sheets: [] };
  }
}
```

> Note: existing tests call `readWorkbook(...)` and destructure `{ sheets }` —
> still valid (extra `date1904` is ignored). `readSheet(xml, shared)` callers
> without the 3rd arg get the default `{}`.

- [ ] **Step 4: Run to verify it passes** — including Task 4's date round-trip now

Run: `npx vitest run tests/mdh-xlsx.test.js tests/mdh-xlsx-write.test.js`
Expected: PASS (date cells now round-trip writer→reader).

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 6: Engine binary-serializer protocol (`downloadCollection.js`)

**Files:**
- Modify: `src/mdh/downloadCollection.js`
- Test: `tests/mdh-download-collection.test.js`

**Interfaces:**
- Consumes: `buildXlsxSerializer` from `./xlsxWrite.js`.
- Produces: re-export `buildXlsxSerializer`; `downloadCollection` supports a
  serializer with `binary === true` (lifecycle `start`/`writeDocs`/`finish`).

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-download-collection.test.js`)

```js
// @vitest-environment jsdom
import { downloadCollection, buildXlsxSerializer } from '../src/mdh/downloadCollection.js';
import { parseXlsx } from '../src/mdh/xlsx.js';
import * as api from '../src/mdh/api.js';
import { vi } from 'vitest';

it('streams an xlsx via the binary serializer and it round-trips', async () => {
  vi.spyOn(api, 'aggregate').mockImplementation(async (col, pipeline) => {
    // column-discovery pipeline ends with a $group on keys
    const last = pipeline[pipeline.length - 1];
    if (last && last.$group) return { result: [{ _id: null, keys: ['name', 'n'] }] };
    return { result: [{ name: 'Alice', n: 1 }, { name: 'Bob', n: 2 }] };
  });
  let blob = null;
  const res = await downloadCollection('c', {
    serializer: buildXlsxSerializer({ sheetName: 'c' }),
    fetchCount: async () => 2,
    pickFile: async () => null,            // force Blob fallback
    downloadBlob: (b) => { blob = b; },
  });
  expect(res.cancelled).toBe(false);
  const buf = await blob.arrayBuffer();
  const { docs, columns, error } = await parseXlsx(buf, { hasHeader: true });
  expect(error).toBe(null);
  expect(columns).toEqual(['name', 'n']);
  expect(docs).toEqual([{ name: 'Alice', n: 1 }, { name: 'Bob', n: 2 }]);
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-download-collection.test.js -t "binary serializer"`
Expected: FAIL — `buildXlsxSerializer` not exported / binary path missing.

- [ ] **Step 3: Modify `src/mdh/downloadCollection.js`**

3a. Add to the import line at top:
```js
import { buildXlsxSerializer } from './xlsxWrite.js';
```
and re-export it:
```js
export { buildXlsxSerializer };
```

3b. In `downloadCollection`, after the `serializer.init` block, branch the body
on `serializer.binary`. Replace the existing `writeChunk` and the main
fetch/flush region with a version that supports both. The text path stays
exactly as-is; the binary path drives `start`/`writeDocs`/`finish`.

Concretely, make `writeChunk` byte-tolerant (it already only forwards):
```js
    async function writeChunk(chunk) {
      if (writer) await writer.write(chunk);
      else parts.push(chunk);
    }
```
(`chunk` may be a string or `Uint8Array`; both are accepted by FS-Access
`write` and `Blob`.)

3c. Replace the preamble/flush/postamble section. For the **binary** serializer,
the in-order flush calls `serializer.writeDocs(docs, writeChunk)` instead of
concatenating `item()` strings:
```js
    const isBinary = serializer.binary === true;

    if (isBinary) await serializer.start(writeChunk, { collectionName, pipelineStages });
    else await writeChunk(serializer.preamble());

    function scheduleFlush() {
      flushChain = flushChain.then(async () => {
        while (pending.has(nextWriteIdx)) {
          const docs = pending.get(nextWriteIdx);
          pending.delete(nextWriteIdx);
          if (isBinary) {
            await serializer.writeDocs(docs, writeChunk);
            docsWritten += docs.length;
          } else {
            let buf = '';
            for (const doc of docs) {
              if (docsWritten > 0) buf += serializer.separator;
              buf += serializer.item(doc);
              docsWritten++;
            }
            if (buf) await writeChunk(buf);
          }
          nextWriteIdx++;
          wakeOneWaiter();
        }
      });
    }
```
(Leave `workerLoop`, backpressure, cancellation unchanged — they call
`scheduleFlush`.)

3d. After `await Promise.all(workers); await flushChain;` and the cancellation
check, replace the postamble write:
```js
    if (isBinary) await serializer.finish(writeChunk);
    else await writeChunk(serializer.postamble());
```

> The CSV serializer's optional `init` still runs (it is independent of the
> binary branch). `buildXlsxSerializer` does its column discovery inside
> `start`, after the picker — same ordering guarantee.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-download-collection.test.js`
Expected: PASS — xlsx round-trips; JSON/CSV/XML/NDJSON cases unchanged.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS (text-serializer output byte-identical).

---

## Task 7: Export options modal (`XlsxExportOptions.jsx`)

**Files:**
- Create: `src/mdh/components/XlsxExportOptions.jsx`
- Test: `tests/mdh-xlsx-export-options.test.js`

**Interfaces:**
- Consumes: `closeModal` from `./Modal.jsx`.
- Produces: default export `XlsxExportOptions({ loadPreview, onDownload })`.
  - `loadPreview()` resolves `{ columns, sample }`.
  - `onDownload({ sheetName, header, columns })` is called on Download.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/preact';
import { h } from 'preact';
import XlsxExportOptions from '../src/mdh/components/XlsxExportOptions.jsx';

describe('XlsxExportOptions', () => {
  it('loads a preview and hands columns + options back on Download', async () => {
    const loadPreview = vi.fn().mockResolvedValue({ columns: ['a', 'b'], sample: [{ a: 1, b: 'x' }] });
    const onDownload = vi.fn();
    render(h(XlsxExportOptions, { loadPreview, onDownload }));
    await screen.findByTestId('xlsx-export-preview');
    fireEvent.click(screen.getByTestId('xlsx-export-download'));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ header: true, columns: ['a', 'b'] }));
  });
});
```

> Confirm `@testing-library/preact` is the convention used by the other
> `*-export-options`/wizard tests; if those tests instead render via a manual
> `render(h(...), container)` helper, mirror that exact pattern instead.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-export-options.test.js`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `src/mdh/components/XlsxExportOptions.jsx`** (mirror `CsvExportOptions.jsx`; drop the delimiter control, add a sheet-name input; preview is a small table of `sample` over `columns`)

```jsx
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { closeModal } from './Modal.jsx';
import { Toggle } from './CsvImportWizard.jsx';
import { displayValue } from '../displayValue.js';

// Options + preview before an .xlsx export. `loadPreview` resolves
// { columns, sample }; discovered columns are handed back so the download
// doesn't re-scan.
export default function XlsxExportOptions({ loadPreview, onDownload }) {
  const [sheetName, setSheetName] = useState('Sheet1');
  const [header, setHeader] = useState(true);
  const [preview, setPreview] = useState({ loading: true, columns: [], sample: [], error: null });

  useEffect(() => {
    let live = true;
    if (!loadPreview) { setPreview({ loading: false, columns: [], sample: [], error: null }); return undefined; }
    loadPreview()
      .then((r) => { if (live) setPreview({ loading: false, columns: r.columns || [], sample: r.sample || [], error: null }); })
      .catch((e) => { if (live) setPreview({ loading: false, columns: [], sample: [], error: e?.message || 'failed' }); });
    return () => { live = false; };
  }, []);

  function download() {
    const cols = (!preview.loading && !preview.error && preview.columns.length) ? preview.columns : null;
    closeModal();
    onDownload({ sheetName, header, columns: cols });
  }

  return (
    <div class="modal-body csv-export-options">
      <div class="csv-toolbar">
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Worksheet tab name.">Sheet name</span>
          <input class="xlsx-sheet-select" data-testid="xlsx-export-sheet" value={sheetName} onInput={(e) => setSheetName(e.target.value)} />
        </span>
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Write a first row with the field names.">Header row</span>
          <Toggle checked={header} onChange={setHeader} testid="xlsx-export-header" title="Write a header row." />
        </span>
        <span class="toolbar-menu-beta">beta</span>
      </div>

      <div class="csv-export-preview" data-testid="xlsx-export-preview">
        {preview.loading ? <div class="csv-export-preview-note">Building preview{'…'}</div>
          : preview.error ? <div class="csv-export-preview-note">Preview unavailable</div>
          : preview.columns.length === 0 ? <div class="csv-export-preview-note">No rows to preview</div>
          : (
            <Fragment>
              <div class="csv-export-preview-caption">
                Preview {'·'} first {preview.sample.length} row{preview.sample.length === 1 ? '' : 's'} {'·'} {preview.columns.length} column{preview.columns.length === 1 ? '' : 's'}
              </div>
              <div class="csv-preview-scroll">
                <table class="csv-preview-table">
                  <thead><tr>{(header ? preview.columns : preview.columns).map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {preview.sample.map((d, i) => (
                      <tr key={i}>{preview.columns.map((c) => <td key={c}>{cellPreview(d[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Fragment>
          )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={closeModal}>Cancel</button>
        <button class="btn btn-primary" data-testid="xlsx-export-download" onClick={download}>Download</button>
      </div>
    </div>
  );
}

function cellPreview(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return displayValue(v);
  return String(v);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-xlsx-export-options.test.js`
Expected: PASS.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 8: Wire export into the UI (`DownloadSplitButton`, `DataPanel`, `RecordList`)

**Files:**
- Modify: `src/mdh/components/DownloadSplitButton.jsx`
- Modify: `src/mdh/components/DataPanel.jsx`
- Modify: `src/mdh/components/RecordList.jsx`
- Test: `tests/mdh-download-dropdown.test.js`

**Interfaces:**
- Consumes: `XlsxExportOptions` (Task 7), `buildXlsxSerializer` (Task 6).
- Produces: `DownloadSplitButton` gains `onAllXlsx`/`onFilteredXlsx`; DataPanel
  routes `download-xlsx`/`download-filtered-xlsx`.

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-download-dropdown.test.js`)

```js
it('renders an Excel item and fires onAllXlsx / onFilteredXlsx', async () => {
  const onAllXlsx = vi.fn();
  const onFilteredXlsx = vi.fn();
  render(h(DownloadSplitButton, { onAllJson(){}, onFilteredJson(){}, onAllCsv(){}, onFilteredCsv(){}, onAllXml(){}, onFilteredXml(){}, onAllJsonl(){}, onFilteredJsonl(){}, onAllXlsx, onFilteredXlsx }));
  fireEvent.click(screen.getByText(/Download/));
  fireEvent.click(screen.getByTestId('download-all'));
  fireEvent.click(screen.getByTestId('download-all-xlsx'));
  expect(onAllXlsx).toHaveBeenCalled();
});
```

> Match the existing render/query helpers already used in
> `tests/mdh-download-dropdown.test.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-download-dropdown.test.js`
Expected: FAIL — no `download-all-xlsx` item.

- [ ] **Step 3a: `DownloadSplitButton.jsx`** — add the prop + menu item.

Signature:
```jsx
export default function DownloadSplitButton({ onAllJson, onFilteredJson, onAllCsv, onFilteredCsv, onAllXml, onFilteredXml, onAllJsonl, onFilteredJsonl, onAllXlsx, onFilteredXlsx }) {
```
In `ITEMS`, add `xlsx` to each row:
```jsx
  const ITEMS = [
    { key: 'all', label: 'Download all', json: onAllJson, csv: onAllCsv, xml: onAllXml, jsonl: onAllJsonl, xlsx: onAllXlsx },
    { key: 'filtered', label: 'Download filtered', json: onFilteredJson, csv: onFilteredCsv, xml: onFilteredXml, jsonl: onFilteredJsonl, xlsx: onFilteredXlsx },
  ];
```
In the flyout, after the CSV button (before XML), add:
```jsx
                  <button class="toolbar-menu-item" data-testid={`download-${it.key}-xlsx`}
                    onClick={() => choose(it.xlsx)}>Excel <span class="toolbar-menu-beta">beta</span></button>
```

- [ ] **Step 3b: `RecordList.jsx`** — pass the two new props (after `onFilteredJsonl`):
```jsx
            onAllXlsx={() => onRefresh('download-xlsx')}
            onFilteredXlsx={() => onRefresh('download-filtered-xlsx')}
```

- [ ] **Step 3c: `DataPanel.jsx`** — import + route + handlers.

Add to the download imports:
```js
import { downloadCollection as runDownload, buildCsvSerializer, buildXmlSerializer, buildNdjsonSerializer, buildXlsxSerializer } from '../downloadCollection.js';
import XlsxExportOptions from './XlsxExportOptions.jsx';
```
In the `onRefresh`/action dispatch where `download-csv` etc. are routed, add:
```js
    } else if (action === 'download-xlsx') {
      downloadAllXlsx();
    } else if (action === 'download-filtered-xlsx') {
      downloadFilteredXlsx();
```
Add two handlers modeled exactly on `downloadAllCsv`/`downloadFilteredCsv` but
opening `XlsxExportOptions` and using `buildXlsxSerializer`:
```js
  function downloadAllXlsx() {
    const col = collection;
    openModal('Export Excel', () => (
      <XlsxExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline([{ $match: {} }])),
            api.aggregate(col, [{ $match: {} }, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ sheetName, header, columns }) => {
          const tc = pagination.totalCount.value;
          if (tc !== null && tc > 10_000) {
            const proceed = await confirmModal('Large collection', `This collection has ${tc.toLocaleString()} documents. Exporting may take a while. Continue?`);
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages: [{ $match: {} }],
            filename: `${col}.xlsx`,
            filtered: false,
            fetchCount: async () => {
              if (pagination.totalCount.value !== null) return pagination.totalCount.value;
              const r = await api.aggregate(col, [{ $count: 'total' }]);
              return r.result?.[0]?.total ?? 0;
            },
            serializer: buildXlsxSerializer({ sheetName, header, columns }),
          });
        }}
      />
    ));
  }

  function downloadFilteredXlsx() {
    if (!editorRef.current) return;
    let pipelineStages;
    try {
      const text = pipeline.substituteWithTypes(editorRef.current.getValue());
      const parsed = JSON5.parse(text);
      if (!Array.isArray(parsed)) throw new Error('pipeline must be a JSON array');
      pipelineStages = stripPaginationStages(parsed);
    } catch (err) {
      error.value = { message: `Cannot export filtered: ${err.message}` };
      return;
    }
    const col = collection;
    openModal('Export Excel', () => (
      <XlsxExportOptions
        loadPreview={async () => {
          const [keysRes, sampleRes] = await Promise.all([
            api.aggregate(col, buildColumnDiscoveryPipeline(pipelineStages)),
            api.aggregate(col, [...pipelineStages, { $limit: 10 }]),
          ]);
          return { columns: orderColumns(keysRes.result?.[0]?.keys ?? []), sample: sampleRes.result || [] };
        }}
        onDownload={async ({ sheetName, header, columns }) => {
          downloadCancelRef.current = false;
          error.value = null;
          setDownloadState({ counting: true, filtered: true });
          const ac = new AbortController();
          downloadCountAbortRef.current = ac;
          let filteredCount;
          try {
            const r = await api.aggregate(col, [...pipelineStages, { $count: 'total' }], { signal: ac.signal });
            filteredCount = r.result?.[0]?.total ?? 0;
          } catch (err) {
            downloadCountAbortRef.current = null;
            if (downloadCancelRef.current || err.name === 'AbortError') { setDownloadState(null); return; }
            error.value = { message: `Cannot export filtered: ${err.message}` };
            setDownloadState(null);
            return;
          }
          downloadCountAbortRef.current = null;
          if (downloadCancelRef.current) { setDownloadState(null); return; }
          if (filteredCount > 10_000) {
            setDownloadState(null);
            const proceed = await confirmModal('Large export', `This filter matches ${filteredCount.toLocaleString()} documents. Exporting may take a while. Continue?`);
            if (!proceed) return;
          }
          await runDownloadJob({
            pipelineStages,
            filename: `${col}-filtered.xlsx`,
            filtered: true,
            fetchCount: async () => filteredCount,
            serializer: buildXlsxSerializer({ sheetName, header, columns }),
          });
        }}
      />
    ));
  }
```

> `buildColumnDiscoveryPipeline`, `orderColumns`, `openModal`, `confirmModal`,
> `runDownloadJob`, `pagination`, `downloadCancelRef`, `downloadCountAbortRef`,
> `editorRef`, `pipeline`, `stripPaginationStages`, `JSON5` are all already
> imported/in scope in `DataPanel.jsx` (used by the CSV/XML handlers). No new
> imports beyond `buildXlsxSerializer` + `XlsxExportOptions`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-download-dropdown.test.js`
Expected: PASS.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 9: Import wizard parity (`XlsxImportWizard.jsx`)

**Files:**
- Modify: `src/mdh/components/XlsxImportWizard.jsx`
- Test: `tests/mdh-xlsx-wizard.test.js`

**Interfaces:**
- Adds `trim` (default false) + a 3-way empty mode (`empty`/`null`/`omit`,
  default `null`) to `DEFAULT_OPTS`, forwarded into `parseXlsx`. Removes the
  serial-number hint text.

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-xlsx-wizard.test.js`)

```js
it('exposes an empty-string option and a Trim toggle, and no serial-number hint', async () => {
  // mount the wizard at the Configure stage with a tiny parsed workbook
  // (mirror the existing wizard test's harness for getting past PICK).
  // Then assert:
  //   - the empty-mode segmented control has an option for "" (testid xlsx-empty)
  //   - a trim toggle exists (testid xlsx-trim)
  //   - the body does not contain the text "serial number"
});
```

> Fill this in mirroring the existing `tests/mdh-xlsx-wizard.test.js` harness
> (it already drives the wizard through PICK→CONFIGURE with a stub file +
> `parseXlsx`). Assert the three points above.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mdh/components/XlsxImportWizard.jsx`**

3a. Update defaults + empty options:
```js
const DEFAULT_OPTS = { sheet: null, hasHeader: true, emptyMode: 'null', trim: false };
const EMPTY_SEG = [
  { value: 'empty', label: '""', title: 'Empty string' },
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];
```

3b. Forward `trim` into the reparse effect:
```js
    parseXlsx(buffer, { sheet: opts.sheet, hasHeader: opts.hasHeader, emptyMode: opts.emptyMode, trim: opts.trim })
```
and add `opts.trim` to the effect dependency array.

3c. In `XlsxStageConfigure`, add a Trim toggle next to the empty-mode control:
```jsx
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Strip leading/trailing whitespace around text cells.">Trim values</span>
          <Toggle checked={opts.trim} onChange={(v) => setOpt('trim', v)} testid="xlsx-trim" />
        </span>
```

3d. Remove the two serial-number hints:
- In `XlsxStagePick`, change the `file-input-info` line to:
  `<div class="file-input-info" style="margin-top:4px">Each row becomes one document. Date cells import as dates.</div>`
- Delete the `<div class="csv-opt-hint">Excel date cells import as their underlying serial number.</div>` line in `XlsxStageConfigure`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js`
Expected: PASS.

- [ ] **Step 5: Full-suite checkpoint**

Run: `npm test`
Expected: PASS.

---

## Task 10: Build, CSP check, and live verification

**Files:** none (verification only).

- [ ] **Step 1: Full clean build**

Run: `npm run build`
Expected: completes; `dist/console/console.js` produced.

- [ ] **Step 2: CSP-clean grep**

Run: `grep -c -E "eval\(|new Function|new Worker" dist/console/console.js || true`
Expected: `0` (no eval/new Function/Worker introduced by the writer).

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all green (target ≥ prior count; new tests added).

- [ ] **Step 4: Live verification (manual, dev org only — no customer data committed/leaked)**

  1. Load the unpacked `dist/` extension; open Data Storage; pick a small dev
     collection that contains a date field.
  2. Export it via **Download → Excel** (both "all" and "filtered").
  3. Open the file in Excel and/or LibreOffice — confirm it opens without a
     repair prompt, header + rows + date cells render as dates.
  4. Re-import the exported file via **Insert → From Excel file** into a scratch
     collection; confirm date cells import as a real date (`{$date}` in the JSON
     tree, rendered as a Date), and a `find`/`aggregate` filter on that field as
     a date works.
  5. **Gate:** if `{$date}` does NOT store as a real BSON date (stored as a
     literal `{ "$date": "…" }` sub-document instead), change the reader's date
     representation in `xlsx.js#readSheet` from `{ $date: iso }` to the plain
     ISO string `iso`, update Task 5's tests accordingly, and note it in the
     spec. (Writer is unaffected — it would then no longer detect a date on
     re-export, which is the correct consequence of strings-not-dates.)

---

## Self-Review

**Spec coverage:**
- §1/§3 export gap → Tasks 2–8 (writer + engine + UI). ✓
- §1/§6 import date fix → Tasks 1, 5. ✓
- §4 import parity (empty-`""`, trim) → Tasks 5, 9. ✓
- §5 cell mapping symmetric with `csvCell` → Task 3 (`cellXml`) + test. ✓
- §5 streamed binary serializer → Tasks 4, 6. ✓
- §8 tests → each task ships tests; round-trip via reader in Tasks 4/6. ✓
- §9 verification gate (`{$date}` insert) → Task 10 Step 4. ✓
- §2 CSP-clean / no dependency → Task 10 Step 2; native APIs throughout. ✓
- §7 text-serializer byte-identity → Task 6 (text path untouched) + full suite. ✓

**Placeholder scan:** Task 9 Step 1 and Task 7/8 test harnesses say "mirror the
existing test pattern" rather than inlining a guessed render helper — this is
deliberate (the repo's exact RTL-vs-manual-render convention must be read from a
sibling test, not assumed). All implementation steps contain complete code.

**Type consistency:** `buildXlsxSerializer({ sheetName, header, columns })` used
identically in Tasks 4, 6, 8. `parseXlsx(buffer, { sheet, hasHeader, emptyMode,
trim })` consistent across Tasks 5, 9. `serialToDate`/`dateToSerial` opts
`{ date1904 }` consistent (Tasks 1, 3, 5). `readSheet(xml, shared, { styleIsDate,
date1904 })` consistent (Task 5). `onDownload({ sheetName, header, columns })`
consistent (Tasks 7, 8). ✓

**Open convention to confirm during execution (not a gap):** the precise test
render helper (`@testing-library/preact` vs a manual `render(h(...))`) — read a
neighboring `*-wizard`/`*-export-options` test and match it.
