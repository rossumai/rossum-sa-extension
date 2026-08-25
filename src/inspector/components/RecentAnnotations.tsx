import { h } from 'preact';
import * as store from '../store.js';
import { clearRecents, relativeTime } from '../recents.js';

// Landing view (variant B, owner-picked 2026-07-04): annotations the user
// recently OPENED IN THE ROSSUM UI, as a compact table — File / Queue / Status /
// When(viewed) / Id — Clear-all in the header, friendly empty state. Rows come
// from store.recents (viewed list, per-org, enriched via one sideloaded call).
export default function RecentAnnotations({ onSelect }: { onSelect: (id: string) => void }) {
  const list = store.recents.value;
  if (!list || list.length === 0) {
    return (
      <div class="inspector-recents-empty">
        Nothing viewed yet. Annotations you open in the Rossum UI will appear here {'—'} or paste an
        id above.
      </div>
    );
  }
  const now = Date.now();
  return (
    <div class="inspector-recents">
      <table class="inspector-rectable">
        <thead>
          <tr>
            <th>File</th>
            <th>Queue</th>
            <th>Status</th>
            <th>When</th>
            <th class="inspector-rectable-idh">
              Id{' '}
              <button type="button" class="inspector-recents-clear" onClick={clearRecents}>
                Clear all
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr
              class="inspector-recent"
              title={`Inspect #${r.id}`}
              onClick={() => onSelect(String(r.id))}
            >
              <td class="inspector-recent-name">{r.fileName || `#${r.id}`}</td>
              <td>
                {r.queue ? (
                  <span class="inspector-chip inspector-recent-queue">{r.queue}</span>
                ) : null}
              </td>
              <td>
                {r.status ? (
                  <span class={`inspector-pill inspector-recent-status inspector-pill-${r.status}`}>
                    {String(r.status).replace(/_/g, ' ')}
                  </span>
                ) : null}
              </td>
              <td class="inspector-recent-when">{relativeTime(r.at, now) || ''}</td>
              <td class="inspector-recent-id">#{r.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
