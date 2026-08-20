// src/devtools/actions.ts
import * as store from './store.js';
import { track } from '../usage/track.js';
import { buildPatchBody } from './diff.js';
import { resourceFromApiUrl, genericResourceFromPath } from './resourceFromApiUrl.js';
import { normalizeRequestInput } from './requestInput.js';

const PRETTY = (o: any) => JSON.stringify(o, null, 2);
const tabById = (id: string) => store.tabs.value.find((t) => t.id === id) || null;

async function resolveResource(resource: any, deps: any) {
  if (!resource || !resource.via) return resource;
  if (resource.via === 'queue') {
    const queue = await deps.getJson(resource.queueApiPath);
    const schema = resourceFromApiUrl(queue && queue.schema);
    if (!schema) throw Object.assign(new Error('no schema'), { noSchema: true });
    return schema;
  }
  if (resource.via === 'queue-inbox') {
    const queue = await deps.getJson(resource.queueApiPath);
    const inbox = resourceFromApiUrl(queue && queue.inbox);
    if (!inbox) throw Object.assign(new Error('no inbox'), { noInbox: true });
    return inbox;
  }
  if (resource.via === 'org') {
    const list = await deps.getJson('/api/v1/organizations');
    const org = resourceFromApiUrl(list && list.results && list.results[0] && list.results[0].url);
    if (!org) throw Object.assign(new Error('no org'), { noOrg: true });
    return org;
  }
  return resource;
}

export async function loadResource(tabId: string, deps: any) {
  const start = tabById(tabId);
  if (!start || !start.resource) return;
  const startKey = store.keyOf(start.resource);
  store.patchTab(tabId, { loading: true, error: null, readOnly: false });
  try {
    let resource = start.resource;
    if (resource.via) {
      resource = await resolveResource(resource, deps);
      const t = tabById(tabId);
      if (!t || store.keyOf(t.resource) !== startKey) return;
      store.patchTab(tabId, { resource });
    }
    const cached = deps.getCached ? deps.getCached(resource.apiPath) : null;
    const result = cached ? { kind: 'json', data: cached } : await deps.getResource(resource.apiPath);
    const t2 = tabById(tabId);
    if (!t2 || store.keyOf(t2.resource) !== store.keyOf(resource)) return;
    if (result.kind === 'blob') {
      store.patchTab(tabId, {
        preview: { kind: 'blob', contentType: result.contentType, size: result.size, filename: result.filename, blob: result.blob },
        original: null, buffer: '', dirty: false, loading: false, readOnly: true,
      });
    } else {
      store.patchTab(tabId, { original: result.data, buffer: PRETTY(result.data), dirty: false, loading: false, readOnly: !!resource.readOnly, preview: null });
      // Warm the cache only on a genuine fetch — re-putting a cache HIT would reset
      // its freshness clock and let a >60s-old object be served indefinitely.
      if (result.kind === 'json' && !cached && deps.putCached) deps.putCached(resource.apiPath, result.data);
    }
  } catch (e) {
    const cur = tabById(tabId);
    if (!cur) return;
    const s = e && (e as any).status;
    // Default read-only from the descriptor: a read-only-by-design resource
    // (e.g. a `/content` sub-resource) must not become an editable editor just
    // because its load failed on a network error / 404 / 500.
    let error = 'Could not load this resource.', readOnly = !!(cur.resource && cur.resource.readOnly);
    if (e && (e as any).noSchema) error = 'This queue has no schema.';
    else if (e && (e as any).noInbox) error = 'This queue has no inbox.';
    else if (e && (e as any).noOrg) error = 'Could not resolve the organization.';
    else if (s === 404) error = 'Not found (404) — this resource may belong to another organization, a support-access user, or have been deleted.';
    else if (s === 403 || s === 405) { readOnly = true; error = 'You can view this resource but not edit it (server declined writes).'; }
    else if (s === 401) error = 'Session expired — reload the Rossum page.';
    store.patchTab(tabId, { error, readOnly, loading: false, preview: null });
  }
}

export function requestDiff(tabId: string) {
  const t = tabById(tabId);
  if (!t) return false;
  let edited;
  try { edited = JSON.parse(t.buffer); }
  catch (e) { store.patchTab(tabId, { error: `Invalid JSON: ${(e as Error).message}`, diffPreview: null }); return false; }
  store.patchTab(tabId, { error: null, diffPreview: { edited } });
  return true;
}

export async function saveResource(tabId: string, deps: any) {
  const t = tabById(tabId);
  if (!t || !t.diffPreview) return;
  const startKey = store.keyOf(t.resource);
  const { body } = buildPatchBody(t.original, t.diffPreview.edited);
  if (Object.keys(body).length === 0) { store.patchTab(tabId, { diffPreview: null }); return; }
  store.patchTab(tabId, { saving: true, error: null });
  try {
    await deps.patch(t.resource!.apiPath, body);
    const fresh = await deps.getJson(t.resource!.apiPath);
    const cur = tabById(tabId);
    if (!cur || store.keyOf(cur.resource) !== startKey) return;
    track('sa_devtools_save');
    store.patchTab(tabId, { original: fresh, buffer: PRETTY(fresh), dirty: false, diffPreview: null, saving: false });
    if (deps.reload && cur && cur.source === 'page') deps.reload();
  } catch (e) {
    const cur = tabById(tabId);
    if (!cur || store.keyOf(cur.resource) !== startKey) return;
    const s = e && (e as any).status;
    let error = 'Save failed.';
    if (s === 400) error = `Server rejected the change (400): ${((e as any).body || '').slice(0, 300)}`;
    else if (s === 401) error = 'Session expired — reload the Rossum page.';
    else if (s === 403 || s === 405) error = 'This resource is not editable (server declined writes).';
    store.patchTab(tabId, { error, saving: false });
  }
}

// Open a link resource as a tab; load it only if it wasn't already open (so a
// re-click focuses an existing tab without clobbering its unsaved edits).
export function openResourceTab(resource: any, deps: any) {
  if (!resource) return null;
  const existed = store.tabs.value.some((t) => store.keyOf(t.resource) === store.keyOf(resource));
  const tab = store.openTab(resource, 'link');
  if (!existed) loadResource(tab.id, deps);
  return tab;
}

// Fire a request-bar input: normalize → single resource (editable) or generic
// read-only (list/query/unknown) → open as a tab. GET-only; never non-GET.
export function openRequestPath(rawInput: unknown, domain: string, deps: any) {
  const norm = normalizeRequestInput(rawInput, domain);
  if (!norm) return null;
  // Casts, not `in` or a guard: `'error' in norm` and an added null check both emit
  // different code, and this function is meant to be types-only.
  if ((norm as any).error) return { error: (norm as any).error };
  const single = (norm as any).apiPath.includes('?') ? null : resourceFromApiUrl((norm as any).apiPath);
  const resource = single || genericResourceFromPath((norm as any).apiPath);
  if (!resource) return { error: 'Could not parse that path.' };
  const tab = openResourceTab(resource, deps);
  return { tab };
}
