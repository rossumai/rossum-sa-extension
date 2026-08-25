// tests/devtools-diff.test.js
import { describe, it, expect } from 'vitest';
import { buildPatchBody, diffObjects } from '../src/devtools/diff.js';

describe('buildPatchBody', () => {
  it('sends only changed/added top-level keys, verbatim', () => {
    const o = { id: 1, name: 'A', metadata: {} };
    const e = { id: 1, name: 'B', metadata: {}, extra: true };
    expect(buildPatchBody(o, e)).toEqual({ body: { name: 'B', extra: true }, removed: [] });
  });

  it('preserves an entire nested key when one leaf inside it changes', () => {
    const o = { settings: { a: 1, b: { c: 2, d: 3 } } };
    const e = { settings: { a: 1, b: { c: 99, d: 3 } } };
    // The whole `settings` object must be sent so `a` and `d` are not dropped.
    expect(buildPatchBody(o, e)).toEqual({ body: { settings: { a: 1, b: { c: 99, d: 3 } } }, removed: [] });
  });

  it('does not send unchanged read-only meta keys', () => {
    const o = { id: 1, url: 'u', modified_at: 't', name: 'A' };
    const e = { id: 1, url: 'u', modified_at: 't', name: 'B' };
    expect(buildPatchBody(o, e).body).toEqual({ name: 'B' });
  });

  it('surfaces removed top-level keys without applying them', () => {
    const o = { name: 'A', gone: 1 };
    const e = { name: 'A' };
    expect(buildPatchBody(o, e)).toEqual({ body: {}, removed: ['gone'] });
  });

  it('treats key reordering as no change', () => {
    const o = { a: 1, b: 2 };
    const e = { b: 2, a: 1 };
    expect(buildPatchBody(o, e).body).toEqual({});
  });
});

describe('diffObjects', () => {
  it('classifies top-level keys', () => {
    const d = diffObjects({ a: 1, b: 2, c: 3 }, { a: 1, b: 20, d: 4 });
    expect(d.changed).toEqual(['b']);
    expect(d.added).toEqual(['d']);
    expect(d.removed).toEqual(['c']);
  });
  it('produces leaf paths for nested changes', () => {
    const d = diffObjects({ settings: { a: 1 } }, { settings: { a: 2 } });
    expect(d.leaves).toEqual([{ path: 'settings.a', before: 1, after: 2, kind: 'changed' }]);
  });
  it('emits a single changed leaf when a nested object becomes a scalar', () => {
    const d = diffObjects({ settings: { b: { x: 1 } } }, { settings: { b: 5 } });
    expect(d.leaves).toEqual([{ path: 'settings.b', before: { x: 1 }, after: 5, kind: 'changed' }]);
  });
  it('emits a single changed leaf when a scalar becomes an object', () => {
    const d = diffObjects({ settings: { b: 5 } }, { settings: { b: { x: 1 } } });
    expect(d.leaves).toEqual([{ path: 'settings.b', before: 5, after: { x: 1 }, kind: 'changed' }]);
  });
});
