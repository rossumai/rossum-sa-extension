// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ whoami: vi.fn(), fetchOrgResources: vi.fn(), init: vi.fn() }));
vi.mock('../src/galaxy/api.js', () => apiMock);

import { initGalaxy, loadGraph } from '../src/galaxy/index.jsx';
import * as store from '../src/galaxy/store.js';

beforeEach(() => {
  apiMock.whoami.mockReset();
  apiMock.fetchOrgResources.mockReset();
  store.connected.value = null;
  store.graph.value = { nodes: [], links: [] };
  store.error.value = null;
  store.retryable.value = false;
  store.loading.value = false;
});

describe('initGalaxy', () => {
  it('sets connected=false and skips fetching when whoami fails', async () => {
    apiMock.whoami.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
    await initGalaxy();
    expect(store.connected.value).toBe(false);
    expect(store.error.value).toMatch(/session expired/i);
    expect(apiMock.fetchOrgResources).not.toHaveBeenCalled();
  });
  it('a 429 on the session check shows the rate-limit message and is retryable', async () => {
    apiMock.whoami.mockRejectedValue(
      Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter: 8 }),
    );
    await initGalaxy();
    expect(store.connected.value).toBe(false);
    expect(store.error.value).toBe('Rossum is rate-limiting requests. Try again in 8 s.');
    expect(store.retryable.value).toBe(true);
  });
  it('a later session check that succeeds clears the 429 error and Retry', async () => {
    apiMock.whoami.mockRejectedValueOnce(
      Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter: 8 }),
    );
    await initGalaxy();
    // A deferred graph load keeps loadGraph from clearing the flags itself: initGalaxy must.
    apiMock.whoami.mockResolvedValueOnce({ id: 1 });
    apiMock.fetchOrgResources.mockReturnValueOnce(new Promise(() => {}));
    const pending = initGalaxy();
    expect(store.error.value).toBeNull();
    expect(store.retryable.value).toBe(false);
    await pending;
    expect(store.connected.value).toBe(true);
  });
  it('connects after the probe, then loads + builds the graph asynchronously', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockResolvedValue({
      organization: { id: 1, url: 'https://x/api/v1/organizations/1', name: 'Acme' },
      workspaces: [
        {
          id: 10,
          url: 'https://x/api/v1/workspaces/10',
          name: 'WS',
          organization: 'https://x/api/v1/organizations/1',
        },
      ],
      queues: [],
      hooks: [],
    });
    await initGalaxy();
    // connected is set right after the probe (before the async graph load), so the
    // shell can render the rail + loading overlay immediately.
    expect(store.connected.value).toBe(true);
    await vi.waitFor(() => {
      const ids = store.graph.value.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(['organization:1', 'workspace:10']);
    });
    expect(store.loading.value).toBe(false);
  });
  it('surfaces a fetch error without crashing', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValue(new Error('boom'));
    await initGalaxy();
    expect(store.connected.value).toBe(true);
    await vi.waitFor(() => {
      expect(store.error.value).toMatch(/boom|failed/i);
    });
    expect(store.loading.value).toBe(false);
  });

  it('a 429 shows the rate-limit message and offers Retry; Retry loads again', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValueOnce(
      Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter: 30 }),
    );
    await initGalaxy();
    await vi.waitFor(() => {
      expect(store.error.value).toBe('Rossum is rate-limiting requests. Try again in 30 s.');
    });
    expect(store.retryable.value).toBe(true);
    apiMock.fetchOrgResources.mockResolvedValueOnce({
      organization: null,
      workspaces: [],
      queues: [],
      hooks: [],
      engines: [],
    });
    await loadGraph();
    expect(store.error.value).toBeNull();
    expect(store.retryable.value).toBe(false);
    expect(apiMock.fetchOrgResources).toHaveBeenCalledTimes(2);
  });

  it('other errors are not retryable', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValue(new Error('boom'));
    await initGalaxy();
    await vi.waitFor(() => expect(store.error.value).toMatch(/boom/));
    expect(store.retryable.value).toBe(false);
  });
});
