import { describe, it, expect } from 'vitest';
import { csvCell, csvRow, csvHeader, orderColumns } from '../src/mdh/csv.js';

describe('csvCell', () => {
  const d = { delimiter: ',' };
  it('renders scalars', () => {
    expect(csvCell('abc', d)).toBe('abc');
    expect(csvCell(42, d)).toBe('42');
    expect(csvCell(true, d)).toBe('true');
    expect(csvCell(false, d)).toBe('false');
    expect(csvCell(null, d)).toBe('');
    expect(csvCell(undefined, d)).toBe('');
  });
  it('JSON-encodes objects and arrays', () => {
    expect(csvCell({ a: 1 }, d)).toBe('"{""a"":1}"');     // quoted because it contains a comma? no comma here, but contains "
    expect(csvCell([1, 2], d)).toBe('"[1,2]"');           // contains the delimiter , -> quoted
  });
  it('quotes and doubles quotes when the cell contains delimiter, quote, or newline', () => {
    expect(csvCell('a,b', d)).toBe('"a,b"');
    expect(csvCell('he said "hi"', d)).toBe('"he said ""hi"""');
    expect(csvCell('line1\nline2', d)).toBe('"line1\nline2"');
    expect(csvCell('semi;colon', { delimiter: ';' })).toBe('"semi;colon"');
  });
  it('unwraps EJSON scalar wrappers to their inner value (matches the rest of the app)', () => {
    expect(csvCell({ $oid: '507f1f77bcf86cd799439011' }, d)).toBe('507f1f77bcf86cd799439011');
    expect(csvCell({ $date: '2026-01-02T03:04:05.000Z' }, d)).toBe('2026-01-02T03:04:05.000Z');
  });
  it('still JSON-encodes genuine (non-EJSON) objects', () => {
    expect(csvCell({ a: 1 }, d)).toBe('"{""a"":1}"');
  });
});

describe('csvRow / csvHeader', () => {
  it('joins cells by the delimiter in column order; missing key -> empty', () => {
    const cols = ['_id', 'name', 'active'];
    expect(csvRow({ _id: 'V1', name: 'Acme', active: true }, cols, { delimiter: ',' }))
      .toBe('V1,Acme,true');
    expect(csvRow({ _id: 'V2', name: 'Globex' }, cols, { delimiter: ',' }))
      .toBe('V2,Globex,');
  });
  it('quotes header names containing the delimiter', () => {
    expect(csvHeader(['_id', 'full,name'], { delimiter: ',' })).toBe('_id,"full,name"');
  });
});

describe('orderColumns', () => {
  it('puts _id first then sorts the rest alphabetically', () => {
    expect(orderColumns(['name', '_id', 'active'])).toEqual(['_id', 'active', 'name']);
  });
  it('omits _id when absent', () => {
    expect(orderColumns(['b', 'a'])).toEqual(['a', 'b']);
  });
  it('handles an empty key set', () => {
    expect(orderColumns([])).toEqual([]);
  });
});

describe('csvRow with dotted columns', () => {
  it('reads a nested value by its dotted path', () => {
    const doc = { _id: 'x', address: { city: 'TOWN', line: ['PO BOX 1'] } };
    expect(csvRow(doc, ['_id', 'address.city', 'address.line'], { delimiter: ',' }))
      .toBe('x,TOWN,"[""PO BOX 1""]"');
  });

  it('leaves a column the document lacks empty', () => {
    expect(csvRow({ a: { b: 1 } }, ['a.b', 'a.c'], { delimiter: ',' })).toBe('1,');
  });

  it('reads a literal dotted key through its escaped header', () => {
    expect(csvRow({ 'a.b': 7 }, ['a\\.b'], { delimiter: ',' })).toBe('7');
  });
});
