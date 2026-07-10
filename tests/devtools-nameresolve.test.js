import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeNameResolver } from '../src/devtools/nameResolve.js';
import * as cache from '../src/devtools/resourceCache.js';

const U = (p) => `https://acme.rossum.app${p}`;
beforeEach(() => cache.clear());

describe('nameResolve.nameFor', () => {
  it('returns null for non-nameable URLs (no id, sub-resource, non-API)', () => {
    const r = makeNameResolver(vi.fn());
    expect(r.nameFor('https://x/dash/queues/1')).toBeNull();      // not /api/v1
    expect(r.nameFor(U('/api/v1/queues'))).toBeNull();            // no id
    expect(r.nameFor(U('/api/v1/annotations/1/content'))).toBeNull(); // read-only sub-resource
  });
  it('reflects cache state for a nameable URL', () => {
    const r = makeNameResolver(vi.fn());
    expect(r.nameFor(U('/api/v1/queues/1'))).toEqual({ status: 'none', name: null });
    cache.put('/api/v1/queues/1', { name: 'Q' });
    expect(r.nameFor(U('/api/v1/queues/1'))).toEqual({ status: 'done', name: 'Q' });
  });
});

describe('nameResolve.ensure', () => {
  it('fetches once, caches the name, notifies subscribers', async () => {
    const getJson = vi.fn(() => Promise.resolve({ name: 'Invoices' }));
    const r = makeNameResolver(getJson);
    const cb = vi.fn();
    r.ensure(U('/api/v1/queues/1'), cb);
    await vi.waitFor(() => cb.mock.calls.length === 1);
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledWith('/api/v1/queues/1');
    expect(cache.nameFor('/api/v1/queues/1')).toEqual({ status: 'done', name: 'Invoices' });
  });
  it('dedupes concurrent ensure() for the same URL (one fetch, all subscribers notified)', async () => {
    let resolve; const getJson = vi.fn(() => new Promise((res) => { resolve = res; }));
    const r = makeNameResolver(getJson);
    const cb1 = vi.fn(), cb2 = vi.fn();
    r.ensure(U('/api/v1/queues/1'), cb1);
    r.ensure(U('/api/v1/queues/1'), cb2);
    expect(getJson).toHaveBeenCalledTimes(1);
    resolve({ name: 'Q' });
    await vi.waitFor(() => cb1.mock.calls.length === 1 && cb2.mock.calls.length === 1);
  });
  it('caches errors (no annotation, no refetch)', async () => {
    const getJson = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { status: 403 })));
    const r = makeNameResolver(getJson);
    r.ensure(U('/api/v1/queues/1'));
    await vi.waitFor(() => r.nameFor(U('/api/v1/queues/1')).status === 'error');
    r.ensure(U('/api/v1/queues/1')); // must NOT refetch
    expect(getJson).toHaveBeenCalledTimes(1);
  });
  it('respects the concurrency cap', async () => {
    const resolvers = [];
    const getJson = vi.fn(() => new Promise((res) => resolvers.push(res)));
    const r = makeNameResolver(getJson, 3); // cap = 3
    for (let i = 0; i < 6; i++) r.ensure(U(`/api/v1/queues/${i}`));
    expect(getJson).toHaveBeenCalledTimes(3);       // only cap in flight
    resolvers[0]({ name: 'a' }); resolvers[1]({ name: 'b' });
    await vi.waitFor(() => getJson.mock.calls.length === 5); // two slots freed
  });
  it('does nothing for a non-nameable URL', () => {
    const getJson = vi.fn();
    const r = makeNameResolver(getJson);
    r.ensure(U('/api/v1/annotations/1/content'), vi.fn());
    expect(getJson).not.toHaveBeenCalled();
  });
});
