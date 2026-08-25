import { describe, it, expect } from 'vitest';
import { restoreDocs, formatRestoreSummary } from '../src/mdh/restoreValues.js';
import { deriveShape } from '../src/mdh/shape.js';

const one = (docs: any, shape: any, opts?: any) => restoreDocs(docs, shape, opts).docs[0];

describe('layer 0 — un-dotting', () => {
  it('rebuilds nesting from dotted headers', () => {
    expect(one([{ 'a.b': '1', 'a.c': '2' }], null)).toEqual({ a: { b: '1', c: '2' } });
  });

  it('keeps a literal dotted key literal', () => {
    expect(one([{ 'a\\.b': '1' }], null)).toEqual({ 'a.b': '1' });
  });

  it('counts un-dotted columns once for the file, not once per row', () => {
    const { summary } = restoreDocs([{ 'a.b': '1' }, { 'a.b': '2' }], null);
    expect(summary.nestedColumns).toBe(1);
  });
});

describe('layer 1 — the collection decides', () => {
  const shape = deriveShape([{
    name: 'x', at: { $date: '2026-01-31T09:00:00.000Z' }, ref: { $oid: '000000000000000000000001' },
    n: 1, ok: true, tags: ['a'], code: '123456',
  }]);

  it('restores a date, an ObjectId, a number and a boolean', () => {
    const d = one([{ name: 'y', at: '2026-02-01T00:00:00.000Z', ref: '0000000000000000000000ff', n: '42', ok: 'true', tags: '["p","q"]', code: '999' }], shape);
    expect(d.at).toEqual({ $date: '2026-02-01T00:00:00.000Z' });
    expect(d.ref).toEqual({ $oid: '0000000000000000000000ff' });
    expect(d.n).toBe(42);
    expect(d.ok).toBe(true);
    expect(d.tags).toEqual(['p', 'q']);
  });

  it('NEVER converts a path the collection calls a string', () => {
    const d = one([{ name: '{"looks":"like json"}', at: '2026-02-01T00:00:00.000Z', ref: 'x', n: '1', ok: 'true', tags: '[]', code: '123456' }], shape);
    expect(d.name).toBe('{"looks":"like json"}');
    expect(d.code).toBe('123456');
  });

  it('wraps a scalar into an array when the collection says array (the XML case)', () => {
    expect(one([{ tags: 'solo' }], deriveShape([{ tags: ['a'] }]))).toEqual({ tags: ['solo'] });
  });

  it('leaves a value that does not match the expected form alone, for the guard to report', () => {
    expect(one([{ at: 'not-a-date' }], deriveShape([{ at: { $date: 'i' } }]))).toEqual({ at: 'not-a-date' });
  });

  it('has no opinion when the collection shows more than one non-null type', () => {
    const mixed = deriveShape([{ v: 1 }, { v: 'text' }]);
    expect(one([{ v: '2026-02-01T00:00:00.000Z' }], mixed)).toEqual({ v: '2026-02-01T00:00:00.000Z' });
  });
});

describe('empty cells', () => {
  it('drops the key when the collection says the path is optional', () => {
    const shape = deriveShape([{ sku: 'A', note: 'x' }, { sku: 'B' }]);
    expect(one([{ sku: 'C', note: '' }], shape)).toEqual({ sku: 'C' });
    expect(restoreDocs([{ sku: 'C', note: '' }], shape).summary.dropped).toBe(1);
  });

  it('becomes null on a required non-string path, where "" cannot be the value', () => {
    const shape = deriveShape([{ n: 1 }]);
    expect(one([{ n: '' }], shape)).toEqual({ n: null });
  });

  it('stays "" on a required string path', () => {
    expect(one([{ s: '' }], deriveShape([{ s: 'x' }]))).toEqual({ s: '' });
  });
});

describe('layers 2 and 3 — only where the collection has no opinion', () => {
  it('parses a JSON cell with no shape at all', () => {
    expect(one([{ a: '{"b":1}' }], null)).toEqual({ a: { b: 1 } });
    expect(one([{ a: '["x"]' }], null)).toEqual({ a: ['x'] });
  });

  it('leaves non-JSON text alone unless inference is opted into', () => {
    expect(one([{ n: '42' }], null)).toEqual({ n: '42' });
    expect(one([{ n: '42' }], null, { inferTypes: true })).toEqual({ n: 42 });
  });

  it('restores EJSON that survived JSON-encoding inside a legacy cell', () => {
    const shape = deriveShape([{ a: { at: { $date: 'i' } } }]);
    expect(one([{ a: '{"at":{"$date":"2026-02-01T00:00:00.000Z"}}' }], shape))
      .toEqual({ a: { at: { $date: '2026-02-01T00:00:00.000Z' } } });
  });

  it('ORDERING: the collection outranks inference — a known-string path survives it', () => {
    const shape = deriveShape([{ code: '000123' }]);
    expect(one([{ code: '123456' }], shape, { inferTypes: true })).toEqual({ code: '123456' });
  });
});

describe('conflicts', () => {
  it('warns instead of clobbering when a file carries both a and a.b', () => {
    const { summary } = restoreDocs([{ a: '1', 'a.b': '2' }], null);
    expect(summary.warnings.join(' ')).toMatch(/could not be nested/i);
  });
});

describe('formatRestoreSummary', () => {
  const empty = { nestedColumns: 0, json: 0, dates: 0, oids: 0, numbers: 0, bools: 0, arrays: 0, dropped: 0, nulled: 0, warnings: [] };

  it('is null when nothing was restored, so a clean import stays silent', () => {
    expect(formatRestoreSummary(empty, { hasShape: true })).toBe(null);
  });

  it('names each category and says it matched the collection', () => {
    const s = formatRestoreSummary({ ...empty, nestedColumns: 9, arrays: 1, dates: 1 }, { hasShape: true });
    expect(s).toMatch(/9 nested columns/);
    expect(s).toMatch(/1 array/);
    expect(s).toMatch(/1 date/);
    expect(s).toMatch(/to match the collection/);
  });

  it('explains why types were left as text when there is no shape', () => {
    expect(formatRestoreSummary({ ...empty, nestedColumns: 9 }, { hasShape: false }))
      .toMatch(/collection is empty, so value types were left as text/);
    expect(formatRestoreSummary({ ...empty, nestedColumns: 9 }, { hasShape: false, shapeError: true }))
      .toMatch(/couldn.t read the collection.s types/);
  });

  it('discloses an empty cell that was set to null on a required non-string path', () => {
    const shape = deriveShape([{ n: 1 }]);
    const { summary } = restoreDocs([{ n: '' }], shape);
    expect(summary.nulled).toBe(1);
    expect(formatRestoreSummary(summary, { hasShape: true })).toMatch(/1 empty field set to null/);
  });
});
