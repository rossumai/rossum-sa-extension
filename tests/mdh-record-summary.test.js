import { describe, it, expect } from 'vitest';
import { rankFields, recordSummary } from '../src/mdh/recordSummary.js';

describe('rankFields', () => {
  it('puts _id last when no other signals exist', () => {
    expect(rankFields({ _id: 'a', foo: 1 }, {})).toEqual(['foo', '_id']);
  });

  it('preserves original document key order within a tier', () => {
    expect(rankFields({ foo: 1, bar: 2, baz: 3 }, {})).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles empty record', () => {
    expect(rankFields({}, {})).toEqual([]);
  });

  it('handles record without _id', () => {
    expect(rankFields({ foo: 1, bar: 2 }, {})).toEqual(['foo', 'bar']);
  });

  it('demotes nested objects, arrays, null, empty string below primitives', () => {
    const record = { blob: { a: 1 }, arr: [1, 2], nothing: null, empty: '', num: 7, text: 'hi' };
    expect(rankFields(record, {})).toEqual(['num', 'text', 'blob', 'arr', 'nothing', 'empty']);
  });

  it('promotes name-pattern matches above generic primitives', () => {
    expect(rankFields({ foo: 1, name: 'Acme', bar: 2 }, {})).toEqual(['name', 'foo', 'bar']);
  });

  it('promotes name-suffix matches (_name, _code, _title)', () => {
    expect(rankFields({ other: 1, vendor_code: 'V1', company_name: 'Acme' }, {})).toEqual(
      ['vendor_code', 'company_name', 'other'],
    );
  });

  it('promotes indexed fields above name-pattern fields', () => {
    const indexes = [{ name: 'by_code', key: { code: 1 } }];
    // 'name' would be tier 2; 'code' is tier 1 via index; 'other' tier 3.
    expect(rankFields({ name: 'Acme', code: 'V1', other: 1 }, { indexes })).toEqual(
      ['code', 'name', 'other'],
    );
  });

  it('ignores the default _id_ index', () => {
    const indexes = [{ name: '_id_', key: { _id: 1 } }];
    expect(rankFields({ _id: 'a', foo: 1 }, { indexes })).toEqual(['foo', '_id']);
  });

  it('credits every top-level path of a compound index to tier 1', () => {
    const indexes = [{ name: 'compound', key: { b: 1, c: -1 } }];
    expect(rankFields({ a: 1, b: 2, c: 3 }, { indexes })).toEqual(['b', 'c', 'a']);
  });

  it('credits nested-path indexes to their first segment', () => {
    const indexes = [{ name: 'addr_city', key: { 'address.city': 1 } }];
    expect(rankFields({ address: { city: 'NYC' }, other: 1 }, { indexes })).toEqual(
      ['address', 'other'],
    );
  });

  it('keeps _id last even when other fields match no tier above 4', () => {
    const record = { _id: 'a', blob: { x: 1 } };
    expect(rankFields(record, {})).toEqual(['blob', '_id']);
  });

  it('treats missing or null indexes option as empty', () => {
    expect(rankFields({ foo: 1 }, { indexes: null })).toEqual(['foo']);
    expect(rankFields({ foo: 1 }, {})).toEqual(['foo']);
  });

  it('promotes EJSON scalar values ($oid, $date, $regex, $binary, $timestamp) to tier 3', () => {
    const record = {
      blob: { nested: 1 },
      ref: { $oid: '507f1f77bcf86cd799439011' },
      when: { $date: '2024-01-01T00:00:00Z' },
      pattern: { $regex: 'abc' },
      bin: { $binary: 'xx' },
      ts: { $timestamp: { t: 1, i: 1 } },
    };
    // All recognized single-key EJSON scalars are tier 3 and beat the nested-object `blob` (tier 4).
    expect(rankFields(record, {})).toEqual(['ref', 'when', 'pattern', 'bin', 'ts', 'blob']);
  });
});

describe('recordSummary — packing', () => {
  it('packs all fields when budget is ample', () => {
    const out = recordSummary({ name: 'Acme', code: 'V1' }, 200, {});
    expect(out).toBe('name: "Acme" \u00b7 code: "V1"');
  });

  it('demotes _id so name/code appear first', () => {
    const out = recordSummary({ _id: 'abc', name: 'Acme', code: 'V1' }, 200, {});
    // _id is tier 5 but still fits here because budget is ample
    expect(out).toBe('name: "Acme" \u00b7 code: "V1" \u00b7 _id: "abc"');
  });

  it('appends +N fields suffix when budget forces a drop', () => {
    // Budget is tight enough that only a couple of entries fit.
    const record = { a: 'xxxxx', b: 'yyyyy', c: 'zzzzz', d: 'wwwww', e: 'vvvvv' };
    const out = recordSummary(record, 40, {});
    expect(out).toMatch(/\+\d+ fields?$/);
    // The suffix consumes reserved space; at least one entry must have landed.
    expect(out.split(' \u00b7 ').length).toBeGreaterThanOrEqual(2);
  });

  it('uses singular "field" when exactly one field is dropped', () => {
    // Room for two short entries, one more is dropped → "+1 field".
    const record = { a: 1, b: 2, c: 3 };
    const out = recordSummary(record, 25, {});
    expect(out.endsWith('+1 field')).toBe(true);
  });

  it('uses plural "fields" when more than one is dropped', () => {
    const record = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const out = recordSummary(record, 25, {});
    expect(out).toMatch(/\+\d+ fields$/);
    // Extract number, confirm >= 2.
    const n = Number(out.match(/\+(\d+) fields$/)[1]);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('emits no suffix when every field fits', () => {
    const out = recordSummary({ a: 1, b: 2 }, 200, {});
    expect(out).not.toMatch(/\+\d+ fields?$/);
  });

  it('respects rank order when choosing which fields fit', () => {
    // code is indexed, so it wins a preview slot over `z` (tier 3).
    const record = { z: 'short', code: 'V1' };
    const indexes = [{ name: 'by_code', key: { code: 1 } }];
    const out = recordSummary(record, 22, { indexes });
    expect(out.startsWith('code: "V1"')).toBe(true);
  });
});

describe('recordSummary — edge cases', () => {
  it('returns "(empty record)" sentinel for {}', () => {
    expect(recordSummary({}, 200, {})).toBe('(empty record)');
  });

  it('truncates ObjectId-shaped _id as "_id: <first8>\u2026<last4>" when no other fields exist', () => {
    const record = { _id: { $oid: '507f1f77bcf86cd799439011' } };
    expect(recordSummary(record, 200, {})).toBe('_id: 507f1f77\u20269011');
  });

  it('uses the normal display path when _id is short (non-ObjectId)', () => {
    const record = { _id: 'short-id' };
    // Normal displayValue wraps strings in quotes.
    expect(recordSummary(record, 200, {})).toBe('_id: "short-id"');
  });

  it('truncates field #1 value aggressively when budget is too narrow for even one entry', () => {
    const record = { description: 'a very long text that will never fit a tiny budget' };
    // Tight budget: keyName (11) + ": " (2) + "\u2026" (1) = 14 chars for the non-value scaffolding.
    const out = recordSummary(record, 20, {});
    // Starts with "description: " and ends with the ellipsis character.
    expect(out.startsWith('description: ')).toBe(true);
    expect(out.endsWith('\u2026')).toBe(true);
    // No suffix even though nothing else fits — the chevron signals "more inside".
    expect(out).not.toMatch(/\+\d+ field/);
  });

  it('always shows at least the "v\u2026" minimum even at absurdly small budgets', () => {
    const record = { description: 'a very long text' };
    const out = recordSummary(record, 5, {}); // absurd
    expect(out.startsWith('description: ')).toBe(true);
    expect(out.endsWith('\u2026')).toBe(true);
  });
});
