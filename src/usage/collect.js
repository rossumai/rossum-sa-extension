import { buildPayload, EVENT_NAMES } from './event.js';
import { GA4_ENDPOINT, MEASUREMENT_ID, API_SECRET } from './ga4Config.js';

// Worker-side collector. The service worker is the ONLY sender: it owns the
// consent gate, the client id and the single fetch, so there is exactly one
// place to audit. See
// docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md.
//
// Real IO, overridable per-call for tests (repo pattern: devtools/actions.js,
// popup/ReviewingLockBanner.jsx).
export const defaultDeps = {
  getLocal: (keys) => chrome.storage.local.get(keys),
  setLocal: (obj) => chrome.storage.local.set(obj),
  getSession: (keys) => chrome.storage.session.get(keys),
  setSession: (obj) => chrome.storage.session.set(obj),
  uuid: () => crypto.randomUUID(),
  version: () => {
    const m = chrome.runtime.getManifest();
    return m.version_name || m.version;
  },
  endpoint: () => `${GA4_ENDPOINT}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`,
  fetch: (url, init) => fetch(url, init),
};

// Deliberately an explicit key list, never getLocal(null): the local store also
// holds staged consoleAuth_* entries carrying session tokens, and this module
// has no business reading them.
const READ_KEYS = ['usageConsent', 'usageClientId'];

async function sessionId(d) {
  const { usageSessionId } = await d.getSession(['usageSessionId']);
  if (usageSessionId) return usageSessionId;
  const id = d.uuid();
  await d.setSession({ usageSessionId: id });
  return id;
}

async function post(d, name, clientId) {
  const body = buildPayload({
    name, clientId, sessionId: await sessionId(d), version: d.version(),
  });
  await d.fetch(d.endpoint(), { method: 'POST', body: JSON.stringify(body) });
}

// NOTE: consent is written by the popup itself (src/popup/usageConsent.js), not
// through this worker — see the measurement in that file. This module only READS
// it.
// Returns how many requests were sent. Never rejects: a usage-reporting failure must
// not surface anywhere. `0` covers no-consent, unknown name and network failure
// alike. Any `params` on the message is ignored, never forwarded.
// Serialized: collect() is a check-then-act read-modify-write across an await
// (the lazy client id). A burst of events in one tick would otherwise each
// observe pre-state and mint several ids, sending events under different
// identifiers. This looks deletable now that the daily snapshot is gone — it is
// not. The queue never rejects — collectOne already swallows.
let queue = Promise.resolve();

export function collect(msg, deps = {}) {
  const result = queue.then(() => collectOne(msg, deps), () => collectOne(msg, deps));
  queue = result.then(() => {}, () => {});
  return result;
}

async function collectOne(msg, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  try {
    const name = msg && msg.name;
    if (typeof name !== 'string' || !EVENT_NAMES.includes(name)) return 0;

    const stored = await d.getLocal(READ_KEYS);
    if (stored.usageConsent !== true) return 0;

    // Minted here, lazily, rather than when consent was given: the popup that
    // grants consent may be destroyed before any message to this worker is
    // delivered, so nothing durable may depend on that hop. Creating it at first
    // use also heals a profile that the old flow left with consent but no id.
    let clientId = stored.usageClientId;
    if (!clientId) {
      clientId = d.uuid();
      await d.setLocal({ usageClientId: clientId });
    }

    await post(d, name, clientId);
    return 1;
  } catch {
    return 0;
  }
}
