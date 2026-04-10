import { h } from 'preact';
import { activePanel } from '../store.js';

const TABS = [
  { id: 'data', label: 'Data' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'search-indexes', label: 'Search Indexes' },
];

export default function TabBar() {
  return (
    <div class="tab-bar">
      {TABS.map(({ id, label }) => (
        <button
          class={'tab' + (activePanel.value === id ? ' active' : '')}
          onClick={() => { activePanel.value = id; }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
