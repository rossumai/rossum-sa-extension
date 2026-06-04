import { h } from 'preact';
import { activeSource, filtersBySource, patchFilters, pageInfo, loading, rows } from '../store.js';
import { SOURCES } from '../sources/index.js';

export default function Pagination() {
  const key = activeSource.value;
  const desc = SOURCES[key];
  const st = filtersBySource.value[key];
  const pi = pageInfo.value;
  const n = rows.value.length;

  const totalText = pi.total != null ? ` of ${pi.total.toLocaleString()}` : '';
  const countText = n === 0 ? '0 records' : `${n.toLocaleString()} shown${totalText}`;

  let prev, next, label;
  if (desc.paginationMode === 'cursor') {
    prev = () => patchFilters(key, { cursor: pi.prevCursor ?? null });
    next = () => patchFilters(key, { cursor: pi.nextCursor });
    label = pi.totalPages != null ? `${pi.totalPages} pages` : '';
  } else {
    const cur = st.page || 1;
    prev = () => patchFilters(key, { page: cur - 1 });
    next = () => patchFilters(key, { page: cur + 1 });
    label = `Page ${cur}${pi.totalPages != null ? ` / ${pi.totalPages}` : ''}`;
  }

  return (
    <div class="pagination">
      <span>{countText}</span>
      <div class="pagination-controls">
        <button disabled={!pi.hasPrev || loading.value} onClick={prev}>{'←'} Prev</button>
        <span>{label}</span>
        <button disabled={!pi.hasNext || loading.value} onClick={next}>Next {'→'}</button>
      </div>
    </div>
  );
}
