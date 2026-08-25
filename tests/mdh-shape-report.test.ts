import { describe, it, expect } from 'vitest';
import { buildLedger, findFlattenedCauses } from '../src/mdh/shapeReport.js';

// buildLedger / findFlattenedCauses are pure presentation logic over a raw
// validateAgainstShape() result — no DOM. See src/mdh/shape.ts for the shape
// of `check` (missing/unknown/typeMismatch/whitespace + missingTypes/unknownTypes).

function check(overrides: any) {
  return {
    missing: [],
    unknown: [],
    typeMismatch: [],
    whitespace: [],
    missingTypes: new Map(),
    unknownTypes: new Map(),
    ...overrides,
  };
}

describe('buildLedger', () => {
  it('renders a missing finding: collection type from missingTypes, file null, kind missing', () => {
    const rows = buildLedger(
      check({
        missing: ['address.city'],
        missingTypes: new Map([['address.city', 'string']]),
      }),
    );
    expect(rows).toEqual([
      { path: 'address.city', root: 'address', collection: 'string', file: null, kind: 'missing' },
    ]);
  });

  it('renders an unexpected finding: collection null, file type from unknownTypes, kind unexpected', () => {
    const rows = buildLedger(
      check({
        unknown: ['address'],
        unknownTypes: new Map([['address', 'string']]),
      }),
    );
    expect(rows).toEqual([
      { path: 'address', root: 'address', collection: null, file: 'string', kind: 'unexpected' },
    ]);
  });

  it('renders a wrong-type finding: expected joined with "/", got as-is, kind type', () => {
    const rows = buildLedger(
      check({
        typeMismatch: [{ path: 'updated', expected: ['date'], got: 'string' }],
      }),
    );
    expect(rows).toEqual([
      { path: 'updated', root: 'updated', collection: 'date', file: 'string', kind: 'type' },
    ]);
  });

  it('renders a multi-type wrong-type finding joined with "/"', () => {
    const rows = buildLedger(
      check({
        typeMismatch: [{ path: 'qty', expected: ['number', 'string'], got: 'bool' }],
      }),
    );
    expect(rows[0].collection).toBe('number/string');
  });

  it('renders a whitespace finding: both cells are SPELLINGS, not types, kind whitespace', () => {
    const rows = buildLedger(
      check({
        whitespace: [{ expected: 'sku', got: 'sku ' }],
      }),
    );
    expect(rows).toEqual([
      { path: 'sku ', root: 'sku ', collection: 'sku', file: 'sku ', kind: 'whitespace' },
    ]);
  });

  it('groups rows by root, in first-seen order, keeping leaves of the same parent together', () => {
    const rows = buildLedger(
      check({
        missing: ['key.code', 'key.system', 'address.line', 'address.city'],
        unknown: ['key', 'address'],
        typeMismatch: [{ path: 'updated', expected: ['date'], got: 'string' }],
        missingTypes: new Map([
          ['key.code', 'string'],
          ['key.system', 'string'],
          ['address.line', 'array'],
          ['address.city', 'string'],
        ]),
        unknownTypes: new Map([
          ['key', 'string'],
          ['address', 'string'],
        ]),
      }),
    );
    expect(rows.map((r) => r.path)).toEqual([
      'key.code',
      'key.system',
      'key',
      'address.line',
      'address.city',
      'address',
      'updated',
    ]);
    expect(rows.map((r) => r.root)).toEqual([
      'key',
      'key',
      'key',
      'address',
      'address',
      'address',
      'updated',
    ]);
  });

  it('an escaped dotted key is its own root, not a child of the unescaped prefix', () => {
    const rows = buildLedger(
      check({
        missing: ['a\\.b'],
        missingTypes: new Map([['a\\.b', 'string']]),
      }),
    );
    expect(rows[0].root).toBe('a.b');
  });

  it('falls back to a null cell when a path has no entry in the type map', () => {
    const rows = buildLedger(check({ missing: ['orphan'] })); // missingTypes has no 'orphan' entry
    expect(() => rows).not.toThrow();
    expect(rows).toEqual([
      { path: 'orphan', root: 'orphan', collection: null, file: null, kind: 'missing' },
    ]);
  });

  it('falls back to a null cell for an unknown path missing from unknownTypes', () => {
    const rows = buildLedger(check({ unknown: ['stray'] }));
    expect(rows[0]).toEqual({
      path: 'stray',
      root: 'stray',
      collection: null,
      file: null,
      kind: 'unexpected',
    });
  });
});

describe('findFlattenedCauses', () => {
  it('coalesces missing leaves under a root that also appears as a whole path in unknown', () => {
    const causes = findFlattenedCauses(
      check({
        missing: ['key.code', 'key.system'],
        unknown: ['key'],
      }),
    );
    expect(causes).toEqual([{ root: 'key', leaves: ['key.code', 'key.system'] }]);
  });

  it('reports one cause per flattened root, in root first-seen order', () => {
    const causes = findFlattenedCauses(
      check({
        missing: ['key.code', 'key.system', 'address.line', 'address.city'],
        unknown: ['key', 'address'],
      }),
    );
    expect(causes).toEqual([
      { root: 'key', leaves: ['key.code', 'key.system'] },
      { root: 'address', leaves: ['address.line', 'address.city'] },
    ]);
  });

  it('a missing root that is NOT also in unknown is not a flattened cause', () => {
    const causes = findFlattenedCauses(
      check({
        missing: ['meta.active'],
        unknown: [],
      }),
    );
    expect(causes).toEqual([]);
  });

  it('a missing root only counts once even with an unrelated unknown path present', () => {
    const causes = findFlattenedCauses(
      check({
        missing: ['meta.active'],
        unknown: ['stray'],
      }),
    );
    expect(causes).toEqual([]);
  });

  // A field literally named "a.b" (a real key containing a dot, escaped on
  // the wire as "a\.b") arrived flat: the collection has it nested with a
  // leaf "c" (encoded "a\.b.c", root "a.b"), the file provided one column
  // encoded "a\.b" (root "a.b" too, as a single segment). Matching them
  // requires decoding both sides — a raw-string comparison of the root
  // against the unknown entry would miss this (root has no backslash, the
  // unknown entry does).
  it('matches an escaped dotted root against its flat unknown column by decoded value, not raw string', () => {
    const causes = findFlattenedCauses(
      check({
        missing: ['a\\.b.c'],
        unknown: ['a\\.b'],
      }),
    );
    expect(causes).toEqual([{ root: 'a.b', leaves: ['a\\.b.c'] }]);
  });
});
