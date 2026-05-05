import { h } from 'preact';
import { page, pageSize, total, results, loading, quickSearch } from '../store.js';
import { quickMatch } from '../quickSearch.js';

export default function Pagination() {
  const cur = page.value;
  const ps = pageSize.value;
  const tot = total.value;
  const hasNext = tot != null ? cur * ps < tot : results.value.length === ps;
  const hasPrev = cur > 1;
  const totalPages = tot != null ? Math.max(1, Math.ceil(tot / ps)) : null;

  const q = quickSearch.value.trim();
  const visibleCount = q
    ? results.value.filter((r) => quickMatch(r, q)).length
    : results.value.length;

  const startIdx = (cur - 1) * ps + 1;
  const endIdx = (cur - 1) * ps + results.value.length;

  const countText = results.value.length === 0
    ? '0 records'
    : `${startIdx.toLocaleString()}–${endIdx.toLocaleString()}${tot != null ? ' of ' + tot.toLocaleString() : ''}`;

  return (
    <div class="pagination">
      <span>{countText}</span>
      {q && <span class="pagination-hint">{visibleCount} match quick search</span>}
      <div class="pagination-controls">
        <button disabled={!hasPrev || loading.value} onClick={() => (page.value = cur - 1)}>{'←'} Prev</button>
        <span>Page {cur}{totalPages != null ? ` / ${totalPages}` : ''}</span>
        <button disabled={!hasNext || loading.value} onClick={() => (page.value = cur + 1)}>Next {'→'}</button>
      </div>
    </div>
  );
}
