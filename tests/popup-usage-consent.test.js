import { describe, it, expect } from 'vitest';
import { writeConsent } from '../src/popup/usageConsent.js';

// The consent flag must be durable the instant the click handler runs, because
// the popup can be destroyed immediately afterwards. VERIFIED 2026-08-03: routing
// it through the service worker left it ABSENT right after the click and only
// present ~50ms later (the worker has to wake first), so closing + reopening
// inside that window read "off". These tests pin the direct-write behaviour.
function makeDeps() {
  const calls = [];
  return {
    calls,
    setLocal: (obj) => { calls.push(['set', obj]); return Promise.resolve(); },
    removeLocal: (keys) => { calls.push(['remove', keys]); return Promise.resolve(); },
    removeSession: (keys) => { calls.push(['removeSession', keys]); return Promise.resolve(); },
  };
}

describe('writeConsent', () => {
  it('writes the flag itself, with no service-worker hop', async () => {
    const d = makeDeps();
    await writeConsent(true, d);
    expect(d.calls).toEqual([['set', { usageConsent: true }]]);
  });

  it('revoking drops the identifier and the snapshot marker too', async () => {
    const d = makeDeps();
    await writeConsent(false, d);
    expect(d.calls).toContainEqual(['set', { usageConsent: false }]);
    expect(d.calls).toContainEqual(['remove', ['usageClientId', 'usageSnapshotDay']]);
  });

  it('revoking also clears the session id, or a re-enable stays linkable', () => {
    // PRIVACY.md promises "a later re-enable cannot be linked to earlier data".
    // The session id lives in chrome.storage.session and outlives the client id,
    // so leaving it behind would bridge the old and new ids.
    const d = makeDeps();
    writeConsent(false, d);
    expect(d.calls).toContainEqual(['removeSession', ['usageSessionId']]);
  });

  it('dispatches every revoke write in the same tick, not chained', () => {
    // If a removal waited on the set, a popup closing in between would leave the
    // identifier behind.
    const d = makeDeps();
    writeConsent(false, d);
    expect(d.calls.length).toBe(3);
  });

  it('treats any non-true value as off', async () => {
    for (const v of [false, null, undefined, 'true', 1]) {
      const d = makeDeps();
      await writeConsent(v, d);
      expect(d.calls).toContainEqual(['set', { usageConsent: false }]);
    }
  });
});
