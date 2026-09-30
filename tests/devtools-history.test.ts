import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  histories,
  railOpen,
  selected,
  historyRef,
  ensureHistory,
  invalidateHistory,
  previousOf,
  openRail,
  setOrg,
  snapshots,
} from '../src/devtools/history.js';

const e = (version_id: number, over: any = {}) =>
  ({
    version_id,
    object_type: 'hook',
    object_id: 48,
    version_event: 'update',
    changed_fields: ['config'],
    version_created_at: '2026-09-29T09:00:00Z',
    modifier_id: 7,
    ...over,
  }) as any;

beforeEach(() => {
  histories.value = {};
  railOpen.value = false;
  selected.value = null;
});

describe('historyRef', () => {
  it('accepts resolved detail tabs of tracked types only', () => {
    expect(
      historyRef({ type: 'hook', id: '48', apiPath: '/api/v1/hooks/48', label: 'Hook' }),
    ).toEqual({
      type: 'hook',
      id: 48,
      key: '/api/v1/hooks/48',
    });
    expect(
      historyRef({ type: 'hook', apiPath: '/api/v1/hooks', label: 'Hooks', readOnly: true }),
    ).toBeNull();
    expect(
      historyRef({ type: 'user', id: '5', apiPath: '/api/v1/users/5', label: 'User' }),
    ).toBeNull();
    expect(historyRef({ type: 'schema', via: 'queue', queueId: '1', label: 'Schema' })).toBeNull();
    expect(historyRef(null)).toBeNull();
  });
});

describe('ensureHistory', () => {
  const ref = { type: 'hook' as const, id: 48, key: '/api/v1/hooks/48' };

  it('reads ONE page for the count and names, never paging further', async () => {
    const get = vi.fn(async (p: string) => {
      if (p.startsWith('/api/v1/users'))
        return { results: [{ id: 7, first_name: 'Jane', last_name: 'Doe' }] };
      return {
        pagination: { total: 250, next: 'n' },
        results: [e(3, { changed_fields: ['settings'] }), e(2)],
      };
    });
    await ensureHistory(ref, get);
    const s = histories.value[ref.key];
    expect(s.status).toBe('ready');
    expect(s.total).toBe(250);
    expect(s.entries.map((x) => x.version_id)).toEqual([3, 2]);
    expect(s.users.get(7)).toBe('Jane Doe');
    expect(get.mock.calls.filter(([p]) => p.includes('configuration_changelog'))).toHaveLength(1);
  });

  it('records 403 as forbidden and does not refetch a known key', async () => {
    const get = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status: 403 });
    });
    await ensureHistory(ref, get);
    expect(histories.value[ref.key].status).toBe('forbidden');
    await ensureHistory(ref, get);
    expect(get).toHaveBeenCalledTimes(1);
    invalidateHistory(ref.key);
    expect(histories.value[ref.key]).toBeUndefined();
  });
});

describe('previousOf', () => {
  it('finds the nearest earlier version of the same object, ignoring other objects', () => {
    const list = [e(9), e(8, { object_id: 99 }), e(5), e(2)];
    expect(previousOf(e(9), list)!.version_id).toBe(5);
    expect(previousOf(e(2), list)).toBeNull();
  });
});

describe('openRail', () => {
  it('opens the rail on live', () => {
    selected.value = e(3);
    openRail();
    expect(railOpen.value).toBe(true);
    expect(selected.value).toBeNull();
  });
});

describe('ensureHistory races', () => {
  const ref = { type: 'hook' as const, id: 48, key: '/api/v1/hooks/48' };

  function deferred(entryId: number) {
    let resolve!: () => void;
    let reject!: () => void;
    const gate = new Promise<void>((res, rej) => {
      resolve = res;
      reject = () => rej(new Error('late'));
    });
    const get = async (p: string) => {
      if (p.startsWith('/api/v1/users')) return { results: [] };
      await gate;
      return { pagination: { total: 1, next: null }, results: [e(entryId)] };
    };
    return { get, resolve, reject };
  }

  it('a stale load finishing after a newer one does not overwrite it', async () => {
    const a = deferred(1);
    const b = deferred(2);
    const pa = ensureHistory(ref, a.get);
    invalidateHistory(ref.key);
    const pb = ensureHistory(ref, b.get);
    b.resolve();
    await pb;
    a.resolve();
    await pa;
    expect(histories.value[ref.key].entries.map((x) => x.version_id)).toEqual([2]);
  });

  it('a stale load rejecting after a newer one does not overwrite it', async () => {
    const a = deferred(1);
    const b = deferred(2);
    const pa = ensureHistory(ref, a.get);
    invalidateHistory(ref.key);
    const pb = ensureHistory(ref, b.get);
    b.resolve();
    await pb;
    a.reject();
    await pa;
    expect(histories.value[ref.key].status).toBe('ready');
    expect(histories.value[ref.key].entries.map((x) => x.version_id)).toEqual([2]);
  });
});

describe('setOrg', () => {
  it('drops every per-org cache when the inspected page moves to another org', () => {
    setOrg('https://a.rossum.app');
    histories.value = {
      '/api/v1/hooks/5': { status: 'ready', total: 3, entries: [], users: new Map() },
    };
    snapshots.set(9, { id: 5 });
    selected.value = e(9);
    setOrg('https://a.rossum.app'); // same org: nothing is dropped
    expect(Object.keys(histories.value)).toEqual(['/api/v1/hooks/5']);
    setOrg('https://b.rossum.app');
    expect(histories.value).toEqual({});
    expect(snapshots.size).toBe(0);
    expect(selected.value).toBeNull();
  });
});
