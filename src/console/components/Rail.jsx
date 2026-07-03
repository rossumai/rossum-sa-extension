// src/console/components/Rail.jsx
import { h } from 'preact';
import { activeApp } from '../store.js';

const DATA_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
  </svg>
);

const AUDIT_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const GALAXY_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="2.2" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(120 12 12)" />
  </svg>
);

const INSPECTOR_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const APPS = [
  { id: 'mdh', label: 'Data', title: 'Dataset Management', icon: DATA_ICON },
  { id: 'audit', label: 'Audit', title: 'Audit Log Viewer', icon: AUDIT_ICON },
  { id: 'inspector', label: 'Inspector', title: 'Annotation Inspector', icon: INSPECTOR_ICON, beta: true },
  { id: 'galaxy', label: 'Galaxy', title: 'Org Galaxy', icon: GALAXY_ICON, beta: true },
];

export default function Rail() {
  const active = activeApp.value;
  return (
    <nav class="app-rail" aria-label="Application switcher">
      {APPS.map((a) => (
        <button
          type="button"
          class={'app-rail-item' + (active === a.id ? ' active' : '') + (a.muted ? ' muted' : '')}
          title={a.title}
          aria-current={active === a.id ? 'page' : undefined}
          onClick={() => { activeApp.value = a.id; }}
        >
          <span class="app-rail-icon">{a.icon}</span>
          <span class="app-rail-label">{a.label}</span>
          {a.beta && <span class="app-rail-beta">beta</span>}
        </button>
      ))}
    </nav>
  );
}
