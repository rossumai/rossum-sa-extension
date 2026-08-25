import { describe, it, expect, beforeEach } from 'vitest';
import JSON5 from 'json5';
import { orgId, domain, scopeSuffix } from '../src/mdh/store.js';
import {
  saveQuery,
  isSaved,
  unsaveQuery,
  addToHistory,
} from '../src/mdh/components/QueryHistory.jsx';

beforeEach(() => {
  orgId.value = null;
  domain.value = '';
});

describe('scopeSuffix', () => {
  it('prefers the org id when resolved', () => {
    orgId.value = '214757';
    expect(scopeSuffix()).toBe('org:214757');
  });
  it('falls back to the origin when org id is null', () => {
    orgId.value = null;
    domain.value = 'https://acme.rossum.app';
    expect(scopeSuffix()).toBe('domain:https://acme.rossum.app');
  });
});

function stubStorage() {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key: any) => Promise.resolve(key in data ? { [key]: (data as any)[key] } : {}),
        set: (obj: any) => {
          Object.assign(data, obj);
          return Promise.resolve();
        },
        remove: (key: any) => {
          delete (data as any)[key];
          return Promise.resolve();
        },
      },
      sync: { get: () => Promise.resolve({}), remove: () => Promise.resolve() },
    } as any,
  } as any;
  return data;
}

describe('QueryHistory per-org scoping', () => {
  it('writes Saved/Recent under the org-scoped key and keeps orgs separate', async () => {
    const data = stubStorage();
    orgId.value = '1';
    domain.value = 'https://x.rossum.app';
    await saveQuery('vendors', '[{"$limit":5}]', 'q1', {});
    await addToHistory('vendors', '[{"$limit":5}]', {});
    expect((data as any)['savedQueries::org:1']).toHaveLength(1);
    expect((data as any)['queryHistory::org:1']).toHaveLength(1);

    // Switch org -> empty library; the org:1 data is untouched.
    orgId.value = '2';
    expect(await isSaved('vendors', '[{"$limit":5}]')).toBe(false);
    await saveQuery('items', '[{"$count":"n"}]', 'q2', {});
    expect((data as any)['savedQueries::org:2']).toHaveLength(1);
    expect((data as any)['savedQueries::org:1']).toHaveLength(1);
  });

  it('falls back to a domain-scoped key when org id is null', async () => {
    const data = stubStorage();
    orgId.value = null;
    domain.value = 'https://acme.rossum.app';
    await saveQuery('vendors', '[]', 'q', {});
    expect((data as any)['savedQueries::domain:https://acme.rossum.app']).toHaveLength(1);
  });
});

describe('QueryHistory dedup is disable-aware', () => {
  // True-collision case: the two pipelines have IDENTICAL active stages — they
  // differ ONLY by an extra disabled stage. JSON5.parse drops the comment, so the
  // old (parse-then-stringify) dedup key was identical for both → they collided.
  // This test fails without the disable-aware dedupKey fix (1 saved, not 2).
  it('treats a pipeline and the same pipeline + an extra disabled stage as distinct saves', async () => {
    const data = stubStorage();
    orgId.value = '1';
    domain.value = 'https://x.rossum.app';

    const active = '[\n  { "$match": {} }\n]';
    const withDisabled =
      '[\n  { "$match": {} },\n  /* @disabled-stage\n  { "$sort": { "a": -1 } } */\n]';

    // Both reduce to the SAME effective pipeline once comments are dropped —
    // that is exactly the collision the fix must distinguish.
    expect(JSON.stringify(JSON5.parse(active))).toBe(JSON.stringify(JSON5.parse(withDisabled)));

    await saveQuery('vendors', active, 'active', {});
    await saveQuery('vendors', withDisabled, 'withDisabled', {});

    expect((data as any)['savedQueries::org:1']).toHaveLength(2);
    expect(await isSaved('vendors', active)).toBe(true);
    expect(await isSaved('vendors', withDisabled)).toBe(true);
  });
});

describe('QueryHistory write serialization', () => {
  function stubSlowStorage() {
    const data = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: (key: any) =>
            new Promise((r) =>
              setTimeout(() => r(key in data ? { [key]: (data as any)[key] } : {}), 5),
            ),
          set: (obj: any) =>
            new Promise<void>((r) =>
              setTimeout(() => {
                Object.assign(data, obj);
                r();
              }, 5),
            ),
          remove: (key: any) =>
            new Promise<void>((r) =>
              setTimeout(() => {
                delete (data as any)[key];
                r();
              }, 5),
            ),
        },
        sync: { get: () => Promise.resolve({}), remove: () => Promise.resolve() },
      } as any,
    } as any;
    return data;
  }

  it('does not lose entries when two addToHistory calls overlap', async () => {
    const data = stubSlowStorage();
    orgId.value = '1';
    domain.value = 'https://x.rossum.app';
    await Promise.all([
      addToHistory('vendors', '[{"$limit":1}]', {}),
      addToHistory('vendors', '[{"$limit":2}]', {}),
    ]);
    expect((data as any)['queryHistory::org:1']).toHaveLength(2);
  });
});
