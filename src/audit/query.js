import * as api from './api.js';
import * as store from './store.js';

let queryId = 0;

// "Available options: ['a', 'b']" — DRF formats the choices Python-repr style
// (single quotes), so just grab everything between the first [ and ].
const OPTIONS_RE = /Available options:\s*\[([^\]]+)\]/i;

function parseAvailableOptions(message) {
  if (typeof message !== 'string') return null;
  const m = message.match(OPTIONS_RE);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function recordConstraintsFromError(fieldErrors, sentObjectType) {
  if (!fieldErrors) return;
  const next = { ...store.constraints.value };
  let changed = false;
  for (const [field, msgs] of Object.entries(fieldErrors)) {
    for (const msg of msgs) {
      const opts = parseAvailableOptions(msg);
      if (!opts) continue;
      if (field === 'object_type') {
        next.object_type = opts;
        changed = true;
      } else if (field === 'action' && sentObjectType) {
        next.action = { ...next.action, [sentObjectType]: opts };
        changed = true;
      }
    }
  }
  if (changed) store.constraints.value = next;
}

export async function fetchPage({ signal } = {}) {
  const myId = ++queryId;
  store.loading.value = true;
  store.error.value = null;
  const sentObjectType = store.filters.value.object_type;
  try {
    const res = await api.listAuditLogs({
      page: store.page.value,
      pageSize: store.pageSize.value,
      ...store.filters.value,
      signal,
    });
    if (myId !== queryId) return;
    // Tag each record with its position in the page so the row component
    // has a key guaranteed unique within the page — content.request_id
    // is not unique (a single HTTP request can produce multiple records).
    const items = (Array.isArray(res?.results) ? res.results : []).map((rec, i) => ({
      ...rec,
      _idx: i,
    }));
    store.expandedRow.value = null;
    store.results.value = items;
    store.availability.value = 'available';
    store.availabilityMessage.value = null;
    store.availabilityStatus.value = null;
    if (typeof res?.pagination?.total === 'number') {
      store.total.value = res.pagination.total;
    } else if (typeof res?.count === 'number') {
      store.total.value = res.count;
    } else {
      store.total.value = null;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (myId !== queryId) return;
    recordConstraintsFromError(err?.fieldErrors, sentObjectType);
    store.results.value = [];
    store.total.value = null;
    if (err?.featureUnavailable) {
      // Don't show the error banner — render a dedicated empty state.
      store.availability.value = 'unavailable';
      store.availabilityMessage.value = err?.message || null;
      store.availabilityStatus.value = err?.status ?? null;
      store.error.value = null;
    } else {
      store.error.value = err?.message || 'Failed to load audit logs';
    }
  } finally {
    if (myId === queryId) store.loading.value = false;
  }
}
