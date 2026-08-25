// Durable consent write, straight from the popup.
//
// WHY NOT VIA THE SERVICE WORKER (the original design): the popup is destroyed
// the moment it loses focus, and a message to the worker needs the worker to
// WAKE UP before it can write. Measured 2026-08-03 against an idle worker:
//
//     immediately after the click -> usageConsent ABSENT
//     +50ms                       -> true
//
// So closing the popup and reopening inside that window read "off", and a
// teardown that dropped the message lost the answer entirely. `chrome.storage`
// writes are handed to the browser process by the call itself, which is why the
// `usageAsked` flag (written this way from the start) always persisted.
//
// The client id is no longer minted here: `collect()` creates it lazily on the
// first event, so it cannot be lost either — and a profile left with consent but
// no id by the old code heals itself on the next event.
export const defaultDeps = {
  setLocal: (obj: Record<string, unknown>) => chrome.storage.local.set(obj),
  removeLocal: (keys: string[]) => chrome.storage.local.remove(keys),
  removeSession: (keys: string[]) => chrome.storage.session.remove(keys),
};

export function writeConsent(
  value: boolean,
  deps: Partial<typeof defaultDeps> = {},
): Promise<unknown> {
  const d = { ...defaultDeps, ...deps };
  if (value === true) return d.setLocal({ usageConsent: true });

  // Both writes are dispatched in the same tick, deliberately NOT chained: if
  // the removal waited on the set, a popup closing in between would leave the
  // identifier behind. (`collect()` also gates on consent, so a lost removal
  // still sends nothing — defence in depth.)
  // The SESSION id must go too, or a re-enable inside the same browser session
  // would share it with the previous client id and be trivially joinable —
  // PRIVACY.md promises the opposite.
  const removed = d.removeLocal(['usageClientId']);
  const session = d.removeSession(['usageSessionId']);
  const written = d.setLocal({ usageConsent: false });
  return Promise.all([written, removed, session]);
}
