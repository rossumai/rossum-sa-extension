// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  crc32, indexToCol, sanitizeSheetName, localHeader, eocd,
  cellXml, rowXml, escapeXmlText, workbookXml, STYLES_XML, buildXlsxSerializer,
} from '../src/mdh/xlsxWrite.js';
import { parseXlsx } from '../src/mdh/xlsx.js';

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
    expect(dv.getUint16(26, true)).toBe(new TextEncoder().encode('a.xml').length);
  });
  it('eocd starts with the end-of-central-directory signature', () => {
    const e = eocd({ count: 1, cdSize: 10, cdOffset: 20 });
    const dv = new DataView(e.buffer);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(1);
  });
});

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

// Drive the serializer like the engine does, collecting bytes.
async function buildWorkbook(docs, columns, opts = {}) {
  const ser = buildXlsxSerializer({ sheetName: 'Data', columns, ...opts });
  const parts = [];
  const writeBytes = async (chunk) => {
    parts.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
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
  it('round-trips strings, numbers and booleans', async () => {
    const docs = [
      { name: 'Alice', age: 30, active: true },
      { name: 'Bob', age: 25, active: false },
    ];
    const buf = await buildWorkbook(docs, ['name', 'age', 'active']);
    const { docs: back, columns, error } = await parseXlsx(buf, { hasHeader: true, emptyMode: 'omit' });
    expect(error).toBe(null);
    expect(columns).toEqual(['name', 'age', 'active']);
    expect(back[0]).toEqual({ name: 'Alice', age: 30, active: true });
    expect(back[1]).toEqual({ name: 'Bob', age: 25, active: false });
  });

  it('omits the header row when header:false', async () => {
    const buf = await buildWorkbook([{ a: 1 }], ['a'], { header: false });
    const { docs } = await parseXlsx(buf, { hasHeader: false });
    expect(docs[0]).toEqual({ column_1: 1 });
  });

  // Strengthened to assert {$date} once Task 5 (reader date conversion) lands.
  it('round-trips a date cell as an EJSON $date', async () => {
    const buf = await buildWorkbook([{ joined: { $date: '2024-01-01T00:00:00.000Z' } }], ['joined']);
    const { docs, error } = await parseXlsx(buf, { hasHeader: true, emptyMode: 'omit' });
    expect(error).toBe(null);
    expect(docs[0]).toEqual({ joined: { $date: '2024-01-01T00:00:00.000Z' } });
  });
});
