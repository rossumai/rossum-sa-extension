// src/console/boot.js
// Pure helpers for the console shell boot. Kept side-effect-free so they can be
// unit-tested without chrome / DOM / sessionStorage.

export function isValidApp(v) {
  return v === 'mdh' || v === 'audit' || v === 'galaxy' || v === 'inspector' || v === 'fabry';
}

// Which app to show on boot. Precedence: staging entry (a popup button click)
// wins, then the persisted last-used app, then Dataset Management. Fabry is
// only ever picked when the experimental gate is unlocked.
export function pickInitialApp({ stagingApp, persistedApp, fabryUnlocked = false } = {}) {
  const ok = (v) => isValidApp(v) && (v !== 'fabry' || fabryUnlocked);
  if (ok(stagingApp)) return stagingApp;
  if (ok(persistedApp)) return persistedApp;
  return 'mdh';
}

// Re-locking the experimental gate while Fabry is the active app falls back to
// Dataset Management; any other app is unaffected.
export function appAfterGateChange(activeApp, fabryUnlocked) {
  return activeApp === 'fabry' && !fabryUnlocked ? 'mdh' : activeApp;
}

// Resolve token/domain from a single-use staging entry (initial open) or the
// session fallback (same-tab reload). When an entry is present it is single-use
// (consumeKey === true) and carries the initial app + DS pipeline prefill.
export function resolveBootAuth({ entry, session }) {
  if (entry?.token && entry?.domain) {
    return {
      token: entry.token,
      domain: entry.domain,
      stagingApp: entry.app,
      consumeKey: true,
      pendingCtx: {
        pendingCollection: entry.pendingCollection,
        pendingPipeline: entry.pendingPipeline,
        pendingVariables: entry.pendingVariables,
        pendingVariableTypes: entry.pendingVariableTypes,
      },
    };
  }
  return {
    token: session.token,
    domain: session.domain,
    stagingApp: undefined,
    consumeKey: false,
    pendingCtx: {},
  };
}

// Keys to purge from chrome.storage.local: stale (or malformed) consoleAuth_
// staging entries past the TTL, plus any orphaned keys left by pre-console
// builds (mdhAuth_/auditAuth_ staging, and mdhToken/mdhDomain at-rest creds).
export function computeStaleAuthRemovals(all, now, ttl) {
  const toRemove = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('consoleAuth_')) {
      const createdAt = value?.createdAt;
      if (typeof createdAt !== 'number' || now - createdAt > ttl) toRemove.push(key);
    } else if (
      key.startsWith('mdhAuth_') ||
      key.startsWith('auditAuth_') ||
      key === 'mdhToken' ||
      key === 'mdhDomain'
    ) {
      toRemove.push(key);
    }
  }
  return toRemove;
}
