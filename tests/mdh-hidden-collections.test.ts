import { describe, it, expect } from 'vitest';
import {
  isHiddenCollection,
  visibleCollections,
  HIDDEN_PREFIX,
} from '../src/mdh/hiddenCollections.js';
import { COLLECTION, LEGACY_COLLECTION } from '../src/fabry/architect/collectionNames.js';

describe('hiddenCollections', () => {
  it('hides the extension prefix and the legacy Architect collection', () => {
    expect(isHiddenCollection(COLLECTION)).toBe(true);
    expect(isHiddenCollection(LEGACY_COLLECTION)).toBe(true);
    expect(isHiddenCollection('_SA_EXTENSION__anything')).toBe(true);
  });

  it('leaves the customer own collections alone, including near-misses', () => {
    for (const n of [
      'suppliers',
      '_SA_EXTENSION',
      '_SA_extension__x',
      'sa_extension__x',
      '__mrfabry_other',
      '_PROD_materials',
    ]) {
      expect(isHiddenCollection(n), n).toBe(false);
    }
  });

  it('the Architect collection MUST be caught by the prefix rule, not only by name', () => {
    // A future rename that drops the prefix would silently unhide it.
    expect(COLLECTION.startsWith(HIDDEN_PREFIX)).toBe(true);
  });

  it('filters, preserves order, and reveals on request', () => {
    const names = ['alpha', COLLECTION, 'beta', LEGACY_COLLECTION];
    expect(visibleCollections(names)).toEqual(['alpha', 'beta']);
    expect(visibleCollections(names, true)).toEqual(names);
    expect(visibleCollections(names, true)).not.toBe(names); // copy, never the caller's array
  });

  it('tolerates junk', () => {
    expect(isHiddenCollection(undefined)).toBe(false);
    expect(visibleCollections(null)).toEqual([]);
  });
});

describe('applyCollectionFilter (the one place the split is applied)', () => {
  it("splits the sorted list: the customer's collections, and ours in their own group", async () => {
    const store = await import('../src/mdh/store.js');
    store.rawCollections.value = ['zeta', COLLECTION, 'alpha', LEGACY_COLLECTION];
    store.showHiddenCollections.value = false;
    store.selectedCollection.value = null;
    expect(store.applyCollectionFilter()).toEqual(['alpha', 'zeta']);
    expect(store.collections.value).toEqual(['alpha', 'zeta']);
    // Ours are listed separately rather than merged in on reveal.
    expect(store.hiddenCollections.value).toEqual(
      [LEGACY_COLLECTION, COLLECTION].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    );
  });

  it('expanding the group does not change either list', async () => {
    const store = await import('../src/mdh/store.js');
    store.rawCollections.value = ['alpha', COLLECTION];
    store.selectedCollection.value = null;
    store.showHiddenCollections.value = false;
    store.applyCollectionFilter();
    const before = [store.collections.value, store.hiddenCollections.value];
    store.showHiddenCollections.value = true;
    store.applyCollectionFilter();
    expect(store.collections.value).toEqual(before[0]);
    expect(store.hiddenCollections.value).toEqual(before[1]);
  });

  it('keeps a selection on one of OUR collections — visibility is not the test, existence is', async () => {
    const store = await import('../src/mdh/store.js');
    store.rawCollections.value = ['alpha', COLLECTION];
    store.showHiddenCollections.value = false;
    store.selectedCollection.value = COLLECTION;
    store.applyCollectionFilter();
    expect(store.selectedCollection.value).toBe(COLLECTION);
    // ...and the group opens itself, so the highlight is not hidden under a collapsed header
    expect(store.showHiddenCollections.value).toBe(true);
  });

  it('clears a selection that has actually disappeared', async () => {
    const store = await import('../src/mdh/store.js');
    store.rawCollections.value = ['alpha'];
    store.selectedCollection.value = 'deleted-elsewhere';
    store.applyCollectionFilter();
    expect(store.selectedCollection.value).toBe(null);
  });
});
