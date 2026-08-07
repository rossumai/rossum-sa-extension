// Which tabs the side panel is available on.
//
// LIVE-VERIFIED 2026-08-07 (Chrome, elis): a per-tab `enabled: false` does NOT
// hide a panel that was opened GLOBALLY — that panel stays visible on every tab,
// even across a navigation. Chrome only scopes the panel when the global default
// is OFF and the wanted tabs are switched ON individually; in that configuration
// the panel reports visibilityState 'hidden' on other tabs and comes back by
// itself (no re-pinning) when the user returns to an enabled tab, with its page
// kept alive so nothing is re-fetched.
import { detectSite } from '../popup/utils.js';

export const SIDE_PANEL_PATH = 'sidepanel/sidepanel.html';

// A tab whose URL we cannot read (no host permission) is not a Rossum tab as far
// as we are concerned — unknown means disabled, never guessed.
export function panelOptionsFor(tabId, url) {
  return detectSite(url || '') === 'rossum'
    ? { tabId, path: SIDE_PANEL_PATH, enabled: true }
    : { tabId, enabled: false };
}

// The decision for one tabs.onUpdated event; null means "ignore this event".
//
// LIVE-VERIFIED 2026-08-07: navigating a tab AWAY from Rossum to a site we hold
// no host permission for still fires onUpdated ({status:'loading'}, {}, then
// {status:'complete'}) but carries NO url — not in changeInfo, and not on the
// tab either. That absence IS the "left Rossum" signal, which is why the answer
// must be read off `tab.url` (undefined => disable). An earlier version keyed on
// changeInfo.url and so left a departed tab enabled forever. Navigating INTO
// Rossum does deliver both changeInfo.url and tab.url.
export function panelUpdateFor(tabId, changeInfo, tab) {
  // Navigation only — title and favicon events also fire, and re-deciding on
  // those is pure noise.
  if (!changeInfo?.url && !changeInfo?.status) return null;
  return panelOptionsFor(tabId, tab?.url);
}

// The pin's action. Enabling first matters: with the global default off, opening
// a tab that has no per-tab option yet would open nothing (a Rossum tab that has
// been sitting there since before the worker last synced).
export async function openPanelForTab(tabId, api) {
  await api.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true });
  await api.open({ tabId });
}
