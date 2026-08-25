// src/console/components/Rail.tsx
import { h } from 'preact';
import { activeApp, experimentalUnlocked } from '../store.js';
import type { AppId } from '../boot.js';
import FabryMark from '../../ui/FabryMark.jsx';

const DATA_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
  </svg>
);

const AUDIT_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const GALAXY_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="12" cy="12" r="2.2" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(120 12 12)" />
  </svg>
);

const INSPECTOR_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

// The rail Fabry icon is the shared mark, rendered STATIC (no color cycle) at rail
// size; fill inherits the rail's currentColor (incl. white-when-active).
const FABRY_ICON = <FabryMark size={20} animated={false} />;

const ACADEMY_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 3 2 8l10 5 10-5-10-5z" />
    <path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5" />
  </svg>
);

type RailApp = {
  id: AppId;
  label: string;
  title: string;
  icon: any;
  beta?: boolean;
  exp?: boolean;
  gated?: boolean;
  muted?: boolean;
};

const APPS: RailApp[] = [
  { id: 'mdh', label: 'Data', title: 'Dataset Management', icon: DATA_ICON },
  { id: 'audit', label: 'Audit', title: 'Audit Log Viewer', icon: AUDIT_ICON },
  {
    id: 'inspector',
    label: 'Inspector',
    title: 'Annotation Inspector',
    icon: INSPECTOR_ICON,
    beta: true,
  },
  { id: 'fabry', label: 'Fabry', title: 'Mr. Fabry', icon: FABRY_ICON, beta: true },
  { id: 'galaxy', label: 'Galaxy', title: 'Org Galaxy', icon: GALAXY_ICON },
  // `gated` hides the row unless experimentalUnlocked is set; `exp` is the
  // badge that names that gate. The title spells the abbreviation out, since
  // "EXP" alone does not tell a first-time reader what it means.
  {
    id: 'academy',
    label: 'Academy',
    title: 'Onboarding training — experimental',
    icon: ACADEMY_ICON,
    exp: true,
    gated: true,
  },
];

export default function Rail() {
  const active = activeApp.value;
  const unlocked = experimentalUnlocked.value;
  return (
    <nav class="app-rail" aria-label="Application switcher">
      {APPS.filter((a) => !a.gated || unlocked).map((a) => (
        <button
          type="button"
          class={'app-rail-item' + (active === a.id ? ' active' : '') + (a.muted ? ' muted' : '')}
          title={a.title}
          aria-current={active === a.id ? 'page' : undefined}
          onClick={() => {
            activeApp.value = a.id;
          }}
        >
          <span class="app-rail-icon">{a.icon}</span>
          <span class="app-rail-label">{a.label}</span>
          {a.beta && <span class="app-rail-beta">beta</span>}
          {a.exp && <span class="app-rail-exp">exp</span>}
        </button>
      ))}
    </nav>
  );
}
