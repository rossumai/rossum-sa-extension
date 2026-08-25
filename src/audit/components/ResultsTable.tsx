import { h } from 'preact';
import { activeSource, rows, loading, selectedRow } from '../store.js';
import { SOURCES } from '../sources/index.js';
import { makeCtx } from '../ctx.js';

export default function ResultsTable() {
  const desc = SOURCES[activeSource.value];
  const all = rows.value;
  const ctx = makeCtx();

  if (loading.value && all.length === 0) return <div class="results-empty">Loading…</div>;
  if (!loading.value && all.length === 0)
    return <div class="results-empty">No records match the current filters.</div>;

  return (
    <div class="results-wrap">
      <table class="results-table">
        <thead>
          <tr>
            {desc.columns.map((c: any) => (
              <th class={c.cls}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {all.map((r) => (
            <tr
              key={String(r._idx)}
              class={'result-row' + (selectedRow.value === r._idx ? ' expanded' : '')}
              onClick={() => (selectedRow.value = selectedRow.value === r._idx ? null : r._idx)}
            >
              {desc.columns.map((c: any) => (
                <td class={c.cls}>{c.render(r, ctx)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
