import { describe, it, expect } from 'vitest';
import { COLLECTION, LEGACY_COLLECTION } from '../src/fabry/architect/collectionNames.js';
import { planCollection, isRaceLostError, mergeDeliverables, legacyOnlyIds } from '../src/fabry/architect/collectionPlan.js';

describe('planCollection', () => {
  it('uses the new collection when only it exists', () => {
    expect(planCollection({ hasNew: true, hasOld: false }))
      .toEqual({ use: COLLECTION, legacy: null, action: 'none', fallback: null });
  });

  it('creates the new collection for a fresh org', () => {
    const p = planCollection({ hasNew: false, hasOld: false });
    expect(p.action).toBe('create');
    expect(p.use).toBe(COLLECTION);
    expect(p.legacy).toBe(null);
  });

  it('renames a legacy-only org, and names the fallback for when the rename cannot happen', () => {
    const p = planCollection({ hasNew: false, hasOld: true });
    expect(p.action).toBe('rename');
    expect(p.use).toBe(COLLECTION);
    // the "older customers where we cannot rename it now" path: keep working, unchanged
    expect(p.fallback).toBe(LEGACY_COLLECTION);
  });

  it('merges when both exist — an older build recreated the legacy collection', () => {
    const p = planCollection({ hasNew: true, hasOld: true });
    expect(p.action).toBe('merge');
    expect(p.use).toBe(COLLECTION);
    expect(p.legacy).toBe(LEGACY_COLLECTION);
  });

  it('treats a missing argument as a fresh org rather than throwing', () => {
    expect(planCollection().action).toBe('create');
  });
});

describe('isRaceLostError', () => {
  it('recognises the server wording for a target that already exists', () => {
    // LIVE-VERIFIED wording + HTTP 400 on the internal org
    expect(isRaceLostError(new Error('target namespace exists'))).toBe(true);
    expect(isRaceLostError(new Error('collection _SA_EXTENSION__x already exists'))).toBe(true);
  });
  it('does not swallow unrelated failures', () => {
    expect(isRaceLostError(new Error('Session expired.'))).toBe(false);
    expect(isRaceLostError(new Error('Source collection ns.x does not exist'))).toBe(false);
    expect(isRaceLostError(null)).toBe(false);
  });
});

describe('mergeDeliverables', () => {
  const A = { id: 'a', order: 1, text: 'new A', editedAt: 200 };
  const Aold = { id: 'a', order: 1, text: 'old A', editedAt: 100 };
  const B = { id: 'b', order: 2, text: 'legacy only', editedAt: 50 };

  it('keeps the newest edit when both collections hold the same id', () => {
    expect(mergeDeliverables([A], [Aold]).map((d) => d.text)).toEqual(['new A']);
  });

  it('lets a NEWER legacy edit win — an older build wrote after we migrated', () => {
    const newer = { id: 'a', order: 1, text: 'legacy is newer', editedAt: 300 };
    expect(mergeDeliverables([A], [newer]).map((d) => d.text)).toEqual(['legacy is newer']);
  });

  it('keeps ids that exist only in the legacy collection', () => {
    expect(mergeDeliverables([A], [B]).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('falls back to createdAt, and never drops a doc that has neither stamp', () => {
    const noStamp = { id: 'c', order: 3 };
    const created = { id: 'a', order: 1, text: 'created only', createdAt: 500 };
    expect(mergeDeliverables([A], [created]).map((d) => d.text)).toEqual(['created only']);
    expect(mergeDeliverables([], [noStamp]).map((d) => d.id)).toEqual(['c']);
  });

  it('orders by order, not by which collection the doc came from', () => {
    expect(mergeDeliverables([{ id: 'z', order: 9 }], [{ id: 'y', order: 0 }]).map((d) => d.id))
      .toEqual(['y', 'z']);
  });

  it('tolerates absent lists and unidentified docs', () => {
    expect(mergeDeliverables(null, null)).toEqual([]);
    expect(mergeDeliverables([{ order: 1 }], [{ id: null }])).toEqual([]);
  });
});

describe('legacyOnlyIds', () => {
  it('reports which deliverables still live only in the legacy collection', () => {
    expect(legacyOnlyIds([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toEqual(['b']);
    expect(legacyOnlyIds([{ id: 'a' }], [{ id: 'a' }])).toEqual([]);
    expect(legacyOnlyIds(null, null)).toEqual([]);
  });
});
