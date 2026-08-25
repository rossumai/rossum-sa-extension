// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { rowsToDocs, colToIndex } from '../src/mdh/xlsx.js';
import { readWorkbook, readRels, readSharedStrings, readSheet } from '../src/mdh/xlsx.js';

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

  it('keeps renamed columns unique when the suffix would itself collide', () => {
    const { docs, columns } = rowsToDocs([['id', 'id', 'id_2'], [1, 2, 3]], { hasHeader: true });
    // The second 'id' renames to 'id_2'; the third column's literal 'id_2'
    // header then collides and must bump again to 'id_2_2' rather than silently
    // overwriting the renamed column. All three keys stay distinct (matches the
    // collision-safe csv.js dedupeHeaders: ['a','a','a_2'] -> ['a','a_2','a_2_2']).
    expect(columns).toEqual(['id', 'id_2', 'id_2_2']);
    expect(new Set(columns).size).toBe(3);     // all keys distinct
    expect(Object.keys(docs[0])).toHaveLength(3);
    expect(docs[0]).toEqual({ id: 1, id_2: 2, id_2_2: 3 }); // all three values preserved
  });

  it('drops fully-empty rows and returns empty for a header-only sheet', () => {
    expect(rowsToDocs([['only']], { hasHeader: true }).docs).toEqual([]);
    expect(rowsToDocs([['a'], [undefined], [], ['x']], { hasHeader: true }).docs).toEqual([{ a: 'x' }]);
  });
});

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

import { readFileSync } from 'node:fs';
// Use node:url's URL/fileURLToPath, not jsdom's global URL — under the jsdom test
// env the global URL resolves a relative spec against the document base
// (http://localhost:3000/) instead of import.meta.url's file:// URL, which would
// make fileURLToPath throw "The URL must be of scheme file".
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { unzip } from '../src/mdh/xlsx.js';

function fixtureBuffer() {
  const p = fileURLToPath(new NodeURL('./fixtures/sample.xlsx', import.meta.url));
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

import { readStyles, readWorkbook as readWb, rowsToDocs as xlsxRowsToDocs } from '../src/mdh/xlsx.js';

describe('readStyles', () => {
  it('flags cellXfs entries whose numFmt is a date', () => {
    const xml = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';
    expect(readStyles(xml)).toEqual([false, true, true]);
  });
});

describe('readWorkbook date1904', () => {
  const WB = (pr: any) => `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pr}<sheets><sheet name="A" r:id="rId1"/></sheets></workbook>`;
  it('reads the date1904 flag', () => {
    expect(readWb(WB('<workbookPr date1904="1"/>')).date1904).toBe(true);
    expect(readWb(WB('')).date1904).toBe(false);
  });
});

describe('rowsToDocs emptyMode/trim (xlsx)', () => {
  it("supports emptyMode 'empty'", () => {
    const { docs } = xlsxRowsToDocs([['a', 'b'], ['x', undefined]], { hasHeader: true, emptyMode: 'empty' });
    expect(docs[0]).toEqual({ a: 'x', b: '' });
  });
  it('trims string cells when trim:true, leaving non-strings untouched', () => {
    const { docs } = xlsxRowsToDocs([['a'], ['  hi  '], [42]], { hasHeader: true, trim: true });
    expect(docs[0]).toEqual({ a: 'hi' });
    expect(docs[1]).toEqual({ a: 42 });
  });
});
