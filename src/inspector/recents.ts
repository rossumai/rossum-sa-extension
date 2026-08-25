import * as store from './store.js';
import { VIEWED_KEY } from './viewed.js';

export const MAX_RECENTS = 8;

// The landing list = annotations the user recently OPENED IN THE ROSSUM UI
// (recorded by the track-viewed content script into rossumViewedAnnotations),
// filtered to the connected org's origin and enriched with file/queue/status via
// one sideloaded API call. The old investigated-recents storage (inspectorRecents)
// is retired — orphaned, not migrated.

// Pure: stored viewed entries -> id-only landing rows for this origin.
export function viewedRows(stored: any, origin: string, max = MAX_RECENTS): any[] {
  return (Array.isArray(stored) ? stored : [])
    .filter((e) => e && e.id != null && (!origin || e.origin === origin))
    .slice(0, max)
    .map((e) => ({ id: String(e.id), fileName: null, queue: null, status: null, at: typeof e.at === 'number' ? e.at : null }));
}

// Pure: join a sideloaded /annotations payload ({results, documents, queues})
// into the rows. Rows whose annotation didn't resolve (deleted/inaccessible)
// keep their honest id-only shape.
export function enrichRows(rows: any[], payload: any): any[] {
  const anns = new Map<string, any>((payload?.results || []).map((a: any) => [String(a.id), a]));
  const docs = new Map<string, any>((payload?.documents || []).map((d: any) => [d.url, d]));
  const queues = new Map<string, any>((payload?.queues || []).map((q: any) => [q.url, q]));
  return (rows || []).map((r) => {
    const a = anns.get(String(r.id));
    if (!a) return r;
    return {
      ...r,
      fileName: docs.get(a.document)?.original_file_name || null,
      queue: queues.get(a.queue)?.name || null,
      status: a.status || null,
    };
  });
}

// Compact relative time for the recents table ("just now", "12 min ago",
// "2 h ago", "yesterday", "5 d ago"). Pure; null when no usable timestamp.
// `unknown`, because the guard below is the contract: anything that is not a finite
// number has no relative time and reports null rather than NaN.
export function relativeTime(at: unknown, now = Date.now()): string | null {
  const t = typeof at === 'number' ? at : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} d ago`;
}

function hasStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

// Async: read the viewed list into the signal as id-only rows (works even
// before/without a connection — names resolve later via enrichRecents).
export async function loadRecents() {
  try {
    if (!hasStorage()) return;
    const got = await chrome.storage.local.get(VIEWED_KEY);
    store.recents.value = viewedRows(got && got[VIEWED_KEY], store.domain.value);
  } catch { /* recents are a convenience, never fatal */ }
}

// Async: resolve file/queue/status for the current rows in ONE sideloaded call
// (verified live 2026-07-04: /annotations?id=<csv>&sideload=documents,queues).
// Failures keep the id-only rows — never fatal.
export async function enrichRecents(api: any) {
  const rows = store.recents.value;
  if (!rows || rows.length === 0) return;
  try {
    const payload = await api.listAnnotationsByIds(rows.map((r) => r.id));
    if (payload) store.recents.value = enrichRows(store.recents.value, payload);
  } catch { /* keep id-only rows */ }
}

// Clear only the CURRENT org's viewed entries (other orgs' traces stay).
export function clearRecents() {
  store.recents.value = [];
  try {
    if (!hasStorage()) return;
    chrome.storage.local.get(VIEWED_KEY).then((got) => {
      const rest = (got && Array.isArray(got[VIEWED_KEY]) ? got[VIEWED_KEY] : []).filter((e) => e && e.origin !== store.domain.value);
      chrome.storage.local.set({ [VIEWED_KEY]: rest });
    }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}
