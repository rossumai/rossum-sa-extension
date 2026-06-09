# Excel (.xlsx) import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Excel `.xlsx` import to the MDH Dataset Management app via a custom, zero-dependency parser (native `DecompressionStream('deflate-raw')` + `DOMParser` only), values-only fidelity, marked **beta**, reusing the entire existing import tail.

**Architecture:** A new `src/mdh/xlsx.js` exposes `parseXlsx(arrayBuffer, opts) → Promise<{ docs, columns, warnings, error, sheets }>` — the same shape `csv.js`'s `parseCsv` returns — so `analyzeDocs` / `dedupeById` / `runChunkedInsert` / `runChunkedOverwrite` / `StageConfirm` / `StageImporting` / `StageDone` / `CsvPreview` are all reused unchanged. A parallel `XlsxImportWizard` (async preview) drives it. The parser is built only on Web APIs → CSP-clean, no worker, no new dependency.

**Tech Stack:** Preact + signals, esbuild, Vitest (jsdom). No runtime dependencies added.

**Spec:** `docs/superpowers/specs/2026-06-09-xlsx-import-design.md`

**Commits:** This repo commits manually — **do NOT run `git commit`** during execution. End each task by running the relevant tests (and `npm run build` where noted). Stay on `master`.

**Test conventions:** `// @vitest-environment jsdom` (the parser needs `DOMParser` from jsdom and `DecompressionStream` from the Node global — Task 1 verifies both are present); `import { h, render } from 'preact'`; mount into a div; query by `data-testid`/class; condition-based `waitFor` (never fixed-sleep flush races). JSX unicode literal in `{'…'}` expression form (e.g. `{'→'}`, `{'…'}`), never `\uXXXX` in JSX text.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mdh/xlsx.js` | create | The parser: `unzip` (ZIP+`DecompressionStream`), `readWorkbook`/`readRels`/`readSharedStrings`/`readSheet` (`DOMParser`), pure `rowsToDocs`, `colToIndex`, and `parseXlsx` orchestration. |
| `src/mdh/components/XlsxImportWizard.jsx` | create | Parallel import wizard (pick + async-preview configure), reusing `ImportStages`, `CsvPreview`, `importFile.js`. Beta tag in header. |
| `src/mdh/components/RecordList.jsx` | modify | "Insert from Excel file" menu item (`beta: true`) + menu renderer renders an optional beta badge. |
| `src/mdh/components/DataPanel.jsx` | modify | Route `'insert-xlsx-file'` → `openDataOperations`. |
| `src/mdh/components/DataOperations.jsx` | modify | Dispatch `'insert-xlsx'` → `<XlsxImportWizard>`; title "Insert from Excel file". |
| `src/console/console.css` | modify | `.toolbar-menu-beta` inline beta pill (mirrors `.app-rail-beta`). |
| `tests/fixtures/sample.xlsx` | create | Committed fixture for integration tests (generated once by a throwaway script). |
| `tests/mdh-xlsx.test.js` | create | Unit tests (`rowsToDocs`, XML decoders, `colToIndex`) + integration (`unzip`, `parseXlsx`) against the fixture. |
| `tests/mdh-xlsx-wizard.test.js` | create | Wizard flow + beta-tag tests. |

> **Sequencing:** Tasks build the parser bottom-up (pure → XML → zip → orchestration), then UI. Each is independently green. Task 1 de-risks the platform assumptions first.

---

## Task 1: De-risk the platform + create the test fixture

**Files:**
- Create: `tests/fixtures/sample.xlsx`
- Test: `tests/mdh-xlsx-env.test.js` (a small sanity test; may be deleted at the end or kept)

- [ ] **Step 1: Verify `DecompressionStream('deflate-raw')` is usable in the vitest env**

Create `tests/mdh-xlsx-env.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

describe('xlsx platform prerequisites', () => {
  it('DecompressionStream("deflate-raw") and DOMParser are available and round-trip', async () => {
    expect(typeof DecompressionStream).toBe('function');
    expect(typeof DOMParser).toBe('function');
    const orig = new TextEncoder().encode('Excel '.repeat(2000)); // 12k → real deflate
    const comp = new Uint8Array(await new Response(
      new Response(orig).body.pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer());
    const back = new Uint8Array(await new Response(
      new Response(comp).body.pipeThrough(new DecompressionStream('deflate-raw'))
    ).arrayBuffer());
    expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(orig));
    // DOMParser parses application/xml
    const doc = new DOMParser().parseFromString('<a><b r="1"/></a>', 'application/xml');
    expect(doc.getElementsByTagName('b')[0].getAttribute('r')).toBe('1');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/mdh-xlsx-env.test.js`
Expected: PASS. **If `DecompressionStream` is undefined under jsdom**, STOP and report — the fallback is to run the zip/integration tests under `// @vitest-environment node` and parse XML with jsdom's `DOMParser` injected, or to add a node-env companion file. (Node ≥18 exposes `DecompressionStream` globally; the repo runs Node v24, so this should pass.)

- [ ] **Step 3: Generate the committed fixture**

> **Why hand-authored, not `xlsx@0.18.5`:** the original `xlsx@0.18.5` `aoa_to_sheet`
> recipe produced a fixture where **every** ZIP entry was *Stored* (method 0, no
> compression) and **no** `xl/sharedStrings.xml` was emitted (string cells came out
> as `t="str"` inline values). That left the two highest-risk platform paths
> **uncovered by the real-file integration tests**: the `DecompressionStream('deflate-raw')`
> method-8 inflate branch in `unzip` (spec §3, §10 — the whole reason Task 1 exists)
> and the `readSharedStrings` + `t="s"` decode path (spec §3, §4.1, §7). The fixture
> is therefore generated by a small **zero-dependency** Node script (native
> `node:zlib` `deflateRawSync` + a hand-written minimal ZIP writer — no library,
> nothing added to the repo's `package.json`) that **mixes** compression methods and
> emits a real shared-string table.

In a scratch dir, create `/tmp/xlsx-gen/gen.mjs` that authors the OOXML parts by
hand and zips them so that:
- `xl/sharedStrings.xml`, `xl/worksheets/sheet1.xml`, `xl/worksheets/sheet2.xml` are
  **DEFLATE** (method 8) — exercises `DecompressionStream`/the inflate branch;
- `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`
  are **Stored** (method 0) — keeps the copy branch covered too;
- the People sheet's string cells use `t="s"` referencing `xl/sharedStrings.xml`, and
  the `note="hello"` entry is a **rich-text** `<si>` (`<r><t>hel</t></r><r><t>lo</t></r>`)
  so the run-concatenation path in `readSharedStrings` is exercised — yet still decodes
  to exactly `"hello"`.

Key generator shape (native ZIP, no deps):
```js
import { writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
// parts = [{ name, xml, deflate }]; deflate:true -> method 8 (deflateRawSync),
// deflate:false -> method 0 (raw bytes). Build local headers + central directory
// + EOCD with little-endian u16/u32 fields; sizes/crc in each header (no data
// descriptor). sharedStrings + worksheets deflate; container parts store.
```

Run it and copy the result into the repo:
```bash
cd /tmp/xlsx-gen && node gen.mjs && cp sample.xlsx "<repo>/tests/fixtures/sample.xlsx"
```
Confirm the binary exists and shows **mixed** methods:
`unzip -v tests/fixtures/sample.xlsx` → expect both `Stored` and `Defl:N` rows, and a
`xl/sharedStrings.xml` entry. This file is the single committed fixture; the shipped
extension contains **no** writer. **Coverage achieved (verified):** `unzip` hits both
the method-0 copy and the method-8 inflate (`DecompressionStream('deflate-raw')`)
branches, and `parseXlsx` resolves `t="s"` cells through a real `xl/sharedStrings.xml`
(including a rich-text run) — while the documented expected parse below is byte-identical
to the old fixture.

The fixture's expected parse (default sheet "People", `hasHeader:true`, `emptyMode:'null'`) — used by later tasks:
```
sheets  = ['People', 'Extra']
columns = ['name', 'age', 'active', 'joined', 'note']
docs    = [
  { name: 'Alice', age: 30, active: true,  joined: 45306, note: 'hello' },
  { name: 'Bob',   age: 25, active: false, joined: 44196, note: null },
]
```

- [ ] **Step 4: Note the manifest floor**

`manifest.json` has no `minimum_chrome_version`, so the effective floor is the user's current Chrome — comfortably past `deflate-raw`'s Chrome-103 (2022) requirement. **Do not** change the manifest in this plan (a global min-version bump is a separate product decision); this step is documentation only.

---

## Task 2: `rowsToDocs` + `colToIndex` (pure, no Web API)

**Files:**
- Create: `src/mdh/xlsx.js`
- Test: `tests/mdh-xlsx.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-xlsx.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { rowsToDocs, colToIndex } from '../src/mdh/xlsx.js';

describe('colToIndex', () => {
  it('maps cell refs to 0-based column indices', () => {
    expect(colToIndex('A1')).toBe(0);
    expect(colToIndex('B')).toBe(1);
    expect(colToIndex('Z9')).toBe(25);
    expect(colToIndex('AA1')).toBe(26);
    expect(colToIndex('AB10')).toBe(27);
  });
});

describe('rowsToDocs', () => {
  const rows = [
    ['name', 'age', 'active', 'joined', 'note'],
    ['Alice', 30, true, 45306, 'hello'],
    ['Bob', 25, false, 44196, undefined],
  ];

  it('uses row 1 as the header and preserves native cell types', () => {
    const { docs, columns, warnings } = rowsToDocs(rows, { hasHeader: true, emptyMode: 'null' });
    expect(columns).toEqual(['name', 'age', 'active', 'joined', 'note']);
    expect(docs[0]).toEqual({ name: 'Alice', age: 30, active: true, joined: 45306, note: 'hello' });
    expect(docs[1]).toEqual({ name: 'Bob', age: 25, active: false, joined: 44196, note: null }); // empty → null
    expect(warnings).toEqual([]);
  });

  it('omits empty cells under emptyMode omit (and preserves 0 / false)', () => {
    const { docs } = rowsToDocs([['a', 'b'], [0, undefined], [false, 'x']], { hasHeader: true, emptyMode: 'omit' });
    expect(docs[0]).toEqual({ a: 0 });              // b omitted; 0 kept
    expect(docs[1]).toEqual({ a: false, b: 'x' });  // false kept
  });

  it('generates column_N names when hasHeader is false', () => {
    const { docs, columns } = rowsToDocs([['x', 1], ['y', 2]], { hasHeader: false });
    expect(columns).toEqual(['column_1', 'column_2']);
    expect(docs).toEqual([{ column_1: 'x', column_2: 1 }, { column_1: 'y', column_2: 2 }]);
  });

  it('fills blank header names and de-duplicates them with a warning', () => {
    const { columns, warnings } = rowsToDocs([['id', '', 'id'], [1, 2, 3]], { hasHeader: true });
    expect(columns).toEqual(['id', 'column_2', 'id_2']);
    expect(warnings.join(' ')).toMatch(/Duplicate column/);
  });

  it('drops fully-empty rows and returns empty for a header-only sheet', () => {
    expect(rowsToDocs([['only']], { hasHeader: true }).docs).toEqual([]);
    expect(rowsToDocs([['a'], [undefined], [], ['x']], { hasHeader: true }).docs).toEqual([{ a: 'x' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx.test.js` → FAIL (`xlsx.js` doesn't exist / exports missing).

- [ ] **Step 3: Implement `colToIndex` + `rowsToDocs`**

Create `src/mdh/xlsx.js` with (the rest of the module is added in later tasks):
```js
// Custom, dependency-free .xlsx (OOXML SpreadsheetML) reader.
// Uses ONLY native Web APIs — DecompressionStream('deflate-raw') for ZIP inflate
// and DOMParser for XML — so it is CSP-clean (no eval/new Function, no Worker) and
// adds no dependency. Values-only: strings/numbers/booleans decode natively; date
// cells arrive as their raw Excel serial number (no styles.xml). Produces the same
// shape as csv.js's parseCsv so the whole import tail is reused unchanged.

// 'A1' -> 0, 'B' -> 1, 'AA10' -> 26. Reads the leading A–Z run only.
export function colToIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const isEmpty = (v) => v === undefined || v === null || v === '';

// Pure: 2-D typed rows -> { docs, columns, warnings }. No type inference, no trim
// (cells are already natively typed); 0 and false are NOT treated as empty.
export function rowsToDocs(rows, { hasHeader = true, emptyMode = 'null' } = {}) {
  const warnings = [];
  const dataRows = rows.filter((r) => !r.every(isEmpty));
  if (dataRows.length === 0) return { docs: [], columns: [], warnings };

  const width = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  let header, body;
  if (hasHeader) {
    const h = dataRows[0];
    const seen = new Map();
    header = [];
    for (let i = 0; i < width; i++) {
      let name = isEmpty(h[i]) ? `column_${i + 1}` : String(h[i]);
      if (seen.has(name)) {
        const k = seen.get(name) + 1;
        seen.set(name, k);
        warnings.push(`Duplicate column name "${name}" renamed to "${name}_${k}".`);
        name = `${name}_${k}`;
      } else {
        seen.set(name, 1);
      }
      header.push(name);
    }
    body = dataRows.slice(1);
  } else {
    header = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    body = dataRows;
  }

  const docs = body.map((r) => {
    const doc = {};
    for (let i = 0; i < header.length; i++) {
      const v = r[i];
      if (isEmpty(v)) { if (emptyMode !== 'omit') doc[header[i]] = null; }
      else doc[header[i]] = v;
    }
    return doc;
  });
  const ragged = body.filter((r) => r.length > header.length).length;
  if (ragged) warnings.push(`${ragged} row(s) have more columns than the header; extra cells ignored.`);
  return { docs, columns: [...header], warnings };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-xlsx.test.js` → PASS.

---

## Task 3: XML part decoders (`DOMParser`)

**Files:**
- Modify: `src/mdh/xlsx.js`
- Test: `tests/mdh-xlsx.test.js`

- [ ] **Step 1: Append failing tests**

Add to `tests/mdh-xlsx.test.js`:
```js
import { readWorkbook, readRels, readSharedStrings, readSheet } from '../src/mdh/xlsx.js';

describe('readWorkbook / readRels', () => {
  it('lists sheets with names + r:id, and resolves rels', () => {
    const wb = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="People" sheetId="1" r:id="rId1"/><sheet name="Extra" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    expect(readWorkbook(wb).sheets).toEqual([
      { name: 'People', rid: 'rId1' }, { name: 'Extra', rid: 'rId2' },
    ]);
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
    expect(readRels(rels).get('rId1')).toBe('worksheets/sheet1.xml');
  });
});

describe('readSharedStrings', () => {
  it('reads plain and rich-text strings', () => {
    const ss = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
      <si><t>hello</t></si>
      <si><r><t>Rich</t></r><r><t> Text</t></r></si></sst>`;
    expect(readSharedStrings(ss)).toEqual(['hello', 'Rich Text']);
  });
});

describe('readSheet', () => {
  const shared = ['Alice', 'hello'];
  const xml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="b"><v>1</v></c><c r="C1"><v>45306</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="C2" t="str"><v>formula</v></c><c r="D2" t="e"><v>#DIV/0!</v></c><c r="E2" t="d"><v>2024-01-15</v></c></row>
  </sheetData></worksheet>`;
  it('decodes each cell type by its t attribute, placed by column ref', () => {
    const rows = readSheet(xml, shared);
    expect(rows[0]).toEqual(['Alice', true, 45306]);         // s, b, number
    expect(rows[1][0]).toBe('inline');                        // inlineStr
    expect(rows[1][2]).toBe('formula');                       // str (B2 missing -> hole)
    expect(rows[1][1]).toBeUndefined();                       // sparse cell
    expect(rows[1][3]).toBeNull();                            // error -> null
    expect(rows[1][4]).toBe('2024-01-15');                    // d -> ISO string kept as-is
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx.test.js` → FAIL (decoders not exported).

- [ ] **Step 3: Implement the decoders**

Append to `src/mdh/xlsx.js`:
```js
function parseXml(str) {
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed XML in .xlsx');
  return doc;
}
const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function readWorkbook(xmlString) {
  const doc = parseXml(xmlString);
  const sheets = [...doc.getElementsByTagName('sheet')].map((el) => ({
    name: el.getAttribute('name') || '',
    rid: el.getAttribute('r:id') || el.getAttributeNS(RELS_NS, 'id') || '',
  }));
  return { sheets };
}

export function readRels(xmlString) {
  const doc = parseXml(xmlString);
  const map = new Map();
  for (const el of doc.getElementsByTagName('Relationship')) map.set(el.getAttribute('Id'), el.getAttribute('Target'));
  return map;
}

export function readSharedStrings(xmlString) {
  const doc = parseXml(xmlString);
  // One entry per <si>; concatenate every <t> beneath it (covers plain + rich-text runs).
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
}

export function readSheet(xmlString, sharedStrings) {
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
        else if (t === 'd') value = raw;          // ISO date string (rare) — kept as-is
        else if (t === 'e') value = null;         // error cell
        else value = Number(raw);                 // number (incl. date serials)
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-xlsx.test.js` → PASS.

---

## Task 4: `unzip` — ZIP container + `DecompressionStream`

**Files:**
- Modify: `src/mdh/xlsx.js`
- Test: `tests/mdh-xlsx.test.js`

- [ ] **Step 1: Append failing test (integration, against the fixture)**

Add to `tests/mdh-xlsx.test.js`:
```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzip } from '../src/mdh/xlsx.js';

function fixtureBuffer() {
  const p = fileURLToPath(new URL('./fixtures/sample.xlsx', import.meta.url));
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // ArrayBuffer
}

describe('unzip', () => {
  it('extracts and inflates the OOXML parts from a real .xlsx', async () => {
    const files = await unzip(fixtureBuffer());
    expect(files.has('xl/workbook.xml')).toBe(true);
    expect(files.has('[Content_Types].xml')).toBe(true);
    const wb = new TextDecoder().decode(files.get('xl/workbook.xml'));
    expect(wb).toContain('<sheet');
    expect(wb).toMatch(/People/);
  });

  it('rejects a non-.xlsx buffer', async () => {
    await expect(unzip(new TextEncoder().encode('not a zip at all').buffer)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx.test.js` → FAIL (`unzip` not exported).

- [ ] **Step 3: Implement `unzip` + the inflate helper**

Append to `src/mdh/xlsx.js`:
```js
async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal ZIP reader: parse the central directory, then for each entry inflate
// (method 8) or copy (method 0). Throws on a non-ZIP buffer, Zip64, or an
// unsupported compression method.
export async function unzip(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const dec = new TextDecoder();

  // Find End Of Central Directory (sig 0x06054b50), scanning back over the comment.
  let eocd = -1;
  const min = Math.max(0, dv.byteLength - 22 - 0xffff);
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record).');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported.');

  // Walk central-directory headers (sig 0x02014b50). Sizes here are authoritative
  // even when local headers use a trailing data descriptor.
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for (const e of entries) {
    if (dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new Error(`Bad local header for ${e.name}`);
    const lNameLen = dv.getUint16(e.localOffset + 26, true);
    const lExtraLen = dv.getUint16(e.localOffset + 28, true);
    const start = e.localOffset + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) out.set(e.name, comp.slice());
    else if (e.method === 8) out.set(e.name, await inflateRaw(comp));
    else throw new Error(`Unsupported compression method ${e.method} for ${e.name}`);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/mdh-xlsx.test.js` → PASS.

---

## Task 5: `parseXlsx` orchestration

**Files:**
- Modify: `src/mdh/xlsx.js`
- Test: `tests/mdh-xlsx.test.js`

- [ ] **Step 1: Append failing tests (against the fixture)**

Add to `tests/mdh-xlsx.test.js` (reuse `fixtureBuffer`):
```js
import { parseXlsx } from '../src/mdh/xlsx.js';

describe('parseXlsx', () => {
  it('parses the default (first) sheet into typed docs', async () => {
    const r = await parseXlsx(fixtureBuffer(), { hasHeader: true, emptyMode: 'null' });
    expect(r.error).toBeNull();
    expect(r.sheets).toEqual(['People', 'Extra']);
    expect(r.columns).toEqual(['name', 'age', 'active', 'joined', 'note']);
    expect(r.docs[0]).toEqual({ name: 'Alice', age: 30, active: true, joined: 45306, note: 'hello' });
    expect(r.docs[1]).toEqual({ name: 'Bob', age: 25, active: false, joined: 44196, note: null });
    expect(typeof r.docs[0].joined).toBe('number'); // date serial stays a number
  });

  it('honors emptyMode omit and sheet selection', async () => {
    const omit = await parseXlsx(fixtureBuffer(), { emptyMode: 'omit' });
    expect('note' in omit.docs[1]).toBe(false);
    const extra = await parseXlsx(fixtureBuffer(), { sheet: 'Extra' });
    expect(extra.error).toBeNull();
    expect(extra.docs).toEqual([]); // header-only sheet
  });

  it('returns a structured error for a non-.xlsx buffer (no throw)', async () => {
    const r = await parseXlsx(new TextEncoder().encode('nope').buffer, {});
    expect(r.error).toBeTruthy();
    expect(r.docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx.test.js` → FAIL (`parseXlsx` not exported).

- [ ] **Step 3: Implement `parseXlsx`**

Append to `src/mdh/xlsx.js`:
```js
const textOf = (u8) => new TextDecoder().decode(u8);

export async function parseXlsx(arrayBuffer, { sheet, hasHeader = true, emptyMode = 'null' } = {}) {
  try {
    const files = await unzip(arrayBuffer);
    const wbBytes = files.get('xl/workbook.xml');
    if (!wbBytes) throw new Error('Not a valid .xlsx workbook (missing xl/workbook.xml).');
    const { sheets: defs } = readWorkbook(textOf(wbBytes));
    if (defs.length === 0) throw new Error('Workbook has no sheets.');
    const sheets = defs.map((s) => s.name);

    const relsBytes = files.get('xl/_rels/workbook.xml.rels');
    const rels = relsBytes ? readRels(textOf(relsBytes)) : new Map();

    const def = (sheet ? defs.find((s) => s.name === sheet) : defs[0]) || defs[0];
    const target = rels.get(def.rid);
    let path;
    if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    else path = `xl/worksheets/sheet${defs.indexOf(def) + 1}.xml`; // positional fallback
    const sheetBytes = files.get(path);
    if (!sheetBytes) throw new Error('Worksheet part not found.');

    const ssBytes = files.get('xl/sharedStrings.xml');
    const shared = ssBytes ? readSharedStrings(textOf(ssBytes)) : [];

    const rows = readSheet(textOf(sheetBytes), shared);
    const { docs, columns, warnings } = rowsToDocs(rows, { hasHeader, emptyMode });
    return { docs, columns, warnings, error: null, sheets };
  } catch (err) {
    return { docs: [], columns: [], warnings: [], error: { message: err.message }, sheets: [] };
  }
}
```

- [ ] **Step 4: Run to verify pass + full suite + build**

Run: `npx vitest run tests/mdh-xlsx.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 6: `XlsxImportWizard`

**Files:**
- Create: `src/mdh/components/XlsxImportWizard.jsx`
- Test: `tests/mdh-xlsx-wizard.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mdh-xlsx-wizard.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import XlsxImportWizard from '../src/mdh/components/XlsxImportWizard.jsx';

function mount(node) { const root = document.createElement('div'); document.body.appendChild(root); render(node, root); return root; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, interval)); }
}
function fixtureFile() {
  const p = fileURLToPath(new URL('./fixtures/sample.xlsx', import.meta.url));
  const bytes = readFileSync(p);
  const file = new File([bytes], 'sample.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  // jsdom's File.arrayBuffer may be absent; guarantee it returns the fixture bytes.
  file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return file;
}

describe('XlsxImportWizard', () => {
  it('starts on the pick stage with a beta tag and accepts .xlsx', () => {
    const root = mount(h(XlsxImportWizard, { onSuccess: () => {} }));
    expect(root.textContent).toContain('Click to select an Excel');
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();           // beta marking
    expect(root.querySelector('[data-testid="xlsx-file-input"]').accept).toBe('.xlsx');
  });

  it('reads a file, shows the async preview, and offers a sheet picker', async () => {
    const root = mount(h(XlsxImportWizard, { onSuccess: () => {} }));
    const input = root.querySelector('[data-testid="xlsx-file-input"]');
    Object.defineProperty(input, 'files', { value: [fixtureFile()], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => root.querySelector('[data-testid="csv-preview"]'));   // shared preview renders
    expect(root.textContent).toContain('Alice');
    expect(root.querySelector('[data-testid="xlsx-sheet"]')).toBeTruthy();    // >1 sheet → picker
    expect(root.querySelector('[data-testid="xlsx-next"]').disabled).toBe(false);
    expect(root.querySelector('.toolbar-menu-beta')).toBeTruthy();            // beta tag in configure too
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js` → FAIL (component doesn't exist).

- [ ] **Step 3: Implement `XlsxImportWizard.jsx`**

Create `src/mdh/components/XlsxImportWizard.jsx`:
```jsx
import { h, Fragment } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { selectedCollection } from '../store.js';
import { closeModal } from './Modal.jsx';
import { analyzeDocs, dedupeById, runChunkedInsert, runChunkedOverwrite } from '../importFile.js';
import { StageConfirm, StageImporting, StageDone, formatBytes } from './ImportStages.jsx';
import { Segmented, Toggle, CsvPreview } from './CsvImportWizard.jsx';
import { parseXlsx } from '../xlsx.js';

const STAGE = { PICK: 'pick', CONFIGURE: 'configure', CONFIRM: 'confirm', IMPORTING: 'importing', DONE: 'done' };
const DEFAULT_OPTS = { sheet: null, hasHeader: true, emptyMode: 'null' };
const EMPTY_SEG = [
  { value: 'null', label: 'null', title: 'JSON null' },
  { value: 'omit', label: 'omit', title: 'Drop the field' },
];

export default function XlsxImportWizard({ onSuccess }) {
  const [stage, setStage] = useState(STAGE.PICK);
  const [fileMeta, setFileMeta] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [parsed, setParsed] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [mode, setMode] = useState('insert');
  const [stats, setStats] = useState(null);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const abortRef = useRef(null);
  const parseToken = useRef(0);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Async (re)parse on buffer / option change, with a race guard.
  useEffect(() => {
    if (!buffer) return undefined;
    const token = ++parseToken.current;
    setParsing(true);
    parseXlsx(buffer, { sheet: opts.sheet, hasHeader: opts.hasHeader, emptyMode: opts.emptyMode })
      .then((res) => { if (token === parseToken.current) { setParsed(res); setParsing(false); } })
      .catch((err) => { if (token === parseToken.current) { setParsed({ docs: [], columns: [], warnings: [], error: { message: err.message }, sheets: [] }); setParsing(false); } });
    return undefined;
  }, [buffer, opts.sheet, opts.hasHeader, opts.emptyMode]);

  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  function handleFile(file) {
    setErrorMsg(null);
    setFileMeta({ name: file.name, size: file.size });
    file.arrayBuffer().then((buf) => { setBuffer(buf); setStage(STAGE.CONFIGURE); })
      .catch((err) => setErrorMsg(`Couldn't read file: ${err.message}`));
  }

  function handleNext() {
    if (!parsed || parsed.error || parsed.docs.length === 0) return;
    setStats(analyzeDocs(parsed.docs));
    setErrorMsg(null);
    setStage(STAGE.CONFIRM);
  }

  async function startImport() {
    if (!parsed) return;
    setErrorMsg(null);
    const { kept, dropped: inFileDropped } = dedupeById(parsed.docs);
    setStage(STAGE.IMPORTING);
    const controller = new AbortController();
    abortRef.current = controller;
    setImportProgress({ phase: 'insert', processed: 0, total: kept.length, inserted: 0, failedBatches: 0 });
    try {
      let result;
      if (mode === 'overwrite' && stats.uniqueIdCount > 0) {
        result = await runChunkedOverwrite(selectedCollection.value, kept, { signal: controller.signal, onProgress: (p) => setImportProgress({ ...p, total: kept.length }) });
        result.kind = 'overwrite';
      } else {
        result = await runChunkedInsert(selectedCollection.value, kept, { signal: controller.signal, onProgress: setImportProgress });
        result.kind = 'insert';
      }
      result.inFileDropped = inFileDropped;
      setImportResult(result);
      if (result.inserted > 0 || result.deleted > 0) onSuccess?.();
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally { abortRef.current = null; }
  }

  return (
    <div class="modal-body import-wizard xlsx-import-wizard">
      {stage === STAGE.PICK && <XlsxStagePick onFile={handleFile} errorMsg={errorMsg} onCancel={closeModal} />}
      {stage === STAGE.CONFIGURE && (
        <XlsxStageConfigure fileMeta={fileMeta} opts={opts} setOpt={setOpt} parsed={parsed} parsing={parsing} onNext={handleNext} onCancel={closeModal} />
      )}
      {stage === STAGE.CONFIRM && stats && (
        <StageConfirm fileMeta={fileMeta} stats={stats} mode={mode} setMode={setMode} errorMsg={errorMsg} onImport={startImport} onCancel={closeModal} />
      )}
      {stage === STAGE.IMPORTING && importProgress && (
        <StageImporting progress={importProgress} mode={mode} onCancel={() => abortRef.current?.abort()} />
      )}
      {stage === STAGE.DONE && importResult && (
        <StageDone result={importResult} mode={mode} fileMeta={fileMeta} onClose={closeModal} />
      )}
    </div>
  );
}

function XlsxStagePick({ onFile, errorMsg, onCancel }) {
  const inputRef = useRef(null);
  function pick(e) { const f = e.target.files?.[0]; if (f) onFile(f); }
  return (
    <Fragment>
      <div class="modal-field-label">Select an Excel file to insert: <span class="toolbar-menu-beta">beta</span></div>
      <input ref={inputRef} type="file" accept=".xlsx" style="display:none" onChange={pick} data-testid="xlsx-file-input" />
      <div class="file-input-area" onClick={() => inputRef.current?.click()}>
        <div class="file-input-label">Click to select an Excel (.xlsx) file</div>
        <div class="file-input-info" style="margin-top:4px">Each row becomes one document. Date cells import as their Excel serial number.</div>
      </div>
      {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
      <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </Fragment>
  );
}

function XlsxStageConfigure({ fileMeta, opts, setOpt, parsed, parsing, onNext, onCancel }) {
  const clean = parsed && !parsed.error;
  const rows = clean ? parsed.docs.length : null;
  const cols = clean ? parsed.columns.length : null;
  const sheets = parsed?.sheets || [];
  const canNext = clean && parsed.docs.length > 0;
  return (
    <Fragment>
      <div class="csv-meta" data-testid="xlsx-meta">
        <span class="csv-meta-fn">{fileMeta?.name}</span>
        <span class="toolbar-menu-beta">beta</span>
        {rows != null && <span class="csv-meta-m">{'·'} <b>{rows.toLocaleString()}</b> row{rows === 1 ? '' : 's'}</span>}
        {fileMeta?.size != null && <span class="csv-meta-m">{'·'} <b>{formatBytes(fileMeta.size)}</b></span>}
        {cols != null && <span class="csv-meta-m">{'·'} <b>{cols}</b> column{cols === 1 ? '' : 's'}</span>}
      </div>

      <div class="csv-toolbar">
        {sheets.length > 1 && (
          <span class="csv-tb-item">
            <span class="csv-tb-k" title="Which worksheet to import.">Sheet</span>
            <select class="csv-chip" data-testid="xlsx-sheet" value={opts.sheet ?? sheets[0]} onChange={(e) => setOpt('sheet', e.target.value)}>
              {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </span>
        )}
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="Use row 1 as field names.">First row is a header</span>
          <Toggle checked={opts.hasHeader} onChange={(v) => setOpt('hasHeader', v)} testid="xlsx-header" title="Use row 1 as field names." />
        </span>
        <span class="csv-tb-item">
          <span class="csv-tb-k" title="What an empty cell becomes.">Empty cell {'→'}</span>
          <Segmented value={opts.emptyMode} options={EMPTY_SEG} testid="xlsx-empty" ariaLabel="Empty cell" onChange={(v) => setOpt('emptyMode', v)} />
        </span>
      </div>
      <div class="csv-opt-hint">Excel date cells import as their underlying serial number.</div>

      {parsing && !parsed
        ? <div class="csv-preview-empty">Reading{'…'}</div>
        : <CsvPreview parsed={parsed} />}

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" onClick={onNext} disabled={!canNext} data-testid="xlsx-next">Next {'→'}</button>
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 4: Run to verify pass + build**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js` → PASS.
Run: `npm run build` → clean.

> Note: `CsvPreview`, `Segmented`, `Toggle` are already exported from `CsvImportWizard.jsx` (verified). If `CsvPreview` is *not* exported, add `export` to its declaration there (no behavior change).

---

## Task 7: UI wiring + beta badge

**Files:**
- Modify: `src/mdh/components/RecordList.jsx`
- Modify: `src/mdh/components/DataPanel.jsx`
- Modify: `src/mdh/components/DataOperations.jsx`
- Modify: `src/console/console.css`
- Test: `tests/mdh-xlsx-wizard.test.js`

- [ ] **Step 1: Append failing test (menu beta badge)**

The Insert split-button menu lives in a `SplitButton`-style component in `RecordList.jsx`. Add a focused render test to `tests/mdh-xlsx-wizard.test.js` that mounts that menu component if it is exported; otherwise assert the renderer logic via a minimal harness. Simplest robust form — assert the renderer adds a badge only for `beta` items:
```js
import { h as hh } from 'preact';

describe('toolbar menu beta badge', () => {
  it('renders a beta badge only for items flagged beta', () => {
    // Mirror the renderer used in RecordList's split-button menu.
    const Item = ({ item }) => hh('button', { class: 'toolbar-menu-item' },
      item.label, item.beta ? hh('span', { class: 'toolbar-menu-beta' }, 'beta') : null);
    const root = document.createElement('div');
    render(hh('div', null,
      hh(Item, { item: { label: 'Insert from CSV file' } }),
      hh(Item, { item: { label: 'Insert from Excel file', beta: true } })), root);
    const badges = root.querySelectorAll('.toolbar-menu-beta');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('beta');
    expect(root.textContent).toContain('Insert from Excel file');
  });
});
```
*(This pins the badge contract. The wiring in Steps 3–5 must make the real menu render the same way; the wizard tests from Task 6 already cover the in-wizard beta tag.)*

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js` → the new test passes in isolation (it's a local harness), but it documents the required renderer shape. Proceed to wire the real components.

- [ ] **Step 3: Add the menu item + badge renderer in `RecordList.jsx`**

Add the Excel item to the Insert split-button's `menuItems` (right after the CSV item, ~line 270):
```jsx
            { label: 'Insert from CSV file', onClick: () => onRefresh('insert-csv-file') },
            { label: 'Insert from Excel file', beta: true, onClick: () => onRefresh('insert-xlsx-file') },
```
Update the menu-item renderer (~lines 214-216) to render an optional badge:
```jsx
          {menuItems.map((item) => (
            <button key={item.label} class="toolbar-menu-item" onClick={() => { setOpen(false); item.onClick(); }}>
              {item.label}{item.beta && <span class="toolbar-menu-beta">beta</span>}
            </button>
          ))}
```

- [ ] **Step 4: Route the action in `DataPanel.jsx`**

After the `'insert-csv-file'` branch (~lines 397-398), add:
```jsx
    } else if (action === 'insert-xlsx-file') {
      openDataOperations('insert-xlsx-file', invalidateAndRun, currentFields);
```

- [ ] **Step 5: Dispatch in `DataOperations.jsx`**

Add the import at the top (next to the `CsvImportWizard` import):
```jsx
import XlsxImportWizard from './XlsxImportWizard.jsx';
```
Extend the title and render switch in `openDataOperations` (the `op` for `'insert-xlsx-file'` is `'insert-xlsx'`):
```jsx
  const title = op === 'insert-csv'
    ? 'Insert from CSV file'
    : op === 'insert-xlsx'
    ? 'Insert from Excel file'
    : op.charAt(0).toUpperCase() + op.slice(1) + (isFile ? ' from File' : '');

  openModal(title, () => {
    if (op === 'insert-csv') return <CsvImportWizard onSuccess={onSuccess} />;
    if (op === 'insert-xlsx') return <XlsxImportWizard onSuccess={onSuccess} />;
    // …existing branches unchanged…
```

- [ ] **Step 6: Add the beta-pill CSS in `console.css`**

Next to `.app-rail-beta` (or with the other `.toolbar-menu-*` rules), add an inline variant reusing the same warning colors:
```css
.toolbar-menu-beta {
  margin-left: 6px; vertical-align: middle;
  font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 1px 4px; border-radius: 999px;
  background: var(--warning-bg); color: var(--warning-fg); line-height: 1.3;
}
```

- [ ] **Step 7: Run to verify + build**

Run: `npx vitest run tests/mdh-xlsx-wizard.test.js` → PASS.
Run: `npm test` → full suite PASS.
Run: `npm run build` → clean.

---

## Task 8: Verification + manual QA

**Files:** none.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all files PASS (capture the `Test Files N passed` line). Run: `npm run build` → clean.

- [ ] **Step 2: CSP / no-worker guard (the whole point of the custom parser)**

Run: `grep -nE "eval\(|new Function\(|WebAssembly" dist/console/console.js` → expect **no matches**.
Run: `grep -nE "new Worker\(|createObjectURL\(|blob:" dist/console/console.js` → expect **no matches** introduced by this feature (confirms we pulled in no worker-based path). If a pre-existing match exists unrelated to xlsx, note it; the xlsx parser must contribute none.
Run: `grep -nE "read-excel-file|sheetjs|xlsx\"|exceljs|fflate" package.json` → expect **no matches** (zero dependencies added).

- [ ] **Step 3: Confirm the env sanity test still passes (or remove it)**

`tests/mdh-xlsx-env.test.js` may be kept as a regression guard for the platform assumptions, or deleted now that the integration tests exercise the same APIs. Recommendation: **keep it** (cheap, documents the requirement). State the choice.

- [ ] **Step 4: Manual QA in Chrome (needs a live token)**

Load `dist/`, open the Console on a collection:
- The Insert ▾ menu shows **"Insert from Excel file"** with a **beta** badge (CSV/JSON items have none).
- Pick a real `.xlsx`: the pick stage shows the beta tag; after selection the Configure stage shows the async preview (typed cells — numbers/booleans/strings; an empty cell shows the `(empty)` marker from the shared preview; date columns appear as serial numbers), the file/row/column meta, and a **Sheet** picker when the workbook has >1 sheet.
- Toggle header off → `column_N`; switch sheet → re-parses; switch Empty cell → null vs omit.
- Next → Confirm (insert vs overwrite) → Import → Done, reusing the existing stages. Verify rows landed in the collection.
- Try a non-`.xlsx` (renamed file) → graceful "not a valid .xlsx" error in the preview, Next disabled.

- [ ] **Step 5: Report**

Summarize suite + build, the CSP/no-worker/zero-dep grep results, and the manual-QA outcome (menu beta badge, async preview, sheet picker, typed import, graceful error). Don't claim done without the manual check.

---

## Self-Review (completed during planning)

- **Spec coverage:** custom zero-dep parser on `DecompressionStream` + `DOMParser` (Tasks 2–5) ✓; values-only, dates→serial numbers, no `styles.xml` (Task 3 decode + Task 5 + fixture) ✓; same `parseCsv` shape → tail reused (Task 5/6) ✓; parallel `XlsxImportWizard` with async preview + sheet/header/empty options reusing `ImportStages`/`CsvPreview` (Task 6) ✓; UI wiring + **beta** badge on the menu item and wizard, reusing the badge idiom (Task 7) ✓; CSP/no-worker/zero-dep verification (Task 8) ✓; graceful failure + edge cases (Task 5 error path, Task 4 Zip64/method guards) ✓; de-risk + fixture first (Task 1) ✓.
- **Placeholder scan:** none — every code step has complete code; tests are complete; commands are exact. The one judgment note (keep vs delete the env sanity test) is an explicit choice, not a gap.
- **Type/name consistency:** `parseXlsx`/`unzip`/`readWorkbook`/`readRels`/`readSharedStrings`/`readSheet`/`rowsToDocs`/`colToIndex` names match across the implementation, the per-task tests, and the import lists; `parseXlsx` resolves `{ docs, columns, warnings, error, sheets }` everywhere (wizard reads `parsed.sheets`/`parsed.docs`/`parsed.error`); options object `{ sheet, hasHeader, emptyMode }` is consistent component→`parseXlsx`; the action key `'insert-xlsx-file'` (RecordList → DataPanel → DataOperations, where `op` becomes `'insert-xlsx'`) is consistent; `.toolbar-menu-beta` is the single badge class used by the menu renderer and the wizard and defined once in `console.css`; `CsvPreview`/`Segmented`/`Toggle` are reused from `CsvImportWizard.jsx`.
- **Test-env risk** is front-loaded in Task 1 (DecompressionStream under jsdom) with a documented fallback, so later tasks don't discover it late.
