import {
  buildPayload, buildSnapshotParams, EVENT_NAMES, SNAPSHOT_KEYS,
} from './event.js';
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
  today: () => new Date().toISOString().slice(0, 10),
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
const READ_KEYS = [
  'usageConsent', 'usageClientId', 'usageSnapshotDay', ...Object.values(SNAPSHOT_KEYS),
];

async function sessionId(d) {
  const { usageSessionId } = await d.getSession(['usageSessionId']);
  if (usageSessionId) return usageSessionId;
  const id = d.uuid();
  await d.setSession({ usageSessionId: id });
  return id;
}

async function post(d, name, params, clientId) {
  const body = buildPayload({
    name, params, clientId, sessionId: await sessionId(d), version: d.version(),
  });
  await d.fetch(d.endpoint(), { method: 'POST', body: JSON.stringify(body) });
}

// NOTE: consent is written by the popup itself (src/popup/usageConsent.js), not
// through this worker — see the measurement in that file. This module only READS
// it.
// Returns how many requests were sent. Never rejects: a usage-reporting failure must
// not surface anywhere. `0` covers no-consent, unknown name, invalid params and
// network failure alike.
// Serialized: collect() is a check-then-act read-modify-write across awaits
// (lazy client id, daily snapshot marker). A burst of events in one tick would
// otherwise each observe pre-state, minting several client ids and sending
// duplicate snapshots. The queue never rejects — collectOne already swallows.
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

    let sent = 0;
    const day = d.today();
    if (stored.usageSnapshotDay !== day) {
      // Isolated, and the marker is committed only AFTER a successful post:
      // otherwise one transient failure both loses that day's snapshot forever
      // and aborts the event that triggered it. Retrying on a later event today
      // is the lesser evil. The snapshot piggybacks on the first event of the
      // day because a scheduled alternative would need chrome.alarms, and adding
      // a permission would disable every existing install until re-approved.
      try {
        await post(d, 'sa_config_snapshot', buildSnapshotParams(stored), clientId);
        await d.setLocal({ usageSnapshotDay: day });
        sent += 1;
      } catch {
        // fall through to the real event
      }
    }
    if (name !== 'sa_config_snapshot') {
      await post(d, name, msg.params || {}, clientId);
      sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
}
