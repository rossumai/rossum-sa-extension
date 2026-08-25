import { describe, it, expect } from 'vitest';
import {
  encodeSegment,
  decodeSegment,
  joinPath,
  splitPath,
  isOpaqueKey,
  isEjsonWrapper,
  flattenDoc,
  unflattenDoc,
  getByPath,
  hasByPath,
} from '../src/mdh/flatten.js';
import { tokenizeCsv } from '../src/mdh/csv.js';

describe('path grammar', () => {
  it('is a no-op for ordinary keys', () => {
    expect(encodeSegment('address')).toBe('address');
    expect(joinPath(['address', 'city'])).toBe('address.city');
    expect(splitPath('address.city')).toEqual(['address', 'city']);
  });

  it('encodeSegment and decodeSegment round-trip', () => {
    expect(decodeSegment(encodeSegment('a.b'))).toBe('a.b');
    expect(decodeSegment(encodeSegment('a\\b'))).toBe('a\\b');
    expect(decodeSegment(encodeSegment('ordinary'))).toBe('ordinary');
  });

  it('escapes a dot so a literal dotted key is distinguishable from nesting', () => {
    expect(joinPath(['a.b'])).toBe('a\\.b');
    expect(splitPath('a\\.b')).toEqual(['a.b']);
    expect(joinPath(['a', 'b'])).toBe('a.b');
    expect(splitPath('a.b')).toEqual(['a', 'b']);
    expect(joinPath(['a.b'])).not.toBe(joinPath(['a', 'b']));
  });

  it('escapes a backslash and round-trips it', () => {
    expect(joinPath(['a\\b'])).toBe('a\\\\b');
    expect(splitPath('a\\\\b')).toEqual(['a\\b']);
  });

  it('round-trips every segment through join then split', () => {
    for (const segs of [['a'], ['a', 'b'], ['a.b'], ['a\\b'], ['a.b', 'c'], ['x', 'y.z'], ['$k']]) {
      expect(splitPath(joinPath(segs))).toEqual(segs);
    }
  });
});

describe('isOpaqueKey', () => {
  it('is true for a dotted key and a $-prefixed key, false otherwise', () => {
    expect(isOpaqueKey('a.b')).toBe(true);
    expect(isOpaqueKey('$foo')).toBe(true); // a field path would become '$$foo' — a VARIABLE
    expect(isOpaqueKey('address')).toBe(false);
    expect(isOpaqueKey('a\\b')).toBe(false); // backslash is fine in a Mongo field path
  });
});

describe('isEjsonWrapper', () => {
  it('accepts a single-$-key object, or $date with 2 keys (metadata)', () => {
    expect(isEjsonWrapper({ $oid: 'x' })).toBe(true);
    expect(isEjsonWrapper({ $date: 'x' })).toBe(true);
    expect(isEjsonWrapper({ $date: 'x', y: 1 })).toBe(true); // $date allows metadata
    expect(isEjsonWrapper({ a: 1 })).toBe(false);
    expect(isEjsonWrapper([1])).toBe(false);
    expect(isEjsonWrapper(null)).toBe(false);
  });

  it('accepts the legacy 2-key $regex/$options form', () => {
    expect(isEjsonWrapper({ $regex: 'ab', $options: 'i' })).toBe(true);
  });
});

describe('flattenDoc', () => {
  it('expands nested objects into dotted paths', () => {
    expect(flattenDoc({ a: { b: 1, c: 2 }, d: 3 })).toEqual({ 'a.b': 1, 'a.c': 2, d: 3 });
  });

  it('treats arrays, EJSON wrappers and empty objects as leaves', () => {
    expect(flattenDoc({ tags: ['x'], id: { $oid: 'h' }, at: { $date: 'i' }, empty: {} })).toEqual({
      tags: ['x'],
      id: { $oid: 'h' },
      at: { $date: 'i' },
      empty: {},
    });
  });

  it('escapes a literal dotted key instead of expanding it', () => {
    expect(flattenDoc({ 'a.b': 1 })).toEqual({ 'a\\.b': 1 });
  });

  it('never descends into an opaque key — its whole subtree is one leaf', () => {
    expect(flattenDoc({ a: { 'b.c': { d: 1 } } })).toEqual({ 'a.b\\.c': { d: 1 } });
    expect(flattenDoc({ a: { $foo: { d: 1 } } })).toEqual({ 'a.$foo': { d: 1 } });
  });

  it('stops at the depth cap and leaves the rest as one value', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(flattenDoc(deep, { maxDepth: 3 })).toEqual({ 'a.b.c': { d: { e: { f: 1 } } } });
  });

  it('keeps an EJSON wrapper whose value is an OBJECT as a leaf', () => {
    // $binary/$regex/$timestamp carry object values; descending into them would
    // invent paths like `f.$binary.base64` in the Update match-key picker.
    const bin = { $binary: { base64: 'AA==', subType: '00' } };
    expect(isEjsonWrapper(bin)).toBe(true);
    expect(flattenDoc({ f: bin })).toEqual({ f: bin });
    expect(isEjsonWrapper({ $timestamp: { t: 1, i: 1 } })).toBe(true);
    expect(isEjsonWrapper({ $foo: { d: 1 } })).toBe(false); // not an EJSON type
  });

  it('keeps a legacy 2-key $regex/$options wrapper as a single leaf, not two dotted keys', () => {
    const re = { $regex: 'ab', $options: 'i' };
    expect(flattenDoc({ x: re })).toEqual({ x: re });
  });
});

describe('unflattenDoc', () => {
  it('rebuilds nesting and is the inverse of flattenDoc', () => {
    for (const doc of [
      { a: { b: 1, c: 2 }, d: 3 },
      { 'a.b': 1 },
      { a: { 'b.c': { d: 1 } } },
      { tags: ['x'], id: { $oid: 'h' } },
      { 'a\\b': 1 },
    ]) {
      expect(unflattenDoc(flattenDoc(doc)).doc).toEqual(doc);
    }
  });

  it('reports a conflict and keeps the key literal rather than clobbering', () => {
    const both = unflattenDoc({ a: 1, 'a.b': 2 });
    expect(both.conflicts).toEqual(['a.b']);
    expect(both.doc).toEqual({ a: 1, 'a.b': 2 });

    const reversed = unflattenDoc({ 'a.b': 2, a: 1 });
    expect(reversed.conflicts).toEqual(['a']);
    expect(reversed.doc.a).toEqual({ b: 2 }); // the nested build wins; the scalar cannot overwrite it
  });

  // Measured defect: a mixed object/scalar path emits a header the exporter's
  // own importer could not re-read — the export's empty cell means "no scalar
  // here" / "no nested value here", never a genuine conflict.
  it('treats an empty occupant ("" or null) as absent and keeps descending into it', () => {
    // Row A: v is blank (this row's v is the nested object), v.inner has the value.
    const a = unflattenDoc({ sku: 'A', v: '', 'v.inner': 'X' });
    expect(a.conflicts).toEqual([]);
    expect(a.doc).toEqual({ sku: 'A', v: { inner: 'X' } });

    const aNull = unflattenDoc({ sku: 'A', v: null, 'v.inner': 'X' });
    expect(aNull.conflicts).toEqual([]);
    expect(aNull.doc).toEqual({ sku: 'A', v: { inner: 'X' } });
  });

  it('silently drops an empty incoming value that would conflict with a real occupant, instead of reporting a conflict', () => {
    // Row B: v is a plain scalar on this row, so v.inner (blank) means nothing.
    // This is the order a real header always produces (both orderColumns and
    // orderExportColumns sort a parent path ahead of its own children, since
    // it is a strict string prefix of them) — the REVERSE order (reachable
    // only through a foreign/hand-edited file) is covered by the
    // order-independence table below.
    const b = unflattenDoc({ sku: 'B', v: 'plain', 'v.inner': '' });
    expect(b.conflicts).toEqual([]);
    expect(b.doc).toEqual({ sku: 'B', v: 'plain' });
  });

  it('still reports a genuine conflict when the colliding value is not empty (unchanged behaviour)', () => {
    const both = unflattenDoc({ a: 1, 'a.b': 2 });
    expect(both.conflicts).toEqual(['a.b']);
    const reversed = unflattenDoc({ 'a.b': 2, a: 1 });
    expect(reversed.conflicts).toEqual(['a']);
  });

  // Round 2 re-review: the empty-occupant handling above was itself
  // order-dependent. `unflattenDoc({sku:'B', 'v.inner':'', v:'plain'})` used
  // to build a spurious `{v:{inner:''}}` from the empty child (processed
  // first, so its occupant check never fired) and then report the REAL
  // scalar 'plain' as a conflict against that spurious object — losing the
  // value entirely. Unreachable through our own exports (orderColumns and
  // orderExportColumns always sort a parent ahead of its children), but
  // reachable through a foreign/hand-edited CSV with reordered columns,
  // which is exactly the Import Wizard's main job. Each row below is
  // asserted in BOTH column orders, and the two must agree.
  describe('order independence: the result does not depend on which column comes first', () => {
    const cases = [
      {
        name: 'v blank, v.inner filled -> nests under v',
        forward: { v: '', 'v.inner': 'X' },
        reverse: { 'v.inner': 'X', v: '' },
        doc: { v: { inner: 'X' } },
        conflicts: [],
      },
      {
        name: 'v.inner blank, v filled -> v stays the plain scalar',
        forward: { 'v.inner': '', v: 'plain' },
        reverse: { v: 'plain', 'v.inner': '' },
        doc: { v: 'plain' },
        conflicts: [],
      },
    ];
    for (const c of cases) {
      it(`${c.name} (forward order)`, () => {
        const r = unflattenDoc(c.forward);
        expect(r.doc).toEqual(c.doc);
        expect(r.conflicts).toEqual(c.conflicts);
      });
      it(`${c.name} (reverse order — the case the re-review measured)`, () => {
        const r = unflattenDoc(c.reverse);
        expect(r.doc).toEqual(c.doc);
        expect(r.conflicts).toEqual(c.conflicts);
      });
    }

    it('a plain empty single-segment column still lands as "" (restoreLeaf needs the key present)', () => {
      const r = unflattenDoc({ name: '' });
      expect(r.doc).toEqual({ name: '' });
      expect(r.conflicts).toEqual([]);
    });

    it('genuine conflicts (no empty side) are unaffected by the two-pass split, in either order', () => {
      const forward = unflattenDoc({ a: 1, 'a.b': 2 });
      expect(forward.doc).toEqual({ a: 1, 'a.b': 2 });
      expect(forward.conflicts).toEqual(['a.b']);

      const reverse = unflattenDoc({ 'a.b': 2, a: 1 });
      expect(reverse.doc.a).toEqual({ b: 2 }); // the nested build wins; the scalar cannot overwrite it
      expect(reverse.conflicts).toEqual(['a']);
    });
  });
});

describe('getByPath / hasByPath', () => {
  it('reads through an encoded path', () => {
    const doc = { a: { b: 1 }, 'a.b': 2 };
    expect(getByPath(doc, 'a.b')).toBe(1);
    expect(getByPath(doc, 'a\\.b')).toBe(2);
    expect(getByPath(doc, 'a.zz')).toBe(undefined);
    expect(hasByPath(doc, 'a.b')).toBe(true);
    expect(hasByPath(doc, 'a.zz')).toBe(false);
  });

  it('distinguishes a stored undefined-like value from an absent path', () => {
    expect(hasByPath({ a: { b: null } }, 'a.b')).toBe(true);
    expect(getByPath({ a: { b: null } }, 'a.b')).toBe(null);
  });
});

describe('escaped headers survive the CSV tokenizer', () => {
  it('keeps a backslash intact even with escapeChar set', () => {
    const { rows } = tokenizeCsv('a\\.b,c\r\n1,2', { escapeChar: '\\' });
    expect(rows[0]).toEqual(['a\\.b', 'c']); // escapeChar applies INSIDE quotes only
  });
});
