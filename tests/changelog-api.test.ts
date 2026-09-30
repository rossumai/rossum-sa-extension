import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  changelogPath,
  listEntries,
  snapshotPair,
  previousVersion,
  resolveUsers,
  isForbidden,
} from '../src/changelog/api.js';

const entry = (over: any = {}) => ({
  version_id: 10,
  object_type: 'hook',
  object_id: 48,
  name: 'Export to ERP',
  version_event: 'update',
  changed_fields: ['config'],
  version_created_at: '2026-09-25T09:01:25.131374+00:00',
  modifier_id: 7,
  description: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('changelogPath', () => {
  it('joins list filters with commas and always pages', () => {
    const p = changelogPath({ objectTypes: ['hook', 'rule'], objectIds: [1, 2] }, 3, 50);
    const q = new URL(`https://x${p}`).searchParams;
    expect(p.startsWith('/api/v1/configuration_changelog?')).toBe(true);
    expect(q.get('object_type')).toBe('hook,rule');
    expect(q.get('object_id')).toBe('1,2');
    expect(q.get('page')).toBe('3');
    expect(q.get('page_size')).toBe('50');
  });

  it('omits empty filters and maps versionIdMax to version_id_range_max', () => {
    const q = new URL(`https://x${changelogPath({ objectIds: [], versionIdMax: 9 })}`).searchParams;
    expect(q.has('object_id')).toBe(false);
    expect(q.get('version_id_range_max')).toBe('9');
    expect(q.get('page_size')).toBe('100');
  });
});

describe('listEntries', () => {
  it('returns entries, total and whether a next page exists', async () => {
    const get = vi.fn(async (_p: string) => ({
      pagination: { total: 14, next: 'https://x/next' },
      results: [entry()],
    }));
    const page = await listEntries(get, { objectTypes: ['hook'] }, 2);
    expect(page).toEqual({ entries: [entry()], total: 14, hasMore: true });
    expect(get.mock.calls[0][0]).toContain('page=2');
  });

  it('tolerates a body without pagination', async () => {
    const page = await listEntries(async () => ({}), {});
    expect(page).toEqual({ entries: [], total: null, hasMore: false });
  });
});

describe('snapshotPair', () => {
  it('asks for both versions with snapshots and keys them by version id', async () => {
    const get = vi.fn(async (_p: string) => ({
      results: [
        { ...entry({ version_id: 11 }), snapshot: { a: 2 } },
        { ...entry({ version_id: 10 }), snapshot: { a: 1 } },
      ],
    }));
    const m = await snapshotPair(get, [11, 10]);
    const q = new URL(`https://x${get.mock.calls[0][0]}`).searchParams;
    expect(q.get('version_id')).toBe('11,10');
    expect(q.get('include_snapshot')).toBe('true');
    expect(m.get(11)).toEqual({ a: 2 });
    expect(m.get(10)).toEqual({ a: 1 });
  });

  it('leaves out a version the server did not return', async () => {
    const m = await snapshotPair(
      async () => ({ results: [{ ...entry(), snapshot: {} }] }),
      [10, 9],
    );
    expect(m.has(9)).toBe(false);
  });
});

describe('previousVersion', () => {
  it('asks for one entry of the same object below the given version', async () => {
    const get = vi.fn(async (_p: string) => ({ results: [entry({ version_id: 4 })] }));
    const prev = await previousVersion(get, 'hook', 48, 10);
    const q = new URL(`https://x${get.mock.calls[0][0]}`).searchParams;
    expect(q.get('object_type')).toBe('hook');
    expect(q.get('object_id')).toBe('48');
    expect(q.get('version_id_range_max')).toBe('9');
    expect(q.get('page_size')).toBe('1');
    expect(prev!.version_id).toBe(4);
  });

  it('returns null when there is none', async () => {
    expect(await previousVersion(async () => ({ results: [] }), 'hook', 48, 10)).toBeNull();
  });
});

describe('resolveUsers', () => {
  it('names users by full name, falling back to email, and marks deleted ones', async () => {
    const get = vi.fn(async (_p: string) => ({
      results: [
        { id: 1, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' },
        { id: 2, first_name: '', last_name: '', email: 'ops@example.com' },
        { id: 3, first_name: 'John', last_name: 'Roe', deleted: true },
      ],
    }));
    const m = await resolveUsers(get, [1, 2, 3, 1]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain('id=1,2,3');
    expect(m.get(1)).toBe('Jane Doe');
    expect(m.get(2)).toBe('ops@example.com');
    expect(m.get(3)).toBe('John Roe (deleted)');
  });

  it('makes no request for an empty list', async () => {
    const get = vi.fn();
    expect((await resolveUsers(get, [])).size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('isForbidden', () => {
  it('is true only for a 403', () => {
    expect(isForbidden(Object.assign(new Error('x'), { status: 403 }))).toBe(true);
    expect(isForbidden(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});
