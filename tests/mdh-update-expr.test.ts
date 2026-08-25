import { describe, it, expect } from 'vitest';
import { stripEmptyOperators, trivialSetDiff } from '../src/mdh/updateExpr.js';

describe('stripEmptyOperators', () => {
  it('drops a top-level operator key whose value is an empty object', () => {
    expect(stripEmptyOperators({ $set: { a: 1 }, $unset: {} })).toEqual({ $set: { a: 1 } });
  });

  it('drops every empty operator key', () => {
    expect(stripEmptyOperators({ $set: {}, $unset: {}, $inc: {} })).toEqual({});
  });

  it('passes through expressions with no empty operators', () => {
    const expr = { $set: { a: 1 }, $unset: { b: '' } };
    expect(stripEmptyOperators(expr)).toEqual({ $set: { a: 1 }, $unset: { b: '' } });
  });

  it('only strips operator-style keys (those starting with $)', () => {
    // A replaceOne-style document with a literal field whose value is {} must
    // not be touched — that empty object is a legitimate field value.
    expect(stripEmptyOperators({ name: 'Acme', metadata: {} })).toEqual({ name: 'Acme', metadata: {} });
  });

  it('does not mutate the input', () => {
    const expr = { $set: { a: 1 }, $unset: {} };
    stripEmptyOperators(expr);
    expect(expr).toEqual({ $set: { a: 1 }, $unset: {} });
  });

  it('returns null/non-object inputs unchanged', () => {
    expect(stripEmptyOperators(null)).toBe(null);
    expect(stripEmptyOperators(undefined)).toBe(undefined);
    expect(stripEmptyOperators('foo')).toBe('foo');
    expect(stripEmptyOperators(42)).toBe(42);
  });

  it('treats arrays as opaque (does not strip from them)', () => {
    // Defensive: someone passes an array by mistake. Don't crash, don't mangle.
    const arr = [{ $set: {} }];
    expect(stripEmptyOperators(arr)).toBe(arr);
  });
});

describe('trivialSetDiff', () => {
  it('returns null for non-object input', () => {
    expect(trivialSetDiff(null, {})).toBe(null);
    expect(trivialSetDiff(undefined, {})).toBe(null);
    expect(trivialSetDiff('foo', {})).toBe(null);
  });

  it('returns null for shapes outside { $set, $unset }', () => {
    expect(trivialSetDiff({ $inc: { n: 1 } }, {})).toBe(null);
    expect(trivialSetDiff({ $set: {}, $rename: { a: 'b' } }, {})).toBe(null);
    expect(trivialSetDiff({ a: 1 }, {})).toBe(null);
    expect(trivialSetDiff({}, {})).toBe(null);
  });

  it('returns a from→to diff for $set-only expressions', () => {
    const doc = { name: 'Acme', taxId: '123' };
    const expr = { $set: { name: 'Beta', region: 'EMEA' } };
    expect(trivialSetDiff(expr, doc)).toEqual({
      name: { from: 'Acme', to: 'Beta' },
      region: { from: undefined, to: 'EMEA' },
    });
  });

  it('returns removed:true entries for $unset-only expressions', () => {
    const doc = { name: 'Acme', legacy: true };
    const expr = { $unset: { legacy: '' } };
    expect(trivialSetDiff(expr, doc)).toEqual({
      legacy: { from: true, removed: true },
    });
  });

  it('combines $set and $unset into a single diff map', () => {
    const doc = { name: 'Acme', legacy: true, taxId: '123' };
    const expr = { $set: { name: 'Beta' }, $unset: { legacy: '' } };
    expect(trivialSetDiff(expr, doc)).toEqual({
      name: { from: 'Acme', to: 'Beta' },
      legacy: { from: true, removed: true },
    });
  });

  it('skips empty $set or $unset blocks but accepts the surrounding shape', () => {
    // A user who has only filled $unset (with empty $set) should still get a diff.
    const doc = { legacy: true };
    expect(trivialSetDiff({ $set: {}, $unset: { legacy: '' } }, doc)).toEqual({
      legacy: { from: true, removed: true },
    });
    // And vice versa.
    expect(trivialSetDiff({ $set: { name: 'X' }, $unset: {} }, { name: 'Y' })).toEqual({
      name: { from: 'Y', to: 'X' },
    });
  });

  it('rejects malformed $set / $unset payloads', () => {
    expect(trivialSetDiff({ $set: 'oops' }, {})).toBe(null);
    expect(trivialSetDiff({ $unset: [1, 2] }, {})).toBe(null);
  });
});
