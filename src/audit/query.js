import * as api from './api.js';
import * as store from './store.js';
import { SOURCES } from './sources/index.js';

let queryId = 0;

export async function fetchActive({ signal } = {}) {
  const myId = ++queryId;
  const key = store.activeSource.value;
  const desc = SOURCES[key];
  const st = store.filtersBySource.value[key];

  store.loading.value = true;
  store.error.value = null;
  store.selectedRow.value = null;
  store.availability.value = 'unknown';
  store.availabilityMessage.value = null;
  store.availabilityStatus.value = null;

  const params = { ...desc.buildParams(st), page_size: st.pageSize };
  if (desc.paginationMode === 'cursor') {
    params.include_total = 'true';
    if (st.cursor) params.cursor = st.cursor;
  } else if (st.page && st.page > 1) {
    params.page = st.page;
  }
  if (desc.supportsServerSearch && st.search) params.search = st.search;

  try {
    const res = await api.get(`${desc.path}?${api.buildQuery(params)}`, { signal });
    if (myId !== queryId) return;
    const items = (Array.isArray(res?.results) ? res.results : []).map((r, i) => ({ ...r, _idx: i }));
    store.rows.value = items;
    store.pageInfo.value = api.normalizePage(res?.pagination, desc.paginationMode, st.page || 1);
    store.availability.value = 'available';
    store.availabilityMessage.value = null;
    store.availabilityStatus.value = null;
  } catch (err) {
    if (err?.name === 'AbortError' || myId !== queryId) return;
    store.rows.value = [];
    store.pageInfo.value = { total: null, totalPages: null, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null };
    if (err?.featureUnavailable) {
      store.availability.value = 'unavailable';
      store.availabilityMessage.value = err?.message || null;
      store.availabilityStatus.value = err?.status ?? null;
      store.error.value = null;
    } else {
      store.error.value = err?.message || 'Failed to load';
    }
  } finally {
    if (myId === queryId) store.loading.value = false;
  }
}
