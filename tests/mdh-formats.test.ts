// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { FORMATS, getFormat, detectFormat, ALL_ACCEPT } from '../src/mdh/formats/index.js';

describe('format registry', () => {
  it('exposes the five formats with accept + read type', () => {
    expect(Object.keys(FORMATS).sort()).toEqual(['csv', 'json', 'jsonl', 'xlsx', 'xml']);
    expect(getFormat('csv').read).toBe('arrayBuffer');
    expect(getFormat('xlsx').read).toBe('arrayBuffer');
    expect(getFormat('json').read).toBe('text');
    expect(getFormat('json').accept).toContain('.json');
    expect(getFormat('jsonl').accept).toContain('.jsonl');
  });

  it('json parse wraps a single object into an array', () => {
    expect(getFormat('json').parse('{"a":1}').docs).toEqual([{ a: 1 }]);
    expect(getFormat('json').parse('[{"a":1},{"a":2}]').docs.length).toBe(2);
  });

  it('json parse falls back to NDJSON on whole-file parse failure', () => {
    const r = getFormat('json').parse('{"a":1}\n{"a":2}');
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('jsonl parse rejects a non-jsonl blob with an error', () => {
    expect(getFormat('jsonl').parse('not json\nstill not').error).toBeTruthy();
  });

  it('csv parse yields row objects', () => {
    const r = getFormat('csv').parse(new TextEncoder().encode('a,b\n1,2\n').buffer, getFormat('csv').defaultOpts);
    expect(r.docs).toEqual([{ a: '1', b: '2' }]);
  });

  it('json/jsonl have no ConfigureControls; csv/xlsx/xml do', () => {
    expect(getFormat('json').ConfigureControls).toBeUndefined();
    expect(typeof getFormat('csv').ConfigureControls).toBe('function');
    expect(typeof getFormat('xlsx').ConfigureControls).toBe('function');
    expect(typeof getFormat('xml').ConfigureControls).toBe('function');
  });
});

describe('detectFormat', () => {
  it('maps extensions to format ids', () => {
    expect(detectFormat('vendors.json')).toBe('json');
    expect(detectFormat('data.jsonl')).toBe('jsonl');
    expect(detectFormat('data.ndjson')).toBe('jsonl');
    expect(detectFormat('rows.csv')).toBe('csv');
    expect(detectFormat('book.xlsx')).toBe('xlsx');
    expect(detectFormat('feed.xml')).toBe('xml');
  });
  it('is case-insensitive', () => {
    expect(detectFormat('DATA.CSV')).toBe('csv');
    expect(detectFormat('Book.XLSX')).toBe('xlsx');
  });
  it('returns null for unknown / missing extensions', () => {
    expect(detectFormat('notes.txt')).toBeNull();
    expect(detectFormat('noext')).toBeNull();
    expect(detectFormat('')).toBeNull();
    expect(detectFormat(null)).toBeNull();
  });
});

describe('ALL_ACCEPT', () => {
  it('includes every format extension token', () => {
    for (const ext of ['.json', '.jsonl', '.ndjson', '.csv', '.xlsx', '.xml']) {
      expect(ALL_ACCEPT).toContain(ext);
    }
  });
});

describe('csv detectOpts', () => {
  it('autodetects the delimiter from an ArrayBuffer sample', () => {
    const buf = new TextEncoder().encode('a;b\n1;2\n').buffer;
    expect(getFormat('csv').detectOpts!(buf)).toEqual({ delimiter: ';' });
  });
  it('only CSV provides detectOpts', () => {
    expect(typeof getFormat('csv').detectOpts).toBe('function');
    expect(getFormat('json').detectOpts).toBeUndefined();
    expect(getFormat('xlsx').detectOpts).toBeUndefined();
    expect(getFormat('xml').detectOpts).toBeUndefined();
  });
});
