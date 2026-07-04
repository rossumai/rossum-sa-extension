// Records which annotations the user opens in the Rossum UI (/document/<id> —
// the id in that URL is the ANNOTATION id) into chrome.storage.local, so the
// Console Inspector's landing can list "recently viewed". Pure tracking — no
// DOM is injected (the earlier floating button was removed 2026-07-04). Always
// on, like closable-tooltips/dataset-mgmt-suggest. SPA route changes are caught
// by a light interval; writes are deduped per route change and best-effort.
import { VIEWED_KEY, mergeViewed } from '../../inspector/viewed.js';

export function annotationIdFromPath(pathname) {
  const m = /^\/document\/(\d+)(?:[/?#]|$)/.exec(String(pathname || ''));
  return m ? m[1] : null;
}

let lastRecordedKey = '';

function recordView(annotationId) {
  const origin = window.location.origin;
  const key = `${origin}|${annotationId}`;
  if (key === lastRecordedKey) return;
  lastRecordedKey = key;
  try {
    chrome.storage.local.get(VIEWED_KEY).then((got) => {
      const next = mergeViewed(got && got[VIEWED_KEY], { id: annotationId, origin, at: Date.now() });
      chrome.storage.local.set({ [VIEWED_KEY]: next });
    }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

function sync() {
  const annotationId = annotationIdFromPath(window.location.pathname);
  if (annotationId) recordView(annotationId);
}

export function init({ intervalMs = 1500 } = {}) {
  sync();
  if (intervalMs > 0) setInterval(sync, intervalMs); // SPA route changes
}
