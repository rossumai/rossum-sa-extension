import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../src/devtools/store.js';
import { loadResource, requestDiff, saveResource, openResourceTab } from '../src/devtools/actions.js';

const RES = { type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' };
beforeEach(() => { store.tabs.value = []; store.activeId.value = null; });

// JSON body fetches go through deps.getResource, which returns a tagged union.
const asJson = (data) => Promise.resolve({ kind: 'json', data });

describe('loadResource', () => {
  it('loads the object into original + buffer', async () => {
    const t = store.openTab(RES);
    const getResource = vi.fn(() => asJson({ id: 1, name: 'A' }));
    await loadResource(t.id, { getResource });
    const tab = store.activeTab();
    expect(tab.original).toEqual({ id: 1, name: 'A' });
    expect(JSON.parse(tab.buffer)).toEqual({ id: 1, name: 'A' });
    expect(tab.readOnly).toBe(false);
    expect(tab.preview).toBeNull();
    expect(tab.loading).toBe(false);
  });
  it('renders a preview for a blob (non-JSON) response', async () => {
    const blob = { size: 3, type: 'application/pdf' };
    const t = store.openTab({ type: 'documents', id: '5', apiPath: '/api/v1/documents/5/content', label: 'Content', readOnly: true });
    const getResource = vi.fn(() => Promise.resolve({ kind: 'blob', contentType: 'application/pdf', size: 3, filename: 'doc.pdf', blob }));
    await loadResource(t.id, { getResource });
    const tab = store.activeTab();
    expect(tab.preview).toEqual({ kind: 'blob', contentType: 'application/pdf', size: 3, filename: 'doc.pdf', blob });
    expect(tab.readOnly).toBe(true);
    expect(tab.original).toBeNull();
    expect(tab.buffer).toBe('');
    expect(tab.loading).toBe(false);
  });
  it('keeps a read-only-by-descriptor resource read-only when the load fails (non-403)', async () => {
    const t = store.openTab({ type: 'documents', id: '5', apiPath: '/api/v1/documents/5/content', label: 'Content', readOnly: true });
    await loadResource(t.id, { getResource: () => Promise.reject(new Error('network')) }); // no .status
    const tab = store.activeTab();
    expect(tab.readOnly).toBe(true); // must not fall back to an editable editor
    expect(tab.preview).toBeNull();
    expect(tab.error).toBeTruthy();
  });
  it('drops to read-only on 403', async () => {
    const t = store.openTab(RES);
    const getResource = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { status: 403 })));
    await loadResource(t.id, { getResource });
    const tab = store.activeTab();
    expect(tab.readOnly).toBe(true);
    expect(tab.error).toMatch(/view/i);
  });
  it('resolves a schema-via-queue descriptor by fetching the queue then its schema', async () => {
    const t = store.openTab({ type: 'schema', via: 'queue', queueId: '5', queueApiPath: '/api/v1/queues/5', label: 'Schema' });
    const getJson = vi.fn().mockResolvedValueOnce({ schema: 'https://acme.rossum.app/api/v1/schemas/9' }); // the queue (via)
    const getResource = vi.fn(() => asJson({ id: 9, content: [] }));                                        // the schema body
    await loadResource(t.id, { getJson, getResource, patch: vi.fn() });
    expect(getJson).toHaveBeenNthCalledWith(1, '/api/v1/queues/5');
    expect(getResource).toHaveBeenCalledWith('/api/v1/schemas/9');
    expect(store.activeTab().resource).toEqual({ type: 'schema', id: '9', apiPath: '/api/v1/schemas/9', label: 'Schema' });
    expect(store.activeTab().original).toEqual({ id: 9, content: [] });
  });
  it('surfaces an error when the queue has no schema', async () => {
    const t = store.openTab({ type: 'schema', via: 'queue', queueId: '5', queueApiPath: '/api/v1/queues/5', label: 'Schema' });
    const getJson = vi.fn(() => Promise.resolve({})); // no .schema field
    await loadResource(t.id, { getJson });
    expect(store.activeTab().error).toMatch(/no schema/i);
  });

  it('resolves an inbox-via-queue descriptor by fetching the queue then its inbox', async () => {
    const t = store.openTab({ type: 'inbox', via: 'queue-inbox', queueId: '5', queueApiPath: '/api/v1/queues/5', label: 'Inbox' });
    const getJson = vi.fn().mockResolvedValueOnce({ inbox: 'https://acme.rossum.app/api/v1/inboxes/9' }); // the queue (via)
    const getResource = vi.fn(() => asJson({ id: 9, name: 'Inbox' }));                                     // the inbox body
    await loadResource(t.id, { getJson, getResource, patch: vi.fn() });
    expect(getJson).toHaveBeenNthCalledWith(1, '/api/v1/queues/5');
    expect(getResource).toHaveBeenCalledWith('/api/v1/inboxes/9');
    expect(store.activeTab().resource).toEqual({ type: 'inbox', id: '9', apiPath: '/api/v1/inboxes/9', label: 'Inbox' });
    expect(store.activeTab().original).toEqual({ id: 9, name: 'Inbox' });
  });

  it('surfaces an error when the queue has no inbox', async () => {
    const t = store.openTab({ type: 'inbox', via: 'queue-inbox', queueId: '5', queueApiPath: '/api/v1/queues/5', label: 'Inbox' });
    const getJson = vi.fn(() => Promise.resolve({})); // no .inbox field
    await loadResource(t.id, { getJson });
    expect(store.activeTab().error).toMatch(/inbox/i);
  });

  it('loadResource marks the tab read-only when the resource is readOnly', async () => {
    const t = store.openTab({ type: 'annotations', id: '1', apiPath: '/api/v1/annotations/1/content', label: 'Content', readOnly: true });
    await loadResource(t.id, { getResource: () => asJson([{ a: 1 }]), patch: vi.fn() });
    expect(store.activeTab().readOnly).toBe(true);
  });

  it('loadResource resolves a via:org descriptor to the organization', async () => {
    const t = store.openTab({ type: 'organization', via: 'org', label: 'Organization' });
    const getJson = vi.fn().mockResolvedValueOnce({ results: [{ url: 'https://acme.rossum.app/api/v1/organizations/1' }] });
    const getResource = vi.fn(() => asJson({ id: 1, name: 'Org' }));
    await loadResource(t.id, { getJson, getResource, patch: vi.fn() });
    expect(getJson).toHaveBeenNthCalledWith(1, '/api/v1/organizations');
    expect(getResource).toHaveBeenCalledWith('/api/v1/organizations/1');
    expect(store.activeTab().resource).toEqual({ type: 'organization', id: '1', apiPath: '/api/v1/organizations/1', label: 'Organization' });
  });

  it('loadResource shows a list read-only', async () => {
    const t = store.openTab({ type: 'hook', apiPath: '/api/v1/hooks', label: 'Hooks', readOnly: true });
    await loadResource(t.id, { getResource: () => asJson({ results: [], pagination: {} }), patch: vi.fn() });
    expect(store.activeTab().readOnly).toBe(true);
  });

  it('loadResource shows a clear 404 message (e.g. out-of-org / support-access user)', async () => {
    const t = store.openTab({ type: 'user', id: '359651', apiPath: '/api/v1/users/359651', label: 'User' });
    await loadResource(t.id, { getResource: () => Promise.reject(Object.assign(new Error('x'), { status: 404 })), patch: vi.fn() });
    expect(store.activeTab().error).toMatch(/404/);
  });

  it('opens instantly from a cache hit without calling getResource', async () => {
    const t = store.openTab({ type: 'schema', id: '9', apiPath: '/api/v1/schemas/9', label: 'Schema' });
    const getResource = vi.fn();
    const getCached = vi.fn(() => ({ id: 9, name: 'Cached' }));
    const putCached = vi.fn();
    await loadResource(t.id, { getResource, getCached, putCached });
    expect(getResource).not.toHaveBeenCalled();
    expect(putCached).not.toHaveBeenCalled(); // a cache hit must not reset the freshness clock
    expect(store.activeTab().original).toEqual({ id: 9, name: 'Cached' });
    expect(store.activeTab().buffer).toContain('"Cached"');
    expect(store.activeTab().preview).toBeNull();
  });

  it('fetches on a cache miss and warms the cache with a JSON result', async () => {
    const t = store.openTab({ type: 'schema', id: '9', apiPath: '/api/v1/schemas/9', label: 'Schema' });
    const getResource = vi.fn(() => asJson({ id: 9 }));
    const getCached = vi.fn(() => null);
    const putCached = vi.fn();
    await loadResource(t.id, { getResource, getCached, putCached });
    expect(getResource).toHaveBeenCalledTimes(1);
    expect(putCached).toHaveBeenCalledWith('/api/v1/schemas/9', { id: 9 });
  });

  it('does not warm the cache for a blob result', async () => {
    const t = store.openTab({ type: 'documents', id: '5', apiPath: '/api/v1/documents/5/content', label: 'Content', readOnly: true });
    const getResource = vi.fn(() => Promise.resolve({ kind: 'blob', contentType: 'application/pdf', size: 1, filename: 'd.pdf', blob: {} }));
    const putCached = vi.fn();
    await loadResource(t.id, { getResource, getCached: () => null, putCached });
    expect(putCached).not.toHaveBeenCalled();
    expect(store.activeTab().preview).not.toBeNull();
  });
});

describe('requestDiff', () => {
  it('rejects invalid JSON', () => {
    const t = store.openTab(RES);
    store.patchTab(t.id, { buffer: '{ not json' });
    expect(requestDiff(t.id)).toBe(false);
    expect(store.activeTab().error).toMatch(/Invalid JSON/);
    expect(store.activeTab().diffPreview).toBeNull();
  });
  it('stages the edited object', () => {
    const t = store.openTab(RES);
    store.patchTab(t.id, { buffer: '{"name":"B"}' });
    expect(requestDiff(t.id)).toBe(true);
    expect(store.activeTab().diffPreview).toEqual({ edited: { name: 'B' } });
  });
});

describe('saveResource', () => {
  it('PATCHes only changed keys, re-fetches canonical, then reloads the inspected page', async () => {
    const t = store.openTab(RES, 'page');
    store.patchTab(t.id, { original: { id: 1, name: 'A' }, buffer: JSON.stringify({ id: 1, name: 'B' }) });
    requestDiff(t.id);
    const patch = vi.fn(() => Promise.resolve({}));
    const getJson = vi.fn(() => Promise.resolve({ id: 1, name: 'B', modified_at: 't' }));
    const reload = vi.fn();
    await saveResource(t.id, { getJson, patch, reload });
    expect(patch).toHaveBeenCalledWith('/api/v1/queues/1', { name: 'B' });
    const tab = store.activeTab();
    expect(tab.original).toEqual({ id: 1, name: 'B', modified_at: 't' });
    expect(tab.diffPreview).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('keeps the buffer and surfaces the server message on 400, and does not reload', async () => {
    const t = store.openTab(RES);
    store.patchTab(t.id, { original: { name: 'A' }, buffer: JSON.stringify({ name: 'B' }) });
    requestDiff(t.id);
    const patch = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { status: 400, body: 'bad' })));
    const getJson = vi.fn();
    const reload = vi.fn();
    await saveResource(t.id, { getJson, patch, reload });
    const tab = store.activeTab();
    expect(tab.error).toMatch(/400/);
    expect(tab.buffer).toContain('"B"');
    expect(tab.diffPreview).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
  it('does not PATCH when only removals are staged (removals are never applied)', async () => {
    const t = store.openTab(RES);
    store.patchTab(t.id, { original: { name: 'A', gone: 1 }, buffer: JSON.stringify({ name: 'A' }) });
    requestDiff(t.id);
    const patch = vi.fn();
    const getJson = vi.fn();
    const reload = vi.fn();
    await saveResource(t.id, { getJson, patch, reload });
    expect(patch).not.toHaveBeenCalled();
    expect(store.activeTab().diffPreview).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('saveResource reloads the inspected page only for the page tab', async () => {
    // page tab => reload
    const p = store.openTab({ type: 'queue', id: '1', apiPath: '/api/v1/queues/1', label: 'Queue' }, 'page');
    store.patchTab(p.id, { original: { name: 'A' }, buffer: JSON.stringify({ name: 'B' }) });
    requestDiff(p.id);
    const reloadP = vi.fn();
    await saveResource(p.id, { getJson: vi.fn(() => Promise.resolve({ name: 'B' })), patch: vi.fn(() => Promise.resolve({})), reload: reloadP });
    expect(reloadP).toHaveBeenCalledTimes(1);

    // link tab => NO reload
    const l = store.openTab({ type: 'hook', id: '2', apiPath: '/api/v1/hooks/2', label: 'Hook' }, 'link');
    store.patchTab(l.id, { original: { name: 'A' }, buffer: JSON.stringify({ name: 'B' }) });
    requestDiff(l.id);
    const reloadL = vi.fn();
    await saveResource(l.id, { getJson: vi.fn(() => Promise.resolve({ name: 'B' })), patch: vi.fn(() => Promise.resolve({})), reload: reloadL });
    expect(reloadL).not.toHaveBeenCalled();
  });

  it('openResourceTab loads a new tab but focuses an existing one without reloading', async () => {
    const getResource = vi.fn(() => Promise.resolve({ kind: 'json', data: { id: 9 } }));
    const r = { type: 'schema', id: '9', apiPath: '/api/v1/schemas/9', label: 'Schema' };
    const t1 = openResourceTab(r, { getResource, patch: vi.fn() });
    await Promise.resolve(); await Promise.resolve();
    expect(getResource).toHaveBeenCalledTimes(1); // new => loaded
    store.patchTab(t1.id, { dirty: true, buffer: '{"edited":true}' }); // unsaved edit
    const t2 = openResourceTab(r, { getResource, patch: vi.fn() }); // re-open same
    expect(t2.id).toBe(t1.id);               // focused existing
    expect(getResource).toHaveBeenCalledTimes(1); // NOT re-loaded (no clobber)
    expect(store.tabs.value.find((t) => t.id === t1.id).buffer).toBe('{"edited":true}'); // edits preserved
  });
});

describe('resource-change guard', () => {
  it('does not write stale state to a tab that navigated to a different resource mid-save', async () => {
    const t = store.openTab(RES);
    store.patchTab(t.id, { original: { id: 1, name: 'A' }, buffer: JSON.stringify({ id: 1, name: 'B' }) });
    requestDiff(t.id);
    let resolvePatch;
    const patch = vi.fn(() => new Promise((r) => { resolvePatch = r; }));
    const getJson = vi.fn(() => Promise.resolve({ id: 1, name: 'B' }));
    const reload = vi.fn();
    const p = saveResource(t.id, { getJson, patch, reload });
    // The SAME tab id navigates to a different resource (e.g. the page tab follows
    // a SPA nav) while the PATCH is in flight.
    store.patchTab(t.id, { resource: { type: 'queue', id: '2', apiPath: '/api/v1/queues/2', label: 'Queue' }, original: null, buffer: '', diffPreview: null });
    resolvePatch({});
    await p;
    const tab = store.tabs.value.find((x) => x.id === t.id);
    expect(tab.resource.id).toBe('2');   // new resource is intact, not clobbered by the stale save
    expect(tab.original).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a stale load response after the tab is closed', async () => {
    const t = store.openTab(RES);
    let resolveGet;
    const getResource = vi.fn(() => new Promise((r) => { resolveGet = r; }));
    const p = loadResource(t.id, { getResource });
    store.closeTab(t.id);
    resolveGet({ kind: 'json', data: { id: 1, name: 'A' } });
    await p; // must not throw even though the tab no longer exists
    expect(store.tabs.value.find((x) => x.id === t.id)).toBeUndefined();
  });
});

// append to tests/devtools-actions.test.js
import { openRequestPath } from '../src/devtools/actions.js';

describe('openRequestPath', () => {
  const deps = { getResource: () => Promise.resolve({ kind: 'json', data: {} }) };
  it('opens a single resource as an editable tab (no query, has id)', () => {
    const r = openRequestPath('/api/v1/queues/9', 'https://elis.rossum.app', deps);
    expect(r.tab.resource).toEqual({ type: 'queue', id: '9', apiPath: '/api/v1/queues/9', label: 'Queue' });
    expect(r.tab.resource.readOnly).toBeUndefined();
  });
  it('opens a bare collection as a generic read-only tab', () => {
    const r = openRequestPath('queues', 'https://elis.rossum.app', deps);
    expect(r.tab.resource.readOnly).toBe(true);
    expect(r.tab.resource.apiPath).toBe('/api/v1/queues');
  });
  it('routes a query path to the generic descriptor and keeps the query', () => {
    const r = openRequestPath('/api/v1/annotations?queue=1', 'https://elis.rossum.app', deps);
    expect(r.tab.resource.apiPath).toBe('/api/v1/annotations?queue=1');
    expect(r.tab.resource.readOnly).toBe(true);
  });
  it('returns an error (no tab) for a cross-host URL', () => {
    const r = openRequestPath('https://other.rossum.app/api/v1/queues/1', 'https://elis.rossum.app', deps);
    expect(r.error).toBeTruthy();
    expect(r.tab).toBeUndefined();
  });
  it('returns null for empty input', () => {
    expect(openRequestPath('   ', 'https://elis.rossum.app', deps)).toBeNull();
  });
});
