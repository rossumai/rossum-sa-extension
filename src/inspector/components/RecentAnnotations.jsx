import { h } from 'preact';
import * as store from '../store.js';
import { clearRecents } from '../recents.js';

// Landing-state shortcut list: the annotations most recently inspected, so an SA
// can re-open one in a click instead of re-pasting its id. Reads store.recents
// (populated from chrome.storage.local at init + on every successful load).
export default function RecentAnnotations({ onSelect }) {
  const list = store.recents.value;
  if (!list || list.length === 0) return null;
  return (
    <div class="inspector-recents">
      <div class="inspector-recents-hd">
        <span>Recent</span>
        <button type="button" class="inspector-recents-clear" onClick={clearRecents}>Clear</button>
      </div>
      <ul class="inspector-recents-list">
        {list.map((r) => (
          <li>
            <button type="button" class="inspector-recent" onClick={() => onSelect(String(r.id))}>
              <span class="inspector-recent-name">{r.fileName || `#${r.id}`}</span>
              {r.queue ? <span class="inspector-recent-queue">{r.queue}</span> : null}
              {r.status ? <span class="inspector-recent-status">{r.status}</span> : null}
              <span class="inspector-recent-id">#{r.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
