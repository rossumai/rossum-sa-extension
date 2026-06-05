import { describe, it, expect, beforeEach } from 'vitest';
import { orgId, domain, scopeSuffix } from '../src/mdh/store.js';
import { saveQuery, isSaved, unsaveQuery, addToHistory } from '../src/mdh/components/QueryHistory.jsx';

beforeEach(() => { orgId.value = null; domain.value = ''; });

describe('scopeSuffix', () => {
  it('prefers the org id when resolved', () => {
    orgId.value = 214757;
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
        get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
        set: (obj) => { Object.assign(data, obj); return Promise.resolve(); },
        remove: (key) => { delete data[key]; return Promise.resolve(); },
      },
      sync: { get: () => Promise.resolve({}), remove: () => Promise.resolve() },
    },
  };
  return data;
}

describe('QueryHistory per-org scoping', () => {
  it('writes Saved/Recent under the org-scoped key and keeps orgs separate', async () => {
    const data = stubStorage();
    orgId.value = 1; domain.value = 'https://x.rossum.app';
    await saveQuery('vendors', '[{"$limit":5}]', 'q1', {});
    await addToHistory('vendors', '[{"$limit":5}]', {});
    expect(data['savedQueries::org:1']).toHaveLength(1);
    expect(data['queryHistory::org:1']).toHaveLength(1);

    // Switch org -> empty library; the org:1 data is untouched.
    orgId.value = 2;
    expect(await isSaved('vendors', '[{"$limit":5}]')).toBe(false);
    await saveQuery('items', '[{"$count":"n"}]', 'q2', {});
    expect(data['savedQueries::org:2']).toHaveLength(1);
    expect(data['savedQueries::org:1']).toHaveLength(1);
  });

  it('falls back to a domain-scoped key when org id is null', async () => {
    const data = stubStorage();
    orgId.value = null; domain.value = 'https://acme.rossum.app';
    await saveQuery('vendors', '[]', 'q', {});
    expect(data['savedQueries::domain:https://acme.rossum.app']).toHaveLength(1);
  });
});
