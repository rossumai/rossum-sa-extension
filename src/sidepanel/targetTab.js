// Pure helpers for "which tab is the side panel following". The popup reads its
// context once, on open, because that is its whole life; a panel outlives every
// click, so it has to notice tab switches and SPA navigation itself.
//
// The annotation id itself comes from ../rossum/annotationUrl.js — parsing the
// tab.url string the panel already holds lets us notice a document change with
// no executeScript round-trip.
import { detectSite } from '../popup/utils.js';

// A tab whose URL we cannot read (no host permission, redacted) is treated as
// unsupported rather than guessed at — the same stance as findRossumTabs.
export function isRossumTab(tab) {
  return !!tab && detectSite(tab.url || '') === 'rossum';
}

export function viewState(tab) {
  if (!tab) return 'no-tab';
  return isRossumTab(tab) ? 'ready' : 'unsupported';
}

export function sameTarget(a, b) {
  return !!a && !!b && a.id === b.id && a.url === b.url;
}
