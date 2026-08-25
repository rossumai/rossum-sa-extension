import { describe, it, expect } from 'vitest';
import * as store from '../src/audit/store.js';

describe('audit store — Fabry state', () => {
  it('defaults: aiAvailable false, fabry idle and empty', () => {
    store.resetFabry();
    expect(store.aiAvailable.value).toBe(false);
    expect(store.fabry.value).toEqual({
      status: 'idle',
      chatId: null,
      turns: [],
      error: null,
      forView: null,
      refreshFailedFor: null,
    });
  });
  it('resetFabry restores the idle default after mutation', () => {
    store.fabry.value = {
      status: 'done',
      chatId: 'c1',
      error: 'x',
      forView: null,
      turns: [{ id: 1, question: null, text: 'hi', reasoning: '', tools: [], state: 'done' }],
    };
    store.resetFabry();
    expect(store.fabry.value.turns).toEqual([]);
    expect(store.fabry.value.status).toBe('idle');
    expect(store.fabry.value.chatId).toBe(null);
  });
});

describe('searchSignature — what counts as a new search', () => {
  const base = {
    audit: { object_type: 'annotation', action: '', search: '', page: 1, cursor: null },
  };

  it('ignores pagination, so a next-page click is not a search', () => {
    // Pagination.jsx patches page/cursor through patchFilters, i.e. into the
    // very object the tracking effect watches. Before this, every next-page
    // click was counted as sa_audit_search.
    const a = store.searchSignature('audit', base);
    const b = store.searchSignature('audit', { audit: { ...base.audit, page: 2 } });
    const c = store.searchSignature('audit', { audit: { ...base.audit, cursor: 'abc' } });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('still changes for a real filter change or a source change', () => {
    const a = store.searchSignature('audit', base);
    expect(
      store.searchSignature('audit', { audit: { ...base.audit, search: 'invoice' } }),
    ).not.toBe(a);
    expect(
      store.searchSignature('audit', { audit: { ...base.audit, object_type: 'queue' } }),
    ).not.toBe(a);
    expect(store.searchSignature('other', base)).not.toBe(a);
  });

  it('is order-independent, since patchFilters spreads keys', () => {
    const one = store.searchSignature('audit', { audit: { a: 1, b: 2 } });
    const two = store.searchSignature('audit', { audit: { b: 2, a: 1 } });
    expect(one).toBe(two);
  });

  it('tolerates an unknown source instead of throwing', () => {
    expect(() => store.searchSignature('nope', base)).not.toThrow();
    expect(() => store.searchSignature('audit', undefined)).not.toThrow();
  });
});
