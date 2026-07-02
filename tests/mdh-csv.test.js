import { describe, it, expect } from 'vitest';
import { tokenizeCsv, detectDelimiter } from '../src/mdh/csv.js';
import { inferValue, dedupeHeaders, rowsToDocs } from '../src/mdh/csv.js';
import { decodeBytes, parseCsv } from '../src/mdh/csv.js';

describe('tokenizeCsv', () => {
  it('parses plain rows', () => {
    expect(tokenizeCsv('a,b\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps the delimiter inside a quoted field', () => {
    expect(tokenizeCsv('"a,b",c').rows).toEqual([['a,b', 'c']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(tokenizeCsv('"a\nb",c').rows).toEqual([['a\nb', 'c']]);
  });

  it('collapses doubled quotes when doubleQuote is on', () => {
    expect(tokenizeCsv('"a""b"').rows).toEqual([['a"b']]);
  });

  it('uses escapeChar when set (doubleQuote off)', () => {
    // raw text: "a\"b"  -> field a"b
    const r = tokenizeCsv('"a\\"b"', { escapeChar: '\\', doubleQuote: false });
    expect(r.rows).toEqual([['a"b']]);
  });

  it('honours custom delimiters', () => {
    expect(tokenizeCsv('a;b', { delimiter: ';' }).rows).toEqual([['a', 'b']]);
    expect(tokenizeCsv('a\tb', { delimiter: '\t' }).rows).toEqual([['a', 'b']]);
    expect(tokenizeCsv('a|b', { delimiter: '|' }).rows).toEqual([['a', 'b']]);
  });

  it('handles CRLF, LF, and lone CR terminators', () => {
    expect(tokenizeCsv('a,b\r\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(tokenizeCsv('a,b\rc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops blank lines when skipEmptyLines is on, keeps them when off', () => {
    expect(tokenizeCsv('a,b\n\nc,d').rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(tokenizeCsv('a,b\n\nc,d', { skipEmptyLines: false }).rows)
      .toEqual([['a', 'b'], [''], ['c', 'd']]);
  });

  it('keeps a row of empty quoted fields (not a blank line)', () => {
    expect(tokenizeCsv('""').rows).toEqual([['']]);
    expect(tokenizeCsv('"",""').rows).toEqual([['', '']]);
  });

  it('returns empty rows for empty input', () => {
    expect(tokenizeCsv('').rows).toEqual([]);
  });

  it('reports an error for an unterminated quoted field', () => {
    const r = tokenizeCsv('"abc');
    expect(r.error).toBeTruthy();
    expect(r.error.message).toMatch(/unterminated/i);
  });

  it('returns null error on a clean parse', () => {
    expect(tokenizeCsv('a,b\nc,d').error).toBeNull();
  });

  it('preserves an embedded CRLF inside a quoted field', () => {
    expect(tokenizeCsv('"a\r\nb",c').rows).toEqual([['a\r\nb', 'c']]);
  });
});

describe('inferValue', () => {
  it('detects booleans case-insensitively', () => {
    expect(inferValue('true')).toBe(true);
    expect(inferValue('TRUE')).toBe(true);
    expect(inferValue('false')).toBe(false);
  });
  it('detects integers and decimals', () => {
    expect(inferValue('42')).toBe(42);
    expect(inferValue('-7')).toBe(-7);
    expect(inferValue('0')).toBe(0);
    expect(inferValue('3.14')).toBe(3.14);
    expect(inferValue('0.5')).toBe(0.5);
  });
  it('keeps leading-zero and non-numeric strings as strings', () => {
    expect(inferValue('01234')).toBe('01234');
    expect(inferValue('00')).toBe('00');
    expect(inferValue('1e5')).toBe('1e5');
    expect(inferValue('12abc')).toBe('12abc');
    expect(inferValue('+5')).toBe('+5');
  });
  it('keeps -0 as a string (JSON has no negative zero)', () => {
    expect(inferValue('-0')).toBe('-0');
    expect(inferValue('0')).toBe(0);
  });
});

describe('dedupeHeaders', () => {
  it('uniquifies duplicates and fills blanks with column_N', () => {
    expect(dedupeHeaders(['a', '', 'a'])).toEqual(['a', 'column_2', 'a_2']);
    expect(dedupeHeaders(['x', '  '])).toEqual(['x', 'column_2']);
  });
});

describe('rowsToDocs', () => {
  it('maps a header row to keys (strings by default)', () => {
    const r = rowsToDocs([['name', 'age'], ['Alice', '30']], { hasHeader: true });
    expect(r.columns).toEqual(['name', 'age']);
    expect(r.docs).toEqual([{ name: 'Alice', age: '30' }]);
  });
  it('infers types when inferTypes is on', () => {
    const r = rowsToDocs([['name', 'age'], ['Alice', '30']], { hasHeader: true, inferTypes: true });
    expect(r.docs).toEqual([{ name: 'Alice', age: 30 }]);
  });
  it('generates column_N names when there is no header', () => {
    const r = rowsToDocs([['a', 'b']], { hasHeader: false });
    expect(r.columns).toEqual(['column_1', 'column_2']);
    expect(r.docs).toEqual([{ column_1: 'a', column_2: 'b' }]);
  });
  it('resolves duplicate header names', () => {
    const r = rowsToDocs([['x', 'x'], ['1', '2']], { hasHeader: true });
    expect(r.docs).toEqual([{ x: '1', x_2: '2' }]);
  });
  it('handles empty cells per emptyMode', () => {
    const rows = [['a', 'b'], ['1', '']];
    expect(rowsToDocs(rows, { emptyMode: 'empty' }).docs).toEqual([{ a: '1', b: '' }]);
    expect(rowsToDocs(rows, { emptyMode: 'null' }).docs).toEqual([{ a: '1', b: null }]);
    expect(rowsToDocs(rows, { emptyMode: 'omit' }).docs).toEqual([{ a: '1' }]);
  });
  it('trims values when trim is on', () => {
    const r = rowsToDocs([['a'], [' x ']], { hasHeader: true, trim: true });
    expect(r.docs).toEqual([{ a: 'x' }]);
  });
  it('passes an _id column through unchanged', () => {
    const r = rowsToDocs([['_id', 'name'], ['V1', 'Acme']], { hasHeader: true });
    expect(r.docs).toEqual([{ _id: 'V1', name: 'Acme' }]);
  });
  it('warns about ragged rows and pads short ones', () => {
    const r = rowsToDocs([['a', 'b'], ['1']], { hasHeader: true, emptyMode: 'empty' });
    expect(r.docs).toEqual([{ a: '1', b: '' }]);
    expect(r.warnings.join(' ')).toMatch(/column count/i);
  });
  it('returns empty docs for no rows', () => {
    expect(rowsToDocs([]).docs).toEqual([]);
  });
});

describe('decodeBytes', () => {
  it('decodes utf-8 by default', () => {
    const bytes = new TextEncoder().encode('héllo');
    expect(decodeBytes(bytes.buffer)).toBe('héllo');
  });
  it('decodes windows-1252', () => {
    expect(decodeBytes(new Uint8Array([0x68, 0xE9]), 'windows-1252')).toBe('hé');
  });
  it('falls back to utf-8 for an unknown encoding label', () => {
    expect(decodeBytes(new Uint8Array([0x41]), 'bogus-enc-xyz')).toBe('A');
  });
});

describe('parseCsv', () => {
  it('decodes, tokenizes, and converts in one call', () => {
    const text = new TextEncoder().encode('a,b\n1,2');
    const r = parseCsv(text.buffer, { hasHeader: true });
    expect(r).toEqual({ docs: [{ a: '1', b: '2' }], columns: ['a', 'b'], warnings: [], error: null });
  });
  it('accepts a string buffer directly', () => {
    expect(parseCsv('a,b\n1,2', { hasHeader: true }).docs).toEqual([{ a: '1', b: '2' }]);
  });
  it('surfaces a tokenizer error', () => {
    expect(parseCsv('"oops', {}).error).toBeTruthy();
  });
});

describe('detectDelimiter', () => {
  it('detects comma, semicolon, and tab', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('picks the most frequent across the first non-empty lines', () => {
    // semicolons: 3 (one per line); commas: 1 (inside a value) -> semicolon wins
    expect(detectDelimiter('name;note\nAlice;hello, world\nBob;hi')).toBe(';');
  });
  it('defaults to comma on ties or when no delimiter is present', () => {
    expect(detectDelimiter('singlecolumn\nvalue')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});
