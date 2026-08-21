import { h } from 'preact';
import { activePanel, selectedCollection, statsSummary } from '../store.js';

const TABS = [
  { id: 'data', label: 'Data' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'search-indexes', label: 'Search Indexes' },
  { id: 'stats', label: 'Stats' },
];

function StatsAlertIcon() {
  const summary = statsSummary.value;
  if (!summary) return null;
  if (summary.collection !== selectedCollection.value) return null;
  if (summary.health >= 90) return null;

  // Severity tracks the existing healthLabel buckets — the boundary at 50
  // is the same Fair/Poor split users see in the panel.
  const severity = summary.health < 50 ? 'danger' : 'warning';
  const tooltip = `Health: ${summary.health} (${summary.label})`;
  const iconCls = `tab-alert-icon tab-alert-${severity}`;

  return (
    <span class="tab-alert" title={tooltip}>
      {severity === 'danger' ? (
        // Filled circle with white "!" — high severity (Poor: < 50)
        <svg class={iconCls} width="14" height="14" viewBox="0 0 16 16" aria-label={tooltip}>
          <circle cx="8" cy="8" r="7" />
          <rect x="7.25" y="3.5" width="1.5" height="6" rx="0.5" fill="#fff" />
          <rect x="7.25" y="11" width="1.5" height="1.5" rx="0.5" fill="#fff" />
        </svg>
      ) : (
        // Triangle with white "!" — moderate severity (Good/Fair: 50–89)
        <svg class={iconCls} width="14" height="14" viewBox="0 0 16 16" aria-label={tooltip}>
          <path d="M8 1.5 L15 14 L1 14 Z" />
          <rect x="7.25" y="6" width="1.5" height="4.5" rx="0.5" fill="#fff" />
          <rect x="7.25" y="11.75" width="1.5" height="1.5" rx="0.5" fill="#fff" />
        </svg>
      )}
    </span>
  );
}

export default function TabBar() {
  return (
    <div class="tab-bar">
      {TABS.map(({ id, label }) => (
        <button
          class={'tab' + (activePanel.value === id ? ' active' : '')}
          onClick={() => { activePanel.value = id; }}
        >
          {label}
          {id === 'stats' && <StatsAlertIcon />}
        </button>
      ))}
    </div>
  );
}
