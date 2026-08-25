// src/console/tabState.ts
//
// Per-tab navigation state for the Console. Each console.html tab is its own
// browsing context, so sessionStorage is per-tab while chrome.storage.local is
// shared across all tabs. We keep the navigation keys (which collection / view /
// panel / app the user is looking at, plus the ops-log search) per-tab in
// sessionStorage so tabs don't clobber each other on reload, while mirroring the
// value into chrome.storage.local as a cross-session SEED — a freshly-opened tab
// (empty sessionStorage) still resumes where the user last was. Genuine
// preferences (layout widths, results view, Stages options, chart scale) stay
// global in chrome.storage.local and are NOT handled here.
//
// Value asymmetry (by design): sessionStorage holds JSON-encoded values (it only
// stores strings); chrome.storage.local stores the value natively. resolveTabState
// reads each surface accordingly.

// The navigation keys that are per-tab. Everything else stays global.
export const TAB_SCOPED_KEYS = [
  'consoleActiveApp',
  'fabryActiveChat',
  'fabryMode',
  'fabryArchitectActive',
  'mdhActiveView',
  'mdhSelectedCollection',
  'mdhActivePanel',
  'mdhOpsSearch',
] as const;

/** One of the eight keys above — `as const` turns the list into a checked union. */
export type TabScopedKey = (typeof TAB_SCOPED_KEYS)[number];

/** Whatever the caller stored: JSON in sessionStorage, native in chrome.storage.local. */
type TabValue = unknown;

function readSession(key: string): TabValue {
  try {
    const raw = sessionStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined; // missing sessionStorage or corrupt JSON → fall back to local
  }
}

// For each requested key, return this tab's sessionStorage value if present,
// otherwise the chrome.storage.local value already fetched by the caller.
// Pure given (keys, localValues) + the current sessionStorage — easy to test.
export function resolveTabState(
  keys: readonly string[],
  localValues: Record<string, TabValue>,
): Record<string, TabValue> {
  const out: Record<string, TabValue> = {};
  for (const key of keys) {
    const s = readSession(key);
    out[key] = s !== undefined ? s : localValues[key];
  }
  return out;
}

// Persist a per-tab value to BOTH surfaces. Best-effort: a storage hiccup must
// never break navigation, so each write is guarded independently.
export function writeTabState(key: string, value: TabValue): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  try {
    chrome.storage.local.set({ [key]: value });
  } catch {
    /* ignore */
  }
}
